// strategies/lib/story-indicators.cjs — 传导链节点指标计算器（数据哨兵）
//
// 两种模式（均只读文件库，文件库是唯一事实源）：
//   历史模式 computeForDate(date)：data/daily 全品种 + data/macro-history/<ANCHOR>.json
//   运行模式 computeForRun(runId)：runId 仅用于从 data/macro/<runId>.json 取 signalDate，
//   指标仍全部从 data/daily + data/macro-history 计算，不读 output/runs。
//
// 每个指标返回 { value, prevValue, prevAt, asOf, direction, speedZ? }：
//   value     = 当前周期真实值（asOf 为该值的真实数据日）
//   prevValue = 上一周期真实值（序列上前一个交易日/观测日，不是上次跑批记录）
//   direction = sign(value)
// 哨兵用 asOf 判定「是否有新数据」；无新数据不得确认/证伪。
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { skillRoot } = require('../../lib/workspace.cjs');
const macroHistory = require('../../collector/macro-history-builder.cjs');

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function mean(xs) {
  const v = xs.filter((x) => Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

function sign(v) {
  if (!Number.isFinite(v) || v === 0) return 0;
  return v > 0 ? 1 : -1;
}

function lastIdxLE(dates, target) {
  let lo = 0, hi = dates.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid] <= target) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return ans;
}

function prevIdxLE(dates, target) {
  // 严格小于 target 的最后一个下标
  let lo = 0, hi = dates.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid] < target) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return ans;
}

function loadSymbols() {
  const cfg = readJson(path.join(skillRoot, 'config', 'symbols.json'));
  return (cfg && cfg.symbols || []).filter((s) => s.active && s.sector !== 'financial');
}

function loadDailySeries(symbol) {
  const d = readJson(path.join(skillRoot, 'data', 'daily', `${symbol}.json`));
  const o = d && d.contract && d.contract.ohlcv;
  if (!o) return null;
  return { symbol, dates: o.dates, open: o.open, close: o.close, oi: o.openInterest };
}

// 板块指数（与 collector/sector-aggregator.cjs 同口径：等权日收益链式，基点 1000）
function buildSectorIndex(members, sortedDates) {
  const closeMap = new Map();
  for (const m of members) {
    const map = new Map();
    for (let i = 0; i < m.dates.length; i++) map.set(m.dates[i], m.close[i]);
    closeMap.set(m.symbol, map);
  }
  const rows = [];
  let lastLevel = 1000;
  for (let i = 0; i < sortedDates.length; i++) {
    const date = sortedDates[i];
    const prevDate = i > 0 ? sortedDates[i - 1] : null;
    const rets = [];
    for (const m of members) {
      const map = closeMap.get(m.symbol);
      const cur = map.get(date);
      const prev = prevDate === null ? null : map.get(prevDate);
      if (Number.isFinite(cur) && Number.isFinite(prev) && prev > 0 && cur > 0) rets.push((cur / prev - 1) * 100);
    }
    if (rets.length === 0) continue;
    const avg = mean(rets);
    const level = lastLevel * (1 + avg / 100);
    rows.push({ date, level, ret5: null });
    lastLevel = level;
  }
  for (let i = 0; i < rows.length; i++) {
    rows[i].ret5 = i >= 5 ? (rows[i].level / rows[i - 5].level - 1) * 100 : null;
  }
  return rows;
}

function zscore(cur, series, window = 60) {
  const xs = series.slice(-window).filter((x) => Number.isFinite(x));
  if (xs.length < 20) return null;
  const m = mean(xs);
  const sd = Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length);
  if (!(sd > 0)) return null;
  return (cur - m) / sd;
}

// ── 原子指标计算（返回 { value, asOf } 或 null）──────────────
function macroChangeAt(anchor, targetDate) {
  const pairs = macroHistory.loadMacroHistory(anchor) || [];
  const dates = pairs.map(([d]) => d);
  const i = lastIdxLE(dates, targetDate);
  if (i < 0 || i < 5) return null;
  const asOf = dates[i];
  const lastDay = Date.parse(`${asOf}T00:00:00Z`);
  const nowDay = Date.parse(`${targetDate}T00:00:00Z`);
  if ((nowDay - lastDay) / 86400000 > 7) return null; // 陈旧数据 fail-closed
  return { value: (pairs[i][1] / pairs[i - 5][1] - 1) * 100, asOf };
}

function symbolRet5At(series, targetDate) {
  const i = lastIdxLE(series.dates, targetDate);
  if (i < 5 || !Number.isFinite(series.close[i - 5]) || series.close[i - 5] <= 0) return null;
  return { value: (series.close[i] / series.close[i - 5] - 1) * 100, asOf: series.dates[i] };
}

function symbolVsMa20At(series, targetDate) {
  const i = lastIdxLE(series.dates, targetDate);
  if (i < 19) return null;
  const ma20 = mean(series.close.slice(i - 19, i + 1));
  if (!Number.isFinite(ma20)) return null;
  return { value: series.close[i] - ma20, asOf: series.dates[i] };
}

function sectorRet5At(indexRows, targetDate) {
  const idx = lastIdxLE(indexRows.map((r) => r.date), targetDate);
  if (idx < 0 || !Number.isFinite(indexRows[idx].ret5)) return null;
  return { value: indexRows[idx].ret5, asOf: indexRows[idx].date };
}

function sectorOiFlowAt(members, tradingDates, targetDate) {
  const dateIdx = lastIdxLE(tradingDates, targetDate);
  if (dateIdx < 5) return null;
  const d = tradingDates[dateIdx];
  const pd = tradingDates[dateIdx - 5];
  let sumNow = 0, sumPrev = 0, cnt = 0;
  for (const m of members) {
    const mi = lastIdxLE(m.dates, d);
    const pi = lastIdxLE(m.dates, pd);
    if (mi >= 0 && pi >= 0 && m.dates[mi] === d
      && Number.isFinite(m.oi[mi]) && m.oi[mi] > 0
      && Number.isFinite(m.oi[pi]) && m.oi[pi] > 0) {
      sumNow += m.oi[mi]; sumPrev += m.oi[pi]; cnt++;
    }
  }
  if (cnt < 3 || sumPrev <= 0) return null;
  return { value: (sumNow / sumPrev - 1) * 100, asOf: d };
}

function marketRet5At(sectors, indexBySector, targetDate) {
  const vals = [];
  for (const sec of sectors) {
    const r = sectorRet5At(indexBySector.get(sec), targetDate);
    if (r) vals.push(r.value);
  }
  return vals.length >= 2 ? mean(vals) : null;
}

function rsAt(sector, indexBySector, targetDate) {
  const r = sectorRet5At(indexBySector.get(sector), targetDate);
  if (!r) return null;
  const market = marketRet5At([...indexBySector.keys()], indexBySector, targetDate);
  if (!Number.isFinite(market)) return null;
  return { value: r.value - market, asOf: r.asOf };
}

// ── 历史模式 ────────────────────────────────────────────────
function computeForDate(date) {
  const symbols = loadSymbols();
  const sectors = [...new Set(symbols.map((s) => s.sector))].sort();
  const seriesBySymbol = new Map();
  for (const s of symbols) {
    const ser = loadDailySeries(s.symbol);
    if (ser) { ser.sector = s.sector; seriesBySymbol.set(s.symbol, ser); }
  }
  const membersBySector = new Map();
  for (const sec of sectors) {
    membersBySector.set(sec, symbols.filter((s) => s.sector === sec).map((s) => seriesBySymbol.get(s.symbol)).filter(Boolean));
  }

  const allDatesSet = new Set();
  for (const s of seriesBySymbol.values()) for (const d of s.dates) allDatesSet.add(d);
  const tradingDates = [...allDatesSet].sort();

  const indexBySector = new Map();
  for (const sec of sectors) indexBySector.set(sec, buildSectorIndex(membersBySector.get(sec), tradingDates));

  const values = {};
  const setVal = (id, cur, prevAtFn, prevFn) => {
    if (!cur || !cur.asOf) { values[id] = null; return; }
    const prevAt = prevAtFn ? prevAtFn(cur.asOf) : null;
    const prev = prevAt ? prevFn(prevAt) : null;
    values[id] = {
      value: cur.value,
      prevValue: prev ? prev.value : null,
      prevAt: prev ? prev.asOf : null,
      asOf: cur.asOf,
      direction: sign(cur.value),
    };
  };

  // 宏观锚点（上一周期 = 锚点序列上一观测日）
  macroHistory.ensureMacroHistory();
  for (const anchor of ['DXY', 'USDCNH', 'US10Y', 'DR007']) {
    const pairs = macroHistory.loadMacroHistory(anchor) || [];
    const anchorDates = pairs.map(([d]) => d);
    setVal(`macro.${anchor}.change5d`, macroChangeAt(anchor, date),
      (asOf) => { const pi = prevIdxLE(anchorDates, asOf); return pi >= 0 ? anchorDates[pi] : null; },
      (t) => macroChangeAt(anchor, t));
  }

  // SC0（5 交易日涨跌；上一周期 = SC0 上一交易日）
  const sc0 = seriesBySymbol.get('SC0');
  setVal('macro.SC0.change5d', sc0 ? symbolRet5At(sc0, date) : null,
    (asOf) => { const pi = prevIdxLE(sc0.dates, asOf); return pi >= 0 ? sc0.dates[pi] : null; },
    (t) => symbolRet5At(sc0, t));

  // 板块指标（上一周期 = 全市场上一交易日）
  const prevTrading = (asOf) => {
    const pi = prevIdxLE(tradingDates, asOf);
    return pi >= 0 ? tradingDates[pi] : null;
  };
  for (const sec of sectors) {
    setVal(`sector.${sec}.index.ret5d`, sectorRet5At(indexBySector.get(sec), date), prevTrading,
      (t) => sectorRet5At(indexBySector.get(sec), t));
    setVal(`sector.${sec}.rs5d`, rsAt(sec, indexBySector, date), prevTrading,
      (t) => rsAt(sec, indexBySector, t));
    const oi = sectorOiFlowAt(membersBySector.get(sec), tradingDates, date);
    if (oi) {
      const dateIdx = lastIdxLE(tradingDates, date);
      const series = [];
      for (let i = 5; i <= dateIdx; i++) {
        const r = sectorOiFlowAt(membersBySector.get(sec), tradingDates, tradingDates[i]);
        if (r && r.asOf === tradingDates[i]) series.push(r.value);
      }
      const prevAt = prevTrading(oi.asOf);
      const prevOi = prevAt ? sectorOiFlowAt(membersBySector.get(sec), tradingDates, prevAt) : null;
      values[`sector.${sec}.oi.flow5d`] = {
        value: oi.value,
        prevValue: prevOi ? prevOi.value : null,
        prevAt: prevOi ? prevOi.asOf : null,
        asOf: oi.asOf,
        direction: sign(oi.value),
        speedZ: series.length >= 20 ? zscore(oi.value, series) : null,
      };
    } else {
      values[`sector.${sec}.oi.flow5d`] = null;
    }
  }

  // 品种指标
  for (const [sym, ser] of seriesBySymbol) {
    setVal(`symbol.${sym}.price.ret5d`, symbolRet5At(ser, date),
      (asOf) => { const pi = prevIdxLE(ser.dates, asOf); return pi >= 0 ? ser.dates[pi] : null; },
      (t) => symbolRet5At(ser, t));
    setVal(`symbol.${sym}.price.vs_ma20`, symbolVsMa20At(ser, date),
      (asOf) => { const pi = prevIdxLE(ser.dates, asOf); return pi >= 0 ? ser.dates[pi] : null; },
      (t) => symbolVsMa20At(ser, t));
  }

  return { values, tradingDates };
}

// runId 只是文件库的检索键：signalDate 从 data/macro/<runId>.json（回退 data/sector/snapshots/<runId>.json）读取，
// 所有指标一律从文件库 data/daily + data/macro-history 计算。不读 output/runs。
function computeForRun(runId) {
  const macroDoc = readJson(path.join(skillRoot, 'data', 'macro', `${runId}.json`));
  const macro = macroDoc && macroDoc.snapshot ? macroDoc.snapshot : macroDoc;
  const sectorDoc = readJson(path.join(skillRoot, 'data', 'sector', 'snapshots', `${runId}.json`));
  const sectorSnap = sectorDoc && sectorDoc.snapshot ? sectorDoc.snapshot : sectorDoc;
  const signalDate = (macro && macro.meta && macro.meta.signalDate)
    || (sectorSnap && sectorSnap.meta && sectorSnap.meta.signalDate) || null;
  if (!signalDate) {
    throw new Error(`run ${runId}: 文件库中找不到 macro/sector 快照，无法确定 signalDate`);
  }
  const ctx = computeForDate(signalDate);
  return { ...ctx, signalDate };
}

module.exports = { computeForDate, computeForRun, zscore };
