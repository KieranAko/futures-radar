#!/usr/bin/env node
/**
 * threshold-ablation.cjs — P1 Item 3: Single-variable threshold ablation
 *
 * Grid: 13 configs — 4 HV + 4 ATR + 4 EMA + 1 observed baseline.
 * Each runs on the same 30 signal dates with identical scanner,
 * hard filter, entry/exit, and cost logic from shared-backtest-lib.
 *
 * DISCLAIMER: Exploratory in-sample. No p-values. Best threshold is
 * a candidate for purged walk-forward only — NOT production.
 *
 * Usage: node threshold-ablation.cjs
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
  calculateCosts
} = require('./shared-backtest-lib.cjs');

const { createModel } = require('./models/momentum-ema20-parameterized.cjs');

// ─── Grid ──────────────────────────────────────────────────

const OBSERVED = { hv: 1.1, atr: 2.0, ema: 0.3 };

function buildConfigs() {
  const configs = [];

  configs.push({
    id: 'observed',
    label: 'HV=1.1 ATR=2.0 EMA=0.3 (observed)',
    hvThreshold: OBSERVED.hv,
    atrThreshold: OBSERVED.atr,
    emaSlopeThreshold: OBSERVED.ema,
    varying: null
  });

  for (const hv of [1.0, 1.2, 1.3, 1.5]) {
    configs.push({
      id: `HV=${hv}`,
      label: `HV=${hv}`,
      hvThreshold: hv,
      atrThreshold: OBSERVED.atr,
      emaSlopeThreshold: OBSERVED.ema,
      varying: 'hv'
    });
  }
  for (const atr of [1.0, 1.5, 2.5, 3.0]) {
    configs.push({
      id: `ATR=${atr}`,
      label: `ATR=${atr}`,
      hvThreshold: OBSERVED.hv,
      atrThreshold: atr,
      emaSlopeThreshold: OBSERVED.ema,
      varying: 'atr'
    });
  }
  for (const ema of [0.1, 0.2, 0.4, 0.5]) {
    configs.push({
      id: `EMA=${ema}`,
      label: `EMA=${ema}`,
      hvThreshold: OBSERVED.hv,
      atrThreshold: OBSERVED.atr,
      emaSlopeThreshold: ema,
      varying: 'ema'
    });
  }

  return configs;
}

// ─── Baseline identity gate ───────────────────────────────

/**
 * Assert baseline replayed via parameterized model matches observed
 * trades on the full tuple: (runId, symbol, direction, entryDate,
 * exitDate, entryPrice, exitPrice, costs, netReturn).
 * Any mismatch → exit non-zero. Prevents parameterized-model drift
 * from passing on aggregate metrics alone.
 */
function identityGate(replayed, observed) {
  const EPS = 1e-8;

  const obsByKey = new Map();
  for (const t of observed) {
    obsByKey.set(`${t.runId}|${t.symbol}|${t.direction}|${t.entryDate}|${t.exitDate}`, t);
  }
  const repByKey = new Map();
  for (const t of replayed) {
    repByKey.set(`${t.runId}|${t.symbol}|${t.direction}|${t.entryDate}|${t.exitDate}`, t);
  }

  const missing = [];
  const extra = [];
  const changed = [];

  for (const [key, t] of obsByKey) {
    const r = repByKey.get(key);
    if (!r) { missing.push(key); continue; }
    const diffs = [];
    if (Math.abs(r.entryPrice - t.entryPrice) > EPS) diffs.push(`entryPrice ${r.entryPrice} vs ${t.entryPrice}`);
    if (Math.abs(r.exitPrice - t.exitPrice) > EPS) diffs.push(`exitPrice ${r.exitPrice} vs ${t.exitPrice}`);
    if (Math.abs(r.costs - t.costs) > EPS) diffs.push(`costs ${r.costs} vs ${t.costs}`);
    if (Math.abs(r.netReturn - t.netReturn) > EPS) diffs.push(`netReturn ${r.netReturn} vs ${t.netReturn}`);
    if (diffs.length > 0) changed.push({ key, diffs });
  }

  for (const key of repByKey.keys()) {
    if (!obsByKey.has(key)) extra.push(key);
  }

  const passed = missing.length + extra.length + changed.length === 0;

  console.log('\n═══════════════════════════════════════════════');
  console.log('BASELINE IDENTITY GATE');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Replayed: ${replayed.length}  Observed: ${observed.length}`);
  console.log(`  Missing: ${missing.length}  Extra: ${extra.length}  Changed: ${changed.length}`);
  console.log(`  Result: ${passed ? 'PASS' : 'FAIL'}`);

  if (!passed) {
    for (const m of missing.slice(0, 5)) console.log(`  MISSING: ${m}`);
    for (const e of extra.slice(0, 5)) console.log(`  EXTRA:   ${e}`);
    for (const c of changed.slice(0, 5)) console.log(`  CHANGED: ${c.key} — ${c.diffs.join(', ')}`);
    console.log('\nFATAL: parameterized model diverges from observed. Fix before proceeding.');
    process.exit(1);
  }

  return { passed, replayedCount: replayed.length, observedCount: observed.length };
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

// ─── Load data ────────────────────────────────────────────

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
  return { signalDate: dates[signalIdx], signalIdx, exitIdx };
}

// ─── Run one config ───────────────────────────────────────

function runConfig(config, runIds, runMap) {
  const allTrades = [];
  let signalCount = 0;
  let coverageGaps = 0;

  for (const runId of runIds) {
    const raw = runMap.get(runId);
    if (!raw) continue;

    const sd = getSignalDate(raw, runId);
    if (!sd) continue;

    const top10 = runScanner(raw, sd.signalDate);
    const filtered = runHardFilter(top10, raw, sd.signalDate);

    const model = createModel({
      hvThreshold: config.hvThreshold,
      atrThreshold: config.atrThreshold,
      emaSlopeThreshold: config.emaSlopeThreshold
    });

    const signals = model.generateSignals(raw, { candidates: filtered }, sd.signalDate);
    signalCount += signals.length;

    if (signals.length === 0) {
      coverageGaps++;
      continue;
    }

    for (const s of signals) {
      const trade = executeTrade(s.symbol, s.direction, raw, sd.signalDate);
      if (trade) allTrades.push({ ...trade, runId });
    }
  }

  const n = allTrades.length;
  if (n === 0) {
    return {
      configId: config.id,
      varying: config.varying,
      hvThreshold: config.hvThreshold,
      atrThreshold: config.atrThreshold,
      emaSlopeThreshold: config.emaSlopeThreshold,
      tradeCount: 0,
      signalCount,
      coverageGaps,
      avgReturn: null,
      accuracy: null,
      bullishCount: 0, bullishAccuracy: null,
      bearishCount: 0, bearishAccuracy: null,
      trades: []
    };
  }

  const avgReturn = allTrades.reduce((a, t) => a + t.netReturn, 0) / n;
  const correct = allTrades.filter(t => t.netReturn > 0).length;
  const bullish = allTrades.filter(t => t.direction === 'bullish');
  const bearish = allTrades.filter(t => t.direction === 'bearish');

  return {
    configId: config.id,
    varying: config.varying,
    hvThreshold: config.hvThreshold,
    atrThreshold: config.atrThreshold,
    emaSlopeThreshold: config.emaSlopeThreshold,
    tradeCount: n,
    signalCount,
    coverageGaps,
    avgReturn,
    accuracy: correct / n,
    bullishCount: bullish.length,
    bullishAccuracy: bullish.length > 0 ? bullish.filter(t => t.netReturn > 0).length / bullish.length : null,
    bearishCount: bearish.length,
    bearishAccuracy: bearish.length > 0 ? bearish.filter(t => t.netReturn > 0).length / bearish.length : null,
    trades: allTrades
  };
}

// ─── Formatting ────────────────────────────────────────────

function fmtPct(v) {
  if (v === null || v === undefined) return '     N/A';
  return (v * 100).toFixed(2).padStart(8) + '%';
}

function fmtRatio(v) {
  if (v === null || v === undefined) return '   N/A';
  return (v * 100).toFixed(1).padStart(5) + '%';
}

function printGrid(results) {
  const baseline = results.find(r => r.configId === 'observed');

  console.log('\n┌──────────────────────────────────────────────────────────────────────────────────────────────┐');
  console.log('│  THRESHOLD ABLATION GRID — Single-variable sweep (in-sample, exploratory only)              │');
  console.log('├──────────┬──────────┬──────────┬──────────┬──────────┬──────────┬──────────┬────────┬────────┤');
  console.log('│ config   │  trades  │ signals  │ gaps     │ avg ret  │ accuracy │ bull acc │bear acc│ Δret   │');
  console.log('├──────────┼──────────┼──────────┼──────────┼──────────┼──────────┼──────────┼────────┼────────┤');

  for (const r of results) {
    const marker = r.configId === 'observed' ? ' ★' : '  ';
    const delta = baseline && r.avgReturn !== null && baseline.avgReturn !== null
      ? (r.avgReturn - baseline.avgReturn) : null;

    console.log(
      `│ ${(r.configId + marker).padEnd(19)}` +
      ` ${String(r.tradeCount).padStart(4)}    ` +
      ` ${String(r.signalCount).padStart(4)}    ` +
      ` ${String(r.coverageGaps).padStart(4)}    ` +
      ` ${fmtPct(r.avgReturn)}` +
      ` ${fmtPct(r.accuracy)}` +
      ` ${fmtRatio(r.bullishAccuracy)}` +
      ` ${fmtRatio(r.bearishAccuracy)}` +
      ` ${delta !== null ? (delta >= 0 ? '+' : '') + (delta * 100).toFixed(2).padStart(6) + '%' : '     N/A'}` +
      ` │`
    );
  }

  console.log('└──────────┴──────────┴──────────┴──────────┴──────────┴──────────┴──────────┴────────┴────────┘');

  // Parameter-specific sub-tables
  for (const param of ['hv', 'atr', 'ema']) {
    const paramResults = results.filter(r => r.varying === param);
    const paramLabel = { hv: 'HV ratio', atr: 'ATR%', ema: 'EMA slope' }[param];
    console.log(`\n  ${paramLabel} sweep (other params at observed defaults):`);
    for (const r of paramResults) {
      const val = { hv: r.hvThreshold, atr: r.atrThreshold, ema: r.emaSlopeThreshold }[param];
      console.log(`    ${param}=${val}: ${r.tradeCount} trades, avg ${(r.avgReturn * 100).toFixed(2)}%, acc ${(r.accuracy * 100).toFixed(1)}%`);
    }
  }

  // ATR caveat
  console.log('\n  ── ATR sweep caveat ──');
  console.log('  ATR=1.0/1.5 produce identical results to ATR=2.0 (observed).');
  console.log('  This means: on these 30 baseline-active dates, after Top 10 +');
  console.log('  hard filter + HV≥1.1 + |EMA slope|≥0.3 + trade executability,');
  console.log('  the final trade set was not altered by lowering ATR from 2.0→1.0.');
  console.log('  It does NOT prove that every Top 10 candidate has ATR% > 2.0.');
  console.log('  Per-candidate min/max/distribution audit would be needed for that claim.');

  // Non-monotonic caveat
  console.log('\n  ── Caveat: relationship is not monotonic ──');
  console.log('  Tighter thresholds do NOT universally increase returns.');
  console.log('  HV: 1.0→1.2 avg return rises, but 1.3 and 1.5 degrade sharply');
  console.log('  (1.5 only 9 trades at −1.15%). The grid reports the highest');
  console.log('  in-sample value per parameter range — not a "sweet spot" and');
  console.log('  not a basis for extrapolation. All values are exploratory.');
}

// ─── Main ──────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║  THRESHOLD ABLATION — P1 Item 3            ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  // Load observed trades to get runIds
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
  const observedRunIds = [...new Set(observedTrades.map(t => t.runId))].sort();

  console.log(`Observed: ${fwFiles[0]}`);
  console.log(`Observed T+10 trades: ${observedTrades.length}`);
  console.log(`Unique runIds: ${observedRunIds.length}\n`);

  const runMap = loadAllRuns();
  console.log(`Loaded ${runMap.size} historical runs\n`);

  const configs = buildConfigs();
  console.log(`Grid: ${configs.length} configs × ${observedRunIds.length} dates`);
  console.log(`(30 runIds conditioned on baseline-active dates only; ${runMap.size} total historical runs exist)\n`);

  // ── Gate 0: Baseline identity — must pass before grid ──
  console.log('[Gate 0] Baseline identity check (parameterized model vs observed)...');
  const baselineResult = runConfig(configs[0], observedRunIds, runMap);
  identityGate(baselineResult.trades, observedTrades);

  const results = [baselineResult];
  for (let i = 1; i < configs.length; i++) {
    const cfg = configs[i];
    console.log(`[${i}/${configs.length}] ${cfg.id}...`);
    const result = runConfig(cfg, observedRunIds, runMap);
    results.push(result);
    console.log(`  → ${result.tradeCount} trades, avg ${result.avgReturn !== null ? (result.avgReturn * 100).toFixed(2) + '%' : 'N/A'}, ${result.coverageGaps} gaps`);
  }

  printGrid(results);

  // Save
  const outPath = path.join(BACKTEST_DIR, `threshold-ablation-${Date.now()}.json`);
  const output = {
    description: 'Single-variable threshold ablation — exploratory in-sample',
    samplingNote: '30 runIds derived from observed-trade-positive dates only. ' +
      'Results are conditioned on baseline-active dates, not an unconditional ' +
      'evaluation over the full 44 historical runs. Per 缅因猫 review: this is ' +
      'acceptable for Item 3\'s fixed-same-30-dates constraint; Item 4 purged ' +
      'walk-forward must define train/test calendars independently of observed trades.',
    totalHistoricalRuns: runMap.size,
    baselineActiveRunIds: observedRunIds.length,
    grid: {
      hv: [1.0, 1.1, 1.2, 1.3, 1.5],
      atr: [1.0, 1.5, 2.0, 2.5, 3.0],
      ema: [0.1, 0.2, 0.3, 0.4, 0.5]
    },
    observedDefaults: OBSERVED,
    runIds: observedRunIds,
    runIdCount: observedRunIds.length,
    results: results.map(r => ({
      configId: r.configId,
      varying: r.varying,
      hvThreshold: r.hvThreshold,
      atrThreshold: r.atrThreshold,
      emaSlopeThreshold: r.emaSlopeThreshold,
      tradeCount: r.tradeCount,
      signalCount: r.signalCount,
      coverageGaps: r.coverageGaps,
      avgReturn: r.avgReturn,
      accuracy: r.accuracy,
      bullishCount: r.bullishCount,
      bullishAccuracy: r.bullishAccuracy,
      bearishCount: r.bearishCount,
      bearishAccuracy: r.bearishAccuracy
    })),
    timestamp: new Date().toISOString(),
    disclaimer: 'EXPLORATORY IN-SAMPLE. Conditioned on 30 baseline-active dates only. ' +
      'Relationship between thresholds and returns is non-monotonic; HV degrades ' +
      'sharply after 1.2. Grid maximum per parameter is an in-sample candidate only — ' +
      'not a "sweet spot" and not for production. Multiple comparisons not corrected. ' +
      'Purged walk-forward required before any threshold change.'
  };

  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\nSaved: ${path.basename(outPath)}`);

  console.log('\n═══════════════════════════════════════════════');
  console.log('CAVEATS (per 缅因猫 review):');
  console.log('═══════════════════════════════════════════════');
  console.log('1. 30 runIds conditioned on baseline-active dates only');
  console.log(`   (${runMap.size} total historical runs; only 30 had baseline trades).`);
  console.log('2. Threshold-return relationship is non-monotonic:');
  console.log('   HV=1.0→1.2 rises, but 1.3/1.5 degrade sharply.');
  console.log('3. ATR=1.0/1.5 identity to observed only proves: on these 30');
  console.log('   dates, after Top10+filter+HV+EMA+executability, lowering ATR');
  console.log('   did not alter the trade set. Not proof of Top10 ATR% > 2.0.');
  console.log('4. Grid maxima per parameter are exploratory in-sample candidates.');
  console.log('5. 13 comparisons × same 30 dates = multiple comparison risk.');
  console.log('6. Best thresholds are CANDIDATES ONLY for purged walk-forward');
  console.log('   — NOT for production replacement.');
}

main().catch(err => { console.error(err); process.exit(1); });
