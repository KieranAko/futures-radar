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

  if (type === 'family-evidence-closure') {
    const evidenceSha = sha256(fromPath);
    fs.copyFileSync(fromPath, toPath);
    const id = `promote-${Date.now()}-${evidenceSha.slice(0, 8)}`;
    const rec = {
      schema: 'futures-radar-experiment-line-promotion/1',
      id, type, promotedAt: nowIso(), from, to, note,
      evidenceSha256: evidenceSha, baseline,
      revert: { action: 'delete-target', target: to },
    };
    writeJson(path.join(PROMO_DIR, `${id}.json`), rec);
    console.log(`promoted: ${from} -> ${to}`);
    console.log(`promotion id: ${id}`);
    console.log(`baseline: ${JSON.stringify(baseline)}`);
    return rec;
  }

  if (type === 'analyze-v2') {
    // 整段搬迁：v2 工具链目录 → 生产 analyze/v2 + 蓝图替换（旧蓝图归档，支持回滚）
    if (!fs.statSync(fromPath).isDirectory()) throw new Error('analyze-v2 promote requires a directory');
    fs.rmSync(toPath, { recursive: true, force: true });
    fs.cpSync(fromPath, toPath, { recursive: true });
    const blueprint = path.join(ROOT, 'analyze', 'blueprint.md');
    const legacy = path.join(ROOT, 'analyze', 'blueprint-legacy.md');
    const hadBlueprint = fs.existsSync(blueprint);
    if (hadBlueprint && !fs.existsSync(legacy)) fs.copyFileSync(blueprint, legacy);
    fs.writeFileSync(blueprint, ANALYZE_V2_BLUEPRINT, 'utf8');

    const id = `promote-${Date.now()}-analyze-v2`;
    const rec = {
      schema: 'futures-radar-experiment-line-promotion/1',
      id, type, promotedAt: nowIso(), from, to, note,
      baseline,
      revert: {
        action: 'analyze-v2-revert',
        targetDir: to,
        blueprint: 'analyze/blueprint.md',
        legacy: 'analyze/blueprint-legacy.md',
        hadBlueprint,
      },
    };
    writeJson(path.join(PROMO_DIR, `${id}.json`), rec);
    console.log(`promoted analyze-v2: ${from} -> ${to}`);
    console.log(`blueprint: ${blueprint}（旧版归档 ${legacy}）`);
    console.log(`promotion id: ${id}`);
    console.log(`baseline: ${JSON.stringify(baseline)}`);
    return rec;
  }

  throw new Error(`unknown promotion type: ${type}`);
}

const ANALYZE_V2_BLUEPRINT = `# Analyze Blueprint v2 — 单轮合并推理（promote 自实验线 analyze candidate v2）

> Stage: 4 (after filter-llm) | Type: LLM manual | 输出：analysis.json + reasoning-results.json + sector-driver.json
> 旧版（多轮：freeze-packets → sector-driver LLM → FinCoT → 六问）归档于 blueprint-legacy.md。

## 流程（2 次逻辑 LLM 调用）

1. 自动：\`node analyze/v2/packet-freeze-v2.cjs --runId <runId>\`（确定性冻结：价格/量/OI/期限结构(GA-8)/宏观/板块/机制候选/昨日结论缓存）
2. 自动：\`node analyze/v2/prefill-v2.cjs --runId <runId>\`（Q2/Q4/Q5/Q6 确定性预填）
3. 自动：\`node analyze/v2/prompt-builder-v2.cjs --runId <runId>\`（生成 prompts-v2.md）
4. LLM：按 prompts-v2.md 执行 P1 板块批量 + P2 品种批量，一次输出写 \`analyze/outputs-v2.json\`
5. 自动：\`node analyze/v2/assemble-v2.cjs --runId <runId> --as-production\`（组装生产兼容六问 + grounding/等价性校验 + sector-driver.json）

## 纪律（继承自 FinCoT v5 与 v6）

- evidenceCheck.evidenceIds 只能引用 packet 字段；grounding fail-closed；
- 方向必须与 prefill 结构一致或显式 override；pass→neutral 且注明原因；
- 机制候选来自实验线 registry；机制目录为空时 matchStatus=unknown；
- 输出不构成投资建议；不新增数据源、不联网。
`;

function cmdRevert(id) {
  const recFile = path.join(PROMO_DIR, `${id}.json`);
  if (!fs.existsSync(recFile)) throw new Error(`promotion not found: ${id}`);
  const rec = readJson(recFile);
  if (rec.revert.action === 'delete-target') {
    const target = path.join(ROOT, rec.revert.target);
    if (fs.existsSync(target)) fs.rmSync(target);
    rec.revertedAt = nowIso();
    writeJson(recFile, rec);
    console.log(`reverted: removed ${rec.revert.target}`);
  } else if (rec.revert.action === 'analyze-v2-revert') {
    const target = path.join(ROOT, rec.revert.targetDir);
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
    const blueprint = path.join(ROOT, rec.revert.blueprint);
    const legacy = path.join(ROOT, rec.revert.legacy);
    if (rec.revert.hadBlueprint && fs.existsSync(legacy)) {
      fs.copyFileSync(legacy, blueprint);
      fs.rmSync(legacy);
    } else if (!rec.revert.hadBlueprint && fs.existsSync(blueprint)) {
      fs.rmSync(blueprint);
    }
    rec.revertedAt = nowIso();
    writeJson(recFile, rec);
    console.log('reverted analyze-v2: removed production analyze/v2 and restored legacy blueprint');
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
