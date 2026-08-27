/**
 * E4a Hold Period Replay Adapter
 *
 * Purpose: Test 3 hold period variants vs H10 baseline
 *
 * Baseline: H10 (10-day hold period, current production)
 * Challengers:
 *   1. H7 (7-day hold period, faster exit)
 *   2. H15 (15-day hold period, longer trend capture)
 *
 * All variants use:
 * - Same scanner: ATR14% Top10
 * - Same eligibility gates: HV≥1, ATR≥2%
 * - Same direction policy: EMA20 slope sign
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const lib = require('../../backtest/shared-backtest-lib.cjs');

/**
 * Calculate EMA slope (normalized to %/day)
 */
function calculateEMASlope(close, period = 20, slopeDays = 5) {
  if (close.length < period + slopeDays) return null;

  const emaValues = [];
  const k = 2 / (period + 1);

  for (let i = period - 1; i < close.length; i++) {
    const slice = close.slice(0, i + 1);
    let ema = slice[0];
    for (let j = 1; j < slice.length; j++) {
      ema = slice[j] * k + ema * (1 - k);
    }
    emaValues.push(ema);
  }

  const recentEMA = emaValues.slice(-slopeDays);
  const n = recentEMA.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;

  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += recentEMA[i];
    sumXY += i * recentEMA[i];
    sumX2 += i * i;
  }

  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  const avgPrice = recentEMA[n - 1];

  return (slope / avgPrice) * 100;
}

/**
 * Replay E4a hold period variant on a single signal date
 * @param {string} signalDate - Signal date
 * @param {Object} raw - Raw OHLCV data
 * @param {Object} config - {holdPeriod, hvThreshold, atrThreshold, emaSlopeThreshold, topN}
 * @returns {Array<{symbol, direction, entryPrice, exitPrice, netReturn, signalDate}>}
 */
export function replayE4aHoldPeriodDate(signalDate, raw, config) {
  const {
    holdPeriod,  // 7, 10, or 15
    hvThreshold = 1,
    atrThreshold = 2,
    emaSlopeThreshold = 0.3,
    topN = 10
  } = config;

  const candidates = lib.runScanner(raw, signalDate);
  const filtered = lib.runHardFilter(candidates, raw, signalDate);

  const eligible = [];

  for (const candidate of filtered) {
    const { symbol, hv5, hv20, atr14, price } = candidate;

    const hvRatio = hv20 > 0 ? hv5 / hv20 : null;
    const atrPct = (atr14 / price) * 100;

    if (hvRatio === null || hvRatio < hvThreshold) continue;
    if (atrPct < atrThreshold) continue;

    const contract = raw.contracts[symbol];
    if (!contract?.ohlcv) continue;

    const { dates, close } = contract.ohlcv;
    const signalIdx = dates.indexOf(signalDate);
    if (signalIdx < 0 || signalIdx < 25) continue;

    const truncClose = close.slice(0, signalIdx + 1);
    const emaSlope = calculateEMASlope(truncClose, 20, 5);

    if (emaSlope === null || Math.abs(emaSlope) < emaSlopeThreshold) continue;

    eligible.push({
      symbol,
      atrPct,
      emaSlope,
    });
  }

  // Rank by ATR14% and take topN
  eligible.sort((a, b) => b.atrPct - a.atrPct);
  const selected = eligible.slice(0, topN);

  // Execute trades with specified hold period
  const trades = [];

  for (const candidate of selected) {
    const { symbol, emaSlope } = candidate;
    const direction = emaSlope > 0 ? 'bullish' : 'bearish';

    const entryResult = lib.simulateEntry(symbol, raw, signalDate);
    if (!entryResult) continue;

    const exitResult = lib.simulateExit(symbol, raw, entryResult.entryIdx, holdPeriod);
    if (!exitResult) continue;

    const { entryPrice, entryDate } = entryResult;
    const { exitPrice, exitDate } = exitResult;

    const sign = direction === 'bullish' ? 1 : -1;
    const grossReturn = sign * (exitPrice - entryPrice) / entryPrice;

    const costs = lib.calculateCosts(entryPrice, exitPrice);
    const netReturn = grossReturn - costs;

    trades.push({
      symbol,
      direction,
      entryDate,
      exitDate,
      entryPrice,
      exitPrice,
      grossReturn,
      costs,
      netReturn,
      signalDate,
    });
  }

  return trades;
}
