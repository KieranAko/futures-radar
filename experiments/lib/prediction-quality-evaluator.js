/**
 * Prediction Quality Evaluator (Parameter Backtest Scoring Engine)
 *
 * Purpose: Score any parameter configuration on historical data
 * Output: Two core metrics for model evaluation
 *
 * Core metrics:
 * - Direction hit rate (方向命中率): Long hit when exitPrice > entryPrice, short hit when exitPrice < entryPrice
 * - Net return mean (净收益): Average gross return minus transaction costs (0.05% total)
 *
 * NOT an experiment selection framework — this is pure scoring, human decides what's better
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const lib = require('../../backtest/shared-backtest-lib.cjs');

/**
 * Evaluate prediction quality for a set of trades
 * @param {Array} trades - Array of {symbol, direction, entryPrice, exitPrice, entryDate, exitDate, signalDate}
 * @returns {Object} Quality metrics
 */
export function evaluatePredictionQuality(trades) {
  if (!Array.isArray(trades) || trades.length === 0) {
    return {
      totalSignals: 0,
      longSignals: 0,
      shortSignals: 0,
      long: null,
      short: null,
      overall: null,
    };
  }

  const longTrades = trades.filter(t => t.direction === 'bullish');
  const shortTrades = trades.filter(t => t.direction === 'bearish');

  return {
    totalSignals: trades.length,
    longSignals: longTrades.length,
    shortSignals: shortTrades.length,
    long: calculateMetrics(longTrades, 'bullish'),
    short: calculateMetrics(shortTrades, 'bearish'),
    overall: calculateMetrics(trades, null),
  };
}

/**
 * Calculate core metrics: hitRate and netReturnMean
 * @param {Array} trades - Trades to evaluate
 * @param {string|null} direction - 'bullish', 'bearish', or null for mixed
 * @returns {Object} {sampleSize, hitRate, netReturnMean}
 */
function calculateMetrics(trades, direction) {
  if (trades.length === 0) {
    return {
      sampleSize: 0,
      hitRate: null,
      netReturnMean: null,
    };
  }

  let hits = 0;
  const netReturns = [];

  for (const trade of trades) {
    const { entryPrice, exitPrice, direction: tradeDirection } = trade;
    const costs = lib.calculateCosts(entryPrice, exitPrice);

    let isHit, grossReturn;

    if (direction === 'bullish') {
      // Long: hit if exitPrice > entryPrice
      isHit = exitPrice > entryPrice;
      grossReturn = (exitPrice - entryPrice) / entryPrice;
    } else if (direction === 'bearish') {
      // Short: hit if exitPrice < entryPrice
      isHit = exitPrice < entryPrice;
      grossReturn = (entryPrice - exitPrice) / entryPrice;
    } else {
      // Mixed: use trade's actual direction
      const sign = tradeDirection === 'bullish' ? 1 : -1;
      grossReturn = sign * (exitPrice - entryPrice) / entryPrice;
      isHit = tradeDirection === 'bullish' ? exitPrice > entryPrice : exitPrice < entryPrice;
    }

    if (isHit) hits++;
    netReturns.push(grossReturn - costs);
  }

  return {
    sampleSize: trades.length,
    hitRate: hits / trades.length,
    netReturnMean: mean(netReturns),
  };
}

/**
 * Evaluate by signal date (date-level aggregation)
 * @param {Array} trades - All trades with signalDate
 * @param {Array<string>} dates - All 29 signal dates (including zero-signal dates)
 * @returns {Object} Date-level metrics
 */
export function evaluateBySignalDate(trades, dates) {
  const tradesByDate = new Map();

  for (const trade of trades) {
    if (!tradesByDate.has(trade.signalDate)) {
      tradesByDate.set(trade.signalDate, []);
    }
    tradesByDate.get(trade.signalDate).push(trade);
  }

  const dateReturns = [];

  for (const date of dates) {
    const dateTrades = tradesByDate.get(date) || [];

    if (dateTrades.length === 0) {
      dateReturns.push(0); // Zero-signal date
      continue;
    }

    const netReturns = dateTrades.map(t => {
      const costs = lib.calculateCosts(t.entryPrice, t.exitPrice);
      const sign = t.direction === 'bullish' ? 1 : -1;
      const grossReturn = sign * (t.exitPrice - t.entryPrice) / t.entryPrice;
      return grossReturn - costs;
    });

    dateReturns.push(mean(netReturns));
  }

  return {
    totalDates: dates.length,
    activeSignalDates: tradesByDate.size,
    zeroSignalDates: dates.length - tradesByDate.size,
    dateEqualWeightMean: mean(dateReturns),
    dateReturns,
  };
}

/**
 * Helper: calculate mean
 */
function mean(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((sum, val) => sum + val, 0) / arr.length;
}
