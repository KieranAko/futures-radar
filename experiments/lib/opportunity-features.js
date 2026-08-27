/**
 * Opportunity Feature Calculators
 *
 * Direction-agnostic features for opportunity identification:
 * - Efficiency Ratio (ER20): Trend efficiency vs noise
 * - ADX: Trend strength (directionless)
 * - HV ratio bounds: Avoid overheated volatility
 */

/**
 * Calculate Efficiency Ratio (ER)
 * ER = Net price change / Sum of absolute bar changes
 * High ER (>0.3) = persistent trend; Low ER (<0.2) = choppy range
 *
 * @param {Array<number>} close - Close prices
 * @param {number} period - Lookback period (default 20)
 * @returns {number|null} ER value (0-1)
 */
export function calculateER(close, period = 20) {
  if (close.length < period + 1) return null;

  const recentClose = close.slice(-period - 1);
  const netChange = Math.abs(recentClose[period] - recentClose[0]);

  let sumAbsChanges = 0;
  for (let i = 1; i <= period; i++) {
    sumAbsChanges += Math.abs(recentClose[i] - recentClose[i - 1]);
  }

  // Match production calculateER20: return 0 for flat prices (not null)
  if (sumAbsChanges === 0) return 0;
  return netChange / sumAbsChanges;
}

/**
 * Calculate Average Directional Index (ADX)
 * Measures trend strength without indicating direction
 *
 * @param {Array<number>} high - High prices
 * @param {Array<number>} low - Low prices
 * @param {Array<number>} close - Close prices
 * @param {number} period - Lookback period (default 14)
 * @returns {number|null} ADX value (0-100)
 */
export function calculateADX(high, low, close, period = 14) {
  if (high.length < period + 1 || low.length < period + 1 || close.length < period + 1) {
    return null;
  }

  // Step 1: Calculate True Range (TR)
  const tr = [];
  for (let i = 1; i < close.length; i++) {
    const hl = high[i] - low[i];
    const hc = Math.abs(high[i] - close[i - 1]);
    const lc = Math.abs(low[i] - close[i - 1]);
    tr.push(Math.max(hl, hc, lc));
  }

  // Step 2: Calculate +DM and -DM
  const plusDM = [];
  const minusDM = [];
  for (let i = 1; i < high.length; i++) {
    const upMove = high[i] - high[i - 1];
    const downMove = low[i - 1] - low[i];

    if (upMove > downMove && upMove > 0) {
      plusDM.push(upMove);
      minusDM.push(0);
    } else if (downMove > upMove && downMove > 0) {
      plusDM.push(0);
      minusDM.push(downMove);
    } else {
      plusDM.push(0);
      minusDM.push(0);
    }
  }

  // Step 3: Smooth TR, +DM, -DM with EMA
  const smoothTR = [];
  const smoothPlusDM = [];
  const smoothMinusDM = [];

  let trSum = tr.slice(0, period).reduce((a, b) => a + b, 0);
  let plusDMSum = plusDM.slice(0, period).reduce((a, b) => a + b, 0);
  let minusDMSum = minusDM.slice(0, period).reduce((a, b) => a + b, 0);

  smoothTR.push(trSum);
  smoothPlusDM.push(plusDMSum);
  smoothMinusDM.push(minusDMSum);

  for (let i = period; i < tr.length; i++) {
    trSum = trSum - (trSum / period) + tr[i];
    plusDMSum = plusDMSum - (plusDMSum / period) + plusDM[i];
    minusDMSum = minusDMSum - (minusDMSum / period) + minusDM[i];

    smoothTR.push(trSum);
    smoothPlusDM.push(plusDMSum);
    smoothMinusDM.push(minusDMSum);
  }

  // Step 4: Calculate +DI and -DI
  const plusDI = smoothPlusDM.map((dm, i) => (smoothTR[i] > 0 ? (dm / smoothTR[i]) * 100 : 0));
  const minusDI = smoothMinusDM.map((dm, i) => (smoothTR[i] > 0 ? (dm / smoothTR[i]) * 100 : 0));

  // Step 5: Calculate DX
  const dx = [];
  for (let i = 0; i < plusDI.length; i++) {
    const diSum = plusDI[i] + minusDI[i];
    if (diSum === 0) {
      dx.push(0);
    } else {
      dx.push((Math.abs(plusDI[i] - minusDI[i]) / diSum) * 100);
    }
  }

  // Step 6: Calculate ADX (Wilder smoothing, NOT EMA)
  if (dx.length < period) return null;

  let adx = dx.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dx.length; i++) {
    // Wilder smoothing: ((prior * (period - 1)) + current) / period
    adx = ((adx * (period - 1)) + dx[i]) / period;
  }

  return adx;
}

/**
 * Check if HV ratio is within healthy bounds
 * - Too high (>1.5): Volatility spike, likely late-stage
 * - Too low (<1.0): No expansion
 *
 * @param {number} hv5 - 5-day historical volatility
 * @param {number} hv20 - 20-day historical volatility
 * @param {number} minRatio - Minimum HV5/HV20 ratio (default 1.0)
 * @param {number} maxRatio - Maximum HV5/HV20 ratio (default 1.5)
 * @returns {boolean} True if within bounds
 */
export function isHVRatioHealthy(hv5, hv20, minRatio = 1.0, maxRatio = 1.5) {
  if (hv20 <= 0) return false;
  const ratio = hv5 / hv20;
  return ratio >= minRatio && ratio <= maxRatio;
}
