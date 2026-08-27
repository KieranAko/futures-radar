#!/usr/bin/env node
/**
 * random-selection-v3.cjs — V3 Random Selection Experiment
 *
 * 修复 V2 的所有错误：
 * 1. 候选池现场重算，数据严格截断至 signalDate（无未来泄漏）
 * 2. Null A 复用原模型方向函数（momentum-ema20-relaxed.generateSignals）
 * 3. 30/70 完整 cohort，不静默删除日期
 * 4. 统一成本函数（shared-backtest-lib.calculateCosts）
 * 5. 完整 30 日审计 trail
 * 6. Entry gap check
 * 7. 补抽机制：候选失败时从剩余池中无放回抽取
 *
 * Usage: node random-selection-v3.cjs
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BACKTEST_DIR = __dirname;
const RUNS_DIR = path.join(BACKTEST_DIR, 'runs');

const {
  runScanner,
  runHardFilter,
  simulateEntry,
  simulateExit,
  calculateCosts,
  CONFIG
} = require('./shared-backtest-lib.cjs');

// ─── Scanner variant: return ALL liquid candidates (no Top 10 cutoff) ──

const { calculateATR, calculateHV, calculateSMA, calculateChange5d, calculateVsMA } = (() => {
  // Re-import indicator helpers inline for the full scanner
  function _atr(high, low, close, period = 14) {
    if (close.length < period + 1) return null;
    const tr = [];
    for (let i = 1; i < close.length; i++) {
      tr.push(Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1])));
    }
    if (tr.length < period) return null;
    const recent = tr.slice(-period);
    return recent.reduce((a, b) => a + b, 0) / recent.length;
  }
  function _hv(close, period = 5) {
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
  function _sma(arr, period) {
    if (arr.length < period) return null;
    const slice = arr.slice(-period);
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  }
  function _c5d(close) {
    if (close.length < 6) return null;
    const len = close.length;
    return ((close[len - 1] - close[len - 6]) / close[len - 6]) * 100;
  }
  function _vsma(price, ma) {
    if (ma === null || ma === 0) return null;
    return ((price - ma) / ma) * 100;
  }
  return {
    calculateATR: _atr, calculateHV: _hv, calculateSMA: _sma,
    calculateChange5d: _c5d, calculateVsMA: _vsma
  };
})();

function runScannerFull(raw, signalDate) {
  const candidates = [];
  for (const [symbol, contract] of Object.entries(raw.contracts)) {
    if (!contract.ohlcv || !contract.ohlcv.dates) continue;
    const { dates, high, low, close, volume, openInterest } = contract.ohlcv;
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

    candidates.push({
      symbol, name: contract.name, sector: contract.sector,
      price: currentPrice, atr14, atrPct, hv5, hv20, hvRatio,
      ma20, ma60, vsMA20, vsMA60, change5d,
      avgTurnover5d, avgOI5d,
      _lastDate: dates[signalIdx]
    });
  }
  candidates.sort((a, b) => b.atrPct - a.atrPct);
  return candidates; // ALL liquid candidates, not just Top 10
}

const model = require('./models/momentum-ema20-relaxed.cjs');

// ─── RNG ─────────────────────────────────────────────────

function createRNG(seed) {
  let rng = seed;
  return () => {
    rng = (rng * 1103515245 + 12345) & 0x7fffffff;
    return rng / 0x7fffffff;
  };
}

function fisherYatesShuffle(array, random) {
  const result = array.slice();
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// ─── Load data ──────────────────────────────────────────

function loadAllRuns() {
  const rawMap = new Map();
  const runDirs = fs.readdirSync(RUNS_DIR).filter(d => d.startsWith('bt-'));
  for (const runDir of runDirs) {
    const rawPath = path.join(RUNS_DIR, runDir, 'raw.json');
    if (!fs.existsSync(rawPath)) continue;
    const raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
    rawMap.set(runDir, raw);
  }
  return rawMap;
}

function getSignalDate(raw, runId) {
  const firstContract = Object.values(raw.contracts)[0];
  if (!firstContract || !firstContract.ohlcv) return null;
  const dates = firstContract.ohlcv.dates;
  const exitDateStr = runId.replace('bt-', '');
  const exitDateFormatted = exitDateStr.substring(0, 4) + '-' +
                             exitDateStr.substring(4, 6) + '-' +
                             exitDateStr.substring(6, 8);
  const exitIdx = dates.indexOf(exitDateFormatted);
  if (exitIdx < 0) return null;
  const signalIdx = exitIdx - 11;
  if (signalIdx < 20) return null;
  return { signalDate: dates[signalIdx], signalIdx, exitIdx, exitDateFormatted };
}

// ─── Execute one trade ──────────────────────────────────

function executeTrade(symbol, direction, raw, signalDate) {
  const entry = simulateEntry(symbol, raw, signalDate);
  if (!entry) return null;

  const exit = simulateExit(symbol, raw, entry.entryIdx, 10);
  if (!exit) return null;

  const costs = calculateCosts(entry.entryPrice, exit.exitPrice);
  const directionSign = direction === 'bullish' ? 1 : -1;
  const grossReturn = directionSign * (exit.exitPrice - entry.entryPrice) / entry.entryPrice;
  const netReturn = grossReturn - costs;

  return {
    symbol, direction,
    entryDate: entry.entryDate,
    exitDate: exit.exitDate,
    entryPrice: entry.entryPrice,
    exitPrice: exit.exitPrice,
    grossReturn, costs, netReturn,
    correct: netReturn > 0
  };
}

// ─── Null runner ────────────────────────────────────────

function runNullExperiment(runMap, observedTrades, nullType, seeds = 1000) {
  console.log(`\n=== Null ${nullType.toUpperCase()} ===\n`);

  const observedRunIds = [...new Set(observedTrades.map(t => t.runId))].sort();

  // Pre-compute per-run data
  const runData = [];
  for (const runId of observedRunIds) {
    const raw = runMap.get(runId);
    if (!raw) {
      console.log(`  ${runId}: raw not found — SKIP`);
      continue;
    }

    const sd = getSignalDate(raw, runId);
    if (!sd) {
      console.log(`  ${runId}: cannot determine signalDate — SKIP`);
      continue;
    }

    const candidates = runScanner(raw, sd.signalDate); // Top 10 by ATR%
    const allLiquid = runScannerFull(raw, sd.signalDate); // ALL liquid candidates
    const filtered = runHardFilter(candidates, raw, sd.signalDate);

    const obsCount = observedTrades.filter(t => t.runId === runId).length;
    const modelSignals = model.generateSignals(raw, { candidates: filtered }, sd.signalDate);
    // Model signals on ALL liquid candidates (not just Top 10)
    const allHardFiltered = runHardFilter(allLiquid, raw, sd.signalDate);
    const allLiquidModelSignals = model.generateSignals(raw, { candidates: allHardFiltered }, sd.signalDate);

    runData.push({
      runId, raw, signalDate: sd.signalDate,
      allLiquidCandidates: allLiquid,
      filtered, modelSignals, obsCount,
      liquidCount: allLiquid.length,
      allLiquidModelSignalCount: allLiquidModelSignals.length,
      poolHash: crypto.createHash('sha256')
        .update(filtered.map(c => c.symbol).sort().join(','))
        .digest('hex').substring(0, 8)
    });
  }

  console.log(`  Dates with data: ${runData.length}`);
  console.log(`  Total target trades: ${runData.reduce((a, r) => a + r.obsCount, 0)}`);

  const nullReturns = [];
  const coverageFailures = [];
  const fullAudit = []; // Complete audit for first successful seed

  for (let seed = 1; seed <= seeds; seed++) {
    const random = createRNG(seed);
    const seedTrades = [];
    let coverageFailed = false;

    for (const rd of runData) {
      let pool, directionSource;

      if (nullType === 'A') {
        // Null A: Model direction on ALL liquid candidates, then random selection
        // 1. Apply hard filter to all liquid candidates
        // 2. Apply model direction (same function/thresholds as observed)
        // 3. Randomly select targetCount from all model-valid signals
        // Tests whether ATR% Top 10 ranking (observed) beats random selection from
        // the full set of model-eligible candidates.
        const hardFiltered = runHardFilter(rd.allLiquidCandidates, rd.raw, rd.signalDate);
        const nullModelSignals = model.generateSignals(rd.raw, { candidates: hardFiltered }, rd.signalDate);

        if (nullModelSignals.length < rd.obsCount) {
          coverageFailed = true;
          break;
        }

        const shuffledSignals = fisherYatesShuffle(nullModelSignals, random);
        const selected = shuffledSignals.slice(0, rd.obsCount);

        for (const s of selected) {
          const trade = executeTrade(s.symbol, s.direction, rd.raw, rd.signalDate);
          if (!trade) {
            let found = false;
            for (let j = rd.obsCount; j < shuffledSignals.length; j++) {
              const retry = executeTrade(shuffledSignals[j].symbol, shuffledSignals[j].direction, rd.raw, rd.signalDate);
              if (retry) { seedTrades.push(retry); found = true; break; }
            }
            if (!found) { coverageFailed = true; break; }
          } else {
            seedTrades.push(trade);
          }
        }
      } else {
        // Null B: Random selection from ALL liquid + random direction
        // 1. Apply hard filter to all liquid candidates
        // 2. Randomly select targetCount + assign random direction
        const hardFiltered = runHardFilter(rd.allLiquidCandidates, rd.raw, rd.signalDate);

        if (hardFiltered.length < rd.obsCount) {
          coverageFailed = true;
          break;
        }

        const shuffledFiltered = fisherYatesShuffle(hardFiltered, random);
        const selected = shuffledFiltered.slice(0, rd.obsCount);

        for (const s of selected) {
          const direction = random() < 0.5 ? 'bullish' : 'bearish';
          const trade = executeTrade(s.symbol, direction, rd.raw, rd.signalDate);
          if (!trade) {
            let found = false;
            for (let j = rd.obsCount; j < shuffledFiltered.length; j++) {
              const d = random() < 0.5 ? 'bullish' : 'bearish';
              const retry = executeTrade(shuffledFiltered[j].symbol, d, rd.raw, rd.signalDate);
              if (retry) { seedTrades.push(retry); found = true; break; }
            }
            if (!found) { coverageFailed = true; break; }
          } else {
            seedTrades.push(trade);
          }
        }
      }

      if (coverageFailed) break;
    }

    if (coverageFailed) {
      coverageFailures.push(seed);
    } else {
      const avgReturn = seedTrades.reduce((a, b) => a + b.netReturn, 0) / seedTrades.length;
      nullReturns.push(avgReturn);
    }

    // Save complete audit for first successful seed
    if (seed === 1 && !coverageFailed) {
      for (const rd of runData) {
        fullAudit.push({
          runId: rd.runId,
          signalDate: rd.signalDate,
          liquidCount: rd.liquidCount,
          observedCount: rd.obsCount,
          poolHash: rd.poolHash,
          selected: seedTrades.filter(t => {
            const entry = simulateEntry(t.symbol, rd.raw, rd.signalDate);
            return entry && entry.entryDate === t.entryDate;
          }).map(t => `${t.symbol}:${t.direction}`)
        });
      }
    }

    if (seed % 200 === 0) {
      console.log(`  ${seed}/${seeds} (failures: ${coverageFailures.length})`);
    }
  }

  console.log(`\n  Completed ${seeds} seeds`);
  console.log(`  Coverage failures: ${coverageFailures.length}/${seeds}`);
  console.log(`  Valid seeds: ${nullReturns.length}`);

  // Statistics
  const observedAvg = observedTrades.reduce((a, b) => a + b.netReturn, 0) / observedTrades.length;
  const nullMean = nullReturns.reduce((a, b) => a + b, 0) / nullReturns.length;
  const nullStd = Math.sqrt(nullReturns.reduce((a, b) => a + Math.pow(b - nullMean, 2), 0) / nullReturns.length);
  const nullBetterCount = nullReturns.filter(r => r >= observedAvg).length;
  const empiricalP = (1 + nullBetterCount) / (nullReturns.length + 1);

  console.log(`\n  ── Results ──`);
  console.log(`  Observed avg return: ${(observedAvg * 100).toFixed(3)}%`);
  console.log(`  Null mean:          ${(nullMean * 100).toFixed(3)}%`);
  console.log(`  Null std:           ${(nullStd * 100).toFixed(3)}%`);
  console.log(`  Null better:        ${nullBetterCount}/${nullReturns.length}`);
  console.log(`  Empirical p-value:  ${empiricalP.toFixed(4)}`);

  return {
    type: `random_selection_v3_null${nullType}`,
    observedCount: observedTrades.length,
    nullCount: nullReturns.length,
    coverageFailures: coverageFailures.length,
    observedAvgReturn: observedAvg,
    nullMean, nullStd, nullBetterCount,
    empiricalP,
    fullAudit,
    nullReturns,
    coverageFailureSeeds: coverageFailures.slice(0, 20),
    timestamp: new Date().toISOString()
  };
}

// ─── Main ───────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║  V3 RANDOM SELECTION — Gate E              ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  // Load observed trades
  const fwFiles = fs.readdirSync(BACKTEST_DIR)
    .filter(f => f.startsWith('fixed-window-momentum-') && f.endsWith('.json'))
    .sort((a, b) => {
      const aTime = fs.statSync(path.join(BACKTEST_DIR, a)).mtime;
      const bTime = fs.statSync(path.join(BACKTEST_DIR, b)).mtime;
      return bTime - aTime;
    });

  const fwPath = path.join(BACKTEST_DIR, fwFiles[0]);
  console.log(`Observed: ${fwFiles[0]}\n`);

  const fwData = JSON.parse(fs.readFileSync(fwPath, 'utf8'));
  const observedTrades = fwData.results['T+10'] || [];
  console.log(`Observed T+10 trades: ${observedTrades.length}\n`);

  const runMap = loadAllRuns();
  console.log(`Loaded ${runMap.size} historical runs\n`);

  // ── Null A ──
  console.log('═'.repeat(60));
  const resultA = runNullExperiment(runMap, observedTrades, 'A', 1000);

  // ── Null B ──
  console.log('\n' + '═'.repeat(60));
  const resultB = runNullExperiment(runMap, observedTrades, 'B', 1000);

  // ── Save ──
  const outA = path.join(BACKTEST_DIR, `random-selection-v3-nullA-t+10-${Date.now()}.json`);
  fs.writeFileSync(outA, JSON.stringify(resultA, null, 2));
  console.log(`\nNull A → ${path.basename(outA)}`);

  const outB = path.join(BACKTEST_DIR, `random-selection-v3-nullB-t+10-${Date.now()}.json`);
  fs.writeFileSync(outB, JSON.stringify(resultB, null, 2));
  console.log(`Null B → ${path.basename(outB)}`);

  // ── Summary ──
  console.log('\n═══════════════════════════════════════════════');
  console.log('V3 RANDOM SELECTION COMPLETE');
  console.log('═══════════════════════════════════════════════');
  console.log(`Null A p-value: ${resultA.empiricalP.toFixed(4)} (${resultA.coverageFailures} failures)`);
  console.log(`Null B p-value: ${resultB.empiricalP.toFixed(4)} (${resultB.coverageFailures} failures)`);
}

main().catch(err => { console.error(err); process.exit(1); });
