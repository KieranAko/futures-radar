import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateBlockSignFlip, calculateStudentizedT } from '../lib/statistics.js';

describe('Block Sign-Flip', () => {
  it('should generate 64 patterns for 6 blocks', () => {
    const patterns = generateBlockSignFlip(6);

    assert.equal(patterns.length, 64, 'Should generate 2^6 = 64 patterns');
    assert.ok(patterns.every(p => p.length === 6), 'Each pattern should have 6 signs');
    assert.ok(patterns.every(p => p.every(s => s === 1 || s === -1)), 'Signs must be +1 or -1');
  });

  it('should include observed all-plus pattern', () => {
    const patterns = generateBlockSignFlip(6);
    const allPlus = patterns.find(p => p.every(s => s === 1));

    assert.ok(allPlus, 'Should include (+1,+1,+1,+1,+1,+1) pattern');
  });

  it('should include all-minus pattern', () => {
    const patterns = generateBlockSignFlip(6);
    const allMinus = patterns.find(p => p.every(s => s === -1));

    assert.ok(allMinus, 'Should include (-1,-1,-1,-1,-1,-1) pattern');
  });

  it('should have unique patterns', () => {
    const patterns = generateBlockSignFlip(6);
    const uniqueKeys = new Set(patterns.map(p => p.join(',')));

    assert.equal(uniqueKeys.size, 64, 'All 64 patterns should be unique');
  });
});

describe('Studentized T-statistic', () => {
  it('should calculate t-statistic with sample variance', () => {
    const deltas = [1, 2, 3, 4, 5]; // mean=3, n=5
    const t = calculateStudentizedT(deltas);

    // Manual calculation:
    // mean = 3
    // sample variance s^2 = sum((x-mean)^2)/(n-1) = (4+1+0+1+4)/4 = 2.5
    // s = sqrt(2.5) = 1.581
    // SE = s/sqrt(5) = 1.581/2.236 = 0.707
    // t = 3 / 0.707 = 4.243
    assert.ok(Math.abs(t - 4.243) < 0.01, 't should be approximately 4.243');
  });

  it('should use n-1 divisor (sample variance)', () => {
    const deltas = [10, 10, 10, 10, 10]; // constant, but n=5
    const t = calculateStudentizedT(deltas);

    // mean = 10, all deviations = 0
    // sample variance = 0 / (5-1) = 0
    // Zero variance with non-zero mean → +inf
    assert.equal(t, Infinity, 'Constant positive deltas should give t=+inf');
  });

  it('should return 0 for zero mean and zero variance', () => {
    const deltas = [0, 0, 0, 0, 0];
    const t = calculateStudentizedT(deltas);

    assert.equal(t, 0, 'All zeros should give t=0 by convention');
  });

  it('should return +inf for positive mean with zero variance', () => {
    const deltas = [5, 5, 5, 5, 5];
    const t = calculateStudentizedT(deltas);

    assert.equal(t, Infinity, 'Constant positive should give t=+inf');
  });

  it('should return -inf for negative mean with zero variance', () => {
    const deltas = [-5, -5, -5, -5, -5];
    const t = calculateStudentizedT(deltas);

    assert.equal(t, -Infinity, 'Constant negative should give t=-inf');
  });

  it('should handle negative mean', () => {
    const deltas = [-1, -2, -3, -4, -5]; // mean=-3
    const t = calculateStudentizedT(deltas);

    // Symmetric to positive case, expect t ≈ -4.243
    assert.ok(Math.abs(t + 4.243) < 0.01, 't should be approximately -4.243');
  });
});

describe('Paired Delta Application', () => {
  it('should apply block signs to 29-element delta array', () => {
    const deltas = Array(29).fill(1); // All +1
    const blockSigns = [1, -1, 1, -1, 1, -1]; // 6 blocks

    // Block boundaries: [0-4], [5-9], [10-14], [15-19], [20-24], [25-28]
    const permuted = applyBlockSigns(deltas, blockSigns);

    assert.equal(permuted.length, 29);
    // Block 0: signs +1
    assert.ok(permuted.slice(0, 5).every(d => d === 1));
    // Block 1: signs -1
    assert.ok(permuted.slice(5, 10).every(d => d === -1));
    // Block 2: signs +1
    assert.ok(permuted.slice(10, 15).every(d => d === 1));
    // Block 3: signs -1
    assert.ok(permuted.slice(15, 20).every(d => d === -1));
    // Block 4: signs +1
    assert.ok(permuted.slice(20, 25).every(d => d === 1));
    // Block 5 (remainder): signs -1
    assert.ok(permuted.slice(25, 29).every(d => d === -1));
  });
});

// Helper function for test
function applyBlockSigns(deltas, blockSigns) {
  const blockSize = 5;
  const permuted = [];

  for (let blockIdx = 0; blockIdx < blockSigns.length; blockIdx++) {
    const start = blockIdx * blockSize;
    const end = Math.min(start + blockSize, deltas.length);

    for (let i = start; i < end; i++) {
      permuted.push(deltas[i] * blockSigns[blockIdx]);
    }
  }

  return permuted;
}
