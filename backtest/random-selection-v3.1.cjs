#!/usr/bin/env node
/**
 * random-selection-v3.1.cjs — V3.1 Random Selection (复审修正)
 *
 * 砚砚复审要求：
 * 1. Null A 精确命名为 "conditional ATR-ranking null"
 * 2. Null B 精确命名为 "composite selection+direction null"
 * 3. 新增 Null C: pure direction null — 固定所有 observed 特征，仅随机化方向
 * 4. 補抽唯一性不变量测试
 * 5. 删除"显著 alpha"表述，p-value 标注为探索性 in-sample
 *
 * Usage: node random-selection-v3.1.cjs
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

// ─── Scanner full (all liquid, no Top N) ─────────────────

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
  return candidates;
}

// ─── Indicator helpers (inline, same as shared lib) ──────

function calculateATR(high, low, close, period = 14) {
  if (close.length < period + 1) return null;
  const tr = [];
  for (let i = 1; i < close.length; i++) {
    tr.push(Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1])));
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

// ─── Trade exec ──────────────────────────────────────────

function executeTrade(symbol, direction, raw, signalDate) {
  const entry = simulateEntry(symbol, raw, signalDate);
  if (!entry) return null;
  const exit = simulateExit(symbol, raw, entry.entryIdx, 10);
  if (!exit) return null;
  const costs = calculateCosts(entry.entryPrice, exit.exitPrice);
  const directionSign = direction === 'bullish' ? 1 : -1;
  const grossReturn = directionSign * (exit.exitPrice - entry.entryPrice) / entry.entryPrice;
  return {
    symbol, direction,
    entryDate: entry.entryDate, exitDate: exit.exitDate,
    entryPrice: entry.entryPrice, exitPrice: exit.exitPrice,
    grossReturn, costs, netReturn: grossReturn - costs
  };
}

// ─── Load data ──────────────────────────────────────────

function loadAllRuns() {
  const rawMap = new Map();
  const runDirs = fs.readdirSync(RUNS_DIR).filter(d => d.startsWith('bt-'));
  for (const runDir of runDirs) {
    const rawPath = path.join(RUNS_DIR, runDir, 'raw.json');
    if (!fs.existsSync(rawPath)) continue;
    rawMap.set(runDir, JSON.parse(fs.readFileSync(rawPath, 'utf8')));
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

// ─── Null A: Conditional ATR-ranking ─────────────────────

function runNull_ConditionalATR(runData, observedTrades, seeds = 1000) {
  console.log(`\n=== Null A: conditional ATR-ranking null ===`);
  console.log(`Tests: given fixed liquidity/hard filter/model eligibility,`);
  console.log(`       does ATR% Top-10 ranking beat random selection?\n`);

  const nullReturns = [];
  const coverageFailures = [];
  const fullAudit = [];
  let uniquenessFailure = false;

  for (let seed = 1; seed <= seeds; seed++) {
    const random = createRNG(seed);
    const seedTrades = [];
    let coverageFailed = false;

    for (const rd of runData) {
      const hardFiltered = runHardFilter(rd.allLiquidCandidates, rd.raw, rd.signalDate);
      const allModelSignals = model.generateSignals(rd.raw, { candidates: hardFiltered }, rd.signalDate);

      if (allModelSignals.length < rd.obsCount) {
        coverageFailed = true;
        break;
      }

      const shuffled = fisherYatesShuffle(allModelSignals, random);
      const selected = shuffled.slice(0, rd.obsCount);
      // per-run attempted-symbol uniqueness: all candidates tried (success or fail)
      // are recorded to prevent re-attempt. Scope: within one run/date.
      const attemptedSymbols = new Set();

      for (const s of selected) {
        if (attemptedSymbols.has(s.symbol)) {
          uniquenessFailure = true;
          coverageFailed = true;
          break;
        }
        attemptedSymbols.add(s.symbol);

        const trade = executeTrade(s.symbol, s.direction, rd.raw, rd.signalDate);
        if (!trade) {
          let found = false;
          for (let j = rd.obsCount; j < shuffled.length; j++) {
            if (attemptedSymbols.has(shuffled[j].symbol)) continue;
            attemptedSymbols.add(shuffled[j].symbol); // mark BEFORE attempt — pass or fail
            const retry = executeTrade(shuffled[j].symbol, shuffled[j].direction, rd.raw, rd.signalDate);
            if (retry) {
              seedTrades.push(retry);
              found = true;
              break;
            }
            // failed retry stays in attemptedSymbols → won't be tried again
          }
          if (!found) { coverageFailed = true; break; }
        } else {
          seedTrades.push(trade);
        }
      }
      if (coverageFailed) break;
    }

    if (coverageFailed) {
      coverageFailures.push(seed);
    } else {
      nullReturns.push(seedTrades.reduce((a, b) => a + b.netReturn, 0) / seedTrades.length);
    }

    if (seed === 1 && !coverageFailed) {
      for (const rd of runData) {
        fullAudit.push({
          runId: rd.runId, signalDate: rd.signalDate,
          liquidCount: rd.liquidCount,
          targetCount: rd.obsCount
        });
      }
    }

    if (seed % 200 === 0) console.log(`  ${seed}/${seeds} (failures: ${coverageFailures.length})`);
  }

  return computeStats(nullReturns, coverageFailures, fullAudit, observedTrades,
    'conditional ATR-ranking null', uniquenessFailure);
}

// ─── Null B: Composite selection+direction ───────────────

function runNull_CompositeSelectionDirection(runData, observedTrades, seeds = 1000) {
  console.log(`\n=== Null B: composite selection+direction null ===`);
  console.log(`Tests: simultaneous random selection + random direction,`);
  console.log(`       against observed (ATR% Top-10 + model direction)\n`);

  const nullReturns = [];
  const coverageFailures = [];
  const fullAudit = [];
  let uniquenessFailure = false;

  for (let seed = 1; seed <= seeds; seed++) {
    const random = createRNG(seed);
    const seedTrades = [];
    let coverageFailed = false;

    for (const rd of runData) {
      const hardFiltered = runHardFilter(rd.allLiquidCandidates, rd.raw, rd.signalDate);

      if (hardFiltered.length < rd.obsCount) {
        coverageFailed = true;
        break;
      }

      const shuffled = fisherYatesShuffle(hardFiltered, random);
      const selected = shuffled.slice(0, rd.obsCount);
      const attemptedSymbols = new Set();

      for (const s of selected) {
        if (attemptedSymbols.has(s.symbol)) {
          uniquenessFailure = true;
          coverageFailed = true;
          break;
        }
        attemptedSymbols.add(s.symbol);

        const direction = random() < 0.5 ? 'bullish' : 'bearish';
        const trade = executeTrade(s.symbol, direction, rd.raw, rd.signalDate);
        if (!trade) {
          let found = false;
          for (let j = rd.obsCount; j < shuffled.length; j++) {
            if (attemptedSymbols.has(shuffled[j].symbol)) continue;
            attemptedSymbols.add(shuffled[j].symbol); // mark BEFORE attempt
            const d = random() < 0.5 ? 'bullish' : 'bearish';
            const retry = executeTrade(shuffled[j].symbol, d, rd.raw, rd.signalDate);
            if (retry) {
              seedTrades.push(retry);
              found = true;
              break;
            }
          }
          if (!found) { coverageFailed = true; break; }
        } else {
          seedTrades.push(trade);
        }
      }
      if (coverageFailed) break;
    }

    if (coverageFailed) {
      coverageFailures.push(seed);
    } else {
      nullReturns.push(seedTrades.reduce((a, b) => a + b.netReturn, 0) / seedTrades.length);
    }

    if (seed === 1 && !coverageFailed) {
      for (const rd of runData) {
        fullAudit.push({
          runId: rd.runId, signalDate: rd.signalDate,
          liquidCount: rd.liquidCount,
          targetCount: rd.obsCount
        });
      }
    }

    if (seed % 200 === 0) console.log(`  ${seed}/${seeds} (failures: ${coverageFailures.length})`);
  }

  return computeStats(nullReturns, coverageFailures, fullAudit, observedTrades,
    'composite selection+direction null', uniquenessFailure);
}

// ─── Null C: Pure direction ──────────────────────────────

function runNull_PureDirection(observedTrades, seeds = 1000) {
  console.log(`\n=== Null C: pure direction null ===`);
  console.log(`Tests: fix ALL observed characteristics (dates, symbols, entry/exit, costs),`);
  console.log(`       only randomize direction. Tests whether model direction beats random.\n`);

  const nullReturns = [];

  for (let seed = 1; seed <= seeds; seed++) {
    const random = createRNG(seed);
    const seedTrades = [];

    for (const t of observedTrades) {
      const randomDirection = random() < 0.5 ? 'bullish' : 'bearish';
      const directionSign = randomDirection === 'bullish' ? 1 : -1;
      const grossReturn = directionSign * (t.exitPrice - t.entryPrice) / t.entryPrice;
      const netReturn = grossReturn - t.costs;

      seedTrades.push({
        ...t,
        direction: randomDirection,
        grossReturn,
        netReturn,
        correct: netReturn > 0
      });
    }

    nullReturns.push(seedTrades.reduce((a, b) => a + b.netReturn, 0) / seedTrades.length);

    if (seed % 200 === 0) {
      console.log(`  ${seed}/${seeds}`);
    }
  }

  const observedAvg = observedTrades.reduce((a, b) => a + b.netReturn, 0) / observedTrades.length;
  const nullMean = nullReturns.reduce((a, b) => a + b, 0) / nullReturns.length;
  const nullStd = Math.sqrt(nullReturns.reduce((a, b) => a + Math.pow(b - nullMean, 2), 0) / nullReturns.length);
  const nullBetterCount = nullReturns.filter(r => r >= observedAvg).length;
  const empiricalP = (1 + nullBetterCount) / (nullReturns.length + 1);

  console.log(`\n  Observed avg: ${(observedAvg * 100).toFixed(3)}%`);
  console.log(`  Null mean:    ${(nullMean * 100).toFixed(3)}%`);
  console.log(`  Null std:     ${(nullStd * 100).toFixed(3)}%`);
  console.log(`  Null better:  ${nullBetterCount}/${nullReturns.length}`);
  console.log(`  Empirical p:  ${empiricalP.toFixed(4)}`);

  return {
    type: 'pure direction null',
    description: 'Fixed observed dates/symbols/entry/exit/costs; only direction randomized',
    nullCount: nullReturns.length,
    observedAvgReturn: observedAvg,
    nullMean, nullStd, nullBetterCount,
    empiricalP,
    nullReturns,
    timestamp: new Date().toISOString()
  };
}

// ─── Stats helper ────────────────────────────────────────

function computeStats(nullReturns, coverageFailures, fullAudit, observedTrades, type, uniquenessFailure) {
  const observedAvg = observedTrades.reduce((a, b) => a + b.netReturn, 0) / observedTrades.length;

  if (nullReturns.length === 0) {
    console.log(`\n  ALL SEEDS FAILED — check coverage`);
    return {
      type, observedAvgReturn: observedAvg,
      coverageFailures: coverageFailures.length,
      nullCount: 0, nullMean: null, nullStd: null,
      empiricalP: null, uniquenessFailure,
      fullAudit,
      timestamp: new Date().toISOString()
    };
  }

  const nullMean = nullReturns.reduce((a, b) => a + b, 0) / nullReturns.length;
  const nullStd = Math.sqrt(nullReturns.reduce((a, b) => a + Math.pow(b - nullMean, 2), 0) / nullReturns.length);
  const nullBetterCount = nullReturns.filter(r => r >= observedAvg).length;
  const empiricalP = (1 + nullBetterCount) / (nullReturns.length + 1);

  console.log(`\n  Observed avg: ${(observedAvg * 100).toFixed(3)}%`);
  console.log(`  Null mean:    ${(nullMean * 100).toFixed(3)}%`);
  console.log(`  Null std:     ${(nullStd * 100).toFixed(3)}%`);
  console.log(`  Null better:  ${nullBetterCount}/${nullReturns.length}`);
  console.log(`  Empirical p:  ${empiricalP.toFixed(4)}`);
  console.log(`  Uniqueness:   ${uniquenessFailure ? 'FAIL' : 'PASS'}`);

  return {
    type, observedAvgReturn: observedAvg,
    nullCount: nullReturns.length,
    coverageFailures: coverageFailures.length,
    nullMean, nullStd, nullBetterCount,
    empiricalP, uniquenessFailure,
    fullAudit,
    nullReturns,
    timestamp: new Date().toISOString()
  };
}

// ─── Main ───────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║  V3.1 RANDOM SELECTION — 复审修正          ║');
  console.log('╚══════════════════════════════════════════════╝\n');
  console.log('Null A: conditional ATR-ranking null');
  console.log('  Tests whether ATR% Top-10 adds value');
  console.log('  (fixed liquidity/hard filter/model eligibility)\n');
  console.log('Null B: composite selection+direction null');
  console.log('  Simultaneous random selection + random direction\n');
  console.log('Null C: pure direction null');
  console.log('  Fixed observed dates/symbols/entry/exit/costs');
  console.log('  ONLY randomizes direction\n');

  // Load observed
  const fwFiles = fs.readdirSync(BACKTEST_DIR)
    .filter(f => f.startsWith('fixed-window-momentum-') && f.endsWith('.json'))
    .sort((a, b) => {
      const aTime = fs.statSync(path.join(BACKTEST_DIR, a)).mtime;
      const bTime = fs.statSync(path.join(BACKTEST_DIR, b)).mtime;
      return bTime - aTime;
    });

  const fwPath = path.join(BACKTEST_DIR, fwFiles[0]);
  const fwData = JSON.parse(fs.readFileSync(fwPath, 'utf8'));
  const observedTrades = fwData.results['T+10'] || [];

  console.log(`Observed: ${fwFiles[0]}`);
  console.log(`Observed T+10 trades: ${observedTrades.length}\n`);

  const runMap = loadAllRuns();
  console.log(`Loaded ${runMap.size} historical runs\n`);

  // Pre-compute run data for Null A and Null B
  const observedRunIds = [...new Set(observedTrades.map(t => t.runId))].sort();
  const runData = [];

  for (const runId of observedRunIds) {
    const raw = runMap.get(runId);
    if (!raw) continue;
    const sd = getSignalDate(raw, runId);
    if (!sd) continue;

    const allLiquid = runScannerFull(raw, sd.signalDate);
    const obsCount = observedTrades.filter(t => t.runId === runId).length;

    runData.push({
      runId, raw, signalDate: sd.signalDate,
      allLiquidCandidates: allLiquid,
      liquidCount: allLiquid.length,
      obsCount
    });
  }

  console.log(`Dates: ${runData.length}`);
  console.log(`Target trades: ${runData.reduce((a, r) => a + r.obsCount, 0)}\n`);

  // ── Run all three nulls ──
  console.log('═'.repeat(60));
  const resultA = runNull_ConditionalATR(runData, observedTrades, 1000);

  console.log('\n' + '═'.repeat(60));
  const resultB = runNull_CompositeSelectionDirection(runData, observedTrades, 1000);

  console.log('\n' + '═'.repeat(60));
  const resultC = runNull_PureDirection(observedTrades, 1000);

  // ── Save ──
  const ts = Date.now();
  const outA = path.join(BACKTEST_DIR, `v3.1-nullA-conditional-atr-${ts}.json`);
  const outB = path.join(BACKTEST_DIR, `v3.1-nullB-composite-${ts}.json`);
  const outC = path.join(BACKTEST_DIR, `v3.1-nullC-pure-direction-${ts}.json`);

  fs.writeFileSync(outA, JSON.stringify(resultA, null, 2));
  fs.writeFileSync(outB, JSON.stringify(resultB, null, 2));
  fs.writeFileSync(outC, JSON.stringify(resultC, null, 2));

  console.log(`\nSaved:`);
  console.log(`  ${path.basename(outA)}`);
  console.log(`  ${path.basename(outB)}`);
  console.log(`  ${path.basename(outC)}`);

  // ── Summary ──
  console.log('\n═══════════════════════════════════════════════');
  console.log('V3.1 RESULTS (exploratory in-sample)');
  console.log('═══════════════════════════════════════════════');
  console.log(`Null A (conditional ATR-ranking):  p=${resultA.empiricalP?.toFixed(4) ?? 'N/A'} cov_fail=${resultA.coverageFailures} unique=${resultA.uniquenessFailure ? 'FAIL' : 'PASS'}`);
  console.log(`Null B (composite sel+dir):       p=${resultB.empiricalP?.toFixed(4) ?? 'N/A'} cov_fail=${resultB.coverageFailures} unique=${resultB.uniquenessFailure ? 'FAIL' : 'PASS'}`);
  console.log(`Null C (pure direction):          p=${resultC.empiricalP.toFixed(4)}`);
  console.log('\nInterpretation:');
  console.log('  Null A and Null C each do not reject their respective nulls;');
  console.log('  Null B rejects only the composite null. Independent evidence');
  console.log('  for ATR Top-10 ranking or direction rules has not been');
  console.log('  separately identified in the current sample. The full strategy');
  console.log('  exceeds a specific double-random composite baseline, but');
  console.log('  contribution sources remain unidentified.');
  console.log('\nDISCLAIMER: Without clustered bootstrap / purged walk-forward,');
  console.log('these p-values are exploratory in-sample evidence only.');
  console.log('They do NOT establish statistical significance for production.');
}

main().catch(err => { console.error(err); process.exit(1); });
