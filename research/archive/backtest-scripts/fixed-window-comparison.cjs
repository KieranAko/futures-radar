#!/usr/bin/env node
/**
 * fixed-window-comparison.cjs — 固定信号日的持仓周期对比
 *
 * 目的：修复T+3 vs T+5混杂问题
 * 方法：
 * 1. 固定signalDate（使用T+10的信号日，确保T+10也能退出）
 * 2. 对同一批signals，分别计算T+3/T+5/T+10退出结果
 * 3. 这样才是真正的持仓周期对比实验
 *
 * Usage: node fixed-window-comparison.cjs --model momentum-ema20-relaxed
 */

const fs = require('fs');
const path = require('path');
const { markUntradableDays } = require('./data-quality.cjs');

const BACKTEST_DIR = __dirname;
const RUNS_DIR = path.join(BACKTEST_DIR, 'runs');
const MODELS_DIR = path.join(BACKTEST_DIR, 'models');

const CONFIG = {
  ENTRY_TIMING: 'T+1_open',
  COMMISSION_RATE: 0.0003,
  SLIPPAGE_RATE: 0.0002,
  LIMIT_THRESHOLD: 0.095,
  MIN_TURNOVER: 1e8,
  MIN_OI: 10000,
  TOP_N: 10
};

// 复用 strict-backtest.cjs 的函数
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

function runScanner(raw, signalDate) {
  const candidates = [];
  for (const [symbol, contract] of Object.entries(raw.contracts)) {
    if (!contract.ohlcv || !contract.ohlcv.dates) continue;
    const { dates, open, high, low, close, volume, openInterest } = contract.ohlcv;
    const signalIdx = dates.indexOf(signalDate);
    if (signalIdx < 0 || signalIdx < 20) continue;

    const truncDates = dates.slice(0, signalIdx + 1);
    const truncOpen = open.slice(0, signalIdx + 1);
    const truncHigh = high.slice(0, signalIdx + 1);
    const truncLow = low.slice(0, signalIdx + 1);
    const truncClose = close.slice(0, signalIdx + 1);
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
      avgTurnover5d,
      avgOI5d,
      _lastDate: truncDates[truncDates.length - 1],
      _dataLength: truncClose.length
    });
  }

  candidates.sort((a, b) => b.atrPct - a.atrPct);
  return candidates.slice(0, CONFIG.TOP_N);
}

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

function simulateEntry(symbol, raw, signalDate) {
  const contract = raw.contracts[symbol];
  if (!contract || !contract.ohlcv) return null;
  const { dates, open, close } = contract.ohlcv;
  const signalIdx = dates.indexOf(signalDate);
  if (signalIdx < 0) return null;

  const entryIdx = signalIdx + 1;
  if (entryIdx >= dates.length) return null;

  const entryDate = dates[entryIdx];
  if (contract._untradableDays && contract._untradableDays.has(entryDate)) {
    return null;
  }

  const signalClose = close[signalIdx];
  const entryOpen = open[entryIdx];
  const gapChange = Math.abs((entryOpen - signalClose) / signalClose);

  if (gapChange >= CONFIG.LIMIT_THRESHOLD) return null;

  return {
    entryDate,
    entryPrice: entryOpen,
    signalIdx,
    entryIdx
  };
}

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

function calculateCosts(entryPrice, exitPrice) {
  const avgPrice = (entryPrice + exitPrice) / 2;
  const commission = avgPrice * CONFIG.COMMISSION_RATE;
  const slippage = entryPrice * CONFIG.SLIPPAGE_RATE * 2;
  return (commission + slippage) / entryPrice;
}

function loadModel(modelName) {
  const modelPath = path.join(MODELS_DIR, `${modelName}.cjs`);
  if (!fs.existsSync(modelPath)) {
    throw new Error(`Model not found: ${modelPath}`);
  }
  return require(modelPath);
}

function loadHistoricalRuns() {
  const runs = [];
  const runDirs = fs.readdirSync(RUNS_DIR).filter(d => d.startsWith('bt-'));

  for (const runDir of runDirs) {
    const rawPath = path.join(RUNS_DIR, runDir, 'raw.json');
    if (!fs.existsSync(rawPath)) continue;

    const raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'));

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

async function runFixedWindowComparison(modelName) {
  console.log(`\n=== Fixed Window Comparison ===`);
  console.log(`Model: ${modelName}`);
  console.log(`Method: Fixed signal date, vary exit window\n`);

  const model = loadModel(modelName);
  const runs = loadHistoricalRuns();

  const results = {
    'T+3': [],
    'T+5': [],
    'T+10': []
  };

  for (const { runId, raw } of runs) {
    const firstContract = Object.values(raw.contracts)[0];
    if (!firstContract || !firstContract.ohlcv) continue;

    const dates = firstContract.ohlcv.dates;

    // 使用T+10的信号日（确保所有窗口都能退出）
    const signalDateIdx = dates.length - 12;
    if (signalDateIdx < 20) continue;

    const signalDate = dates[signalDateIdx];
    console.log(`\n[${runId}] Signal Date: ${signalDate} (idx ${signalDateIdx}/${dates.length})`);

    const candidates = runScanner(raw, signalDate);
    const filtered = runHardFilter(candidates, raw, signalDate);

    if (filtered.length === 0) continue;

    const modelSignals = model.generateSignals(raw, { candidates: filtered }, signalDate);
    console.log(`  Generated ${modelSignals.length} signals`);

    for (const signal of modelSignals) {
      const { symbol, direction } = signal;
      const entry = simulateEntry(symbol, raw, signalDate);
      if (!entry) continue;

      // 对同一个信号，分别计算T+3/T+5/T+10退出
      for (const window of ['T+3', 'T+5', 'T+10']) {
        const holdDays = parseInt(window.replace('T+', ''));
        const exit = simulateExit(symbol, raw, entry.entryIdx, holdDays);
        if (!exit) continue;

        const costs = calculateCosts(entry.entryPrice, exit.exitPrice);
        const directionSign = direction === 'bullish' ? 1 : -1;
        const grossReturn = directionSign * (exit.exitPrice - entry.entryPrice) / entry.entryPrice;
        const netReturn = grossReturn - costs;

        const actualDirection = exit.exitPrice > entry.entryPrice ? 'bullish' : 'bearish';
        const correct = actualDirection === direction;

        results[window].push({
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

        console.log(`    ${window} ${symbol} ${direction} ${(netReturn * 100).toFixed(2)}% ${correct ? '✓' : '✗'}`);
      }
    }
  }

  // 计算每个窗口的指标
  console.log(`\n=== Results ===\n`);

  for (const window of ['T+3', 'T+5', 'T+10']) {
    const trades = results[window];
    if (trades.length === 0) continue;

    const correct = trades.filter(t => t.correct).length;
    const returns = trades.map(t => t.netReturn);
    const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;

    const winReturns = trades.filter(t => t.netReturn > 0).map(t => t.netReturn);
    const lossReturns = trades.filter(t => t.netReturn <= 0).map(t => t.netReturn);

    const avgWin = winReturns.length > 0 ? winReturns.reduce((a, b) => a + b, 0) / winReturns.length : 0;
    const avgLoss = lossReturns.length > 0 ? lossReturns.reduce((a, b) => a + b, 0) / lossReturns.length : 0;

    const totalWin = winReturns.reduce((a, b) => a + b, 0);
    const totalLoss = Math.abs(lossReturns.reduce((a, b) => a + b, 0));
    const profitFactor = totalLoss > 0 ? totalWin / totalLoss : (totalWin > 0 ? 999 : 0);

    const mean = avgReturn;
    const variance = returns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / returns.length;
    const stdDev = Math.sqrt(variance);
    const sharpe = stdDev > 0 ? (avgReturn * Math.sqrt(252)) / stdDev : 0;

    console.log(`${window}:`);
    console.log(`  Trades: ${trades.length}`);
    console.log(`  Direction Accuracy: ${(correct / trades.length * 100).toFixed(1)}%`);
    console.log(`  Avg Return: ${(avgReturn * 100).toFixed(2)}%`);
    console.log(`  Avg Win: ${(avgWin * 100).toFixed(2)}%`);
    console.log(`  Avg Loss: ${(avgLoss * 100).toFixed(2)}%`);
    console.log(`  Profit Factor: ${profitFactor.toFixed(2)}`);
    console.log(`  Sharpe: ${sharpe.toFixed(2)}`);
    console.log('');
  }

  // 保存结果
  const timestamp = Date.now();
  const resultPath = path.join(BACKTEST_DIR, `fixed-window-${modelName}-${timestamp}.json`);
  fs.writeFileSync(resultPath, JSON.stringify({ model: modelName, results }, null, 2));
  console.log(`Results → ${resultPath}`);
}

async function main() {
  const args = process.argv.slice(2);
  const modelIdx = args.indexOf('--model');

  if (modelIdx < 0) {
    console.error('Usage: node fixed-window-comparison.cjs --model <name>');
    process.exit(1);
  }

  const modelName = args[modelIdx + 1];
  await runFixedWindowComparison(modelName);
}

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { runFixedWindowComparison };
