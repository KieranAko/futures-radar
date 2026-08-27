#!/usr/bin/env node
/**
 * baseline.cjs — Current System (Stage 2 + Stage 3 logic)
 *
 * Replicates existing scanner + quantitative-filter behavior for comparison
 */

const fs = require('fs');
const path = require('path');

/**
 * Scoring functions (copied from quantitative-filter.cjs)
 */

function scoreVolatilityQuality(indicators) {
  const volPct = indicators.volPercentile;
  if (volPct == null) return 0;

  let score = volPct / 10;

  if (volPct >= 60 && volPct <= 90) {
    score += 1;
  }
  if (volPct > 95) {
    score -= 2;
  }

  const hvRatio = indicators.hv5 && indicators.hv20 ? indicators.hv5 / indicators.hv20 : 1;
  if (hvRatio > 1.2) {
    score += 0.5;
  }

  return Math.max(0, Math.min(10, score));
}

function scoreTrendConfirmation(indicators, trend) {
  let score = 0;

  const ma20 = trend.vsMA20;
  const ma60 = trend.vsMA60;

  if (ma20 != null && ma60 != null) {
    if ((ma20 > 0 && ma60 > 0) || (ma20 < 0 && ma60 < 0)) {
      score += 6;
    } else {
      score += 2;
    }
  }

  const change5d = indicators.change5d;
  if (change5d != null && Math.abs(change5d) > 3) {
    score += 2;
  }

  const volMult = indicators.volMultiplier;
  if (volMult != null && volMult > 1.5) {
    score += 2;
  }

  if (ma20 != null && Math.abs(ma20) > 15) {
    score -= 3;
  }

  return Math.max(0, Math.min(10, score));
}

function scoreLiquidityDepth(liquidity) {
  let score = 0;

  const turnover = liquidity.avgTurnover5d;
  if (turnover != null) {
    if (turnover >= 10e8) score += 5;
    else if (turnover >= 5e8) score += 4;
    else if (turnover >= 2e8) score += 3;
    else score += 1;
  }

  const oi = liquidity.avgOI5d;
  if (oi != null) {
    if (oi >= 100000) score += 5;
    else if (oi >= 50000) score += 4;
    else if (oi >= 30000) score += 3;
    else score += 1;
  }

  return Math.max(0, Math.min(10, score));
}

function scoreSectorMomentum(candidate, allCandidates) {
  const sector = candidate.sector;
  const direction = candidate.trend?.direction;

  if (!sector || direction === 'flat' || direction === 'unknown') {
    return 2;
  }

  const sectorSymbols = allCandidates.filter(c =>
    c.sector === sector &&
    c.symbol !== candidate.symbol &&
    c.trend?.direction === direction
  );

  const count = sectorSymbols.length;

  if (count >= 3) return 8;
  if (count === 2) return 5;
  if (count === 1) return 2;
  return 2;
}

function calculateOverallScore(candidate, allCandidates) {
  const scoreA = scoreVolatilityQuality(candidate.indicators || {});
  const scoreB = scoreTrendConfirmation(candidate.indicators || {}, candidate.trend || {});
  const scoreC = scoreLiquidityDepth(candidate.liquidity || {});
  const scoreD = scoreSectorMomentum(candidate, allCandidates);

  const overall = scoreA * 0.30 + scoreB * 0.35 + scoreC * 0.15 + scoreD * 0.20;

  return {
    overall: parseFloat(overall.toFixed(2)),
    breakdown: {
      volatilityQuality: parseFloat(scoreA.toFixed(2)),
      trendConfirmation: parseFloat(scoreB.toFixed(2)),
      liquidityDepth: parseFloat(scoreC.toFixed(2)),
      sectorMomentum: parseFloat(scoreD.toFixed(2))
    }
  };
}

function determineDirection(indicators, trend) {
  const change5d = indicators?.change5d || 0;
  const ma20 = trend?.vsMA20 || 0;
  const ma60 = trend?.vsMA60 || 0;
  const volMult = indicators?.volMultiplier || 1;

  let direction = 'neutral';
  let confidenceBoost = 0;

  if (change5d > 0 && ma20 > 0 && ma60 > 0) {
    direction = 'bullish';
    confidenceBoost = 0.5;
  } else if (change5d < 0 && ma20 < 0 && ma60 < 0) {
    direction = 'bearish';
    confidenceBoost = 0.5;
  } else if (Math.abs(change5d) > 5 && volMult > 2.0) {
    direction = change5d > 0 ? 'bullish' : 'bearish';
    confidenceBoost = 0;
  } else {
    direction = 'neutral';
    confidenceBoost = -1.0;
  }

  return { direction, confidenceBoost };
}

function determineConfidence(overallScore, confidenceBoost) {
  let adjustedScore = overallScore + confidenceBoost;

  if (adjustedScore >= 7.5) return 'high';
  if (adjustedScore >= 6.0) return 'medium';
  if (adjustedScore >= 5.0) return 'low';
  return 'very_low';
}

/**
 * Generate signals from a historical run using current system logic
 *
 * @param {Object} raw - raw.json data (full dataset for reference)
 * @param {Object} filtered - filtered data with candidates (from scanner/hard-filter)
 * @param {string} signalDate - Signal date T (for validation)
 * @returns {Array} Array of {symbol, direction, confidence, score}
 */
function generateSignals(raw, filtered, signalDate) {
  const signals = [];

  // Use candidates from filtered (already computed with truncated data)
  const candidates = filtered.candidates || [];

  if (candidates.length === 0) {
    return [];
  }

  // Validate time-chain: all candidates must have _lastDate === signalDate
  for (const c of candidates) {
    if (c._lastDate && c._lastDate !== signalDate) {
      console.error(`[Baseline] TIME-CHAIN ERROR: ${c.symbol} _lastDate=${c._lastDate} !== signalDate=${signalDate}`);
    }
  }

  // Build indicators object from candidate fields
  const scored = candidates.map(c => {
    // Map candidate fields to indicators structure
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

    const score = calculateOverallScore({
      symbol: c.symbol,
      sector: c.sector,
      indicators,
      trend,
      derived: {
        avgTurnover5d: c.avgTurnover5d,
        avgOI5d: c.avgOI5d
      }
    }, candidates);

    const directionInfo = determineDirection(indicators, trend);
    const confidence = determineConfidence(score.overall, directionInfo.confidenceBoost);

    return {
      symbol: c.symbol,
      direction: directionInfo.direction,
      confidence,
      score: score.overall,
      adjustedScore: score.overall + directionInfo.confidenceBoost,
      scoreBreakdown: score.breakdown
    };
  });

  // Filter: only non-neutral with confidence >= low
  const viable = scored.filter(s =>
    s.direction !== 'neutral' &&
    ['low', 'medium', 'high'].includes(s.confidence)
  );

  // Sort by adjusted score and take top 3
  viable.sort((a, b) => b.adjustedScore - a.adjustedScore);

  return viable.slice(0, 3);
}

/**
 * Model metadata
 */
function getMetadata() {
  return {
    name: 'baseline',
    description: 'Current system (4D weighted scoring + MA alignment)',
    stage2: {
      method: 'weighted_scoring',
      dimensions: [
        'volatilityQuality (30%)',
        'trendConfirmation (35%)',
        'liquidityDepth (15%)',
        'sectorMomentum (20%)'
      ],
      sweetSpots: {
        volatility: 'P60-P90',
        trend: 'MA deviation 3-8%',
        momentum: '5d return 3-6%'
      }
    },
    stage3: {
      method: 'ma_alignment',
      logic: 'change5d + MA20 + MA60 all same sign',
      window: 'T+3/T+5'
    }
  };
}

module.exports = {
  generateSignals,
  getMetadata,
  calculateOverallScore,
  determineDirection,
  determineConfidence
};
