#!/usr/bin/env node
/**
 * valid-2 一次性评分器（pre-dev 扩展留出，4579 日期，2005-01-04..2023-10-27）
 *
 * Usage:
 *   node experiments/valid2-score-cli.js opp            → 机会层（45日锚点 + 全窗口 cells + T+11 purge 视图）
 *   node experiments/valid2-score-cli.js dir <configKey> → 方向层 D0-D4（main/control/optimized 之一）
 *
 * 与严格 45 日留出不同：本窗口采用逐合约门槛（manifest 已声明）。
 * 日历校验使用 CU0（最长历史）；time-sampler 的 first-symbol 日历从 2014 起，不覆盖本窗口。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { loadHoldoutManifest, assertDevelopmentBoundary, buildReplayRaw } from './lib/historical-holdout.js';
import { runDirectionMatrixDate, evaluateDirectionMatrix } from './lib/direction-matrix-runner.js';
import { scanDateRows, applyKnobs, aggregate, FROZEN } from './lib/opportunity-knob-scan.js';

const require = createRequire(import.meta.url);
const { loadCache } = require('../../backtest/cache-slicer.cjs');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../../..');
const MANIFEST_PATH = path.join(root, 'data/futures-radar/holdout/manifest-valid2.json');
const OPP_OUT = path.join(root, 'data/futures-radar/holdout/result-valid2-opp.json');
const DIR_OUT = key => path.join(root, `data/futures-radar/holdout/result-valid2-dir-${key}.json`);

const cache = loadCache();
const raw = buildReplayRaw(cache);
const manifest = loadHoldoutManifest(MANIFEST_PATH);
assertDevelopmentBoundary(manifest);

const cuDates = cache.contracts['CU0'].ohlcv.dates;
const calendarSet = new Set(cuDates);
for (const d of manifest.signalDates) {
  if (!calendarSet.has(d)) throw new Error(`manifest signal date ${d} is not a CU0-calendar trading day`);
}

// T+11 不重叠：保留的信号日之间至少间隔 12 个交易日（日期级 purge：保留日上的全部候选一起保留）
function purgeByDateGap(rows, minGapDays) {
  const idx = new Map(cuDates.map((d, i) => [d, i]));
  const bearing = [...new Set(rows.map(r => r.signalDate))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const kept = new Set();
  let lastIdx = -Infinity;
  for (const d of bearing) {
    const i = idx.get(d);
    if (i === undefined) continue;
    if (i >= lastIdx + minGapDays) {
      kept.add(d);
      lastIdx = i;
    }
  }
  return rows.filter(r => kept.has(r.signalDate));
}

const mode = process.argv[2];

if (mode === 'opp') {
  // 1) 锚点：已披露的 45 日窗口必须复现官方口径（result-expanded.json main = 111/107/70）
  const anchorDates = cuDates.filter(d => d >= '2023-10-30' && d <= '2023-12-29');
  const anchorRows = [];
  for (const d of anchorDates) anchorRows.push(...scanDateRows(d, raw));
  const anchor = aggregate(applyKnobs(anchorRows, {}));
  if (anchor.candidates !== 111 || anchor.withOutcome !== 107 || anchor.strong !== 70) {
    throw new Error(
      `45-day anchor mismatch: ${anchor.candidates}/${anchor.withOutcome}/${anchor.strong}, expected 111/107/70`
    );
  }
  console.log(`45-day anchor OK: ${anchor.candidates}/${anchor.withOutcome}/${anchor.strong}`);

  // 2) valid-2 全窗口机会层 cells
  const rows = [];
  for (const d of manifest.signalDates) rows.push(...scanDateRows(d, raw));

  const configs = { ...manifest.configs, ...manifest.knobPreRegistered };
  const frozenAgg = aggregate(applyKnobs(rows, {}));
  const cells = [];
  for (const [name, cfg] of Object.entries(configs)) {
    cells.push({ name, config: { ...FROZEN, ...cfg }, ...aggregate(applyKnobs(rows, cfg)) });
  }

  // 3) T+11 purge 视图
  const purged = purgeByDateGap(rows, 12);
  const purgedCells = [];
  for (const [name, cfg] of Object.entries(configs)) {
    purgedCells.push({ name, ...aggregate(applyKnobs(purged, cfg)) });
  }

  const out = {
    schemaVersion: 1,
    manifest: 'manifest-valid2.json',
    anchor: { window: '2023-10-30..2023-12-29 (disclosed 45)', ...anchor },
    purgedRule: 'kept signal dates separated by >=12 trading days (T+11 non-overlap)',
    cells,
    purgedCells
  };
  fs.writeFileSync(OPP_OUT, JSON.stringify(out, null, 2), { encoding: 'utf8', flag: 'w' });

  console.log(`\nvalid-2 opportunity cells (${manifest.signalDates.length} dates):`);
  for (const c of cells) {
    const hit = c.hitRate === null ? 'null' : `${(c.hitRate * 100).toFixed(2)}%`;
    const cov = frozenAgg.candidates > 0 ? `${((c.candidates / frozenAgg.candidates) * 100).toFixed(1)}%` : 'n/a';
    console.log(
      `${c.name.padEnd(18)} cand=${String(c.candidates).padStart(6)} wo=${String(c.withOutcome).padStart(6)} ` +
      `strong=${String(c.strong).padStart(6)} hit=${hit} cov=${cov}`
    );
  }
  console.log('\npurged view:');
  for (const c of purgedCells) {
    const hit = c.hitRate === null ? 'null' : `${(c.hitRate * 100).toFixed(2)}%`;
    console.log(
      `  ${c.name.padEnd(18)} cand=${String(c.candidates).padStart(5)} wo=${String(c.withOutcome).padStart(5)} ` +
      `strong=${String(c.strong).padStart(5)} hit=${hit}`
    );
  }
  console.log('\nfrozen byYear:', JSON.stringify(frozenAgg.byYear, null, 0));
} else if (mode === 'dir') {
  const key = process.argv[3];
  const config = manifest.configs[key];
  if (!config) throw new Error(`unknown config key: ${key}`);

  const dateResults = [];
  for (const d of manifest.signalDates) dateResults.push(runDirectionMatrixDate(d, raw, config));
  const ev = evaluateDirectionMatrix(dateResults);

  const summary = {
    schemaVersion: 1,
    manifest: 'manifest-valid2.json',
    configKey: key,
    config,
    dates: manifest.signalDates.length,
    totalCandidates: ev.totalCandidates,
    totalWithOutcome: ev.totalWithOutcome,
    strongOpportunities: ev.strongOpportunities,
    opportunityHitRate: ev.totalWithOutcome > 0 ? ev.strongOpportunities / ev.totalWithOutcome : null,
    perLayer: ev.perLayer
  };
  fs.writeFileSync(DIR_OUT(key), JSON.stringify(summary, null, 2), { encoding: 'utf8', flag: 'w' });

  console.log(
    `\ndirection ${key}: cand=${ev.totalCandidates} wo=${ev.totalWithOutcome} strong=${ev.strongOpportunities} ` +
    `oppHit=${summary.opportunityHitRate === null ? 'null' : (summary.opportunityHitRate * 100).toFixed(2) + '%'}`
  );
  for (const [layer, L] of Object.entries(ev.perLayer)) {
    const dirHit = L.directionHitRate === null ? 'null' : `${(L.directionHitRate * 100).toFixed(2)}%`;
    const strongHit = L.strongHitRate === null ? 'null' : `${(L.strongHitRate * 100).toFixed(2)}%`;
    const net = L.avgNetReturn === null ? 'null' : `${(L.avgNetReturn * 100).toFixed(2)}%`;
    console.log(
      `  ${layer}: dirWO=${L.directionalWithOutcome} dirHit=${dirHit} strongHit=${strongHit} ` +
      `net=${net} trades=${L.trades} long=${L.longTotal} short=${L.shortTotal}`
    );
  }
} else {
  throw new Error('usage: valid2-score-cli.js opp | dir <configKey>');
}
