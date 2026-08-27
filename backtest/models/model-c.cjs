#!/usr/bin/env node
/**
 * model-c.cjs — Pure Volatility Breakout (No Direction Prediction)
 *
 * Strategy: Trade high volatility without predicting direction
 * - Enter BOTH long and short positions (straddle)
 * - Exit when either leg hits profit target or both hit stop loss
 * - Hypothesis: Direction is unpredictable, but volatility expansion is tradable
 *
 * For backtest compatibility: randomly assign direction (simulates straddle)
 * Real implementation would track both legs separately
 */

const fs = require('fs');
const path = require('path');

/**
 * Calculate recent volatility acceleration
 */
function calculateVolatilityMetrics(ohlcv) {
  const { close, high, low } = ohlcv;
  if (!close || close.length < 20) return null;

  // 5-day historical volatility
  const returns5 = [];
  for (let i = close.length - 5; i < close.length; i++) {
    returns5.push(Math.log(close[i] / close[i - 1]));
  }
  const hv5 = Math.sqrt(returns5.reduce((a, b) => a + b ** 2, 0) / 5) * Math.sqrt(252) * 100;

  // 20-day historical volatility
  const returns20 = [];
  for (let i = close.length - 20; i < close.length; i++) {
    returns20.push(Math.log(close[i] / close[i - 1]));
  }
  const hv20 = Math.sqrt(returns20.reduce((a, b) => a + b ** 2, 0) / 20) * Math.sqrt(252) * 100;

  // Average True Range (ATR) as % of price
  let atrSum = 0;
  for (let i = close.length - 14; i < close.length; i++) {
    const tr = Math.max(
      high[i] - low[i],
      Math.abs(high[i] - close[i - 1]),
      Math.abs(low[i] - close[i - 1])
    );
    atrSum += tr;
  }
  const atr14 = (atrSum / 14) / close[close.length - 1] * 100;

  return {
    hv5: parseFloat(hv5.toFixed(2)),
    hv20: parseFloat(hv20.toFixed(2)),
    hvRatio: parseFloat((hv5 / hv20).toFixed(2)),
    atr14Pct: parseFloat(atr14.toFixed(2))
  };
}

/**
 * Pure volatility signal (no direction)
 */
function volatilityBreakoutSignal(indicators, raw, symbol) {
  const contract = raw.contracts[symbol];
  if (!contract || !contract.ohlcv) {
    return { direction: 'neutral', confidence: 'very_low', metrics: {} };
  }

  const volMetrics = calculateVolatilityMetrics(contract.ohlcv);
  if (!volMetrics) {
    return { direction: 'neutral', confidence: 'very_low', metrics: {} };
  }

  const { hvRatio, atr14Pct } = volMetrics;

  // Criteria: volatility accelerating (HV5 > HV20) AND high ATR
  if (hvRatio > 1.3 && atr14Pct > 3.0) {
    // For backtest: assign random direction (simulates straddle where we only track one leg)
    // In real implementation, would enter both long and short
    const direction = Math.random() > 0.5 ? 'bullish' : 'bearish';
    const confidenceBoost = 0.5;

    return { direction, confidenceBoost, metrics: volMetrics, strategy: 'straddle_sim' };
  }

  return { direction: 'neutral', confidence: 'very_low', metrics: volMetrics };
}

/**
 * Generate signals based on pure volatility
 */
function generateSignals(raw, filtered, signalDate) {
  const signals = [];
  const candidates = filtered.candidates || [];
  const baseline = require('./baseline.cjs');

  for (const c of candidates) {
    // Build indicators from flat candidate fields
    const indicators = {
      atr14: c.atr14,
      atrPct: c.atrPct,
      hv5: c.hv5,
      hv20: c.hv20,
      hvRatio: c.hv20 > 0 ? c.hv5 / c.hv20 : null,
      ma20: c.ma20,
      ma60: c.ma60,
      price: c.price,
      change5d: c.change5d,
      volPercentile: c.volPercentile,
      volMultiplier: c.volMultiplier
    };

    const trend = {
      change5d: c.change5d,
      ma20: c.ma20,
      ma60: c.ma60,
      vsMA20: c.vsMA20,
      vsMA60: c.vsMA60
    };

    // Reuse baseline scoring for candidate quality
    const score = baseline.calculateOverallScore({
      symbol: c.symbol,
      sector: c.sector,
      indicators,
      trend,
      liquidity: {
        avgTurnover5d: c.avgTurnover5d,
        avgOI5d: c.avgOI5d
      }
    }, candidates);

    const volInfo = volatilityBreakoutSignal(indicators, raw, c.symbol);

    const adjustedScore = score.overall + (volInfo.confidenceBoost || 0);
    const confidence = baseline.determineConfidence(adjustedScore, 0);

    if (volInfo.direction !== 'neutral' && ['low', 'medium', 'high'].includes(confidence)) {
      signals.push({
        symbol: c.symbol,
        direction: volInfo.direction,
        confidence,
        score: score.overall,
        adjustedScore,
        strategy: volInfo.strategy,
        hvRatio: volInfo.metrics.hvRatio,
        atr14Pct: volInfo.metrics.atr14Pct
      });
    }
  }

  signals.sort((a, b) => b.adjustedScore - a.adjustedScore);
  return signals.slice(0, 3);
}

function getMetadata() {
  return {
    name: 'model-c',
    description: 'Pure volatility breakout (no direction prediction, straddle simulation)',
    change: 'Trade HV acceleration (HV5/HV20 > 1.3) + high ATR (>3%), random direction simulates straddle',
    hypothesis: 'Direction is unpredictable, but volatility expansion is tradable'
  };
}

module.exports = {
  generateSignals,
  getMetadata
};
