// falsification harness — self-test battery (synthetic data + one real-data smoke)
// `node harness.cjs selftest` → runs all tests, writes data/harness-selftest.json, exit 0/1
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { Rng, round, stableHash, FALS_DATA_DIR } = require('./util.cjs');
const S = require('./stats.cjs');
const { TradeSim } = require('./sim.cjs');
const { Engine, buildFolds } = require('./engine.cjs');
const { LookaheadViolation } = require('./data.cjs');
const G = require('./gates.cjs');
const demoAdapter = require('./strategies/demo.cjs');

const TOL = 1e-9;

function makeBars({ dates, open, high, low, close, volume }) {
  const n = dates.length;
  const fill = (arr) => (Array.isArray(arr) && arr.length === n ? arr : new Array(n).fill(arr));
  return {
    dates: dates.slice(),
    open: fill(open),
    high: fill(high),
    low: fill(low),
    close: fill(close),
    volume: fill(volume ?? 0),
    openInterest: new Array(n).fill(0),
    settle: new Array(n).fill(0),
    sources: new Array(n).fill('synthetic'),
    n,
  };
}

function datesFrom(start, n) {
  // consecutive weekdays starting at `start` (weekends skipped, no duplicates)
  const out = [];
  const d0 = new Date(Date.UTC(2020, 0, 6)); // a Monday
  let day = Math.floor((Date.parse(start) - d0.getTime()) / 86400000);
  while (out.length < n) {
    const d = new Date(d0.getTime() + day * 86400000);
    const wd = d.getUTCDay();
    day += wd === 5 ? 3 : wd === 6 ? 2 : 1; // Fri→Mon, Sat→Mon, else next day
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}
function ok(cond, msg) {
  if (!cond) throw new Error(msg);
}
function approx(a, b, tol = TOL, msg = '') {
  if (a === null || b === null) throw new Error(`approx null: ${a} vs ${b} ${msg}`);
  if (Math.abs(a - b) > tol) throw new Error(`approx ${a} vs ${b} (tol ${tol}) ${msg}`);
}

// ---------------- statistics ----------------
test('stats: PF / hitRate / mean / sharpe exact', () => {
  const rs = [1, -1, 2, -0.5, 3, -2];
  approx(S.profitFactor(rs), (1 + 2 + 3) / (1 + 0.5 + 2));
  approx(S.hitRateNet(rs), 3 / 6);
  approx(S.mean(rs), 2.5 / 6);
  const s = S.std(rs, 1);
  ok(s > 0, 'std finite');
});

test('stats: t-test & binomial known values', () => {
  const t = S.tTestOneSample([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0);
  approx(t.mean, 5.5);
  ok(t.p < 1e-3, `t p small: ${t.p}`);
  const b = S.binomialTest(60, 100, 0.5, 'two');
  approx(b.p, 0.056887, 0.0005, `binomial p ${b.p}`);
  const bg = S.binomialTest(60, 100, 0.5, 'greater');
  approx(bg.p, 0.028444, 0.0005, `binomial greater p ${bg.p}`);
});

test('stats: bootstrap CI excludes 0 on positive-edge series', () => {
  const rng = new Rng(42);
  const xs = [];
  for (let i = 0; i < 400; i++) xs.push(0.5 + rng.uniform() * 2 - 1); // mean 0.5, sd ~0.58
  const ci = S.bootstrapMeanCI(xs, { B: 2000, seed: 7 });
  ok(ci.lo > 0, `CI lo ${ci.lo} > 0`);
  approx(S.mean(xs), ci.obs, 1e-9);
});

test('stats: paired diff CI positive when x = y + 0.3', () => {
  const rng = new Rng(5);
  const xs = []; const ys = [];
  for (let i = 0; i < 300; i++) {
    const base = rng.uniform() * 2 - 1;
    ys.push(base);
    xs.push(base + 0.3);
  }
  const d = S.bootstrapPairedDiffCI(xs, ys, { B: 2000, seed: 11 });
  ok(d.lo > 0, `diff CI lo ${d.lo} > 0`);
  approx(d.obsDiff, 0.3, 1e-9);
});

test('stats: OLS exact on line', () => {
  const x = Array.from({ length: 10 }, (_, i) => i);
  const y = x.map((v) => 2 + 3 * v);
  const r = S.ols(x, y);
  approx(r.alpha, 2);
  approx(r.beta, 3);
  approx(r.r2, 1);
});

test('stats: ADF rejects unit root for AR(1) phi=0.5, fails to reject for RW', () => {
  const rng = new Rng(123);
  const rw = [0];
  for (let i = 1; i < 500; i++) rw.push(rw[i - 1] + (rng.uniform() * 2 - 1));
  const ar = [0];
  for (let i = 1; i < 500; i++) ar.push(0.5 * ar[i - 1] + (rng.uniform() * 2 - 1));
  const aRw = S.adf(rw, { table: 'df-const' });
  const aAr = S.adf(ar, { table: 'df-const' });
  ok(aRw.pApprox >= 0.10, `RW pApprox ${aRw.pApprox} >= 0.10 (t=${round(aRw.tStat)})`);
  ok(aAr.reject10 === true, `AR(1) reject10 (t=${round(aAr.tStat)}, p=${aAr.pApprox})`);
});

test('stats: Engle-Granger detects cointegration, rejects independent pair', () => {
  const rng = new Rng(777);
  const n = 600;
  const x = [0];
  for (let i = 1; i < n; i++) x.push(x[i - 1] + (rng.uniform() * 2 - 1));
  const e = [0];
  for (let i = 1; i < n; i++) e.push(0.3 * e[i - 1] + (rng.uniform() * 2 - 1));
  const y = x.map((v, i) => v + e[i]);
  const eg = S.engleGranger(y, x);
  ok(eg.adf.reject05 === true, `cointegrated residual reject05 (t=${round(eg.adf.tStat)})`);
  const x2 = [0];
  for (let i = 1; i < n; i++) x2.push(x2[i - 1] + (rng.uniform() * 2 - 1));
  const eg2 = S.engleGranger(x2, x);
  ok(eg2.adf.pApprox >= 0.10, `independent pair pApprox ${eg2.adf.pApprox} >= 0.10`);
  const ec = S.ecmGamma(y, x, eg.resid);
  ok(ec.gamma !== null && ec.gamma < 0, `ECM gamma ${round(ec.gamma)} < 0`);
  approx(ec.gamma, -0.7, 0.1, `gamma near phi-1`);
});

// ---------------- simulator ----------------
function simFixture() {
  const dates = datesFrom('2020-01-06', 30);
  const n = 30;
  const open = new Array(n).fill(100);
  const high = new Array(n).fill(101);
  const low = new Array(n).fill(99);
  const close = new Array(n).fill(100);
  const bars = makeBars({ dates, open, high, low, close });
  const meta = { daily: { X: bars } };
  const barIdx = { X: new Map(dates.map((d, i) => [d, i])) };
  return { bars, meta, barIdx, dates };
}

function runSim({ bars, meta, barIdx, dates }, intent, { jumps = {}, cost = { roundtripBps: 7, legs: 1 } } = {}) {
  const sim = new TradeSim({ cost, jumpDatesBySymbol: jumps });
  sim.submitIntent(intent, meta);
  for (const d of dates) sim.onGlobalDate(d, barIdx);
  sim.forceCloseAll(dates[dates.length - 1], barIdx);
  return sim;
}

test('sim: T+1 fill at next bar open', () => {
  const f = simFixture();
  const intent = {
    signalDate: f.dates[2], direction: +1,
    legs: [{ symbol: 'X', side: +1, stop: 95, target: 110, weight: 1 }],
    sizeR: 1, timeExitBars: 5, gapAbandon: null, gapAtrValues: null, tags: {},
  };
  const sim = runSim(f, intent);
  ok(sim.trades.length === 1, 'one trade');
  const t = sim.trades[0];
  ok(t.entryDate === f.dates[3], `entryDate ${t.entryDate} == ${f.dates[3]}`);
  approx(t.legs[0].entry, f.bars.open[3]);
});

test('sim: gap-abandon when T+1 open gap exceeds 0.5xATR', () => {
  const f = simFixture();
  f.bars.open[3] = 103.5; // gap 3.5 > 0.5*5 = 2.5
  const intent = {
    signalDate: f.dates[2], direction: +1,
    legs: [{ symbol: 'X', side: +1, stop: 95, target: 110, weight: 1 }],
    sizeR: 1, timeExitBars: 5,
    gapAbandon: { type: 'atr', factor: 0.5 }, gapAtrValues: { X: 5 }, tags: {},
  };
  const sim = runSim(f, intent);
  ok(sim.trades.length === 0, 'no fill');
  ok(sim.abandons.length === 1 && sim.abandons[0].reason === 'gap-abandon', 'gap-abandon recorded');
});

test('sim: stop-first path priority (stop & target same bar → stop)', () => {
  const f = simFixture();
  f.bars.high[4] = 112; f.bars.low[4] = 94; // both touched
  const intent = {
    signalDate: f.dates[3], direction: +1,
    legs: [{ symbol: 'X', side: +1, stop: 95, target: 110, weight: 1 }],
    sizeR: 1, timeExitBars: 20, gapAbandon: null, gapAtrValues: null, tags: {},
  };
  const sim = runSim(f, intent);
  const t = sim.trades[0];
  ok(t.exitReason === 'stop', `exitReason ${t.exitReason}`);
  approx(t.legs[0].exit, 95);
  approx(t.legs[0].rawR, -1);
});

test('sim: target hit when only target touched', () => {
  const f = simFixture();
  f.bars.high[4] = 111; f.bars.low[4] = 97;
  const intent = {
    signalDate: f.dates[3], direction: +1,
    legs: [{ symbol: 'X', side: +1, stop: 95, target: 110, weight: 1 }],
    sizeR: 1, timeExitBars: 20, gapAbandon: null, gapAtrValues: null, tags: {},
  };
  const sim = runSim(f, intent);
  const t = sim.trades[0];
  ok(t.exitReason === 'target', `exitReason ${t.exitReason}`);
  approx(t.legs[0].exit, 110);
  approx(t.legs[0].rawR, 2);
});

test('sim: gap through stop → exit at open', () => {
  const f = simFixture();
  f.bars.open[4] = 90; f.bars.high[4] = 92; f.bars.low[4] = 88;
  const intent = {
    signalDate: f.dates[3], direction: +1,
    legs: [{ symbol: 'X', side: +1, stop: 95, target: 110, weight: 1 }],
    sizeR: 1, timeExitBars: 20, gapAbandon: null, gapAtrValues: null, tags: {},
  };
  const sim = runSim(f, intent);
  const t = sim.trades[0];
  ok(t.legs[0].exitReason === 'stop-gap-through', `reason ${t.legs[0].exitReason}`);
  approx(t.legs[0].exit, 90);
});

test('sim: time exit at close of timeExitBars-th bar', () => {
  const f = simFixture();
  f.bars.close[12] = 102; // entry bar idx 3, 10th held bar = idx 12
  const intent = {
    signalDate: f.dates[2], direction: +1,
    legs: [{ symbol: 'X', side: +1, stop: 90, target: 150, weight: 1 }],
    sizeR: 1, timeExitBars: 10, gapAbandon: null, gapAtrValues: null, tags: {},
  };
  const sim = runSim(f, intent);
  const t = sim.trades[0];
  ok(t.exitReason === 'time-exit', `reason ${t.exitReason}`);
  ok(t.exitDate === f.dates[12], `exitDate ${t.exitDate}`);
  approx(t.legs[0].exit, 102);
});

test('sim: onFill recomputes bracket against actual T+1 open', () => {
  const f = simFixture();
  f.bars.open[3] = 101; // fill 101 instead of signal close 100
  const intent = {
    signalDate: f.dates[2], direction: +1,
    legs: [{ symbol: 'X', side: +1, stop: 95, target: 110, weight: 0.5 },
           { symbol: 'X', side: +1, stop: 95, target: 115, weight: 0.5 }],
    sizeR: 1, timeExitBars: null, gapAbandon: null, gapAtrValues: null, tags: {},
    onFill(trade) {
      const entry = trade.legs[0].entry;
      trade.legs[0].stop = entry - 5;
      trade.legs[0].riskDist = 5;
      trade.legs[0].target = entry + 10;
      trade.legs[1].stop = entry - 5;
      trade.legs[1].riskDist = 5;
      trade.legs[1].target = entry + 15;
    },
  };
  const sim = runSim(f, intent);
  const t = sim.trades[0];
  approx(t.legs[0].stop, 96);
  approx(t.legs[0].riskDist, 5);
  approx(t.legs[0].target, 111);
  ok(t.legs[0].stopInit === 95, 'stopInit keeps the fill-time initial bracket');
});

test('sim: manage decision.add fills add-on leg at next open and participates in R accounting', () => {
  const f = simFixture();
  let addOnce = false;
  const intent = {
    signalDate: f.dates[2], direction: +1,
    legs: [{ symbol: 'X', side: +1, stop: 90, target: 150, weight: 0.5 },
           { symbol: 'X', side: +1, stop: 90, target: 150, weight: 0.5 }],
    sizeR: 1, timeExitBars: null, gapAbandon: null, gapAtrValues: null, tags: {},
    manage({ trade, date, barInfo }) {
      if (addOnce || !barInfo.X || trade.legs.length >= 3) return null;
      addOnce = true;
      return { add: { symbol: 'X', side: +1, stop: 90, target: 150, addR: 0.5, addNo: 1 } };
    },
  };
  const sim = runSim(f, intent);
  const t = sim.trades[0];
  ok(t.legs.length === 3, `legs after add ${t.legs.length}`);
  const addLeg = t.legs[2];
  ok(addLeg.addOn === true, 'add leg flagged');
  approx(addLeg.entry, f.bars.open[4]); // manage ran at bar idx3 → add fills at idx4 open
  approx(addLeg.weight, 0.5); // 0.5R / sizeRBase(1)
  ok(t.exitReason === 'end-of-fold', `exit ${t.exitReason}`);
  const expected = t.legs[0].netR * 0.5 + t.legs[1].netR * 0.5 + t.legs[2].netR * 0.5;
  approx(t.netR, expected, 1e-5, 'netR sums initial halves + add half');
});

test('sim: cost model exact (7bp roundtrip, 1 leg)', () => {
  const f = simFixture();
  f.bars.high[4] = 111; f.bars.low[4] = 97;
  const intent = {
    signalDate: f.dates[3], direction: +1,
    legs: [{ symbol: 'X', side: +1, stop: 95, target: 110, weight: 1 }],
    sizeR: 1, timeExitBars: 20, gapAbandon: null, gapAtrValues: null, tags: {},
  };
  const sim = runSim(f, intent, { cost: { roundtripBps: 7, legs: 1 } });
  const t = sim.trades[0];
  approx(t.legs[0].rawR, 2);
  approx(t.legs[0].costR, (7 / 1e4) * 100 / 5);
  approx(t.netR, 2 - (7 / 1e4) * 20);
});

test('sim: roll-jump bar bans entry and force-closes holdings at prev close', () => {
  const f = simFixture();
  const jumps = { X: new Set([f.dates[4]]) };
  // intent at 3 → fill would be at 4 (jump) → abandoned
  const intentA = {
    signalDate: f.dates[3], direction: +1,
    legs: [{ symbol: 'X', side: +1, stop: 95, target: 110, weight: 1 }],
    sizeR: 1, timeExitBars: 20, gapAbandon: null, gapAtrValues: null, tags: {},
  };
  const sim = runSim(f, intentA, { jumps });
  ok(sim.trades.length === 0, 'entry banned on jump bar');
  ok(sim.abandons[0]?.reason === 'roll-jump-bar', 'abandon reason roll-jump-bar');
  // open position through a jump date → close at prev close
  const f2 = simFixture();
  f2.bars.close[3] = 105; // prev close of jump bar
  const intentB = {
    signalDate: f2.dates[2], direction: +1,
    legs: [{ symbol: 'X', side: +1, stop: 90, target: 150, weight: 1 }],
    sizeR: 1, timeExitBars: 20, gapAbandon: null, gapAtrValues: null, tags: {},
  };
  const sim2 = runSim(f2, intentB, { jumps });
  const t = sim2.trades[0];
  ok(t.exitReason === 'roll-jump', `reason ${t.exitReason}`);
  approx(t.legs[0].exit, 105, 1e-9, 'exit at prev close');
});

test('sim: multi-leg any-stop closes siblings at close, weighted R', () => {
  const f = simFixture();
  // add symbol Y with aligned dates
  const barsY = makeBars({ dates: f.dates, open: 200, high: 201, low: 199, close: 200 });
  f.meta.daily.Y = barsY;
  f.barIdx.Y = new Map(f.dates.map((d, i) => [d, i]));
  f.bars.high[4] = 112; f.bars.low[4] = 94;   // X stops
  barsY.close[4] = 203;                       // Y closes at 203
  const intent = {
    signalDate: f.dates[3], direction: +1,
    legs: [
      { symbol: 'X', side: +1, stop: 95, target: 110, weight: 0.5 },
      { symbol: 'Y', side: -1, stop: 210, target: 180, weight: 0.5 },
    ],
    sizeR: 1, timeExitBars: 20, gapAbandon: null, gapAtrValues: null, tags: {},
  };
  const sim = runSim(f, intent, { cost: { roundtripBps: 0, legs: 2 } });
  const t = sim.trades[0];
  ok(t.exitReason === 'stop', 'stop');
  const xLeg = t.legs[0]; const yLeg = t.legs[1];
  approx(xLeg.exit, 95);
  ok(yLeg.exitReason === 'close-on-sibling-stop', yLeg.exitReason);
  approx(yLeg.exit, 203);
  approx(xLeg.rawR, -1);
  approx(yLeg.rawR, -(203 - 200) / (210 - 200));
  approx(t.grossR, 0.5 * -1 + 0.5 * yLeg.rawR);
});

// ---------------- engine: folds & guards ----------------
test('engine: purged-expanding year folds correct', () => {
  const timeline = [];
  for (let y = 2018; y <= 2021; y++) {
    for (let m = 1; m <= 3; m++) timeline.push(`${y}-0${m}-15`);
  }
  const { folds } = buildFolds('purged-expanding', timeline, { start: '2018-01-01', end: '2021-12-31', purgeBars: 2 });
  ok(folds.length === 4, `folds=${folds.length}`);
  ok(folds[0].testStart === 0 && folds[0].testEnd === 2, 'fold1 spans 2018');
  ok(folds[1].trainEndExclusive === 1, 'fold2 trainEnd = testStart(3) - purge(2) = 1');
  ok(folds[3].year === '2021', 'last fold 2021');
});

test('engine: lookahead guard throws on future bar access', () => {
  const f = simFixture();
  const engine = new Engine({}, { adapters: {} });
  const data = { dailyBySymbol: { X: f.bars }, derivedBySymbol: {}, macro: {}, calendar: { events: [] }, jumpDates: { bySymbol: {} }, barIndexBySymbol: f.barIdx, tradable: null };
  const anchors = { X: 2 };
  const ctx = engine.makeCtx(data, f.dates[2], anchors);
  let threw = false;
  try {
    ctx.daily.X.at('close', 3);
  } catch (e) {
    threw = e instanceof LookaheadViolation;
  }
  ok(threw, 'LookaheadViolation raised');
});

test('engine: determinism — two runs produce identical resultsHash', () => {
  const spec = require('../specs/demo-momentum.json');
  const run = () => {
    const engine = new Engine(spec, { adapters: { demo: demoAdapter }, seed: 20260828 });
    const result = engine.run();
    const gate = G.evaluateStrategyGate(result, spec);
    const theoryEval = G.evaluateTheory(result.theory);
    const kill = G.evaluateKillRules(result, spec, theoryEval);
    const suggestion = G.suggestState({ spec, strategyGate: gate, theoryEval, killVerdicts: kill });
    return stableHash({ trades: result.trades.map((t) => [t.entryDate, t.exitDate, t.netR]), gate, kill, suggestion });
  };
  ok(run() === run(), 'byte-identical across runs');
});

test('engine: demo smoke on real RB0 data (2015–2026), no violations', () => {
  const spec = require('../specs/demo-momentum.json');
  const engine = new Engine(spec, { adapters: { demo: demoAdapter }, seed: 20260828 });
  const result = engine.run();
  ok(result.violations.length === 0, 'no lookahead violations');
  ok(result.trades.length > 50, `trades=${result.trades.length} > 50`);
  const gate = G.evaluateStrategyGate(result, spec);
  const theoryEval = G.evaluateTheory(result.theory);
  const kill = G.evaluateKillRules(result, spec, theoryEval);
  const suggestion = G.suggestState({ spec, strategyGate: gate, theoryEval, killVerdicts: kill });
  ok(gate.stats.n === result.trades.length, 'gate n matches');
  ok(['designed', 'suspended', 'retired', 'validated-eligible'].includes(suggestion.suggestedState), 'valid suggested state');
  return { trades: result.trades.length, gate: gate.checks, suggestion: suggestion.suggestedState };
});

test('engine: random-flipped baseline discriminates against strategy edge', () => {
  const spec = require('../specs/demo-momentum.json');
  const engine = new Engine(spec, { adapters: { demo: demoAdapter }, seed: 20260828 });
  const result = engine.run();
  const stratMean = S.mean(result.trades.map((t) => t.netR));
  const flippedMean = S.mean(result.baselines.random.pooledNetRs);
  ok(result.baselines.random.mode === 'same-entries-flipped-side', 'mode');
  // flipped = opposite side, brackets mirrored around entry, SAME conservative management.
  // It is not an algebraic negative (stop-first priority is not reflection-symmetric);
  // it must still be clearly below the strategy when the strategy has real edge.
  ok(flippedMean < 0, `flipped mean ${round(flippedMean)} < 0`);
  ok(flippedMean < stratMean - 0.5, `flipped ${round(flippedMean)} < strategy ${round(stratMean)} - 0.5`);
});

// ---------------- gates ----------------
test('gates: sample insufficiency stays designed; theory falsified retires', () => {
  const base = require('../specs/demo-momentum.json');
  const spec = { ...base, strategyLevel: { ...base.strategyLevel, minTrades: 99999 } };
  const trades = [];
  for (let i = 0; i < 150; i++) trades.push({ foldId: 'fold-1', netR: 1.0 });
  for (let i = 0; i < 150; i++) trades.push({ foldId: 'fold-1', netR: -0.4 });
  const fakeResult = { trades, folds: [{ fold: 'fold-1' }], meta: { seed: 1 }, baselines: {} };
  const gate = G.evaluateStrategyGate(fakeResult, spec);
  ok(gate.checks.find((c) => c.id === 'minTrades').passed === false, 'minTrades fails');
  ok(gate.checks.filter((c) => !c.passed).every((c) => c.id === 'minTrades'), 'only minTrades fails');
  const theoryEval = { present: true, anyFalsified: false, falsified: [], tests: [], killOn: null };
  const kill = G.evaluateKillRules(fakeResult, spec, theoryEval);
  const sug = G.suggestState({ spec, strategyGate: gate, theoryEval, killVerdicts: kill });
  ok(sug.suggestedState === 'designed', `state ${sug.suggestedState} (sample insufficiency)`);
  const theoryFalsified = { present: true, anyFalsified: true, falsified: [{ id: 't1' }], tests: [], killOn: null };
  const sug2 = G.suggestState({ spec, strategyGate: gate, theoryEval: theoryFalsified, killVerdicts: kill });
  ok(sug2.suggestedState === 'retired', `state ${sug2.suggestedState} (theory falsified)`);
});

// ---------------- runner ----------------
function runAll({ verbose = false } = {}) {
  const results = [];
  let failed = 0;
  const t0 = Date.now();
  for (const t of tests) {
    const t1 = Date.now();
    let status = 'PASS';
    let detail = '';
    let extra = null;
    try {
      const ret = t.fn();
      if (ret && typeof ret === 'object') extra = ret;
    } catch (e) {
      status = 'FAIL';
      failed++;
      detail = e.message;
    }
    results.push({ name: t.name, status, detail, ms: Date.now() - t1, extra });
    if (verbose) console.log(`${status}  ${t.name}  ${detail}  (${Date.now() - t1}ms)`);
  }
  const summary = {
    schema: 'falsification-harness-selftest/1',
    generatedAt: new Date().toISOString(),
    total: results.length,
    passed: results.length - failed,
    failed,
    durationMs: Date.now() - t0,
    results,
  };
  const outFile = path.join(FALS_DATA_DIR, 'harness-selftest.json');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(summary, null, 2), 'utf8');
  console.log(`selftest: ${summary.passed}/${summary.total} passed, ${summary.failed} failed (${summary.durationMs}ms)`);
  console.log(`written: ${outFile}`);
  return summary;
}

module.exports = { tests, runAll };

if (require.main === module) {
  const s = runAll({ verbose: true });
  process.exit(s.failed > 0 ? 1 : 0);
}
