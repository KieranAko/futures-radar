#!/usr/bin/env node
/**
 * control-random-fixed.cjs — Random Direction Control Group (Fixed Seed)
 *
 * Purpose: Establish random baseline distribution
 * Strategy: Enter random direction on all candidates, deterministic seed
 * Hypothesis: This is the null hypothesis - 50% accuracy, near-zero return
 */

// Fixed seed for reproducibility
let seed = 12345;

function seededRandom() {
  const x = Math.sin(seed++) * 10000;
  return x - Math.floor(x);
}

function generateSignals(raw, filtered, signalDate) {
  const signals = [];
  const candidates = filtered.candidates || [];

  // Reset seed for each run to ensure deterministic results
  seed = 12345;

  for (const c of candidates) {
    const direction = seededRandom() > 0.5 ? 'bullish' : 'bearish';

    signals.push({
      symbol: c.symbol,
      direction,
      confidence: 'medium',
      score: 5.0,
      adjustedScore: 5.0,
      strategy: 'random-fixed-seed'
    });
  }

  return signals;
}

function getMetadata() {
  return {
    name: 'control-random-fixed',
    description: 'Random direction (fixed seed) - deterministic random baseline',
    purpose: 'Null hypothesis: expected 50% accuracy, near-zero return'
  };
}

module.exports = {
  generateSignals,
  getMetadata
};
