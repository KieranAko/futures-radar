// pipeline/run.cjs — futures-radar v0.1.0
// Single pipeline entry point. Orchestrates automatable stages, stops at LLM boundaries.
//
// Usage:
//   node pipeline/run.cjs
//   node pipeline/run.cjs --runId 20260730-1637-auto --from scan
//   node pipeline/run.cjs --runId 20260730-1637-auto --from filter
//   node pipeline/run.cjs --runId 20260730-1637-auto --from analyze
//
// --from values:
//   source-probe — source-probe → DONE
//   collect  (default) — source-probe → collect → [STOP: scan]
//   scan     — scan → filter-hard → [STOP: filter-llm]
//   filter   — filter-hard → [STOP: filter-llm]
//   analyze  — filter-llm → analyze → [STOP: probability]
//   probability — probability → [STOP: report]
//   report   — probability → report → publish-current → DONE

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const { runtimeRoot, skillRoot } = require('../lib/workspace.cjs');
const { artifacts, stages } = require('./contracts.cjs');

// ── CLI ──────────────────────────────────────────────────────
const args = process.argv.slice(2);
function flagVal(flag) {
  const i = args.indexOf(flag);
  return i === -1 ? null : args[i + 1];
}

const fromStage = flagVal('--from') || 'collect';
const explicitRunId = flagVal('--runId');

if (!['source-probe', 'collect', 'scan', 'filter', 'analyze', 'probability', 'report'].includes(fromStage)) {
  console.error(`ERROR: invalid --from value: ${fromStage}. Must be: source-probe, collect, scan, filter, analyze, probability, report`);
  process.exit(1);
}
if (fromStage !== 'collect' && !explicitRunId) {
  console.error('ERROR: --runId is required when --from is not "collect"');
  process.exit(1);
}

// ── runId ────────────────────────────────────────────────────
const now = new Date();
const runId = explicitRunId
  || `${now.toISOString().slice(0, 10).replace(/-/g, '')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}-auto`;

const RUN_DIR = path.join(runtimeRoot, 'runs', runId);

// ── Stage index lookup ───────────────────────────────────────
const stageMap = {};
for (const s of stages) stageMap[s.id] = s;

// --from aliases: user-facing names → internal stage IDs to start from
const fromAlias = {
  'source-probe': 'source-probe',
  collect: 'source-probe',
  scan: 'scan',
  filter: 'filter-hard',
  analyze: 'filter-llm',
  probability: 'probability',
  report: 'probability'
};
const resolvedStage = fromAlias[fromStage];
const stageOrder = stages.map(s => s.id);
const startIdx = stageOrder.indexOf(resolvedStage);

// ── Helpers ──────────────────────────────────────────────────
function runStage(scriptRelPath, scriptArgs) {
  const scriptPath = path.join(skillRoot, scriptRelPath);
  if (!fs.existsSync(scriptPath)) {
    console.error(`  ERROR: script not found: ${scriptPath}`);
    return { ok: false, error: 'script_missing' };
  }
  const res = cp.spawnSync('node', [scriptPath, ...scriptArgs], {
    encoding: 'utf8',
    stdio: 'inherit',
    timeout: 300000,
    windowsHide: true
  });
  if (res.error) {
    console.error(`  ERROR: spawn failed: ${res.error.message}`);
    return { ok: false, error: res.error.message };
  }
  return { ok: res.status === 0, exitCode: res.status };
}

function checkArtifactById(artifactId) {
  const artifact = artifacts.find(a => a.id === artifactId);
  if (!artifact) return false;
  const p = artifact.path.replace('{runDir}', RUN_DIR).replace('{runtimeRoot}', runtimeRoot);
  return fs.existsSync(p);
}

// ── Manual stage output mapping ──────────────────────────────
const manualOutputs = {
  'filter-llm': ['filtered.json'],
  analyze: ['analysis.json'],
  report: ['report.md']
};

// ── Stage-by-stage runner ────────────────────────────────────
let stoppedForLLM = false;
let stoppedAtStage = null;
let stoppedReason = null; // 'placeholder' | 'llm_boundary'

console.log(`=== futures-radar pipeline v0.1.0 ===`);
console.log(`runId: ${runId}  from: ${fromStage}`);
console.log(`skillRoot: ${skillRoot}`);
console.log(`runtimeRoot: ${runtimeRoot}\n`);

if (fromStage !== 'collect') {
  if (!fs.existsSync(RUN_DIR)) {
    console.error(`ERROR: run directory not found: ${RUN_DIR}`);
    console.error('Run collect first: node pipeline/run.cjs');
    process.exit(1);
  }
}

for (let i = startIdx; i < stageOrder.length; i++) {
  const sid = stageOrder[i];
  const stage = stageMap[sid];

  // Skip publish-current when not running full report
  if (sid === 'publish-current' && fromStage !== 'report') continue;

  console.log(`── ${stage.label} ──`);

  if (stage.auto) {
    // ── Auto stage ──
    const scriptArgs = stage.args(runId);

    // Skip if script is a Phase 3+ placeholder (not yet implemented)
    if (!fs.existsSync(path.join(skillRoot, stage.script))) {
      console.log(`  ⏸  SKIP — ${stage.script} not yet implemented (Phase 3+)`);
      stoppedForLLM = true;
      stoppedAtStage = sid;
      stoppedReason = 'placeholder';
      break;
    }

    // Check inputs exist
    if (stage.inputs && stage.inputs.length > 0) {
      const missing = stage.inputs.filter(id => !checkArtifactById(id));
      if (missing.length > 0) {
        console.error(`  FATAL: ${stage.label} — missing inputs: ${missing.join(', ')}`);
        console.error('  Run earlier stages first.');
        process.exit(1);
      }
    }

    console.log(`  Running: node ${stage.script} ${scriptArgs.join(' ')}`);
    const result = runStage(stage.script, scriptArgs);
    if (!result.ok) {
      if (stage.failurePolicy === 'warn' || stage.failurePolicy === 'degraded') {
        console.warn(`  WARN: ${stage.label} failed (exit ${result.exitCode}) — continuing (failurePolicy=${stage.failurePolicy}).`);
      } else {
        console.error(`\nFATAL: ${stage.label} failed (exit ${result.exitCode}). Pipeline stopped.`);
        process.exit(1);
      }
    }
  } else {
    // ── Manual (LLM) stage ──
    const outputs = manualOutputs[sid] || [];
    const allOutputsExist = outputs.length > 0 && outputs.every(f => {
      const artifact = artifacts.find(a => a.path.endsWith(f));
      return artifact ? checkArtifactById(artifact.id) : false;
    });

    if (allOutputsExist) {
      console.log(`  (already complete — ${outputs.join(', ')} exists, skipping)`);
      continue;
    }

    // Check upstream dependencies
    const missing = [];
    if (sid === 'filter-llm') {
      if (!checkArtifactById('filtered-hard-json')) missing.push('filtered-hard.json');
      if (!checkArtifactById('candidates-json')) missing.push('candidates.json');
    } else if (sid === 'analyze') {
      if (!checkArtifactById('filtered-json')) missing.push('filtered.json');
    } else if (sid === 'report') {
      if (!checkArtifactById('analysis-json')) missing.push('analysis.json');
      if (!checkArtifactById('probability-json')) missing.push('probability.json');
      if (!checkArtifactById('candidates-json')) missing.push('candidates.json');
    }

    if (missing.length > 0) {
      console.error(`  ERROR: missing upstream artifacts: ${missing.join(', ')}`);
      console.error('  Run earlier stages first.');
      process.exit(1);
    }

    console.log(`  ⏸  STOP — ${stage.note}`);
    stoppedForLLM = true;
    stoppedAtStage = sid;
    stoppedReason = 'llm_boundary';
    break;
  }
}

// ── Summary ──────────────────────────────────────────────────
console.log();
if (stoppedForLLM) {
  console.log('=== PIPELINE PAUSED ===');
  if (stoppedReason === 'placeholder') {
    const nextScript = stageMap[stoppedAtStage] ? stageMap[stoppedAtStage].script : 'unknown';
    console.log(`Blocked at "${stageMap[stoppedAtStage]?.label || stoppedAtStage}" — ${nextScript} not yet implemented.`);
    console.log(`Implement this script first, then re-run:`);
    console.log(`  node pipeline/run.cjs --runId ${runId} --from ${fromStage}`);
  } else {
    // llm_boundary
    const nextStageAlias = stoppedAtStage === 'filter-llm' ? 'filter'
      : stoppedAtStage === 'analyze' ? 'analyze'
      : stoppedAtStage === 'report' ? 'report'
      : fromStage;
    console.log(`Next: complete "${stageMap[stoppedAtStage]?.label || stoppedAtStage}" (LLM stage), then resume:`);
    console.log(`  node pipeline/run.cjs --runId ${runId} --from ${nextStageAlias}`);
  }
} else {
  console.log('=== PIPELINE COMPLETE ===');
  console.log(`runId: ${runId}`);
}
