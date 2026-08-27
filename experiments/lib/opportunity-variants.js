/**
 * Opportunity Model Variants (O0-O4)
 *
 * Progressive single-variable testing for opportunity selection.
 * Each variant adds ONE independent dimension.
 */

import { createRequire } from 'node:module';
import { calculateER, calculateADX, isHVRatioHealthy } from './opportunity-features.js';

const require = createRequire(import.meta.url);
const lib = require('../../backtest/shared-backtest-lib.cjs');

/**
 * O0: Baseline - Current production model
 * - HV5/HV20 >= 1.0
 * - ATR14% >= 2.0%
 * - Top 10 by ATR14%
 */
export function selectOpportunitiesO0(signalDate, raw) {
  const candidates = lib.runScanner(raw, signalDate);
  const filtered = lib.runHardFilter(candidates, raw, signalDate);

  const eligible = [];

  for (const candidate of filtered) {
    const { symbol, hv5, hv20, atr14, price } = candidate;

    const hvRatio = hv20 > 0 ? hv5 / hv20 : null;
    const atrPct = (atr14 / price) * 100;

    if (hvRatio === null || hvRatio < 1.0) continue;
    if (atrPct < 2.0) continue;

    eligible.push({ symbol, atrPct, hv5, hv20, price });
  }

  eligible.sort((a, b) => b.atrPct - a.atrPct);
  return eligible.slice(0, 10);
}

/**
 * O1: Add HV ratio upper bound
 * - HV5/HV20 in [1.0, 1.5] (exclude overheated volatility)
 * - ATR14% >= 2.0%
 * - Top 10 by ATR14%
 */
export function selectOpportunitiesO1(signalDate, raw) {
  const candidates = lib.runScanner(raw, signalDate);
  const filtered = lib.runHardFilter(candidates, raw, signalDate);

  const eligible = [];

  for (const candidate of filtered) {
    const { symbol, hv5, hv20, atr14, price } = candidate;

    const atrPct = (atr14 / price) * 100;

    if (!isHVRatioHealthy(hv5, hv20, 1.0, 1.5)) continue;
    if (atrPct < 2.0) continue;

    eligible.push({ symbol, atrPct, hv5, hv20, price });
  }

  eligible.sort((a, b) => b.atrPct - a.atrPct);
  return eligible.slice(0, 10);
}

/**
 * O2: O1 + Efficiency Ratio minimum
 * - HV5/HV20 in [1.0, 1.5]
 * - ATR14% >= 2.0%
 * - ER20 >= 0.25 (exclude choppy range)
 * - Top 10 by ATR14%
 */
export function selectOpportunitiesO2(signalDate, raw) {
  const candidates = lib.runScanner(raw, signalDate);
  const filtered = lib.runHardFilter(candidates, raw, signalDate);

  const eligible = [];

  for (const candidate of filtered) {
    const { symbol, hv5, hv20, atr14, price } = candidate;

    const atrPct = (atr14 / price) * 100;

    if (!isHVRatioHealthy(hv5, hv20, 1.0, 1.5)) continue;
    if (atrPct < 2.0) continue;

    // Check ER20
    const contract = raw.contracts[symbol];
    if (!contract?.ohlcv) continue;

    const { dates, close } = contract.ohlcv;
    const signalIdx = dates.indexOf(signalDate);
    if (signalIdx < 0 || signalIdx < 25) continue;

    const truncClose = close.slice(0, signalIdx + 1);
    const er = calculateER(truncClose, 20);

    if (er === null || er < 0.25) continue;

    eligible.push({ symbol, atrPct, hv5, hv20, price, er });
  }

  eligible.sort((a, b) => b.atrPct - a.atrPct);
  return eligible.slice(0, 10);
}

/**
 * O3: O2 + ADX trend strength
 * - HV5/HV20 in [1.0, 1.5]
 * - ATR14% >= 2.0%
 * - ER20 >= 0.25
 * - ADX14 >= 25 (strong trend)
 * - Top 10 by ATR14%
 */
export function selectOpportunitiesO3(signalDate, raw) {
  const candidates = lib.runScanner(raw, signalDate);
  const filtered = lib.runHardFilter(candidates, raw, signalDate);

  const eligible = [];

  for (const candidate of filtered) {
    const { symbol, hv5, hv20, atr14, price } = candidate;

    const atrPct = (atr14 / price) * 100;

    if (!isHVRatioHealthy(hv5, hv20, 1.0, 1.5)) continue;
    if (atrPct < 2.0) continue;

    const contract = raw.contracts[symbol];
    if (!contract?.ohlcv) continue;

    const { dates, close, high, low } = contract.ohlcv;
    const signalIdx = dates.indexOf(signalDate);
    if (signalIdx < 0 || signalIdx < 25) continue;

    const truncClose = close.slice(0, signalIdx + 1);
    const truncHigh = high?.slice(0, signalIdx + 1);
    const truncLow = low?.slice(0, signalIdx + 1);

    const er = calculateER(truncClose, 20);
    if (er === null || er < 0.25) continue;

    if (!truncHigh || !truncLow) continue;
    const adx = calculateADX(truncHigh, truncLow, truncClose, 14);
    if (adx === null || adx < 25) continue;

    eligible.push({ symbol, atrPct, hv5, hv20, price, er, adx });
  }

  eligible.sort((a, b) => b.atrPct - a.atrPct);
  return eligible.slice(0, 10);
}

/**
 * O4: Test different topN values with O0 baseline
 * Returns arrays for Top3, Top5, Top7, Top10
 */
export function selectOpportunitiesO4(signalDate, raw) {
  const candidates = lib.runScanner(raw, signalDate);
  const filtered = lib.runHardFilter(candidates, raw, signalDate);

  const eligible = [];

  for (const candidate of filtered) {
    const { symbol, hv5, hv20, atr14, price } = candidate;

    const hvRatio = hv20 > 0 ? hv5 / hv20 : null;
    const atrPct = (atr14 / price) * 100;

    if (hvRatio === null || hvRatio < 1.0) continue;
    if (atrPct < 2.0) continue;

    eligible.push({ symbol, atrPct, hv5, hv20, price });
  }

  eligible.sort((a, b) => b.atrPct - a.atrPct);

  return {
    top3: eligible.slice(0, 3),
    top5: eligible.slice(0, 5),
    top7: eligible.slice(0, 7),
    top10: eligible.slice(0, 10),
  };
}
