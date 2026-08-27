/**
 * E1 Scanner Replay Adapter
 *
 * Purpose: Test 4 scanner variants vs ATR14% baseline
 *
 * Baseline: ATR14% Top10 (current production scanner)
 * Challengers:
 *   1. HV20 percentile (historical volatility over 20 days)
 *   2. ER20 (Efficiency Ratio - trend strength)
 *   3. ATR5 percentile (faster ATR response)
 *   4. VEC composite (volatility-efficiency-ATR hybrid)
 *
 * All variants use:
 * - Same eligibility gates: HV=1, ATR=2%, EMA slope=0.3%/day
 * - Same direction policy: EMA20 slope sign
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
 * Calculate HV20 percentile for a contract
 * @param {Array<number>} close - Close prices (≥110 needed)
 * @returns {number|null} HV20 value at signal date
 */
function calculateHV20(close) {
  if (close.length < 110) return null;

  const returns = [];
  for (let i = 1; i < close.length; i++) {
    returns.push(Math.log(close[i] / close[i - 1]));
  }

  // 90 rolling 20-day windows
  const hvValues = [];
  for (let i = 0; i <= returns.length - 20; i++) {
    const window = returns.slice(i, i + 20);
    const mean = window.reduce((sum, r) => sum + r, 0) / 20;
    const variance = window.reduce((sum, r) => sum + (r - mean) ** 2, 0) / 20;
    hvValues.push(Math.sqrt(variance) * Math.sqrt(252));
  }

  return hvValues[hvValues.length - 1]; // Current HV20
}

/**
 * Calculate ER20 (Efficiency Ratio) for a contract
 * @param {Array<number>} close - Close prices (≥21 needed)
 * @returns {number|null} ER20 value (0-1, higher = stronger trend)
 */
function calculateER20(close) {
  if (close.length < 21) return null;

  const recent = close.slice(-21);
  const netChange = Math.abs(recent[recent.length - 1] - recent[0]);
  let sumAbsChanges = 0;
  for (let i = 1; i < recent.length; i++) {
    sumAbsChanges += Math.abs(recent[i] - recent[i - 1]);
  }

  return sumAbsChanges > 0 ? netChange / sumAbsChanges : 0;
}

/**
 * Calculate ATR5 percentile for a contract
 * @param {Object} ohlcv - {high, low, close} arrays (≥95 needed)
 * @returns {number|null} ATR5 value at signal date
 */
function calculateATR5(ohlcv) {
  const { high, low, close } = ohlcv;
  if (!high || !low || !close || close.length < 95) return null;

  const trueRanges = [];
  for (let i = 1; i < close.length; i++) {
    const tr = Math.max(
      high[i] - low[i],
      Math.abs(high[i] - close[i - 1]),
      Math.abs(low[i] - close[i - 1])
    );
    trueRanges.push(tr);
  }

  // 90 rolling 5-bar ATR windows
  const atrValues = [];
  for (let i = 0; i <= trueRanges.length - 5; i++) {
    const window = trueRanges.slice(i, i + 5);
    const atr = window.reduce((sum, tr) => sum + tr, 0) / 5;
    atrValues.push(atr);
  }

  return atrValues[atrValues.length - 1]; // Current ATR5
}

/**
 * Calculate VEC composite score (volatility-efficiency-ATR hybrid)
 * @param {number} hv20 - HV20 value
 * @param {number} er20 - ER20 value
 * @param {number} atr14Pct - ATR14% value
 * @returns {number} VEC composite score (0-1)
 */
function calculateVEC(hv20, er20, atr14Pct) {
  // Normalize each component to 0-1 range (using typical bounds)
  const hvNorm = Math.min(hv20 / 1.0, 1.0); // HV20 typically 0-1.0
  const erNorm = er20; // ER20 already 0-1
  const atrNorm = Math.min(atr14Pct / 10.0, 1.0); // ATR% typically 0-10%

  // Equal-weighted composite
  return (hvNorm + erNorm + atrNorm) / 3;
}

/**
 * Replay E1 scanner variant on a single signal date
 * @param {string} signalDate - Signal date
 * @param {Object} raw - Raw OHLCV data
 * @param {Object} config - {scannerType, topN, hvThreshold, atrThreshold, emaSlopeThreshold}
 * @returns {Array<{symbol, direction, entryPrice, exitPrice, netReturn, signalDate}>}
 */
export function replayE1ScannerDate(signalDate, raw, config) {
  const {
    scannerType,  // 'ATR14', 'HV20', 'ER20', 'ATR5', 'VEC'
    topN = 10,
    hvThreshold = 1,
    atrThreshold = 2,
    emaSlopeThreshold = 0.3,
    holdPeriod = 10
  } = config;

  const candidates = lib.runScanner(raw, signalDate);
  const filtered = lib.runHardFilter(candidates, raw, signalDate);

  // Calculate scanner-specific scores for each candidate
  const scored = [];

  for (const candidate of filtered) {
    const { symbol, hv5, hv20, atr14, price } = candidate;

    // Eligibility gates (same for all scanners)
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

    // Calculate scanner-specific score
    let score;
    switch (scannerType) {
      case 'ATR14':
        score = atrPct; // Baseline: rank by ATR14%
        break;
      case 'HV20':
        score = calculateHV20(truncClose);
        break;
      case 'ER20':
        score = calculateER20(truncClose);
        break;
      case 'ATR5': {
        const atr5 = calculateATR5({
          high: contract.ohlcv.high?.slice(0, signalIdx + 1),
          low: contract.ohlcv.low?.slice(0, signalIdx + 1),
          close: truncClose
        });
        score = atr5 ? (atr5 / price) * 100 : null;
        break;
      }
      case 'VEC': {
        const hv20Val = calculateHV20(truncClose);
        const er20Val = calculateER20(truncClose);
        score = hv20Val !== null && er20Val !== null
          ? calculateVEC(hv20Val, er20Val, atrPct)
          : null;
        break;
      }
      default:
        throw new Error(`Unknown scanner type: ${scannerType}`);
    }

    if (score === null) continue;

    scored.push({
      symbol,
      score,
      emaSlope,
      price,
      atr14,
    });
  }

  // Rank by score and take topN
  scored.sort((a, b) => b.score - a.score);
  const selected = scored.slice(0, topN);

  // Execute trades for selected contracts
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
