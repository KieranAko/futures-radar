// strategies/signal-backtest/context-assembler.cjs — v4 上下文组装器（确定性）
//
// 为每个试点锚点（每品种最近 10 个，共 30 个）组装 asOf 截断的上下文包：
//   price   : 复用 v3 冻结特征（已审计无未来数据）
//   macro   : DXY/USDCNH/US10Y/DR007 历史序列取 asOf <= 锚点日 的最后一根；SC0 复用 2y bars
//   sector  : 板块成员 bars 截断到锚点日，等权链式指数 + 广度 + 方向 coherence + 领涨/领跌
//   events  : 事件日历中 date <= 锚点日 的近期事件；含日程已知的未来最近事件（nextScheduled）
//
// 纪律：本模块不调用 LLM、不联网；所有数值必须能从冻结 JSON 重新计算。
'use strict';

const fs = require('fs');
const path = require('path');
const store = require('../../data-store/index.cjs');
const { skillRoot } = require('../../lib/workspace.cjs');

const ROOT = __dirname;
const V4 = path.join(ROOT, 'recordings', 'v4');
const FEATURES_PATH = path.join(ROOT, 'recordings', 'v3', 'features.json');
const MACRO_PATH = path.join(V4, 'macro-history.json');
const SECTOR_PATH = path.join(V4, 'sector-history.json');
const EVENTS_PATH = path.join(V4, 'event-calendar.json');
const CONTEXT_DIR = path.join(V4, 'context');
const PILOT_ANCHOR_COUNT = 10;
const SYMBOLS = ['RB0', 'M0', 'SC0'];

const mean = arr => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
function round(v, d = 4) { if (v == null || !isFinite(v)) return v; const f = Math.pow(10, d); return Math.round(v * f) / f; }

function loadJSON(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

function pilotAnchors() {
  const features = loadJSON(FEATURES_PATH);
  const anchors = {};
  for (const sym of SYMBOLS) anchors[sym] = features.anchors[sym].slice(-PILOT_ANCHOR_COUNT);
  return anchors;
}

function seriesAsOf(series, anchorDate) {
  if (!Array.isArray(series) || series.length === 0) return null;
  const rows = series.map(r => ({ date: String(r[0]), value: Number(r[1]) })).filter(r => r.date <= anchorDate);
  if (rows.length === 0) return null;
  const t = rows[rows.length - 1];
  const prev = rows.length >= 6 ? rows[rows.length - 6].value : null;
  return {
    asOf: t.date,
    value: round(t.value, 4),
    change5d: prev != null && prev !== 0 ? round(((t.value / prev) - 1) * 100, 2) : null,
    status: t.date === anchorDate ? 'fresh' : 'stale'
  };
}

function buildMacro(anchorDate, sc0Bars) {
  const h = loadJSON(MACRO_PATH);
  const items = [];
  for (const [id, ind] of Object.entries(h.indicators || {})) {
    const s = seriesAsOf(ind.series, anchorDate);
    items.push({
      id,
      label: id,
      ...(s || { asOf: null, value: null, change5d: null, status: 'missing' }),
      source: ind.spec && ind.spec.kind
    });
  }
  // SC0 复用 2y bars（宏观配置里的 SC0 锚点）
  const sc = seriesAsOf(sc0Bars.map(b => [b.date, b.close]), anchorDate);
  items.push({ id: 'SC0', label: 'SC0', ...(sc || { asOf: null, value: null, change5d: null, status: 'missing' }), source: 'raw_contract' });
  return items;
}

function buildSector(symbol, anchorDate) {
  const config = loadJSON(path.join(skillRoot, 'config', 'symbols.json'));
  const all = Object.values(config.symbols || {});
  const target = all.find(v => v.symbol === symbol);
  if (!target) throw new Error(`context-assembler: unknown symbol ${symbol}`);
  const members = all.filter(v => v.sector === target.sector && v.active !== false).map(v => v.symbol);
  const history = loadJSON(SECTOR_PATH);
  const closesBySym = {};
  for (const m of members) {
    const bars = history.symbols && history.symbols[m];
    if (!bars || !bars.length) continue;
    closesBySym[m] = new Map(bars.filter(b => b.date <= anchorDate).map(b => [b.date, b.close]));
  }
  const available = Object.keys(closesBySym);
  if (available.length < 3) return { status: 'insufficient_members', members: available.length };

  // 交易日 = 任一成员有数据的日期，按升序截断到 anchorDate
  const daySet = new Set();
  for (const m of available) for (const d of closesBySym[m].keys()) daySet.add(d);
  const days = [...daySet].sort();
  let idx = 1000;
  const indexSeries = [];
  const dayReturns = [];
  for (const d of days) {
    const prevDay = indexSeries.length ? indexSeries[indexSeries.length - 1] : null;
    const rets = [];
    for (const m of available) {
      const c = closesBySym[m].get(d);
      const p = prevDay ? closesBySym[m].get(prevDay.date) : null;
      if (c != null && p != null && p !== 0) rets.push(c / p - 1);
    }
    const ret = rets.length ? mean(rets) : 0;
    idx = prevDay ? idx * (1 + ret) : idx;
    indexSeries.push({ date: d, idx, ret });
    dayReturns.push({ date: d, ret: round(ret * 100, 2) });
  }
  const n = indexSeries.length;
  if (n < 6) return { status: 'insufficient_history', members: available.length };
  const last = indexSeries[n - 1];
  const chg = k => (n - 1 - k >= 0 ? round((last.idx / indexSeries[n - 1 - k].idx - 1) * 100, 2) : null);
  const breadth = dayReturns.slice(-5).filter(r => r.ret > 0).length / Math.min(5, dayReturns.length);
  const sign = Math.sign(chg(5) || 0);
  const member5 = [];
  for (const m of available) {
    const dates = [...closesBySym[m].keys()].sort();
    const i = dates.length - 1;
    if (i < 5) continue;
    member5.push({ symbol: m, ret5d: round((closesBySym[m].get(dates[i]) / closesBySym[m].get(dates[i - 5]) - 1) * 100, 2) });
  }
  const coherence = sign === 0 ? null : member5.filter(x => Math.sign(x.ret5d) === sign).length / Math.max(1, member5.length);
  member5.sort((a, b) => b.ret5d - a.ret5d);
  return {
    status: 'ok',
    sector: target.sector,
    members: available.length,
    index: round(last.idx, 2),
    ret1d: round(last.ret * 100, 2),
    ret5d: chg(5),
    ret20d: chg(20),
    breadth5d: round(breadth, 2),
    coherence5d: coherence == null ? null : round(coherence, 2),
    leading: member5.slice(0, 3),
    lagging: member5.slice(-3).reverse(),
    daysAvailable: n
  };
}

function buildEvents(symbol, anchorDate) {
  const cal = loadJSON(EVENTS_PATH);
  const secOf = sym => {
    const config = loadJSON(path.join(skillRoot, 'config', 'symbols.json'));
    const t = Object.values(config.symbols || {}).find(v => v.symbol === sym);
    return t ? t.sector : null;
  };
  const sector = secOf(symbol);
  const relevant = e => e.scope.includes(symbol) || e.scope.includes(sector) || e.scope.includes('macro');
  const day = d => Math.floor(new Date(`${d}T00:00:00Z`).getTime() / 86400000);
  const anchorDay = day(anchorDate);
  const past = cal.events.filter(e => relevant(e) && e.date <= anchorDate).sort((a, b) => a.date.localeCompare(b.date)).slice(-4).map(e => ({ date: e.date, type: e.type, title: e.title, verified: e.verified, schedule: e.schedule || null }));
  const next = cal.events.filter(e => relevant(e) && e.date > anchorDate && day(e.date) - anchorDay <= 7).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 2).map(e => ({ date: e.date, type: e.type, title: e.title, verified: e.verified, schedule: e.schedule || null }));
  return { past, nextScheduled: next, totalInCalendar: cal.events.length };
}

function buildOne(symbol, anchor) {
  const history = loadJSON(path.join(V4, 'history-2y.json'));
  const sc0Bars = history.symbols.SC0.bars;
  return {
    schema: 'futures-radar-signal-context/1',
    symbol,
    anchorDate: anchor.date,
    anchorIdx: anchor.idx,
    price: {
      close: anchor.close, ma20: anchor.ma20, ma60: anchor.ma60,
      atr5: anchor.atr5, chg5: anchor.chg5, volRatio: anchor.volRatio
    },
    macro: { items: buildMacro(anchor.date, sc0Bars) },
    sector: buildSector(symbol, anchor.date),
    events: buildEvents(symbol, anchor.date)
  };
}

function assemble() {
  fs.mkdirSync(CONTEXT_DIR, { recursive: true });
  const anchors = pilotAnchors();
  const manifest = { schema: 'futures-radar-signal-context-manifest/1', generatedAt: new Date().toISOString(), anchorCount: PILOT_ANCHOR_COUNT, symbols: {} };
  for (const sym of SYMBOLS) {
    manifest.symbols[sym] = [];
    for (const a of anchors[sym]) {
      const packet = buildOne(sym, a);
      const out = path.join(CONTEXT_DIR, `${sym}-${a.date}.json`);
      fs.writeFileSync(out, JSON.stringify(packet, null, 2), 'utf8');
      manifest.symbols[sym].push({ date: a.date, idx: a.idx, path: path.relative(V4, out) });
    }
  }
  fs.writeFileSync(path.join(V4, 'context-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return manifest;
}

if (require.main === module) {
  const manifest = assemble();
  console.log(JSON.stringify(manifest, null, 2));
}

module.exports = { pilotAnchors, seriesAsOf, buildMacro, buildSector, buildEvents, buildOne, assemble, V4, CONTEXT_DIR };
