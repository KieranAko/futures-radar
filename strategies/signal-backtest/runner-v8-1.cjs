// strategies/signal-backtest/runner-v8-1.cjs — 生产 strategy-plan + V8 定价层（F1-F5）执行
//
// 架构：FinCoT 只做分析；策略适配模块（生产 strategy-matcher）产出 strategy-plan；
// 本执行引擎只读 strategy-plan 结构化字段，支持两种 triggerTiming：
//   T+1 开盘执行（PB-03/PB-08）：T+1 open 越界即入场
//   T+1 收盘确认（PB-07）：T+1 close 越界，T+2 open 入场
// 目标/止损/失效来自 plan 字段；只执行 executionStatus=executable。
'use strict';

const fs = require('fs');
const path = require('path');
const store = require('../../data-store/index.cjs');
const { runDir } = require('../../lib/workspace.cjs');

const ROOT = __dirname;
const V7 = path.join(ROOT, 'recordings', 'v7');
const OUT_DIR = path.join(ROOT, 'output');
const SYMBOLS = ['RB0', 'M0', 'SC0'];

const mean = arr => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
const round = (v, d = 4) => (v == null || !isFinite(v) ? v : Math.round(v * Math.pow(10, d)) / Math.pow(10, d));
const loadJSON = p => JSON.parse(fs.readFileSync(p, 'utf8'));

function loadBars(symbol) {
  const cache = store.loadHistoricalCache();
  const c = cache.contracts && cache.contracts[symbol];
  if (c && c.ohlcv && Array.isArray(c.ohlcv.dates) && c.ohlcv.dates.length > 0) {
    const o = c.ohlcv;
    return o.dates.map((d, i) => ({ date: d, open: o.open[i], high: o.high[i], low: o.low[i], close: o.close[i] }));
  }
  const fixture = path.join(V7, '..', 'v5', 'history-2y.json');
  return loadJSON(path.resolve(ROOT, fixture)).symbols[symbol].bars;
}

function atr5(bars, upto) {
  const trs = [];
  for (let i = 1; i <= upto; i++) trs.push(Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - bars[i - 1].close), Math.abs(bars[i].low - bars[i - 1].close)));
  return mean(trs.slice(-5));
}

function parseFirstNumber(text) {
  if (text == null) return null;
  const m = String(text).match(/(\d{2,}(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}

function targetLevels(p, direction, close, a5) {
  const sign = direction === 'bullish' ? 1 : -1;
  const t1 = p.targets?.t1 || '';
  const t2 = p.targets?.t2 || '';
  const levels = [];
  // 概率锥代理（与 adapter probability.json 一致）：3d p68=±1.5×ATR，3d p95/5d=±2×ATR
  const p68 = close + sign * 1.5 * a5;
  const p95 = close + sign * 2 * a5;
  if (/p68/.test(t1)) levels.push(p68);
  if (/前高|前低|2R|R 口径/.test(t1)) {
    const stop = p.stop.stopPrice;
    const r = Math.abs((p.entry.triggerLevel || close) - stop);
    levels.push((p.entry.triggerLevel || close) + sign * 2 * r);
  }
  if (/p95/.test(t2)) levels.push(p95);
  if (!levels.length) levels.push((p.entry.triggerLevel || close) + sign * 2 * Math.abs((p.entry.triggerLevel || close) - p.stop.stopPrice));
  const sorted = levels.sort((a, b) => (direction === 'bullish' ? a - b : b - a));
  return { t1: sorted[0], t2: sorted[1] || null, basis: `${t1} | ${t2}` };
}

function invalidationResolver(text, bars, idx) {
  if (!text) return null;
  const closes = bars.slice(0, idx + 1).map(b => b.close);
  const m20 = mean(closes.slice(-20));
  const m60 = mean(closes.slice(-60));
  if (/m20/.test(text)) return m20;
  if (/m60/.test(text)) return m60;
  return null;
}

function executePlan(symbol, planFile, pricing) {
  const plan = loadJSON(planFile);
  const p = plan.plans[0];
  const bars = loadBars(symbol);
  const anchorIdx = bars.findIndex(b => b.date === plan.meta.signalDate);
  const base = {
    symbol, anchorDate: plan.meta.signalDate, runId: plan.meta.runId,
    pricing: pricing ? {
      originalExecutionStatus: pricing.originalExecutionStatus,
      effectiveExecutionStatus: pricing.effectiveExecutionStatus,
      downgradeReasons: pricing.downgradeReasons,
      f1BandAtr: pricing.f1BandAtr,
      structuralTarget: pricing.structuralTarget,
      target1Atr: pricing.target1Atr,
      target2Atr: pricing.target2Atr,
      pricingBasis: pricing.pricingBasis,
      stopBasis: pricing.stopBasis
    } : null,
    direction: p.reportBaseline.direction,
    confidence: p.reportBaseline.confidence,
    matchedStrategies: p.matchedStrategies.map(m => m.strategyId),
    playbookId: p.playbook.playbookId,
    executionStatus: p.executionStatus,
    triggerLevel: p.entry.triggerLevel,
    stopPrice: p.stop.stopPrice,
    triggerTiming: p.entry.triggerTiming,
    maxHoldingDays: p.riskAssessment.maxHoldingDays || 5,
    lots: p.position.lots
  };
  if (anchorIdx === -1 || p.reportBaseline.direction === 'neutral') {
    return { ...base, status: p.executionStatus === 'executable' ? 'unverifiable' : 'not_executable' };
  }
  if (p.executionStatus !== 'executable') return { ...base, status: 'not_executable' };
  if (pricing && pricing.effectiveExecutionStatus !== 'executable') {
    return { ...base, status: 'pricing_watch', downgradeReasons: pricing.downgradeReasons };
  }
  const dir = p.reportBaseline.direction;
  const sign = dir === 'bullish' ? 1 : -1;
  const closeConfirm = /收盘/.test(p.entry.triggerTiming || '');
  const a5 = atr5(bars, anchorIdx);
  const close = bars[anchorIdx].close;
  const targets = targetLevels(p, dir, close, a5);

  if (anchorIdx + 1 >= bars.length) return { ...base, status: 'pending_data', targets, atr5: round(a5, 2) };
  const t1Bar = bars[anchorIdx + 1];
  const triggered = closeConfirm
    ? (dir === 'bullish' ? t1Bar.close > p.entry.triggerLevel : t1Bar.close < p.entry.triggerLevel)
    : (dir === 'bullish' ? t1Bar.open > p.entry.triggerLevel : t1Bar.open < p.entry.triggerLevel);
  if (!triggered) return { ...base, status: 'trigger_miss', triggerVerifyDate: t1Bar.date, targets, atr5: round(a5, 2) };

  const entryIdx = closeConfirm ? anchorIdx + 2 : anchorIdx + 1;
  if (entryIdx >= bars.length) return { ...base, status: 'triggered_pending_entry', triggerVerifyDate: t1Bar.date, targets, atr5: round(a5, 2) };
  const entryBar = bars[entryIdx];
  const entryPrice = closeConfirm ? entryBar.open : t1Bar.open;
  const gapMul = /0\.75/.test(p.entry.execution || '') ? 0.75 : 0.5;
  const gap = Math.abs(entryPrice - p.entry.triggerLevel);
  if (gap > gapMul * a5) {
    return { ...base, status: 'gap_skip', entryDate: entryBar.date, entryPrice: round(entryPrice, 1), gap: round(gap, 1), gapMul, atr5: round(a5, 2), targets };
  }

  const invText = p.invalidation?.hard?.[0] || '';
  const invLevel = invalidationResolver(invText, bars, entryIdx - 1);
  const stop = p.stop.stopPrice;
  const t1 = targets.t1;
  let exit = null; let exitType = 'time_exit'; let exitDate = null;
  const maxEnd = Math.min(bars.length - 1, entryIdx + (p.riskAssessment.maxHoldingDays || 5));
  for (let i = entryIdx; i <= maxEnd; i++) {
    const b = bars[i];
    if (dir === 'bullish') {
      if (b.low <= stop) { exit = stop; exitType = 'stopped_out'; exitDate = b.date; break; }
      if (b.high >= t1) { exit = t1; exitType = 'target1_hit'; exitDate = b.date; break; }
      if (invLevel != null && b.close < invLevel) { exit = b.close; exitType = 'invalidation_exit'; exitDate = b.date; break; }
    } else {
      if (b.high >= stop) { exit = stop; exitType = 'stopped_out'; exitDate = b.date; break; }
      if (b.low <= t1) { exit = t1; exitType = 'target1_hit'; exitDate = b.date; break; }
      if (invLevel != null && b.close > invLevel) { exit = b.close; exitType = 'invalidation_exit'; exitDate = b.date; break; }
    }
    exit = b.close; exitDate = b.date;
  }
  const directionCorrect = dir === 'bullish' ? exit > entryPrice : exit < entryPrice;
  const pnlPct = dir === 'bullish' ? ((exit - entryPrice) / entryPrice) * 100 : ((entryPrice - exit) / entryPrice) * 100;
  const risk = Math.abs(entryPrice - stop);
  const costPct = 0.25 * risk / entryPrice * 100;
  return {
    ...base, status: 'verified',
    triggerVerifyDate: t1Bar.date,
    entryDate: bars[entryIdx].date, entryPrice: round(entryPrice, 1),
    exitDate, exitPrice: round(exit, 1), exitType,
    directionCorrect, pnlPct: round(pnlPct, 2), costPct: round(costPct, 2), netPnlPct: round(pnlPct - costPct, 2),
    target1: round(t1, 1), target2: targets.t2 == null ? null : round(targets.t2, 1),
    invalidationLevel: invLevel == null ? null : round(invLevel, 1),
    atr5: round(a5, 2), gap: round(gap, 1), gapMul
  };
}

function aggregate(list) {
  const verified = list.filter(s => s.status === 'verified');
  const sum = f => verified.reduce((a, s) => a + f(s), 0);
  return {
    plans: list.length,
    executable: list.filter(s => s.executionStatus === 'executable').length,
    pricingWatch: list.filter(s => s.status === 'pricing_watch').length,
    effectiveExecutable: list.filter(s => s.executionStatus === 'executable').length - list.filter(s => s.status === 'pricing_watch').length,
    signals: list.filter(s => s.executionStatus === 'executable').length,
    verifiedCount: verified.length,
    triggerMiss: list.filter(s => s.status === 'trigger_miss').length,
    gapSkip: list.filter(s => s.status === 'gap_skip').length,
    stopRate: verified.length ? round(verified.filter(s => s.exitType === 'stopped_out').length / verified.length * 100, 2) : 0,
    target1Rate: verified.length ? round(verified.filter(s => s.exitType === 'target1_hit').length / verified.length * 100, 2) : 0,
    directionCorrectRate: verified.length ? round(verified.filter(s => s.directionCorrect).length / verified.length * 100, 2) : 0,
    avgPnlPct: verified.length ? round(sum(s => s.pnlPct) / verified.length, 2) : 0,
    avgNetPnlPct: verified.length ? round(sum(s => s.netPnlPct) / verified.length, 2) : 0
  };
}

function main() {
  const planDir = path.join(V7, 'strategy-plans');
  const pricing = loadJSON(path.join(V7, 'pricing-layer-v8.json'));
  const pricingByKey = Object.fromEntries(pricing.entries.map(e => [`${e.symbol}-${e.date}`, e]));
  const files = fs.readdirSync(planDir).filter(f => f.endsWith('.json') && f !== 'manifest.json').sort();
  const results = files.map(f => {
    const sym = f.split('-')[0];
    const date = f.replace('.json','').split('-').slice(1).join('-');
    return executePlan(sym, path.join(planDir, f), pricingByKey[`${sym}-${date}`]);
  });
  const agg = aggregate(results);
  const bySymbol = Object.fromEntries(SYMBOLS.map(sym => {
    const list = results.filter(r => r.symbol === sym);
    return [sym, aggregate(list)];
  }));

  const report = {
    schema: 'futures-radar-signal-backtest/8-1',
    meta: {
      generatedAt: new Date().toISOString(),
      universe: SYMBOLS,
      anchorsPerSymbol: 10,
      engine: 'production-strategy-plan + pricing-layer F1-F5',
      costPerTradeR: 0.25,
      inSample: true,
      note: 'FinCoT 只做分析；策略计划由生产 strategy-matcher 产出；执行先过 F1-F5 定价层，只执行 effectiveExecutionStatus=executable 的计划。'
    },
    aggregate: agg,
    perSymbol: bySymbol,
    signals: results
  };
  const jsonPath = path.join(OUT_DIR, 'signal-quality-baseline-v8-1.json');
  const mdPath = path.join(OUT_DIR, 'signal-quality-baseline-v8-1.md');
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  const L = ['# 信号质量回测基线 V8.1（生产 strategy-plan + F1-F5 定价层）', '',
    '> 链路：V7 FinCoT（分析）→ 生产 strategy-matcher（策略适配）→ 本执行引擎（只读 plan 字段）。', '',
    `- 30 个计划：原始 executable ${agg.executable}、定价层放行 ${agg.effectiveExecutable}（watch ${agg.pricingWatch}）、成交 ${agg.verifiedCount}、方向正确率 ${agg.directionCorrectRate}%、毛 ${agg.avgPnlPct}%/净 ${agg.avgNetPnlPct}%`, '',
    '| 品种 | 计划 | 原始 exec | 定价放行 | watch | 成交 | 方向正确率 | 毛盈亏 | 净盈亏 |',
    '|---|---|---|---|---|---|---|---|---|'];
  for (const sym of SYMBOLS) {
    const a = bySymbol[sym];
    L.push(`| ${sym} | ${a.plans} | ${a.executable} | ${a.effectiveExecutable} | ${a.pricingWatch} | ${a.verifiedCount} | ${a.directionCorrectRate}% | ${a.avgPnlPct}% | ${a.avgNetPnlPct}% |`);
  }
  L.push('', '## 逐计划结果', '', '| 品种 | 锚点 | 状态 | 方向 | 策略 | 入场 | 离场 | 盈亏 |', '|---|---|---|---|---|---|---|---|');
  for (const s of results) {
    L.push(`| ${s.symbol} | ${s.anchorDate} | ${s.status} | ${s.direction} | ${s.matchedStrategies.join(',')} | ${s.entryPrice ?? '-'} | ${s.exitPrice ?? '-'}${s.exitType ? `（${s.exitType}）` : ''} | ${s.pnlPct ?? '-'}% |`);
  }
  fs.writeFileSync(mdPath, `${L.join('\n')}\n`, 'utf8');
  console.log(JSON.stringify({ meta: report.meta, aggregate: agg, perSymbol: bySymbol, jsonPath, mdPath }, null, 2));
}

if (require.main === module) main();

module.exports = { executePlan, aggregate, main };
