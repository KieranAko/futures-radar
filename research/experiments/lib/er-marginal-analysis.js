/**
 * ER Marginal Analysis - Shared Logic
 *
 * Compare adjacent ER thresholds to identify marginal benefit.
 */

/**
 * Compare two adjacent thresholds and identify removed/added samples
 *
 * @param {Object} lowerResult - Result from lower threshold with candidates array
 * @param {Object} higherResult - Result from higher threshold with candidates array
 * @returns {Object} Comparison metrics
 * @throws {Error} If duplicate date:symbol keys found
 */
export function compareAdjacentThresholds(lowerResult, higherResult) {
  // Build key sets for membership testing
  const lowerKeys = lowerResult.candidates.map(c => `${c.date}:${c.symbol}`);
  const higherKeys = higherResult.candidates.map(c => `${c.date}:${c.symbol}`);

  // Detect duplicate keys (should not happen in valid data)
  const lowerDupes = lowerKeys.filter((k, i) => lowerKeys.indexOf(k) !== i);
  const higherDupes = higherKeys.filter((k, i) => higherKeys.indexOf(k) !== i);

  if (lowerDupes.length > 0 || higherDupes.length > 0) {
    throw new Error(
      `Duplicate date:symbol keys found: ${[...new Set([...lowerDupes, ...higherDupes])].join(', ')}`
    );
  }

  const lowerSymbols = new Set(lowerKeys);
  const higherSymbols = new Set(higherKeys);

  // Samples removed when going from lower to higher threshold
  const removedSamples = lowerResult.candidates.filter(c => {
    const key = `${c.date}:${c.symbol}`;
    return !higherSymbols.has(key);
  });

  // Samples added when going from lower to higher threshold (should be empty if strictly nested)
  const addedSamples = higherResult.candidates.filter(c => {
    const key = `${c.date}:${c.symbol}`;
    return !lowerSymbols.has(key);
  });

  const removedHits = removedSamples.filter(c => c.isHit).length;
  const removedMisses = removedSamples.filter(c => !c.isHit).length;
  const removedHitRate = removedSamples.length > 0
    ? removedHits / removedSamples.length
    : null;

  const marginalBenefit = removedHits > 0 ? removedMisses / removedHits : null;

  return {
    removedSamples,
    addedSamples,
    removedHits,
    removedMisses,
    removedHitRate,
    marginalBenefit,
  };
}
