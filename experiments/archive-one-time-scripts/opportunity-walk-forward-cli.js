#!/usr/bin/env node
/**
 * Usage: node experiments/opportunity-walk-forward-cli.js [output.json]
 *
 * Train 内 walk-forward：fold1(2024) 上选参数，fold2(2025)/fold3(2026H1) 上检验稳定性。
 * 45 天 valid 集已披露一次，不能再用于新参数验证；本工具只使用 train 池内部数据。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { buildTrainRows, applyKnobs, aggregate, KNOB_GRID, FROZEN } from './lib/opportunity-knob-scan.js';

const require = createRequire(import.meta.url);
const { loadCache } = require('../backtest/cache-slicer.cjs');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../../../..');

const outputPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(root, 'data/futures-radar/train/opportunity-walk-forward-2026-08-14.json');

const FOLDS = [
  { name: 'fold1-2024', first: '2024-01-02', last: '2024-12-31' },
  { name: 'fold2-2025', first: '2025-01-01', last: '2025-12-31' },
  { name: 'fold3-2026h1', first: '2026-01-01', last: '2026-06-16' }
];

const { rows } = buildTrainRows(loadCache());

const result = { folds: {} };
for (const fold of FOLDS) {
  const foldRows = rows.filter(r => r.signalDate >= fold.first && r.signalDate <= fold.last);
  result.folds[fold.name] = {
    first: fold.first,
    last: fold.last,
    cells: KNOB_GRID.map(({ name, overrides }) => ({
      name,
      ...aggregate(applyKnobs(foldRows, overrides))
    }))
  };
}

// fold1 选择：命中率最高且 n≥100 的旋钮（排除 frozen 之外的任意单元格）
const fold1 = result.folds['fold1-2024'].cells;
const eligible = fold1.filter(c => c.withOutcome >= 100);
const winner = eligible.reduce((a, b) => (a.hitRate > b.hitRate ? a : b));
result.selectionProtocol = 'winner picked on fold1-2024 (n>=100), stability checked on fold2/fold3';
result.selected = winner.name;
result.frozen = FROZEN;

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), { encoding: 'utf8', flag: 'w' });

for (const [foldName, fold] of Object.entries(result.folds)) {
  console.log(`\n${foldName} (${fold.first}..${fold.last}):`);
  for (const c of fold.cells) {
    const hit = c.hitRate === null ? 'null' : `${(c.hitRate * 100).toFixed(2)}%`;
    console.log(`  ${c.name.padEnd(18)} wo=${String(c.withOutcome).padStart(4)} strong=${String(c.strong).padStart(4)} hit=${hit}`);
  }
}
console.log(`\nselected on fold1: ${winner.name}`);
