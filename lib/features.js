/**
 * Feature calculation functions for futures-radar experiments
 * Implements HV20 percentile, ER20, ATR5 percentile, and VEC score
 */

/**
 * Calculate HV20 percentile from 110 prices
 * @param {number[]} prices - Array of 110 closing prices
 * @returns {{hv90d: number[], hvCurrent: number, percentile: number}}
 */
export function calculateHV20Percentile(prices) {
  if (prices.length !== 110) {
    throw new Error(`calculateHV20Percentile requires 110 prices, got ${prices.length}`);
  }

  // Calculate HV20 for a 21-price window
  function calculateHV20(window) {
    if (window.length !== 21) {
      throw new Error(`HV20 window must be 21 prices, got ${window.length}`);
    }

    // Calculate 20 log returns
    const returns = [];
    for (let i = 1; i < 21; i++) {
      returns.push(Math.log(window[i] / window[i - 1]));
    }

    // Population variance (divide by n, not n-1)
    const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;
    const std = Math.sqrt(variance);

    // Annualize with sqrt(252)
    return std * Math.sqrt(252);
  }

  // Generate 90 rolling HV20 windows
  const hv90d = [];
  for (let i = 0; i < 90; i++) {
    const window = prices.slice(i, i + 21);
    hv90d.push(calculateHV20(window));
  }

  // Current HV20 is the last window (prices[89:110])
  const currentWindow = prices.slice(89, 110);
  const hvCurrent = calculateHV20(currentWindow);

  // Calculate percentile using <= comparison
  const countLE = hv90d.filter(hv => hv <= hvCurrent).length;
  const percentile = (countLE / 90) * 100;

  return { hv90d, hvCurrent, percentile };
}

/**
 * Calculate Efficiency Ratio (ER20) from 21 prices
 * @param {number[]} prices - Array of 21 closing prices
 * @returns {number} ER20 value between 0 and 1
 */
export function calculateER20(prices) {
  if (prices.length !== 21) {
    throw new Error(`calculateER20 requires 21 prices, got ${prices.length}`);
  }

  // Net change: abs(close[T] - close[T-20])
  const net = Math.abs(prices[20] - prices[0]);

  // Sum of 20 daily changes
  let sumChanges = 0;
  for (let i = 1; i < 21; i++) {
    sumChanges += Math.abs(prices[i] - prices[i - 1]);
  }

  // Handle zero daily changes
  if (sumChanges === 0) {
    return 0;
  }

  return net / sumChanges;
}

/**
 * Calculate ATR5 percentile from 95 bars
 * @param {number[]} high - Array of 95 high prices
 * @param {number[]} low - Array of 95 low prices
 * @param {number[]} close - Array of 95 closing prices
 * @returns {{atr90dPct: number[], atr5CurrentPct: number, percentile: number}}
 */
export function calculateATR5Percentile(high, low, close) {
  if (high.length !== 95 || low.length !== 95 || close.length !== 95) {
    throw new Error(`calculateATR5Percentile requires 95 bars, got ${high.length}/${low.length}/${close.length}`);
  }

  // Calculate True Range for a bar
  function calculateTR(h, l, prevClose) {
    return Math.max(
      h - l,
      Math.abs(h - prevClose),
      Math.abs(l - prevClose)
    );
  }

  // Calculate ATR5% for a window ending at endpoint e
  function calculateATR5Pct(endpoint) {
    const trs = [];
    for (let i = endpoint - 4; i <= endpoint; i++) {
      const prevClose = i > 0 ? close[i - 1] : close[0];
      trs.push(calculateTR(high[i], low[i], prevClose));
    }
    const atr5 = trs.reduce((sum, tr) => sum + tr, 0) / 5;
    return (atr5 / close[endpoint]) * 100;
  }

  // Generate 90 rolling ATR5% windows (endpoints 5..94)
  const atr90dPct = [];
  for (let e = 5; e < 95; e++) {
    atr90dPct.push(calculateATR5Pct(e));
  }

  // Current ATR5% is endpoint 94 (bars 90..94)
  const atr5CurrentPct = calculateATR5Pct(94);

  // Calculate percentile using <= comparison
  const countLE = atr90dPct.filter(atr => atr <= atr5CurrentPct).length;
  const percentile = (countLE / 90) * 100;

  return { atr90dPct, atr5CurrentPct, percentile };
}

/**
 * Calculate VEC score (Volatility-Efficiency Composite)
 * @param {number[]} prices - Array of 110 closing prices (for HV20 percentile)
 * @returns {number} VEC score (HV percentile * ER20)
 */
export function calculateVEC(prices) {
  if (prices.length !== 110) {
    throw new Error(`calculateVEC requires 110 prices, got ${prices.length}`);
  }

  const { percentile } = calculateHV20Percentile(prices);

  // Use last 21 prices for ER20
  const last21 = prices.slice(-21);
  const er20 = calculateER20(last21);

  return percentile * er20;
}

/**
 * Calculate EMA20 slope via 5-point OLS regression
 * @param {number[]} emaValues - Array of 5 consecutive EMA20 values
 * @returns {number} Slope in %/day
 */
export function calculateEMA20Slope(emaValues) {
  if (emaValues.length !== 5) {
    throw new Error(`calculateEMA20Slope requires 5 EMA values, got ${emaValues.length}`);
  }

  // OLS linear regression: y = a + bx
  // x = [0, 1, 2, 3, 4] (days)
  // y = emaValues
  const x = [0, 1, 2, 3, 4];
  const y = emaValues;

  const meanX = 2.0; // (0+1+2+3+4)/5
  const meanY = y.reduce((sum, val) => sum + val, 0) / 5;

  // Calculate slope: b = sum((x-meanX)*(y-meanY)) / sum((x-meanX)^2)
  let numerator = 0;
  let denominator = 0;

  for (let i = 0; i < 5; i++) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    numerator += dx * dy;
    denominator += dx * dx;
  }

  // Handle flat EMA (all values equal)
  if (denominator === 0) {
    return 0;
  }

  const rawSlope = numerator / denominator;

  // Normalize to %/day: (slope / lastEMA) * 100
  // This matches baseline implementation in momentum-ema20-parameterized.cjs:42-43
  const lastEMA = emaValues[4]; // Last (most recent) EMA value
  const slopePctPerDay = (rawSlope / lastEMA) * 100;

  return slopePctPerDay;
}
