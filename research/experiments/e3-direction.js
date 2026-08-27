/**
 * E3 Direction Policy Experiments
 * Tests 2 direction candidates + 3 controls against EMA20 baseline
 * Uses fixed cohort with neutral retention
 * Max-T FWER control (one-sided), controls excluded from winner selection
 */

import {
  generateBlockSignFlip,
  applyBlockSigns,
  calculateStudentizedT,
  calculateMaxT,
  calculateAdjustedPValue
} from '../../lib/statistics.js';

/**
 * Run E3 direction policy experiment
 * @param {Object} testData - Test data with baseline, candidates, and controls
 * @param {number} cohortSize - Fixed cohort size (number of symbols in cohort)
 * @returns {Object} Experiment results with null distribution and winner
 */
export function runE3Experiment(testData, cohortSize = null) {
  const { dates, baseline, candidates, controls } = testData;
  const n = dates.length;

  // Input invariants: array length consistency and finite values
  if (baseline.returns.length !== n) {
    throw new Error(`E3 baseline.returns length ${baseline.returns.length} != dates length ${n}`);
  }
  if (baseline.neutralCount.length !== n) {
    throw new Error(`E3 baseline.neutralCount length ${baseline.neutralCount.length} != dates length ${n}`);
  }
  if (!baseline.returns.every(r => Number.isFinite(r))) {
    throw new Error('E3 baseline.returns contains non-finite values');
  }
  if (!baseline.neutralCount.every(nc => Number.isFinite(nc) && nc >= 0 && Number.isInteger(nc))) {
    throw new Error('E3 baseline.neutralCount contains invalid values (must be non-negative integers)');
  }
  candidates.forEach((c, idx) => {
    if (c.returns.length !== n) {
      throw new Error(`E3 candidate[${idx}] ${c.name} returns length ${c.returns.length} != dates length ${n}`);
    }
    if (c.neutralCount.length !== n) {
      throw new Error(`E3 candidate[${idx}] ${c.name} neutralCount length ${c.neutralCount.length} != dates length ${n}`);
    }
    if (!c.returns.every(r => Number.isFinite(r))) {
      throw new Error(`E3 candidate[${idx}] ${c.name} returns contains non-finite values`);
    }
    if (!c.neutralCount.every(nc => Number.isFinite(nc) && nc >= 0 && Number.isInteger(nc))) {
      throw new Error(`E3 candidate[${idx}] ${c.name} neutralCount contains invalid values`);
    }
  });
  controls.forEach((c, idx) => {
    if (c.returns.length !== n) {
      throw new Error(`E3 control[${idx}] ${c.name} returns length ${c.returns.length} != dates length ${n}`);
    }
    if (c.neutralCount.length !== n) {
      throw new Error(`E3 control[${idx}] ${c.name} neutralCount length ${c.neutralCount.length} != dates length ${n}`);
    }
    if (!c.returns.every(r => Number.isFinite(r))) {
      throw new Error(`E3 control[${idx}] ${c.name} returns contains non-finite values`);
    }
    if (!c.neutralCount.every(nc => Number.isFinite(nc) && nc >= 0 && Number.isInteger(nc))) {
      throw new Error(`E3 control[${idx}] ${c.name} neutralCount contains invalid values`);
    }
  });

  // Check coverage: >20% dates all-neutral fails
  // All-neutral = all candidates mark entire cohort as neutral on that date
  // If cohortSize not provided, infer from max neutralCount across all policies
  const inferredCohortSize = cohortSize ?? Math.max(
    ...baseline.neutralCount,
    ...candidates.flatMap(c => c.neutralCount),
    ...controls.flatMap(c => c.neutralCount)
  );

  const allNeutralDates = dates.filter((_, i) => {
    // A date is all-neutral if every candidate policy has neutralCount == cohortSize
    // Controls are not checked (they're for null distribution only)
    if (candidates.length === 0) return false;

    return candidates.every(c => c.neutralCount[i] === inferredCohortSize);
  });

  const allNeutralRate = allNeutralDates.length / n;
  if (allNeutralRate > 0.20) {
    return {
      coverageFailure: {
        reason: 'More than 20% dates where all candidates mark entire cohort as neutral',
        allNeutralRate,
        allNeutralDates: allNeutralDates.length,
        cohortSize: inferredCohortSize
      }
    };
  }

  // Generate 64 block sign-flip patterns
  const patterns = generateBlockSignFlip(6);

  // Process candidates and controls together for null distribution
  const allPolicies = [...candidates, ...controls];

  const policyResults = allPolicies.map(policy => {
    // Paired deltas: Δ[d] = R_policy[d] - R_baseline[d]
    // Neutral dates retained with return=0
    const deltas = policy.returns.map((r, i) => r - baseline.returns[i]);

    // Observed t-statistic
    const tObserved = calculateStudentizedT(deltas);

    // Null distribution: apply each pattern and recalculate t
    const nullTStats = patterns.map(pattern => {
      const permutedDeltas = applyBlockSigns(deltas, pattern);
      return calculateStudentizedT(permutedDeltas);
    });

    return {
      name: policy.name,
      deltas,
      tObserved,
      nullTStats,
      isControl: controls.some(c => c.name === policy.name)
    };
  });

  // Family-wise Max-T statistic (signed, for one-sided test)
  // Include all policies (candidates + controls) in null distribution
  const nullMaxT = [];
  for (let p = 0; p < 64; p++) {
    const tValues = policyResults.map(policy => policy.nullTStats[p]);
    nullMaxT.push(Math.max(...tValues));
  }

  // Calculate adjusted p-values for all policies
  policyResults.forEach(policy => {
    policy.pAdjusted = calculateAdjustedPValue(policy.tObserved, nullMaxT);
  });

  // Winner selection: only from candidates (t > 0 and p_adj <= 0.05)
  const candidateResults = policyResults.filter(p => !p.isControl);
  const controlResults = policyResults.filter(p => p.isControl);

  const eligibleWinners = candidateResults.filter(
    c => c.tObserved > 0 && c.pAdjusted <= 0.05
  );

  let winner = null;
  if (eligibleWinners.length > 0) {
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
    controls: controlResults.map(c => ({
      name: c.name,
      deltas: c.deltas,
      tObserved: c.tObserved,
      pAdjusted: c.pAdjusted,
      excluded: true // Controls cannot win
    })),
    winner: winner ? winner.name : null
  };
}
