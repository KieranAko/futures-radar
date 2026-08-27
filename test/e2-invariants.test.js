import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runE2Experiment } from '../experiments/e2-eligibility.js';

describe('E2 Input Invariants', () => {
  it('should reject baseline returns length mismatch', () => {
    const testData = {
      dates: Array(29).fill(0).map((_, i) => `2024-${String(i+1).padStart(2, '0')}-01`),
      baseline: { returns: Array(30).fill(0.01) },
      variants: [
        { name: 'V1', returns: Array(29).fill(0.009) },
        { name: 'V2', returns: Array(29).fill(0.011) },
        { name: 'V3', returns: Array(29).fill(0.010) }
      ]
    };

    assert.throws(() => runE2Experiment(testData), /baseline.returns length.*!= dates length/);
  });

  it('should reject non-finite baseline returns', () => {
    const testData = {
      dates: Array(29).fill(0).map((_, i) => `2024-${String(i+1).padStart(2, '0')}-01`),
      baseline: { returns: [...Array(28).fill(0.01), -Infinity] },
      variants: [
        { name: 'V1', returns: Array(29).fill(0.009) },
        { name: 'V2', returns: Array(29).fill(0.011) },
        { name: 'V3', returns: Array(29).fill(0.010) }
      ]
    };

    assert.throws(() => runE2Experiment(testData), /baseline.returns contains non-finite/);
  });

  it('should reject variant returns length mismatch', () => {
    const testData = {
      dates: Array(29).fill(0).map((_, i) => `2024-${String(i+1).padStart(2, '0')}-01`),
      baseline: { returns: Array(29).fill(0.01) },
      variants: [
        { name: 'V1', returns: Array(29).fill(0.009) },
        { name: 'V2', returns: Array(27).fill(0.011) },
        { name: 'V3', returns: Array(29).fill(0.010) }
      ]
    };

    assert.throws(() => runE2Experiment(testData), /variant\[1\] V2 returns length.*!= dates length/);
  });

  it('should reject non-finite variant returns', () => {
    const testData = {
      dates: Array(29).fill(0).map((_, i) => `2024-${String(i+1).padStart(2, '0')}-01`),
      baseline: { returns: Array(29).fill(0.01) },
      variants: [
        { name: 'V1', returns: Array(29).fill(0.009) },
        { name: 'V2', returns: Array(29).fill(0.011) },
        { name: 'V3', returns: [...Array(28).fill(0.010), NaN] }
      ]
    };

    assert.throws(() => runE2Experiment(testData), /variant\[2\] V3 returns contains non-finite/);
  });
});
