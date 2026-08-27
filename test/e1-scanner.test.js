import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runE1Experiment } from '../research/experiments/e1-scanner.js';

describe('E1 Scanner Experiments', () => {
  it('should test 4 candidates against ATR14 baseline', () => {
    // Mock 29 test dates with paired returns
    const testData = {
      dates: Array(29).fill(0).map((_, i) => `2024-${String(i+1).padStart(2, '0')}-01`),
      baseline: {
        name: 'ATR14% Top10',
        returns: Array(29).fill(0.01) // Baseline mean return = 1%
      },
      candidates: [
        {
          name: 'HV20 Top10',
          returns: Array(29).fill(0.015) // Better than baseline
        },
        {
          name: 'VEC Top10',
          returns: Array(29).fill(0.008) // Worse than baseline
        },
        {
          name: 'ER20 Top10',
          returns: Array(29).fill(0.012) // Slightly better
        },
        {
          name: 'HV20×ER20 Top10',
          returns: Array(29).fill(0.009) // Slightly worse
        }
      ]
    };

    const result = runE1Experiment(testData);

    assert.ok(result.nullDistribution, 'Should generate null distribution');
    assert.equal(result.nullDistribution.length, 64, 'Should have 64 patterns');
    assert.ok(result.candidates, 'Should have candidate results');
    assert.equal(result.candidates.length, 4, 'Should test 4 candidates');
  });

  it('should calculate paired deltas correctly', () => {
    const testData = {
      dates: ['2024-01-01', '2024-01-02'],
      baseline: {
        name: 'Baseline',
        returns: [0.01, 0.02]
      },
      candidates: [
        {
          name: 'Candidate',
          returns: [0.015, 0.025]
        }
      ]
    };

    const result = runE1Experiment(testData);
    const candidate = result.candidates[0];

    // Deltas should be [0.015-0.01, 0.025-0.02] = [0.005, 0.005]
    assert.ok(candidate.deltas, 'Should have deltas');
    assert.equal(candidate.deltas.length, 2);
  });

  it('should reject winner if p_adj > 0.05', () => {
    // Null case: candidate same as baseline
    const testData = {
      dates: Array(29).fill(0).map((_, i) => `2024-${String(i+1).padStart(2, '0')}-01`),
      baseline: {
        name: 'Baseline',
        returns: Array(29).fill(0.01)
      },
      candidates: [
        {
          name: 'Same',
          returns: Array(29).fill(0.01)
        }
      ]
    };

    const result = runE1Experiment(testData);
    const candidate = result.candidates[0];

    assert.ok(candidate.pAdjusted > 0.05, 'Should not reject null when returns are identical');
    assert.equal(result.winner, null, 'Should have no winner');
  });

  it('should use Max-T (signed) for one-sided test', () => {
    const testData = {
      dates: ['2024-01-01'],
      baseline: {
        name: 'Baseline',
        returns: [0.01]
      },
      candidates: [
        {
          name: 'C1',
          returns: [0.02]
        },
        {
          name: 'C2',
          returns: [0.015]
        }
      ]
    };

    const result = runE1Experiment(testData);

    // Null distribution should use signed Max-T, not absolute
    assert.ok(result.familyStatistic === 'Max-T (signed)', 'Should use signed Max-T');
  });

  it('should require positive t and p_adj <= 0.05 for rejection', () => {
    // Negative delta case
    const testData = {
      dates: Array(29).fill(0).map((_, i) => `2024-${String(i+1).padStart(2, '0')}-01`),
      baseline: {
        name: 'Baseline',
        returns: Array(29).fill(0.01)
      },
      candidates: [
        {
          name: 'Worse',
          returns: Array(29).fill(0.005) // Consistently worse
        }
      ]
    };

    const result = runE1Experiment(testData);
    const candidate = result.candidates[0];

    // Even if p_adj < 0.05, cannot reject if t < 0 (worse than baseline)
    assert.ok(candidate.tObserved < 0, 'Should have negative t for worse candidate');
    assert.equal(result.winner, null, 'Should not select winner with negative improvement');
  });
});
