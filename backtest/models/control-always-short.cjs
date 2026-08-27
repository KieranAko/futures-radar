#!/usr/bin/env node
/**
 * control-always-short.cjs — Always Short Control Group
 *
 * Purpose: Test if high-volatility scanner creates a natural short bias
 * Strategy: Enter short on ALL candidates that pass hard filter
 * Hypothesis: If this beats random, scanner has predictive value (bearish)
 */

function generateSignals(raw, filtered, signalDate) {
  const signals = [];
  const candidates = filtered.candidates || [];

  // Enter short on every candidate
  for (const c of candidates) {
    signals.push({
      symbol: c.symbol,
      direction: 'bearish',
      confidence: 'medium',
      score: 5.0,
      adjustedScore: 5.0,
      strategy: 'always-short'
    });
  }

  // Return all candidates (no top-3 limit for control group)
  return signals;
}

function getMetadata() {
  return {
    name: 'control-always-short',
    description: 'Always short control group - enter short on all high-volatility candidates',
    purpose: 'Establish baseline: does scanner create natural short bias?'
  };
}

module.exports = {
  generateSignals,
  getMetadata
};
