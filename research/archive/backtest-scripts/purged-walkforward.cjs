#!/usr/bin/env node
/**
 * purged-walkforward.cjs — P1 Item 4: Post-Selection Walk-Forward
 *
 * 3-fold expanding window, pre-registered indices on 44 sorted signalDate runs.
 * Purge by actual label interval, equal-weight date-cohort scoring,
 * 13 frozen configs, 7 hard gate assertions, date-cluster + block bootstrap.
 *
 * STATISTICAL IDENTITY: This is a POST-SELECTION / CONDITIONAL OOS evaluation.
 * The 13-config candidate grid was derived from Item 3's full-sample inspection
 * of the same 44-run history (which includes the test periods used here).
 * Although each fold selects parameters using train-only data, the candidate
 * set itself was informed by the full sample. This is NOT an untouched-OOS /
 * pre-registered model validation. True independent validation requires
 * freezing the model + grid and collecting new dates, or using a hold-out
 * period that was never seen during Item 3's grid exploration.
 *
 * Usage: node purged-walkforward.cjs
 */

const fs = require('fs');
const path = require('path');

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

const { createModel } = require('./models/momentum-ema20-parameterized.cjs');

// ─── Pre-registered Folds ──────────────────────────────────

const FOLDS = [
  { fold: 1, trainEnd: 14, testStart: 15, testEnd: 24 },   // 15 train, 10 test
  { fold: 2, trainEnd: 24, testStart: 25, testEnd: 34 },   // 25 train, 10 test
  { fold: 3, trainEnd: 34, testStart: 35, testEnd: 43 },   // 35 train, 9 test
];

// ─── Frozen Config Grid ────────────────────────────────────

const OBSERVED = { hv: 1.1, atr: 2.0, ema: 0.3 };

function buildFrozenGrid() {
  const configs = [];
  configs.push({ id: 'observed', hvThreshold: OBSERVED.hv, atrThreshold: OBSERVED.atr, emaSlopeThreshold: OBSERVED.ema });
  for (const hv of [1.0, 1.2, 1.3, 1.5])
    configs.push({ id: `HV=${hv}`, hvThreshold: hv, atrThreshold: OBSERVED.atr, emaSlopeThreshold: OBSERVED.ema });
  for (const atr of [1.0, 1.5, 2.5, 3.0])
    configs.push({ id: `ATR=${atr}`, hvThreshold: OBSERVED.hv, atrThreshold: atr, emaSlopeThreshold: OBSERVED.ema });
  for (const ema of [0.1, 0.2, 0.4, 0.5])
    configs.push({ id: `EMA=${ema}`, hvThreshold: OBSERVED.hv, atrThreshold: OBSERVED.atr, emaSlopeThreshold: ema });
  return configs;
}

// ─── RNG ───────────────────────────────────────────────────

function createRNG(seed) {
  let rng = seed;
  return () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };
}

// ─── Trade exec ────────────────────────────────────────────

function executeTrade(symbol, direction, raw, signalDate) {
  const entry = simulateEntry(symbol, raw, signalDate);
  if (!entry) return null;
  const exit = simulateExit(symbol, raw, entry.entryIdx, 10);
  if (!exit) return null;
  const costs = calculateCosts(entry.entryPrice, exit.exitPrice);
  const sign = direction === 'bullish' ? 1 : -1;
  const grossReturn = sign * (exit.exitPrice - entry.entryPrice) / entry.entryPrice;
  return {
    symbol, direction,
    entryDate: entry.entryDate, exitDate: exit.exitDate,
    entryPrice: entry.entryPrice, exitPrice: exit.exitPrice,
    grossReturn, costs, netReturn: grossReturn - costs
  };
}

// ─── Run signals through a config on a set of runs ─────────

function runConfigOnRuns(config, runIds, runMap, runMeta) {
  const dateCohorts = {};
  const allTrades = [];
  const scannerTruncationAssertions = []; // [{ runId, symbol, lastDate, signalDate, ok }]
  const modelTruncationAssertions = [];   // [{ runId, symbol, modelInputLastDate, signalDate, ok }]

  for (const runId of runIds) {
    const meta = runMeta.get(runId);
    if (!meta) continue;
    const raw = runMap.get(runId);
    if (!raw) continue;

    const top10 = runScanner(raw, meta.signalDate);
    const filtered = runHardFilter(top10, raw, meta.signalDate);

    // Gate 4a: verify every scanner candidate has _lastDate === signalDate
    for (const c of top10) {
      scannerTruncationAssertions.push({
        runId, symbol: c.symbol,
        lastDate: c._lastDate,
        signalDate: meta.signalDate,
        ok: c._lastDate === meta.signalDate
      });
    }

    const model = createModel({
      hvThreshold: config.hvThreshold,
      atrThreshold: config.atrThreshold,
      emaSlopeThreshold: config.emaSlopeThreshold
    });

    const signals = model.generateSignals(raw, { candidates: filtered }, meta.signalDate);

    // Gate 4b: verify every model signal's input was truncated to signalDate
    for (const s of signals) {
      modelTruncationAssertions.push({
        runId, symbol: s.symbol,
        modelInputLastDate: s._modelInputLastDate,
        signalDate: meta.signalDate,
        ok: s._modelInputLastDate === meta.signalDate
      });
    }

    const dayTrades = [];
    for (const s of signals) {
      const trade = executeTrade(s.symbol, s.direction, raw, meta.signalDate);
      if (trade) dayTrades.push({ ...trade, runId, signalDate: meta.signalDate });
    }

    const dayReturn = dayTrades.length > 0
      ? dayTrades.reduce((a, t) => a + t.netReturn, 0) / dayTrades.length
      : 0;

    dateCohorts[meta.signalDate] = {
      runId,
      signalDate: meta.signalDate,
      tradeCount: dayTrades.length,
      signalCount: signals.length,
      dayReturn,
      trades: dayTrades
    };

    allTrades.push(...dayTrades);
  }

  return { dateCohorts, allTrades, scannerTruncationAssertions, modelTruncationAssertions };
}

// ─── Equal-weight date-cohort scoring ──────────────────────

function scoreConfig(dateCohorts, allDates) {
  const returns = [];
  let activeDates = 0;

  for (const d of allDates) {
    const cohort = dateCohorts[d];
    if (cohort) {
      returns.push(cohort.dayReturn);
      if (cohort.tradeCount > 0) activeDates++;
    } else {
      returns.push(0);
    }
  }

  const meanReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const coverage = allDates.length > 0 ? activeDates / allDates.length : 0;

  return { meanReturn, coverage, activeDates, totalDates: allDates.length, dateReturns: returns };
}

// ─── Tiebreaker: closer to observed defaults ──────────────

function distanceFromObserved(config) {
  const hvDist = Math.abs(config.hvThreshold - OBSERVED.hv) / OBSERVED.hv;
  const atrDist = Math.abs(config.atrThreshold - OBSERVED.atr) / OBSERVED.atr;
  const emaDist = Math.abs(config.emaSlopeThreshold - OBSERVED.ema) / OBSERVED.ema;
  return hvDist + atrDist + emaDist;
}

function selectBestConfig(scoredConfigs) {
  // Sort by: meanReturn desc → coverage desc → closer to observed
  scoredConfigs.sort((a, b) => {
    if (Math.abs(a.score.meanReturn - b.score.meanReturn) > 1e-10)
      return b.score.meanReturn - a.score.meanReturn;
    if (Math.abs(a.coverage - b.coverage) > 1e-10)
      return b.coverage - a.coverage;
    return a.distance - b.distance;
  });
  return scoredConfigs[0];
}

// ─── Data loading ──────────────────────────────────────────

function loadAllRuns() {
  const rawMap = new Map();
  const runDirs = fs.readdirSync(RUNS_DIR).filter(d => d.startsWith('bt-')).sort();
  for (const runDir of runDirs) {
    const rawPath = path.join(RUNS_DIR, runDir, 'raw.json');
    if (!fs.existsSync(rawPath)) continue;
    rawMap.set(runDir, JSON.parse(fs.readFileSync(rawPath, 'utf8')));
  }
  return rawMap;
}

function buildRunMeta(runMap) {
  const meta = new Map();
  for (const [runId, raw] of runMap) {
    const firstContract = Object.values(raw.contracts)[0];
    if (!firstContract || !firstContract.ohlcv) continue;
    const dates = firstContract.ohlcv.dates;
    const exitDateStr = runId.replace('bt-', '');
    const exitDateFormatted = exitDateStr.substring(0, 4) + '-' +
                               exitDateStr.substring(4, 6) + '-' +
                               exitDateStr.substring(6, 8);
    const exitIdx = dates.indexOf(exitDateFormatted);
    if (exitIdx < 0) continue;
    const signalIdx = exitIdx - 11;
    if (signalIdx < 20) continue;
    const signalDate = dates[signalIdx];
    const entryDate = dates[signalIdx + 1];
    const labelEndDate = dates[exitIdx]; // T+10 exit = latest label end
    meta.set(runId, { runId, signalDate, signalIdx, exitIdx, entryDate, labelEndDate, exitDateFormatted });
  }
  return meta;
}

// ─── Purge ─────────────────────────────────────────────────

function purgeTrainRuns(trainRunIds, testRunIds, runMeta) {
  if (testRunIds.length === 0) return { purged: trainRunIds, removed: [] };

  const testFirstSignal = Math.min(...testRunIds.map(id => {
    const m = runMeta.get(id);
    return m ? new Date(m.signalDate).getTime() : Infinity;
  }));

  const kept = [];
  const removed = [];

  for (const runId of trainRunIds) {
    const meta = runMeta.get(runId);
    if (!meta) { removed.push({ runId, reason: 'no_meta' }); continue; }

    const labelEnd = new Date(meta.labelEndDate).getTime();
    if (labelEnd >= testFirstSignal) {
      removed.push({ runId, reason: 'label_overlap', labelEnd: meta.labelEndDate });
    } else {
      kept.push(runId);
    }
  }

  return { purged: kept, removed };
}

// ─── Gates ─────────────────────────────────────────────────

function runGates(foldsResult, sortedRunIds, runMeta) {
  console.log('\n═══════════════════════════════════════════════');
  console.log('GATE ASSERTIONS');
  console.log('═══════════════════════════════════════════════');

  let allPass = true;
  const failures = [];

  // Gate 1: 44-run full coverage — every run in exactly one test OR one train (possibly purged)
  const testRunIds = new Set();
  const trainRunIds = new Set();
  const purgedRunIds = new Set();

  for (const fr of foldsResult) {
    for (const id of fr.testRunIds) testRunIds.add(id);
    for (const id of fr.trainRunIds) trainRunIds.add(id);
    for (const p of fr.purgeRemoved) purgedRunIds.add(p.runId);
  }

  const allClassified = new Set([...testRunIds, ...trainRunIds]);
  const unclassified = sortedRunIds.filter(id => !allClassified.has(id));

  // In expanding window, runs can appear in both test (earlier fold) and train (later fold).
  // This is expected and not an error. The real check: union covers all 44 runs,
  // no run appears in >1 test set, and runs not in any test are at least in train.
  const multiTest = [];
  for (const fr of foldsResult) {
    for (const fr2 of foldsResult) {
      if (fr.fold >= fr2.fold) continue;
      for (const id of fr.testRunIds) {
        if (fr2.testRunIds.includes(id)) multiTest.push(id);
      }
    }
  }
  const g1_ok = unclassified.length === 0 && multiTest.length === 0;

  // Count actual OOS we care about
  const totalTest = testRunIds.size;
  console.log(`  Gate 1 (full coverage): ${g1_ok ? 'PASS' : 'FAIL'}`);
  console.log(`    Test: ${totalTest}, Train: ${trainRunIds.size}, Purged: ${purgedRunIds.size}, Unclassified: ${unclassified.length}, Multi-test: ${multiTest.length}`);
  if (!g1_ok) { allPass = false; failures.push('G1: coverage'); if (unclassified.length) console.log('    Unclassified: ' + unclassified.join(', ')); if (multiTest.length) console.log('    Multi-test: ' + multiTest.join(', ')); }

  // Gate 2: max(unpurgedTrainLabelEnd) < testFirstSignalDate per fold
  let g2_ok = true;
  for (const fr of foldsResult) {
    const testFirst = Math.min(...fr.testRunIds.map(id => {
      const m = runMeta.get(id); return m ? new Date(m.signalDate).getTime() : Infinity;
    }));
    const trainLabelEnds = fr.trainRunIds.map(id => {
      const m = runMeta.get(id); return m ? new Date(m.labelEndDate).getTime() : 0;
    });
    const maxTrainLabel = trainLabelEnds.length > 0 ? Math.max(...trainLabelEnds) : 0;

    if (maxTrainLabel >= testFirst) {
      g2_ok = false;
      console.log(`  Gate 2 (fold ${fr.fold}): FAIL — max train label ${new Date(maxTrainLabel).toISOString().slice(0,10)} >= test first signal ${new Date(testFirst).toISOString().slice(0,10)}`);
    }
  }
  console.log(`  Gate 2 (label non-overlap): ${g2_ok ? 'PASS' : 'FAIL'}`);
  if (!g2_ok) { allPass = false; failures.push('G2: label overlap'); }

  // Gate 3: config frozen — verify hash unchanged after test execution
  let g3_ok = true;
  for (const fr of foldsResult) {
    if (!fr.configFrozenIntact) {
      g3_ok = false;
      console.log(`  Gate 3 (fold ${fr.fold}): FAIL — config hash mismatch (pre=${fr.frozenConfigHash}, post=${fr.postTestConfigHash})`);
    }
  }
  console.log(`  Gate 3 (config frozen): ${g3_ok ? 'PASS' : 'FAIL'} (hash verified pre/post test per fold)`);
  if (!g3_ok) { allPass = false; failures.push('G3: config mutation'); }

  // Gate 4a: scanner truncation — every candidate _lastDate === signalDate
  let g4a_ok = true;
  let g4a_total = 0, g4a_pass = 0;
  for (const fr of foldsResult) {
    const allScanner = [...(fr.trainScannerAssertions || []), ...(fr.testScannerAssertions || [])];
    for (const a of allScanner) {
      g4a_total++;
      if (a.ok) g4a_pass++;
      else { g4a_ok = false; }
    }
  }
  // Gate 4b: model input truncation — every signal _modelInputLastDate === signalDate
  let g4b_ok = true;
  let g4b_total = 0, g4b_pass = 0;
  for (const fr of foldsResult) {
    const allModel = [...(fr.trainModelAssertions || []), ...(fr.testModelAssertions || [])];
    for (const a of allModel) {
      g4b_total++;
      if (a.ok) g4b_pass++;
      else { g4b_ok = false; }
    }
  }
  const g4_ok = g4a_ok && g4b_ok;
  console.log(`  Gate 4a (scanner truncation): ${g4a_ok ? 'PASS' : 'FAIL'} (${g4a_pass}/${g4a_total} candidates lastDate===signalDate)`);
  console.log(`  Gate 4b (model input truncation): ${g4b_ok ? 'PASS' : 'FAIL'} (${g4b_pass}/${g4b_total} signals modelInputLastDate===signalDate)`);
  if (!g4_ok) { allPass = false; failures.push('G4: truncation'); }

  // Gate 5: zero-signal test runs retained
  let g5_ok = true;
  for (const fr of foldsResult) {
    for (const runId of fr.testRunIds) {
      if (!fr.testDateCohorts || !fr.testDateCohorts[runMeta.get(runId)?.signalDate]) {
        g5_ok = false;
        console.log(`  Gate 5 (fold ${fr.fold}): FAIL — run ${runId} missing from test cohorts`);
      }
    }
  }
  console.log(`  Gate 5 (zero-signal retained): ${g5_ok ? 'PASS' : 'FAIL'}`);
  if (!g5_ok) { allPass = false; failures.push('G5: missing zero-signal run'); }

  // Gate 6: re-run selector on saved trainGrid, assert winner matches frozen config,
  // and verify trainSelectionHash unchanged across test execution
  let g6_ok = true;
  for (const fr of foldsResult) {
    // 6a: Re-run tie-break selector from saved trainGrid scores
    const reconstructedScored = fr.trainGrid.map(g => ({
      config: { id: g.configId, hvThreshold: g.hvThreshold, atrThreshold: g.atrThreshold, emaSlopeThreshold: g.emaSlopeThreshold },
      score: { meanReturn: g.dateCohortMeanReturn, coverage: g.coverage, activeDates: g.activeDates, totalDates: g.totalDates },
      coverage: g.coverage,
      distance: distanceFromObserved({ hvThreshold: g.hvThreshold, atrThreshold: g.atrThreshold, emaSlopeThreshold: g.emaSlopeThreshold })
    }));
    const reSelected = selectBestConfig(reconstructedScored);

    // Assert re-selected winner matches frozen config on all threshold fields
    const fields = ['id', 'hvThreshold', 'atrThreshold', 'emaSlopeThreshold'];
    let mismatch = null;
    for (const f of fields) {
      if (reSelected.config[f] !== fr.selectedConfig[f]) {
        mismatch = `${f}: selected=${reSelected.config[f]} vs frozen=${fr.selectedConfig[f]}`;
        break;
      }
    }
    if (mismatch) {
      g6_ok = false;
      console.log(`  Gate 6a (fold ${fr.fold}): FAIL — re-selected config differs from frozen (${mismatch})`);
    }

    // 6b: Verify trainSelectionHash unchanged (re-compute from saved inputs)
    const recomputedHash = require('crypto').createHash('sha256')
      .update(JSON.stringify(fr.trainSelectionInputs)).digest('hex').substring(0, 16);
    if (recomputedHash !== fr.trainSelectionHash) {
      g6_ok = false;
      console.log(`  Gate 6b (fold ${fr.fold}): FAIL — trainSelectionHash mismatch (saved=${fr.trainSelectionHash}, recomputed=${recomputedHash})`);
    }
  }
  console.log(`  Gate 6 (no test leakage): ${g6_ok ? 'PASS' : 'FAIL'} (selector re-run + hash verified)`);
  if (!g6_ok) { allPass = false; failures.push('G6: selection leak'); }

  // Gate 7: OOS dedup — no duplicate (runId, symbol, direction, entryDate)
  const oosKeys = new Set();
  let dupCount = 0;
  for (const fr of foldsResult) {
    for (const t of (fr.testAllTrades || [])) {
      const key = `${t.runId}|${t.symbol}|${t.direction}|${t.entryDate}`;
      if (oosKeys.has(key)) dupCount++;
      oosKeys.add(key);
    }
  }
  const g7_ok = dupCount === 0;
  console.log(`  Gate 7 (OOS dedup): ${g7_ok ? 'PASS' : 'FAIL'} (${oosKeys.size} unique, ${dupCount} dups)`);
  if (!g7_ok) { allPass = false; failures.push('G7: duplicates'); }

  console.log(`\n  Overall: ${allPass ? 'ALL GATES PASS' : 'GATE FAILURES: ' + failures.join(', ')}`);
  return { allPass, failures, testRunCount: totalTest };
}

// ─── Bootstrap ─────────────────────────────────────────────

function dateClusterBootstrap(dateReturns, nBoot = 1000) {
  const random = createRNG(42);
  const n = dateReturns.length;
  const means = [];

  for (let b = 0; b < nBoot; b++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      sum += dateReturns[Math.floor(random() * n)];
    }
    means.push(sum / n);
  }

  means.sort((a, b) => a - b);
  return {
    mean: means.reduce((a, b) => a + b, 0) / means.length,
    ci05: means[Math.floor(nBoot * 0.05)],
    ci95: means[Math.floor(nBoot * 0.95)],
    ci50: means[Math.floor(nBoot * 0.50)]
  };
}

// HEURISTIC: blockLen=10 consecutive OOS observation dates, NOT 10 trading days.
// OOS dates are sparse (weeks apart), so a block of 10 covers months, not days.
// At n=29, this yields only ~3 blocks per bootstrap sample → CI is unstable.
// A proper trading-day block bootstrap would require a full daily calendar with
// per-day composite returns, which is not available from the current run structure.
function consecutiveOOSBlockBootstrap(dateReturns, nBoot = 1000, blockLen = 10) {
  const random = createRNG(99);
  const n = dateReturns.length;
  if (n < blockLen) return dateClusterBootstrap(dateReturns, nBoot);

  const means = [];
  const maxStart = n - blockLen;

  for (let b = 0; b < nBoot; b++) {
    const sampled = [];
    while (sampled.length < n) {
      const start = Math.floor(random() * (maxStart + 1));
      for (let j = 0; j < blockLen && sampled.length < n; j++) {
        sampled.push(dateReturns[start + j]);
      }
    }
    means.push(sampled.reduce((a, v) => a + v, 0) / sampled.length);
  }

  means.sort((a, b) => a - b);
  return {
    mean: means.reduce((a, b) => a + b, 0) / means.length,
    ci05: means[Math.floor(nBoot * 0.05)],
    ci95: means[Math.floor(nBoot * 0.95)],
    ci50: means[Math.floor(nBoot * 0.50)]
  };
}

// ─── Formatting ────────────────────────────────────────────

function fmtPct(v) { return (v * 100).toFixed(4) + '%'; }

// ─── Main ──────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║  POST-SELECTION WALK-FORWARD — P1 Item 4   ║');
  console.log('║  (conditional OOS — NOT untouched OOS)     ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  const runMap = loadAllRuns();
  const runMeta = buildRunMeta(runMap);
  const sortedRunIds = [...runMap.keys()].sort();
  console.log(`Loaded ${runMap.size} runs, ${runMeta.size} with valid metadata`);

  if (sortedRunIds.length !== 44) {
    console.log(`WARNING: expected 44 runs, got ${sortedRunIds.length}`);
  }

  const frozenGrid = buildFrozenGrid();
  console.log(`Frozen config grid: ${frozenGrid.length} configurations\n`);

  // ── Per-fold execution ──
  const foldsResult = [];

  for (const foldDef of FOLDS) {
    console.log('═'.repeat(60));
    console.log(`FOLD ${foldDef.fold}: train [0..${foldDef.trainEnd}], test [${foldDef.testStart}..${foldDef.testEnd}]`);

    const allTrainIds = sortedRunIds.slice(0, foldDef.trainEnd + 1);
    const testRunIds = sortedRunIds.slice(foldDef.testStart, foldDef.testEnd + 1);

    // Purge
    const { purged: trainRunIds, removed: purgeRemoved } = purgeTrainRuns(allTrainIds, testRunIds, runMeta);

    const testSignalDates = testRunIds.map(id => runMeta.get(id)?.signalDate).filter(Boolean);
    console.log(`  Train: ${allTrainIds.length} candidates → ${trainRunIds.length} after purge (${purgeRemoved.length} removed)`);
    console.log(`  Test: ${testRunIds.length} runs`);
    console.log(`  Test signal range: ${testSignalDates[0]} to ${testSignalDates[testSignalDates.length - 1]}`);

    // ── Train: score all 13 configs ──
    const trainDates = trainRunIds.map(id => runMeta.get(id)?.signalDate).filter(Boolean).sort();
    const scoredConfigs = [];
    const trainScannerAssertions = [];
    const trainModelAssertions = [];

    for (const cfg of frozenGrid) {
      const { dateCohorts, scannerTruncationAssertions, modelTruncationAssertions } = runConfigOnRuns(cfg, trainRunIds, runMap, runMeta);
      const score = scoreConfig(dateCohorts, trainDates);
      scoredConfigs.push({
        config: cfg,
        score,
        coverage: score.coverage,
        distance: distanceFromObserved(cfg)
      });
      if (cfg.id === 'observed') {
        trainScannerAssertions.push(...scannerTruncationAssertions);
        trainModelAssertions.push(...modelTruncationAssertions);
      }
    }

    // Select best + freeze config (detached copy via JSON round-trip; hash guards against mutation)
    const best = selectBestConfig(scoredConfigs);
    const frozenConfig = JSON.parse(JSON.stringify(best.config));
    const frozenConfigHash = require('crypto').createHash('sha256')
      .update(JSON.stringify(frozenConfig)).digest('hex').substring(0, 16);

    // Save train selection inputs for Gate 6 (prove test didn't influence selection)
    const trainSelectionInputs = {
      trainRunIds: [...trainRunIds].sort(),
      trainDates: [...trainDates],
      gridScores: scoredConfigs.map(sc => ({ id: sc.config.id, return: sc.score.meanReturn }))
    };
    const trainSelectionHash = require('crypto').createHash('sha256')
      .update(JSON.stringify(trainSelectionInputs)).digest('hex').substring(0, 16);

    console.log(`\n  Train best: ${best.config.id} (mean date return=${fmtPct(best.score.meanReturn)}, coverage=${(best.score.coverage * 100).toFixed(1)}%, active=${best.score.activeDates}/${best.score.totalDates})`);

    // Show all train scores
    console.log('  Train grid:');
    for (const sc of scoredConfigs) {
      const marker = sc.config.id === best.config.id ? ' ★' : '  ';
      console.log(`   ${(sc.config.id + marker).padEnd(12)} dateRet=${fmtPct(sc.score.meanReturn)} cov=${(sc.score.coverage * 100).toFixed(1)}%`);
    }

    // ── Test: evaluate FROZEN config once (detached copy, hash-verified) ──
    console.log(`\n  → Test with frozen config: ${frozenConfig.id} (hash=${frozenConfigHash})`);
    const testResult = runConfigOnRuns(frozenConfig, testRunIds, runMap, runMeta);
    const testDates = testRunIds.map(id => runMeta.get(id)?.signalDate).filter(Boolean).sort();
    const testScore = scoreConfig(testResult.dateCohorts, testDates);

    const testTotalTrades = testResult.allTrades.length;
    const testActiveDates = testScore.activeDates;
    const testAvgReturn = testScore.meanReturn;
    const testAccuracy = testTotalTrades > 0
      ? testResult.allTrades.filter(t => t.netReturn > 0).length / testTotalTrades
      : null;

    console.log(`  Test: ${testTotalTrades} trades across ${testActiveDates}/${testDates.length} active dates`);
    console.log(`  Test date-cohort mean return: ${fmtPct(testAvgReturn)}`);
    if (testAccuracy !== null) console.log(`  Test trade accuracy: ${(testAccuracy * 100).toFixed(1)}%`);

    // Print per-date test detail
    console.log('  Test details:');
    for (const d of testDates) {
      const cohort = testResult.dateCohorts[d];
      if (cohort && cohort.tradeCount > 0) {
        console.log(`    ${d}: ${cohort.tradeCount} trades, return=${fmtPct(cohort.dayReturn)} [${cohort.trades.map(t => `${t.symbol}:${t.direction}`).join(', ')}]`);
      } else {
        console.log(`    ${d}: 0 trades (zero-signal)`);
      }
    }

    // Verify frozen config didn't mutate during test
    const postTestConfigHash = require('crypto').createHash('sha256')
      .update(JSON.stringify(frozenConfig)).digest('hex').substring(0, 16);
    const configFrozenIntact = postTestConfigHash === frozenConfigHash;

    foldsResult.push({
      fold: foldDef.fold,
      trainRunIds,
      purgeRemoved,
      testRunIds,
      selectedConfig: frozenConfig,
      frozenConfigHash,
      postTestConfigHash,
      configFrozenIntact,
      trainSelectionHash,
      trainSelectionInputs,
      trainScannerAssertions,
      trainModelAssertions,
      testScannerAssertions: testResult.scannerTruncationAssertions,
      testModelAssertions: testResult.modelTruncationAssertions,
      trainGrid: scoredConfigs.map(sc => ({
        configId: sc.config.id,
        hvThreshold: sc.config.hvThreshold,
        atrThreshold: sc.config.atrThreshold,
        emaSlopeThreshold: sc.config.emaSlopeThreshold,
        dateCohortMeanReturn: sc.score.meanReturn,
        coverage: sc.score.coverage,
        activeDates: sc.score.activeDates,
        totalDates: sc.score.totalDates
      })),
      testDateCohorts: testResult.dateCohorts,
      testAllTrades: testResult.allTrades,
      testScore: {
        dateCohortMeanReturn: testScore.meanReturn,
        coverage: testScore.coverage,
        activeDates: testScore.activeDates,
        totalDates: testScore.totalDates,
        tradeCount: testTotalTrades,
        accuracy: testAccuracy
      }
    });
  }

  // ── Gates ──
  const gateResult = runGates(foldsResult, sortedRunIds, runMeta);
  if (!gateResult.allPass) {
    console.log('\nFATAL: Gate assertions failed. Aborting.');
    process.exit(1);
  }

  // ── Test-run date metadata (Item 5 truth source) ──
  const allTestRunIds = foldsResult.flatMap(fr => fr.testRunIds);
  const testRunDateMetadata = allTestRunIds.map(runId => {
    const m = runMeta.get(runId);
    if (!m) throw new Error(`Missing runMeta for test run ${runId}`);
    return { runId, signalDate: m.signalDate, entryDate: m.entryDate, labelEndDate: m.labelEndDate };
  });
  // Gate: assert 29 unique runIds, signal < entry <= labelEnd
  const metaRunIds = new Set(testRunDateMetadata.map(m => m.runId));
  if (metaRunIds.size !== testRunDateMetadata.length) {
    throw new Error(`Duplicate runId in testRunDateMetadata`);
  }
  for (const m of testRunDateMetadata) {
    if (!(m.signalDate < m.entryDate && m.entryDate <= m.labelEndDate)) {
      throw new Error(`Date order violation for ${m.runId}: signal=${m.signalDate} entry=${m.entryDate} labelEnd=${m.labelEndDate}`);
    }
  }
  for (const rid of allTestRunIds) {
    if (!metaRunIds.has(rid)) throw new Error(`Test run ${rid} missing from testRunDateMetadata`);
  }
  console.log(`Test-run date metadata: ${testRunDateMetadata.length} runs, all passes (runId unique, signal < entry <= labelEnd, all testRunIds covered)`);

  // ── OOS aggregation ──
  console.log('\n═══════════════════════════════════════════════');
  console.log('CONDITIONAL OOS AGGREGATION');
  console.log('═══════════════════════════════════════════════');

  const allOOSTrades = [];
  const allOOSDateReturns = [];
  const allOOSDates = [];

  for (const fr of foldsResult) {
    allOOSTrades.push(...fr.testAllTrades);
    const testDates = fr.testRunIds.map(id => runMeta.get(id)?.signalDate).filter(Boolean).sort();
    for (const d of testDates) {
      allOOSDates.push(d);
      const cohort = fr.testDateCohorts[d];
      allOOSDateReturns.push(cohort ? cohort.dayReturn : 0);
    }
  }

  const oosMean = allOOSDateReturns.reduce((a, b) => a + b, 0) / allOOSDateReturns.length;

  // Exact active-date count: signalDate where cohort.tradeCount > 0
  let oosActiveDates = 0;
  for (const fr of foldsResult) {
    for (const cohort of Object.values(fr.testDateCohorts)) {
      if (cohort.tradeCount > 0) oosActiveDates++;
    }
  }

  const oosTradeAccuracy = allOOSTrades.length > 0
    ? allOOSTrades.filter(t => t.netReturn > 0).length / allOOSTrades.length
    : null;

  console.log(`OOS signal dates: ${allOOSDates.length}`);
  console.log(`OOS active dates (tradeCount>0): ${oosActiveDates}`);
  console.log(`OOS trades: ${allOOSTrades.length}`);
  console.log(`OOS date-cohort mean return: ${fmtPct(oosMean)}`);
  if (oosTradeAccuracy !== null) console.log(`OOS trade accuracy: ${(oosTradeAccuracy * 100).toFixed(1)}%`);

  // ── Bootstrap ──
  console.log('\n── Bootstrap (exploratory, n=29 OOS signal dates, 1000 reps) ──');

  const dcBoot = dateClusterBootstrap(allOOSDateReturns, 1000);
  console.log(`Date-cluster bootstrap:        mean=${fmtPct(dcBoot.mean)} 90%CI [${fmtPct(dcBoot.ci05)}, ${fmtPct(dcBoot.ci95)}]`);

  const blkBoot = consecutiveOOSBlockBootstrap(allOOSDateReturns, 1000, 10);
  console.log(`10-obs-date block bootstrap:   mean=${fmtPct(blkBoot.mean)} 90%CI [${fmtPct(blkBoot.ci05)}, ${fmtPct(blkBoot.ci95)}]`);
  console.log('(block=10 consecutive OOS signal dates, NOT 10 trading days. At n=29, ~3 blocks, CI unstable.)');

  // ── Save ──
  const outPath = path.join(BACKTEST_DIR, `purged-walkforward-${Date.now()}.json`);
  const output = {
    description: 'P1 Item 4: Post-selection walk-forward / conditional OOS evaluation',
    statisticalIdentity: 'POST-SELECTION / CONDITIONAL OOS. ' +
      'The 13-config candidate grid was derived from Item 3 full-sample inspection ' +
      'of the same 44-run history. Although each fold selects parameters on train-only ' +
      'data, the candidate set itself was informed by the full sample. This is NOT ' +
      'untouched-OOS / pre-registered model validation.',
    folds: FOLDS,
    frozenGrid: frozenGrid.map(c => ({ id: c.id, hv: c.hvThreshold, atr: c.atrThreshold, ema: c.emaSlopeThreshold })),
    observedDefaults: OBSERVED,
    totalRuns: sortedRunIds.length,
    gates: { allPass: gateResult.allPass, failures: gateResult.failures },
    foldsDetail: foldsResult.map(fr => ({
      fold: fr.fold,
      trainRunIds: fr.trainRunIds,
      purgeRemoved: fr.purgeRemoved.map(p => p.runId),
      testRunIds: fr.testRunIds,
      selectedConfig: fr.selectedConfig,
      frozenConfigHash: fr.frozenConfigHash,
      configFrozenIntact: fr.configFrozenIntact,
      trainGrid: fr.trainGrid,
      testScore: fr.testScore,
      testTradeCount: fr.testAllTrades.length,
      gate4aScannerTruncationOk: [...(fr.trainScannerAssertions || []), ...(fr.testScannerAssertions || [])].every(a => a.ok),
      gate4bModelTruncationOk: [...(fr.trainModelAssertions || []), ...(fr.testModelAssertions || [])].every(a => a.ok)
    })),
    oosAggregate: {
      totalSignalDates: allOOSDates.length,
      activeDates: oosActiveDates,
      totalTrades: allOOSTrades.length,
      dateCohortMeanReturn: oosMean,
      tradeAccuracy: oosTradeAccuracy,
      bootstrapDateCluster: dcBoot,
      bootstrapConsecutiveOOSBlock: { ...blkBoot, blockLength: 10, blockUnit: 'consecutive OOS signal dates (NOT trading days)', note: 'Heuristic. n=29 sparse dates → ~3 blocks per sample → CI is unstable.' }
    },
    testRunDateMetadata,
    allOOSTrades: allOOSTrades.map(t => ({
      runId: t.runId,
      signalDate: t.signalDate,
      symbol: t.symbol,
      direction: t.direction,
      entryDate: t.entryDate,
      exitDate: t.exitDate,
      entryPrice: t.entryPrice,
      exitPrice: t.exitPrice,
      grossReturn: t.grossReturn,
      costs: t.costs,
      netReturn: t.netReturn
    })),
    scoringMethod: 'equal-weight date-cohort mean; zero-signal dates counted as 0; tiebreak: coverage → closer to observed defaults',
    bootstrapMethod: 'date-cluster bootstrap + 10-consecutive-OOS-date block bootstrap (heuristic, NOT trading-day block), 1000 reps, 90% CI',
    disclaimer: 'POST-SELECTION / CONDITIONAL OOS. ' +
      '13-config grid was informed by full-sample Item 3 sweep. ' +
      '29 OOS signal dates is a small sample. 90% CIs are indicative only. ' +
      'Scoring proxy is equal-weight date-cohort mean, NOT account-level return. ' +
      'The consecutive-OOS-date block bootstrap uses heuristic block length on sparse dates ' +
      'and is NOT a proper trading-day block bootstrap. ' +
      'This evaluates a pre-registered training rule — it does NOT validate any specific threshold.',
    timestamp: new Date().toISOString()
  };

  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\nSaved: ${path.basename(outPath)}`);

  // ── Summary ──
  console.log('\n═══════════════════════════════════════════════');
  console.log('SUMMARY (post-selection walk-forward / conditional OOS)');
  console.log('═══════════════════════════════════════════════');
  console.log(`OOS signal dates: ${allOOSDates.length} (${oosActiveDates} active)`);
  console.log(`OOS trades: ${allOOSTrades.length}`);
  console.log(`OOS date-cohort mean: ${fmtPct(oosMean)}`);
  console.log(`Date-cluster 90% CI:           [${fmtPct(dcBoot.ci05)}, ${fmtPct(dcBoot.ci95)}]`);
  console.log(`10-obs-date block 90% CI:      [${fmtPct(blkBoot.ci05)}, ${fmtPct(blkBoot.ci95)}]`);
  console.log(`Gates: ${gateResult.allPass ? 'ALL PASS' : 'FAILURES: ' + gateResult.failures.join(', ')}`);
  console.log('\nCAVEATS:');
  console.log('1. STATISTICAL IDENTITY: Post-selection / conditional OOS. The 13-config');
  console.log('   grid was informed by Item 3 full-sample sweep of the same 44-run history.');
  console.log('   This is NOT untouched-OOS / pre-registered model validation.');
  console.log('2. True independent validation requires freezing model+grid and collecting');
  console.log('   new dates, or using a hold-out period unseen during Item 3.');
  console.log('3. Scoring proxy = equal-weight date-cohort mean, NOT account return.');
  console.log('4. 29 OOS signal dates = small sample; bootstrap CIs are wide and exploratory.');
  console.log('5. "10-obs-date block bootstrap" uses 10 consecutive OOS observation dates');
  console.log('   (~months of calendar time), NOT 10 trading days. Heuristic, ~3 blocks per');
  console.log('   sample, CI is unstable. Proper trading-day block bootstrap needs daily calendar.');
  console.log('6. 3-fold expanding on 44 runs; different fold designs may yield different results.');
}

main().catch(err => { console.error(err); process.exit(1); });
