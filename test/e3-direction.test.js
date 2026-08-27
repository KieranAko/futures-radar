import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runE3Experiment } from '../experiments/e3-direction.js';

describe('E3 Direction Policy', () => {
  it('should test 2 candidates + 3 controls with fixed cohort', () => {
    const testData = {
      dates: Array(29).fill(0).map((_, i) => `2024-${String(i+1).padStart(2, '0')}-01`),
      baseline: {
        name: 'EMA20 5-point regression',
        returns: Array(29).fill(0.01),
        neutralCount: Array(29).fill(1) // 1 neutral per date
      },
      candidates: [
        {
          name: 'change5d sign',
          returns: Array(29).fill(0.012),
          neutralCount: Array(29).fill(2)
        },
        {
          name: 'Donchian breakout',
          returns: Array(29).fill(0.008),
          neutralCount: Array(29).fill(3)
        }
      ],
      controls: [
        {
          name: 'always-long',
          returns: Array(29).fill(0.005),
          neutralCount: Array(29).fill(0) // No neutrals
        },
        {
          name: 'always-short',
          returns: Array(29).fill(-0.003),
          neutralCount: Array(29).fill(0)
        },
        {
          name: 'random',
          returns: Array(29).fill(0.002),
          neutralCount: Array(29).fill(0)
        }
      ]
    };

    const result = runE3Experiment(testData);

    assert.ok(result.nullDistribution, 'Should generate null distribution');
    assert.equal(result.candidates.length, 2, 'Should test 2 candidates');
    assert.equal(result.controls.length, 3, 'Should have 3 controls');
  });

  it('should exclude controls from winner selection', () => {
    const testData = {
      dates: Array(29).fill(0).map((_, i) => `2024-${String(i+1).padStart(2, '0')}-01`),
      baseline: {
        name: 'Baseline',
        returns: Array(29).fill(0.01),
        neutralCount: Array(29).fill(1)
      },
      candidates: [
        {
          name: 'Weak Candidate',
          returns: Array(29).fill(0.011), // Barely better
          neutralCount: Array(29).fill(1)
        }
      ],
      controls: [
        {
          name: 'Strong Control',
          returns: Array(29).fill(0.02), // Much better but is control
          neutralCount: Array(29).fill(0)
        }
      ]
    };

    const result = runE3Experiment(testData, 10);

    // Even if control has best t and p < 0.05, it cannot win
    const strongControl = result.controls.find(c => c.name === 'Strong Control');
    assert.ok(strongControl.excluded, 'Control should be excluded from winner selection');
  });

  it('should retain neutral dates in fixed cohort', () => {
    // Cohort size = 10 symbols
    // Some dates have neutrals, but never all 10 symbols neutral
    const testData = {
      dates: ['2024-01-01', '2024-01-02', '2024-01-03'],
      baseline: {
        name: 'Baseline',
        returns: [0.01, 0, 0.015], // 2nd date neutral (return=0)
        neutralCount: [0, 1, 0] // Only 1 symbol neutral on 2nd date
      },
      candidates: [
        {
          name: 'Candidate',
          returns: [0.012, 0, 0.018], // Also neutral on 2nd date
          neutralCount: [0, 2, 0] // Only 2 symbols neutral, not all 10
        }
      ],
      controls: []
    };

    const result = runE3Experiment(testData, 10);

    // Should not have coverage failure (0/3 = 0% all-neutral)
    assert.ok(!result.coverageFailure, 'Should not fail coverage with <20% all-neutral');
    assert.ok(result.candidates, 'Should have candidates results');

    const candidate = result.candidates[0];

    // Deltas should include neutral date: [0.002, 0, 0.003]
    assert.equal(candidate.deltas.length, 3, 'Should retain all dates including neutral');
  });

  it('should fail coverage if >20% dates are all-neutral', () => {
    // Cohort size = 10 symbols
    // All 29 dates (100%) have all candidates marking all 10 symbols as neutral
    const testData = {
      dates: Array(29).fill(0).map((_, i) => `2024-${String(i+1).padStart(2, '0')}-01`),
      baseline: {
        name: 'Baseline',
        returns: Array(29).fill(0),
        neutralCount: Array(29).fill(10) // All neutral every date
      },
      candidates: [
        {
          name: 'Candidate',
          returns: Array(29).fill(0),
          neutralCount: Array(29).fill(10) // All neutral every date
        }
      ],
      controls: []
    };

    const result = runE3Experiment(testData, 10);

    assert.ok(result.coverageFailure, 'Should fail coverage when >20% all-neutral');
    assert.ok(result.coverageFailure.allNeutralRate > 0.20);
    assert.equal(result.coverageFailure.allNeutralDates, 29);
    assert.equal(result.coverageFailure.cohortSize, 10);
  });

  it('should pass coverage when control is all-neutral but candidates are not', () => {
    // Control being all-neutral should NOT trigger coverage failure
    // Only candidates matter for coverage check
    const testData = {
      dates: Array(29).fill(0).map((_, i) => `2024-${String(i+1).padStart(2, '0')}-01`),
      baseline: {
        name: 'Baseline',
        returns: Array(29).fill(0.01),
        neutralCount: Array(29).fill(2)
      },
      candidates: [
        {
          name: 'Candidate 1',
          returns: Array(29).fill(0.012),
          neutralCount: Array(29).fill(3) // Never hits cohort size (10)
        }
      ],
      controls: [
        {
          name: 'Always-Neutral Control',
          returns: Array(29).fill(0),
          neutralCount: Array(29).fill(10) // Always all-neutral
        }
      ]
    };

    const result = runE3Experiment(testData, 10);

    assert.ok(!result.coverageFailure, 'Should pass coverage when only control is all-neutral');
    assert.ok(result.nullDistribution, 'Should generate null distribution');
  });

  it('should use Max-T (signed) for one-sided test', () => {
    const testData = {
      dates: ['2024-01-01'],
      baseline: {
        name: 'Baseline',
        returns: [0.01],
        neutralCount: [0]
      },
      candidates: [
        {
          name: 'C1',
          returns: [0.02],
          neutralCount: [0]
        }
      ],
      controls: []
    };

    const result = runE3Experiment(testData, 10);

    assert.equal(result.familyStatistic, 'Max-T (signed)', 'Should use signed Max-T');
  });
});
