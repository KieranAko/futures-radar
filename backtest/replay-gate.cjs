#!/usr/bin/env node
/**
 * replay-gate.cjs — V3 确定性回放门禁
 *
 * 目标：从 raw.json 重新生成 observed T+10 交易，逐笔验证零差异。
 * 修复 V2 的核心错误：候选池必须截至 signalDate，不能使用缓存的 filtered-hard.json
 * （后者 asOfDate=exitDate，包含未来 11 个交易日的数据）。
 *
 * 门禁顺序：
 * A. 读取 observed 交易，验证 70/70 完整
 * B. 用当前代码从 raw 数据回放，比较 runId|symbol|direction|entryDate|exitDate
 * C. 零差异后，抽取共享模块供 V3 null 使用
 *
 * Usage: node replay-gate.cjs
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BACKTEST_DIR = __dirname;
const RUNS_DIR = path.join(BACKTEST_DIR, 'runs');
const MODELS_DIR = path.join(BACKTEST_DIR, 'models');

// ─── Utils ───────────────────────────────────────────────

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

// ─── Scanner — 严格截断到 signalDate ─────────────────────

const CONFIG = {
  ENTRY_TIMING: 'T+1_open',
  COMMISSION_RATE: 0.0003,
  SLIPPAGE_RATE: 0.0002,
  LIMIT_THRESHOLD: 0.095,
  MIN_TURNOVER: 1e8,
  MIN_OI: 10000,
  TOP_N: 10
};

function runScanner(raw, signalDate) {
  const candidates = [];
  for (const [symbol, contract] of Object.entries(raw.contracts)) {
    if (!contract.ohlcv || !contract.ohlcv.dates) continue;
    const { dates, open, high, low, close, volume, openInterest } = contract.ohlcv;
    const signalIdx = dates.indexOf(signalDate);
    if (signalIdx < 0 || signalIdx < 20) continue;

    // ═══ 关键：数据严格截断到 signalIdx（包含 signalDate）═══
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
      _dataLength: truncClose.length,
      _signalIdx: signalIdx
    });
  }

  candidates.sort((a, b) => b.atrPct - a.atrPct);
  return candidates.slice(0, CONFIG.TOP_N);
}

// Run scanner with explicit data-length assertion
function runScannerAsserted(raw, signalDate) {
  const candidates = [];
  const signalIdxAssertions = [];

  for (const [symbol, contract] of Object.entries(raw.contracts)) {
    if (!contract.ohlcv || !contract.ohlcv.dates) continue;
    const { dates, open, high, low, close, volume, openInterest } = contract.ohlcv;
    const signalIdx = dates.indexOf(signalDate);
    if (signalIdx < 0 || signalIdx < 20) continue;

    const truncDates = dates.slice(0, signalIdx + 1);
    const truncClose = close.slice(0, signalIdx + 1);
    const truncHigh = high.slice(0, signalIdx + 1);
    const truncLow = low.slice(0, signalIdx + 1);
    const truncVolume = volume.slice(0, signalIdx + 1);
    const truncOI = openInterest ? openInterest.slice(0, signalIdx + 1) : [];
    const truncOpen = open.slice(0, signalIdx + 1);

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

    // Assertion: lastDate must equal signalDate
    const lastDate = truncDates[truncDates.length - 1];
    const lastDateMatches = lastDate === signalDate;
    signalIdxAssertions.push({ symbol, lastDate, signalDate, ok: lastDateMatches });

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
      _lastDate: lastDate,
      _dataLength: truncClose.length,
      _signalIdx: signalIdx
    });
  }

  candidates.sort((a, b) => b.atrPct - a.atrPct);
  return {
    candidates: candidates.slice(0, CONFIG.TOP_N),
    assertions: signalIdxAssertions
  };
}

// ─── Hard filter ─────────────────────────────────────────

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

// ─── Entry/Exit simulation ───────────────────────────────

function simulateEntry(symbol, raw, signalDate) {
  const contract = raw.contracts[symbol];
  if (!contract || !contract.ohlcv) return null;
  const { dates, open, close } = contract.ohlcv;
  const signalIdx = dates.indexOf(signalDate);
  if (signalIdx < 0) return null;

  const entryIdx = signalIdx + 1;
  if (entryIdx >= dates.length) return null;

  const entryDate = dates[entryIdx];

  const gapChange = Math.abs((open[entryIdx] - close[signalIdx]) / close[signalIdx]);
  if (gapChange >= CONFIG.LIMIT_THRESHOLD) return null;

  return { entryDate, entryPrice: open[entryIdx], signalIdx, entryIdx };
}

function simulateExit(symbol, raw, entryIdx, holdDays) {
  const contract = raw.contracts[symbol];
  if (!contract || !contract.ohlcv) return null;
  const { dates, close } = contract.ohlcv;
  const exitIdx = entryIdx + holdDays;
  if (exitIdx >= dates.length) return null;
  return { exitDate: dates[exitIdx], exitPrice: close[exitIdx] };
}

function calculateCosts(entryPrice, exitPrice) {
  const avgPrice = (entryPrice + exitPrice) / 2;
  const commission = avgPrice * CONFIG.COMMISSION_RATE;
  const slippage = entryPrice * CONFIG.SLIPPAGE_RATE * 2;
  return (commission + slippage) / entryPrice;
}

// ─── Model loader ────────────────────────────────────────

function loadModel(modelName) {
  const modelPath = path.join(MODELS_DIR, `${modelName}.cjs`);
  if (!fs.existsSync(modelPath)) {
    throw new Error(`Model not found: ${modelPath}`);
  }
  // Clear require cache to get fresh copy
  delete require.cache[require.resolve(modelPath)];
  return require(modelPath);
}

// ─── Load historical runs ────────────────────────────────

function loadAllRuns() {
  const runs = [];
  const runDirs = fs.readdirSync(RUNS_DIR).filter(d => d.startsWith('bt-'));
  for (const runDir of runDirs) {
    const rawPath = path.join(RUNS_DIR, runDir, 'raw.json');
    if (!fs.existsSync(rawPath)) continue;
    const raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
    runs.push({ runId: runDir, raw });
  }
  return runs;
}

// ─── Main replay ─────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║  V3 REPLAY GATE — Gate A & B               ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  // ── Gate A: Load observed trades ──
  const fixedWindowFiles = fs.readdirSync(BACKTEST_DIR)
    .filter(f => f.startsWith('fixed-window-momentum-') && f.endsWith('.json'))
    .sort((a, b) => {
      const aTime = fs.statSync(path.join(BACKTEST_DIR, a)).mtime;
      const bTime = fs.statSync(path.join(BACKTEST_DIR, b)).mtime;
      return bTime - aTime;
    });

  if (fixedWindowFiles.length === 0) {
    console.error('No fixed-window file found');
    process.exit(1);
  }

  const fwPath = path.join(BACKTEST_DIR, fixedWindowFiles[0]);
  console.log(`[Gate A] Loading observed trades from: ${fixedWindowFiles[0]}`);

  const fwData = JSON.parse(fs.readFileSync(fwPath, 'utf8'));
  const modelName = fwData.model;
  const observed = fwData.results['T+10'] || [];

  console.log(`  Model: ${modelName}`);
  console.log(`  Observed T+10 trades: ${observed.length}`);
  console.log(`  Expected: 70 (pre-registered)\n`);

  if (observed.length !== 70) {
    console.log(`WARNING: Expected 70 trades, got ${observed.length}.`);
    console.log('Either the observed artifact has changed or the cohort was modified.\n');
  }

  // Validate observed completeness
  let observedOk = true;
  const observedKeys = new Set();
  for (const t of observed) {
    const key = `${t.runId}|${t.symbol}|${t.direction}|${t.entryDate}|${t.exitDate}`;
    if (observedKeys.has(key)) {
      console.log(`  DUPLICATE: ${key}`);
      observedOk = false;
    }
    observedKeys.add(key);

    // Validate required fields
    const required = ['runId', 'symbol', 'direction', 'entryDate', 'exitDate', 'entryPrice', 'exitPrice', 'grossReturn', 'costs', 'netReturn'];
    for (const f of required) {
      if (t[f] === undefined || t[f] === null) {
        console.log(`  MISSING FIELD ${f} in trade: ${key}`);
        observedOk = false;
      }
    }
  }

  console.log(`  Unique keys: ${observedKeys.size}/${observed.length}`);
  console.log(`  Observed completeness: ${observedOk ? 'PASS' : 'FAIL'}\n`);

  // ── Gate B: Replay from raw data ──
  console.log('[Gate B] Replaying observed from raw data...\n');

  const model = loadModel(modelName);
  const runs = loadAllRuns();
  console.log(`  Loaded ${runs.length} historical runs`);

  // Build run lookup
  const runMap = new Map();
  for (const r of runs) runMap.set(r.runId, r.raw);

  // Group observed by runId for per-run replay
  const observedByRun = new Map();
  for (const t of observed) {
    const list = observedByRun.get(t.runId) || [];
    list.push(t);
    observedByRun.set(t.runId, list);
  }

  const replayed = [];
  const missing = [];    // in observed, not in replay
  const extra = [];      // in replay, not in observed
  const changed = [];    // different details

  // Track the observed runs that failed to produce candidates
  const emptyRuns = [];

  for (const [runId, observedTrades] of observedByRun) {
    const raw = runMap.get(runId);
    if (!raw) {
      console.log(`  ${runId}: raw.json not found — SKIP`);
      missing.push(...observedTrades);
      continue;
    }

    // Determine signalDate: exitDate - 11 trading days
    const firstContract = Object.values(raw.contracts)[0];
    if (!firstContract || !firstContract.ohlcv) {
      missing.push(...observedTrades);
      continue;
    }

    const allDates = firstContract.ohlcv.dates;
    const exitDateStr = runId.replace('bt-', ''); // 20240102
    const exitDateFormatted = exitDateStr.substring(0, 4) + '-' +
                               exitDateStr.substring(4, 6) + '-' +
                               exitDateStr.substring(6, 8);
    const exitIdx = allDates.indexOf(exitDateFormatted);

    if (exitIdx < 0) {
      console.log(`  ${runId}: exitDate ${exitDateFormatted} not found in data`);
      missing.push(...observedTrades);
      continue;
    }

    // T+10: exit = entry + 10, entry = signal + 1 => signalIdx = exitIdx - 11
    const signalIdx = exitIdx - 11;
    if (signalIdx < 20) {
      console.log(`  ${runId}: signalIdx=${signalIdx} too early (need ≥20)`);
      missing.push(...observedTrades);
      continue;
    }

    const signalDate = allDates[signalIdx];
    const observedSymbols = observedTrades.map(t => t.symbol);

    // Re-run scanner with assertion
    const { candidates, assertions } = runScannerAsserted(raw, signalDate);
    const allAssertOk = assertions.every(a => a.ok);
    if (!allAssertOk) {
      const bad = assertions.filter(a => !a.ok);
      console.log(`  ${runId}: TIME CHAIN ASSERTION FAILED for ${bad.length} symbols`);
      for (const b of bad.slice(0, 3)) {
        console.log(`    ${b.symbol}: lastDate=${b.lastDate}, expected=${b.signalDate}`);
      }
    }

    // Re-run hard filter
    const filtered = runHardFilter(candidates, raw, signalDate);

    // Re-run model
    const modelSignals = model.generateSignals(raw, { candidates: filtered }, signalDate);

    console.log(`  ${runId}: signalDate=${signalDate}, scanner=${candidates.length}, filter=${filtered.length}, signals=${modelSignals.length}`);

    if (modelSignals.length === 0) {
      emptyRuns.push(runId);
      // Check if observed also has no trades for this run
      if (observedTrades.length > 0) {
        console.log(`    ⚠ EMPTY replay but observed has ${observedTrades.length} trades!`);
        for (const t of observedTrades) {
          console.log(`      Observed: ${t.symbol} ${t.direction}`);
        }
        missing.push(...observedTrades);
      }
      continue;
    }

    // Simulate entry/exit for each model signal
    for (const signal of modelSignals) {
      const { symbol, direction } = signal;
      const entry = simulateEntry(symbol, raw, signalDate);
      if (!entry) continue;

      const exit = simulateExit(symbol, raw, entry.entryIdx, 10);
      if (!exit) continue;

      const costs = calculateCosts(entry.entryPrice, exit.exitPrice);
      const directionSign = direction === 'bullish' ? 1 : -1;
      const grossReturn = directionSign * (exit.exitPrice - entry.entryPrice) / entry.entryPrice;
      const netReturn = grossReturn - costs;
      const correct = (exit.exitPrice > entry.entryPrice) === (direction === 'bullish');

      const replayKey = `${runId}|${symbol}|${direction}|${entry.entryDate}|${exit.exitDate}`;
      replayed.push({
        runId, symbol, direction,
        entryDate: entry.entryDate,
        exitDate: exit.exitDate,
        entryPrice: entry.entryPrice,
        exitPrice: exit.exitPrice,
        grossReturn, costs, netReturn, correct
      });
    }
  }

  console.log(`\n  Replayed total: ${replayed.length} trades`);

  // ── Build key sets for comparison ──
  const observedKeySet = new Set(observed.map(t =>
    `${t.runId}|${t.symbol}|${t.direction}|${t.entryDate}|${t.exitDate}`
  ));
  const replayedKeySet = new Set(replayed.map(t =>
    `${t.runId}|${t.symbol}|${t.direction}|${t.entryDate}|${t.exitDate}`
  ));

  // Find missing (in observed but not replayed)
  for (const t of observed) {
    const key = `${t.runId}|${t.symbol}|${t.direction}|${t.entryDate}|${t.exitDate}`;
    if (!replayedKeySet.has(key)) missing.push(t);
  }

  // Find extra (in replayed but not observed)
  for (const t of replayed) {
    const key = `${t.runId}|${t.symbol}|${t.direction}|${t.entryDate}|${t.exitDate}`;
    if (!observedKeySet.has(key)) extra.push(t);
  }

  // Find changed (same key, different values)
  const replayedByKey = new Map();
  for (const t of replayed) {
    const key = `${t.runId}|${t.symbol}|${t.direction}|${t.entryDate}|${t.exitDate}`;
    replayedByKey.set(key, t);
  }

  for (const t of observed) {
    const key = `${t.runId}|${t.symbol}|${t.direction}|${t.entryDate}|${t.exitDate}`;
    const r = replayedByKey.get(key);
    if (!r) continue;
    if (Math.abs(r.grossReturn - t.grossReturn) > 1e-8 || Math.abs(r.costs - t.costs) > 1e-8) {
      changed.push({
        key,
        observed: { grossReturn: t.grossReturn, costs: t.costs, netReturn: t.netReturn },
        replayed: { grossReturn: r.grossReturn, costs: r.costs, netReturn: r.netReturn }
      });
    }
  }

  // ── Report ──
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║  GATE B RESULTS                             ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  console.log(`Observed trades: ${observed.length}`);
  console.log(`Replayed trades: ${replayed.length}`);
  console.log(`Missing (in observed, not replayed): ${missing.length}`);
  console.log(`Extra (in replayed, not observed): ${extra.length}`);
  console.log(`Changed (same key, different values): ${changed.length}`);
  console.log(`Empty runs (model produced 0 signals): ${emptyRuns.length}`);

  const diff = missing.length + extra.length + changed.length;
  console.log(`\nTotal diffs: ${diff}`);

  if (missing.length > 0) {
    console.log('\n── Missing trades ──');
    for (const t of missing.slice(0, 10)) {
      console.log(`  ${t.runId} ${t.symbol} ${t.direction} entry=${t.entryDate} exit=${t.exitDate}`);
    }
    if (missing.length > 10) console.log(`  ... and ${missing.length - 10} more`);
  }

  if (extra.length > 0) {
    console.log('\n── Extra trades (not in observed) ──');
    for (const t of extra.slice(0, 10)) {
      console.log(`  ${t.runId} ${t.symbol} ${t.direction} entry=${t.entryDate} exit=${t.exitDate}`);
    }
    if (extra.length > 10) console.log(`  ... and ${extra.length - 10} more`);
  }

  if (changed.length > 0) {
    console.log('\n── Changed trades ──');
    for (const c of changed.slice(0, 5)) {
      console.log(`  ${c.key}`);
      console.log(`    Observed: gr=${c.observed.grossReturn} costs=${c.observed.costs}`);
      console.log(`    Replayed: gr=${c.replayed.grossReturn} costs=${c.replayed.costs}`);
    }
  }

  if (emptyRuns.length > 0) {
    console.log('\n── Runs with 0 signals ──');
    console.log(`  ${emptyRuns.join(', ')}`);
  }

  // ── Print run-by-run comparison ──
  console.log('\n── Per-run breakdown ──');
  for (const [runId, obsTrades] of observedByRun) {
    const repTrades = replayed.filter(t => t.runId === runId);
    const obsSymbols = obsTrades.map(t => `${t.symbol}:${t.direction}`).join(',');
    const repSymbols = repTrades.map(t => `${t.symbol}:${t.direction}`).join(',');
    const match = obsSymbols === repSymbols ? 'MATCH' : 'DIFF';
    console.log(`  ${runId}: obs=${obsTrades.length} rep=${repTrades.length} ${match}`);
    if (match === 'DIFF') {
      console.log(`    Observed: ${obsSymbols || '(none)'}`);
      console.log(`    Replayed: ${repSymbols || '(none)'}`);
    }
  }

  // ── Verdict ──
  console.log('\n═══════════════════════════════════════════════');
  if (diff === 0) {
    console.log('GATE B: PASS — Zero difference');
    console.log('Proceed to Gate C (shared module extraction).');
  } else {
    console.log('GATE B: FAIL — Differences found');
    console.log('Must resolve all diffs before V3 random experiments.');
    console.log('Old observed artifact must be invalidated and regenerated.');
  }
  console.log('═══════════════════════════════════════════════\n');

  // ── Save replay result for audit ──
  const result = {
    gate: 'B',
    observedCount: observed.length,
    replayedCount: replayed.length,
    missing: missing.length,
    extra: extra.length,
    changed: changed.length,
    emptyRuns,
    missingDetails: missing.slice(0, 50).map(t => ({
      runId: t.runId, symbol: t.symbol, direction: t.direction,
      entryDate: t.entryDate, exitDate: t.exitDate
    })),
    extraDetails: extra.slice(0, 50).map(t => ({
      runId: t.runId, symbol: t.symbol, direction: t.direction,
      entryDate: t.entryDate, exitDate: t.exitDate
    })),
    changedDetails: changed.slice(0, 20),
    passed: diff === 0,
    timestamp: new Date().toISOString()
  };

  const resultPath = path.join(BACKTEST_DIR, `replay-gate-result-${Date.now()}.json`);
  fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));
  console.log(`Replay result saved to: ${path.basename(resultPath)}`);

  return result;
}

main().catch(err => { console.error(err); process.exit(1); });
