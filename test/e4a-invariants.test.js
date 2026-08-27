import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runE4aExperiment } from '../research/experiments/e4a-holdperiod.js';

describe('E4a Input Invariants', () => {
  it('should reject baseline returns length mismatch', () => {
    const testData = {
      dates: Array(29).fill(0).map((_, i) => `2024-${String(i+1).padStart(2, '0')}-01`),
      baseline: { returns: Array(27).fill(0.01) },
      candidates: [
        { name: 'H7', returns: Array(29).fill(0.009) },
        { name: 'H15', returns: Array(29).fill(0.011) }
      ]
    };

    assert.throws(() => runE4aExperiment(testData), /baseline.returns length.*!= dates length/);
  });

  it('should reject non-finite baseline returns', () => {
    const testData = {
      dates: Array(29).fill(0).map((_, i) => `2024-${String(i+1).padStart(2, '0')}-01`),
      baseline: { returns: [...Array(28).fill(0.01), Infinity] },
      candidates: [
        { name: 'H7', returns: Array(29).fill(0.009) },
        { name: 'H15', returns: Array(29).fill(0.011) }
      ]
    };

    assert.throws(() => runE4aExperiment(testData), /baseline.returns contains non-finite/);
  });

  it('should reject candidate returns length mismatch', () => {
    const testData = {
      dates: Array(29).fill(0).map((_, i) => `2024-${String(i+1).padStart(2, '0')}-01`),
      baseline: { returns: Array(29).fill(0.01) },
      candidates: [
        { name: 'H7', returns: Array(29).fill(0.009) },
        { name: 'H15', returns: Array(26).fill(0.011) }
      ]
    };

    assert.throws(() => runE4aExperiment(testData), /candidate\[1\] H15 returns length.*!= dates length/);
  });

  it('should reject non-finite candidate returns', () => {
    const testData = {
      dates: Array(29).fill(0).map((_, i) => `2024-${String(i+1).padStart(2, '0')}-01`),
      baseline: { returns: Array(29).fill(0.01) },
      candidates: [
        { name: 'H7', returns: [...Array(28).fill(0.009), NaN] },
        { name: 'H15', returns: Array(29).fill(0.011) }
      ]
    };

    assert.throws(() => runE4aExperiment(testData), /candidate\[0\] H7 returns contains non-finite/);
  });
});
