// experiment-line/mechanism-identify.cjs — analyze 环节 candidate（实验线实现，不改生产）
//
// 对镜像 run 的 analysis.json/report-model.json 输出 mechanismRef：
//   family（来源族，关键词规则 v1）→ 机制目录匹配（registry）→ matchStatus。
// 生产 analyze 只在 candidate promote 后才改造；本实现用于影子阶段证据积累。
//
// 用法: node experiment-line/mechanism-identify.cjs --runId <生产runId>
// 输出: experiment-line/results/mechanism-identify/<runId>.json
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const EL = __dirname;
const { inferFamily } = require(path.join(EL, '..', 'strategies', 'lib', 'family-infer.cjs'));

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function main(runIdArg) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--runId');
  const runId = runIdArg || (i >= 0 ? args[i + 1] : null);
  if (!runId) throw new Error('--runId required');

  const reportModel = readJson(path.join(EL, 'runs', runId, 'report-model.json'));
  const regDir = path.join(EL, 'registry');
  const registry = {};
  if (fs.existsSync(regDir)) {
    for (const f of fs.readdirSync(regDir).filter((x) => x.endsWith('.json'))) {
      registry[f.replace('.json', '')] = readJson(path.join(regDir, f));
    }
  }

  const rows = [];
  for (const opp of reportModel.opportunities || []) {
    const text = [
      opp.thesis?.driver?.primary,
      opp.thesis?.driver?.secondary,
      opp.thesis?.trendOrImpulse?.assessment,
      opp.thesis?.odds?.reasoning,
    ].join(' ');
    const family = inferFamily(text);
    const matches = Object.values(registry).filter((m) => m.family === family);
    rows.push({
      symbol: opp.symbol,
      family,
      inferenceRule: 'keyword-rule-v1（candidate 注册时声明，promote 前由正式机制识别替换）',
      mechanismIds: matches.map((m) => m.id),
      matchStatus: matches.length ? 'matched' : 'unknown',
      registryNote: matches.length ? `机制目录已有 ${matches.map((m) => `${m.id}(${m.status})`).join(', ')}` : '该族无已注册机制',
    });
  }

  const out = {
    schema: 'futures-radar-experiment-line-mechanism-identify/1',
    generatedAt: new Date().toISOString(),
    runId,
    candidateId: 'analyze-mechanism-identification-v1',
    rows,
  };
  const outDir = path.join(EL, 'results', 'mechanism-identify');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `${runId}.json`), JSON.stringify(out, null, 2) + '\n');
  console.log(`mechanismRef rows: ${rows.length}`);
  for (const r of rows) console.log(`  ${r.symbol}: family=${r.family} match=${r.matchStatus} mechs=[${r.mechanismIds.join(',')}]`);
  return out;
}

if (require.main === module) main();
module.exports = { main };
