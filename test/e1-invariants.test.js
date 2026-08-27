import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runE1Experiment } from '../research/experiments/e1-scanner.js';

describe('E1 Input Invariants', () => {
  it('should reject baseline returns length mismatch', () => {
    const testData = {
      dates: Array(29).fill(0).map((_, i) => `2024-${String(i+1).padStart(2, '0')}-01`),
      baseline: { returns: Array(28).fill(0.01) }, // Wrong length
      candidates: [
        { name: 'C1', returns: Array(29).fill(0.012) },
        { name: 'C2', returns: Array(29).fill(0.011) },
        { name: 'C3', returns: Array(29).fill(0.009) },
        { name: 'C4', returns: Array(29).fill(0.013) }
      ]
    };

    assert.throws(() => runE1Experiment(testData), /baseline.returns length.*!= dates length/);
  });

  it('should reject non-finite baseline returns', () => {
    const testData = {
      dates: Array(29).fill(0).map((_, i) => `2024-${String(i+1).padStart(2, '0')}-01`),
      baseline: { returns: [...Array(28).fill(0.01), NaN] },
      candidates: [
        { name: 'C1', returns: Array(29).fill(0.012) },
        { name: 'C2', returns: Array(29).fill(0.011) },
        { name: 'C3', returns: Array(29).fill(0.009) },
        { name: 'C4', returns: Array(29).fill(0.013) }
      ]
    };

    assert.throws(() => runE1Experiment(testData), /baseline.returns contains non-finite/);
  });

  it('should reject candidate returns length mismatch', () => {
    const testData = {
      dates: Array(29).fill(0).map((_, i) => `2024-${String(i+1).padStart(2, '0')}-01`),
      baseline: { returns: Array(29).fill(0.01) },
      candidates: [
        { name: 'C1', returns: Array(29).fill(0.012) },
        { name: 'C2', returns: Array(28).fill(0.011) }, // Wrong length
        { name: 'C3', returns: Array(29).fill(0.009) },
        { name: 'C4', returns: Array(29).fill(0.013) }
      ]
    };

    assert.throws(() => runE1Experiment(testData), /candidate\[1\] C2 returns length.*!= dates length/);
  });

  it('should reject non-finite candidate returns', () => {
    const testData = {
      dates: Array(29).fill(0).map((_, i) => `2024-${String(i+1).padStart(2, '0')}-01`),
      baseline: { returns: Array(29).fill(0.01) },
      candidates: [
        { name: 'C1', returns: Array(29).fill(0.012) },
        { name: 'C2', returns: Array(29).fill(0.011) },
        { name: 'C3', returns: [...Array(28).fill(0.009), Infinity] },
        { name: 'C4', returns: Array(29).fill(0.013) }
      ]
    };

    assert.throws(() => runE1Experiment(testData), /candidate\[2\] C3 returns contains non-finite/);
  });
});
