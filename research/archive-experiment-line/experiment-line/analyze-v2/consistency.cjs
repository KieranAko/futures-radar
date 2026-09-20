// experiment-line/analyze-v2/consistency.cjs — 历史 run 批量回放一致率预检
//
// 对比：生产 analysis.json（原版） vs analyze-v2 单轮合并输出（analysis-v2.json）
// 口径：方向（bullish/bearish/neutral）+ 置信度（high/medium/low）
// 用法: node experiment-line/analyze-v2/consistency.cjs --runs 20260827-1910-auto,20260827-2159-auto
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const EL = path.join(ROOT, 'experiment-line');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--runs');
  const runs = (i >= 0 ? args[i + 1] : '').split(',').filter(Boolean);
  if (!runs.length) throw new Error('--runs required');

  const rows = [];
  for (const runId of runs) {
    const prodFile = path.join(EL, 'runs', runId, 'analysis.json');
    const v2File = path.join(EL, 'runs', runId, 'analyze', 'analysis-v2.json');
    if (!fs.existsSync(prodFile) || !fs.existsSync(v2File)) {
      rows.push({ runId, symbol: '—', status: 'skip', note: 'analysis 缺失' });
      continue;
    }
    const prod = readJson(prodFile);
    const v2 = readJson(v2File);
    const v2Map = Object.fromEntries(v2.analyses.map((a) => [a.symbol, a]));
    for (const p of prod.analyses || []) {
      const v = v2Map[p.symbol];
      if (!v) {
        rows.push({ runId, symbol: p.symbol, prod: `${p.direction}/${p.confidence}`, v2: '—', dirMatch: false, confMatch: false });
        continue;
      }
      rows.push({
        runId,
        symbol: p.symbol,
        prod: `${p.direction}/${p.confidence}`,
        v2: `${v.direction}/${v.confidence}`,
        dirMatch: p.direction === v.direction,
        confMatch: p.confidence === v.confidence,
      });
    }
  }

  const compared = rows.filter((r) => r.prod && r.v2);
  const dirMatches = compared.filter((r) => r.dirMatch);
  const confMatches = compared.filter((r) => r.confMatch);
  const out = {
    schema: 'futures-radar-analyze-v2-consistency/1',
    generatedAt: new Date().toISOString(),
    runs,
    summary: {
      compared: compared.length,
      directionMatches: dirMatches.length,
      directionAgreementPct: compared.length ? Math.round((dirMatches.length / compared.length) * 1000) / 10 : null,
      confidenceMatches: confMatches.length,
      confidenceAgreementPct: compared.length ? Math.round((confMatches.length / compared.length) * 1000) / 10 : null,
      targetDirectionPct: 90,
    },
    rows,
    caveats: [
      '回放环境无当日 WebSearch：v2 驱动字段基于 packet 数据独立判断，source 已如实标注',
      '置信度一致率受回放信息缺失影响，仅方向一致率作为预检主指标',
      'pass→neutral 映射按生产口径（finCoT pass 映射 neutral）',
    ],
  };
  const outFile = path.join(EL, 'results', 'analyze-v2-replay-consistency.json');
  writeJson(outFile, out);
  console.log(`direction agreement: ${out.summary.directionAgreementPct}% (${dirMatches.length}/${compared.length})`);
  console.log(`confidence agreement: ${out.summary.confidenceAgreementPct}% (${confMatches.length}/${compared.length})`);
  for (const r of rows) console.log(`  ${r.runId} ${r.symbol}: prod=${r.prod} v2=${r.v2} dir=${r.dirMatch}`);
  console.log(`result: ${outFile}`);
  return out;
}

if (require.main === module) main();
module.exports = { main };
