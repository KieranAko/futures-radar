/**
 * E2 Eligibility Ablation Experiments
 * Tests 3 gate variants against combined gate baseline
 * Uses paired comparison with Max-|T| FWER control (two-sided)
 */

import {
  generateBlockSignFlip,
  applyBlockSigns,
  calculateStudentizedT,
  calculateMaxAbsT,
  calculateAdjustedPValue
} from '../lib/statistics.js';

/**
 * Run E2 eligibility ablation experiment
 * @param {Object} testData - Test data with baseline and variants
 * @returns {Object} Experiment results with null distribution and analysis
 */
export function runE2Experiment(testData) {
  const { dates, baseline, variants } = testData;
  const n = dates.length;

  // Input invariants: array length consistency and finite values
  if (baseline.returns.length !== n) {
    throw new Error(`E2 baseline.returns length ${baseline.returns.length} != dates length ${n}`);
  }
  if (!baseline.returns.every(r => Number.isFinite(r))) {
    throw new Error('E2 baseline.returns contains non-finite values');
  }
  variants.forEach((v, idx) => {
    if (v.returns.length !== n) {
      throw new Error(`E2 variant[${idx}] ${v.name} returns length ${v.returns.length} != dates length ${n}`);
    }
    if (!v.returns.every(r => Number.isFinite(r))) {
      throw new Error(`E2 variant[${idx}] ${v.name} returns contains non-finite values`);
    }
  });

  // Generate 64 block sign-flip patterns
  const patterns = generateBlockSignFlip(6);

  // Calculate paired deltas and observed t-statistics for each variant
  const variantResults = variants.map(variant => {
    // Paired deltas: Δ[d] = R_variant[d] - R_baseline[d]
    const deltas = variant.returns.map((r, i) => r - baseline.returns[i]);

    // Observed t-statistic
    const tObserved = calculateStudentizedT(deltas);

    // Null distribution: apply each pattern and recalculate t
    const nullTStats = patterns.map(pattern => {
      const permutedDeltas = applyBlockSigns(deltas, pattern);
      return calculateStudentizedT(permutedDeltas);
    });

    return {
      name: variant.name,
      deltas,
      tObserved,
      nullTStats
    };
  });

  // Family-wise Max-|T| statistic (absolute, for two-sided test)
  const nullMaxAbsT = [];
  for (let p = 0; p < 64; p++) {
    const absTValues = variantResults.map(v => Math.abs(v.nullTStats[p]));
    nullMaxAbsT.push(Math.max(...absTValues));
  }

  // Calculate adjusted p-values (using absolute t-observed)
  variantResults.forEach(variant => {
    const absTObserved = Math.abs(variant.tObserved);
    variant.pAdjusted = calculateAdjustedPValue(absTObserved, nullMaxAbsT);
  });

  // Ablation analysis: which removal hurts most?
  const rejected = variantResults.filter(v => v.pAdjusted <= 0.05);

  let analysis = '';
  if (rejected.length === 0) {
    analysis = 'No component removal showed significant impact (all p > 0.05)';
  } else {
    // Find variant with most negative impact (lowest t)
    const worstImpact = rejected.reduce((worst, current) =>
      current.tObserved < worst.tObserved ? current : worst
    );
    analysis = `${worstImpact.name} showed significant degradation (t=${worstImpact.tObserved.toFixed(2)}, p=${worstImpact.pAdjusted.toFixed(3)})`;
  }

  return {
    familyStatistic: 'Max-|T| (absolute)',
    nullDistribution: nullMaxAbsT,
    variants: variantResults.map(v => ({
      name: v.name,
      deltas: v.deltas,
      tObserved: v.tObserved,
      pAdjusted: v.pAdjusted,
      rejected: v.pAdjusted <= 0.05
    })),
    analysis
  };
}
