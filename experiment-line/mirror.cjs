// experiment-line/mirror.cjs — 实验线管道镜像（v6 架构 §8 第一步）
//
// 职责：
//   init                     生成 blueprint.json（管道蓝图 + 每环节 stable/candidate 配置对）
//   replay --runId <生产runId>  把生产 runDir 完整复制为镜像 runDir，对全部确定性环节重跑
//                              stable 配置并逐产物比对，输出 stable 回放基线报告。
//
// 设计依据：
//   - P2 同构：镜像使用与生产完全相同的环节脚本（pipeline/contracts.cjs stable 配置），
//     只通过 FUTURES_RUNTIME_ROOT 把运行根切到 experiment-line/。
//   - P4 回放基线：replay 是 stable 回放，验证实验线能逐字节复现生产确定性环节。
//   - 复用 V7 strategy-plan-adapter 的 runDir 同构思想：不修改任何生产脚本。
//   - 网络阶段（source-probe/collect/sector/macro）与人工阶段（filter-llm/analyze/
//     publish-current）不回放，产物整体继承并校验存在性。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');

const SKILL_ROOT = path.resolve(__dirname, '..');
const EXPERIMENT_ROOT = __dirname; // experiment-line/ 即实验线 runtimeRoot（FUTURES_RUNTIME_ROOT）
const RUNS_DIR = path.join(__dirname, 'runs');
const RESULTS_DIR = path.join(__dirname, 'results');
const BLUEPRINT_FILE = path.join(__dirname, 'blueprint.json');

const { stages } = require(path.join(SKILL_ROOT, 'pipeline', 'contracts.cjs'));

const TIMESTAMP_KEYS = new Set([
  'generatedAt', 'calculatedAt', 'fetchedAt', 'updatedAt', 'analyzedAt',
  'runAt', 'computedAt', 'publishedAt', 'timestamp', 'createdAt',
  'scannedAt', 'filteredAt', 'processedAt', 'refreshedAt', 'renderedAt',
]);

const NETWORK_STAGES = new Set(['source-probe', 'collect', 'sector', 'macro']);
const MANUAL_STAGES = new Set(['filter-llm', 'analyze', 'publish-current']);

function nowIso() {
  return new Date().toISOString();
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readArtifact(file) {
  const text = fs.readFileSync(file, 'utf8');
  return file.endsWith('.json') ? JSON.parse(text) : text;
}

// 归一化：时间戳键删除、runId 与路径中的 runId 字符串统一，供逐字节比对
function normalize(value, prodRunId, mirrorRunId, opts = {}) {
  const { dropKeys = [] } = opts;
  if (Array.isArray(value)) return value.map((v) => normalize(v, prodRunId, mirrorRunId, opts));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (TIMESTAMP_KEYS.has(k)) continue;
      if (dropKeys.includes(k)) continue;
      if (k === 'runId' && typeof v === 'string') {
        out[k] = '<RUNID>';
        continue;
      }
      out[k] = normalize(v, prodRunId, mirrorRunId, opts);
    }
    return out;
  }
  if (typeof value === 'string') {
    let s = value;
    if (prodRunId) s = s.split(prodRunId).join('<RUNID>');
    if (mirrorRunId) s = s.split(mirrorRunId).join('<RUNID>');
    // wall-clock 标题日期（render-markdown 依赖运行当天日期，非数据字段）
    s = s.replace(/# (期货投机机会雷达) — \d{4}-\d{2}-\d{2}/g, '# $1 — <DATE>');
    // 管道版本是代码版本，历史 run 与当前代码回放之间的预期漂移
    s = s.replace(/管道版本：[\d.]+/g, '管道版本：<PIPELINE>');
    return s;
  }
  return value;
}

// 先严格比对；若差异只来自 pipelineVersion 类版本字段 → version-drift
function compareArtifact(prodValue, mirrorValue, prodRunId, mirrorRunId, versionDriftKeys = ['pipelineVersion']) {
  const a = normalize(prodValue, prodRunId, mirrorRunId);
  const b = normalize(mirrorValue, prodRunId, mirrorRunId);
  if (isDeepStrictEqual(a, b)) return { status: 'pass' };
  const a2 = normalize(prodValue, prodRunId, mirrorRunId, { dropKeys: versionDriftKeys });
  const b2 = normalize(mirrorValue, prodRunId, mirrorRunId, { dropKeys: versionDriftKeys });
  if (isDeepStrictEqual(a2, b2)) return { status: 'version-drift', firstDiff: firstDiff(a, b) };
  return { status: 'diff', firstDiff: firstDiff(a2, b2) || firstDiff(a, b) };
}

function firstDiff(a, b, p = '') {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return { path: p, prod: typeof a, mirror: typeof b };
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const d = firstDiff(a[i], b[i], `${p}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of [...keys].sort()) {
      if (!(k in a)) return { path: `${p}.${k}`, prod: '<missing>', mirror: typeof b[k] };
      if (!(k in b)) return { path: `${p}.${k}`, prod: typeof a[k], mirror: '<missing>' };
      const d = firstDiff(a[k], b[k], `${p}.${k}`);
      if (d) return d;
    }
    return null;
  }
  if (!isDeepStrictEqual(a, b)) return { path: p, prod: a, mirror: b };
  return null;
}

function runScript(script, runId, label) {
  const res = spawnSync('node', [path.join(SKILL_ROOT, script), '--runId', runId], {
    cwd: SKILL_ROOT,
    env: { ...process.env, FUTURES_RUNTIME_ROOT: EXPERIMENT_ROOT },
    encoding: 'utf8',
    timeout: 300000,
  });
  if (res.status !== 0) {
    const tail = (res.stderr || res.stdout || '').split('\n').slice(-8).join('\n');
    throw new Error(`${label} failed (exit ${res.status}):\n${tail}`);
  }
  return { stdout: res.stdout || '', stderr: res.stderr || '' };
}

function cmdInit() {
  const blueprint = {
    schema: 'futures-radar-experiment-line-blueprint/1',
    architectureRef: 'strategies/research/v2/experiment-line-architecture.md',
    architectureVersion: 'v6',
    createdAt: nowIso(),
    policy: {
      promoteUnit: 'whole-stage-segment',
      hotUpdateWhitelist: false,
      g1GateRequired: true,
      shadow: {
        verdictRulesAtRegister: true,
        fixedObservationWindow: false,
        reviewSnapshotsImmutable: true,
      },
    },
    stages: stages.map((s) => ({
      id: s.id,
      auto: Boolean(s.auto),
      stable: s.script
        ? { script: s.script, outputs: s.outputs || [] }
        : { manual: true, outputs: s.outputs || [] },
      candidate: null,
    })),
  };
  writeJson(BLUEPRINT_FILE, blueprint);
  fs.mkdirSync(RUNS_DIR, { recursive: true });
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  console.log(`blueprint: ${BLUEPRINT_FILE}`);
  console.log(`stages: ${stages.length} (auto=${stages.filter((s) => s.auto).length}, manual=${stages.filter((s) => !s.auto).length})`);
}

function cmdReplay(prodRunId) {
  const { runDir } = require(path.join(SKILL_ROOT, 'lib', 'workspace.cjs'));
  const prodDir = runDir(prodRunId);
  if (!fs.existsSync(prodDir)) throw new Error(`production run not found: ${prodDir}`);
  const blueprint = fs.existsSync(BLUEPRINT_FILE) ? readJson(BLUEPRINT_FILE) : null;
  if (!blueprint) throw new Error('run `node experiment-line/mirror.cjs init` first');

  const mirrorRunId = prodRunId; // 镜像与生产同 runId：runId 内嵌契约与 inputsSha 才能逐字节一致；两线由运行时根隔离
  const mirrorDir = path.join(RUNS_DIR, mirrorRunId);
  fs.rmSync(mirrorDir, { recursive: true, force: true });
  fs.cpSync(prodDir, mirrorDir, { recursive: true });
  console.log(`mirror: ${mirrorDir}`);

  const checks = [];
  for (const st of blueprint.stages) {
    if (NETWORK_STAGES.has(st.id)) {
      const missing = (st.stable.outputs || []).filter((o) => !fs.existsSync(path.join(mirrorDir, outputName(st.id, o))));
      checks.push({
        stage: st.id, mode: 'inherited', status: missing.length ? 'missing-artifacts' : 'ok',
        note: missing.length ? `missing: ${missing.join(',')}` : 'network stage artifacts inherited from production run',
      });
      continue;
    }
    if (MANUAL_STAGES.has(st.id)) {
      checks.push({ stage: st.id, mode: 'inherited', status: 'ok', note: 'manual stage artifact inherited (not replayed)' });
      continue;
    }
    if (!st.stable.script) {
      checks.push({ stage: st.id, mode: 'inherited', status: 'ok', note: 'no deterministic script in stable config' });
      continue;
    }
    let status = 'pass';
    let diff = null;
    let error = null;
    try {
      runScript(st.stable.script, mirrorRunId, st.id);
      for (const out of st.stable.outputs || []) {
        const name = outputName(st.id, out);
        const prodFile = path.join(prodDir, name);
        const mirrorFile = path.join(mirrorDir, name);
        if (!fs.existsSync(prodFile) || !fs.existsSync(mirrorFile)) {
          status = 'artifact-missing';
          continue;
        }
        const prod = readArtifact(prodFile);
        const mirror = readArtifact(mirrorFile);
        const cmp = compareArtifact(prod, mirror, prodRunId, mirrorRunId);
        if (cmp.status !== 'pass') {
          status = cmp.status;
          diff = diff || { artifact: name, firstDiff: cmp.firstDiff || null };
        }
      }
    } catch (e) {
      status = 'error';
      error = String(e.message || e);
    }
    checks.push({ stage: st.id, mode: 'replayed', status, diff: diff || null, error: error || null });
    console.log(`[${st.id}] ${status}${diff ? ` ${diff.artifact}@${diff.firstDiff?.path}` : ''}`);
  }

  // 策略适配环节（production strategy-plan）——核心镜像验证：实验线完整调用生产 matcher。
  // matcher 是纯函数；为保证 inputsSha 逐字节一致，运行前把其 7 个输入文件恢复为生产原文件。
  const planCheck = { stage: 'strategy-plan', mode: 'replayed', status: 'pass' };
  try {
    const matcherInputs = [
      'report-model.json', 'probability.json', 'sector-snapshot.json', 'sector-driver.json',
      'macro-snapshot.json', 'analysis.json', 'raw.json',
    ];
    for (const f of matcherInputs) {
      const src = path.join(prodDir, f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(mirrorDir, f));
    }
    runScript('strategies/build-strategy-plan.cjs', mirrorRunId, 'strategy-plan');
    const prodPlan = readArtifact(path.join(prodDir, 'strategy-plan.json'));
    const mirrorPlan = readArtifact(path.join(mirrorDir, 'strategy-plan.json'));
    const cmp = compareArtifact(prodPlan, mirrorPlan, prodRunId, mirrorRunId);
    planCheck.status = cmp.status;
    if (cmp.status !== 'pass') planCheck.diff = { artifact: 'strategy-plan.json', firstDiff: cmp.firstDiff || null };
  } catch (e) {
    planCheck.status = 'error';
    planCheck.error = String(e.message || e);
  }
  checks.push(planCheck);
  console.log(`[strategy-plan] ${planCheck.status}`);

  const ok = checks.filter((c) => ['pass', 'ok', 'version-drift'].includes(c.status)).length;
  const report = {
    schema: 'futures-radar-experiment-line-replay/1',
    generatedAt: nowIso(),
    mirrorRunId,
    mirrorRuntimeRoot: EXPERIMENT_ROOT,
    prodRunId,
    blueprintRef: BLUEPRINT_FILE,
    summary: {
      total: checks.length,
      ok,
      diff: checks.filter((c) => c.status === 'diff').length,
      versionDrift: checks.filter((c) => c.status === 'version-drift').length,
      error: checks.filter((c) => c.status === 'error').length,
    },
    checks,
  };
  const outFile = path.join(RESULTS_DIR, `${mirrorRunId}-replay.json`);
  writeJson(outFile, report);
  console.log(`baseline: ${ok}/${checks.length} stages consistent (diff=${report.summary.diff}, error=${report.summary.error})`);
  console.log(`report: ${outFile}`);
  return report;
}

function outputName(stageId, artifactId) {
  const { artifacts } = require(path.join(SKILL_ROOT, 'pipeline', 'contracts.cjs'));
  const a = artifacts.find((x) => x.id === artifactId);
  if (a) return a.path.replace('{runDir}/', '').replace('{runtimeRoot}/', '');
  return artifactId;
}

function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const flagVal = (f) => {
    const i = args.indexOf(f);
    return i === -1 ? null : args[i + 1];
  };
  if (cmd === 'init') return cmdInit();
  if (cmd === 'replay') {
    const runId = flagVal('--runId');
    if (!runId) throw new Error('replay requires --runId <production runId>');
    return cmdReplay(runId);
  }
  throw new Error('usage: node experiment-line/mirror.cjs init | replay --runId <runId>');
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(`FATAL: ${e.message}`);
    process.exit(1);
  }
}

module.exports = { cmdInit, cmdReplay, normalize, compareArtifact, firstDiff };
