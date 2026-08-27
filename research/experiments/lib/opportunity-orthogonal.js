/**
 * Opportunity Model Orthogonal Matrix (O0-O7)
 *
 * Single-variable isolation testing:
 * - O0: Baseline
 * - O1: ER20 only (no HV upper bound)
 * - O2: HV upper bound only (no ER)
 * - O3: ER + HV upper bound (previous O2)
 * - O4-O6: ER threshold sensitivity (0.20, 0.25, 0.30)
 * - O7: ADX only (corrected Wilder smoothing)
 */

import { createRequire } from 'node:module';
import { calculateER, calculateADX, isHVRatioHealthy } from './opportunity-features.js';

const require = createRequire(import.meta.url);
const lib = require('../../backtest/shared-backtest-lib.cjs');

/**
 * O0: Baseline - Current production model
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
 * O1: Baseline + ER20 >= threshold (no HV upper bound)
 */
export function selectOpportunitiesO1(signalDate, raw, erThreshold = 0.25, topN = 10) {
  const candidates = lib.runScanner(raw, signalDate);
  const filtered = lib.runHardFilter(candidates, raw, signalDate);

  const eligible = [];

  for (const candidate of filtered) {
    const { symbol, hv5, hv20, atr14, price } = candidate;

    const hvRatio = hv20 > 0 ? hv5 / hv20 : null;
    const atrPct = (atr14 / price) * 100;

    if (hvRatio === null || hvRatio < 1.0) continue;
    if (atrPct < 2.0) continue;

    // Check ER20
    const contract = raw.contracts[symbol];
    if (!contract?.ohlcv) continue;

    const { dates, close } = contract.ohlcv;
    const signalIdx = dates.indexOf(signalDate);
    if (signalIdx < 0 || signalIdx < 25) continue;

    const truncClose = close.slice(0, signalIdx + 1);
    const er = calculateER(truncClose, 20);

    if (er === null || er < erThreshold) continue;

    eligible.push({ symbol, atrPct, hv5, hv20, price, er });
  }

  eligible.sort((a, b) => b.atrPct - a.atrPct);
  return topN ? eligible.slice(0, topN) : eligible;
}

/**
 * O2: Baseline + HV upper bound (no ER)
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

    eligible.push({ symbol, atrPct, hv5, hv20, price });
  }

  eligible.sort((a, b) => b.atrPct - a.atrPct);
  return eligible.slice(0, 10);
}

/**
 * O3: Baseline + ER20 + HV upper bound (previous O2)
 */
export function selectOpportunitiesO3(signalDate, raw, erThreshold = 0.25) {
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

    const { dates, close } = contract.ohlcv;
    const signalIdx = dates.indexOf(signalDate);
    if (signalIdx < 0 || signalIdx < 25) continue;

    const truncClose = close.slice(0, signalIdx + 1);
    const er = calculateER(truncClose, 20);

    if (er === null || er < erThreshold) continue;

    eligible.push({ symbol, atrPct, hv5, hv20, price, er });
  }

  eligible.sort((a, b) => b.atrPct - a.atrPct);
  return eligible.slice(0, 10);
}

/**
 * O7: Baseline + ADX >= 25 (Wilder smoothing corrected)
 */
export function selectOpportunitiesO7(signalDate, raw) {
  const candidates = lib.runScanner(raw, signalDate);
  const filtered = lib.runHardFilter(candidates, raw, signalDate);

  const eligible = [];

  for (const candidate of filtered) {
    const { symbol, hv5, hv20, atr14, price } = candidate;

    const hvRatio = hv20 > 0 ? hv5 / hv20 : null;
    const atrPct = (atr14 / price) * 100;

    if (hvRatio === null || hvRatio < 1.0) continue;
    if (atrPct < 2.0) continue;

    const contract = raw.contracts[symbol];
    if (!contract?.ohlcv) continue;

    const { dates, close, high, low } = contract.ohlcv;
    const signalIdx = dates.indexOf(signalDate);
    if (signalIdx < 0 || signalIdx < 25) continue;

    const truncClose = close.slice(0, signalIdx + 1);
    const truncHigh = high?.slice(0, signalIdx + 1);
    const truncLow = low?.slice(0, signalIdx + 1);

    if (!truncHigh || !truncLow) continue;
    const adx = calculateADX(truncHigh, truncLow, truncClose, 14);
    if (adx === null || adx < 25) continue;

    eligible.push({ symbol, atrPct, hv5, hv20, price, adx });
  }

  eligible.sort((a, b) => b.atrPct - a.atrPct);
  return eligible.slice(0, 10);
}

/**
 * TopN variants with baseline filters
 */
export function selectOpportunitiesTopN(signalDate, raw) {
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
