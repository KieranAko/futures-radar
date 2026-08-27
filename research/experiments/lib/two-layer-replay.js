/**
 * Two-Layer Replay Adapter
 *
 * Separates Opportunity Model (Layer 1) and Direction Model (Layer 2):
 *
 * Layer 1: Opportunity Model
 *   - Input: All market contracts
 *   - Output: Candidates with sufficient expected volatility
 *   - Evaluation: % with ≥3% absolute move (direction-agnostic)
 *
 * Layer 2: Direction Model
 *   - Input: Opportunity candidates only
 *   - Output: long / short / uncertain
 *   - Evaluation: % with correct direction
 *
 * Key invariant: Direction policy parameters MUST NOT affect Layer 1 sample set
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
 * Layer 1: Select opportunity candidates (direction-agnostic)
 *
 * @param {string} signalDate - Signal date
 * @param {Object} raw - Raw OHLCV data
 * @param {Object} config - {hvThreshold, atrThreshold, topN}
 * @returns {Array<{symbol, atrPct, hv5, hv20, price}>}
 */
export function selectOpportunityCandidates(signalDate, raw, config) {
  const {
    hvThreshold = 1,
    atrThreshold = 2,
    topN = 10
  } = config;

  const candidates = lib.runScanner(raw, signalDate);
  const filtered = lib.runHardFilter(candidates, raw, signalDate);

  const eligible = [];

  for (const candidate of filtered) {
    const { symbol, hv5, hv20, atr14, price } = candidate;

    const hvRatio = hv20 > 0 ? hv5 / hv20 : null;
    const atrPct = (atr14 / price) * 100;

    // Opportunity gates: volatility only, NO direction filter
    if (hvRatio === null || hvRatio < hvThreshold) continue;
    if (atrPct < atrThreshold) continue;

    eligible.push({
      symbol,
      atrPct,
      hv5,
      hv20,
      price,
    });
  }

  // Rank by ATR14% and take topN
  eligible.sort((a, b) => b.atrPct - a.atrPct);
  return eligible.slice(0, topN);
}

/**
 * Layer 2: Determine direction for opportunity candidates
 *
 * @param {string} signalDate - Signal date
 * @param {Object} raw - Raw OHLCV data
 * @param {Array<{symbol}>} candidates - Opportunity candidates from Layer 1
 * @param {Object} config - {directionPolicy, emaSlopeThreshold}
 * @returns {Array<{symbol, direction}>} direction = 'long' | 'short' | 'uncertain'
 */
export function determineDirection(signalDate, raw, candidates, config) {
  const {
    directionPolicy = 'ema-slope',
    emaSlopeThreshold = 0.3,
  } = config;

  const directions = [];

  for (const { symbol } of candidates) {
    const contract = raw.contracts[symbol];
    if (!contract?.ohlcv) {
      directions.push({ symbol, direction: 'uncertain' });
      continue;
    }

    const { dates, close } = contract.ohlcv;
    const signalIdx = dates.indexOf(signalDate);
    if (signalIdx < 0 || signalIdx < 25) {
      directions.push({ symbol, direction: 'uncertain' });
      continue;
    }

    const truncClose = close.slice(0, signalIdx + 1);

    let direction = 'uncertain';

    if (directionPolicy === 'ema-slope') {
      const emaSlope = calculateEMASlope(truncClose, 20, 5);

      if (emaSlope !== null && Math.abs(emaSlope) >= emaSlopeThreshold) {
        direction = emaSlope > 0 ? 'long' : 'short';
      }
      // else: remains 'uncertain'
    }

    directions.push({ symbol, direction });
  }

  return directions;
}

/**
 * Replay two-layer model on a single date
 *
 * @param {string} signalDate - Signal date
 * @param {Object} raw - Raw OHLCV data
 * @param {Object} config - {hvThreshold, atrThreshold, topN, directionPolicy, emaSlopeThreshold, holdPeriod}
 * @returns {Object} {opportunityCandidates, candidateOutcomes, directionSignals, trades}
 */
export function replayTwoLayerDate(signalDate, raw, config) {
  const { holdPeriod = 10 } = config;

  // Layer 1: Select opportunity candidates (direction-agnostic)
  const opportunityCandidates = selectOpportunityCandidates(signalDate, raw, config);

  const candidateOutcomes = opportunityCandidates.map(({ symbol }) => {
    const entryResult = lib.simulateEntry(symbol, raw, signalDate);
    if (!entryResult) {
      return { symbol, signalDate, outcomeAvailable: false };
    }

    const exitResult = lib.simulateExit(symbol, raw, entryResult.entryIdx, holdPeriod);
    if (!exitResult) {
      return { symbol, signalDate, outcomeAvailable: false };
    }

    const { entryPrice, entryDate } = entryResult;
    const { exitPrice, exitDate } = exitResult;

    return {
      symbol,
      signalDate,
      entryDate,
      exitDate,
      entryPrice,
      exitPrice,
      absMove: Math.abs((exitPrice - entryPrice) / entryPrice),
      outcomeAvailable: true,
    };
  });

  // Layer 2: Determine direction for each candidate
  const directionSignals = determineDirection(signalDate, raw, opportunityCandidates, config);
  const outcomeBySymbol = new Map(candidateOutcomes.map(outcome => [outcome.symbol, outcome]));

  // Execute trades (only long/short, skip uncertain)
  const trades = [];

  for (const { symbol, direction } of directionSignals) {
    if (direction === 'uncertain') continue;

    const outcome = outcomeBySymbol.get(symbol);
    if (!outcome?.outcomeAvailable) continue;

    const { entryPrice, entryDate, exitPrice, exitDate } = outcome;
    const sign = direction === 'long' ? 1 : -1;
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

  return {
    opportunityCandidates,
    candidateOutcomes,
    directionSignals,
    trades,
  };
}
