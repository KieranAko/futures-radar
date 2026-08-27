#!/usr/bin/env node
/**
 * train-2 全量扫描（660 交易日：2023-10-30..2026-07-20，含已披露 45 日 valid + 23 日 holdout）
 *
 * 一次性报告工具：不选参、不调参，旋钮网格与 train 扫描相同（KNOB_GRID）。
 * 子集一致性锚点：截回 592 日 train 窗口必须复现 1195/1184/796，否则视为管道漂移。
 * 另附 T+11 purge 视图（>=12 交易日间隔）与 purge 后的 walk-forward folds。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { buildReplayRaw } from './lib/historical-holdout.js';
import { scanDateRows, applyKnobs, aggregate, KNOB_GRID } from './lib/opportunity-knob-scan.js';

const require = createRequire(import.meta.url);
const { loadCache } = require('../../backtest/cache-slicer.cjs');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../../..');
const OUT = path.join(root, 'data/futures-radar/train/result-train2-scan.json');

const TRAIN2_FIRST = '2023-10-30';
const TRAIN2_LAST = '2026-07-20';
const SUBSET_FIRST = '2024-01-02';
const SUBSET_LAST = '2026-06-16';

const FOLDS = [
  { name: 'fold1-2024', first: '2024-01-02', last: '2024-12-31' },
  { name: 'fold2-2025', first: '2025-01-01', last: '2025-12-31' },
  { name: 'fold3-2026h1', first: '2026-01-01', last: '2026-06-16' }
];

const cache = loadCache();
const raw = buildReplayRaw(cache);
const cuDates = cache.contracts['CU0'].ohlcv.dates;

const train2Dates = cuDates.filter(d => d >= TRAIN2_FIRST && d <= TRAIN2_LAST);

const rows = [];
for (const d of train2Dates) rows.push(...scanDateRows(d, raw));

// 子集一致性锚点：frozen 配置在 592 日子集上必须复现官方口径
const subsetRows = rows.filter(r => r.signalDate >= SUBSET_FIRST && r.signalDate <= SUBSET_LAST);
const frozenOnSubset = aggregate(applyKnobs(subsetRows, {}));
if (frozenOnSubset.candidates !== 1195 || frozenOnSubset.withOutcome !== 1184 || frozenOnSubset.strong !== 796) {
  throw new Error(
    `subset anchor mismatch: ${frozenOnSubset.candidates}/${frozenOnSubset.withOutcome}/${frozenOnSubset.strong}, expected 1195/1184/796`
  );
}

const cells = KNOB_GRID.map(({ name, overrides }) => ({
  name,
  ...aggregate(applyKnobs(rows, overrides))
}));

// T+11 purge 视图（>=12 交易日间隔，日期级：保留日上的全部候选一起保留）
const idx = new Map(cuDates.map((d, i) => [d, i]));
const bearing = [...new Set(rows.map(r => r.signalDate))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
const kept = new Set();
let lastIdx = -Infinity;
for (const d of bearing) {
  const i = idx.get(d);
  if (i === undefined) continue;
  if (i >= lastIdx + 12) {
    kept.add(d);
    lastIdx = i;
  }
}
const purged = rows.filter(r => kept.has(r.signalDate));
const purgedCells = KNOB_GRID.map(({ name, overrides }) => ({
  name,
  ...aggregate(applyKnobs(purged, overrides))
}));

const foldCells = {};
const purgedFoldCells = {};
for (const fold of FOLDS) {
  const foldRows = rows.filter(r => r.signalDate >= fold.first && r.signalDate <= fold.last);
  foldCells[fold.name] = KNOB_GRID.map(({ name, overrides }) => ({
    name,
    ...aggregate(applyKnobs(foldRows, overrides))
  }));
  const foldPurged = purged.filter(r => r.signalDate >= fold.first && r.signalDate <= fold.last);
  purgedFoldCells[fold.name] = KNOB_GRID.map(({ name, overrides }) => ({
    name,
    ...aggregate(applyKnobs(foldPurged, overrides))
  }));
}

const out = {
  schemaVersion: 1,
  window: `${TRAIN2_FIRST}..${TRAIN2_LAST}`,
  dates: train2Dates.length,
  subsetAnchor: { window: `${SUBSET_FIRST}..${SUBSET_LAST}`, ...frozenOnSubset },
  purgedRule: 'signal dates separated by >=12 trading days (T+11 non-overlap)',
  cells,
  purgedCells,
  foldCells,
  purgedFoldCells
};
fs.writeFileSync(OUT, JSON.stringify(out, null, 2), { encoding: 'utf8', flag: 'w' });

const fmt = c =>
  `  ${c.name.padEnd(18)} wo=${String(c.withOutcome).padStart(5)} strong=${String(c.strong).padStart(5)} ` +
  `hit=${c.hitRate === null ? 'null' : `${(c.hitRate * 100).toFixed(2)}%`}`;

console.log(`train-2: ${train2Dates.length} dates`);
console.log(`subset anchor OK: ${frozenOnSubset.candidates}/${frozenOnSubset.withOutcome}/${frozenOnSubset.strong}`);
console.log('\nfull window cells:');
for (const c of cells) console.log(fmt(c));
console.log('\npurged cells:');
for (const c of purgedCells) console.log(fmt(c));
for (const [foldName, foldCellsList] of Object.entries(purgedFoldCells)) {
  console.log(`\npurged ${foldName}:`);
  for (const c of foldCellsList) console.log(fmt(c));
}
