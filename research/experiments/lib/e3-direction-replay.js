/**
 * E3 Direction Replay Adapter
 *
 * Purpose: Test 2 direction policies + 3 random controls vs EMA slope baseline
 *
 * Baseline: EMA20 slope sign (current production)
 * Challengers:
 *   1. MA20/MA60 crossover (bullish if MA20 > MA60, bearish otherwise)
 *   2. Donchian breakout direction (bullish if price broke upper band, bearish if lower)
 *   3-5. Random direction (3 independent random seeds for null distribution)
 *
 * Fixed cohort constraint:
 * - All variants trade the SAME contracts on SAME dates (selected by baseline scanner)
 * - Only direction varies
 * - Zero-signal dates from baseline are preserved as return=0 for all variants
 *
 * All variants use:
 * - Same scanner: ATR14% Top10
 * - Same eligibility gates: HV≥1, ATR≥2%
 * - Same hold period: H10 (10 days)
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
 * Calculate MA (Simple Moving Average)
 */
function calculateMA(close, period) {
  if (close.length < period) return null;
  const sum = close.slice(-period).reduce((acc, val) => acc + val, 0);
  return sum / period;
}

/**
 * Calculate Donchian breakout direction
 * @param {Array<number>} high - High prices
 * @param {Array<number>} low - Low prices
 * @param {number} currentPrice - Current close price
 * @param {number} period - Donchian period (20)
 * @returns {string|null} 'bullish' if broke upper, 'bearish' if broke lower, null if neither
 */
function calculateDonchianDirection(high, low, currentPrice, period = 20) {
  if (high.length < period + 1 || low.length < period + 1) return null;

  // Donchian: prior 20-bar channel excluding current bar
  const priorHigh = high.slice(-(period + 1), -1);
  const priorLow = low.slice(-(period + 1), -1);

  const upperBand = Math.max(...priorHigh);
  const lowerBand = Math.min(...priorLow);

  // Check breakout
  if (currentPrice >= upperBand) return 'bullish';
  if (currentPrice <= lowerBand) return 'bearish';

  return null; // No clear breakout
}

/**
 * Seeded RNG for reproducible random direction
 * @param {number} seed - Random seed
 * @returns {function(): number} RNG function returning 0-1
 */
function createSeededRNG(seed) {
  let state = seed;
  return function() {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

/**
 * Get baseline cohort (contracts selected by baseline EMA slope policy)
 * @param {string} signalDate - Signal date
 * @param {Object} raw - Raw OHLCV data
 * @param {Object} config - {hvThreshold, atrThreshold, emaSlopeThreshold, topN}
 * @returns {Array<{symbol, baselineDirection}>}
 */
function getBaselineCohort(signalDate, raw, config) {
  const {
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

  return selected.map(c => ({
    symbol: c.symbol,
    baselineDirection: c.emaSlope > 0 ? 'bullish' : 'bearish'
  }));
}

/**
 * Replay E3 direction variant on a single signal date (fixed cohort)
 * @param {string} signalDate - Signal date
 * @param {Object} raw - Raw OHLCV data
 * @param {Object} config - {directionPolicy, randomSeed?, hvThreshold, atrThreshold, emaSlopeThreshold, topN, holdPeriod}
 * @returns {Array<{symbol, direction, entryPrice, exitPrice, netReturn, signalDate}>}
 */
export function replayE3DirectionDate(signalDate, raw, config) {
  const {
    directionPolicy,  // 'ema-slope', 'ma-crossover', 'donchian', 'random'
    randomSeed,       // Required for 'random' policy
    hvThreshold = 1,
    atrThreshold = 2,
    emaSlopeThreshold = 0.3,
    topN = 10,
    holdPeriod = 10
  } = config;

  // Step 1: Get baseline cohort (same contracts for all variants)
  const cohort = getBaselineCohort(signalDate, raw, { hvThreshold, atrThreshold, emaSlopeThreshold, topN });

  // Step 2: Determine direction for each contract using specified policy
  const rng = directionPolicy === 'random' && randomSeed !== undefined
    ? createSeededRNG(randomSeed)
    : null;

  const trades = [];

  for (const { symbol } of cohort) {
    const contract = raw.contracts[symbol];
    if (!contract?.ohlcv) continue;

    const { dates, close, high, low } = contract.ohlcv;
    const signalIdx = dates.indexOf(signalDate);
    if (signalIdx < 0) continue;

    const truncClose = close.slice(0, signalIdx + 1);
    const truncHigh = high?.slice(0, signalIdx + 1);
    const truncLow = low?.slice(0, signalIdx + 1);

    let direction;

    switch (directionPolicy) {
      case 'ema-slope': {
        const emaSlope = calculateEMASlope(truncClose, 20, 5);
        direction = emaSlope && emaSlope > 0 ? 'bullish' : 'bearish';
        break;
      }
      case 'ma-crossover': {
        const ma20 = calculateMA(truncClose, 20);
        const ma60 = calculateMA(truncClose, 60);
        direction = (ma20 && ma60 && ma20 > ma60) ? 'bullish' : 'bearish';
        break;
      }
      case 'donchian': {
        const currentPrice = truncClose[truncClose.length - 1];
        const donchianDir = truncHigh && truncLow
          ? calculateDonchianDirection(truncHigh, truncLow, currentPrice, 20)
          : null;
        direction = donchianDir || 'bearish'; // Default to bearish if no breakout
        break;
      }
      case 'random': {
        if (!rng) throw new Error('randomSeed required for random direction policy');
        direction = rng() > 0.5 ? 'bullish' : 'bearish';
        break;
      }
      default:
        throw new Error(`Unknown direction policy: ${directionPolicy}`);
    }

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
