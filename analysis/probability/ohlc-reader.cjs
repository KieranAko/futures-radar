/**
 * OHLC Data Reader for Futures-Radar
 *
 * Extracts and transforms OHLC data from raw.json parallel arrays
 * to object array format required by HV estimators.
 */

/**
 * Extract OHLC array from raw.json for a specific symbol
 *
 * @param {Object} rawJson - Parsed raw.json
 * @param {string} symbol - Symbol code (e.g., "SC0")
 * @param {number} lastNBars - Number of recent bars to extract (default: all)
 * @returns {Array<Object>} Array of {date, open, high, low, close} objects
 * @throws {Error} If symbol not found or array length mismatch
 */
function extractOHLC(rawJson, symbol, lastNBars = null) {
  // Validate input
  if (!rawJson || !rawJson.contracts) {
    throw new Error('Invalid raw.json structure: missing contracts object');
  }

  const contract = rawJson.contracts[symbol];
  if (!contract || !contract.ohlcv) {
    throw new Error(`Symbol ${symbol} not found in raw.json`);
  }

  const { dates, open, high, low, close } = contract.ohlcv;

  // Validate all required fields exist
  if (!dates || !open || !high || !low || !close) {
    throw new Error(`Incomplete OHLC data for ${symbol}: missing required fields`);
  }

  // Validate parallel array lengths
  const lengths = [dates.length, open.length, high.length, low.length, close.length];
  const uniqueLengths = [...new Set(lengths)];

  if (uniqueLengths.length > 1) {
    throw new Error(
      `OHLC array length mismatch for ${symbol}: ` +
      `dates=${dates.length}, open=${open.length}, high=${high.length}, ` +
      `low=${low.length}, close=${close.length}`
    );
  }

  // Check minimum data requirement
  if (dates.length < 21) {
    throw new Error(
      `Insufficient OHLC data for ${symbol}: need at least 21 bars for 20-day HV, got ${dates.length}`
    );
  }

  // Transform parallel arrays to object array
  const ohlcArray = [];
  for (let i = 0; i < dates.length; i++) {
    ohlcArray.push({
      date: dates[i],
      open: open[i],
      high: high[i],
      low: low[i],
      close: close[i]
    });
  }

  // Return last N bars if specified
  if (lastNBars && lastNBars < ohlcArray.length) {
    return ohlcArray.slice(-lastNBars);
  }

  return ohlcArray;
}

/**
 * Extract latest close price from raw.json
 *
 * @param {Object} rawJson - Parsed raw.json
 * @param {string} symbol - Symbol code
 * @returns {number} Latest close price
 * @throws {Error} If symbol not found or close array empty
 */
function getLatestClose(rawJson, symbol) {
  const contract = rawJson.contracts[symbol];
  if (!contract || !contract.ohlcv || !contract.ohlcv.close) {
    throw new Error(`Cannot extract close price for ${symbol}`);
  }

  const closeArray = contract.ohlcv.close;
  if (closeArray.length === 0) {
    throw new Error(`Empty close array for ${symbol}`);
  }

  return closeArray[closeArray.length - 1];
}

module.exports = {
  extractOHLC,
  getLatestClose
};
