/**
 * E1 Scanner Experiments
 * Tests 4 candidate scanners against ATR14% Top10 baseline
 * Uses paired comparison with Max-T FWER control (one-sided)
 */

import {
  generateBlockSignFlip,
  applyBlockSigns,
  calculateStudentizedT,
  calculateMaxT,
  calculateAdjustedPValue
} from '../lib/statistics.js';

/**
 * Run E1 scanner experiment
 * @param {Object} testData - Test data with baseline and candidates
 * @returns {Object} Experiment results with null distribution and winner
 */
export function runE1Experiment(testData) {
  const { dates, baseline, candidates } = testData;
  const n = dates.length;

  // Input invariants: array length consistency and finite values
  if (baseline.returns.length !== n) {
    throw new Error(`E1 baseline.returns length ${baseline.returns.length} != dates length ${n}`);
  }
  if (!baseline.returns.every(r => Number.isFinite(r))) {
    throw new Error('E1 baseline.returns contains non-finite values');
  }
  candidates.forEach((c, idx) => {
    if (c.returns.length !== n) {
      throw new Error(`E1 candidate[${idx}] ${c.name} returns length ${c.returns.length} != dates length ${n}`);
    }
    if (!c.returns.every(r => Number.isFinite(r))) {
      throw new Error(`E1 candidate[${idx}] ${c.name} returns contains non-finite values`);
    }
  });

  // Generate 64 block sign-flip patterns
  const patterns = generateBlockSignFlip(6);

  // Calculate paired deltas and observed t-statistics for each candidate
  const candidateResults = candidates.map(candidate => {
    // Paired deltas: Δ[d] = R_candidate[d] - R_baseline[d]
    const deltas = candidate.returns.map((r, i) => r - baseline.returns[i]);

    // Observed t-statistic
    const tObserved = calculateStudentizedT(deltas);

    // Null distribution: apply each pattern and recalculate t
    const nullTStats = patterns.map(pattern => {
      const permutedDeltas = applyBlockSigns(deltas, pattern);
      return calculateStudentizedT(permutedDeltas);
    });

    return {
      name: candidate.name,
      deltas,
      tObserved,
      nullTStats
    };
  });

  // Family-wise Max-T statistic (signed, for one-sided test)
  const nullMaxT = [];
  for (let p = 0; p < 64; p++) {
    const tValues = candidateResults.map(c => c.nullTStats[p]);
    nullMaxT.push(Math.max(...tValues));
  }

  // Calculate adjusted p-values
  candidateResults.forEach(candidate => {
    candidate.pAdjusted = calculateAdjustedPValue(candidate.tObserved, nullMaxT);
  });

  // Winner selection: t > 0 and p_adj <= 0.05
  const eligibleWinners = candidateResults.filter(
    c => c.tObserved > 0 && c.pAdjusted <= 0.05
  );

  let winner = null;
  if (eligibleWinners.length > 0) {
    // Select best t-statistic among eligible
    winner = eligibleWinners.reduce((best, current) =>
      current.tObserved > best.tObserved ? current : best
    );
  }

  return {
    familyStatistic: 'Max-T (signed)',
    nullDistribution: nullMaxT,
    candidates: candidateResults.map(c => ({
      name: c.name,
      deltas: c.deltas,
      tObserved: c.tObserved,
      pAdjusted: c.pAdjusted,
      rejected: c.tObserved > 0 && c.pAdjusted <= 0.05
    })),
    winner: winner ? winner.name : null
  };
}
