/**
 * Direction Features D0-D3 — Cumulative Confirmation Layers
 *
 * Spec (缅因猫 2026-08-13):
 * - Opportunity cohort is fixed by ER threshold; direction features NEVER
 *   participate in candidate selection.
 * - D0: EMA20 5-point OLS slope, |slope| >= 0.3 %/day -> long/short, else uncertain
 * - D1: D0 + prior-20 Donchian structure confirm (strictly excludes bar T)
 * - D2: D1 + volume activity confirm: avg(vol[T-4..T]) / avg(vol[T-19..T]) >= 1.0
 * - D3: D2 + open interest confirm: avg(OI[T-4..T]) / avg(OI[T-19..T]) >= 1.0
 * - Unconfirmed signals are 'uncertain'. No default bearish, no forced long/short.
 * - All inputs are truncated to bar T (inclusive). Functions validate their own
 *   window requirements and return 'uncertain'/false when data is insufficient.
 */

/**
 * EMA20 5-point OLS regression slope, normalized to %/day
 * @param {number[]} close - Close prices truncated to T (inclusive)
 * @param {number} period - EMA period (20)
 * @param {number} slopeDays - Number of EMA points for regression (5)
 * @returns {number|null} slope in %/day, or null if insufficient data
 */
export function calculateEMASlopePct(close, period = 20, slopeDays = 5) {
  if (!Array.isArray(close) || close.length < period + slopeDays) return null;
  if (!close.every(v => Number.isFinite(v))) return null;

  const emaValues = [];
  const k = 2 / (period + 1);

  for (let i = period - 1; i < close.length; i++) {
    let ema = close[0];
    for (let j = 1; j <= i; j++) {
      ema = close[j] * k + ema * (1 - k);
    }
    emaValues.push(ema);
  }

  const recentEMA = emaValues.slice(-slopeDays);
  const n = recentEMA.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;

  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += recentEMA[i];
    sumXY += i * recentEMA[i];
    sumX2 += i * i;
  }

  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return null;

  const slope = (n * sumXY - sumX * sumY) / denom;
  const lastEMA = recentEMA[n - 1];
  if (!Number.isFinite(lastEMA) || lastEMA === 0) return null;

  return (slope / lastEMA) * 100;
}

/**
 * D0: EMA20 slope direction
 * @param {number[]} close - Close prices truncated to T
 * @param {number} slopeThreshold - %/day threshold (0.3)
 * @returns {'long'|'short'|'uncertain'}
 */
export function determineD0Direction(close, slopeThreshold = 0.3) {
  const slope = calculateEMASlopePct(close);
  if (slope === null) return 'uncertain';
  if (slope >= slopeThreshold) return 'long';
  if (slope <= -slopeThreshold) return 'short';
  return 'uncertain';
}

/**
 * D1: Prior-20 Donchian structure confirmation (strictly excludes bar T)
 * @param {number[]} high - High prices truncated to T
 * @param {number[]} low - Low prices truncated to T
 * @param {number[]} close - Close prices truncated to T
 * @returns {'long'|'short'|'uncertain'} Donchian structure verdict
 */
export function confirmD1Donchian(high, low, close) {
  if (!Array.isArray(high) || !Array.isArray(low) || !Array.isArray(close)) return 'uncertain';
  if (high.length < 21 || low.length < 21 || close.length < 21) return 'uncertain';
  if (![...high, ...low, ...close].every(v => Number.isFinite(v))) return 'uncertain';

  const current = close[close.length - 1];
  // Prior 20 bars: T-20 .. T-1 (last 21 bars minus current bar T)
  const priorHigh = high.slice(-21, -1);
  const priorLow = low.slice(-21, -1);

  const maxPriorHigh = Math.max(...priorHigh);
  const minPriorLow = Math.min(...priorLow);

  if (current > maxPriorHigh) return 'long';
  if (current < minPriorLow) return 'short';
  return 'uncertain';
}

/**
 * D2: Volume activity confirmation
 * avg(vol[T-4..T]) / avg(vol[T-19..T]) >= 1.0
 * @param {number[]} volume - Volume truncated to T
 * @returns {boolean} true when volume activity confirms
 */
export function confirmD2VolumeRatio(volume) {
  if (!Array.isArray(volume) || volume.length < 20) return false;
  if (!volume.every(v => Number.isFinite(v))) return false;

  const recent5 = volume.slice(-5);
  const prior20 = volume.slice(-20);

  const sumRecent = recent5.reduce((a, b) => a + b, 0);
  const sumPrior = prior20.reduce((a, b) => a + b, 0);
  if (sumPrior <= 0) return false;

  return (sumRecent / 5) / (sumPrior / 20) >= 1.0;
}

/**
 * D3: Open interest participation confirmation
 * avg(OI[T-4..T]) / avg(OI[T-19..T]) >= 1.0
 * Missing, non-finite or non-positive denominator -> false
 * @param {number[]} oi - Open interest truncated to T
 * @returns {boolean} true when OI participation confirms
 */
export function confirmD3OpenInterestRatio(oi) {
  if (!Array.isArray(oi) || oi.length < 20) return false;
  if (!oi.every(v => Number.isFinite(v))) return false;

  const recent5 = oi.slice(-5);
  const prior20 = oi.slice(-20);

  const sumRecent = recent5.reduce((a, b) => a + b, 0);
  const sumPrior = prior20.reduce((a, b) => a + b, 0);
  if (sumPrior <= 0) return false;

  return (sumRecent / 5) / (sumPrior / 20) >= 1.0;
}

/**
 * D1 layer: D0 + Donchian structure confirmation
 */
export function layerD1Direction(high, low, close, slopeThreshold = 0.3) {
  const d0 = determineD0Direction(close, slopeThreshold);
  if (d0 === 'uncertain') return 'uncertain';
  const donchian = confirmD1Donchian(high, low, close);
  if (donchian !== d0) return 'uncertain';
  return d0;
}

/**
 * D2 layer: D1 + volume confirmation
 */
export function layerD2Direction(high, low, close, volume, slopeThreshold = 0.3) {
  const d1 = layerD1Direction(high, low, close, slopeThreshold);
  if (d1 === 'uncertain') return 'uncertain';
  return confirmD2VolumeRatio(volume) ? d1 : 'uncertain';
}

/**
 * D3 layer: D2 + open interest confirmation
 */
export function layerD3Direction(high, low, close, volume, oi, slopeThreshold = 0.3) {
  const d2 = layerD2Direction(high, low, close, volume, slopeThreshold);
  if (d2 === 'uncertain') return 'uncertain';
  return confirmD3OpenInterestRatio(oi) ? d2 : 'uncertain';
}
