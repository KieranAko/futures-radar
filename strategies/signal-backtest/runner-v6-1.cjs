// strategies/signal-backtest/runner-v6-1.cjs — v6.1 安全执行引擎（复用 v5 计划，硬约束修正版）
//
// 在 v5 已冻结的 A/B/C 计划上应用五道确定性安全闸：
//   G1 冲突闸：shock/极端动量的 breakout 必须有宏观+板块同侧，否则禁止
//   G2 确认距离闸（仅 C）：Q4 确认位与触发价距离 ≤ 1.5×ATR5；三层共振（macro=sector=direction
//      且 breadth≤0.2 且 coherence≥0.8）时可豁免
//   G3 目标帽：target1 距离 ≤ 2×ATR5，超出自动截断
//   G4 三日确认/保本/移动止损：第 3 交易日收盘 MFE<0.5R 离场；MFE≥1R 保本；MFE≥1.5R 移动止损
//   G5 失效硬退出：持仓期每日检查 invalidationLevel，反向越界立即收盘离场
//
// v6.1 修正：G1 只作用于 B/C；三集合口径 + 闸门成本；止损帽 R≥1；信号日 sector 重算；
// 失效价带宽校验；net 成本口径；证据方向 linter；前10/后10 锚点拆分；diff 敏感性。
// 输出 signal-quality-baseline-v6-1.{md,json}。
'use strict';

const fs = require('fs');
const path = require('path');
const store = require('../../data-store/index.cjs');
const { verifySignal, isBannedCombo } = require('./runner.cjs');
const { makeSignalV3, aggregateSignals, crossTab, qualityFlagTab } = require('./runner-v3.cjs');
const { buildSector } = require('./context-bundle-builder.cjs');

const ROOT = __dirname;
const V5 = path.join(ROOT, 'recordings', 'v5');
const OUT_DIR = path.join(ROOT, 'output');
const SYMBOLS = ['RB0', 'M0', 'SC0'];
const ARMS = ['A', 'B', 'C'];
const GATE = { G1: 1, G2: 1, G3: 1, G4: 1, G5: 1 };

const mean = arr => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
const round = (v, d = 4) => (v == null || !isFinite(v) ? v : Math.round(v * Math.pow(10, d)) / Math.pow(10, d));
const pct = (a, b) => (b ? round((a / b) * 100, 2) : 0);
const loadJSON = p => JSON.parse(fs.readFileSync(p, 'utf8'));

function loadBars(symbol) {
  const cache = store.loadHistoricalCache();
  const c = cache.contracts && cache.contracts[symbol];
  if (c && c.ohlcv && Array.isArray(c.ohlcv.dates) && c.ohlcv.dates.length > 0) {
    const o = c.ohlcv;
    return { bars: o.dates.map((d, i) => ({ date: d, open: o.open[i], high: o.high[i], low: o.low[i], close: o.close[i], volume: o.volume && o.volume[i] })), source: 'data-store daily merged' };
  }
  const fixture = path.join(V5, 'history-2y.json');
  if (fs.existsSync(fixture)) return { bars: loadJSON(fixture).symbols[symbol].bars, source: 'recordings/v5/history-2y.json fixture' };
  throw new Error(`runner-v6: no bars for ${symbol}`);
}

function atr5(bars, uptoIdx) {
  if (uptoIdx < 1) return null;
  const trs = [];
  for (let i = 1; i <= uptoIdx; i++) trs.push(Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - bars[i - 1].close), Math.abs(bars[i].low - bars[i - 1].close)));
  return mean(trs.slice(-5));
}
function ma20(bars, uptoIdx) { return mean(bars.slice(Math.max(0, uptoIdx - 19), uptoIdx + 1).map(b => b.close)); }

function resolveFincotEntry(byDate, date, seen = new Set()) {
  if (seen.has(date) || !byDate[date]) return null;
  seen.add(date);
  const e = byDate[date];
  if (e.mode === 'reused' && e.reusedFrom) return resolveFincotEntry(byDate, e.reusedFrom, seen);
  return e;
}

function q4Numbers(fin) {
  if (!fin || !fin.q4) return [];
  return [...String(fin.q4).matchAll(/(\d+(?:\.\d+)?)/g)].map(m => parseFloat(m[1])).filter(n => n > 1 && n < 100000);
}

function loadPlans(arm) {
  if (arm === 'A') {
    const j = loadJSON(path.join(V5, 'arm-A.json'));
    return Object.fromEntries(SYMBOLS.map(s => [s, j.symbols[s]]));
  }
  const out = {};
  for (const sym of SYMBOLS) {
    const j = loadJSON(path.join(V5, `arm-${arm}-${sym}.json`));
    let plans = j.anchors;
    const bundle = loadJSON(path.join(V5, `bundle-${sym}.json`));
    const bundleByDate = Object.fromEntries(bundle.rows.map(r => [r.d, r]));
    if (arm === 'C') {
      const fincot = loadJSON(path.join(V5, `fincot-${sym}.json`));
      const byDate = Object.fromEntries(fincot.entries.map(e => [e.anchorDate, e]));
      plans = plans.map(p => {
        const fin = resolveFincotEntry(byDate, p.date);
        return {
          ...p,
          finCotMode: byDate[p.date] ? byDate[p.date].mode : 'unknown',
          finCotReusedFrom: byDate[p.date] ? byDate[p.date].reusedFrom || null : null,
          q4Numbers: q4Numbers(fin),
          anchorRow: bundleByDate[p.date] || null
        };
      });
    } else {
      plans = plans.map(p => ({ ...p, anchorRow: bundleByDate[p.date] || null }));
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

// G1：冲突闸（仅 B/C 臂；A 臂契约不含 macroBias/sectorBias，闸门放弃判定）
function g1(arm, anchor, b, a5, m20, chg5s) {
  if (arm === 'A') return null; // P1：适用域与信息域一致
  if (anchor.triggerType !== 'breakout') return null;
  const row = anchor.anchorRow;
  const anchorExtreme = anchor.regime === 'shock' || (row && Math.abs(row.chg5) >= 8);
  if (anchorExtreme) {
    const aligned = anchor.macroBias === anchor.direction && anchor.sectorBias === anchor.direction;
    if (!aligned) return 'g1_shock_conflict_breakout_forbidden';
  }
  if (Math.abs(chg5s) >= 5) {
    const trendOk = anchor.direction === 'bullish' ? b.close > m20 : b.close < m20;
    const sectorOk = anchor.sectorBias === anchor.direction;
    if (!(trendOk && sectorOk)) return 'g1_extreme_momentum_breakout_forbidden';
  }
  return null;
}

// G2：确认距离闸（仅 C 臂；三层共振豁免使用信号日 sector br/co）
function g2(anchor, triggerLevel, a5, sector) {
  if (!anchor.q4Numbers || anchor.q4Numbers.length === 0) return null;
  let q4 = anchor.q4Numbers[0];
  for (const n of anchor.q4Numbers) if (Math.abs(n - triggerLevel) < Math.abs(q4 - triggerLevel)) q4 = n;
  const distanceAtr = Math.abs(q4 - triggerLevel) / a5;
  if (distanceAtr <= 1.5) return null;
  const resonance = anchor.macroBias === anchor.direction && anchor.sectorBias === anchor.direction
    && sector && sector.br != null && sector.br <= 0.2 && sector.co != null && sector.co >= 0.8;
  return resonance ? null : `g2_confirmation_too_far:${round(distanceAtr, 2)}ATR`;
}

function makeSafeSignal(symbol, anchor, s, bars, conf) {
  const sig = makeSignalV3(symbol, anchor, s, bars, conf);
  const sign = anchor.direction === 'bullish' ? 1 : -1;
  // P5：止损帽 —— stopDist ≤ 2×ATR5，保证 R = targetDist/stopDist ≥ 1
  const stopCapped = sig.triggerLevel - sign * 2 * conf.atr5;
  const stopTooWide = anchor.direction === 'bullish' ? sig.stopPrice < stopCapped : sig.stopPrice > stopCapped;
  if (stopTooWide) {
    sig.stopPriceOriginal = sig.stopPrice;
    sig.stopPrice = round(stopCapped, 1);
    sig.p5StopCapped = true;
  }
  // G3 目标帽：距离 ≤ 2×ATR5（以触发价为基准）
  const cap = sig.triggerLevel + sign * 2 * conf.atr5;
  if (anchor.direction === 'bullish' ? sig.target1Level > cap : sig.target1Level < cap) {
    sig.target1LevelOriginal = sig.target1Level;
    sig.target1Level = round(cap, 1);
    sig.target1Text = `${round(cap, 1)}（v6.1 目标帽 2×ATR）`;
    sig.g3TargetCapped = true;
  }
  // P6：失效价带宽校验 —— 必须在 (stop, trigger] 带内，否则 G5 放弃判定
  const inv = sig.invalidationLevel;
  const invApplicable = anchor.direction === 'bullish'
    ? (inv != null && inv > sig.stopPrice && inv <= sig.triggerLevel)
    : (inv != null && inv < sig.stopPrice && inv >= sig.triggerLevel);
  sig.invalidationApplicable = !!invApplicable;
  sig.invalidationExit = !!invApplicable;
  sig.macroBias = anchor.macroBias ?? null;
  sig.sectorBias = anchor.sectorBias ?? null;
  sig.eventRisk = anchor.eventRisk ?? null;
  sig.finCotAlignment = anchor.finCotAlignment ?? 'not_applicable';
  sig.finCotMode = anchor.finCotMode ?? null;
  sig.finCotReusedFrom = anchor.finCotReusedFrom ?? null;
  sig.finCotRefs = anchor.finCotRefs || [];
  sig.executionStatus = anchor.executionStatus;
  sig.contextRefs = anchor.contextRefs || [];
  return sig;
}

// P7：信号日 sector 重算（预加载冻结数据，逐日截断计算 br/co）
function makeSectorAt() {
  const cfg = loadJSON(path.join(ROOT, '..', '..', 'config', 'symbols.json'));
  const history = loadJSON(path.join(V5, 'sector-history.json'));
  const cache = new Map();
  return function sectorAt(symbol, date) {
    const key = `${symbol}|${date}`;
    if (cache.has(key)) return cache.get(key);
    const target = Object.values(cfg.symbols).find(v => v.symbol === symbol);
    const members = Object.values(cfg.symbols).filter(v => v.sector === target.sector && v.active !== false).map(v => v.symbol);
    const closesBySym = {};
    for (const m of members) {
      const bars = history.symbols && history.symbols[m];
      if (!bars || !bars.length) continue;
      closesBySym[m] = new Map(bars.filter(b => b.date <= date).map(b => [b.date, b.close]));
    }
    const available = Object.keys(closesBySym);
    if (available.length < 3) { cache.set(key, { br: null, co: null }); return cache.get(key); }
    const daySet = new Set();
    for (const m of available) for (const d of closesBySym[m].keys()) daySet.add(d);
    const days = [...daySet].sort();
    let idx = 1000;
    const series = [];
    for (const d of days) {
      const prev = series.length ? series[series.length - 1] : null;
      const rets = [];
      for (const m of available) {
        const c = closesBySym[m].get(d);
        const p = prev ? closesBySym[m].get(prev.date) : null;
        if (c != null && p != null && p !== 0) rets.push(c / p - 1);
      }
      const ret = rets.length ? mean(rets) : 0;
      idx = prev ? idx * (1 + ret) : idx;
      series.push({ date: d, ret });
    }
    const n = series.length;
    let br = null; let co = null;
    if (n >= 5) {
      const sign = Math.sign(series[n - 1].idx / series[n - 6].idx - 1);
      br = series.slice(-5).filter(x => x.ret > 0).length / Math.min(5, n);
      const member5 = [];
      for (const m of available) {
        const ds = [...closesBySym[m].keys()].sort();
        const i = ds.length - 1;
        if (i < 5) continue;
        member5.push((closesBySym[m].get(ds[i]) / closesBySym[m].get(ds[i - 5]) - 1));
      }
      if (sign !== 0) co = member5.filter(x => Math.sign(x) === sign).length / Math.max(1, member5.length);
    }
    cache.set(key, { br: br == null ? null : round(br, 2), co: co == null ? null : round(co, 2) });
    return cache.get(key);
  };
}

function lintEvidence(sig, anchor) {
  const warnings = [];
  const row = anchor.anchorRow;
  if (!row || !sig.contextRefs || !sig.contextRefs.length) return warnings;
  const dir = sig.direction === 'bullish' ? 1 : -1;
  for (const ref of sig.contextRefs) {
    if (ref.startsWith('macro.')) {
      const id = ref.slice('macro.'.length);
      const v = row.macro && row.macro[id] ? row.macro[id][2] : null;
      if (v != null && Math.sign(v) !== 0 && Math.sign(v) !== dir && anchor.macroBias === sig.direction) {
        warnings.push(`macro_ref_conflicts_with_claimed_bias:${id}`);
      }
    }
    if (ref === 'sect.r5') {
      const v = row.sect && row.sect.r5;
      if (v != null && Math.sign(v) !== 0 && Math.sign(v) !== dir && anchor.sectorBias === sig.direction) {
        warnings.push('sector_r5_conflicts_with_claimed_bias');
      }
    }
  }
  return warnings;
}

function simulateSafeArm(arm, symbol, plans) {
  const { bars, source } = loadBars(symbol);
  const sectorAt = makeSectorAt();
  const byDate = new Map(bars.map((b, i) => [b.date, i]));
  const anchors = plans.map(p => ({ ...p, idx: byDate.get(p.date) })).filter(p => p.idx != null).sort((a, b) => a.idx - b.idx);
  const signals = [];
  let anchorCursor = 0;
  let pending = null;
  let open = null;

  function recordPositionExit(sig, exitType, exitPrice, exitDate) {
    const entryPrice = open.entryPrice;
    const directionCorrect = sig.direction === 'bullish' ? exitPrice > entryPrice : exitPrice < entryPrice;
    const pnlPct = sig.direction === 'bullish' ? ((exitPrice - entryPrice) / entryPrice) * 100 : ((entryPrice - exitPrice) / entryPrice) * 100;
    const attribution = [];
    if (exitType === 'stopped_out') attribution.push({ code: 'stop_hit', detail: `止损 ${open.stop} 被触发` });
    if (exitType === 'target1_hit') attribution.push({ code: 'target1_hit', detail: `第一目标 ${open.target} 兑现` });
    if (exitType === 'time_stop_3d') attribution.push({ code: 'time_stop_3d', detail: '3 日确认窗口 MFE<0.5R，收盘离场' });
    if (exitType === 'invalidation_exit') attribution.push({ code: 'invalidation_exit', detail: `持仓期失效价 ${sig.invalidationLevel} 被反向越过` });
    attribution.push({ code: directionCorrect ? 'direction_correct' : 'direction_wrong', detail: `${directionCorrect ? '方向一致' : '方向相反'}（entry=${entryPrice}, exit=${exitPrice}）` });
    signals.push({ ...sig, status: 'verified', entryDate: bars[open.entryIdx].date, exitDate, entryPrice: round(entryPrice, 1), exitPrice: round(exitPrice, 1), exitType, stoppedOut: exitType === 'stopped_out', target1Hit: exitType === 'target1_hit', directionCorrect, pnlPct: round(pnlPct, 2), mfePct: open.mfePct, maePct: open.maePct, attribution });
    open = null;
  }

  for (let s = 1; s < bars.length; s++) {
    if (open) {
      const b = bars[s];
      const sig = open.signal;
      // G4 前：先更新 MFE/MAE 与保本/移动止损
      if (sig.direction === 'bullish') {
        open.highWater = Math.max(open.highWater, b.high);
        open.mfePct = round((open.highWater - open.entryPrice) / open.entryPrice * 100, 2);
        open.maePct = round((open.entryPrice - Math.min(open.lowWater, b.low)) / open.entryPrice * 100, 2);
        open.lowWater = Math.min(open.lowWater, b.low);
        const mfeR = (open.highWater - open.entryPrice) / open.riskR;
        if (mfeR >= 1) open.stop = Math.max(open.stop, open.entryPrice);
        if (mfeR >= 1.5) open.stop = Math.max(open.stop, open.highWater - 0.75 * open.riskR);
      } else {
        open.lowWater = Math.min(open.lowWater, b.low);
        open.mfePct = round((open.entryPrice - open.lowWater) / open.entryPrice * 100, 2);
        open.maePct = round((Math.max(open.highWater, b.high) - open.entryPrice) / open.entryPrice * 100, 2);
        open.highWater = Math.max(open.highWater, b.high);
        const mfeR = (open.entryPrice - open.lowWater) / open.riskR;
        if (mfeR >= 1) open.stop = Math.min(open.stop, open.entryPrice);
        if (mfeR >= 1.5) open.stop = Math.min(open.stop, open.lowWater + 0.75 * open.riskR);
      }
      let exited = false;
      if (sig.direction === 'bullish') {
        if (b.low <= open.stop) { recordPositionExit(sig, 'stopped_out', open.stop, b.date); exited = true; }
        else if (b.high >= open.target) { recordPositionExit(sig, 'target1_hit', open.target, b.date); exited = true; }
      } else {
        if (b.high >= open.stop) { recordPositionExit(sig, 'stopped_out', open.stop, b.date); exited = true; }
        else if (b.low <= open.target) { recordPositionExit(sig, 'target1_hit', open.target, b.date); exited = true; }
      }
      if (!exited) {
        // G5 失效硬退出（P6：仅在失效价位于止损带内时启用）
        const inv = sig.invalidationLevel;
        const invHit = sig.invalidationExit && (sig.direction === 'bullish' ? (inv != null && b.close < inv) : (inv != null && b.close > inv));
        if (invHit) { recordPositionExit(sig, 'invalidation_exit', b.close, b.date); exited = true; }
      }
      if (!exited && s >= open.entryIdx + 3) {
        const mfeR = (sig.direction === 'bullish' ? open.highWater - open.entryPrice : open.entryPrice - open.lowWater) / open.riskR;
        if (mfeR < 0.5) { recordPositionExit(sig, 'time_stop_3d', b.close, b.date); exited = true; }
      }
      if (!exited && s >= open.maxEndIdx) { recordPositionExit(sig, 'time_exit', b.close, b.date); }
    }
    if (pending && s === pending.triggerIdx) {
      const b = bars[s];
      const triggered = pending.signal.direction === 'bullish' ? b.close > pending.signal.triggerLevel : b.close < pending.signal.triggerLevel;
      if (triggered && s + 1 < bars.length) {
        const entryBar = bars[s + 1];
        const entryPrice = entryBar.open;
        const gapThreshold = Math.abs(pending.signal.stopPrice - pending.signal.triggerLevel) * 0.5;
        if (Math.abs(entryPrice - pending.signal.triggerLevel) > gapThreshold) signals.push(verifySignal(pending.signal, bars));
        else {
          open = {
            signal: pending.signal,
            entryIdx: s + 1,
            entryPrice,
            stop: pending.signal.stopPrice,
            target: pending.signal.target1Level,
            maxEndIdx: s + 1 + pending.signal.maxHoldingDays,
            riskR: Math.abs(entryPrice - pending.signal.stopPrice),
            highWater: entryBar.high,
            lowWater: entryBar.low,
            mfePct: 0,
            maePct: 0
          };
        }
      } else signals.push(verifySignal(pending.signal, bars));
      pending = null;
    }
    if (!pending && !open) {
      while (anchorCursor < anchors.length - 1 && s > anchors[anchorCursor].idx + 4) anchorCursor++;
      const anchor = anchors[anchorCursor];
      const windowEnd = Math.min(anchor.idx + 4, bars.length - 1);
      if (s >= anchor.idx + 1 && s <= windowEnd && anchor.executionStatus === 'executable' && anchor.direction !== 'neutral' && !isBannedCombo(anchor)) {
        const a5 = atr5(bars, s); const m20 = ma20(bars, s); const b = bars[s];
        if (a5 != null && a5 > 0 && signalGateOk(anchor, b, a5, m20)) {
          const sig = makeSafeSignal(symbol, anchor, s, bars, { atr5: a5, ma20: m20 });
          sig.lintWarnings = lintEvidence(sig, anchor);
          const chg5s = (bars[s].close - bars[s - 5].close) / bars[s - 5].close * 100;
          const sector = sectorAt(symbol, b.date);
          const gate = g1(arm, anchor, b, a5, m20, chg5s) || (anchor.q4Numbers ? g2(anchor, sig.triggerLevel, a5, sector) : null);
          if (gate) {
            sig.status = 'gate_skipped';
            sig.gateReasons = [gate];
            sig.gateAt = b.date;
            signals.push(sig);
          } else {
            pending = { signal: sig, triggerIdx: s + 1 };
          }
        }
      }
    }
  }
  return {
    bars, anchors, signals, barsSource: source,
    totalPlans: anchors.length,
    executablePlans: anchors.filter(a => a.executionStatus === 'executable').length,
    gateSkipped: signals.filter(s => s.status === 'gate_skipped').length,
    gateReasons: signals.filter(s => s.status === 'gate_skipped').map(s => s.gateReasons).flat()
  };
}

function aggregateSafe(signals) {
  const verified = signals.filter(s => s.status === 'verified');
  // P8：净收益口径 —— 默认 0.25R 成本（手续费+滑点，含方向折算）
  for (const v of verified) {
    const risk = v.entryPrice != null ? Math.abs(v.entryPrice - v.stopPrice) : 0;
    const costPct = v.entryPrice != null ? 0.25 * risk / v.entryPrice * 100 : 0;
    v.costPct = round(costPct, 2);
    v.netPnlPct = round((v.pnlPct || 0) - costPct, 2);
  }
  return {
    ...aggregateSignals(signals),
    gateSkippedCount: signals.filter(s => s.status === 'gate_skipped').length,
    invalidationExits: verified.filter(s => s.exitType === 'invalidation_exit').length,
    invalidationNotApplicable: signals.filter(s => s.invalidationApplicable === false && s.status !== 'gate_skipped').length,
    timeStop3dExits: verified.filter(s => s.exitType === 'time_stop_3d').length,
    targetCapped: signals.filter(s => s.g3TargetCapped).length,
    stopCapped: signals.filter(s => s.p5StopCapped).length,
    avgMfePct: verified.length ? round(mean(verified.map(s => s.mfePct || 0)), 2) : 0,
    avgMaePct: verified.length ? round(mean(verified.map(s => s.maePct || 0)), 2) : 0,
    avgNetPnlPct: verified.length ? round(mean(verified.map(s => s.netPnlPct || 0)), 2) : 0,
    lintWarningsCount: signals.filter(s => s.lintWarnings && s.lintWarnings.length > 0).length
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
  L.push('# 信号质量回测基线 v6.1（硬约束修正版，复用 v5 计划）');
  L.push('');
  L.push('> v6.1 修正：G1 只作用于 B/C；三集合口径 + 闸门成本；止损帽 R≥1；信号日 sector 重算；失效价带宽校验；net 成本 0.25R；证据 linter；前10/后10 拆分。');
  L.push('');
  L.push(...tableMd('三臂总览（v6.1 安全引擎）', ['臂', '计划', '信号', '闸跳过', '执行', '成交', '方向正确率', '毛盈亏', '净盈亏(0.25R)', 'MFE', 'MAE'], ARMS.map(arm => {
    const a = report.arms[arm].aggregate; const m = report.arms[arm].meta;
    return [arm, m.totalPlans, a.signalCount, a.gateSkippedCount, a.executedCount, a.verifiedCount, `${a.directionCorrectRate}%`, `${a.avgPnlPct}%`, `${a.avgNetPnlPct}%`, `${a.avgMfePct}%`, `${a.avgMaePct}%`];
  })));
  L.push(...tableMd('v5 原引擎 vs v6.1 安全引擎（方向正确率 / 平均盈亏）', ['臂', 'v5 原', 'v6.1 安全'], ARMS.map(arm => {
    const o = report.oldArms[arm].aggregate; const n = report.arms[arm].aggregate;
    return [arm, `${o.directionCorrectRate}% / ${o.avgPnlPct}%`, `${n.directionCorrectRate}% / ${n.avgPnlPct}%`];
  })));
  L.push(...tableMd('闸门成本（gated 信号在 v5 原引擎的反事实）', ['臂', '闸跳过', 'v5 反事实成交', '方向正确', 'savedPnl', 'costPnl', '净收益'], ARMS.map(arm => {
    const cf = report.skippedCF[arm];
    return [arm, cf.gated, cf.v5Trades, `${cf.correct}/${cf.verified}`, `${cf.savedPnl}%`, `${cf.costPnl}%`, `${cf.netBenefit}%`];
  })));
  L.push(...tableMd('前10（校准）/ 后10（验证）拆分', ['臂', '段', '信号', '成交', '方向正确率', '毛盈亏', '净盈亏'], ARMS.flatMap(arm => {
    const sp = report.splits[arm];
    return [
      [arm, '校准段', sp.cal.signalCount, sp.cal.verifiedCount, `${sp.cal.directionCorrectRate}%`, `${sp.cal.avgPnlPct}%`, `${sp.cal.avgNetPnlPct}%`],
      [arm, '验证段', sp.val.signalCount, sp.val.verifiedCount, `${sp.val.directionCorrectRate}%`, `${sp.val.avgPnlPct}%`, `${sp.val.avgNetPnlPct}%`],
      [arm, '验证段（剔4笔归因）', sp.valExcludingKnownTrades.signalCount, sp.valExcludingKnownTrades.verifiedCount, `${sp.valExcludingKnownTrades.directionCorrectRate}%`, `${sp.valExcludingKnownTrades.avgPnlPct}%`, `${sp.valExcludingKnownTrades.avgNetPnlPct}%`]
    ];
  })));
  const c = report.crossTabs.C;
  L.push(...tableMd('C 臂 · macroBias 交叉证伪', ['macroBias', '样本', '方向正确率', '平均盈亏'], c.byMacroBias.map(r => [r.value, r.n, `${r.directionCorrectRate}%`, `${r.avgPnlPct}%`])));
  L.push(...tableMd('C 臂 · sectorBias 交叉证伪', ['sectorBias', '样本', '方向正确率', '平均盈亏'], c.bySectorBias.map(r => [r.value, r.n, `${r.directionCorrectRate}%`, `${r.avgPnlPct}%`])));
  L.push(...tableMd('C 臂 · finCotAlignment / 复用', ['字段', '样本', '方向正确率', '平均盈亏'], [
    ...c.byFinCotAlignment.map(r => [`alignment=${r.value}`, r.n, `${r.directionCorrectRate}%`, `${r.avgPnlPct}%`]),
    ...c.byFinCotMode.map(r => [`mode=${r.value}`, r.n, `${r.directionCorrectRate}%`, `${r.avgPnlPct}%`])
  ]));
  L.push('');
  L.push('## 证伪结论');
  L.push('');
  for (const line of report.falsification) L.push(`- ${line}`);
  L.push('');
  L.push('## 闸命中统计（跳过原因）');
  L.push('');
  for (const [arm, reasons] of Object.entries(report.gateReasons)) {
    const counts = {};
    for (const r of reasons) counts[r] = (counts[r] || 0) + 1;
    L.push(`- ${arm}: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join('，') || '无'}`);
  }
  if (report.diffSensitivity) {
    L.push('');
    L.push('## diff 阈值敏感性（只报告，不选优）');
    L.push('');
    L.push('| 品种 | baseline fresh/reused | relaxed fresh/reused | strict fresh/reused |');
    L.push('|---|---|---|---|');
    for (const sym of report.diffSensitivity.symbols) {
      const get = id => sym.counts.find(c => c.config === id);
      L.push(`| ${sym.symbol} | ${get('baseline').changed}/${get('baseline').reused} | ${get('relaxed').changed}/${get('relaxed').reused} | ${get('strict').changed}/${get('strict').reused} |`);
    }
  }
  return `${L.join('\n')}\n`;
}

function armCrossTabs(signals) {
  const verified = signals.filter(s => s.status === 'verified');
  return {
    byMacroBias: crossTab(verified, 'macroBias'),
    bySectorBias: crossTab(verified, 'sectorBias'),
    byEventRisk: crossTab(verified, 'eventRisk'),
    byFinCotAlignment: crossTab(verified, 'finCotAlignment'),
    byFinCotMode: crossTab(verified, 'finCotMode')
  };
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const arms = {}; const perSymbol = {}; const gateReasons = {};
  for (const arm of ARMS) {
    const plansBySym = loadPlans(arm);
    const sims = {}; const signals = [];
    let totalPlans = 0; let executablePlans = 0; let gateSkipped = 0; const reasons = [];
    for (const sym of SYMBOLS) {
      const sim = simulateSafeArm(arm, sym, plansBySym[sym]);
      sims[sym] = sim; signals.push(...sim.signals);
      totalPlans += sim.totalPlans; executablePlans += sim.executablePlans; gateSkipped += sim.gateSkipped; reasons.push(...sim.gateReasons);
    }
    arms[arm] = { aggregate: aggregateSafe(signals), meta: { totalPlans, executablePlans, gateSkipped }, signals };
    perSymbol[arm] = Object.fromEntries(SYMBOLS.map(sym => [sym, aggregateSafe(sims[sym].signals)]));
    gateReasons[arm] = reasons;
  }
  const oldV5 = loadJSON(path.join(OUT_DIR, 'signal-quality-baseline-v5.json'));
  const oldArms = Object.fromEntries(ARMS.map(arm => [arm, { aggregate: oldV5.arms[arm].aggregate, meta: oldV5.arms[arm].meta }]));

  // P2：闸门成本 —— gated 信号在 v5 原引擎下的反事实成交
  const skippedCF = {};
  for (const arm of ARMS) {
    const v5Signals = oldV5.signals[arm];
    let trades = 0; let savedPnl = 0; let costPnl = 0; let correct = 0; let verified = 0;
    for (const gated of arms[arm].signals.filter(s => s.status === 'gate_skipped')) {
      const key = `${gated.symbol}|${gated.signalDate}`;
      const v5 = v5Signals.find(x => x.status === 'verified' && `${x.symbol}|${x.signalDate}` === key);
      if (!v5) continue;
      trades++; verified++;
      if (v5.directionCorrect) correct++;
      if (v5.pnlPct < 0) savedPnl += -v5.pnlPct; else costPnl += v5.pnlPct;
    }
    skippedCF[arm] = { gated: arms[arm].aggregate.gateSkippedCount, v5Trades: trades, verified, correct, savedPnl: round(savedPnl, 2), costPnl: round(costPnl, 2), netBenefit: round(savedPnl - costPnl, 2) };
  }

  // P3：前 10 锚点（校准段）vs 后 10 锚点（验证段）；已知 4 笔归因交易从放行统计剔除
  const CAL_END = '2026-06-04';
  const KNOWN_TRADES = new Set(['RB0|2026-06-30', 'SC0|2026-04-17', 'SC0|2026-06-24', 'SC0|2026-08-17']);
  const splitAgg = (signals) => {
    const cal = signals.filter(s => s.anchorDate <= CAL_END);
    const val = signals.filter(s => s.anchorDate > CAL_END);
    return {
      cal: aggregateSafe(cal),
      val: aggregateSafe(val),
      valExcludingKnownTrades: aggregateSafe(val.filter(s => !KNOWN_TRADES.has(`${s.symbol}|${s.signalDate}`)))
    };
  };
  const splits = Object.fromEntries(ARMS.map(arm => [arm, splitAgg(arms[arm].signals)]));

  const crossTabs = { C: armCrossTabs(arms.C.signals) };
  const ablation = [
    { comparison: 'B - A（v6.1 引擎）', directionDelta: round(arms.B.aggregate.directionCorrectRate - arms.A.aggregate.directionCorrectRate, 2), pnlDelta: round(arms.B.aggregate.avgPnlPct - arms.A.aggregate.avgPnlPct, 2) },
    { comparison: 'C - B（v6.1 引擎）', directionDelta: round(arms.C.aggregate.directionCorrectRate - arms.B.aggregate.directionCorrectRate, 2), pnlDelta: round(arms.C.aggregate.avgPnlPct - arms.B.aggregate.avgPnlPct, 2) },
    { comparison: 'C - A（v6.1 引擎）', directionDelta: round(arms.C.aggregate.directionCorrectRate - arms.A.aggregate.directionCorrectRate, 2), pnlDelta: round(arms.C.aggregate.avgPnlPct - arms.A.aggregate.avgPnlPct, 2) }
  ];

  // P10：diff 阈值敏感性（只报告）
  let diffSensitivity = null;
  const sensPath = path.join(V5, 'diff-sensitivity.json');
  if (fs.existsSync(sensPath)) diffSensitivity = loadJSON(sensPath);

  const falsification = [];
  for (const arm of ARMS) {
    const o = oldArms[arm].aggregate; const n = arms[arm].aggregate; const cf = skippedCF[arm];
    falsification.push(`${arm} 臂 v5→v6.1：方向正确率 ${o.directionCorrectRate}%→${n.directionCorrectRate}%（${round(n.directionCorrectRate - o.directionCorrectRate, 2)}pp），毛盈亏 ${o.avgPnlPct}%→${n.avgPnlPct}%、净盈亏 ${n.avgNetPnlPct}%；闸跳过 ${n.gateSkippedCount}，其中 v5 反事实成交 ${cf.v5Trades} 笔，saved ${cf.savedPnl}% / cost ${cf.costPnl}%。`);
  }
  const v = splits.C.val; const vx = splits.C.valExcludingKnownTrades;
  falsification.push(`C 臂拆分：校准段 ${splits.C.cal.verifiedCount} 笔 ${splits.C.cal.directionCorrectRate}%；验证段 ${v.verifiedCount} 笔 ${v.directionCorrectRate}%；剔除 4 笔归因交易后 ${vx.verifiedCount} 笔 ${vx.directionCorrectRate}%。inSample=true（本批 20 锚点参与了规则校准），不得据此放行。`);
  falsification.push(`失效价带宽校验：A/B/C 不可用失效退出 ${arms.A.aggregate.invalidationNotApplicable}/${arms.B.aggregate.invalidationNotApplicable}/${arms.C.aggregate.invalidationNotApplicable} 个信号；止损帽命中 A/B/C ${arms.A.aggregate.stopCapped}/${arms.B.aggregate.stopCapped}/${arms.C.aggregate.stopCapped} 个信号；证据 linter 警告 A/B/C ${arms.A.aggregate.lintWarningsCount}/${arms.B.aggregate.lintWarningsCount}/${arms.C.aggregate.lintWarningsCount} 个信号。`);
  falsification.push('v6.1 只修评估与规则硬约束，仍不得作为策略有效性证据；下一轮必须在未见锚点上做 out-of-sample。');

  const report = {
    schema: 'futures-radar-signal-backtest/6-1',
    meta: {
      generatedAt: new Date().toISOString(),
      arms: ARMS,
      universe: SYMBOLS,
      anchorsPerSymbol: 20,
      engine: 'v6.1-safe',
      gates: GATE,
      costPerTradeR: 0.25,
      inSample: true,
      knownAttributionTradesExcluded: [...KNOWN_TRADES],
      barsSource: 'data-store daily merged（500 bars）'
    },
    arms: Object.fromEntries(ARMS.map(arm => [arm, { aggregate: arms[arm].aggregate, meta: arms[arm].meta }])),
    oldArms,
    skippedCF,
    splits,
    crossTabs,
    ablation,
    gateReasons,
    diffSensitivity,
    falsification,
    signals: ARMS.reduce((acc, arm) => {
      acc[arm] = arms[arm].signals.map(s => ({
        symbol: s.symbol, anchorDate: s.anchorDate, signalDate: s.signalDate, status: s.status,
        direction: s.direction, confidence: s.confidence, regime: s.regime, edge: s.edge, triggerType: s.triggerType,
        executionStatus: s.executionStatus, macroBias: s.macroBias, sectorBias: s.sectorBias, eventRisk: s.eventRisk,
        finCotAlignment: s.finCotAlignment, finCotMode: s.finCotMode, gateReasons: s.gateReasons || [],
        lintWarnings: s.lintWarnings || [],
        triggerLevel: s.triggerLevel, stopPrice: s.stopPrice, target1Level: s.target1Level, target1LevelOriginal: s.target1LevelOriginal || null,
        stopPriceOriginal: s.stopPriceOriginal || null,
        entryDate: s.entryDate, entryPrice: s.entryPrice, exitDate: s.exitDate, exitPrice: s.exitPrice,
        exitType: s.exitType, directionCorrect: s.directionCorrect, pnlPct: s.pnlPct, costPct: s.costPct, netPnlPct: s.netPnlPct, mfePct: s.mfePct, maePct: s.maePct,
        invalidationApplicable: s.invalidationApplicable
      }));
      return acc;
    }, {})
  };
  const jsonPath = path.join(OUT_DIR, 'signal-quality-baseline-v6-1.json');
  const mdPath = path.join(OUT_DIR, 'signal-quality-baseline-v6-1.md');
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  fs.writeFileSync(mdPath, renderMd(report), 'utf8');
  console.log(JSON.stringify({ meta: report.meta, arms: report.arms, oldArms: report.oldArms, skippedCF: report.skippedCF, splits: report.splits, ablation: report.ablation, crossTabs: report.crossTabs, gateReasons: report.gateReasons, falsification: report.falsification, jsonPath, mdPath }, null, 2));
}

if (require.main === module) main();

module.exports = { loadPlans, simulateSafeArm, aggregateSafe, main };
