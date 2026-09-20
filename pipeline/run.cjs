// pipeline/run.cjs — futures-radar v2.0.0
// Six-module pipeline runner. Consumes pipeline/contracts.cjs only.
//
// Usage:
//   node pipeline/run.cjs
//   node pipeline/run.cjs --runId 20260918-1941-auto --from data-collection
//   node pipeline/run.cjs --runId 20260918-1941-auto --from story-chain
//   node pipeline/run.cjs --runId 20260918-1941-auto --from opportunity-analysis
//   node pipeline/run.cjs --runId 20260918-1941-auto --from signal-pool
//   node pipeline/run.cjs --runId 20260918-1941-auto --from result-output
//   node pipeline/run.cjs --runId 20260918-1941-auto --from story-observe   (任意 stage id)
//
// --from 接受 phase id 或 stage id：
//   data-collection | file-library | story-chain | opportunity-analysis | signal-pool | result-output
//   source-probe | collect | sector | macro | storage-verify | macro-history-build |
//   story-prompt | story-register | story-observe | story-filtered |
//   analysis-freeze | analysis-prefill | analysis-prompt | analysis-llm | analysis-assemble |
//   probability | report-facts | report-model | strategy-reasoning-prompt | strategy-reasoning-llm |
//   strategy-plan | render-markdown | publish-current

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const { runtimeRoot, skillRoot } = require('../shared/workspace.cjs');
const { artifacts, phases, stages } = require('./contracts.cjs');

// ── CLI ──────────────────────────────────────────────────────
const args = process.argv.slice(2);
function flagVal(flag) {
  const i = args.indexOf(flag);
  return i === -1 ? null : args[i + 1];
}

const fromStage = flagVal('--from') || 'data-collection';
const explicitRunId = flagVal('--runId');

const phaseIds = phases.map((p) => p.id);
const stageIds = stages.map((s) => s.id);
if (!phaseIds.includes(fromStage) && !stageIds.includes(fromStage)) {
  console.error(`ERROR: invalid --from value: ${fromStage}.`);
  console.error(`  phase ids: ${phaseIds.join(', ')}`);
  console.error(`  stage ids: ${stageIds.join(', ')}`);
  process.exit(1);
}
if (fromStage !== 'data-collection' && fromStage !== 'source-probe' && !explicitRunId) {
  console.error('ERROR: --runId is required when --from is not "data-collection"');
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

function startIndexFor(from) {
  if (stageIds.includes(from)) return stages.findIndex((s) => s.id === from);
  const phase = phases.find((p) => p.id === from);
  const firstStage = phase.stages[0].id;
  return stages.findIndex((s) => s.id === firstStage);
}
const startIdx = startIndexFor(fromStage);

// ── Helpers ──────────────────────────────────────────────────
function artifactById(id) {
  return artifacts.find((a) => a.id === id) || null;
}

function artifactPath(artifact) {
  return artifact.path
    .replace('{runDir}', RUN_DIR)
    .replace('{runtimeRoot}', runtimeRoot)
    .replace('{skillRoot}', skillRoot)
    .replace('{runId}', runId);
}

function checkArtifactById(artifactId) {
  const artifact = artifactById(artifactId);
  if (!artifact) return false;
  return fs.existsSync(artifactPath(artifact));
}

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

// ── Runner ───────────────────────────────────────────────────
let stoppedForLLM = false;
let stoppedAtStage = null;

console.log(`=== futures-radar pipeline v2.0.0 (six-module) ===`);
console.log(`runId: ${runId}  from: ${fromStage}`);
console.log(`skillRoot: ${skillRoot}`);
console.log(`runtimeRoot: ${runtimeRoot}\n`);

if (fromStage !== 'data-collection' && fromStage !== 'source-probe') {
  if (!fs.existsSync(RUN_DIR)) {
    console.error(`ERROR: run directory not found: ${RUN_DIR}`);
    console.error('Run collect first: node pipeline/run.cjs');
    process.exit(1);
  }
}

for (let i = startIdx; i < stages.length; i++) {
  const stage = stages[i];
  const phaseLabel = `[${stage.phaseSeq}.${stage.phaseName}]`;
  console.log(`── ${phaseLabel} ${stage.name} ──`);

  if (stage.auto) {
    const scriptArgs = stage.args ? stage.args(runId) : [];

    if (!stage.script || !fs.existsSync(path.join(skillRoot, stage.script))) {
      console.log(`  ⏸  SKIP — ${stage.script || stage.id} not implemented`);
      stoppedForLLM = true;
      stoppedAtStage = stage;
      break;
    }

    // Input gate
    const missing = (stage.inputs || []).filter((id) => !checkArtifactById(id));
    if (missing.length > 0) {
      console.error(`  FATAL: ${stage.label || stage.name} — missing inputs: ${missing.join(', ')}`);
      console.error('  Run earlier stages first.');
      process.exit(1);
    }

    console.log(`  Running: node ${stage.script} ${scriptArgs.join(' ')}`);
    const result = runStage(stage.script, scriptArgs);
    if (!result.ok) {
      if (stage.failurePolicy === 'warn' || stage.failurePolicy === 'degraded') {
        console.warn(`  WARN: ${stage.name} failed (exit ${result.exitCode}) — continuing (failurePolicy=${stage.failurePolicy}).`);
      } else {
        console.error(`\nFATAL: ${stage.name} failed (exit ${result.exitCode}). Pipeline stopped.`);
        process.exit(1);
      }
    }
  } else {
    // ── Manual (LLM) stage ──
    const outputs = stage.outputs || [];
    const allOutputsExist = outputs.length > 0 && outputs.every((id) => checkArtifactById(id));

    if (allOutputsExist) {
      console.log(`  (already complete — ${outputs.join(', ')} exists, skipping)`);
      continue;
    }

    // Check upstream dependencies
    const missing = (stage.inputs || []).filter((id) => !checkArtifactById(id));
    if (missing.length > 0) {
      console.error(`  ERROR: missing upstream artifacts: ${missing.join(', ')}`);
      console.error('  Run earlier stages first.');
      process.exit(1);
    }

    if (stage.failurePolicy === 'warn') {
      console.warn(`  ⏭  SKIP (optional LLM stage): ${stage.note}`);
      continue;
    }

    console.log(`  ⏸  STOP — ${stage.note}`);
    stoppedForLLM = true;
    stoppedAtStage = stage;
    break;
  }
}

// ── Summary ──────────────────────────────────────────────────
console.log();
if (stoppedForLLM) {
  const idx = stages.indexOf(stoppedAtStage);
  const nextStage = stages[idx + 1] || null;
  console.log('=== PIPELINE PAUSED ===');
  console.log(`Blocked at "${stoppedAtStage.name}" (${stoppedAtStage.id}) — LLM/manual stage.`);
  if (nextStage) {
    console.log(`Complete it, then resume:`);
    console.log(`  node pipeline/run.cjs --runId ${runId} --from ${nextStage.id}`);
  } else {
    console.log(`Complete it, then pipeline is done.`);
  }
} else {
  console.log('=== PIPELINE COMPLETE ===');
  console.log(`runId: ${runId}`);
}
