// strategies/signal-backtest/runner.cjs — 信号质量回测（v0.1.10 · 2y/5d）
//
// 只测「LLM 锚点 → 确定性信号延续 → 策略计划 → 证伪」链路。
// 纪律：
//   - 信号生成阶段只允许读取 bars[0..signalIdx]（截断特征）；
//   - 未来数据只用于验证（T+1 确认、T+2 执行、止损/目标/时间退出）；
//   - 不写真实 strategy-feedback 台账，输出只在 output/。
//   - v1 证伪的最差参数组合（trigger0.5×stop1.5×R2×hold6）永久淘汰。
//
// 用法：
//   node strategies/signal-backtest/runner.cjs
'use strict';

const fs = require('fs');
const path = require('path');
const store = require('../../data-store/index.cjs');

const ROOT = __dirname;
const RECORDINGS = path.join(ROOT, 'recordings', '2y');
const OUT_DIR = path.join(ROOT, 'output');
const UNIVERSE = ['RB0', 'M0', 'SC0'];
// v1 基线证伪淘汰：trigger0.5×stop1.5×R2×hold6（2 笔，方向正确率 0%）
const BANNED_COMBOS = [
  { triggerAtrMult: 0.5, stopAtrMult: 1.5, targetR: 2, maxHoldDays: 6 }
];

function isBannedCombo(anchor) {
  return BANNED_COMBOS.some(c =>
    anchor.triggerAtrMult === c.triggerAtrMult &&
    anchor.stopAtrMult === c.stopAtrMult &&
    anchor.targetR === c.targetR &&
    anchor.maxHoldDays === c.maxHoldDays
  );
}

const mean = arr => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);

function round(v, digits = 4) {
  if (v == null || !isFinite(v)) return v;
  const f = Math.pow(10, digits);
  return Math.round(v * f) / f;
}

function pct(a, b) {
  if (!b) return 0;
  return round((a / b) * 100, 2);
}

function loadBars(symbol) {
  const cache = store.loadHistoricalCache();
  const c = cache.contracts && cache.contracts[symbol];
  if (c && c.ohlcv && Array.isArray(c.ohlcv.dates) && c.ohlcv.dates.length > 0) {
    const o = c.ohlcv;
    const bars = [];
    for (let i = 0; i < o.dates.length; i++) {
      bars.push({
        date: o.dates[i],
        open: o.open[i], high: o.high[i], low: o.low[i], close: o.close[i], volume: o.volume && o.volume[i]
      });
    }
    return { bars, source: 'data-store daily merged' };
  }
  // 可复现兜底：仓库内冻结的 2 年历史（git 追踪），再退 v1 的 1 年夹具
  for (const [name, rel] of [
    ['history-2y.json', RECORDINGS],
    ['history-1y.json', path.join(ROOT, 'recordings', '1y')]
  ]) {
    const fixture = path.join(rel, name);
    if (fs.existsSync(fixture)) {
      const j = JSON.parse(fs.readFileSync(fixture, 'utf8'));
      const h = j.symbols && j.symbols[symbol];
      if (h && Array.isArray(h.bars) && h.bars.length > 0) return { bars: h.bars, source: `${path.relative(ROOT, fixture)} fixture` };
    }
  }
  throw new Error(`signal-backtest: no bars for ${symbol}`);
}

function atr5(bars, uptoIdx) {
  if (uptoIdx < 1) return null;
  const trs = [];
  for (let i = 1; i <= uptoIdx; i++) {
    trs.push(Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close)
    ));
  }
  return mean(trs.slice(-5));
}

function ma20(bars, uptoIdx) {
  const closes = bars.slice(Math.max(0, uptoIdx - 19), uptoIdx + 1).map(b => b.close);
  return mean(closes);
}

function loadAnchors(symbol) {
  const p = path.join(RECORDINGS, `anchors-${symbol}.json`);
  if (!fs.existsSync(p)) throw new Error(`signal-backtest: missing ${p}`);
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  const { bars, source } = loadBars(symbol);
  const byDate = new Map(bars.map((b, i) => [b.date, i]));
  const anchors = (j.anchors || []).map(a => ({ ...a, idx: byDate.get(a.date) })).filter(a => a.idx != null);
  if (anchors.length === 0) throw new Error(`signal-backtest: no valid anchors for ${symbol}`);
  const step = j.step || 5;
  for (const a of anchors) a.banned = isBannedCombo(a);
  return { bars, anchors, step, barsSource: source, bannedCount: anchors.filter(a => a.banned).length };
}

/**
 * 在 signalIdx 生成一个信号计划。只允许使用 bars[0..signalIdx]。
 */
function makeSignal(symbol, anchor, signalIdx, bars, conf) {
  const bar = bars[signalIdx];
  const close = bar.close;
  const a5 = conf.atr5;
  const sign = anchor.direction === 'bullish' ? 1 : -1;
  const triggerLevel = close + sign * anchor.triggerAtrMult * a5;
  const stopPrice = triggerLevel - sign * anchor.stopAtrMult * a5;
  const target1Level = triggerLevel + sign * anchor.targetR * Math.abs(triggerLevel - stopPrice);
  return {
    symbol,
    anchorDate: anchor.date,
    signalDate: bar.date,
    direction: anchor.direction,
    confidence: anchor.confidence,
    driver: anchor.driver,
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

/**
 * 验证一笔信号：T+1 收盘确认 → T+2 开盘执行 → 止损/目标1/时间退出。
 * 未来数据只在这里读取。
 */
function verifySignal(sig, bars) {
  const tIdx = bars.findIndex(b => b.date === sig.signalDate);
  if (tIdx === -1) return { ...sig, status: 'unverifiable', attribution: [{ code: 'signal_date_missing', detail: '序列中找不到信号日' }] };
  if (tIdx + 1 >= bars.length) return { ...sig, status: 'pending_data', attribution: [] };

  const t1 = bars[tIdx + 1];
  const triggered = sig.direction === 'bullish' ? t1.close > sig.triggerLevel : t1.close < sig.triggerLevel;
  if (!triggered) {
    return {
      ...sig, status: 'trigger_miss',
      triggerVerifyDate: t1.date,
      attribution: [{ code: 'trigger_miss', detail: `T+1 未触发入场（${sig.direction} 触发价 ${sig.triggerLevel}）` }]
    };
  }
  if (tIdx + 2 >= bars.length) return { ...sig, status: 'triggered_pending_entry', triggerVerifyDate: t1.date, attribution: [] };

  const entryBar = bars[tIdx + 2];
  const entryPrice = entryBar.open;
  const gapThreshold = Math.abs(sig.stopPrice - sig.triggerLevel) * 0.5;
  const gapPts = Math.abs(entryPrice - sig.triggerLevel);
  if (gapPts > gapThreshold) {
    return {
      ...sig, status: 'gap_skip', entryDate: entryBar.date, entryPrice: round(entryPrice, 1),
      gapPts: round(gapPts, 1), gapThreshold: round(gapThreshold, 1),
      attribution: [{ code: 'gap_skip', detail: `跳空 ${gapPts.toFixed(1)} > ${gapThreshold.toFixed(1)}，放弃执行` }]
    };
  }

  const maxEnd = Math.min(bars.length - 1, tIdx + 2 + sig.maxHoldingDays);
  const stop = sig.stopPrice;
  const target1 = sig.target1Level;
  let exit = null; let exitType = 'time_exit'; let exitDate = null;
  for (let i = tIdx + 2; i <= maxEnd; i++) {
    const b = bars[i];
    if (sig.direction === 'bullish') {
      if (stop != null && b.low <= stop) { exit = stop; exitType = 'stopped_out'; exitDate = b.date; break; }
      if (target1 != null && b.high >= target1) { exit = target1; exitType = 'target1_hit'; exitDate = b.date; break; }
    } else {
      if (stop != null && b.high >= stop) { exit = stop; exitType = 'stopped_out'; exitDate = b.date; break; }
      if (target1 != null && b.low <= target1) { exit = target1; exitType = 'target1_hit'; exitDate = b.date; break; }
    }
    exit = b.close; exitDate = b.date;
  }
  const directionCorrect = sig.direction === 'bullish' ? exit > entryPrice : exit < entryPrice;
  const pnlPct = sig.direction === 'bullish'
    ? ((exit - entryPrice) / entryPrice) * 100
    : ((entryPrice - exit) / entryPrice) * 100;
  const attribution = [];
  if (exitType === 'stopped_out') attribution.push({ code: 'stop_hit', detail: `止损 ${stop} 被触发` });
  if (exitType === 'target1_hit') attribution.push({ code: 'target1_hit', detail: `第一目标 ${target1} 兑现` });
  attribution.push({
    code: directionCorrect ? 'direction_correct' : 'direction_wrong',
    detail: `${directionCorrect ? '方向一致' : '方向相反'}（entry=${entryPrice}, exit=${exit}）`
  });
  return {
    ...sig, status: 'verified',
    triggerVerifyDate: t1.date,
    entryDate: entryBar.date,
    exitDate,
    entryPrice: round(entryPrice, 1),
    exitPrice: round(exit, 1),
    exitType,
    stoppedOut: exitType === 'stopped_out',
    target1Hit: exitType === 'target1_hit',
    directionCorrect,
    pnlPct: round(pnlPct, 2),
    attribution
  };
}

function simulateSymbol(symbol) {
  const { bars, anchors, step, barsSource, bannedCount } = loadAnchors(symbol);
  const signals = [];
  let anchorCursor = 0;
  let pending = null; // 待 T+1 确认的信号
  let open = null;   // 已入场持仓 { signal, entryIdx, maxEndIdx, stop, target }

  for (let s = 1; s < bars.length; s++) {
    // 1) 推进持仓：按当日 bar 检查止损/目标/时间
    if (open) {
      const b = bars[s];
      const sig = open.signal;
      let exited = false;
      if (sig.direction === 'bullish') {
        if (b.low <= open.stop) { closePosition(sig, 'stopped_out', open.stop, b.date); exited = true; }
        else if (b.high >= open.target) { closePosition(sig, 'target1_hit', open.target, b.date); exited = true; }
      } else {
        if (b.high >= open.stop) { closePosition(sig, 'stopped_out', open.stop, b.date); exited = true; }
        else if (b.low <= open.target) { closePosition(sig, 'target1_hit', open.target, b.date); exited = true; }
      }
      if (!exited && s >= open.maxEndIdx) closePosition(sig, 'time_exit', b.close, b.date);
    }

    // 2) 推进 T+1 确认（放在持仓检查之后，不互相影响）
    if (pending && s === pending.triggerIdx) {
      const b = bars[s];
      const triggered = pending.signal.direction === 'bullish'
        ? b.close > pending.signal.triggerLevel
        : b.close < pending.signal.triggerLevel;
      if (triggered) {
        if (s + 1 < bars.length) {
          const entryBar = bars[s + 1];
          const entryPrice = entryBar.open;
          const gapThreshold = Math.abs(pending.signal.stopPrice - pending.signal.triggerLevel) * 0.5;
          const gapPts = Math.abs(entryPrice - pending.signal.triggerLevel);
          if (gapPts > gapThreshold) {
            signals.push(verifySignal(pending.signal, bars));
          } else {
            open = {
              signal: pending.signal,
              entryIdx: s + 1,
              entryPrice,
              stop: pending.signal.stopPrice,
              target: pending.signal.target1Level,
              maxEndIdx: s + 1 + pending.signal.maxHoldingDays
            };
          }
        } else {
          signals.push(verifySignal(pending.signal, bars));
        }
      } else {
        signals.push(verifySignal(pending.signal, bars));
      }
      pending = null;
    }

    // 3) 生成新信号：只允许在当前锚点有效期内且无待确认/持仓
    if (!pending && !open) {
      while (anchorCursor < anchors.length - 1 && s > anchors[anchorCursor].idx + step - 1) anchorCursor++;
      const anchor = anchors[anchorCursor];
      const windowEnd = Math.min(anchor.idx + step - 1, bars.length - 1);
      if (s >= anchor.idx + 1 && s <= windowEnd && anchor.direction !== 'neutral' && !anchor.banned) {
        const a5 = atr5(bars, s);
        const m20 = ma20(bars, s);
        const b = bars[s];
        const regimeOk = anchor.direction === 'bullish'
          ? b.close > anchor.invalidationLevel && b.close > m20
          : b.close < anchor.invalidationLevel && b.close < m20;
        if (regimeOk && a5 != null && a5 > 0) {
          const signal = makeSignal(symbol, anchor, s, bars, { atr5: a5, ma20: m20 });
          pending = { signal, triggerIdx: s + 1 };
        }
      }
    }
  }

  function closePosition(sig, exitType, exitPrice, exitDate) {
    // 持仓推进使用与 verifySignal 相同的未来数据路径：直接存结果并清仓
    const entryPrice = open.entryPrice;
    const directionCorrect = sig.direction === 'bullish' ? exitPrice > entryPrice : exitPrice < entryPrice;
    const pnlPct = sig.direction === 'bullish'
      ? ((exitPrice - entryPrice) / entryPrice) * 100
      : ((entryPrice - exitPrice) / entryPrice) * 100;
    const attribution = [];
    if (exitType === 'stopped_out') attribution.push({ code: 'stop_hit', detail: `止损 ${open.stop} 被触发` });
    if (exitType === 'target1_hit') attribution.push({ code: 'target1_hit', detail: `第一目标 ${open.target} 兑现` });
    attribution.push({
      code: directionCorrect ? 'direction_correct' : 'direction_wrong',
      detail: `${directionCorrect ? '方向一致' : '方向相反'}（entry=${entryPrice}, exit=${exitPrice}）`
    });
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

  return { bars, anchors, signals, barsSource, step, bannedCount };
}

function bucketParams(sig) {
  return `trigger${sig.triggerAtrMult}×stop${sig.stopAtrMult}×R${sig.targetR}×hold${sig.maxHoldingDays}`;
}

function aggregate(signals) {
  const verified = signals.filter(s => s.status === 'verified');
  const executed = signals.filter(s => s.status === 'verified' || s.status === 'gap_skip');
  const sum = (f) => verified.reduce((a, s) => a + f(s), 0);
  const conf = { high: { n: 0, correct: 0, pnl: 0 }, medium: { n: 0, correct: 0, pnl: 0 }, low: { n: 0, correct: 0, pnl: 0 } };
  const params = new Map();
  for (const s of verified) {
    const c = conf[s.confidence] || { n: 0, correct: 0, pnl: 0 };
    c.n++; if (s.directionCorrect) c.correct++; c.pnl += s.pnlPct;
    conf[s.confidence] = c;
    const key = bucketParams(s);
    const p = params.get(key) || { n: 0, correct: 0, pnl: 0, example: s };
    p.n++; if (s.directionCorrect) p.correct++; p.pnl += s.pnlPct;
    params.set(key, p);
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
    byConfidence: Object.fromEntries(Object.entries(conf).map(([k, v]) => [k, {
      n: v.n, directionCorrectRate: pct(v.correct, v.n), avgPnlPct: round(v.pnl / Math.max(1, v.n), 2)
    }])),
    byParams: [...params.entries()]
      .map(([key, v]) => ({
        params: key, n: v.n, directionCorrectRate: pct(v.correct, v.n),
        avgPnlPct: round(v.pnl / Math.max(1, v.n), 2),
        example: { symbol: v.example.symbol, date: v.example.signalDate, direction: v.example.direction }
      }))
      .sort((a, b) => a.directionCorrectRate - b.directionCorrectRate)
  };
}

function renderMd(report) {
  const L = [];
  const a = report.aggregate;
  L.push('# 信号质量回测基线 v2（RB0 / M0 / SC0 · 2 年 · 5 日锚点）');
  L.push('');
  L.push(`> 链路：LLM 锚点（每 ${report.meta.anchorStep} 个交易日）→ 确定性信号延续 → T+1 收盘确认 → T+2 开盘执行 → 止损/目标1/时间退出。`);
  L.push('> 信号生成只用锚点日及以前的截断行情；未来行情只用于验证。');
  L.push('> 淘汰参数组合：trigger0.5×stop1.5×R2×hold6（v1 证伪，2 笔 0% 方向正确率）。');
  L.push('');
  L.push('## 总览');
  L.push('');
  L.push('| 指标 | 值 |');
  L.push('|---|---|');
  L.push(`| 品种 | ${report.meta.universe.join(' / ')} |`);
  L.push(`| 行情区间 | ${report.meta.barsRange} |`);
  L.push(`| LLM 锚点数 | ${report.meta.anchorCount}（每 ${report.meta.anchorStep} 交易日） |`);
  L.push(`| 淘汰组合命中锚点（已跳过） | ${report.meta.bannedComboSkippedAnchors} |`);
  L.push(`| 生成信号 | ${a.signalCount} |`);
  L.push(`| 触发率 | ${a.triggerRate}% |`);
  L.push(`| 执行（含跳空放弃） | ${a.executedCount} |`);
  L.push(`| 跳空放弃 | ${a.gapSkipCount} |`);
  L.push(`| 止损率 | ${a.stopRate}% |`);
  L.push(`| 目标1兑现率 | ${a.target1Rate}% |`);
  L.push(`| 时间退出率 | ${a.timeExitRate}% |`);
  L.push(`| 方向正确率 | ${a.directionCorrectRate}% |`);
  L.push(`| 平均单笔盈亏 | ${a.avgPnlPct}% |`);
  L.push('');
  L.push('## 分品种');
  L.push('');
  L.push('| 品种 | 信号 | 触发率 | 执行 | 止损 | 目标1 | 时间退出 | 方向正确率 | 平均盈亏 |');
  L.push('|---|---|---|---|---|---|---|---|---|');
  for (const [sym, agg] of Object.entries(report.perSymbol)) {
    L.push(`| ${sym} | ${agg.signalCount} | ${agg.triggerRate}% | ${agg.executedCount} | ${agg.stopRate}% | ${agg.target1Rate}% | ${agg.timeExitRate}% | ${agg.directionCorrectRate}% | ${agg.avgPnlPct}% |`);
  }
  L.push('');
  L.push('## 置信度交叉');
  L.push('');
  L.push('| 置信度 | 信号数 | 方向正确率 | 平均盈亏 |');
  L.push('|---|---|---|---|');
  for (const [k, v] of Object.entries(a.byConfidence)) {
    if (v.n > 0) L.push(`| ${k} | ${v.n} | ${v.directionCorrectRate}% | ${v.avgPnlPct}% |`);
  }
  L.push('');
  L.push('## 参数组合证伪（按方向正确率升序）');
  L.push('');
  L.push('| 参数组合 | 样本 | 方向正确率 | 平均盈亏 | 示例 |');
  L.push('|---|---|---|---|---|');
  for (const p of a.byParams) {
    L.push(`| ${p.params} | ${p.n} | ${p.directionCorrectRate}% | ${p.avgPnlPct}% | ${p.example.symbol} ${p.example.date} ${p.example.direction} |`);
  }
  if (report.comparison) {
    L.push('');
    L.push('## v1 vs v2 对照');
    L.push('');
    L.push('| 版本 | 历史 | 锚点间隔 | 锚点数 | 信号 | 执行 | 方向正确率 | 平均盈亏 |');
    L.push('|---|---|---|---|---|---|---|---|');
    L.push(`| v1 | 1 年（250 交易日） | 10 | 69 | ${report.comparison.v1.signalCount} | ${report.comparison.v1.executedCount} | ${report.comparison.v1.directionCorrectRate}% | ${report.comparison.v1.avgPnlPct}% |`);
    L.push(`| v2 | 2 年（500 交易日） | ${report.meta.anchorStep} | ${report.meta.anchorCount} | ${a.signalCount} | ${a.executedCount} | ${a.directionCorrectRate}% | ${a.avgPnlPct}% |`);
  }
  L.push('');
  L.push('## 证伪结论');
  L.push('');
  for (const line of report.falsification) L.push(`- ${line}`);
  L.push('');
  L.push('## 锚点决策分布');
  L.push('');
  L.push('| 品种 | bullish | bearish | neutral |');
  L.push('|---|---|---|---|');
  for (const [sym, d] of Object.entries(report.anchorDistribution)) {
    L.push(`| ${sym} | ${d.bullish} | ${d.bearish} | ${d.neutral} |`);
  }
  return `${L.join('\n')}\n`;
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const perSymbol = {};
  const anchorDistribution = {};
  const sims = {};
  let anchorCount = 0;
  let bannedSkipped = 0;
  let anchorStep = 5;
  let minDate = null; let maxDate = null;
  for (const sym of UNIVERSE) {
    const sim = simulateSymbol(sym);
    sims[sym] = sim;
    perSymbol[sym] = aggregate(sim.signals);
    const dist = { bullish: 0, bearish: 0, neutral: 0, banned: 0 };
    for (const a of sim.anchors) { dist[a.direction]++; if (a.banned) dist.banned++; }
    anchorDistribution[sym] = dist;
    anchorCount += sim.anchors.length;
    bannedSkipped += sim.bannedCount;
    anchorStep = sim.step;
    if (!minDate || sim.bars[0].date < minDate) minDate = sim.bars[0].date;
    if (!maxDate || sim.bars[sim.bars.length - 1].date > maxDate) maxDate = sim.bars[sim.bars.length - 1].date;
  }
  const signals = [];
  for (const sym of UNIVERSE) signals.push(...sims[sym].signals);
  const aggregateAll = aggregate(signals);

  const falsification = [];
  if (bannedSkipped > 0) falsification.push(`淘汰组合命中 ${bannedSkipped} 个锚点：trigger0.5×stop1.5×R2×hold6 已按契约跳过，不产生任何信号。`);
  const worst = aggregateAll.byParams[0];
  if (worst) falsification.push(`方向正确率最低的参数组合：${worst.params}（${worst.n} 笔，${worst.directionCorrectRate}%），优先证伪/调参。`);
  const best = aggregateAll.byParams[aggregateAll.byParams.length - 1];
  if (best) falsification.push(`方向正确率最高的参数组合：${best.params}（${best.n} 笔，${best.directionCorrectRate}%），可作为下一轮锚点默认参数。`);
  const stopOut = signals.filter(s => s.status === 'verified' && s.stoppedOut);
  if (stopOut.length) falsification.push(`止损样本 ${stopOut.length} 笔：${stopOut.map(s => `${s.symbol} ${s.signalDate}`).slice(0, 5).join('、')}${stopOut.length > 5 ? ' 等' : ''}，需要区分“止损过紧 / 方向错误 / 事件冲击”。`);
  if (aggregateAll.gapSkipCount) falsification.push(`跳空放弃 ${aggregateAll.gapSkipCount} 笔：触发与执行价差超过 0.5×止损距离，跳空是主要执行摩擦。`);
  falsification.push('结论覆盖 2 年行情、3 个主力连续品种、录制的 LLM 锚点；样本量仍然有限，仅作为基线。');

  // v1 基线对照（冻结 artifact）
  let comparison = null;
  const v1Path = path.join(OUT_DIR, 'signal-quality-baseline.json');
  if (fs.existsSync(v1Path)) {
    const v1 = JSON.parse(fs.readFileSync(v1Path, 'utf8'));
    comparison = {
      v1: {
        barsRange: v1.meta && v1.meta.barsRange,
        signalCount: v1.aggregate && v1.aggregate.signalCount,
        executedCount: v1.aggregate && v1.aggregate.executedCount,
        directionCorrectRate: v1.aggregate && v1.aggregate.directionCorrectRate,
        avgPnlPct: v1.aggregate && v1.aggregate.avgPnlPct
      }
    };
  }

  const report = {
    schema: 'futures-radar-signal-backtest/2',
    meta: {
      generatedAt: new Date().toISOString(),
      universe: UNIVERSE,
      barsRange: `${minDate}..${maxDate}`,
      barsSource: sims[UNIVERSE[0]].barsSource,
      anchorStep,
      anchorCount,
      bannedComboSkippedAnchors: bannedSkipped,
      bannedCombos: BANNED_COMBOS,
      signalCount: aggregateAll.signalCount
    },
    aggregate: aggregateAll,
    perSymbol,
    anchorDistribution,
    comparison,
    falsification,
    signals: signals.map(s => ({
      symbol: s.symbol, anchorDate: s.anchorDate, signalDate: s.signalDate,
      direction: s.direction, confidence: s.confidence, status: s.status,
      triggerLevel: s.triggerLevel, stopPrice: s.stopPrice, target1Level: s.target1Level,
      entryDate: s.entryDate, entryPrice: s.entryPrice, exitDate: s.exitDate, exitPrice: s.exitPrice,
      exitType: s.exitType, directionCorrect: s.directionCorrect, pnlPct: s.pnlPct,
      triggerAtrMult: s.triggerAtrMult, stopAtrMult: s.stopAtrMult, targetR: s.targetR, maxHoldingDays: s.maxHoldingDays,
      driver: s.driver
    }))
  };
  const jsonPath = path.join(OUT_DIR, 'signal-quality-baseline-2y.json');
  const mdPath = path.join(OUT_DIR, 'signal-quality-baseline-2y.md');
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  fs.writeFileSync(mdPath, renderMd(report), 'utf8');
  console.log(JSON.stringify({ meta: report.meta, aggregate: report.aggregate, perSymbol: report.perSymbol, anchorDistribution: report.anchorDistribution, comparison: report.comparison, jsonPath, mdPath }, null, 2));
}

if (require.main === module) main();

module.exports = { BANNED_COMBOS, isBannedCombo, loadBars, loadAnchors, makeSignal, verifySignal, simulateSymbol, aggregate, main };
