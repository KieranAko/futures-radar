/**
 * shared-backtest-lib.cjs — V3 共享回测模块
 *
 * 由 observed 回放和 null 实验共同导入，确保同一套逻辑。
 * 所有函数的数据输入截至 signalDate（不含未来信息）。
 *
 * Exports:
 *   runScanner(raw, signalDate)       → candidates[]
 *   runScannerAsserted(raw, signalDate) → { candidates[], assertions[] }
 *   runHardFilter(candidates, raw, signalDate) → filtered[]
 *   simulateEntry(symbol, raw, signalDate) → { entryDate, entryPrice, signalIdx, entryIdx }
 *   simulateExit(symbol, raw, entryIdx, holdDays) → { exitDate, exitPrice }
 *   calculateCosts(entryPrice, exitPrice) → costs (as fraction of entryPrice)
 *   CONFIG                             → { LIMIT_THRESHOLD, ... }
 */

// ─── Config ──────────────────────────────────────────────

const CONFIG = {
  ENTRY_TIMING: 'T+1_open',
  COMMISSION_RATE: 0.0003,
  SLIPPAGE_RATE: 0.0002,
  LIMIT_THRESHOLD: 0.095,   // 涨跌停阈值 (±9.5%)
  MIN_TURNOVER: 1e8,        // 最小5日均成交额
  MIN_OI: 10000,            // 最小5日均持仓量
  TOP_N: 10                 // ATR% Top N
};

// ─── Indicator helpers ───────────────────────────────────

function calculateATR(high, low, close, period = 14) {
  if (close.length < period + 1) return null;
  const tr = [];
  for (let i = 1; i < close.length; i++) {
    tr.push(Math.max(
      high[i] - low[i],
      Math.abs(high[i] - close[i - 1]),
      Math.abs(low[i] - close[i - 1])
    ));
  }
  if (tr.length < period) return null;
  const recent = tr.slice(-period);
  return recent.reduce((a, b) => a + b, 0) / recent.length;
}

function calculateHV(close, period = 5) {
  const TRADING_DAYS = 252;
  const logReturns = [];
  for (let i = 1; i < close.length; i++) {
    if (close[i - 1] <= 0 || close[i] <= 0) continue;
    logReturns.push(Math.log(close[i] / close[i - 1]));
  }
  if (logReturns.length < period) return null;
  const recent = logReturns.slice(-period);
  const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
  const variance = recent.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / recent.length;
  return Math.sqrt(variance) * Math.sqrt(TRADING_DAYS);
}

function calculateSMA(arr, period) {
  if (arr.length < period) return null;
  const slice = arr.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function calculateChange5d(close) {
  if (close.length < 6) return null;
  const len = close.length;
  return ((close[len - 1] - close[len - 6]) / close[len - 6]) * 100;
}

function calculateVsMA(price, ma) {
  if (ma === null || ma === 0) return null;
  return ((price - ma) / ma) * 100;
}

// ─── Scanner ─────────────────────────────────────────────

/**
 * 扫描候选品种，数据严格截断至 signalDate。
 * 返回 ATR% Top N，每个包含指标快照。
 */
function runScanner(raw, signalDate) {
  const candidates = [];

  for (const [symbol, contract] of Object.entries(raw.contracts)) {
    if (!contract.ohlcv || !contract.ohlcv.dates) continue;
    const { dates, open, high, low, close, volume, openInterest } = contract.ohlcv;
    const signalIdx = dates.indexOf(signalDate);
    if (signalIdx < 0 || signalIdx < 20) continue;

    // 数据严格截断到 signalIdx（包含 signalDate）
    const truncClose = close.slice(0, signalIdx + 1);
    const truncHigh = high.slice(0, signalIdx + 1);
    const truncLow = low.slice(0, signalIdx + 1);
    const truncVolume = volume.slice(0, signalIdx + 1);
    const truncOI = openInterest ? openInterest.slice(0, signalIdx + 1) : [];

    const last5Volume = truncVolume.slice(-5);
    const last5Close = truncClose.slice(-5);
    const last5OI = truncOI.length >= 5 ? truncOI.slice(-5) : truncOI;

    const avgVolume5d = last5Volume.reduce((a, b) => a + b, 0) / last5Volume.length;
    const avgClose5d = last5Close.reduce((a, b) => a + b, 0) / last5Close.length;
    const avgOI5d = last5OI.length > 0 ? last5OI.reduce((a, b) => a + b, 0) / last5OI.length : 0;
    const avgTurnover5d = avgVolume5d * avgClose5d * (contract.multiplier || 1);

    if (avgTurnover5d < CONFIG.MIN_TURNOVER) continue;
    if (avgOI5d < CONFIG.MIN_OI) continue;

    const atr14 = calculateATR(truncHigh, truncLow, truncClose, 14);
    const hv5 = calculateHV(truncClose, 5);
    const hv20 = calculateHV(truncClose, 20);
    const ma20 = calculateSMA(truncClose, 20);
    const ma60 = calculateSMA(truncClose, 60);
    const change5d = calculateChange5d(truncClose);

    if (atr14 === null || hv5 === null) continue;

    const currentPrice = truncClose[truncClose.length - 1];
    const atrPct = (atr14 / currentPrice) * 100;
    const hvRatio = hv20 > 0 ? hv5 / hv20 : null;
    const vsMA20 = calculateVsMA(currentPrice, ma20);
    const vsMA60 = calculateVsMA(currentPrice, ma60);

    const lastDate = dates[signalIdx]; // = signalDate

    candidates.push({
      symbol,
      name: contract.name,
      sector: contract.sector,
      price: currentPrice,
      atr14, atrPct, hv5, hv20, hvRatio,
      ma20, ma60, vsMA20, vsMA60, change5d,
      avgTurnover5d, avgOI5d,
      _lastDate: lastDate,
      _dataLength: truncClose.length,
      _signalIdx: signalIdx
    });
  }

  candidates.sort((a, b) => b.atrPct - a.atrPct);
  return candidates.slice(0, CONFIG.TOP_N);
}

/**
 * 带时间链断言的 scanner — 验证每个品种的 lastDate === signalDate。
 */
function runScannerAsserted(raw, signalDate) {
  const candidates = [];
  const assertions = [];

  for (const [symbol, contract] of Object.entries(raw.contracts)) {
    if (!contract.ohlcv || !contract.ohlcv.dates) continue;
    const { dates, open, high, low, close, volume, openInterest } = contract.ohlcv;
    const signalIdx = dates.indexOf(signalDate);
    if (signalIdx < 0 || signalIdx < 20) continue;

    const truncClose = close.slice(0, signalIdx + 1);
    const truncHigh = high.slice(0, signalIdx + 1);
    const truncLow = low.slice(0, signalIdx + 1);
    const truncVolume = volume.slice(0, signalIdx + 1);
    const truncOI = openInterest ? openInterest.slice(0, signalIdx + 1) : [];

    const last5Volume = truncVolume.slice(-5);
    const last5Close = truncClose.slice(-5);
    const last5OI = truncOI.length >= 5 ? truncOI.slice(-5) : truncOI;

    const avgVolume5d = last5Volume.reduce((a, b) => a + b, 0) / last5Volume.length;
    const avgClose5d = last5Close.reduce((a, b) => a + b, 0) / last5Close.length;
    const avgOI5d = last5OI.length > 0 ? last5OI.reduce((a, b) => a + b, 0) / last5OI.length : 0;
    const avgTurnover5d = avgVolume5d * avgClose5d * (contract.multiplier || 1);

    if (avgTurnover5d < CONFIG.MIN_TURNOVER) continue;
    if (avgOI5d < CONFIG.MIN_OI) continue;

    const atr14 = calculateATR(truncHigh, truncLow, truncClose, 14);
    const hv5 = calculateHV(truncClose, 5);
    const hv20 = calculateHV(truncClose, 20);
    const ma20 = calculateSMA(truncClose, 20);
    const ma60 = calculateSMA(truncClose, 60);
    const change5d = calculateChange5d(truncClose);

    if (atr14 === null || hv5 === null) continue;

    const currentPrice = truncClose[truncClose.length - 1];
    const atrPct = (atr14 / currentPrice) * 100;
    const hvRatio = hv20 > 0 ? hv5 / hv20 : null;
    const vsMA20 = calculateVsMA(currentPrice, ma20);
    const vsMA60 = calculateVsMA(currentPrice, ma60);

    const lastDate = dates[signalIdx];
    assertions.push({ symbol, lastDate, signalDate, ok: lastDate === signalDate });

    candidates.push({
      symbol,
      name: contract.name,
      sector: contract.sector,
      price: currentPrice,
      atr14, atrPct, hv5, hv20, hvRatio,
      ma20, ma60, vsMA20, vsMA60, change5d,
      avgTurnover5d, avgOI5d,
      _lastDate: lastDate,
      _dataLength: truncClose.length,
      _signalIdx: signalIdx
    });
  }

  candidates.sort((a, b) => b.atrPct - a.atrPct);
  return {
    candidates: candidates.slice(0, CONFIG.TOP_N),
    assertions
  };
}

// ─── Hard filter ─────────────────────────────────────────

/**
 * 过滤涨跌停日（change >= 9.5%），只检查 signalDate 当日。
 */
function runHardFilter(candidates, raw, signalDate) {
  const filtered = [];
  for (const c of candidates) {
    const contract = raw.contracts[c.symbol];
    if (!contract || !contract.ohlcv) continue;
    const { dates, close } = contract.ohlcv;
    const signalIdx = dates.indexOf(signalDate);
    if (signalIdx < 1) continue;

    const prevClose = close[signalIdx - 1];
    const currClose = close[signalIdx];
    const change = Math.abs((currClose - prevClose) / prevClose);

    if (change >= CONFIG.LIMIT_THRESHOLD) continue;
    filtered.push(c);
  }
  return filtered;
}

// ─── Entry / Exit ────────────────────────────────────────

/**
 * T+1 开盘入场。signalDate → 下一个交易日开盘价。
 */
function simulateEntry(symbol, raw, signalDate) {
  const contract = raw.contracts[symbol];
  if (!contract || !contract.ohlcv) return null;
  const { dates, open, close } = contract.ohlcv;
  const signalIdx = dates.indexOf(signalDate);
  if (signalIdx < 0) return null;

  const entryIdx = signalIdx + 1;
  if (entryIdx >= dates.length) return null;

  const entryDate = dates[entryIdx];

  // 跳空涨停/跌停检查
  const gapChange = Math.abs((open[entryIdx] - close[signalIdx]) / close[signalIdx]);
  if (gapChange >= CONFIG.LIMIT_THRESHOLD) return null;

  return { entryDate, entryPrice: open[entryIdx], signalIdx, entryIdx };
}

/**
 * T+N 收盘退出。entryIdx + holdDays = exitIdx。
 */
function simulateExit(symbol, raw, entryIdx, holdDays) {
  const contract = raw.contracts[symbol];
  if (!contract || !contract.ohlcv) return null;
  const { dates, close } = contract.ohlcv;
  const exitIdx = entryIdx + holdDays;
  if (exitIdx >= dates.length) return null;
  return { exitDate: dates[exitIdx], exitPrice: close[exitIdx] };
}

// ─── Costs ───────────────────────────────────────────────

/**
 * 成本 = 佣金(0.03%) + 滑点(0.02% × 2)，按 entryPrice 归一化。
 */
function calculateCosts(entryPrice, exitPrice) {
  // 单一真相源：lib/costs.cjs（reasoning 也直接引用同一实现）
  const { calculateCosts: sharedCosts } = require('../../lib/costs.cjs');
  return sharedCosts(entryPrice, exitPrice);
}

// ─── Exports ─────────────────────────────────────────────

module.exports = {
  CONFIG,
  runScanner,
  runScannerAsserted,
  runHardFilter,
  simulateEntry,
  simulateExit,
  calculateCosts
};
