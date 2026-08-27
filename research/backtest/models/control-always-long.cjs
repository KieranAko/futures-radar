#!/usr/bin/env node
/**
 * control-always-long.cjs — Always Long Control Group
 *
 * Purpose: Test if high-volatility scanner creates a natural long bias
 * Strategy: Enter long on ALL candidates that pass hard filter
 * Hypothesis: If this beats random, scanner has predictive value
 */

function generateSignals(raw, filtered, signalDate) {
  const signals = [];
  const candidates = filtered.candidates || [];

  // Enter long on every candidate
  for (const c of candidates) {
    signals.push({
      symbol: c.symbol,
      direction: 'bullish',
      confidence: 'medium',
      score: 5.0,
      adjustedScore: 5.0,
      strategy: 'always-long'
    });
  }

  // Return all candidates (no top-3 limit for control group)
  return signals;
}

function getMetadata() {
  return {
    name: 'control-always-long',
    description: 'Always long control group - enter long on all high-volatility candidates',
    purpose: 'Establish baseline: does scanner create natural long bias?'
  };
}

module.exports = {
  generateSignals,
  getMetadata
};
