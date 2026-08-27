/**
 * Probability Cone Calculator - Closed-form Solution
 *
 * Implements GBM (Geometric Brownian Motion) closed-form solution for price probability bands.
 * No Monte Carlo simulation needed - O(1) calculation.
 *
 * References:
 * - Expected Move calculation: https://dev.to/ayratmurtazin/visualizing-expected-stock-price-movement-with-python-and-volatility-multipliers-1o14
 * - TradingView Probability Cone: https://ar.tradingview.com/script/uPhPuNle-Probability-Cone/
 */

/**
 * Calculate probability cone bands using closed-form GBM solution
 *
 * Formula: Upper = S₀ × exp(z × σ × √(t))
 *          Lower = S₀ × exp(-z × σ × √(t))
 *
 * @param {number} close - Current price
 * @param {number} hvAnnual - Annualized historical volatility (e.g., 0.35 = 35%)
 * @param {Array<number>} daysList - Forecast horizons in days (e.g., [3, 5, 10])
 * @param {Array<number>} zScores - Z-scores for confidence levels (e.g., [1.0, 1.96])
 * @returns {Object} Nested bands: { "3d": { "p68": [lower, upper], "p95": [lower, upper] }, ... }
 */
export function probabilityCone(close, hvAnnual, daysList = [3, 5], zScores = [1.0, 1.96]) {
  const sigmaDailyResult = {};

  // Daily volatility (convert annual to daily, using 242 trading days for Chinese futures)
  const sigmaDaily = hvAnnual / Math.sqrt(242);

  for (const days of daysList) {
    const dayKey = `${days}d`;
    sigmaDailyResult[dayKey] = {};

    for (const z of zScores) {
      // Map z-score to percentile label (fixed thresholds)
      let label;
      if (z <= 1.1) {
        label = 'p68';  // z=1.0 → 68%
      } else if (z <= 1.7) {
        label = 'p90';  // z=1.645 → 90%
      } else if (z <= 2.4) {
        label = 'p95';  // z=1.96 → 95%
      } else {
        label = 'p99';  // z=2.576 → 99%
      }

      // Closed-form solution
      const move = z * sigmaDaily * Math.sqrt(days);
      const upper = close * Math.exp(move);
      const lower = close * Math.exp(-move);

      sigmaDailyResult[dayKey][label] = [
        Math.round(lower * 10) / 10,  // Round to 1 decimal
        Math.round(upper * 10) / 10
      ];
    }
  }

  return sigmaDailyResult;
}

/**
 * Calculate divergence between ATR channel and HV cone
 *
 * @param {Array<number>} atrBand - ATR band [lower, upper]
 * @param {Array<number>} hvBand - HV cone band [lower, upper]
 * @returns {{divergencePct: number, interpretation: string}} Divergence percentage and interpretation
 */
export function compareBands(atrBand, hvBand) {
  const [atrLower, atrUpper] = atrBand;
  const [hvLower, hvUpper] = hvBand;

  // Calculate width difference
  const atrWidth = atrUpper - atrLower;
  const hvWidth = hvUpper - hvLower;
  const divergencePct = Math.abs(atrWidth - hvWidth) / hvWidth * 100;

  // Interpretation
  let interpretation;
  if (divergencePct < 10) {
    interpretation = '两种方法区间基本一致，波动率模型稳定 ✅';
  } else if (divergencePct < 20) {
    interpretation = '两种方法区间存在差异，波动率结构可能变化 ⚠️';
  } else {
    interpretation = '两种方法区间严重背离，波动率模型不稳定 ❌';
  }

  return {
    divergencePct: Math.round(divergencePct * 10) / 10,
    interpretation
  };
}

import { autoEstimateHV, hvPercentile } from './hv-estimators.js';

/**
 * @deprecated Use stage-4-5.cjs instead. This function is kept for backward compatibility
 * but has schema inconsistencies (outputs `hv95Band` instead of `hv95Band3d`).
 *
 * Generate complete probability analysis for a single symbol
 *
 * @param {Object} params
 * @param {string} params.symbol - Symbol code (e.g., "SC0")
 * @param {number} params.close - Current close price
 * @param {number} params.atr5 - ATR(5) value
 * @param {Array<Object>} params.ohlcData - Historical OHLC data for HV calculation
 * @param {number} params.hvWindow - HV calculation window (default 20)
 * @returns {Object} Complete probability analysis including HV, cone, and comparison
 */
export function generateProbabilityAnalysis({
  symbol,
  close,
  atr5,
  ohlcData,
  hvWindow = 20
}) {

  // Calculate HV
  const { hv: hvAnnual, estimator } = autoEstimateHV(ohlcData, hvWindow);

  // Calculate HV percentile
  let percentile = null;
  try {
    const percentileResult = hvPercentile(ohlcData, hvWindow);
    percentile = percentileResult.percentile;
  } catch (err) {
    // Not enough data for percentile calculation (need 90+ days)
    percentile = null;
  }

  // Calculate probability cone
  const cone = probabilityCone(close, hvAnnual, [3, 5], [1.0, 1.96]);

  // ATR band for comparison (2×ATR)
  const atrBand = [close - 2 * atr5, close + 2 * atr5];

  // Compare ATR vs HV (use 3d p95 for comparison)
  const hvBand3d = cone['3d']['p95'];
  const comparison = compareBands(atrBand, hvBand3d);

  return {
    symbol,
    close,
    hv: {
      annual: Math.round(hvAnnual * 1000) / 1000,  // Round to 3 decimals
      periodDays: hvWindow,
      percentile90d: percentile,
      estimator
    },
    cone,
    atrComparison: {
      atr5,
      atr2xBand: [Math.round(atrBand[0] * 10) / 10, Math.round(atrBand[1] * 10) / 10],
      hv95Band: hvBand3d,
      divergencePct: comparison.divergencePct,
      interpretation: comparison.interpretation
    }
  };
}

/**
 * Z-score reference table for confidence levels
 */
export const Z_SCORES = {
  p68: 1.0,      // 68% (1σ)
  p90: 1.645,    // 90%
  p95: 1.96,     // 95% (2σ)
  p99: 2.576     // 99% (3σ)
};
