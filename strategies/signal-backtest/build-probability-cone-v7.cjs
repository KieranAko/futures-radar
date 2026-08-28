// strategies/signal-backtest/build-probability-cone-v7.cjs — 用生产概率模块为回测锚点计算真实概率锥
//
// 目的：把“定价依据”还回生产链路——strategy-matcher 的 targets 需要 probability.json 的
// HV 概率锥；回测不能再用手写 ATR 代理。本脚本对每个锚点截断 bars，调用生产
// probability/hv-estimators（Yang-Zhang）与 probability/probability-cone.js（GBM 闭式）。
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = __dirname;
const V7 = path.join(ROOT, 'recordings', 'v7');
const SYMBOLS = ['RB0', 'M0', 'SC0'];

async function main() {
  const { probabilityCone } = await import('../../probability/probability-cone.js');
  const { yangZhangVolatility } = await import('../../probability/hv-estimators.js');
  const history = JSON.parse(fs.readFileSync(path.join(ROOT, 'recordings', 'v5', 'history-2y.json'), 'utf8'));
  const outDir = path.join(V7, 'probability');
  fs.mkdirSync(outDir, { recursive: true });
  const manifest = { schema: 'futures-radar-v7-probability-manifest/1', generatedAt: new Date().toISOString(), symbols: [] };
  for (const sym of SYMBOLS) {
    const evidence = JSON.parse(fs.readFileSync(path.join(V7, `evidence-${sym}.json`), 'utf8'));
    const bars = history.symbols[sym].bars;
    const rows = [];
    for (const row of evidence.rows) {
      const idx = bars.findIndex(b => b.date === row.d);
      if (idx < 20) continue;
      const slice = bars.slice(0, idx + 1);
      const est = yangZhangVolatility(slice, 20);
      const close = slice[idx].close;
      const cone = probabilityCone(close, est.hv, [3, 5], [1.0, 1.96]);
      const entry = {
        schema: 'futures-radar-v7-probability/1',
        symbol: sym, date: row.d, close,
        hv: { annual: +est.hv.toFixed(4), periodDays: 20, percentile90d: 50, degraded: est.degraded, correctionCount: est.correctionCount },
        cone
      };
      fs.writeFileSync(path.join(outDir, `${sym}-${row.d}.json`), JSON.stringify(entry, null, 2), 'utf8');
      rows.push({ symbol: sym, date: row.d, path: path.relative(V7, path.join(outDir, `${sym}-${row.d}.json`)) });
    }
    manifest.symbols.push({ symbol: sym, rows });
  }
  fs.writeFileSync(path.join(V7, 'probability-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
