/**
 * Historical Volatility Estimators for Futures-Radar
 *
 * Implements three volatility estimators with automatic fallback:
 * 1. Yang-Zhang (primary) - handles overnight gaps + drift
 * 2. Garman-Klass (fallback) - OHLC without overnight gaps
 * 3. Close-to-Close (minimal) - only requires close prices
 *
 * References:
 * - Yang-Zhang: https://github.com/hugogobato/Yang-Zhang-s-Realized-Volatility-Automated-Estimation-in-Python
 * - qf-lib implementation: https://qf-lib.readthedocs.io/en/v2.2.1/_modules/qf_lib/common/utils/volatility/drift_independent_volatility.html
 */

/**
 * Correct invalid OHLC data using conservative strategy
 * @param {Array<Object>} ohlc - Array of {open, high, low, close} objects
 * @returns {{corrected: Array<Object>, correctionCount: number}} Corrected data and count
 */
function correctOHLC(ohlc) {
  let correctionCount = 0;
  const corrected = ohlc.map(bar => {
    const result = { ...bar };

    // Correct high if below max(open, close)
    const maxOC = Math.max(bar.open, bar.close);
    if (bar.high < maxOC) {
      result.high = maxOC;
      correctionCount++;
    }

    // Correct low if above min(open, close)
    const minOC = Math.min(bar.open, bar.close);
    if (bar.low > minOC) {
      result.low = minOC;
      correctionCount++;
    }

    return result;
  });

  return { corrected, correctionCount };
}

/**
 * Validate OHLC data integrity
 * @param {Array<Object>} ohlc - Array of {open, high, low, close} objects
 * @returns {{valid: boolean, errors: Array<string>}} Validation result
 */
function validateOHLC(ohlc) {
  const errors = [];

  for (let i = 0; i < ohlc.length; i++) {
    const bar = ohlc[i];
    const idx = i + 1; // 1-based for error messages

    // Check all prices are positive
    if (bar.open <= 0) errors.push(`Bar ${idx}: open=${bar.open} must be positive`);
    if (bar.high <= 0) errors.push(`Bar ${idx}: high=${bar.high} must be positive`);
    if (bar.low <= 0) errors.push(`Bar ${idx}: low=${bar.low} must be positive`);
    if (bar.close <= 0) errors.push(`Bar ${idx}: close=${bar.close} must be positive`);

    // Check OHLC constraints
    if (bar.high < Math.max(bar.open, bar.close)) {
      errors.push(`Bar ${idx}: high=${bar.high} < max(open=${bar.open}, close=${bar.close})`);
    }
    if (bar.low > Math.min(bar.open, bar.close)) {
      errors.push(`Bar ${idx}: low=${bar.low} > min(open=${bar.open}, close=${bar.close})`);
    }
    if (bar.high < bar.low) {
      errors.push(`Bar ${idx}: high=${bar.high} < low=${bar.low}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Yang-Zhang volatility estimator
 * Handles overnight gaps and drift - best for futures with night sessions
 *
 * @param {Array<Object>} ohlc - Array of {open, high, low, close} objects (must be sorted chronologically)
 * @param {number} window - Lookback window in days (default 20)
 * @param {Object} options - Optional parameters
 * @param {boolean} options.autoCorrect - Auto-correct invalid OHLC (default true)
 * @param {number} options.maxCorrectionPct - Max correction ratio before degradation (default 0.2)
 * @returns {{hv: number, correctionCount: number, degraded: boolean}} HV result with correction info
 */
export function yangZhangVolatility(ohlc, window = 20, options = {}) {
  const { autoCorrect = true, maxCorrectionPct = 0.2 } = options;

  if (ohlc.length < window + 1) {
    throw new Error(`Insufficient data: need ${window + 1} bars, got ${ohlc.length}`);
  }

  // Auto-correct invalid OHLC if enabled
  let dataToUse = ohlc;
  let correctionCount = 0;
  if (autoCorrect) {
    const { corrected, correctionCount: count } = correctOHLC(ohlc);
    dataToUse = corrected;
    correctionCount = count;
  }

  // Validate OHLC data
  const validation = validateOHLC(dataToUse);
  if (!validation.valid) {
    throw new Error(`OHLC validation failed:\n${validation.errors.join('\n')}`);
  }

  // Check if too many corrections -> degraded
  const correctionRatio = correctionCount / ohlc.length;
  const degraded = correctionRatio > maxCorrectionPct;

  const n = window;
  const slice = dataToUse.slice(-n - 1); // Need n+1 for overnight calculation

  // Log returns
  const o = []; // overnight: ln(O_t / C_{t-1})
  const c = []; // day: ln(C_t / O_t)
  const u = []; // high-open: ln(H_t / O_t)
  const d = []; // low-open: ln(L_t / O_t)

  for (let i = 1; i < slice.length; i++) {
    const prev = slice[i - 1];
    const curr = slice[i];

    o.push(Math.log(curr.open / prev.close));
    c.push(Math.log(curr.close / curr.open));
    u.push(Math.log(curr.high / curr.open));
    d.push(Math.log(curr.low / curr.open));
  }

  // Variance components
  const mean_o = o.reduce((a, b) => a + b, 0) / o.length;
  const mean_c = c.reduce((a, b) => a + b, 0) / c.length;

  const sigma_on = o.reduce((sum, val) => sum + Math.pow(val - mean_o, 2), 0) / (n - 1);
  const sigma_oc = c.reduce((sum, val) => sum + Math.pow(val - mean_c, 2), 0) / (n - 1);

  // Rogers-Satchell component
  const rs = u.map((u_i, i) => u_i * (u_i - c[i]) + d[i] * (d[i] - c[i]));
  const sigma_rs = rs.reduce((a, b) => a + b, 0) / n;

  // Yang-Zhang weight
  const k = 0.34 / (1.34 + (n + 1) / (n - 1));

  // Total variance
  const sigma_yz = sigma_on + k * sigma_oc + (1 - k) * sigma_rs;

  // Annualize (242 trading days for Chinese futures)
  const hv = Math.sqrt(sigma_yz * 242);

  return { hv, correctionCount, degraded };
}

/**
 * Garman-Klass volatility estimator
 * Fallback when Open is missing - uses High/Low/Close only
 *
 * @param {Array<Object>} hlc - Array of {high, low, close} objects
 * @param {number} window - Lookback window in days
 * @returns {number} Annualized volatility
 */
export function garmanKlassVolatility(hlc, window = 20) {
  if (hlc.length < window) {
    throw new Error(`Insufficient data: need ${window} bars, got ${hlc.length}`);
  }

  const slice = hlc.slice(-window);

  // Garman-Klass formula: σ² = (1/n) * Σ[ 0.5*(ln(H/L))² - (2*ln2-1)*(ln(C/O))² ]
  // Simplified when Open is unavailable: use Close_{t-1} as proxy for Open_t
  let sum = 0;
  for (let i = 1; i < slice.length; i++) {
    const curr = slice[i];
    const prev_close = slice[i - 1].close;

    const hl_term = 0.5 * Math.pow(Math.log(curr.high / curr.low), 2);
    const co_term = (2 * Math.log(2) - 1) * Math.pow(Math.log(curr.close / prev_close), 2);

    sum += hl_term - co_term;
  }

  const variance = sum / (window - 1);
  return Math.sqrt(variance * 242);
}

/**
 * Close-to-Close volatility estimator
 * Minimal fallback - only requires close prices
 *
 * @param {Array<number>} closes - Array of close prices
 * @param {number} window - Lookback window in days
 * @returns {number} Annualized volatility
 */
export function closeToCloseVolatility(closes, window = 20) {
  if (closes.length < window + 1) {
    throw new Error(`Insufficient data: need ${window + 1} bars, got ${closes.length}`);
  }

  const slice = closes.slice(-window - 1);

  // Log returns
  const returns = [];
  for (let i = 1; i < slice.length; i++) {
    returns.push(Math.log(slice[i] / slice[i - 1]));
  }

  // Sample standard deviation
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / (returns.length - 1);

  return Math.sqrt(variance * 242);
}

/**
 * Auto-select best available estimator based on data completeness
 *
 * @param {Array<Object>} data - Array of OHLC objects
 * @param {number} window - Lookback window
 * @param {Object} options - Optional parameters for yangZhangVolatility
 * @returns {{hv: number, estimator: string, correctionCount?: number, degraded?: boolean}} HV and estimator info
 */
export function autoEstimateHV(data, window = 20, options = {}) {
  const hasOpen = data.every(bar => bar.open != null);
  const hasHigh = data.every(bar => bar.high != null);
  const hasLow = data.every(bar => bar.low != null);

  // Priority: Yang-Zhang > Garman-Klass > Close-to-Close
  if (hasOpen && hasHigh && hasLow) {
    const result = yangZhangVolatility(data, window, options);
    return {
      hv: result.hv,
      estimator: 'yang_zhang',
      correctionCount: result.correctionCount,
      degraded: result.degraded
    };
  } else if (hasHigh && hasLow) {
    return {
      hv: garmanKlassVolatility(data, window),
      estimator: 'garman_klass'
    };
  } else {
    const closes = data.map(bar => bar.close);
    return {
      hv: closeToCloseVolatility(closes, window),
      estimator: 'close_to_close'
    };
  }
}

/**
 * Calculate HV percentile rank in historical 90-day window
 *
 * @param {Array<Object>} data - Array of OHLC objects (need 90+ days)
 * @param {number} hvWindow - Window for HV calculation (default 20)
 * @returns {{current: number, percentile: number}} Current HV and its percentile rank (0-100)
 */
export function hvPercentile(data, hvWindow = 20) {
  const minRequired = 90 + hvWindow;
  if (data.length < minRequired) {
    throw new Error(`Insufficient data for percentile: need ${minRequired} bars, got ${data.length}`);
  }

  // Calculate current HV
  const { hv: currentHV } = autoEstimateHV(data.slice(-hvWindow - 1), hvWindow);

  // Calculate rolling HV for past 90 days
  const historicalHVs = [];
  for (let i = data.length - 90; i < data.length; i++) {
    const windowData = data.slice(i - hvWindow - 1, i);
    if (windowData.length >= hvWindow + 1) {
      const { hv } = autoEstimateHV(windowData, hvWindow);
      historicalHVs.push(hv);
    }
  }

  // Percentile rank
  const belowCurrent = historicalHVs.filter(hv => hv < currentHV).length;
  const percentile = (belowCurrent / historicalHVs.length) * 100;

  return {
    current: currentHV,
    percentile: Math.round(percentile * 10) / 10 // Round to 1 decimal
  };
}
