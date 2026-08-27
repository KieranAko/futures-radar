import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runE3Experiment } from '../experiments/e3-direction.js';

describe('E3 Input Invariants', () => {
  it('should reject baseline returns length mismatch', () => {
    const testData = {
      dates: Array(29).fill(0).map((_, i) => `2024-${String(i+1).padStart(2, '0')}-01`),
      baseline: { returns: Array(28).fill(0.01), neutralCount: Array(29).fill(1) },
      candidates: [
        { name: 'C1', returns: Array(29).fill(0.012), neutralCount: Array(29).fill(2) },
        { name: 'C2', returns: Array(29).fill(0.011), neutralCount: Array(29).fill(1) }
      ],
      controls: [
        { name: 'Ctrl1', returns: Array(29).fill(0.005), neutralCount: Array(29).fill(0) },
        { name: 'Ctrl2', returns: Array(29).fill(-0.003), neutralCount: Array(29).fill(0) },
        { name: 'Ctrl3', returns: Array(29).fill(0.002), neutralCount: Array(29).fill(0) }
      ]
    };

    assert.throws(() => runE3Experiment(testData, 10), /baseline.returns length.*!= dates length/);
  });

  it('should reject baseline neutralCount length mismatch', () => {
    const testData = {
      dates: Array(29).fill(0).map((_, i) => `2024-${String(i+1).padStart(2, '0')}-01`),
      baseline: { returns: Array(29).fill(0.01), neutralCount: Array(30).fill(1) },
      candidates: [
        { name: 'C1', returns: Array(29).fill(0.012), neutralCount: Array(29).fill(2) },
        { name: 'C2', returns: Array(29).fill(0.011), neutralCount: Array(29).fill(1) }
      ],
      controls: [
        { name: 'Ctrl1', returns: Array(29).fill(0.005), neutralCount: Array(29).fill(0) },
        { name: 'Ctrl2', returns: Array(29).fill(-0.003), neutralCount: Array(29).fill(0) },
        { name: 'Ctrl3', returns: Array(29).fill(0.002), neutralCount: Array(29).fill(0) }
      ]
    };

    assert.throws(() => runE3Experiment(testData, 10), /baseline.neutralCount length.*!= dates length/);
  });

  it('should reject non-finite baseline returns', () => {
    const testData = {
      dates: Array(29).fill(0).map((_, i) => `2024-${String(i+1).padStart(2, '0')}-01`),
      baseline: { returns: [...Array(28).fill(0.01), NaN], neutralCount: Array(29).fill(1) },
      candidates: [
        { name: 'C1', returns: Array(29).fill(0.012), neutralCount: Array(29).fill(2) },
        { name: 'C2', returns: Array(29).fill(0.011), neutralCount: Array(29).fill(1) }
      ],
      controls: [
        { name: 'Ctrl1', returns: Array(29).fill(0.005), neutralCount: Array(29).fill(0) },
        { name: 'Ctrl2', returns: Array(29).fill(-0.003), neutralCount: Array(29).fill(0) },
        { name: 'Ctrl3', returns: Array(29).fill(0.002), neutralCount: Array(29).fill(0) }
      ]
    };

    assert.throws(() => runE3Experiment(testData, 10), /baseline.returns contains non-finite/);
  });

  it('should reject invalid baseline neutralCount', () => {
    const testData = {
      dates: Array(29).fill(0).map((_, i) => `2024-${String(i+1).padStart(2, '0')}-01`),
      baseline: { returns: Array(29).fill(0.01), neutralCount: [...Array(28).fill(1), -1] },
      candidates: [
        { name: 'C1', returns: Array(29).fill(0.012), neutralCount: Array(29).fill(2) },
        { name: 'C2', returns: Array(29).fill(0.011), neutralCount: Array(29).fill(1) }
      ],
      controls: [
        { name: 'Ctrl1', returns: Array(29).fill(0.005), neutralCount: Array(29).fill(0) },
        { name: 'Ctrl2', returns: Array(29).fill(-0.003), neutralCount: Array(29).fill(0) },
        { name: 'Ctrl3', returns: Array(29).fill(0.002), neutralCount: Array(29).fill(0) }
      ]
    };

    assert.throws(() => runE3Experiment(testData, 10), /baseline.neutralCount contains invalid values/);
  });

  it('should reject candidate returns length mismatch', () => {
    const testData = {
      dates: Array(29).fill(0).map((_, i) => `2024-${String(i+1).padStart(2, '0')}-01`),
      baseline: { returns: Array(29).fill(0.01), neutralCount: Array(29).fill(1) },
      candidates: [
        { name: 'C1', returns: Array(29).fill(0.012), neutralCount: Array(29).fill(2) },
        { name: 'C2', returns: Array(25).fill(0.011), neutralCount: Array(29).fill(1) }
      ],
      controls: [
        { name: 'Ctrl1', returns: Array(29).fill(0.005), neutralCount: Array(29).fill(0) },
        { name: 'Ctrl2', returns: Array(29).fill(-0.003), neutralCount: Array(29).fill(0) },
        { name: 'Ctrl3', returns: Array(29).fill(0.002), neutralCount: Array(29).fill(0) }
      ]
    };

    assert.throws(() => runE3Experiment(testData, 10), /candidate\[1\] C2 returns length.*!= dates length/);
  });

  it('should reject control neutralCount with non-integers', () => {
    const testData = {
      dates: Array(29).fill(0).map((_, i) => `2024-${String(i+1).padStart(2, '0')}-01`),
      baseline: { returns: Array(29).fill(0.01), neutralCount: Array(29).fill(1) },
      candidates: [
        { name: 'C1', returns: Array(29).fill(0.012), neutralCount: Array(29).fill(2) },
        { name: 'C2', returns: Array(29).fill(0.011), neutralCount: Array(29).fill(1) }
      ],
      controls: [
        { name: 'Ctrl1', returns: Array(29).fill(0.005), neutralCount: Array(29).fill(0) },
        { name: 'Ctrl2', returns: Array(29).fill(-0.003), neutralCount: Array(29).fill(0) },
        { name: 'Ctrl3', returns: Array(29).fill(0.002), neutralCount: [...Array(28).fill(0), 2.5] }
      ]
    };

    assert.throws(() => runE3Experiment(testData, 10), /control\[2\] Ctrl3 neutralCount contains invalid values/);
  });
});
