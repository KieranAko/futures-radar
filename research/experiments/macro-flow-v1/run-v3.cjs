// research/experiments/macro-flow-v1/run-v3.cjs — MFLOW-03 故事先验 x 流状态机
//
// 与 MFLOW-02 唯一差异：入场增加故事门（代表品种宏观传导规则，锚点 5 日变化方向全部一致）。
// 退出/持仓上限/成本与 MFLOW-02 完全相同（单变量归因）。
//
// 用法: node research/experiments/macro-flow-v1/run-v3.cjs
// 输出: results/results-mflow-03.json + trades-mflow-03.json + report-mflow-03.md
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const DATA_DIR = path.join(ROOT, 'data', 'daily');
const RES_DIR = path.join(__dirname, 'results');

const {
  buildSectorIndex,
  buildSectorOi,
  sectorSignals,
  loadSeries,
  pickRepresentative,
  lastIdxLE,
  dayDiff,
  summarize,
} = require('./run.cjs');
const { buildFlowStates } = require('./run-v2.cjs');

const ELIGIBLE_SECTORS = ['black', 'nonferrous', 'energy_chemical', 'agriculture'];
const COST_PCT = 0.07;
const MAX_HOLD_BARS = 20;
const MAX_ENTRY_GAP_DAYS = 7;
const VALIDATION_START = '2020-01-01';
const M = 3, N = 5;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function round(v, d = 4) {
  return v === null || v === undefined || !Number.isFinite(v) ? null : Number(v.toFixed(d));
}

// ── 故事先验：锚点序列加载 ─────────────────────────────────
function seriesMap(pairs) {
  const map = new Map();
  for (const [date, value] of pairs) map.set(date, value);
  return { dates: [...map.keys()].sort(), map };
}

function loadAnchor(anchor) {
  if (anchor === 'SC0') {
    const d = readJson(path.join(DATA_DIR, 'SC0.json'));
    const o = d.contract.ohlcv;
    const pairs = o.dates.map((dt, i) => [dt, o.close[i]]).filter(([, v]) => Number.isFinite(v));
    return seriesMap(pairs);
  }
  const macro = readJson(path.join(ROOT, 'strategies', 'signal-backtest', 'recordings', 'v4', 'macro-history.json'));
  const ind = macro.indicators[anchor];
  if (!ind || !ind.ok || !Array.isArray(ind.series)) return null;
  return seriesMap(ind.series.filter(([, v]) => Number.isFinite(v)));
}

function valueLE(series, target) {
  const idx = lastIdxLE(series.dates, target);
  return idx >= 0 ? series.map.get(series.dates[idx]) : null;
}

function anchorDir(anchor, series, date) {
  if (!series) return 0;
  const now = valueLE(series, date);
  const prevTarget = new Date(Date.parse(`${date}T00:00:00Z`) - 5 * 86400000).toISOString().slice(0, 10);
  const prev = valueLE(series, prevTarget);
  if (!Number.isFinite(now) || !Number.isFinite(prev)) return 0;
  const chg = now - prev;
  if (!Number.isFinite(chg) || chg === 0) return 0;
  const s = chg > 0 ? 1 : -1;
  switch (anchor) {
    case 'DXY': case 'US10Y': case 'DR007': return -s;
    case 'USDCNH': case 'SC0': return s;
    default: return 0;
  }
}

function buildRules(cfg) {
  const rules = [];
  for (const r of cfg.rules || []) {
    for (const p of r.prefixes) rules.push({ prefix: p, anchors: r.anchors });
  }
  return rules;
}

function symbolPrefix(symbol) {
  return String(symbol).replace(/0$/, '');
}

function storyDirFor(symbol, date, rules, anchors) {
  const prefix = symbolPrefix(symbol);
  let hit = null;
  for (const r of rules) {
    if (r.prefix === prefix) { hit = r; break; }
  }
  if (!hit) return 0;
  let dir = null;
  for (const a of hit.anchors) {
    if (symbol === 'SC0' && a === 'SC0') continue; // 自身价格不能作为自身故事锚
    const d = anchorDir(a, anchors.get(a), date);
    if (d === 0) return 0;
    if (dir === null) dir = d;
    else if (dir !== d) return 0;
  }
  return dir;
}

// ── 引擎：MFLOW-02 + 故事入场门 ────────────────────────────
function runGated(sectors, sortedDates, rawSignalBySector, seriesBySymbol, rules, anchors) {
  const statesBySector = buildFlowStates(rawSignalBySector, sortedDates, M, N);
  const positions = new Map();
  const trades = [];
  const skipped = { no_rep: 0, no_next_bar: 0, gap_too_wide: 0, bad_price: 0, story_blocked: 0 };
  let entryAttempts = 0;

  const nearestLevel = (s, target) => {
    const dates = [...s.index.levelByDate.keys()].sort();
    const idx = lastIdxLE(dates, target);
    return idx >= 0 ? s.index.levelByDate.get(dates[idx]) : null;
  };

  for (let i = 0; i < sortedDates.length; i++) {
    const d = sortedDates[i];
    const exitedSectors = new Set();

    for (const s of sectors) {
      const pos = positions.get(s.id);
      if (!pos) continue;
      const sym = seriesBySymbol.get(pos.symbol);
      const nowIdx = lastIdxLE(sym.dates, d);
      if (nowIdx < pos.entryIdx) continue;
      const state = statesBySector.get(s.id).get(d) || 0;
      const heldBars = nowIdx - pos.entryIdx + 1;
      let exitReason = null;
      if (state === 0) exitReason = 'flow_off';
      else if (state !== pos.dir) exitReason = 'flow_reverse';
      else if (heldBars >= MAX_HOLD_BARS) exitReason = 'max_hold';
      if (!exitReason) continue;

      let exitDate, exitPrice, forced = false;
      const nextIdx = nowIdx + 1;
      if (nextIdx < sym.dates.length && Number.isFinite(sym.open[nextIdx]) && sym.open[nextIdx] > 0) {
        exitDate = sym.dates[nextIdx];
        exitPrice = sym.open[nextIdx];
      } else if (nowIdx < sym.dates.length && Number.isFinite(sym.close[nowIdx]) && sym.close[nowIdx] > 0) {
        exitDate = sym.dates[nowIdx];
        exitPrice = sym.close[nowIdx];
        forced = true;
        exitReason = 'forced_end';
      } else {
        skipped.bad_price++;
        positions.delete(s.id);
        continue;
      }

      const grossPct = pos.dir * (exitPrice / pos.entryPrice - 1) * 100;
      const entryLevel = nearestLevel(s, pos.entryDate);
      const exitLevel = nearestLevel(s, exitDate);
      trades.push({
        M, N, sector: s.id, symbol: pos.symbol, dir: pos.dir,
        storyDir: pos.storyDir, signalDate: pos.signalDate, entryDate: pos.entryDate, exitDate,
        entryPrice: round(pos.entryPrice), exitPrice: round(exitPrice), heldBars, exitReason,
        grossPct: round(grossPct), netPct: round(grossPct - COST_PCT),
        sectorRetPct: entryLevel && exitLevel && entryLevel > 0
          ? round(pos.dir * (exitLevel / entryLevel - 1) * 100) : null,
      });
      positions.delete(s.id);
      exitedSectors.add(s.id);
    }

    for (const s of sectors) {
      if (exitedSectors.has(s.id) || positions.has(s.id)) continue;
      const state = statesBySector.get(s.id).get(d) || 0;
      if (state === 0) continue;
      entryAttempts++;
      const rep = pickRepresentative(s.members, d);
      if (!rep) { skipped.no_rep++; continue; }
      const storyDir = storyDirFor(rep, d, rules, anchors);
      if (storyDir !== state) { skipped.story_blocked++; continue; }
      const sym = seriesBySymbol.get(rep);
      const nowIdx = lastIdxLE(sym.dates, d);
      if (nowIdx < 0 || sym.dates[nowIdx] !== d) { skipped.no_rep++; continue; }
      const nextIdx = nowIdx + 1;
      if (nextIdx >= sym.dates.length) { skipped.no_next_bar++; continue; }
      if (dayDiff(sym.dates[nextIdx], d) > MAX_ENTRY_GAP_DAYS) { skipped.gap_too_wide++; continue; }
      const entryPrice = sym.open[nextIdx];
      if (!Number.isFinite(entryPrice) || entryPrice <= 0) { skipped.bad_price++; continue; }
      positions.set(s.id, {
        dir: state, symbol: rep, storyDir, entryIdx: nextIdx, entryPrice,
        entryDate: sym.dates[nextIdx], signalDate: d,
      });
    }
  }

  for (const [sector, pos] of positions) {
    const sym = seriesBySymbol.get(pos.symbol);
    const last = sym.dates.length - 1;
    const exitPrice = sym.close[last];
    if (!Number.isFinite(exitPrice) || exitPrice <= 0) continue;
    const s = sectors.find((x) => x.id === sector);
    const entryLevel = nearestLevel(s, pos.entryDate);
    const exitLevel = nearestLevel(s, sym.dates[last]);
    trades.push({
      M, N, sector, symbol: pos.symbol, dir: pos.dir, storyDir: pos.storyDir,
      signalDate: pos.signalDate, entryDate: pos.entryDate, exitDate: sym.dates[last],
      entryPrice: round(pos.entryPrice), exitPrice: round(exitPrice),
      heldBars: last - pos.entryIdx + 1, exitReason: 'forced_end',
      grossPct: round(pos.dir * (exitPrice / pos.entryPrice - 1) * 100),
      netPct: round(pos.dir * (exitPrice / pos.entryPrice - 1) * 100 - COST_PCT),
      sectorRetPct: entryLevel && exitLevel && entryLevel > 0
        ? round(pos.dir * (exitLevel / entryLevel - 1) * 100) : null,
    });
  }
  return { trades, skipped, entryAttempts };
}

function main() {
  const t0 = Date.now();
  const cfg = readJson(path.join(ROOT, 'config', 'symbols.json'));
  const trans = readJson(path.join(ROOT, 'config', 'macro-transmission.json'));
  const rules = buildRules(trans);

  const anchors = new Map();
  for (const a of ['DXY', 'USDCNH', 'US10Y', 'DR007', 'SC0']) anchors.set(a, loadAnchor(a));

  const active = (cfg.symbols || []).filter((s) => s.active && ELIGIBLE_SECTORS.includes(s.sector));
  const seriesBySymbol = new Map();
  const membersBySector = new Map();
  for (const id of ELIGIBLE_SECTORS) membersBySector.set(id, []);
  for (const s of active) {
    const series = loadSeries(s.symbol);
    series.sector = s.sector;
    seriesBySymbol.set(s.symbol, series);
    membersBySector.get(s.sector).push(series);
  }

  const allDatesSet = new Set();
  for (const s of seriesBySymbol.values()) for (const d of s.dates) allDatesSet.add(d);
  const sortedDates = [...allDatesSet].sort();

  const sectors = ELIGIBLE_SECTORS.map((id) => {
    const members = membersBySector.get(id);
    return { id, members, index: buildSectorIndex(members, sortedDates), oi: buildSectorOi(members, sortedDates) };
  });
  const rawSignalBySector = sectorSignals(sectors, sortedDates);

  const gated = runGated(sectors, sortedDates, rawSignalBySector, seriesBySymbol, rules, anchors);
  const valTrades = gated.trades.filter((t) => t.entryDate >= VALIDATION_START);
  const designTrades = gated.trades.filter((t) => t.entryDate < VALIDATION_START);
  const val = summarize(valTrades);
  const decision = val.ci && val.meanNetPct > 0 && val.ci.lo > 0 ? 'promote'
    : val.ci && val.meanNetPct < 0 && val.ci.hi < 0 ? 'discard'
      : 'screen_pending';

  // ── 次要分析：故事门对 MFLOW-02 全样本交易的分层判别力 ──
  const bareTrades = readJson(path.join(RES_DIR, 'trades-mflow-02.json'));
  const layered = { aligned: [], no_story: [], opposed: [] };
  for (const t of bareTrades) {
    const sd = storyDirFor(t.symbol, t.signalDate, rules, anchors);
    if (sd === 0) layered.no_story.push(t);
    else if (sd === t.dir) layered.aligned.push(t);
    else layered.opposed.push(t);
  }

  const out = {
    schema: 'futures-radar-experiment-result/1',
    id: 'MFLOW-03',
    generatedAt: new Date().toISOString(),
    runCommand: 'node research/experiments/macro-flow-v1/run-v3.cjs',
    elapsedMs: Date.now() - t0,
    settings: {
      storyProxy: 'macro-transmission.json 前缀→锚点；锚点 5 日变化方向全部一致才算有故事',
      flowState: { M, N },
      costPct: COST_PCT,
      maxHoldBars: MAX_HOLD_BARS,
      validationStart: VALIDATION_START,
      bootstrap: { B: 10000, seed: 20260918 },
    },
    decision,
    primary: {
      full: summarize(gated.trades),
      design: summarize(designTrades),
      validation: val,
    },
    skipped: gated.skipped,
    entryAttempts: gated.entryAttempts,
    gateRate: gated.entryAttempts ? round(1 - gated.skipped.story_blocked / gated.entryAttempts) : null,
    secondaryLayering: {
      note: '对 MFLOW-02 全样本交易按 signalDate 的故事方向分层（不改变主判决）',
      aligned: summarize(layered.aligned),
      no_story: summarize(layered.no_story),
      opposed: summarize(layered.opposed),
    },
    dataRange: { first: sortedDates[0], last: sortedDates[sortedDates.length - 1], tradingDates: sortedDates.length },
  };

  fs.mkdirSync(RES_DIR, { recursive: true });
  fs.writeFileSync(path.join(RES_DIR, 'results-mflow-03.json'), JSON.stringify(out, null, 2) + '\n');
  fs.writeFileSync(path.join(RES_DIR, 'trades-mflow-03.json'), JSON.stringify(gated.trades, null, 2) + '\n');
  writeReport(out);
  console.log(JSON.stringify({
    decision: out.decision,
    gated: { full: out.primary.full, validation: out.primary.validation },
    skipped: out.skipped,
    gateRate: out.gateRate,
    layering: out.secondaryLayering,
  }, null, 2));
  return out;
}

function writeReport(out) {
  const L = [];
  const v = out.primary.validation;
  const f = out.primary.full;
  L.push('# MFLOW-03 故事先验 x 流状态机 — 历史验证报告');
  L.push('');
  L.push(`- 生成时间：${out.generatedAt}`);
  L.push(`- 故事门：${out.settings.storyProxy}`);
  L.push(`- 流状态：${out.settings.flowState.M}/${out.settings.flowState.N}（与 MFLOW-02 同口径）`);
  L.push(`- 判决集：entryDate ≥ ${out.settings.validationStart}`);
  L.push('');
  L.push(`## 判决：${out.decision}`);
  L.push('');
  L.push('| 指标 | 判决集 (2020+) | 全样本 |');
  L.push('|------|--------------|--------|');
  L.push(`| 交易笔数 | ${v.n} | ${f.n} |`);
  L.push(`| 平均单笔净收益 | ${v.meanNetPct}% | ${f.meanNetPct}% |`);
  L.push(`| 胜率 | ${v.winRate === null ? '—' : (v.winRate * 100).toFixed(1) + '%'} | ${f.winRate === null ? '—' : (f.winRate * 100).toFixed(1) + '%'} |`);
  L.push(`| 95% bootstrap CI | ${v.ci ? `[${v.ci.lo}, ${v.ci.hi}]` : '—'} | ${f.ci ? `[${f.ci.lo}, ${f.ci.hi}]` : '—'} |`);
  L.push('');
  L.push(`- 入场尝试 ${out.entryAttempts}，故事门拦截 ${out.skipped.story_blocked}（通过率 ${(out.gateRate * 100).toFixed(1)}%）`);
  L.push('');
  L.push('## 故事门对 MFLOW-02 全样本交易的分层（判别力）');
  L.push('');
  L.push('| 分层 | n | 平均净收益% | 95% CI |');
  L.push('|------|---|-----------|--------|');
  for (const [k, s] of Object.entries(out.secondaryLayering).filter(([k]) => k !== 'note')) {
    L.push(`| ${k} | ${s.n} | ${s.meanNetPct ?? '—'} | ${s.ci ? `[${s.ci.lo}, ${s.ci.hi}]` : '—'} |`);
  }
  L.push('');
  L.push('## 口径与边界');
  L.push('');
  L.push('- 与 MFLOW-02 只差一个变量：入场增加故事门；退出/持仓上限/成本不变。');
  L.push('- 故事代理是确定性的宏观传导规则，不是 LLM——本实验验证『故事层 + 流层』结构是否成立。');
  L.push('- 锚点序列冻结于 v4 macro-history.json 与 data/daily/SC0.json；均为 PIT（只取 ≤ 信号日数据）。');
  L.push('- 故事中途变化不触发退出（单变量归因，留待 MFLOW-04）。');
  L.push('');
  fs.writeFileSync(path.join(RES_DIR, 'report-mflow-03.md'), L.join('\n') + '\n');
}

if (require.main === module) main();
module.exports = { main, storyDirFor, anchorDir, buildRules };
