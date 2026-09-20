// strategies/signal-backtest/context-diff-sensitivity.cjs — v6.1 变化检测阈值敏感性（只报告，不选优）
//
// 对 v5 冻结 bundle 跑三档 diff 配置，输出各品种 fresh/reused 计数。
// 本工具不修改任何 recordings，不参与执行闸门。
'use strict';

const fs = require('fs');
const path = require('path');
const { V5 } = require('./context-bundle-builder.cjs');
const { diffRowsWith } = require('./context-diff.cjs');

const CONFIGS = [
  { id: 'baseline', macroMinAbs: 0.5, macroMinFlips: 2, sectorMinAbs: 1.0, momentumMinAbs: 2.0 },
  { id: 'relaxed', macroMinAbs: 1.0, macroMinFlips: 3, sectorMinAbs: 1.5, momentumMinAbs: 3.0 },
  { id: 'strict', macroMinAbs: 0.25, macroMinFlips: 2, sectorMinAbs: 0.5, momentumMinAbs: 1.0 }
];

function run() {
  const out = { schema: 'futures-radar-context-diff-sensitivity/1', generatedAt: new Date().toISOString(), symbols: [], configs: CONFIGS };
  for (const sym of ['RB0', 'M0', 'SC0']) {
    const bundle = JSON.parse(fs.readFileSync(path.join(V5, `bundle-${sym}.json`), 'utf8'));
    const rows = bundle.rows;
    const per = [];
    for (const cfg of CONFIGS) {
      let changed = 0; let reused = 0;
      for (let i = 0; i < rows.length; i++) {
        const d = diffRowsWith(i > 0 ? rows[i - 1] : null, rows[i], cfg);
        d.changed ? changed++ : reused++;
      }
      per.push({ config: cfg.id, changed, reused });
    }
    out.symbols.push({ symbol: sym, counts: per });
  }
  const p = path.join(V5, 'diff-sensitivity.json');
  fs.writeFileSync(p, JSON.stringify(out, null, 2), 'utf8');
  return out;
}

if (require.main === module) console.log(JSON.stringify(run(), null, 2));

module.exports = { run };
