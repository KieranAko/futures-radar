// strategies/signal-backtest/runner-v3.cjs — 信号质量回测 v3（LLM 定性判断优先）
//
// 与 v1/v2 的区别：
//   - 数值参数降级为执行机制，不再按组合胜率排序“选优”；
//   - LLM 锚点新增 regime / edge / triggerType / qualityFlags / thesis /
//     invalidationReason，回测对这些定性判断做交叉证伪；
//   - 增加纯量化对照臂（MA20 趋势 + 固定执行参数），回答“LLM 判断比不用 LLM 多贡献了什么”。
//
// 纪律：
//   - 信号生成阶段只允许读取 bars[0..signalIdx]；
//   - 未来数据只用于验证（T+1 确认、T+2 执行、止损/目标/时间退出）；
//   - 不写真实 strategy-feedback 台账，输出只在 output/。
//
// 用法：
//   node strategies/signal-backtest/runner-v3.cjs
'use strict';

const fs = require('fs');
const path = require('path');
const store = require('../../data-store/index.cjs');
const { verifySignal, BANNED_COMBOS, isBannedCombo } = require('./runner.cjs');

const ROOT = __dirname;
const RECORDINGS = path.join(ROOT, 'recordings', 'v3');
const OUT_DIR = path.join(ROOT, 'output');
const UNIVERSE = ['RB0', 'M0', 'SC0'];
const CONTROL_PARAMS = { triggerAtrMult: 0.5, stopAtrMult: 1.5, targetR: 2, maxHoldDays: 5 };

const mean = arr => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
function round(v, digits = 4) {
  if (v == null || !isFinite(v)) return v;
  const f = Math.pow(10, digits);
  return Math.round(v * f) / f;
}
function pct(a, b) { return b ? round((a / b) * 100, 2) : 0; }

function loadBarsV3(symbol) {
  const cache = store.loadHistoricalCache();
  const c = cache.contracts && cache.contracts[symbol];
  if (c && c.ohlcv && Array.isArray(c.ohlcv.dates) && c.ohlcv.dates.length > 0) {
    const o = c.ohlcv;
    return {
      bars: o.dates.map((d, i) => ({ date: d, open: o.open[i], high: o.high[i], low: o.low[i], close: o.close[i], volume: o.volume && o.volume[i] })),
      source: 'data-store daily merged'
    };
  }
  for (const name of ['history-2y.json', path.join('..', '2y', 'history-2y.json')]) {
    const fixture = path.join(RECORDINGS, name);
    if (fs.existsSync(fixture)) {
      const j = JSON.parse(fs.readFileSync(fixture, 'utf8'));
      const h = j.symbols && j.symbols[symbol];
      if (h && Array.isArray(h.bars) && h.bars.length > 0) return { bars: h.bars, source: `${name} fixture` };
    }
  }
  throw new Error(`runner-v3: no bars for ${symbol}`);
}

function atr5(bars, uptoIdx) {
  if (uptoIdx < 1) return null;
  const trs = [];
  for (let i = 1; i <= uptoIdx; i++) {
    trs.push(Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - bars[i - 1].close), Math.abs(bars[i].low - bars[i - 1].close)));
  }
  return mean(trs.slice(-5));
}
function ma20(bars, uptoIdx) {
  return mean(bars.slice(Math.max(0, uptoIdx - 19), uptoIdx + 1).map(b => b.close));
}

function loadAnchorsV3(symbol) {
  const p = path.join(RECORDINGS, `anchors-${symbol}.json`);
  if (!fs.existsSync(p)) throw new Error(`runner-v3: missing ${p}`);
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  const { bars, source } = loadBarsV3(symbol);
  const byDate = new Map(bars.map((b, i) => [b.date, i]));
  const anchors = (j.anchors || []).map(a => ({ ...a, idx: byDate.get(a.date) })).filter(a => a.idx != null);
  if (anchors.length === 0) throw new Error(`runner-v3: no valid anchors for ${symbol}`);
  for (const [i, a] of anchors.entries()) {
    if (!a.regime || !a.thesis || !a.invalidationReason) throw new Error(`${symbol}[${i}] missing qualitative fields`);
    if (a.direction !== 'neutral') {
      if (!a.edge || !a.triggerType || typeof a.invalidationLevel !== 'number') throw new Error(`${symbol}[${i}] missing edge fields`);
      if (a.triggerType === 'pullback' && typeof a.pullbackLevel !== 'number') throw new Error(`${symbol}[${i}] pullbackLevel required`);
      if (a.triggerType === 'breakout' && typeof a.triggerAtrMult !== 'number') throw new Error(`${symbol}[${i}] triggerAtrMult required`);
    }
  }
  return { bars, anchors, step: j.step || 5, barsSource: source, bannedCount: anchors.filter(a => isBannedCombo(a)).length };
}

function makeSignalV3(symbol, anchor, signalIdx, bars, conf) {
  const bar = bars[signalIdx];
  const close = bar.close;
  const a5 = conf.atr5;
  const sign = anchor.direction === 'bullish' ? 1 : -1;
  let triggerLevel; let stopPrice; let target1Level;
  if (anchor.triggerType === 'pullback') {
    triggerLevel = anchor.pullbackLevel;
    stopPrice = triggerLevel - sign * anchor.stopAtrMult * a5;
    target1Level = triggerLevel + sign * anchor.targetR * anchor.stopAtrMult * a5;
  } else {
    triggerLevel = close + sign * anchor.triggerAtrMult * a5;
    stopPrice = triggerLevel - sign * anchor.stopAtrMult * a5;
    target1Level = triggerLevel + sign * anchor.targetR * Math.abs(triggerLevel - stopPrice);
  }
  return {
    symbol,
    anchorDate: anchor.date,
    signalDate: bar.date,
    direction: anchor.direction,
    confidence: anchor.confidence,
    regime: anchor.regime,
    edge: anchor.edge,
    triggerType: anchor.triggerType,
    qualityFlags: anchor.qualityFlags || [],
    thesis: anchor.thesis,
    driver: anchor.driver,
    invalidationReason: anchor.invalidationReason,
    close,
    atr5: round(a5, 2),
    triggerLevel: round(triggerLevel, 1),
    stopPrice: round(stopPrice, 1),
    target1Level: round(target1Level, 1),
    target1Text: `${round(target1Level, 1)}（信号质量回测目标）`,
    triggerTiming: 'T+1 收盘确认；确认后下一交易日开盘执行',
    maxHoldingDays: anchor.maxHoldDays,
    triggerAtrMult: anchor.triggerAtrMult,
    stopAtrMult: anchor.stopAtrMult,
    targetR: anchor.targetR,
    invalidationLevel: anchor.invalidationLevel
  };
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
  // breakout：趋势方向与 ma20 一致
  return anchor.direction === 'bullish' ? b.close > m20 : b.close < m20;
}

function simulateLLM(symbol) {
  const { bars, anchors, step, barsSource, bannedCount } = loadAnchorsV3(symbol);
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
    signals.push({
      ...sig, status: 'verified',
      triggerVerifyDate: bars[open.entryIdx - 1].date,
      entryDate: bars[open.entryIdx].date,
      exitDate,
      entryPrice: round(entryPrice, 1),
      exitPrice: round(exitPrice, 1),
      exitType,
      stoppedOut: exitType === 'stopped_out',
      target1Hit: exitType === 'target1_hit',
      directionCorrect,
      pnlPct: round(pnlPct, 2),
      attribution
    });
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
        if (Math.abs(entryPrice - pending.signal.triggerLevel) > gapThreshold) {
          signals.push(verifySignal(pending.signal, bars));
        } else {
          open = {
            signal: pending.signal, entryIdx: s + 1, entryPrice,
            stop: pending.signal.stopPrice, target: pending.signal.target1Level,
            maxEndIdx: s + 1 + pending.signal.maxHoldingDays
          };
        }
      } else {
        signals.push(verifySignal(pending.signal, bars));
      }
      pending = null;
    }
    if (!pending && !open) {
      while (anchorCursor < anchors.length - 1 && s > anchors[anchorCursor].idx + step - 1) anchorCursor++;
      const anchor = anchors[anchorCursor];
      const windowEnd = Math.min(anchor.idx + step - 1, bars.length - 1);
      if (s >= anchor.idx + 1 && s <= windowEnd && anchor.direction !== 'neutral' && !isBannedCombo(anchor)) {
        const a5 = atr5(bars, s);
        const m20 = ma20(bars, s);
        if (a5 != null && a5 > 0 && signalGateOk(anchor, bars[s], a5, m20)) {
          pending = { signal: makeSignalV3(symbol, anchor, s, bars, { atr5: a5, ma20: m20 }), triggerIdx: s + 1 };
        }
      }
    }
  }
  return { bars, anchors, signals, barsSource, step, bannedCount };
}

function simulateControl(bars) {
  const signals = [];
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

  for (let s = 21; s < bars.length; s++) {
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
      const a5 = atr5(bars, s); const m20 = ma20(bars, s); const b = bars[s];
      const direction = b.close > m20 ? 'bullish' : 'bearish';
      const anchor = { ...CONTROL_PARAMS, direction, confidence: 'quant', regime: 'quant', edge: 'quant_trend', triggerType: 'breakout', qualityFlags: [], invalidationLevel: m20, thesis: 'quant MA20 baseline', driver: 'quant MA20 baseline', invalidationReason: 'MA20 反转' };
      pending = { signal: makeSignalV3('CONTROL', anchor, s, bars, { atr5: a5, ma20: m20 }), triggerIdx: s + 1 };
    }
  }
  return signals;
}

function aggregateSignals(signals) {
  const verified = signals.filter(s => s.status === 'verified');
  const executed = signals.filter(s => s.status === 'verified' || s.status === 'gap_skip');
  const sum = f => verified.reduce((a, s) => a + f(s), 0);
  const conf = { high: { n: 0, correct: 0, pnl: 0 }, medium: { n: 0, correct: 0, pnl: 0 }, low: { n: 0, correct: 0, pnl: 0 } };
  for (const s of verified) {
    const c = conf[s.confidence] || { n: 0, correct: 0, pnl: 0 };
    c.n++; if (s.directionCorrect) c.correct++; c.pnl += s.pnlPct;
    conf[s.confidence] = c;
  }
  return {
    signalCount: signals.length,
    triggerRate: pct(executed.length, signals.length),
    executedCount: executed.length,
    verifiedCount: verified.length,
    gapSkipCount: signals.filter(s => s.status === 'gap_skip').length,
    triggerMissCount: signals.filter(s => s.status === 'trigger_miss').length,
    stopRate: pct(verified.filter(s => s.stoppedOut).length, verified.length),
    target1Rate: pct(verified.filter(s => s.target1Hit).length, verified.length),
    timeExitRate: pct(verified.filter(s => s.exitType === 'time_exit').length, verified.length),
    directionCorrectRate: pct(verified.filter(s => s.directionCorrect).length, verified.length),
    avgPnlPct: round(sum(s => s.pnlPct) / Math.max(1, verified.length), 2),
    byConfidence: Object.fromEntries(Object.entries(conf).map(([k, v]) => [k, { n: v.n, directionCorrectRate: pct(v.correct, v.n), avgPnlPct: round(v.pnl / Math.max(1, v.n), 2) }]))
  };
}

function crossTab(verified, field) {
  const map = new Map();
  for (const s of verified) {
    const key = s[field] == null ? 'null' : String(s[field]);
    const v = map.get(key) || { n: 0, correct: 0, pnl: 0 };
    v.n++; if (s.directionCorrect) v.correct++; v.pnl += s.pnlPct;
    map.set(key, v);
  }
  return [...map.entries()].map(([key, v]) => ({ value: key, n: v.n, directionCorrectRate: pct(v.correct, v.n), avgPnlPct: round(v.pnl / Math.max(1, v.n), 2) }))
    .sort((a, b) => b.n - a.n);
}

function qualityFlagTab(verified) {
  const map = new Map();
  for (const s of verified) {
    for (const f of s.qualityFlags || []) {
      const v = map.get(f) || { n: 0, correct: 0, pnl: 0 };
      v.n++; if (s.directionCorrect) v.correct++; v.pnl += s.pnlPct;
      map.set(f, v);
    }
  }
  return [...map.entries()].map(([key, v]) => ({ value: key, n: v.n, directionCorrectRate: pct(v.correct, v.n), avgPnlPct: round(v.pnl / Math.max(1, v.n), 2) }))
    .sort((a, b) => b.n - a.n);
}

function mechanicsTab(verified) {
  const map = new Map();
  for (const s of verified) {
    const key = `trigger${s.triggerAtrMult == null ? '-' : s.triggerAtrMult}×stop${s.stopAtrMult}×R${s.targetR}×hold${s.maxHoldingDays}×${s.triggerType}`;
    const v = map.get(key) || { n: 0, correct: 0, pnl: 0 };
    v.n++; if (s.directionCorrect) v.correct++; v.pnl += s.pnlPct;
    map.set(key, v);
  }
  return [...map.entries()].map(([key, v]) => ({ params: key, n: v.n, directionCorrectRate: pct(v.correct, v.n), avgPnlPct: round(v.pnl / Math.max(1, v.n), 2) }))
    .sort((a, b) => b.n - a.n);
}

function tableMd(title, headers, rows) {
  const L = [`## ${title}`, '', `| ${headers.join(' | ')} |`, `|${headers.map(() => '---').join('|')}|`];
  for (const r of rows) L.push(`| ${r.join(' | ')} |`);
  L.push('');
  return L;
}

function renderMdV3(report) {
  const L = [];
  const a = report.aggregate;
  L.push('# 信号质量回测基线 v3（LLM 定性判断优先）');
  L.push('');
  L.push('> 立场：不做参数组合选优。数值参数只是执行机制；回测重点证伪 LLM 的 regime / edge / triggerType / qualityFlags 定性判断，并与纯量化对照臂比较。');
  L.push(`> 链路：LLM 锚点（每 ${report.meta.anchorStep} 交易日）→ 确定性信号延续 → T+1 收盘确认 → T+2 开盘执行 → 止损/目标1/时间退出。`);
  L.push('');
  L.push(...tableMd('总览', ['指标', '值'], [
    ['品种', report.meta.universe.join(' / ')],
    ['行情区间', report.meta.barsRange],
    ['LLM 锚点数', `${report.meta.anchorCount}（每 ${report.meta.anchorStep} 交易日）`],
    ['淘汰组合命中锚点（跳过）', report.meta.bannedComboSkippedAnchors],
    ['生成信号', a.signalCount],
    ['触发执行', a.executedCount],
    ['成交 / 跳空放弃', `${a.verifiedCount} / ${a.gapSkipCount}`],
    ['方向正确率', `${a.directionCorrectRate}%`],
    ['目标1 / 止损 / 时间退出', `${a.target1Rate}% / ${a.stopRate}% / ${a.timeExitRate}%`],
    ['平均单笔盈亏', `${a.avgPnlPct}%`]
  ]));
  L.push(...tableMd('分品种', ['品种', '信号', '执行', '方向正确率', '目标1', '止损', '平均盈亏'], Object.entries(report.perSymbol).map(([sym, g]) => [sym, g.signalCount, g.executedCount, `${g.directionCorrectRate}%`, `${g.target1Rate}%`, `${g.stopRate}%`, `${g.avgPnlPct}%`])));
  L.push(...tableMd('LLM 定性判断交叉证伪 · regime', ['regime', '样本', '方向正确率', '平均盈亏'], report.crossTab.byRegime.map(r => [r.value, r.n, `${r.directionCorrectRate}%`, `${r.avgPnlPct}%`])));
  L.push(...tableMd('LLM 定性判断交叉证伪 · edge', ['edge', '样本', '方向正确率', '平均盈亏'], report.crossTab.byEdge.map(r => [r.value, r.n, `${r.directionCorrectRate}%`, `${r.avgPnlPct}%`])));
  L.push(...tableMd('LLM 定性判断交叉证伪 · triggerType', ['triggerType', '样本', '方向正确率', '平均盈亏'], report.crossTab.byTriggerType.map(r => [r.value, r.n, `${r.directionCorrectRate}%`, `${r.avgPnlPct}%`])));
  L.push(...tableMd('LLM 质量核查清单交叉证伪', ['qualityFlag', '样本', '方向正确率', '平均盈亏'], report.crossTab.byQualityFlag.map(r => [r.value, r.n, `${r.directionCorrectRate}%`, `${r.avgPnlPct}%`])));
  L.push(...tableMd('纯量化对照臂（MA20 趋势 + 固定执行参数，无 LLM）', ['指标', 'LLM 锚点臂', '纯量化对照臂'], [
    ['生成信号', report.aggregate.signalCount, report.control.aggregate.signalCount],
    ['触发执行', report.aggregate.executedCount, report.control.aggregate.executedCount],
    ['成交', report.aggregate.verifiedCount, report.control.aggregate.verifiedCount],
    ['方向正确率', `${report.aggregate.directionCorrectRate}%`, `${report.control.aggregate.directionCorrectRate}%`],
    ['平均单笔盈亏', `${report.aggregate.avgPnlPct}%`, `${report.control.aggregate.avgPnlPct}%`]
  ]));
  L.push(...tableMd('执行参数分布（观察，不选优）', ['参数', '样本', '方向正确率', '平均盈亏'], report.executionMechanics.map(r => [r.params, r.n, `${r.directionCorrectRate}%`, `${r.avgPnlPct}%`])));
  L.push('## 证伪结论');
  L.push('');
  for (const line of report.falsification) L.push(`- ${line}`);
  L.push('');
  L.push('## 锚点决策分布（方向 / regime / edge / triggerType）');
  L.push('');
  L.push('| 品种 | direction | regime | edge | triggerType |');
  L.push('|---|---|---|---|---|');
  for (const [sym, d] of Object.entries(report.anchorDistribution)) {
    const fmt = obj => Object.entries(obj).map(([k, v]) => `${k}=${v}`).join(' ');
    L.push(`| ${sym} | ${fmt(d.direction)} | ${fmt(d.regime)} | ${fmt(d.edge)} | ${fmt(d.triggerType)} |`);
  }
  return `${L.join('\n')}\n`;
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const perSymbol = {}; const anchorDistribution = {}; const sims = {};
  let anchorCount = 0; let bannedSkipped = 0; let anchorStep = 5; let minDate = null; let maxDate = null;
  for (const sym of UNIVERSE) {
    const sim = simulateLLM(sym);
    sims[sym] = sim;
    perSymbol[sym] = aggregateSignals(sim.signals);
    anchorCount += sim.anchors.length; bannedSkipped += sim.bannedCount; anchorStep = sim.step;
    const d = { direction: {}, regime: {}, edge: {}, triggerType: {} };
    for (const a of sim.anchors) {
      for (const k of ['direction', 'regime', 'edge', 'triggerType']) { const key = a[k] == null ? 'null' : a[k]; d[k][key] = (d[k][key] || 0) + 1; }
    }
    anchorDistribution[sym] = d;
    if (!minDate || sim.bars[0].date < minDate) minDate = sim.bars[0].date;
    if (!maxDate || sim.bars[sim.bars.length - 1].date > maxDate) maxDate = sim.bars[sim.bars.length - 1].date;
  }
  const llmSignals = []; for (const sym of UNIVERSE) llmSignals.push(...sims[sym].signals);
  const aggregate = aggregateSignals(llmSignals);
  const verified = llmSignals.filter(s => s.status === 'verified');
  const crossTabs = {
    byRegime: crossTab(verified, 'regime'),
    byEdge: crossTab(verified, 'edge'),
    byTriggerType: crossTab(verified, 'triggerType'),
    byQualityFlag: qualityFlagTab(verified)
  };
  const executionMechanics = mechanicsTab(verified);

  const controlSignals = []; for (const sym of UNIVERSE) controlSignals.push(...simulateControl(sims[sym].bars));
  const controlAggregate = aggregateSignals(controlSignals);

  const falsification = [];
  const diff = round(aggregate.directionCorrectRate - controlAggregate.directionCorrectRate, 2);
  falsification.push(`LLM 锚点臂方向正确率 ${aggregate.directionCorrectRate}% vs 纯量化对照臂 ${controlAggregate.directionCorrectRate}%：${diff >= 0 ? 'LLM 判断跑赢' : 'LLM 判断落后'} ${Math.abs(diff)} 个百分点（对照臂=MA20 趋势 + 0.5/1.5/R2/hold5，无 LLM）。`);
  if (bannedSkipped > 0) falsification.push(`淘汰组合命中 ${bannedSkipped} 个锚点，已按契约跳过。`);
  const worstEdge = [...crossTabs.byEdge].sort((x, y) => x.directionCorrectRate - y.directionCorrectRate)[0];
  if (worstEdge) falsification.push(`最弱 edge 类别：${worstEdge.value}（${worstEdge.n} 笔，方向正确率 ${worstEdge.directionCorrectRate}%），下一轮优先收紧该定性判断的准入条件。`);
  const bestEdge = [...crossTabs.byEdge].sort((x, y) => y.directionCorrectRate - x.directionCorrectRate)[0];
  if (bestEdge) falsification.push(`最强 edge 类别：${bestEdge.value}（${bestEdge.n} 笔，方向正确率 ${bestEdge.directionCorrectRate}%），保留并验证其稳定性。`);
  const worstRegime = [...crossTabs.byRegime].sort((x, y) => x.directionCorrectRate - y.directionCorrectRate)[0];
  if (worstRegime) falsification.push(`最弱 regime 类别：${worstRegime.value}（${worstRegime.n} 笔，方向正确率 ${worstRegime.directionCorrectRate}%）。`);
  const flagMiss = verified.filter(s => !s.qualityFlags || s.qualityFlags.length === 0);
  if (flagMiss.length) falsification.push(`${flagMiss.length} 笔成交没有任何 qualityFlag，质量核查清单覆盖率 ${pct(verified.length - flagMiss.length, verified.length)}%。`);
  if (aggregate.gapSkipCount) falsification.push(`跳空放弃 ${aggregate.gapSkipCount} 笔，跳空仍是主要执行摩擦。`);
  falsification.push('结论覆盖 2 年、3 个主力连续品种、录制的 LLM 锚点；成交样本有限，仅作基线，不下“最优参数”结论。');

  const report = {
    schema: 'futures-radar-signal-backtest/3',
    meta: {
      generatedAt: new Date().toISOString(),
      universe: UNIVERSE,
      barsRange: `${minDate}..${maxDate}`,
      barsSource: sims[UNIVERSE[0]].barsSource,
      anchorStep,
      anchorCount,
      bannedComboSkippedAnchors: bannedSkipped,
      bannedCombos: BANNED_COMBOS,
      signalCount: aggregate.signalCount,
      control: { description: 'MA20 趋势 + trigger0.5/stop1.5/R2/hold5，无 LLM', params: CONTROL_PARAMS }
    },
    aggregate,
    perSymbol,
    crossTab: crossTabs,
    executionMechanics,
    control: { aggregate: controlAggregate },
    anchorDistribution,
    falsification,
    signals: llmSignals.map(s => ({
      symbol: s.symbol, anchorDate: s.anchorDate, signalDate: s.signalDate,
      direction: s.direction, confidence: s.confidence, status: s.status,
      regime: s.regime, edge: s.edge, triggerType: s.triggerType, qualityFlags: s.qualityFlags,
      thesis: s.thesis, driver: s.driver, invalidationReason: s.invalidationReason,
      triggerLevel: s.triggerLevel, stopPrice: s.stopPrice, target1Level: s.target1Level,
      entryDate: s.entryDate, entryPrice: s.entryPrice, exitDate: s.exitDate, exitPrice: s.exitPrice,
      exitType: s.exitType, directionCorrect: s.directionCorrect, pnlPct: s.pnlPct,
      triggerAtrMult: s.triggerAtrMult, stopAtrMult: s.stopAtrMult, targetR: s.targetR, maxHoldingDays: s.maxHoldingDays
    }))
  };
  const jsonPath = path.join(OUT_DIR, 'signal-quality-baseline-v3.json');
  const mdPath = path.join(OUT_DIR, 'signal-quality-baseline-v3.md');
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  fs.writeFileSync(mdPath, renderMdV3(report), 'utf8');
  console.log(JSON.stringify({ meta: report.meta, aggregate: report.aggregate, crossTab: report.crossTab, control: report.control, executionMechanics: report.executionMechanics, falsification: report.falsification, jsonPath, mdPath }, null, 2));
}

if (require.main === module) main();

module.exports = { loadBarsV3, loadAnchorsV3, makeSignalV3, simulateLLM, simulateControl, aggregateSignals, crossTab, qualityFlagTab, mechanicsTab, main };
