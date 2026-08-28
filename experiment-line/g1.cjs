// experiment-line/g1.cjs — G1 机制命题检验前置入口（v6 架构 P5/AD-5）
//
// 职责：candidate 进入整链回放前，必须先注册机制并跑最便宜的命题检验。
// 本阶段实现注册表 + 判定协议；检验执行复用现有机制探针（mechanism-bound-probes.cjs）。
//
// 用法:
//   node experiment-line/g1.cjs init
//   node experiment-line/g1.cjs register --file <机制JSON>
//   node experiment-line/g1.cjs probe --id <机制id>
//   node experiment-line/g1.cjs list
//
// 机制 JSON 必填字段:
//   id, name, family, theoryRef, proposition, whyItWorks,
//   applicableStates, timeScale, invalidation, probeRef, g1Decision
// g1Decision（判决先于实验，01-L3）:
//   { promote: "probe decision 等于该值", discard: [...], pending: {maxRounds: N} }
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const REGISTRY_DIR = path.join(__dirname, 'registry');
const PROBE_RUNNER = 'strategies/research/v2/falsification/mechanism/mechanism-bound-probes.cjs';
const PROBE_RESULTS_DIR = path.join(ROOT, 'strategies', 'research', 'v2', 'falsification', 'mechanism', 'probe-results');

const REQUIRED = [
  'id', 'name', 'family', 'theoryRef', 'proposition', 'whyItWorks',
  'applicableStates', 'timeScale', 'invalidation', 'probeRef', 'g1Decision',
];

function nowIso() {
  return new Date().toISOString();
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function cmdInit() {
  fs.mkdirSync(REGISTRY_DIR, { recursive: true });
  console.log(`registry: ${REGISTRY_DIR}`);
}

function cmdRegister(file) {
  const mech = readJson(file);
  const missing = REQUIRED.filter((k) => !(k in mech));
  if (missing.length) throw new Error(`missing required fields: ${missing.join(', ')}`);
  if (!mech.theoryRef || !/^0\d/.test(String(mech.theoryRef || ''))) {
    throw new Error('theoryRef must reference theory-base report (e.g. 02-term-structure.md §一 T1)');
  }
  if (!mech.g1Decision.promote || !Array.isArray(mech.g1Decision.discard)) {
    throw new Error('g1Decision must have promote and discard[]');
  }
  const out = {
    schema: 'futures-radar-experiment-line-g1-registry/1',
    registeredAt: nowIso(),
    status: 'registered',
    g1: null,
    ...mech,
  };
  const target = path.join(REGISTRY_DIR, `${mech.id}.json`);
  writeJson(target, out);
  console.log(`registered: ${target}`);
  return out;
}

function cmdProbe(id) {
  const regFile = path.join(REGISTRY_DIR, `${id}.json`);
  if (!fs.existsSync(regFile)) throw new Error(`mechanism not registered: ${id}`);
  const reg = readJson(regFile);
  const res = spawnSync('node', [path.join(ROOT, PROBE_RUNNER), '--hypothesis', id], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 600000,
  });
  if (res.status !== 0) {
    reg.g1 = { ranAt: nowIso(), status: 'error', detail: String(res.stderr || res.stdout || '').slice(-2000) };
    reg.status = 'g1_error';
    writeJson(regFile, reg);
    throw new Error(`probe failed (exit ${res.status}):\n${reg.g1.detail}`);
  }
  const resultFile = path.join(PROBE_RESULTS_DIR, `${id}-probe.json`);
  if (!fs.existsSync(resultFile)) throw new Error(`probe result not found: ${resultFile}`);
  const result = readJson(resultFile);
  const decision = result.decision;
  const d = reg.g1Decision;
  let verdict;
  let status;
  if (decision === d.promote) {
    verdict = 'promote';
    status = 'g1_pass';
  } else if ((d.discard || []).includes(decision)) {
    verdict = 'discard';
    status = 'g1_fail';
  } else {
    const maxRounds = (d.pending && d.pending.maxRounds) || 1;
    const prevRounds = (reg.g1 && reg.g1.pendingRounds) || 0;
    const pendingRounds = prevRounds + 1;
    verdict = 'pending';
    status = pendingRounds >= maxRounds ? 'g1_timeout' : 'g1_pending';
    reg.g1 = { ...(reg.g1 || {}), pendingRounds };
  }
  reg.g1 = {
    ...(reg.g1 || {}),
    ranAt: nowIso(),
    decision,
    verdict,
    resultRef: `strategies/research/v2/falsification/mechanism/probe-results/${id}-probe.json`,
    result: {
      n: result.primary?.n,
      meanNetPct: result.primary?.meanNetPct,
      ciLo: result.primary?.ci?.lo,
      ciHi: result.primary?.ci?.hi,
    },
  };
  reg.status = status;
  writeJson(regFile, reg);
  console.log(`[${id}] decision=${decision} -> verdict=${verdict} status=${status}`);
  return reg;
}

function cmdList() {
  const rows = fs.existsSync(REGISTRY_DIR)
    ? fs.readdirSync(REGISTRY_DIR).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(REGISTRY_DIR, f)))
    : [];
  for (const r of rows) {
    console.log(`${r.id}  ${r.status}  family=${r.family}  g1=${r.g1 ? r.g1.verdict : '-'}`);
  }
  return rows;
}

function main() {
  const args = process.argv.slice(2);
  const flagVal = (f) => {
    const i = args.indexOf(f);
    return i === -1 ? null : args[i + 1];
  };
  if (args[0] === 'init') return cmdInit();
  if (args[0] === 'register') {
    const f = flagVal('--file');
    if (!f) throw new Error('register requires --file');
    return cmdRegister(path.resolve(ROOT, f));
  }
  if (args[0] === 'probe') {
    const id = flagVal('--id');
    if (!id) throw new Error('probe requires --id');
    return cmdProbe(id);
  }
  if (args[0] === 'list') return cmdList();
  throw new Error('usage: node experiment-line/g1.cjs init | register --file <json> | probe --id <id> | list');
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(`FATAL: ${e.message}`);
    process.exit(1);
  }
}

module.exports = { cmdInit, cmdRegister, cmdProbe, cmdList, REGISTRY_DIR };
