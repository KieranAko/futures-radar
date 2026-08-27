#!/usr/bin/env node
/**
 * model-b.cjs — Mean Reversion Counter-Trend Model
 *
 * Strategy: Bet AGAINST MA alignment in low-ADX ranging markets
 * - Low ADX + bullish MA alignment → SHORT (expect reversion)
 * - Low ADX + bearish MA alignment → LONG (expect reversion)
 * - High ADX → Skip (strong trends persist)
 *
 * Hypothesis: 3% accuracy suggests model predicts opposite direction
 * Mean reversion may dominate in commodity futures
 */

const fs = require('fs');
const path = require('path');

// Reuse ADX calculation from model-a
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

  const smoothTR = trueRanges.slice(-period).reduce((a, b) => a + b, 0) / period;
  const smoothPlusDM = plusDM.slice(-period).reduce((a, b) => a + b, 0) / period;
  const smoothMinusDM = minusDM.slice(-period).reduce((a, b) => a + b, 0) / period;

  const plusDI = (smoothPlusDM / smoothTR) * 100;
  const minusDI = (smoothMinusDM / smoothTR) * 100;

  const dx = Math.abs(plusDI - minusDI) / (plusDI + minusDI) * 100;

  return dx;
}

/**
 * Calculate Bollinger Bands deviation (for overbought/oversold)
 */
function calculateBBDeviation(close, period = 20) {
  if (!close || close.length < period) return null;

  const slice = close.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
  const std = Math.sqrt(variance);

  const current = close[close.length - 1];
  const deviation = (current - mean) / std; // Z-score

  return deviation;
}

/**
 * Mean reversion direction logic
 */
function meanReversionDirection(indicators, trend, raw, symbol) {
  const contract = raw.contracts[symbol];
  if (!contract || !contract.ohlcv) {
    return { direction: 'neutral', confidence: 'very_low', regime: 'unknown' };
  }

  const adx = calculateADX(contract.ohlcv);
  const bbDev = calculateBBDeviation(contract.ohlcv.close);

  if (adx === null || bbDev === null) {
    return { direction: 'neutral', confidence: 'very_low', regime: 'unknown' };
  }

  const change5d = indicators?.change5d || 0;
  const ma20 = trend?.vsMA20 || 0;
  const ma60 = trend?.vsMA60 || 0;

  let direction = 'neutral';
  let confidenceBoost = 0;
  let regime = adx > 25 ? 'trending' : 'ranging';

  // Only counter-trend in ranging markets (ADX < 20)
  if (adx < 20) {
    // FLIP the baseline logic
    if (change5d > 0 && ma20 > 0 && ma60 > 0 && bbDev > 1.5) {
      direction = 'bearish'; // Price extended upward → bet on reversion down
      confidenceBoost = 0.8;
    } else if (change5d < 0 && ma20 < 0 && ma60 < 0 && bbDev < -1.5) {
      direction = 'bullish'; // Price extended downward → bet on reversion up
      confidenceBoost = 0.8;
    }
  }
  // Skip trending markets (ADX > 25) entirely

  return { direction, confidenceBoost, regime, adx: parseFloat(adx.toFixed(2)), bbDev: parseFloat(bbDev.toFixed(2)) };
}

/**
 * Generate signals with mean reversion logic
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

    const directionInfo = meanReversionDirection(indicators, trend, raw, c.symbol);

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
        adx: directionInfo.adx,
        bbDev: directionInfo.bbDev
      });
    }
  }

  signals.sort((a, b) => b.adjustedScore - a.adjustedScore);
  return signals.slice(0, 3);
}

function getMetadata() {
  return {
    name: 'model-b',
    description: 'Mean reversion counter-trend (flip baseline logic in ranging markets)',
    change: 'Bet AGAINST MA alignment when ADX < 20 and BB deviation > 1.5σ',
    hypothesis: 'Baseline 3% accuracy suggests it predicts the opposite direction'
  };
}

module.exports = {
  generateSignals,
  getMetadata
};
