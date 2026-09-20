/**
 * Statistical testing utilities for futures-radar experiments
 * Implements block sign-flip enumeration and studentized t-statistic
 */

/**
 * Generate all 2^B block sign patterns
 * @param {number} numBlocks - Number of blocks (6 for 29 dates)
 * @returns {number[][]} Array of 2^B patterns, each pattern is array of ±1
 */
export function generateBlockSignFlip(numBlocks) {
  const numPatterns = Math.pow(2, numBlocks);
  const patterns = [];

  for (let i = 0; i < numPatterns; i++) {
    const pattern = [];
    for (let b = 0; b < numBlocks; b++) {
      // Extract bit b from pattern number i
      // If bit is 0 → +1, if bit is 1 → -1
      const bit = (i >> b) & 1;
      pattern.push(bit === 0 ? 1 : -1);
    }
    patterns.push(pattern);
  }

  return patterns;
}

/**
 * Calculate studentized t-statistic with sample variance
 * @param {number[]} deltas - Array of paired deltas
 * @returns {number} t-statistic (can be ±Infinity for zero variance cases)
 */
export function calculateStudentizedT(deltas) {
  const n = deltas.length;
  const mean = deltas.reduce((sum, d) => sum + d, 0) / n;

  // Calculate sample variance: s^2 = sum((x-mean)^2) / (n-1)
  const squaredDeviations = deltas.map(d => Math.pow(d - mean, 2));
  const sampleVariance = squaredDeviations.reduce((sum, sq) => sum + sq, 0) / (n - 1);

  // Handle zero variance cases
  if (sampleVariance === 0) {
    if (mean === 0) return 0;
    if (mean > 0) return Infinity;
    if (mean < 0) return -Infinity;
  }

  const s = Math.sqrt(sampleVariance);
  const standardError = s / Math.sqrt(n);

  return mean / standardError;
}

/**
 * Apply block signs to delta array
 * @param {number[]} deltas - Array of 29 paired deltas
 * @param {number[]} blockSigns - Array of 6 block signs (±1)
 * @returns {number[]} Permuted deltas with block signs applied
 */
export function applyBlockSigns(deltas, blockSigns) {
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

/**
 * Calculate Max-T statistic (signed, for one-sided tests E1/E3)
 * @param {number[][]} candidateTStats - Array of t-stats per candidate, per pattern
 * @returns {number[]} Max-T per pattern (length 64)
 */
export function calculateMaxT(candidateTStats) {
  const numPatterns = candidateTStats[0].length; // Should be 64
  const maxTPerPattern = [];

  for (let p = 0; p < numPatterns; p++) {
    const tValues = candidateTStats.map(candidate => candidate[p]);
    maxTPerPattern.push(Math.max(...tValues));
  }

  return maxTPerPattern;
}

/**
 * Calculate Max-|T| statistic (absolute, for two-sided test E2)
 * @param {number[][]} candidateTStats - Array of t-stats per candidate, per pattern
 * @returns {number[]} Max-|T| per pattern (length 64)
 */
export function calculateMaxAbsT(candidateTStats) {
  const numPatterns = candidateTStats[0].length; // Should be 64
  const maxAbsTPerPattern = [];

  for (let p = 0; p < numPatterns; p++) {
    const absTValues = candidateTStats.map(candidate => Math.abs(candidate[p]));
    maxAbsTPerPattern.push(Math.max(...absTValues));
  }

  return maxAbsTPerPattern;
}

/**
 * Calculate adjusted p-value from null distribution
 * @param {number} observedStat - Observed test statistic
 * @param {number[]} nullDistribution - Null distribution (64 values)
 * @returns {number} Adjusted p-value (exact count/64)
 */
export function calculateAdjustedPValue(observedStat, nullDistribution) {
  const count = nullDistribution.filter(stat => stat >= observedStat).length;
  return count / 64;
}
