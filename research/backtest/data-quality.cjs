#!/usr/bin/env node
/**
 * data-quality.cjs — 数据质量检查和标记模块
 *
 * 功能：
 * 1. 标记涨跌停日（|change| >= 9.5%）
 * 2. 标记OHLC违规（high < max(open,close) 或 low > min(open,close)）
 * 3. 标记换月日（持仓量骤降 + 价格跳变）
 * 4. 过滤不可交易日期
 */

/**
 * 检查OHLC数据完整性
 * @returns {Object} {valid: boolean, violations: Array}
 */
function validateOHLC(open, high, low, close, dates) {
  const violations = [];

  for (let i = 0; i < dates.length; i++) {
    const o = open[i];
    const h = high[i];
    const l = low[i];
    const c = close[i];

    // 基本约束：high >= max(open, close), low <= min(open, close)
    const maxOC = Math.max(o, c);
    const minOC = Math.min(o, c);

    if (h < maxOC - 1e-6) {  // 允许浮点误差
      violations.push({
        date: dates[i],
        type: 'high_violation',
        message: `high=${h} < max(open=${o}, close=${c})=${maxOC}`
      });
    }

    if (l > minOC + 1e-6) {
      violations.push({
        date: dates[i],
        type: 'low_violation',
        message: `low=${l} > min(open=${o}, close=${c})=${minOC}`
      });
    }

    // 检查零值或负值
    if (o <= 0 || h <= 0 || l <= 0 || c <= 0) {
      violations.push({
        date: dates[i],
        type: 'invalid_price',
        message: `Non-positive price: O=${o} H=${h} L=${l} C=${c}`
      });
    }
  }

  return {
    valid: violations.length === 0,
    violations
  };
}

/**
 * 检测涨跌停日
 * @param {number} limitThreshold - 涨跌停阈值（默认9.5%）
 * @returns {Array} 涨跌停日期索引
 */
function detectLimitMoves(open, high, low, close, dates, limitThreshold = 0.095) {
  const limitDays = [];

  for (let i = 1; i < dates.length; i++) {
    const prevClose = close[i - 1];
    const change = (close[i] - prevClose) / prevClose;

    if (Math.abs(change) >= limitThreshold) {
      limitDays.push({
        index: i,
        date: dates[i],
        change: change * 100,
        price: close[i],
        prevPrice: prevClose
      });
    }
  }

  return limitDays;
}

/**
 * 检测换月日（持仓量骤降 + 价格跳变）
 * @returns {Array} 换月日期索引
 */
function detectRolloverDays(dates, close, openInterest, priceJumpThreshold = 0.05, oiDropThreshold = 0.3) {
  const rolloverDays = [];

  if (!openInterest || openInterest.length !== dates.length) {
    return rolloverDays;  // 无持仓量数据，无法检测
  }

  for (let i = 1; i < dates.length; i++) {
    const priceChange = Math.abs(close[i] - close[i - 1]) / close[i - 1];
    const oiChange = (openInterest[i] - openInterest[i - 1]) / openInterest[i - 1];

    // 换月特征：价格跳变 + 持仓量骤降
    if (priceChange > priceJumpThreshold && oiChange < -oiDropThreshold) {
      rolloverDays.push({
        index: i,
        date: dates[i],
        priceJump: priceChange * 100,
        oiDrop: oiChange * 100,
        prevOI: openInterest[i - 1],
        newOI: openInterest[i]
      });
    }
  }

  return rolloverDays;
}

/**
 * 生成数据质量报告
 */
function generateQualityReport(symbol, ohlcData) {
  const { dates, open, high, low, close, volume, openInterest } = ohlcData;

  // 1. OHLC完整性
  const ohlcCheck = validateOHLC(open, high, low, close, dates);

  // 2. 涨跌停检测
  const limitMoves = detectLimitMoves(open, high, low, close, dates);

  // 3. 换月检测
  const rolloverDays = detectRolloverDays(dates, close, openInterest);

  return {
    symbol,
    totalDays: dates.length,
    ohlcViolations: ohlcCheck.violations.length,
    ohlcViolationDetails: ohlcCheck.violations.slice(0, 10),  // 展示用：前10个
    ohlcViolationsFull: ohlcCheck.violations,  // 完整数组供去重
    limitMoves: limitMoves.length,
    limitMoveDetails: limitMoves.slice(0, 10),  // 展示用：前10个
    limitMovesFull: limitMoves,  // 完整数组供去重
    rolloverDays: rolloverDays.length,
    rolloverDayDetails: rolloverDays,  // 换月通常很少，不截断
    rolloverDaysFull: rolloverDays,  // 完整数组供去重
    isClean: ohlcCheck.valid && limitMoves.length === 0  // 注意：isClean不检查rollover
  };
}

/**
 * 标记不可交易日期（用于回测过滤）
 */
function markUntradableDays(dates, close, openInterest, limitThreshold = 0.095) {
  const untradable = new Set();

  // 1. 标记涨跌停日
  const limitMoves = detectLimitMoves([], [], [], close, dates, limitThreshold);
  for (const lm of limitMoves) {
    untradable.add(lm.date);
  }

  // 2. 标记换月日
  const rolloverDays = detectRolloverDays(dates, close, openInterest);
  for (const rd of rolloverDays) {
    untradable.add(rd.date);
  }

  return Array.from(untradable).sort();
}

module.exports = {
  validateOHLC,
  detectLimitMoves,
  detectRolloverDays,
  generateQualityReport,
  markUntradableDays
};
