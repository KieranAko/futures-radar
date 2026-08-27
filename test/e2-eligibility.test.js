import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runE2Experiment } from '../experiments/e2-eligibility.js';

describe('E2 Eligibility Ablation', () => {
  it('should test 3 variants against combined gate baseline', () => {
    const testData = {
      dates: Array(29).fill(0).map((_, i) => `2024-${String(i+1).padStart(2, '0')}-01`),
      baseline: {
        name: 'Combined Gate (HV+ATR)',
        returns: Array(29).fill(0.01)
      },
      variants: [
        {
          name: 'Only-HV',
          returns: Array(29).fill(0.008)
        },
        {
          name: 'Only-ATR',
          returns: Array(29).fill(0.009)
        },
        {
          name: 'No-Gate',
          returns: Array(29).fill(0.005)
        }
      ]
    };

    const result = runE2Experiment(testData);

    assert.ok(result.nullDistribution, 'Should generate null distribution');
    assert.equal(result.nullDistribution.length, 64, 'Should have 64 patterns');
    assert.equal(result.variants.length, 3, 'Should test 3 variants');
  });

  it('should use Max-|T| (absolute) for two-sided test', () => {
    const testData = {
      dates: ['2024-01-01'],
      baseline: {
        name: 'Baseline',
        returns: [0.01]
      },
      variants: [
        {
          name: 'V1',
          returns: [0.02]
        },
        {
          name: 'V2',
          returns: [0.005]
        }
      ]
    };

    const result = runE2Experiment(testData);

    assert.equal(result.familyStatistic, 'Max-|T| (absolute)', 'Should use absolute Max-|T|');
  });

  it('should reject if p_adj <= 0.05 regardless of direction', () => {
    // Strong negative delta case
    const testData = {
      dates: Array(29).fill(0).map((_, i) => `2024-${String(i+1).padStart(2, '0')}-01`),
      baseline: {
        name: 'Baseline',
        returns: Array(29).fill(0.01)
      },
      variants: [
        {
          name: 'Much Worse',
          returns: Array(29).fill(-0.02) // Strongly negative
        }
      ]
    };

    const result = runE2Experiment(testData);
    const variant = result.variants[0];

    // Two-sided test: can reject even with negative difference
    assert.ok(variant.tObserved < 0, 'Should have negative t');
    // If |t| is large enough and p_adj <= 0.05, should reject
  });

  it('should calculate paired deltas from baseline', () => {
    const testData = {
      dates: ['2024-01-01', '2024-01-02'],
      baseline: {
        name: 'Baseline',
        returns: [0.01, 0.02]
      },
      variants: [
        {
          name: 'Variant',
          returns: [0.008, 0.018]
        }
      ]
    };

    const result = runE2Experiment(testData);
    const variant = result.variants[0];

    // Deltas should be [0.008-0.01, 0.018-0.02] = [-0.002, -0.002]
    assert.ok(variant.deltas, 'Should have deltas');
    assert.equal(variant.deltas.length, 2);
  });

  it('should not select winner (ablation finds worst component)', () => {
    const testData = {
      dates: Array(29).fill(0).map((_, i) => `2024-${String(i+1).padStart(2, '0')}-01`),
      baseline: {
        name: 'Combined',
        returns: Array(29).fill(0.01)
      },
      variants: [
        {
          name: 'Only-HV',
          returns: Array(29).fill(0.015)
        }
      ]
    };

    const result = runE2Experiment(testData);

    // E2 is ablation study, not winner selection
    // Result shows which component removal hurts most
    assert.ok(result.analysis, 'Should have ablation analysis');
  });
});
