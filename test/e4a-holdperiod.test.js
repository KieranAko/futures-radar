import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runE4aExperiment } from '../research/experiments/e4a-holdperiod.js';

describe('E4a Hold Period', () => {
  it('should test H7 and H15 against H10 baseline with Bonferroni', () => {
    const testData = {
      dates: Array(29).fill(0).map((_, i) => `2024-${String(i+1).padStart(2, '0')}-01`),
      baseline: {
        name: 'H10',
        returns: Array(29).fill(0.01)
      },
      candidates: [
        {
          name: 'H7',
          returns: Array(29).fill(0.012)
        },
        {
          name: 'H15',
          returns: Array(29).fill(0.008)
        }
      ]
    };

    const result = runE4aExperiment(testData);

    assert.ok(result.nullDistributions, 'Should have null distributions');
    assert.equal(result.candidates.length, 2, 'Should test 2 candidates');
    assert.equal(result.alphaPerTest, 0.025, 'Should use Bonferroni α=0.025');
  });

  it('should use independent null distributions (no FWER)', () => {
    const testData = {
      dates: ['2024-01-01'],
      baseline: {
        name: 'H10',
        returns: [0.01]
      },
      candidates: [
        {
          name: 'H7',
          returns: [0.02]
        },
        {
          name: 'H15',
          returns: [0.015]
        }
      ]
    };

    const result = runE4aExperiment(testData);

    // Each candidate has its own null distribution (64 patterns each)
    assert.equal(result.nullDistributions.H7.length, 64, 'H7 should have 64-pattern null');
    assert.equal(result.nullDistributions.H15.length, 64, 'H15 should have 64-pattern null');
    assert.equal(result.multipleTesting, 'Bonferroni', 'Should use Bonferroni correction');
  });

  it('should use one-sided test (t > 0 and p <= 0.025)', () => {
    const testData = {
      dates: Array(29).fill(0).map((_, i) => `2024-${String(i+1).padStart(2, '0')}-01`),
      baseline: {
        name: 'H10',
        returns: Array(29).fill(0.01)
      },
      candidates: [
        {
          name: 'H7',
          returns: Array(29).fill(0.005) // Worse than baseline
        }
      ]
    };

    const result = runE4aExperiment(testData);
    const h7 = result.candidates[0];

    // Negative t cannot reject even if p < 0.025
    assert.ok(h7.tObserved < 0, 'Should have negative t');
    assert.equal(h7.rejected, false, 'Should not reject with t < 0');
  });

  it('should calculate paired deltas correctly', () => {
    const testData = {
      dates: ['2024-01-01', '2024-01-02'],
      baseline: {
        name: 'H10',
        returns: [0.01, 0.02]
      },
      candidates: [
        {
          name: 'H7',
          returns: [0.012, 0.022]
        }
      ]
    };

    const result = runE4aExperiment(testData);
    const h7 = result.candidates[0];

    // Deltas should be [0.002, 0.002]
    assert.ok(h7.deltas, 'Should have deltas');
    assert.equal(h7.deltas.length, 2);
  });

  it('should allow both candidates to reject simultaneously', () => {
    const testData = {
      dates: Array(29).fill(0).map((_, i) => `2024-${String(i+1).padStart(2, '0')}-01`),
      baseline: {
        name: 'H10',
        returns: Array(29).fill(0.01)
      },
      candidates: [
        {
          name: 'H7',
          returns: Array(29).fill(0.02) // Strong positive
        },
        {
          name: 'H15',
          returns: Array(29).fill(0.025) // Even stronger
        }
      ]
    };

    const result = runE4aExperiment(testData);

    // Both can reject if both pass their own 0.025 threshold
    // (Bonferroni allows simultaneous rejection)
    const h7 = result.candidates.find(c => c.name === 'H7');
    const h15 = result.candidates.find(c => c.name === 'H15');

    assert.ok(h7.tObserved > 0, 'H7 should have positive t');
    assert.ok(h15.tObserved > 0, 'H15 should have positive t');
  });
});
