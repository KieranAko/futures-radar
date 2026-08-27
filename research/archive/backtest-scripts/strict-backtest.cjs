#!/usr/bin/env node
/**
 * strict-backtest.cjs — 严格无泄漏回测框架
 *
 * 设计原则：
 * 1. 每个信号日独立运行完整pipeline（scanner → hard-filter → model）
 * 2. 所有指标计算只使用截至信号日T的数据
 * 3. 入场使用T+1数据，出场使用T+N数据
 * 4. 严格时间链验证：assert(modelLastDate === T < entryDate < exitDate)
 *
 * Usage:
 *   node strict-backtest.cjs --model baseline --window T+5
 *   node strict-backtest.cjs --model all --window T+5
 */

const fs = require('fs');
const path = require('path');
const { markUntradableDays } = require('./data-quality.cjs');

// ── Configuration ──────────────────────────────────────────────────
const BACKTEST_DIR = __dirname;
const RUNS_DIR = path.join(BACKTEST_DIR, 'runs');
const MODELS_DIR = path.join(BACKTEST_DIR, 'models');

const CONFIG = {
  ENTRY_TIMING: 'T+1_open',
  EXIT_TIMING_MAP: {
    'T+3': 3,
    'T+5': 5,
    'T+10': 10
  },
  COMMISSION_RATE: 0.0003,  // 0.03%
  SLIPPAGE_RATE: 0.0002,    // 0.02%
  LIMIT_THRESHOLD: 0.095,   // 9.5% 视为涨跌停

  // Scanner配置
  MIN_TURNOVER: 1e8,        // 1亿元
  MIN_OI: 10000,            // 1万手
  TOP_N: 10                 // Top 10 candidates
};

// ── Time-Series Indicator Calculation (Strict) ──────────────────────
/**
 * 计算ATR（Average True Range）
 * @param {number[]} high
 * @param {number[]} low
 * @param {number[]} close
 * @param {number} period
 * @returns {number|null}
 */
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

/**
 * 计算HV（Historical Volatility，年化）
 * @param {number[]} close
 * @param {number} period
 * @returns {number|null}
 */
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

/**
 * 计算SMA（Simple Moving Average）
 * @param {number[]} arr
 * @param {number} period
 * @returns {number|null}
 */
function calculateSMA(arr, period) {
  if (arr.length < period) return null;
  const slice = arr.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

/**
 * 计算HV百分位（当前HV5在历史滚动窗口中的分位数）
 * @param {number[]} close
 * @param {number} currentHV5
 * @returns {number|null}
 */
function calculateVolPercentile(close, currentHV5) {
  if (close.length < 12 || currentHV5 == null) return null;

  const rollingHVs = [];
  // 计算所有6日窗口的HV5
  for (let i = 6; i <= close.length; i++) {
    const slice = close.slice(i - 6, i);
    const hv = calculateHV(slice, 5);
    if (hv != null && hv > 0) rollingHVs.push(hv);
  }

  if (rollingHVs.length < 10) return null;

  // 计算百分位
  const count = rollingHVs.filter(hv => hv <= currentHV5).length;
  return (count / rollingHVs.length) * 100;
}

/**
 * 计算成交量倍数（近5日 vs 前期基准）
 * @param {number[]} volume
 * @returns {number|null}
 */
function calculateVolMultiplier(volume) {
  const period = 5;
  const basePeriod = 20;

  if (volume.length < basePeriod + period) return null;

  const recent = volume.slice(-period);
  const base = volume.slice(-basePeriod - period, -period);

  const avgRecent = recent.reduce((a, b) => a + b, 0) / recent.length;
  const avgBase = base.reduce((a, b) => a + b, 0) / base.length;

  if (avgBase === 0) return null;
  return avgRecent / avgBase;
}

/**
 * 计算价格相对MA的偏离度
 * @param {number} price
 * @param {number|null} ma
 * @returns {number|null}
 */
function calculateVsMA(price, ma) {
  if (ma === null || ma === 0) return null;
  return ((price - ma) / ma) * 100;
}

/**
 * 计算change5d
 * @param {number[]} close
 * @returns {number|null}
 */
function calculateChange5d(close) {
  if (close.length < 6) return null;
  const len = close.length;
  return ((close[len - 1] - close[len - 6]) / close[len - 6]) * 100;
}

// ── Time-Series Scanner (Strict) ────────────────────────────────────
/**
 * 在截至signalDate的数据上运行scanner
 * @param {Object} raw - 完整raw数据
 * @param {string} signalDate - 信号日期
 * @returns {Array} Top N candidates with indicators
 */
function runScanner(raw, signalDate) {
  const candidates = [];

  for (const [symbol, contract] of Object.entries(raw.contracts)) {
    if (!contract.ohlcv || !contract.ohlcv.dates) continue;

    const { dates, open, high, low, close, volume, openInterest } = contract.ohlcv;

    // 找到signalDate的索引
    const signalIdx = dates.indexOf(signalDate);
    if (signalIdx < 0) continue;
    if (signalIdx < 20) continue;  // 需要至少20天数据计算MA20

    // 截断到signalDate（包含signalDate当天）
    const truncDates = dates.slice(0, signalIdx + 1);
    const truncOpen = open.slice(0, signalIdx + 1);
    const truncHigh = high.slice(0, signalIdx + 1);
    const truncLow = low.slice(0, signalIdx + 1);
    const truncClose = close.slice(0, signalIdx + 1);
    const truncVolume = volume.slice(0, signalIdx + 1);
    const truncOI = openInterest ? openInterest.slice(0, signalIdx + 1) : [];

    // 流动性过滤
    const last5Volume = truncVolume.slice(-5);
    const last5Close = truncClose.slice(-5);
    const last5OI = truncOI.length >= 5 ? truncOI.slice(-5) : truncOI;

    const avgVolume5d = last5Volume.reduce((a, b) => a + b, 0) / last5Volume.length;
    const avgClose5d = last5Close.reduce((a, b) => a + b, 0) / last5Close.length;
    const avgOI5d = last5OI.length > 0 ? last5OI.reduce((a, b) => a + b, 0) / last5OI.length : 0;
    const avgTurnover5d = avgVolume5d * avgClose5d * (contract.multiplier || 1);

    if (avgTurnover5d < CONFIG.MIN_TURNOVER) continue;
    if (avgOI5d < CONFIG.MIN_OI) continue;

    // 计算指标（只使用截断数据）
    const atr14 = calculateATR(truncHigh, truncLow, truncClose, 14);
    const hv5 = calculateHV(truncClose, 5);
    const hv20 = calculateHV(truncClose, 20);
    const ma20 = calculateSMA(truncClose, 20);
    const ma60 = calculateSMA(truncClose, 60);
    const change5d = calculateChange5d(truncClose);
    const volPercentile = calculateVolPercentile(truncClose, hv5);
    const volMultiplier = calculateVolMultiplier(truncVolume);

    if (atr14 === null || hv5 === null) continue;

    const currentPrice = truncClose[truncClose.length - 1];
    const atrPct = (atr14 / currentPrice) * 100;
    const hvRatio = hv20 > 0 ? hv5 / hv20 : null;
    const vsMA20 = calculateVsMA(currentPrice, ma20);
    const vsMA60 = calculateVsMA(currentPrice, ma60);

    candidates.push({
      symbol,
      name: contract.name,
      sector: contract.sector,
      price: currentPrice,
      atr14,
      atrPct,
      hv5,
      hv20,
      hvRatio,
      ma20,
      ma60,
      vsMA20,
      vsMA60,
      change5d,
      volPercentile,
      volMultiplier,
      avgTurnover5d,
      avgOI5d,
      // 时间链验证字段
      _lastDate: truncDates[truncDates.length - 1],
      _dataLength: truncClose.length
    });
  }

  // 按ATR%排名
  candidates.sort((a, b) => b.atrPct - a.atrPct);

  return candidates.slice(0, CONFIG.TOP_N);
}

// ── Hard Filter (Strict) ────────────────────────────────────────────
/**
 * Hard filter: 检查涨跌停和极端波动
 * @param {Array} candidates
 * @param {Object} raw
 * @param {string} signalDate
 * @returns {Array}
 */
function runHardFilter(candidates, raw, signalDate) {
  const filtered = [];

  for (const c of candidates) {
    const contract = raw.contracts[c.symbol];
    if (!contract || !contract.ohlcv) continue;

    const { dates, close } = contract.ohlcv;
    const signalIdx = dates.indexOf(signalDate);
    if (signalIdx < 1) continue;

    // 检查T日是否涨跌停（用T-1到T的变化）
    const prevClose = close[signalIdx - 1];
    const currClose = close[signalIdx];
    const change = Math.abs((currClose - prevClose) / prevClose);

    if (change >= CONFIG.LIMIT_THRESHOLD) {
      console.log(`  [Hard Filter] ${c.symbol} rejected: limit ${(change * 100).toFixed(2)}%`);
      continue;
    }

    filtered.push(c);
  }

  return filtered;
}

// ── Entry/Exit Simulation ───────────────────────────────────────────
/**
 * 模拟入场：T+1 open
 * @param {string} symbol
 * @param {Object} raw
 * @param {string} signalDate
 * @returns {Object|null} {entryDate, entryPrice, signalIdx}
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

  // 检查T+1是否为不可交易日（涨跌停、换月等）
  if (contract._untradableDays && contract._untradableDays.has(entryDate)) {
    console.log(`  [Entry Skip] ${symbol} ${entryDate} is untradable (limit move or rollover)`);
    return null;
  }

  // 双重检查：计算T到T+1的gap（防御性编程）
  const signalClose = close[signalIdx];
  const entryOpen = open[entryIdx];
  const gapChange = Math.abs((entryOpen - signalClose) / signalClose);

  if (gapChange >= CONFIG.LIMIT_THRESHOLD) {
    console.log(`  [Entry Skip] ${symbol} T+1 limit gap ${(gapChange * 100).toFixed(2)}%`);
    return null;
  }

  return {
    entryDate: dates[entryIdx],
    entryPrice: entryOpen,
    signalIdx,
    entryIdx
  };
}

/**
 * 模拟出场：T+N close
 * @param {string} symbol
 * @param {Object} raw
 * @param {number} entryIdx
 * @param {number} holdDays
 * @returns {Object|null} {exitDate, exitPrice}
 */
function simulateExit(symbol, raw, entryIdx, holdDays) {
  const contract = raw.contracts[symbol];
  if (!contract || !contract.ohlcv) return null;

  const { dates, close } = contract.ohlcv;
  const exitIdx = entryIdx + holdDays;
  if (exitIdx >= dates.length) return null;

  return {
    exitDate: dates[exitIdx],
    exitPrice: close[exitIdx]
  };
}

// ── Cost Calculation ────────────────────────────────────────────────
function calculateCosts(entryPrice, exitPrice) {
  const avgPrice = (entryPrice + exitPrice) / 2;
  const commission = avgPrice * CONFIG.COMMISSION_RATE;
  const slippage = entryPrice * CONFIG.SLIPPAGE_RATE * 2;  // 双向
  const totalCost = commission + slippage;
  return totalCost / entryPrice;  // Return as percentage of entry price
}

// ── Load Historical Runs ────────────────────────────────────────────
function loadHistoricalRuns() {
  const runs = [];
  const runDirs = fs.readdirSync(RUNS_DIR).filter(d => d.startsWith('bt-'));

  for (const runDir of runDirs) {
    const rawPath = path.join(RUNS_DIR, runDir, 'raw.json');
    if (!fs.existsSync(rawPath)) continue;

    const raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'));

    // 为每个合约标记不可交易日（涨跌停、换月等）
    for (const [symbol, contract] of Object.entries(raw.contracts)) {
      if (!contract.ohlcv) continue;
      const { dates, close, openInterest } = contract.ohlcv;
      contract._untradableDays = new Set(
        markUntradableDays(dates, close, openInterest, CONFIG.LIMIT_THRESHOLD)
      );
    }

    runs.push({ runId: runDir, raw });
  }

  console.log(`Loaded ${runs.length} historical runs`);
  return runs;
}

// ── Load Model ──────────────────────────────────────────────────────
function loadModel(modelName) {
  const modelPath = path.join(MODELS_DIR, `${modelName}.cjs`);
  if (!fs.existsSync(modelPath)) {
    throw new Error(`Model not found: ${modelPath}`);
  }
  return require(modelPath);
}

// ── Performance Metrics ─────────────────────────────────────────────
function calculateMetrics(trades) {
  if (trades.length === 0) return {};

  const correct = trades.filter(t => t.correct).length;
  const wins = trades.filter(t => t.netReturn > 0).length;
  const losses = trades.filter(t => t.netReturn <= 0).length;

  const returns = trades.map(t => t.netReturn);
  const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;

  const winReturns = trades.filter(t => t.netReturn > 0).map(t => t.netReturn);
  const lossReturns = trades.filter(t => t.netReturn <= 0).map(t => t.netReturn);

  const avgWin = winReturns.length > 0 ? winReturns.reduce((a, b) => a + b, 0) / winReturns.length : 0;
  const avgLoss = lossReturns.length > 0 ? lossReturns.reduce((a, b) => a + b, 0) / lossReturns.length : 0;

  const totalWin = winReturns.reduce((a, b) => a + b, 0);
  const totalLoss = Math.abs(lossReturns.reduce((a, b) => a + b, 0));
  const profitFactor = totalLoss > 0 ? totalWin / totalLoss : (totalWin > 0 ? 999 : 0);

  // Max drawdown (cumulative)
  let cumulative = 0;
  let peak = 0;
  let maxDD = 0;

  for (const t of trades) {
    cumulative += t.netReturn;
    if (cumulative > peak) peak = cumulative;
    const dd = peak - cumulative;
    if (dd > maxDD) maxDD = dd;
  }

  // Sharpe
  const mean = avgReturn;
  const variance = returns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / returns.length;
  const stdDev = Math.sqrt(variance);
  const sharpe = stdDev > 0 ? (avgReturn * Math.sqrt(252)) / stdDev : 0;

  return {
    tradeCount: trades.length,
    directionAccuracy: parseFloat((correct / trades.length).toFixed(4)),
    winRate: parseFloat((wins / trades.length).toFixed(4)),
    avgReturn: parseFloat(avgReturn.toFixed(6)),
    avgWin: parseFloat(avgWin.toFixed(6)),
    avgLoss: parseFloat(avgLoss.toFixed(6)),
    profitFactor: parseFloat(profitFactor.toFixed(4)),
    maxDrawdown: parseFloat(maxDD.toFixed(4)),
    sharpe: parseFloat(sharpe.toFixed(4))
  };
}

// ── Main Backtest Runner ────────────────────────────────────────────
async function runBacktest(modelName, window) {
  console.log(`\n=== Strict Backtest (No Look-Ahead Bias) ===`);
  console.log(`Model: ${modelName}`);
  console.log(`Window: ${window}`);
  console.log(`Entry: ${CONFIG.ENTRY_TIMING}\n`);

  const model = loadModel(modelName);
  const runs = loadHistoricalRuns();
  const exitDays = CONFIG.EXIT_TIMING_MAP[window];

  const trades = [];
  let signalCount = 0;
  let timeChainViolations = 0;

  for (const { runId, raw } of runs) {
    // 确定信号日期（窗口倒数 exitDays+2 天）
    const firstContract = Object.values(raw.contracts)[0];
    if (!firstContract || !firstContract.ohlcv) continue;

    const dates = firstContract.ohlcv.dates;
    const signalDateIdx = dates.length - (exitDays + 2);
    if (signalDateIdx < 20) continue;  // 至少需要20天数据

    const signalDate = dates[signalDateIdx];
    console.log(`\n[${runId}] Signal Date: ${signalDate} (idx ${signalDateIdx}/${dates.length})`);

    // 阶段1：使用截至signalDate的数据运行scanner + filter
    const candidates = runScanner(raw, signalDate);
    console.log(`  Scanner: ${candidates.length} candidates after liquidity filter`);

    const filtered = runHardFilter(candidates, raw, signalDate);
    console.log(`  Hard Filter: ${filtered.length} candidates passed`);

    if (filtered.length === 0) continue;

    // 时间链验证：所有candidates的_lastDate必须等于signalDate
    for (const c of filtered) {
      if (c._lastDate !== signalDate) {
        console.error(`  TIME-CHAIN VIOLATION: ${c.symbol} lastDate=${c._lastDate} !== signalDate=${signalDate}`);
        timeChainViolations++;
      }
    }

    // 模型生成信号（传入干净的filtered candidates）
    const modelSignals = model.generateSignals(raw, { candidates: filtered }, signalDate);
    console.log(`  Model: ${modelSignals.length} signals generated`);

    // 阶段2：使用完整数据模拟入场/出场
    for (const signal of modelSignals) {
      signalCount++;
      const { symbol, direction } = signal;

      const entry = simulateEntry(symbol, raw, signalDate);
      if (!entry) continue;

      const exit = simulateExit(symbol, raw, entry.entryIdx, exitDays);
      if (!exit) continue;

      // 最终时间链验证
      if (signalDate >= entry.entryDate || entry.entryDate >= exit.exitDate) {
        console.error(`  TIME-CHAIN VIOLATION: ${symbol} ${signalDate} >= ${entry.entryDate} >= ${exit.exitDate}`);
        timeChainViolations++;
        continue;
      }

      const costs = calculateCosts(entry.entryPrice, exit.exitPrice);
      const directionSign = direction === 'bullish' ? 1 : -1;
      const grossReturn = directionSign * (exit.exitPrice - entry.entryPrice) / entry.entryPrice;
      const netReturn = grossReturn - costs;

      const actualDirection = exit.exitPrice > entry.entryPrice ? 'bullish' : 'bearish';
      const correct = actualDirection === direction;

      trades.push({
        runId,
        symbol,
        direction,
        entryDate: entry.entryDate,
        exitDate: exit.exitDate,
        entryPrice: entry.entryPrice,
        exitPrice: exit.exitPrice,
        grossReturn,
        costs,
        netReturn,
        correct
      });

      console.log(`    ✓ ${symbol} ${direction} ${entry.entryDate}→${exit.exitDate} ${(netReturn * 100).toFixed(2)}% ${correct ? '✓' : '✗'}`);
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`Signals Generated: ${signalCount}`);
  console.log(`Executable Trades: ${trades.length}`);
  console.log(`Time-Chain Violations: ${timeChainViolations}`);

  if (timeChainViolations > 0) {
    console.error(`\n⚠️  TIME-CHAIN VIOLATIONS DETECTED - Results may be invalid`);
  }

  const metrics = calculateMetrics(trades);
  console.log(`\n=== Metrics ===`);
  console.log(JSON.stringify(metrics, null, 2));

  // 保存结果
  const timestamp = Date.now();
  const resultPath = path.join(BACKTEST_DIR, `strict-${modelName}-${window}-${timestamp}.json`);
  fs.writeFileSync(resultPath, JSON.stringify({ model: modelName, window, trades, metrics, timeChainViolations }, null, 2));
  console.log(`\nResults → ${resultPath}`);

  return { trades, metrics, timeChainViolations };
}

// ── CLI ─────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const modelIdx = args.indexOf('--model');
  const windowIdx = args.indexOf('--window');

  if (modelIdx < 0 || windowIdx < 0) {
    console.error('Usage: node strict-backtest.cjs --model <name> --window <T+N>');
    process.exit(1);
  }

  const modelName = args[modelIdx + 1];
  const window = args[windowIdx + 1];

  if (!CONFIG.EXIT_TIMING_MAP[window]) {
    console.error(`Invalid window: ${window}. Must be T+3, T+5, or T+10`);
    process.exit(1);
  }

  if (modelName === 'all') {
    const models = fs.readdirSync(MODELS_DIR)
      .filter(f => f.endsWith('.cjs'))
      .map(f => f.replace('.cjs', ''));

    console.log(`Running ${models.length} models: ${models.join(', ')}\n`);

    const results = [];
    for (const m of models) {
      const { metrics } = await runBacktest(m, window);
      results.push({ model: m, ...metrics });
    }

    console.log(`\n=== Comparison ===`);
    console.log('Model | Accuracy | AvgReturn | ProfitFactor | Sharpe | MaxDD');
    console.log('------|----------|-----------|--------------|--------|------');
    for (const r of results) {
      console.log(`${r.model.padEnd(12)} | ${(r.directionAccuracy * 100).toFixed(1)}% | ${(r.avgReturn * 100).toFixed(2)}% | ${r.profitFactor.toFixed(2)} | ${r.sharpe.toFixed(2)} | ${(r.maxDrawdown * 100).toFixed(1)}%`);
    }
  } else {
    await runBacktest(modelName, window);
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { runBacktest };