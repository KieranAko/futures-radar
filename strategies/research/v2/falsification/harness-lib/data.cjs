// falsification harness — local data loaders + PIT view enforcement
// Only reads local files produced by GA-1..GA-7. No network, no wall-clock data.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT, FALS_DATA_DIR, assert } = require('./util.cjs');

const DATA_DIR = path.join(REPO_ROOT, 'data');
const DAILY_DIR = path.join(DATA_DIR, 'daily');
const SECTOR_DIR = path.join(DATA_DIR, 'sector');
const DERIVED_DIR = path.join(FALS_DATA_DIR, 'ga2-derived');
const ROLL_JUMPS_FILE = path.join(FALS_DATA_DIR, 'ga1-roll-jumps.json');
const TRADABLE_SET_FILE = path.join(FALS_DATA_DIR, 'ga6-tradable-set.json');
const CALENDAR_FILE = path.join(FALS_DATA_DIR, 'ga7-policy-calendar-v0.json');
const MACRO_HISTORY_FILE = path.join(REPO_ROOT, 'strategies', 'signal-backtest', 'recordings', 'v5', 'macro-history.json');

function readJson(file, label) {
  if (!fs.existsSync(file)) throw new Error(`${label} not found: ${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function loadDaily(symbol) {
  const f = path.join(DAILY_DIR, `${symbol}.json`);
  const d = readJson(f, `data/daily/${symbol}.json`);
  const o = d.contract.ohlcv;
  const n = o.dates.length;
  const nums = (name) => {
    const arr = o[name];
    if (!Array.isArray(arr) || arr.length !== n) throw new Error(`${symbol} ${name} length mismatch`);
    return arr.map((v) => (v === null || v === undefined ? null : Number(v)));
  };
  return {
    symbol,
    dates: o.dates.slice(),
    open: nums('open'),
    high: nums('high'),
    low: nums('low'),
    close: nums('close'),
    volume: nums('volume'),
    openInterest: nums('openInterest'),
    settle: nums('settle'),
    sources: o.sources.slice(),
    meta: {
      name: d.contract.name,
      exchange: d.contract.exchange,
      sector: d.contract.sector,
      multiplier: d.contract.multiplier,
      lastRunId: d.lastRunId,
      dataStart: d.contract.dataStart,
      dataEnd: d.contract.dataEnd,
    },
    n,
  };
}

// derived series (GA-2): aligned to daily dates by construction (same length/order)
function loadDerived(symbol, fields) {
  const f = path.join(DERIVED_DIR, `${symbol}.json`);
  const d = readJson(f, `ga2-derived/${symbol}.json`);
  const s = d.series;
  const out = { dates: s.dates.slice(), rollJumpDates: (d.rollJumpDates || []).slice() };
  for (const field of fields) {
    const arr = s[field];
    if (!Array.isArray(arr) || arr.length !== out.dates.length) {
      throw new Error(`ga2-derived/${symbol}.json field ${field} missing/misaligned`);
    }
    out[field] = arr.map((v) => (v === null || v === undefined ? null : Number(v)));
  }
  return out;
}

function loadSector(sector) {
  const f = path.join(SECTOR_DIR, `${sector}.json`);
  const d = readJson(f, `data/sector/${sector}.json`);
  return d; // { schema, sector, label, updatedAt, rows: [...] }
}

function loadMacro(indicatorId) {
  const m = readJson(MACRO_HISTORY_FILE, 'v5 macro-history.json');
  const ind = m.indicators[indicatorId];
  if (!ind) throw new Error(`macro indicator ${indicatorId} not found in v5 macro-history`);
  const series = ind.series.map(([date, value]) => ({ date, value: Number(value) }));
  return { id: indicatorId, series, asOf: ind.asOf, source: ind.source, status: ind.status, backfill: m.backfill };
}

function loadRollJumps() {
  const d = readJson(ROLL_JUMPS_FILE, 'ga1-roll-jumps.json');
  const bySymbol = {};
  for (const [sym, jumps] of Object.entries(d.bySymbol)) {
    bySymbol[sym] = new Set(jumps.map((j) => j.date));
  }
  return { threshold: d.threshold, totalJumpBars: d.totalJumpBars, bySymbol };
}

function loadTradableSet() {
  return readJson(TRADABLE_SET_FILE, 'ga6-tradable-set.json');
}

function loadCalendar() {
  const d = readJson(CALENDAR_FILE, 'ga7-policy-calendar-v0.json');
  return d; // { events: [{id,date,end,type,sector,title,scope,verified,source,note}], schedules: [...] }
}

// ---------- PIT view ----------
// A view exposes field access only up to anchorIdx (inclusive). Any read past the
// anchor throws LookaheadViolation — the mechanical no-future-function guard (F8).
class LookaheadViolation extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'LookaheadViolation';
  }
}

class PitView {
  constructor(label, fields, anchorIdx) {
    this.label = label;
    this.fields = fields;
    this.anchorIdx = anchorIdx;
    this._counts = {};
  }
  at(field, i) {
    if (i > this.anchorIdx) {
      throw new LookaheadViolation(`${this.label}.${field}[${i}] read past anchor ${this.anchorIdx}`);
    }
    if (i < 0 || i >= this.fields[field].length) return null;
    return this.fields[field][i];
  }
  series(field) {
    // returns array up to anchor (shallow copy) — safe to hand to adapters
    return this.fields[field].slice(0, this.anchorIdx + 1);
  }
  dateAt(i) {
    return this.at('dates', i);
  }
}

class PitContext {
  // ctx passed to adapters on signal bar T (anchorIdx = index of T).
  // Fields come from a merged set: daily ohlcv + derived + macro + sector views.
  constructor(anchorIdx, daily, extra) {
    this.anchorIdx = anchorIdx;
    this.anchorDate = daily.dates[anchorIdx];
    this.daily = daily;
    this.extra = extra || {};
    this.view = new PitView('daily', daily, anchorIdx);
    this.views = {};
    for (const [name, fields] of Object.entries(this.extra)) {
      this.views[name] = new PitView(name, fields, anchorIdx);
    }
    this.violations = [];
  }
  field(sym, name) {
    // merged lookup: daily first, then extra views keyed by symbol
    const d = this.daily;
    if (name === 'dates' || name === 'open' || name === 'high' || name === 'low' || name === 'close' ||
        name === 'volume' || name === 'openInterest' || name === 'settle' || name === 'sources') {
      return { dates: d.dates, [name]: d[name] };
    }
    if (this.views[sym]) return this.views[sym].fields;
    throw new Error(`no extra view for symbol ${sym} (field ${name})`);
  }
  // event gate: only events with event.date <= anchorDate are visible (F9)
  eventActive(symbol, calendarEvents) {
    const out = [];
    for (const ev of calendarEvents || []) {
      if (ev.date <= this.anchorDate && ev.end >= this.anchorDate) {
        const scope = ev.scope || [];
        if (scope.includes(symbol) || scope.includes(this.daily.meta?.sector)) out.push(ev);
      }
    }
    return out;
  }
}

function makeDailyDateIndex(daily) {
  const idx = new Map();
  daily.dates.forEach((d, i) => idx.set(d, i));
  return idx;
}

module.exports = {
  DATA_DIR, DAILY_DIR, SECTOR_DIR, DERIVED_DIR,
  ROLL_JUMPS_FILE, TRADABLE_SET_FILE, CALENDAR_FILE, MACRO_HISTORY_FILE,
  readJson,
  loadDaily, loadDerived, loadSector, loadMacro, loadRollJumps, loadTradableSet, loadCalendar,
  PitView, PitContext, LookaheadViolation, makeDailyDateIndex,
};
