// falsification harness — walk-forward engine
// Deterministic purged-expanding / rolling folds, T+1 execution loop, three baselines.
'use strict';

const {
  loadDaily, loadDerived, loadSector, loadMacro, loadRollJumps, loadTradableSet, loadCalendar,
  PitView, LookaheadViolation,
} = require('./data.cjs');
const { TradeSim } = require('./sim.cjs');
const { assert, Rng, round, isFiniteNum } = require('./util.cjs');
const { mean, bootstrapPairedDiffCI } = require('./stats.cjs');

// ---------------- fold construction ----------------
// global timeline = union of all universe symbols' bar dates
function buildTimeline(dailyBySymbol) {
  const set = new Set();
  for (const d of Object.values(dailyBySymbol)) for (const date of d.dates) set.add(date);
  return Array.from(set).sort();
}

// purged expanding by calendar year: fold k test = year Y bars; train = [0, testStart - purgeBars)
function buildYearFolds(timeline, { start, end, purgeBars = 5 }) {
  const folds = [];
  let i = 0;
  const n = timeline.length;
  while (i < n && timeline[i] < start) i++;
  const startIdx = i;
  let endIdx = n - 1;
  while (endIdx >= 0 && timeline[endIdx] > end) endIdx--;
  assert(startIdx <= endIdx, `period [${start},${end}] has no bars`);
  let k = startIdx;
  while (k <= endIdx) {
    const year = timeline[k].slice(0, 4);
    let m = k;
    while (m <= endIdx && timeline[m].slice(0, 4) === year) m++;
    folds.push({
      id: `fold-${folds.length + 1}-${year}`,
      year,
      testStart: k,
      testEnd: m - 1, // inclusive
      trainEndExclusive: Math.max(0, k - purgeBars),
    });
    k = m;
  }
  return { folds, startIdx, endIdx };
}

// rolling windows: consecutive windowMonths-month evaluation blocks (test-only)
function buildRollingFolds(timeline, { start, end, windowMonths = 12 }) {
  const folds = [];
  const n = timeline.length;
  let i = 0;
  while (i < n && timeline[i] < start) i++;
  const startIdx = i;
  let endIdx = n - 1;
  while (endIdx >= 0 && timeline[endIdx] > end) endIdx--;
  assert(startIdx <= endIdx, `period [${start},${end}] has no bars`);
  let k = startIdx;
  while (k <= endIdx) {
    const y0 = Number(timeline[k].slice(0, 4));
    const m0 = Number(timeline[k].slice(5, 7));
    const endYm = y0 * 12 + (m0 - 1) + windowMonths - 1; // window end month (inclusive)
    const endY = Math.floor(endYm / 12);
    const endM = (endYm % 12) + 1;
    const endKey = `${String(endY).padStart(4, '0')}-${String(endM).padStart(2, '0')}`;
    let m = k;
    while (m <= endIdx && timeline[m] <= `${endKey}-31`) m++;
    folds.push({
      id: `window-${folds.length + 1}`,
      label: `${timeline[k].slice(0, 7)}..${timeline[Math.min(m - 1, endIdx)].slice(0, 7)}`,
      testStart: k,
      testEnd: Math.min(m - 1, endIdx),
      trainEndExclusive: 0,
    });
    k = m;
  }
  return { folds, startIdx, endIdx };
}

function buildFolds(mode, timeline, opts) {
  if (mode === 'purged-expanding') return buildYearFolds(timeline, opts);
  if (mode === 'rolling') return buildRollingFolds(timeline, opts);
  throw new Error(`unknown folds.mode: ${mode}`);
}

// ---------------- engine ----------------
class Engine {
  constructor(spec, { adapters, seed = 20260828, log = null } = {}) {
    this.spec = spec;
    this.adapters = adapters;
    this.seed = seed >>> 0;
    this.rng = new Rng(seed);
    this.log = log || { info() {}, warn() {} };
  }

  load() {
    const spec = this.spec;
    const dailyBySymbol = {};
    const derivedBySymbol = {};
    const jumpDates = spec.data.rollJumps
      ? loadRollJumps()
      : { threshold: 0.095, totalJumpBars: 0, bySymbol: {} };
    for (const sym of spec.universe.symbols) {
      dailyBySymbol[sym] = loadDaily(sym);
      if (spec.data.derived && spec.data.derived.length) {
        derivedBySymbol[sym] = loadDerived(sym, spec.data.derived);
      }
    }
    const sectors = {};
    for (const s of spec.data.sector || []) sectors[s] = loadSector(s);
    const macro = {};
    for (const id of spec.data.macro || []) macro[id] = loadMacro(id);
    const calendar = spec.data.calendar ? loadCalendar() : { events: [], schedules: [] };
    const tradable = spec.data.tradableSet ? new Set(loadTradableSet().tradableSymbols) : null;
    const timeline = buildTimeline(dailyBySymbol);
    const barIndexBySymbol = {};
    for (const [sym, d] of Object.entries(dailyBySymbol)) {
      const m = new Map();
      d.dates.forEach((date, i) => m.set(date, i));
      barIndexBySymbol[sym] = m;
    }
    return { dailyBySymbol, derivedBySymbol, sectors, macro, calendar, tradable, timeline, barIndexBySymbol, jumpDates };
  }

  // ctx at global date: per-symbol views anchored at each symbol's last bar ≤ date (PIT)
  makeCtx(data, date, perSymbolAnchor) {
    const ctx = {
      anchorDate: date,
      anchorIdxBySymbol: perSymbolAnchor,
      barToday: {},
      daily: {},
      derived: {},
      macro: {},
      calendar: data.calendar.events || [],
      jumpDates: data.jumpDates.bySymbol,
      tradable: data.tradable,
      eventActive: (symbol) => {
        const out = [];
        for (const ev of data.calendar.events || []) {
          if (ev.date <= date && ev.end >= date) {
            const scope = ev.scope || [];
            const sector = data.dailyBySymbol[symbol]?.meta?.sector;
            if (scope.includes(symbol) || (sector && scope.includes(sector))) out.push(ev);
          }
        }
        return out;
      },
    };
    for (const [sym, d] of Object.entries(data.dailyBySymbol)) {
      const idx = perSymbolAnchor[sym];
      ctx.barToday[sym] = d.dates[idx] === date;
      ctx.daily[sym] = new PitView(`daily:${sym}`, d, idx === null ? -1 : idx);
    }
    for (const [sym, d] of Object.entries(data.derivedBySymbol)) {
      const idx = perSymbolAnchor[sym];
      ctx.derived[sym] = new PitView(`derived:${sym}`, d, idx === null ? -1 : idx);
    }
    for (const [id, m] of Object.entries(data.macro)) {
      const dates = [];
      const values = [];
      for (const row of m.series) {
        if (row.date <= date) {
          dates.push(row.date);
          values.push(row.value);
        }
      }
      ctx.macro[id] = { dates, values };
    }
    return ctx;
  }

  run() {
    const spec = this.spec;
    const data = this.load();
    const adapterDef = this.adapters[spec.signal.adapter];
    if (!adapterDef) throw new Error(`unknown adapter: ${spec.signal.adapter}`);
    const adapter = adapterDef.createAdapter({ spec, data, engine: this });
    const foldsMode = spec.folds.mode;
    const foldOpts = {
      start: spec.period.start,
      end: spec.period.end,
      purgeBars: spec.folds.purgeBars ?? 5,
      windowMonths: spec.folds.windowMonths ?? 12,
    };
    const { folds, startIdx } = buildFolds(foldsMode, data.timeline, foldOpts);
    const cost = spec.execution.cost || { roundtripBps: 7, legs: 1 };

    const intentsLog = []; // diagnostics/replay
    const allTrades = [];
    const foldResults = [];
    const violations = [];
    let adapterState = adapter.initState ? adapter.initState() : {};
    const paramsHistory = [];

    for (const fold of folds) {
      // calibration (purged): params trained on data strictly before testStart - purgeBars
      let params;
      let calibProvenance;
      if (adapter.calibrate && fold.trainEndExclusive > 0) {
        const calibIdx = fold.trainEndExclusive - 1;
        const calibDate = data.timeline[calibIdx];
        const perSym = this._anchorsAt(data, calibDate);
        const ctx = this.makeCtx(data, calibDate, perSym);
        params = adapter.calibrate(ctx, { fold, calibDate, spec });
        calibProvenance = { kind: 'adapter-calibrated', endDate: calibDate, purgeBars: spec.folds.purgeBars ?? 5 };
      } else {
        params = spec.params || {};
        calibProvenance = { kind: 'pre-registered-initial' };
      }
      paramsHistory.push({ fold: fold.id, params, calibProvenance });

      const sim = new TradeSim({
        cost,
        jumpDatesBySymbol: data.jumpDates.bySymbol,
        pathPriority: spec.execution.pathPriority || 'stop-first',
        derivedViews: data.derivedBySymbol,
      });
      const meta = { daily: data.dailyBySymbol };
      for (let gi = fold.testStart; gi <= fold.testEnd; gi++) {
        const date = data.timeline[gi];
        const perSym = this._anchorsAt(data, date);
        const ctx = this.makeCtx(data, date, perSym);
        try {
          const out = adapter.evalBar(ctx, adapterState, params, { fold });
          const list = Array.isArray(out) ? out : out ? [out] : [];
          for (const intent of list) {
            intent.signalDate = date;
            if (!intent.legs || !intent.legs.length) {
              throw new Error(`adapter ${spec.signal.adapter} returned intent without legs`);
            }
            sim.submitIntent(intent, meta);
            intentsLog.push(this._serializeIntent(intent));
          }
        } catch (e) {
          if (e instanceof LookaheadViolation) {
            violations.push({ fold: fold.id, date, error: e.message, kind: 'lookahead' });
            throw e; // lookahead is a hard failure — never silently swallowed
          }
          throw e;
        }
        sim.onGlobalDate(date, data.barIndexBySymbol);
      }
      sim.forceCloseAll(data.timeline[fold.testEnd], data.barIndexBySymbol);
      foldResults.push({
        fold: fold.id, year: fold.year || null, label: fold.label || fold.year || fold.id,
        testStart: data.timeline[fold.testStart], testEnd: data.timeline[fold.testEnd],
        calibProvenance,
        trades: sim.trades.length, abandons: sim.abandons.length,
        abandonReasons: _countBy(sim.abandons, (a) => a.reason),
      });
      allTrades.push(...sim.trades.map((t) => ({ ...t, foldId: fold.id })));
    }

    const strategyTrades = allTrades;
    const baselines = this._runBaselines({ data, folds, cost, strategyTrades, intentsLog });

    let theory = null;
    if (adapter.theory && spec.theoryLevel?.engine !== 'none') {
      theory = adapter.theory({ strategyTrades, foldResults, baselines, data, spec, paramsHistory });
    }

    return {
      spec: { specId: spec.specId, strategyId: spec.strategyId },
      meta: { seed: this.seed, foldsMode, generatedAt: new Date().toISOString() },
      data: {
        symbols: spec.universe.symbols,
        timelineStart: data.timeline[startIdx],
        timelineEnd: data.timeline[data.timeline.length - 1],
        nBars: data.timeline.length,
      },
      folds: foldResults,
      paramsHistory,
      trades: strategyTrades,
      intentsLog,
      baselines,
      theory,
      violations,
    };
  }

  _anchorsAt(data, date) {
    const perSym = {};
    for (const [sym, d] of Object.entries(data.dailyBySymbol)) {
      const idx = data.barIndexBySymbol[sym].get(date);
      perSym[sym] = idx !== undefined ? idx : _lastIdxBefore(d.dates, date);
    }
    return perSym;
  }

  _serializeIntent(intent) {
    return {
      signalDate: intent.signalDate,
      direction: intent.direction,
      legs: intent.legs.map((lg) => ({ symbol: lg.symbol, side: lg.side, stop: lg.stop, target: lg.target, weight: lg.weight })),
      sizeR: intent.sizeR || 1,
      timeExitBars: intent.timeExitBars ?? null,
      gapAbandon: intent.gapAbandon || null,
      gapAtrValues: intent.gapAtrValues || null,
      tags: intent.tags || {},
      hasManage: Boolean(intent.manage),
    };
  }

  _runBaselines({ data, folds, cost, strategyTrades, intentsLog }) {
    const spec = this.spec;
    const out = {};
    const want = spec.strategyLevel.baselines || [];

    // market baselines: per symbol per fold, first tradeable bar open → last bar close
    if (want.includes('always-long') || want.includes('always-short')) {
      for (const dirName of ['always-long', 'always-short']) {
        if (!want.includes(dirName)) continue;
        const side = dirName === 'always-long' ? +1 : -1;
        const rows = [];
        for (const fold of folds) {
          for (const sym of spec.universe.symbols) {
            const d = data.dailyBySymbol[sym];
            let i0 = data.barIndexBySymbol[sym].get(data.timeline[fold.testStart]);
            const i1 = data.barIndexBySymbol[sym].get(data.timeline[fold.testEnd]);
            if (i0 === undefined || i1 === undefined || i0 >= i1) continue;
            // skip jump bars at window open (F5: artifact prices)
            while (i0 < i1 && data.jumpDates.bySymbol[sym]?.has(d.dates[i0])) i0++;
            if (i0 >= i1) continue;
            const entry = d.open[i0];
            const exit = d.close[i1];
            const retBps = ((side * (exit - entry)) / entry) * 1e4 - cost.roundtripBps / (cost.legs || 1);
            rows.push({
              fold: fold.id, symbol: sym, side, entryDate: d.dates[i0], exitDate: d.dates[i1],
              retBps: round(retBps),
            });
          }
        }
        out[dirName] = {
          convention: 'per symbol per fold: hold from first non-jump bar open to last bar close, side=±1, roundtrip cost deducted; retBps = side*(exit-entry)/entry*1e4 - roundtripBps/legs',
          rows,
          stats: { n: rows.length, meanRetBps: mean(rows.map((r) => r.retBps)) },
        };
      }
    }

    if (want.includes('random')) {
      const cfg = spec.strategyLevel.random || {};
      const mode = cfg.mode || 'same-entries-flipped-side';
      const runs = Math.max(1, cfg.runs || 1);
      const runResults = [];
      for (let run = 0; run < runs; run++) {
        const sim = new TradeSim({
          cost,
          jumpDatesBySymbol: data.jumpDates.bySymbol,
          pathPriority: spec.execution.pathPriority || 'stop-first',
          derivedViews: data.derivedBySymbol,
        });
        const meta = { daily: data.dailyBySymbol };
        if (mode === 'same-entries-flipped-side') {
          // mirror every strategy trade around its actual entry price:
          // same signal/entry bar, same risk bracket, opposite side
          for (const t of strategyTrades) {
            const intent = {
              signalDate: t.signalDate,
              direction: -t.direction,
              legs: t.legs.map((lg) => {
                // mirror the INITIAL (fill-time) bracket around the actual entry price;
                // managed-exit trades (FS-05 z-stops etc.) use their declared initial bracket
                const stop0 = isFiniteNum(lg.stopInit) ? lg.stopInit : lg.stop;
                const tgt0 = isFiniteNum(lg.targetInit) ? lg.targetInit : lg.target;
                const stopD = isFiniteNum(stop0) ? stop0 - lg.entry : null;
                const tgtD = isFiniteNum(tgt0) ? tgt0 - lg.entry : null;
                const stop = isFiniteNum(stopD) ? (Math.abs(stopD) < 1e-9 ? lg.entry - 1 : lg.entry - stopD) : null;
                const target = isFiniteNum(tgtD) ? (Math.abs(tgtD) < 1e-9 ? null : lg.entry - tgtD) : null;
                return { symbol: lg.symbol, side: -lg.side, stop, target, weight: lg.weight };
              }),
              sizeR: t.sizeR,
              timeExitBars: t.timeExitBars,
              gapAbandon: null, // fill bar identical to original (gap condition inherited)
              gapAtrValues: null,
              tags: { ...t.tags, baseline: 'random-flipped' },
            };
            sim.submitIntent(intent, meta);
          }
        } else if (mode === 'random-entries') {
          const eligible = this._eligibleBars(data, folds, spec);
          const riskProfile = strategyTrades
            .map((t) => ({
              stopDist: mean(t.legs.map((lg) => lg.riskDist)),
              targetDist: mean(t.legs.map((lg) => (isFiniteNum(lg.target) ? Math.abs(lg.target - lg.entry) : null))),
              timeExitBars: t.timeExitBars,
            }))
            .filter((p) => isFiniteNum(p.stopDist) && p.stopDist > 0);
          const N = strategyTrades.length;
          const rng = new Rng((this.seed ^ 0x9e3779b9) + run * 2654435761);
          for (let k = 0; k < N; k++) {
            const bar = eligible.length ? rng.pick(eligible) : null;
            if (!bar) continue;
            const profile = riskProfile.length ? rng.pick(riskProfile) : null;
            if (!profile) continue;
            const d = data.dailyBySymbol[bar.symbol];
            const side = rng.coin() ? +1 : -1;
            const entryRef = d.close[bar.idx];
            const stop = entryRef - side * profile.stopDist;
            const target = isFiniteNum(profile.targetDist) ? entryRef + side * profile.targetDist : null;
            sim.submitIntent({
              signalDate: d.dates[bar.idx],
              direction: side,
              legs: [{ symbol: bar.symbol, side, stop, target, weight: 1 }],
              sizeR: 1,
              timeExitBars: profile.timeExitBars,
              gapAbandon: null,
              gapAtrValues: null,
              tags: { baseline: 'random-entries' },
            }, meta);
          }
        } else {
          throw new Error(`unknown random baseline mode: ${mode}`);
        }
        // replay on the FULL global timeline slice spanned by intents/folds (fills need every date)
        const firstDate = sim.pending.length ? sim.pending[0].intent.signalDate : data.timeline[folds[0].testStart];
        const lastDate = data.timeline[Math.min(folds[folds.length - 1].testEnd + 1, data.timeline.length - 1)];
        let g0 = data.timeline.findIndex((d) => d >= firstDate);
        let g1 = data.timeline.findIndex((d) => d >= lastDate);
        if (g0 < 0) g0 = 0;
        if (g1 < 0) g1 = data.timeline.length - 1;
        for (let gi = g0; gi <= g1; gi++) sim.onGlobalDate(data.timeline[gi], data.barIndexBySymbol);
        sim.forceCloseAll(data.timeline[g1], data.barIndexBySymbol);
        runResults.push({
          run, mode,
          seed: (this.seed ^ 0x9e3779b9) + run * 2654435761,
          trades: sim.trades.length,
          netRs: sim.trades.map((t) => t.netR),
        });
      }
      out.random = {
        convention: mode === 'same-entries-flipped-side'
          ? 'same entry bars as strategy; direction and stop/target mirrored around the actual entry price; dynamic manage() exits not mirrored (fixed-price brackets used)'
          : 'random eligible bars + random sides; stop/target distances bootstrapped from strategy trades',
        mode, runs,
        runResults,
        pooledNetRs: runResults.flatMap((r) => r.netRs),
      };
    }
    return out;
  }

  _eligibleBars(data, folds, spec) {
    const out = [];
    const warmup = spec.warmupBars || 0;
    for (const fold of folds) {
      for (let gi = fold.testStart; gi <= fold.testEnd; gi++) {
        const date = data.timeline[gi];
        for (const sym of spec.universe.symbols) {
          const idx = data.barIndexBySymbol[sym].get(date);
          if (idx === undefined || idx < warmup + 1) continue;
          if (data.jumpDates.bySymbol[sym]?.has(date)) continue;
          out.push({ symbol: sym, date, idx });
        }
      }
    }
    return out;
  }
}

function _lastIdxBefore(dates, date) {
  let i = dates.length - 1;
  while (i >= 0 && dates[i] > date) i--;
  return i;
}

function _countBy(arr, fn) {
  const out = {};
  for (const a of arr) {
    const k = fn(a);
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

// baseline comparison: paired bootstrap CI of (strategy mean - baseline mean) on R series
function compareToBaseline(strategyNetRs, baselineNetRs, { level = 0.95, B = 10000, seed = 20260828 } = {}) {
  const ci = bootstrapPairedDiffCI(strategyNetRs, baselineNetRs, { level, B, seed });
  const stratMean = mean(strategyNetRs);
  const baseMean = mean(baselineNetRs);
  return {
    strategyMeanR: stratMean,
    baselineMeanR: baseMean,
    diffMeanR: ci.obsDiff,
    diffCI: [ci.lo, ci.hi],
    beatsBaseline: ci.lo !== null && ci.hi !== null && ci.lo > 0,
    method: ci.method,
  };
}

module.exports = { Engine, buildTimeline, buildFolds, compareToBaseline };
