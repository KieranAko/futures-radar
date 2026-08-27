// strategies/signal-backtest/runner-v5.cjs — v5 紧凑上下文 + 变化驱动 FinCoT 三臂消融
//
// 三臂（同一批锚点日期、同一执行引擎）：
//   A 纯价格（v3 冻结锚点）
//   B 价格 + 宏观/板块/事件日历（无 FinCoT）
//   C 价格 + 宏观/板块/事件日历 + 完整六问 FinCoT + 报告式策略计划
//
// 严格执行：只执行 executionStatus=executable 的计划；计划一经生成不修改不漂移；
// T+1 收盘确认 → T+2 开盘执行（跳空放弃）→ 止损/目标1/时间退出。
'use strict';

const fs = require('fs');
const path = require('path');
const store = require('../../data-store/index.cjs');
const { verifySignal, isBannedCombo } = require('./runner.cjs');
const { makeSignalV3, aggregateSignals, crossTab, qualityFlagTab } = require('./runner-v3.cjs');

const ROOT = __dirname;
const V5 = path.join(ROOT, 'recordings', 'v5');
const OUT_DIR = path.join(ROOT, 'output');
const SYMBOLS = ['RB0', 'M0', 'SC0'];
const ARMS = ['A', 'B', 'C'];

const mean = arr => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
function round(v, d = 4) { if (v == null || !isFinite(v)) return v; const f = Math.pow(10, d); return Math.round(v * f) / f; }
function pct(a, b) { return b ? round((a / b) * 100, 2) : 0; }
function loadJSON(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

function loadBars(symbol) {
  const cache = store.loadHistoricalCache();
  const c = cache.contracts && cache.contracts[symbol];
  if (c && c.ohlcv && Array.isArray(c.ohlcv.dates) && c.ohlcv.dates.length > 0) {
    const o = c.ohlcv;
    return {
      bars: o.dates.map((d, i) => ({ date: d, open: o.open[i], high: o.high[i], low: o.low[i], close: o.close[i], volume: o.volume && o.volume[i] })),
      source: 'data-store daily merged'
    };
  }
  const fixture = path.join(V5, 'history-2y.json');
  if (fs.existsSync(fixture)) {
    const j = loadJSON(fixture);
    return { bars: j.symbols[symbol].bars, source: 'recordings/v5/history-2y.json fixture' };
  }
  throw new Error(`runner-v5: no bars for ${symbol}`);
}

function atr5(bars, uptoIdx) {
  if (uptoIdx < 1) return null;
  const trs = [];
  for (let i = 1; i <= uptoIdx; i++) trs.push(Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - bars[i - 1].close), Math.abs(bars[i].low - bars[i - 1].close)));
  return mean(trs.slice(-5));
}
function ma20(bars, uptoIdx) { return mean(bars.slice(Math.max(0, uptoIdx - 19), uptoIdx + 1).map(b => b.close)); }

function loadPlans(arm) {
  if (arm === 'A') {
    const j = loadJSON(path.join(V5, 'arm-A.json'));
    return Object.fromEntries(SYMBOLS.map(s => [s, j.symbols[s]]));
  }
  const out = {};
  for (const sym of SYMBOLS) {
    const j = loadJSON(path.join(V5, `arm-${arm}-${sym}.json`));
    let plans = j.anchors;
    if (arm === 'C') {
      const fincot = loadJSON(path.join(V5, `fincot-${sym}.json`));
      const byDate = Object.fromEntries(fincot.entries.map(e => [e.anchorDate, e]));
      plans = plans.map(p => ({ ...p, finCotMode: byDate[p.date] ? byDate[p.date].mode : 'unknown', finCotReusedFrom: byDate[p.date] ? byDate[p.date].reusedFrom || null : null }));
    }
    out[sym] = plans;
  }
  return out;
}

function signalGateOk(anchor, b, a5, m20) {
  if (anchor.direction === 'bullish' && b.close <= anchor.invalidationLevel) return false;
  if (anchor.direction === 'bearish' && b.close >= anchor.invalidationLevel) return false;
  if (anchor.triggerType === 'pullback') {
    const lvl = anchor.pullbackLevel;
    return anchor.direction === 'bullish'
      ? b.close >= lvl - 0.5 * a5 && b.close <= lvl + 0.25 * a5
      : b.close <= lvl + 0.5 * a5 && b.close >= lvl - 0.25 * a5;
  }
  return anchor.direction === 'bullish' ? b.close > m20 : b.close < m20;
}

function simulateArm(symbol, plans) {
  const { bars, source } = loadBars(symbol);
  const byDate = new Map(bars.map((b, i) => [b.date, i]));
  const anchors = plans.map(p => ({ ...p, idx: byDate.get(p.date) })).filter(p => p.idx != null).sort((a, b) => a.idx - b.idx);
  const signals = [];
  let anchorCursor = 0;
  let pending = null;
  let open = null;

  function closePosition(sig, exitType, exitPrice, exitDate) {
    const entryPrice = open.entryPrice;
    const directionCorrect = sig.direction === 'bullish' ? exitPrice > entryPrice : exitPrice < entryPrice;
    const pnlPct = sig.direction === 'bullish' ? ((exitPrice - entryPrice) / entryPrice) * 100 : ((entryPrice - exitPrice) / entryPrice) * 100;
    const attribution = [];
    if (exitType === 'stopped_out') attribution.push({ code: 'stop_hit', detail: `止损 ${open.stop} 被触发` });
    if (exitType === 'target1_hit') attribution.push({ code: 'target1_hit', detail: `第一目标 ${open.target} 兑现` });
    attribution.push({ code: directionCorrect ? 'direction_correct' : 'direction_wrong', detail: `${directionCorrect ? '方向一致' : '方向相反'}（entry=${entryPrice}, exit=${exitPrice}）` });
    signals.push({ ...sig, status: 'verified', entryDate: bars[open.entryIdx].date, exitDate, entryPrice: round(entryPrice, 1), exitPrice: round(exitPrice, 1), exitType, stoppedOut: exitType === 'stopped_out', target1Hit: exitType === 'target1_hit', directionCorrect, pnlPct: round(pnlPct, 2), attribution });
    open = null;
  }

  for (let s = 1; s < bars.length; s++) {
    if (open) {
      const b = bars[s]; const sig = open.signal; let exited = false;
      if (sig.direction === 'bullish') {
        if (b.low <= open.stop) { closePosition(sig, 'stopped_out', open.stop, b.date); exited = true; }
        else if (b.high >= open.target) { closePosition(sig, 'target1_hit', open.target, b.date); exited = true; }
      } else {
        if (b.high >= open.stop) { closePosition(sig, 'stopped_out', open.stop, b.date); exited = true; }
        else if (b.low <= open.target) { closePosition(sig, 'target1_hit', open.target, b.date); exited = true; }
      }
      if (!exited && s >= open.maxEndIdx) closePosition(sig, 'time_exit', b.close, b.date);
    }
    if (pending && s === pending.triggerIdx) {
      const b = bars[s];
      const triggered = pending.signal.direction === 'bullish' ? b.close > pending.signal.triggerLevel : b.close < pending.signal.triggerLevel;
      if (triggered && s + 1 < bars.length) {
        const entryBar = bars[s + 1];
        const entryPrice = entryBar.open;
        const gapThreshold = Math.abs(pending.signal.stopPrice - pending.signal.triggerLevel) * 0.5;
        if (Math.abs(entryPrice - pending.signal.triggerLevel) > gapThreshold) signals.push(verifySignal(pending.signal, bars));
        else open = { signal: pending.signal, entryIdx: s + 1, entryPrice, stop: pending.signal.stopPrice, target: pending.signal.target1Level, maxEndIdx: s + 1 + pending.signal.maxHoldingDays };
      } else signals.push(verifySignal(pending.signal, bars));
      pending = null;
    }
    if (!pending && !open) {
      while (anchorCursor < anchors.length - 1 && s > anchors[anchorCursor].idx + 4) anchorCursor++;
      const anchor = anchors[anchorCursor];
      const windowEnd = Math.min(anchor.idx + 4, bars.length - 1);
      if (s >= anchor.idx + 1 && s <= windowEnd && anchor.executionStatus === 'executable' && anchor.direction !== 'neutral' && !isBannedCombo(anchor)) {
        const a5 = atr5(bars, s); const m20 = ma20(bars, s);
        if (a5 != null && a5 > 0 && signalGateOk(anchor, bars[s], a5, m20)) {
          const sig = makeSignalV3(symbol, anchor, s, bars, { atr5: a5, ma20: m20 });
          // v3 信号 schema 不携带上下文字段，这里把 v4 计划字段显式并入
          sig.macroBias = anchor.macroBias ?? null;
          sig.sectorBias = anchor.sectorBias ?? null;
          sig.eventRisk = anchor.eventRisk ?? null;
          sig.finCotAlignment = anchor.finCotAlignment ?? 'not_applicable';
          sig.finCotMode = anchor.finCotMode ?? null;
          sig.finCotReusedFrom = anchor.finCotReusedFrom ?? null;
          sig.finCotRefs = anchor.finCotRefs || [];
          sig.executionStatus = anchor.executionStatus;
          sig.contextRefs = anchor.contextRefs || [];
          pending = { signal: sig, triggerIdx: s + 1 };
        }
      }
    }
  }
  return { bars, anchors, signals, barsSource: source, executablePlans: anchors.filter(a => a.executionStatus === 'executable').length, totalPlans: anchors.length };
}

function armCrossTabs(signals) {
  const verified = signals.filter(s => s.status === 'verified');
  return {
    byMacroBias: crossTab(verified, 'macroBias'),
    bySectorBias: crossTab(verified, 'sectorBias'),
    byEventRisk: crossTab(verified, 'eventRisk'),
    byFinCotAlignment: crossTab(verified, 'finCotAlignment'),
    byFinCotMode: crossTab(verified, 'finCotMode'),
    byExecutionStatus: crossTab(verified, 'executionStatus')
  };
}

function tableMd(title, headers, rows) {
  const L = [`## ${title}`, '', `| ${headers.join(' | ')} |`, `|${headers.map(() => '---').join('|')}|`];
  for (const r of rows) L.push(`| ${r.join(' | ')} |`);
  L.push('');
  return L;
}

function renderMd(report) {
  const L = [];
  L.push('# 信号质量回测基线 v5（紧凑上下文 + 变化驱动 FinCoT 三臂试点）');
  L.push('');
  L.push('> 试点范围：RB0/M0/SC0 × 最近 20 个锚点（2026-03-27 .. 2026-08-14，5 日间隔），验证到 2026-08-27，固定 1 手。');
  L.push('> 严格执行：只执行 executable 计划；T+1 收盘确认 → T+2 开盘执行（跳空放弃）→ 止损/目标1/时间退出，计划不修改不漂移。');
  L.push('');
  L.push(...tableMd('三臂总览', ['臂', '计划数', 'executable', '信号', '触发执行', '成交', '跳空放弃', '方向正确率', '目标1', '止损', '平均盈亏'], ARMS.map(arm => {
    const a = report.arms[arm].aggregate; const meta = report.arms[arm].meta;
    return [arm, meta.totalPlans, meta.executablePlans, a.signalCount, a.executedCount, a.verifiedCount, a.gapSkipCount, `${a.directionCorrectRate}%`, `${a.target1Rate}%`, `${a.stopRate}%`, `${a.avgPnlPct}%`];
  })));
  L.push(...tableMd('分品种 × 分臂方向正确率', ['品种', 'A', 'B', 'C'], SYMBOLS.map(sym => [sym, ...[...ARMS].map(arm => `${report.perSymbol[arm][sym].directionCorrectRate}% (${report.perSymbol[arm][sym].verifiedCount})`)])));
  const c = report.crossTabs.C;
  L.push(...tableMd('C 臂 · macroBias 交叉证伪', ['macroBias', '样本', '方向正确率', '平均盈亏'], c.byMacroBias.map(r => [r.value, r.n, `${r.directionCorrectRate}%`, `${r.avgPnlPct}%`])));
  L.push(...tableMd('C 臂 · sectorBias 交叉证伪', ['sectorBias', '样本', '方向正确率', '平均盈亏'], c.bySectorBias.map(r => [r.value, r.n, `${r.directionCorrectRate}%`, `${r.avgPnlPct}%`])));
  L.push(...tableMd('C 臂 · eventRisk 交叉证伪', ['eventRisk', '样本', '方向正确率', '平均盈亏'], c.byEventRisk.map(r => [r.value, r.n, `${r.directionCorrectRate}%`, `${r.avgPnlPct}%`])));
  L.push(...tableMd('C 臂 · finCotAlignment 交叉证伪', ['finCotAlignment', '样本', '方向正确率', '平均盈亏'], c.byFinCotAlignment.map(r => [r.value, r.n, `${r.directionCorrectRate}%`, `${r.avgPnlPct}%`])));
  L.push(...tableMd('C 臂 · FinCoT 复用（fresh vs reused）', ['finCotMode', '样本', '方向正确率', '平均盈亏'], c.byFinCotMode.map(r => [r.value, r.n, `${r.directionCorrectRate}%`, `${r.avgPnlPct}%`])));
  L.push(...tableMd('消融结论', ['对比', '方向正确率差（百分点）', '平均盈亏差（%）'], report.ablation.map(r => [r.comparison, r.directionDelta, r.pnlDelta])));
  L.push('');
  L.push('## 证伪结论');
  L.push('');
  for (const line of report.falsification) L.push(`- ${line}`);
  L.push('');
  L.push('## C 臂锚点决策分布');
  L.push('');
  L.push('| 品种 | direction | regime | edge | triggerType | executionStatus |');
  L.push('|---|---|---|---|---|---|');
  for (const sym of SYMBOLS) {
    const fmt = obj => Object.entries(obj).map(([k, v]) => `${k}=${v}`).join(' ');
    const d = report.planDistribution.C[sym];
    L.push(`| ${sym} | ${fmt(d.direction)} | ${fmt(d.regime)} | ${fmt(d.edge)} | ${fmt(d.triggerType)} | ${fmt(d.executionStatus)} |`);
  }
  return `${L.join('\n')}\n`;
}

function planDistribution(plans) {
  const d = { direction: {}, regime: {}, edge: {}, triggerType: {}, executionStatus: {} };
  for (const p of plans) for (const k of ['direction', 'regime', 'edge', 'triggerType', 'executionStatus']) { const key = p[k] == null ? 'null' : p[k]; d[k][key] = (d[k][key] || 0) + 1; }
  return d;
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const arms = {}; const perSymbol = {}; const planDistributionByArm = {};
  for (const arm of ARMS) {
    const plansBySym = loadPlans(arm);
    const sims = {}; const signals = [];
    let totalPlans = 0; let executablePlans = 0;
    for (const sym of SYMBOLS) {
      const sim = simulateArm(sym, plansBySym[sym]);
      sims[sym] = sim;
      signals.push(...sim.signals);
      totalPlans += sim.totalPlans; executablePlans += sim.executablePlans;
    }
    arms[arm] = { aggregate: aggregateSignals(signals), meta: { totalPlans, executablePlans }, signals };
    perSymbol[arm] = Object.fromEntries(SYMBOLS.map(sym => [sym, aggregateSignals(sims[sym].signals)]));
    planDistributionByArm[arm] = Object.fromEntries(SYMBOLS.map(sym => [sym, planDistribution(plansBySym[sym])]));
  }
  const crossTabs = { C: armCrossTabs(arms.C.signals) };
  const ablation = [];
  const acc = arm => arms[arm].aggregate.directionCorrectRate;
  const pnl = arm => arms[arm].aggregate.avgPnlPct;
  ablation.push({ comparison: 'B - A（宏观/板块/事件上下文的增量）', directionDelta: round(acc('B') - acc('A'), 2), pnlDelta: round(pnl('B') - pnl('A'), 2) });
  ablation.push({ comparison: 'C - B（完整 FinCoT 的增量）', directionDelta: round(acc('C') - acc('B'), 2), pnlDelta: round(pnl('C') - pnl('B'), 2) });
  ablation.push({ comparison: 'C - A（总增量）', directionDelta: round(acc('C') - acc('A'), 2), pnlDelta: round(pnl('C') - pnl('A'), 2) });

  const falsification = [];
  for (const r of ablation) falsification.push(`${r.comparison}：方向正确率 ${r.directionDelta} pp，平均盈亏 ${r.pnlDelta}%。`);
  const cExec = arms.C.aggregate.verifiedCount;
  if (cExec < 5) falsification.push(`C 臂成交 ${cExec} 笔，样本过小，结论只能作试点观察。`);
  const refs = arms.C.signals.filter(s => s.status === 'verified' && s.contextRefs && s.contextRefs.length > 0).length;
  falsification.push(`C 臂成交中带 contextRefs 的 ${refs}/${cExec} 笔（${pct(refs, cExec)}%），上下文可溯源覆盖。`);
  const diverged = arms.C.signals.filter(s => s.status === 'verified' && s.finCotAlignment === 'diverged');
  if (diverged.length) falsification.push(`C 臂有 ${diverged.length} 笔成交的锚点方向与 FinCoT 分歧（diverged），需单独核对其方向正确率。`);
  falsification.push('执行引擎对三臂完全一致；三臂差异只来自 LLM 决策上下文。60 个锚点、固定 1 手，仅作试点证据。');

  const report = {
    schema: 'futures-radar-signal-backtest/5',
    meta: {
      generatedAt: new Date().toISOString(),
      arms: ARMS,
      universe: SYMBOLS,
      anchorsPerSymbol: 20,
      barsRange: '2026-03-27..2026-08-27（计划窗口）',
      barsSource: 'data-store daily merged（500 bars）'
    },
    arms: Object.fromEntries(ARMS.map(arm => [arm, { aggregate: arms[arm].aggregate, meta: arms[arm].meta }])),
    perSymbol,
    crossTabs,
    ablation,
    planDistribution: planDistributionByArm,
    falsification,
    signals: Object.fromEntries(ARMS.map(arm => [arm, arms[arm].signals.map(s => ({
      symbol: s.symbol, anchorDate: s.anchorDate, signalDate: s.signalDate, status: s.status,
      direction: s.direction, confidence: s.confidence, regime: s.regime, edge: s.edge, triggerType: s.triggerType,
      executionStatus: s.executionStatus, macroBias: s.macroBias, sectorBias: s.sectorBias, eventRisk: s.eventRisk,
      finCotAlignment: s.finCotAlignment, finCotMode: s.finCotMode, finCotReusedFrom: s.finCotReusedFrom, qualityFlags: s.qualityFlags || [], contextRefs: s.contextRefs || [],
      triggerLevel: s.triggerLevel, stopPrice: s.stopPrice, target1Level: s.target1Level,
      entryDate: s.entryDate, entryPrice: s.entryPrice, exitDate: s.exitDate, exitPrice: s.exitPrice,
      exitType: s.exitType, directionCorrect: s.directionCorrect, pnlPct: s.pnlPct
    }))]))
  };
  const jsonPath = path.join(OUT_DIR, 'signal-quality-baseline-v5.json');
  const mdPath = path.join(OUT_DIR, 'signal-quality-baseline-v5.md');
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  fs.writeFileSync(mdPath, renderMd(report), 'utf8');
  console.log(JSON.stringify({ meta: report.meta, arms: report.arms, perSymbol: report.perSymbol, ablation: report.ablation, crossTabs: report.crossTabs, falsification: report.falsification, jsonPath, mdPath }, null, 2));
}

if (require.main === module) main();

module.exports = { loadPlans, simulateArm, armCrossTabs, main };
