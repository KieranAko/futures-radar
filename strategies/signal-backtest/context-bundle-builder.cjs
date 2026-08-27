// strategies/signal-backtest/context-bundle-builder.cjs — v5 紧凑上下文 bundle（确定性）
//
// 输入（全部冻结）：
//   recordings/v3/features.json            价格截断特征（取最近 20 锚点）
//   recordings/v5/macro-history.json       宏观历史序列
//   recordings/v5/sector-history.json      板块成员 bars（200 日）
//   recordings/v5/event-calendar.json      事件日历（含 weeklySeries）
//
// 输出：recordings/v5/bundle-<SYM>.json（每锚点一行紧凑字段，含 legend）。
// 所有字段 asOf/event.date <= 锚点日；测试可逐行重建比对。
'use strict';

const fs = require('fs');
const path = require('path');
const { skillRoot } = require('../../lib/workspace.cjs');

const ROOT = __dirname;
const V5 = path.join(ROOT, 'recordings', 'v5');
const FEATURES_PATH = path.join(ROOT, 'recordings', 'v3', 'features.json');
const SYMBOLS = ['RB0', 'M0', 'SC0'];
const PILOT_ANCHOR_COUNT = 20;

const mean = arr => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
const round = (v, d = 4) => (v == null || !isFinite(v) ? v : Math.round(v * Math.pow(10, d)) / Math.pow(10, d));
const loadJSON = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const day = d => Math.floor(new Date(`${d}T00:00:00Z`).getTime() / 86400000);

function anchors20() {
  const f = loadJSON(FEATURES_PATH);
  return Object.fromEntries(SYMBOLS.map(s => [s, f.anchors[s].slice(-PILOT_ANCHOR_COUNT)]));
}

function seriesAsOf(series, anchorDate) {
  const rows = (series || []).map(r => ({ date: String(r[0]), value: Number(r[1]) })).filter(r => r.date <= anchorDate);
  if (!rows.length) return null;
  const t = rows[rows.length - 1];
  const prev = rows.length >= 6 ? rows[rows.length - 6].value : null;
  return { asOf: t.date, value: round(t.value, 4), change5d: prev != null && prev !== 0 ? round((t.value / prev - 1) * 100, 2) : null };
}

function expandWeekly(cal) {
  const out = [];
  for (const w of cal.weeklySeries || []) {
    let d = new Date(`${w.start}T00:00:00Z`);
    const end = day(w.end);
    while (day(d.toISOString().slice(0, 10)) <= end) {
      if (d.getUTCDay() === w.weekday) {
        const ds = d.toISOString().slice(0, 10);
        if (ds >= w.start) out.push({ date: ds, type: w.type, title: w.title, scope: w.scope, verified: w.verified, schedule: w.schedule, source: w.source });
      }
      d = new Date(d.getTime() + 86400000);
    }
  }
  return out;
}

function buildSector(symbol, anchorDate) {
  const cfg = loadJSON(path.join(skillRoot, 'config', 'symbols.json'));
  const target = Object.values(cfg.symbols).find(v => v.symbol === symbol);
  const members = Object.values(cfg.symbols).filter(v => v.sector === target.sector && v.active !== false).map(v => v.symbol);
  const history = loadJSON(path.join(V5, 'sector-history.json'));
  const closesBySym = {};
  for (const m of members) {
    const bars = history.symbols && history.symbols[m];
    if (!bars || !bars.length) continue;
    closesBySym[m] = new Map(bars.filter(b => b.date <= anchorDate).map(b => [b.date, b.close]));
  }
  const available = Object.keys(closesBySym);
  if (available.length < 3) return { r1: null, r5: null, r20: null, br: null, co: null, lead: null, lag: null, mem: available.length, days: 0 };
  const daySet = new Set();
  for (const m of available) for (const d of closesBySym[m].keys()) daySet.add(d);
  const days = [...daySet].sort();
  let idx = 1000;
  const idxSeries = [];
  for (const d of days) {
    const prev = idxSeries.length ? idxSeries[idxSeries.length - 1] : null;
    const rets = [];
    for (const m of available) {
      const c = closesBySym[m].get(d);
      const p = prev ? closesBySym[m].get(prev.date) : null;
      if (c != null && p != null && p !== 0) rets.push(c / p - 1);
    }
    const ret = rets.length ? mean(rets) : 0;
    idx = prev ? idx * (1 + ret) : idx;
    idxSeries.push({ date: d, idx, ret });
  }
  const n = idxSeries.length;
  if (n < 6) return { r1: null, r5: null, r20: null, br: null, co: null, lead: null, lag: null, mem: available.length, days: n };
  const last = idxSeries[n - 1];
  const chg = k => (n - 1 - k >= 0 ? round((last.idx / idxSeries[n - 1 - k].idx - 1) * 100, 2) : null);
  const breadth = idxSeries.slice(-5).filter(x => x.ret > 0).length / Math.min(5, n);
  const sign = Math.sign(chg(5) || 0);
  const member5 = [];
  for (const m of available) {
    const ds = [...closesBySym[m].keys()].sort();
    const i = ds.length - 1;
    if (i < 5) continue;
    member5.push({ sym: m, r5: round((closesBySym[m].get(ds[i]) / closesBySym[m].get(ds[i - 5]) - 1) * 100, 2) });
  }
  const co = sign === 0 ? null : member5.filter(x => Math.sign(x.r5) === sign).length / Math.max(1, member5.length);
  member5.sort((a, b) => b.r5 - a.r5);
  return {
    r1: round(last.ret * 100, 2), r5: chg(5), r20: chg(20),
    br: round(breadth, 2), co: co == null ? null : round(co, 2),
    lead: member5.slice(0, 3).map(x => `${x.sym}:${x.r5}`).join(','),
    lag: member5.slice(-3).reverse().map(x => `${x.sym}:${x.r5}`).join(','),
    mem: available.length, days: n
  };
}

function buildEvents(symbol, anchorDate, cal, weekly) {
  const cfg = loadJSON(path.join(skillRoot, 'config', 'symbols.json'));
  const t = Object.values(cfg.symbols).find(v => v.symbol === symbol);
  const sector = t.sector;
  const relevant = e => e.scope.includes(symbol) || e.scope.includes(sector) || e.scope.includes('macro');
  const all = [...cal.events, ...weekly].filter(relevant);
  const past = all.filter(e => e.date <= anchorDate).sort((a, b) => a.date.localeCompare(b.date)).slice(-4)
    .map(e => `${e.date.slice(5)}|${e.type}|${e.verified ? 1 : 0}`);
  const anchorDay = day(anchorDate);
  const nxt = all.filter(e => e.date > anchorDate && day(e.date) - anchorDay <= 7).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 2)
    .map(e => `${e.date.slice(5)}|${e.type}|${e.verified ? 1 : 0}`);
  return { evt: past, nxt };
}

function buildBundle(symbol) {
  const anchors = anchors20()[symbol];
  const macroHistory = loadJSON(path.join(V5, 'macro-history.json'));
  const scBars = loadJSON(path.join(V5, 'history-2y.json')).symbols.SC0.bars;
  const cal = loadJSON(path.join(V5, 'event-calendar.json'));
  const weekly = expandWeekly(cal);
  const rows = anchors.map(a => {
    const macro = {};
    for (const [id, ind] of Object.entries(macroHistory.indicators)) {
      const s = seriesAsOf(ind.series, a.date);
      macro[id] = s ? [s.asOf.slice(5), s.value, s.change5d] : [null, null, null];
    }
    const sc = seriesAsOf(scBars.map(b => [b.date, b.close]), a.date);
    macro.SC0 = sc ? [sc.asOf.slice(5), sc.value, sc.change5d] : [null, null, null];
    const sect = buildSector(symbol, a.date);
    const ev = buildEvents(symbol, a.date, cal, weekly);
    return {
      d: a.date, idx: a.idx, c: a.close, m20: a.ma20, m60: a.ma60, a5: a.atr5, chg5: a.chg5, vol: a.volRatio,
      macro, sect, evt: ev.evt, nxt: ev.nxt
    };
  });
  return {
    schema: 'futures-radar-signal-bundle/1',
    symbol,
    anchorCount: rows.length,
    legend: {
      d: '锚点日期', idx: '截断索引', c: '收盘', m20: 'MA20', m60: 'MA60', a5: 'ATR5', chg5: '5日涨跌%', vol: '量比(量/5日均量)',
      macro: '{DXY/USDCNH/US10Y/DR007/SC0: [asOf月-日, 值, change5d%]}', sect: '{r1/r5/r20: 板块1/5/20日收益%, br: 5日上涨广度, co: 方向coherence, lead: 领涨成员:ret5, lag: 领跌, mem: 成员数, days: 可用天数}',
      evt: '过去事件 [月-日|类型|是否核实1/0]', nxt: '7日内日程事件 [月-日|类型|是否核实1/0]'
    },
    rows
  };
}

function buildAll() {
  fs.mkdirSync(V5, { recursive: true });
  const manifest = { schema: 'futures-radar-signal-bundle-manifest/1', generatedAt: new Date().toISOString(), anchorCount: PILOT_ANCHOR_COUNT, symbols: [] };
  for (const sym of SYMBOLS) {
    const bundle = buildBundle(sym);
    const p = path.join(V5, `bundle-${sym}.json`);
    fs.writeFileSync(p, JSON.stringify(bundle, null, 2), 'utf8');
    manifest.symbols.push({ symbol: sym, path: path.relative(V5, p), rows: bundle.rows.length });
  }
  fs.writeFileSync(path.join(V5, 'bundle-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return manifest;
}

if (require.main === module) console.log(JSON.stringify(buildAll(), null, 2));

module.exports = { anchors20, seriesAsOf, expandWeekly, buildSector, buildEvents, buildBundle, buildAll, V5 };
