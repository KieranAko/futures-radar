/**
 * opportunity-knob-scan — 机会层单旋钮网格扫描（train 池）
 *
 * 冻结机会层 = 基线过滤(hvRatio≥1.0, atrPct≥2.0) + ER≥0.20 + atrPct 排序 + topN=null。
 * 每个日期只跑一次 scanner/hard-filter，逐候选计算特征与 T+1→T+11 结果，
 * 各旋钮配置在内存中过滤同一张特征表，保证互相可比。
 */
import { createRequire } from 'node:module';
import { calculateER, calculateADX } from './opportunity-features.js';
import { buildReplayRaw } from './historical-holdout.js';

const require = createRequire(import.meta.url);
const lib = require('../../backtest/shared-backtest-lib.cjs');

export const FROZEN = Object.freeze({
  erThreshold: 0.2,
  topN: null,
  hvMin: 1.0,
  hvMax: null,
  adxFloor: 0,
  atrFloor: 2.0
});

export const KNOB_GRID = [
  { name: 'frozen', overrides: {} },
  { name: 'er0', overrides: { erThreshold: 0 } },
  { name: 'scanner-raw', overrides: { erThreshold: 0, hvMin: null, atrFloor: 0 } },
  { name: 'top7', overrides: { topN: 7 } },
  { name: 'top5', overrides: { topN: 5 } },
  { name: 'top3', overrides: { topN: 3 } },
  { name: 'hvMax1.5', overrides: { hvMax: 1.5 } },
  { name: 'hvMax1.2', overrides: { hvMax: 1.2 } },
  { name: 'hvMin1.2', overrides: { hvMin: 1.2 } },
  { name: 'hvMin1.5', overrides: { hvMin: 1.5 } },
  { name: 'adx20', overrides: { adxFloor: 20 } },
  { name: 'adx25', overrides: { adxFloor: 25 } },
  { name: 'adx30', overrides: { adxFloor: 30 } },
  { name: 'atr2.5', overrides: { atrFloor: 2.5 } },
  { name: 'atr3.0', overrides: { atrFloor: 3.0 } },
  { name: 'combo-hv12-atr25', overrides: { hvMax: 1.2, atrFloor: 2.5 } }
];

/**
 * 单日期特征表：scanner → hard-filter → 逐候选特征与结果
 * er/adx 沿用生产实现的门槛（signalIdx≥25 才计算，与 selectOpportunitiesO1 一致）
 */
export function scanDateRows(signalDate, raw) {
  const candidates = lib.runScanner(raw, signalDate);
  const filtered = lib.runHardFilter(candidates, raw, signalDate);
  const rows = [];

  for (const cand of filtered) {
    const { symbol, hv5, hv20, atr14, price } = cand;
    const hvRatio = hv20 > 0 ? hv5 / hv20 : null;
    const atrPct = (atr14 / price) * 100;

    const contract = raw.contracts[symbol];
    if (!contract?.ohlcv) continue;

    const { dates, close, high, low } = contract.ohlcv;
    const signalIdx = dates.indexOf(signalDate);
    if (signalIdx < 0) continue;

    let er = null;
    let adx = null;
    if (signalIdx >= 25) {
      er = calculateER(close.slice(0, signalIdx + 1), 20);
      adx = calculateADX(
        high.slice(0, signalIdx + 1),
        low.slice(0, signalIdx + 1),
        close.slice(0, signalIdx + 1),
        14
      );
    }

    const entry = lib.simulateEntry(symbol, raw, signalDate);
    const exit = entry ? lib.simulateExit(symbol, raw, entry.entryIdx, 10) : null;
    const absMove = entry && exit
      ? Math.abs((exit.exitPrice - entry.entryPrice) / entry.entryPrice)
      : null;

    rows.push({ symbol, signalDate, hvRatio, atrPct, er, adx, absMove });
  }
  return rows;
}

export function applyKnobs(rows, config = {}) {
  const cfg = { ...FROZEN, ...config };

  const selected = rows.filter(r => {
    if (cfg.hvMin !== null && (r.hvRatio === null || r.hvRatio < cfg.hvMin)) return false;
    if (cfg.hvMax !== null && (r.hvRatio === null || r.hvRatio > cfg.hvMax)) return false;
    if (r.atrPct < cfg.atrFloor) return false;
    if (cfg.erThreshold > 0 && (r.er === null || r.er < cfg.erThreshold)) return false;
    if (cfg.adxFloor > 0 && (r.adx === null || r.adx < cfg.adxFloor)) return false;
    return true;
  });

  if (!cfg.topN) return selected;

  // topN 与生产实现一致：按日期分组，组内 atrPct 降序后截断
  const byDate = new Map();
  for (const r of selected) {
    const list = byDate.get(r.signalDate) ?? byDate.set(r.signalDate, []).get(r.signalDate);
    list.push(r);
  }
  const out = [];
  for (const list of byDate.values()) {
    list.sort((a, b) => b.atrPct - a.atrPct);
    out.push(...list.slice(0, cfg.topN));
  }
  return out;
}

export function aggregate(rows, minMoveThreshold = 0.03) {
  const withOutcome = rows.filter(r => r.absMove !== null);
  const strong = withOutcome.filter(r => r.absMove >= minMoveThreshold);

  const byBucket = (width) => {
    const buckets = {};
    for (const r of withOutcome) {
      const key = r.signalDate.slice(0, width);
      const bucket = buckets[key] ?? (buckets[key] = { withOutcome: 0, strong: 0 });
      bucket.withOutcome++;
      if (r.absMove >= minMoveThreshold) bucket.strong++;
    }
    return buckets;
  };

  return {
    candidates: rows.length,
    withOutcome: withOutcome.length,
    strong: strong.length,
    hitRate: withOutcome.length > 0 ? strong.length / withOutcome.length : null,
    byYear: byBucket(4),
    byMonth: byBucket(7)
  };
}

export function buildTrainRows(cache, options = {}) {
  const trainFirst = options.trainFirst ?? '2024-01-02';
  const trainLast = options.trainLast ?? '2026-06-16';

  const raw = buildReplayRaw(cache);
  const firstSymbol = Object.keys(cache.contracts)[0];
  const allDates = cache.contracts[firstSymbol].ohlcv.dates;
  const trainDates = allDates.filter(d => d >= trainFirst && d <= trainLast);

  const rows = [];
  for (const d of trainDates) rows.push(...scanDateRows(d, raw));
  return { rows, trainDates };
}

export function scan(cache, options = {}) {
  const trainFirst = options.trainFirst ?? '2024-01-02';
  const trainLast = options.trainLast ?? '2026-06-16';
  const grid = options.grid ?? KNOB_GRID;

  const { rows, trainDates } = buildTrainRows(cache, { trainFirst, trainLast });

  const cells = grid.map(({ name, overrides }) => ({
    name,
    config: { ...FROZEN, ...overrides },
    ...aggregate(applyKnobs(rows, overrides))
  }));

  return { trainFirst, trainLast, trainDates: trainDates.length, cells };
}
