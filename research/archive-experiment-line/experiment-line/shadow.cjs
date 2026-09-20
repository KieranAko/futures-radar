// experiment-line/shadow.cjs — 影子模式框架（v6 架构 AD-7：观察期不预固定，判决规则在
// register 写死；定期人工 review 生成不可事后修改的证据快照）
//
// 用法:
//   node experiment-line/shadow.cjs init --candidate <candidateId>
//   node experiment-line/shadow.cjs review --candidate <candidateId> --runId <生产runId>
//   node experiment-line/shadow.cjs list
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const EL = __dirname;
const SHADOW_DIR = path.join(EL, 'shadow');

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

function loadCandidate(id) {
  const dir = path.join(EL, 'candidates');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const c = readJson(path.join(dir, f));
    if (c.id === id) return c;
  }
  return null;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function cmdInit(candidateId) {
  const c = loadCandidate(candidateId);
  if (!c) throw new Error(`candidate not found: ${candidateId}`);
  const target = path.join(SHADOW_DIR, `${candidateId}.json`);
  if (fs.existsSync(target)) throw new Error(`shadow already initialized: ${target}`);
  const rec = {
    schema: 'futures-radar-experiment-line-shadow/1',
    candidateId,
    stage: c.stage,
    initializedAt: nowIso(),
    verdictRules: c.verdictRules || null,
    theoryRef: c.theoryRef,
    reviews: [],
    status: 'observing',
  };
  writeJson(target, rec);
  console.log(`shadow initialized: ${target}`);
  return rec;
}

function cmdReview(candidateId, runId) {
  const recFile = path.join(SHADOW_DIR, `${candidateId}.json`);
  if (!fs.existsSync(recFile)) throw new Error(`shadow not initialized: ${candidateId}`);
  const rec = readJson(recFile);

  const evidenceFiles = [];
  const trustFile = path.join(EL, 'results', 'trust', `${runId}.json`);
  if (fs.existsSync(trustFile)) evidenceFiles.push(trustFile);
  const replayFile = path.join(EL, 'results', `${runId}-replay.json`);
  if (fs.existsSync(replayFile)) evidenceFiles.push(replayFile);
  if (!evidenceFiles.length) throw new Error(`no evidence for run ${runId}: run mirror replay and trust-model first`);

  const snapshot = {
    schema: 'futures-radar-experiment-line-shadow-snapshot/1',
    candidateId,
    runId,
    reviewedAt: nowIso(),
    evidence: Object.fromEntries(evidenceFiles.map((f) => [path.basename(f), { path: f.replace(`${EL}/`, 'experiment-line/').replace(/\\/g, '/'), sha256: sha256(f) }])),
  };
  const snapDir = path.join(SHADOW_DIR, candidateId, 'snapshots');
  fs.mkdirSync(snapDir, { recursive: true });
  const snapFile = path.join(snapDir, `${runId}-${snapshot.reviewedAt.replace(/[:.]/g, '-')}.json`);
  writeJson(snapFile, snapshot);

  rec.reviews.push({
    runId,
    reviewedAt: snapshot.reviewedAt,
    snapshotRef: snapFile.replace(`${EL}/`, 'experiment-line/').replace(/\\/g, '/'),
    snapshotSha256: sha256(snapFile),
  });
  writeJson(recFile, rec);
  console.log(`snapshot: ${snapFile}`);
  console.log(`reviews: ${rec.reviews.length}`);
  return rec;
}

function cmdList() {
  if (!fs.existsSync(SHADOW_DIR)) return [];
  const rows = fs.readdirSync(SHADOW_DIR)
    .filter((f) => f.endsWith('.json') && fs.statSync(path.join(SHADOW_DIR, f)).isFile())
    .map((f) => readJson(path.join(SHADOW_DIR, f)));
  for (const r of rows) console.log(`${r.candidateId}  ${r.status}  reviews=${r.reviews.length}`);
  return rows;
}

function main() {
  const args = process.argv.slice(2);
  const flag = (f) => {
    const i = args.indexOf(f);
    return i === -1 ? null : args[i + 1];
  };
  if (args[0] === 'init') return cmdInit(flag('--candidate'));
  if (args[0] === 'review') return cmdReview(flag('--candidate'), flag('--runId'));
  if (args[0] === 'list') return cmdList();
  throw new Error('usage: node experiment-line/shadow.cjs init|review|list ...');
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(`FATAL: ${e.message}`);
    process.exit(1);
  }
}

module.exports = { cmdInit, cmdReview, cmdList, SHADOW_DIR };
