// experiment-line/promote.cjs — promote/revert 决策记录与负面结论传导（v6 P5/P6）
//
// promote 单位 = 完整环节段或已冻结的证据状态文件；本阶段第一个 promote 是
// "carry 族 G1 关闭"负面结论 → 生产可读的 strategies/family-evidence.json。
//
// 用法:
//   node experiment-line/promote.cjs record --type family-evidence-closure \
//     --from experiment-line/evidence/family-evidence.json --to strategies/family-evidence.json
//   node experiment-line/promote.cjs revert --id <promotionId>
//   node experiment-line/promote.cjs list
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const EL = __dirname;
const PROMO_DIR = path.join(EL, 'promotions');

function nowIso() {
  return new Date().toISOString();
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function cmdRecord(type, from, to, note = '') {
  if (type !== 'family-evidence-closure') throw new Error(`unknown promotion type: ${type}`);
  const fromPath = path.join(ROOT, from);
  const toPath = path.join(ROOT, to);
  if (!fs.existsSync(fromPath)) throw new Error(`evidence source missing: ${fromPath}`);

  // 前置：证据冻结（sha 记录）+ 镜像基线一致性（最近一次 replay 无 diff/error）
  const resultsDir = path.join(EL, 'results');
  const replayFiles = fs.existsSync(resultsDir) ? fs.readdirSync(resultsDir).filter((f) => f.endsWith('-replay.json')) : [];
  const latestReplay = replayFiles.sort().pop();
  let baseline = null;
  if (latestReplay) {
    const r = readJson(path.join(resultsDir, latestReplay));
    baseline = { file: latestReplay, diff: r.summary.diff, error: r.summary.error, ok: r.summary.ok };
  }
  if (!baseline || baseline.diff !== 0 || baseline.error !== 0) {
    throw new Error(`promote blocked: stable replay baseline not clean (${JSON.stringify(baseline)})`);
  }

  const evidenceSha = sha256(fromPath);
  fs.copyFileSync(fromPath, toPath);

  const id = `promote-${Date.now()}-${evidenceSha.slice(0, 8)}`;
  const rec = {
    schema: 'futures-radar-experiment-line-promotion/1',
    id,
    type,
    promotedAt: nowIso(),
    from,
    to,
    note,
    evidenceSha256: evidenceSha,
    baseline,
    revert: { action: 'delete-target-and-restore-nothing', target: to },
  };
  writeJson(path.join(PROMO_DIR, `${id}.json`), rec);
  console.log(`promoted: ${from} -> ${to}`);
  console.log(`promotion id: ${id}`);
  console.log(`baseline: ${JSON.stringify(baseline)}`);
  return rec;
}

function cmdRevert(id) {
  const recFile = path.join(PROMO_DIR, `${id}.json`);
  if (!fs.existsSync(recFile)) throw new Error(`promotion not found: ${id}`);
  const rec = readJson(recFile);
  if (rec.revert.action === 'delete-target-and-restore-nothing') {
    const target = path.join(ROOT, rec.revert.target);
    if (fs.existsSync(target)) fs.rmSync(target);
    rec.revertedAt = nowIso();
    writeJson(recFile, rec);
    console.log(`reverted: removed ${rec.revert.target}`);
  } else {
    throw new Error(`unknown revert action: ${rec.revert.action}`);
  }
  return rec;
}

function cmdList() {
  if (!fs.existsSync(PROMO_DIR)) return [];
  const rows = fs.readdirSync(PROMO_DIR).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(PROMO_DIR, f)));
  for (const r of rows) console.log(`${r.id}  ${r.type}  ${r.promotedAt}  reverted=${Boolean(r.revertedAt)}`);
  return rows;
}

function main() {
  const args = process.argv.slice(2);
  const flag = (f) => {
    const i = args.indexOf(f);
    return i === -1 ? null : args[i + 1];
  };
  if (args[0] === 'record') return cmdRecord(flag('--type'), flag('--from'), flag('--to'), flag('--note') || '');
  if (args[0] === 'revert') return cmdRevert(flag('--id'));
  if (args[0] === 'list') return cmdList();
  throw new Error('usage: node experiment-line/promote.cjs record|revert|list ...');
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(`FATAL: ${e.message}`);
    process.exit(1);
  }
}

module.exports = { cmdRecord, cmdRevert, cmdList, PROMO_DIR };
