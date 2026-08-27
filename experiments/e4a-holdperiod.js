/**
 * E4a Hold Period Experiments
 * Tests H7 and H15 against H10 baseline
 * Uses Bonferroni correction (α=0.025 per test, family α=0.05)
 * Independent tests (no FWER, each has own null distribution)
 */

import {
  generateBlockSignFlip,
  applyBlockSigns,
  calculateStudentizedT,
  calculateAdjustedPValue
} from '../lib/statistics.js';

/**
 * Run E4a hold period experiment
 * @param {Object} testData - Test data with baseline and candidates (H7, H15)
 * @returns {Object} Experiment results with independent null distributions
 */
export function runE4aExperiment(testData) {
  const { dates, baseline, candidates } = testData;
  const n = dates.length;

  // Input invariants: array length consistency and finite values
  if (baseline.returns.length !== n) {
    throw new Error(`E4a baseline.returns length ${baseline.returns.length} != dates length ${n}`);
  }
  if (!baseline.returns.every(r => Number.isFinite(r))) {
    throw new Error('E4a baseline.returns contains non-finite values');
  }
  candidates.forEach((c, idx) => {
    if (c.returns.length !== n) {
      throw new Error(`E4a candidate[${idx}] ${c.name} returns length ${c.returns.length} != dates length ${n}`);
    }
    if (!c.returns.every(r => Number.isFinite(r))) {
      throw new Error(`E4a candidate[${idx}] ${c.name} returns contains non-finite values`);
    }
  });

  // Bonferroni correction: 2 comparisons, each tested at α=0.025
  const alphaPerTest = 0.05 / 2;

  // Generate 64 block sign-flip patterns
  const patterns = generateBlockSignFlip(6);

  // Calculate paired deltas and null distributions independently for each candidate
  const nullDistributions = {};

  const candidateResults = candidates.map(candidate => {
    // Paired deltas: Δ[d] = R_candidate[d] - R_baseline[d]
    const deltas = candidate.returns.map((r, i) => r - baseline.returns[i]);

    // Observed t-statistic
    const tObserved = calculateStudentizedT(deltas);

    // Null distribution: apply each pattern and recalculate t
    // Each candidate has its own independent null distribution
    const nullTStats = patterns.map(pattern => {
      const permutedDeltas = applyBlockSigns(deltas, pattern);
      return calculateStudentizedT(permutedDeltas);
    });

    // Store null distribution for this candidate
    nullDistributions[candidate.name] = nullTStats;

    // Calculate p-value against own null distribution
    const pValue = calculateAdjustedPValue(tObserved, nullTStats);

    return {
      name: candidate.name,
      deltas,
      tObserved,
      pValue,
      rejected: tObserved > 0 && pValue <= alphaPerTest
    };
  });

  return {
    multipleTesting: 'Bonferroni',
    alphaPerTest,
    nullDistributions,
    candidates: candidateResults
  };
}
