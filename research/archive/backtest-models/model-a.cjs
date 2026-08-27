#!/usr/bin/env node
/**
 * model-a.cjs — Regime-Aware Direction Model
 *
 * Strategy: Use ADX to detect trending vs ranging regimes
 * - High ADX (>25): Follow MA alignment (current logic)
 * - Low ADX (<20): Neutral (skip trade)
 * - Medium ADX (20-25): Reduced confidence
 *
 * Hypothesis: Current model fails because it bets on trends in ranging markets
 */

const fs = require('fs');
const path = require('path');

// Reuse baseline scoring functions
const baseline = require('./baseline.cjs');

/**
 * Calculate ADX from price data (simplified Wilder's method)
 */
function calculateADX(ohlcv, period = 14) {
  const { high, low, close } = ohlcv;
  if (!high || !low || !close || close.length < period + 1) return null;

  const trueRanges = [];
  const plusDM = [];
  const minusDM = [];

  for (let i = 1; i < close.length; i++) {
    const tr = Math.max(
      high[i] - low[i],
      Math.abs(high[i] - close[i - 1]),
      Math.abs(low[i] - close[i - 1])
    );
    trueRanges.push(tr);

    const upMove = high[i] - high[i - 1];
    const downMove = low[i - 1] - low[i];

    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  // Smooth TR, +DM, -DM
  const smoothTR = trueRanges.slice(-period).reduce((a, b) => a + b, 0) / period;
  const smoothPlusDM = plusDM.slice(-period).reduce((a, b) => a + b, 0) / period;
  const smoothMinusDM = minusDM.slice(-period).reduce((a, b) => a + b, 0) / period;

  const plusDI = (smoothPlusDM / smoothTR) * 100;
  const minusDI = (smoothMinusDM / smoothTR) * 100;

  const dx = Math.abs(plusDI - minusDI) / (plusDI + minusDI) * 100;

  return dx; // Simplified: use DX as ADX proxy (should be smoothed EMA in full impl)
}

/**
 * Determine regime and adjust direction logic
 */
function regimeAwareDirection(indicators, trend, raw, symbol) {
  const contract = raw.contracts[symbol];
  if (!contract || !contract.ohlcv) {
    return { direction: 'neutral', confidence: 'very_low', regime: 'unknown' };
  }

  const adx = calculateADX(contract.ohlcv);
  if (adx === null) {
    return { direction: 'neutral', confidence: 'very_low', regime: 'unknown' };
  }

  let regime = 'ranging';
  if (adx > 25) regime = 'trending';
  else if (adx > 20) regime = 'weak_trend';

  // Baseline direction logic
  const change5d = indicators?.change5d || 0;
  const ma20 = trend?.vsMA20 || 0;
  const ma60 = trend?.vsMA60 || 0;

  let direction = 'neutral';
  let confidenceBoost = 0;

  if (regime === 'trending') {
    // High ADX: trust MA alignment
    if (change5d > 0 && ma20 > 0 && ma60 > 0) {
      direction = 'bullish';
      confidenceBoost = 1.0; // Higher confidence in trending regime
    } else if (change5d < 0 && ma20 < 0 && ma60 < 0) {
      direction = 'bearish';
      confidenceBoost = 1.0;
    }
  } else if (regime === 'weak_trend') {
    // Medium ADX: reduced confidence
    if (change5d > 0 && ma20 > 0 && ma60 > 0) {
      direction = 'bullish';
      confidenceBoost = 0.3;
    } else if (change5d < 0 && ma20 < 0 && ma60 < 0) {
      direction = 'bearish';
      confidenceBoost = 0.3;
    }
  }
  // Low ADX: stay neutral (skip trade)

  return { direction, confidenceBoost, regime, adx: parseFloat(adx.toFixed(2)) };
}

/**
 * Generate signals with regime awareness
 */
function generateSignals(raw, filtered, signalDate) {
  const signals = [];
  const candidates = filtered.candidates || [];

  if (process.env.DEBUG_MODEL_A) {
    console.log(`\n[Model-A Debug] Processing ${candidates.length} candidates`);
  }

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

    const directionInfo = regimeAwareDirection(indicators, trend, raw, c.symbol);

    if (process.env.DEBUG_MODEL_A) {
      console.log(`  ${c.symbol}: ADX=${directionInfo.adx}, regime=${directionInfo.regime}, direction=${directionInfo.direction}`);
    }

    const adjustedScore = score.overall + directionInfo.confidenceBoost;
    const confidence = baseline.determineConfidence(adjustedScore, 0);

    if (directionInfo.direction !== 'neutral' && ['low', 'medium', 'high'].includes(confidence)) {
      signals.push({
        symbol: c.symbol,
        direction: directionInfo.direction,
        confidence,
        score: score.overall,
        adjustedScore,
        regime: directionInfo.regime,
        adx: directionInfo.adx
      });
    }
  }

  signals.sort((a, b) => b.adjustedScore - a.adjustedScore);
  return signals.slice(0, 3);
}

function getMetadata() {
  return {
    name: 'model-a',
    description: 'Regime-aware direction using ADX filter',
    change: 'Added ADX(14) regime detection before direction prediction',
    hypothesis: 'MA alignment works in trending markets but fails in ranging markets'
  };
}

module.exports = {
  generateSignals,
  getMetadata
};
