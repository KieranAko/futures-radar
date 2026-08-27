/**
 * Marginal Analysis Unit Tests
 *
 * Tests compareAdjacentThresholds() logic for edge cases:
 * - Pure removal (strictly nested sets)
 * - Removal + addition (non-nested sets, should warn)
 * - No change
 * - Zero removed hits
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { compareAdjacentThresholds } from '../research/experiments/lib/er-marginal-analysis.js';

describe('Marginal Analysis - compareAdjacentThresholds', () => {
  it('should handle pure removal (strictly nested sets)', () => {
    const lower = {
      candidates: [
        { date: '2025-01-01', symbol: 'A', isHit: true },
        { date: '2025-01-01', symbol: 'B', isHit: false },
        { date: '2025-01-02', symbol: 'C', isHit: true },
      ]
    };

    const higher = {
      candidates: [
        { date: '2025-01-01', symbol: 'A', isHit: true },
      ]
    };

    const result = compareAdjacentThresholds(lower, higher);

    assert.strictEqual(result.removedSamples.length, 2, 'Should remove 2 samples');
    assert.strictEqual(result.addedSamples.length, 0, 'Should add 0 samples (strictly nested)');
    assert.strictEqual(result.removedHits, 1, 'Should remove 1 hit');
    assert.strictEqual(result.removedMisses, 1, 'Should remove 1 miss');
    assert.strictEqual(result.marginalBenefit, 1.0, 'Miss/Hit ratio should be 1.0');
  });

  it('should detect non-nested sets (removal + addition)', () => {
    const lower = {
      candidates: [
        { date: '2025-01-01', symbol: 'A', isHit: true },
        { date: '2025-01-01', symbol: 'B', isHit: false },
      ]
    };

    const higher = {
      candidates: [
        { date: '2025-01-01', symbol: 'A', isHit: true },
        { date: '2025-01-02', symbol: 'C', isHit: true }, // New sample (non-nested)
      ]
    };

    const result = compareAdjacentThresholds(lower, higher);

    assert.strictEqual(result.removedSamples.length, 1, 'Should remove 1 sample');
    assert.strictEqual(result.addedSamples.length, 1, 'Should add 1 sample (NON-NESTED WARNING)');
  });

  it('should handle no change (identical sets)', () => {
    const lower = {
      candidates: [
        { date: '2025-01-01', symbol: 'A', isHit: true },
      ]
    };

    const higher = {
      candidates: [
        { date: '2025-01-01', symbol: 'A', isHit: true },
      ]
    };

    const result = compareAdjacentThresholds(lower, higher);

    assert.strictEqual(result.removedSamples.length, 0, 'Should remove 0 samples');
    assert.strictEqual(result.addedSamples.length, 0, 'Should add 0 samples');
    assert.strictEqual(result.marginalBenefit, null, 'Marginal benefit should be null (no change)');
  });

  it('should handle zero removed hits (only misses removed)', () => {
    const lower = {
      candidates: [
        { date: '2025-01-01', symbol: 'A', isHit: true },
        { date: '2025-01-01', symbol: 'B', isHit: false },
        { date: '2025-01-02', symbol: 'C', isHit: false },
      ]
    };

    const higher = {
      candidates: [
        { date: '2025-01-01', symbol: 'A', isHit: true },
      ]
    };

    const result = compareAdjacentThresholds(lower, higher);

    assert.strictEqual(result.removedSamples.length, 2, 'Should remove 2 samples');
    assert.strictEqual(result.removedHits, 0, 'Should remove 0 hits');
    assert.strictEqual(result.removedMisses, 2, 'Should remove 2 misses');
    assert.strictEqual(result.marginalBenefit, null, 'Marginal benefit should be null (division by zero)');
    assert.strictEqual(result.removedHitRate, 0, 'Removed hit rate should be 0%');
  });

  it('should handle all samples removed', () => {
    const lower = {
      candidates: [
        { date: '2025-01-01', symbol: 'A', isHit: true },
        { date: '2025-01-01', symbol: 'B', isHit: false },
      ]
    };

    const higher = {
      candidates: []
    };

    const result = compareAdjacentThresholds(lower, higher);

    assert.strictEqual(result.removedSamples.length, 2, 'Should remove all 2 samples');
    assert.strictEqual(result.addedSamples.length, 0, 'Should add 0 samples');
    assert.strictEqual(result.removedHits, 1, 'Should remove 1 hit');
    assert.strictEqual(result.removedMisses, 1, 'Should remove 1 miss');
  });

  it('should handle duplicate date:symbol keys correctly', () => {
    const lower = {
      candidates: [
        { date: '2025-01-01', symbol: 'A', isHit: true },
        { date: '2025-01-01', symbol: 'A', isHit: false }, // Duplicate key (shouldn't happen in practice)
      ]
    };

    const higher = {
      candidates: [
        { date: '2025-01-01', symbol: 'A', isHit: true },
      ]
    };

    // Should throw error on duplicate keys
    assert.throws(
      () => compareAdjacentThresholds(lower, higher),
      /Duplicate date:symbol keys found/,
      'Should throw error when duplicate keys detected'
    );
  });
});
