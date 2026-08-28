// experiment-line/forward-verify.cjs — G4 前向记录（第一条）
//
// 对生产 strategy-plan.json 做 T+1 语义的事后验证（执行语义派生自 V8 runner，
// 数据源升级为 GA-1 data/daily 全历史）。计划参数全部来自已冻结的 plan 字段，
// 只用信号日之后的行情路径判定触发/止损/目标 —— 前向验证，无未来函数。
//
// 用法: node experiment-line/forward-verify.cjs --runId <生产runId>
// 输出: experiment-line/results/forward/<runId>.json
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const EL = __dirname;
const { loadDaily } = require(path.join(ROOT, 'strategies', 'research', 'v2', 'falsification', 'harness-lib', 'data.cjs'));

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function mean(xs) {
  const a = xs.filter((v) => Number.isFinite(v));
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
}

function round(v, d = 4) {
  return v == null || !Number.isFinite(v) ? v : Math.round(v * 10 ** d) / 10 ** d;
}

function atr5(bars, upto) {
  const a = [];
  for (let i = upto - 4; i <= upto; i++) {
    if (i < 1 || i >= bars.length) continue;
    const b = bars[i];
    const tr = Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close));
    a.push(tr);
  }
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
}

function invalidationResolver(text, bars, idx) {
  if (!text) return null;
  const closes = bars.slice(0, idx + 1).map((b) => b.close);
  if (/m20/i.test(text)) return mean(closes.slice(-20));
  if (/m60/i.test(text)) return mean(closes.slice(-60));
  return null;
}

function verifyPlan(plan, daily, signalDate) {
  const p = plan;
  const bars = daily.dates.map((d, i) => ({ date: d, open: daily.open[i], high: daily.high[i], low: daily.low[i], close: daily.close[i] }));
  const anchorIdx = bars.findIndex((b) => b.date === signalDate);
  const base = {
    symbol: p.symbol,
    signalDate,
    direction: p.reportBaseline.direction,
    confidence: p.reportBaseline.confidence,
    matchedStrategies: (p.matchedStrategies || []).map((m) => m.strategyId),
    playbookId: p.playbook?.playbookId || null,
    executionStatus: p.executionStatus,
    triggerLevel: p.entry.triggerLevel,
    stopPrice: p.stop.stopPrice,
    triggerTiming: p.entry.triggerTiming,
    maxHoldingDays: p.riskAssessment.maxHoldingDays || 5,
    lots: p.position.lots,
  };
  if (anchorIdx === -1) return { ...base, status: 'unverifiable' };
  if (p.executionStatus !== 'executable' || p.reportBaseline.direction === 'neutral') {
    return { ...base, status: p.executionStatus === 'executable' ? 'unverifiable' : 'not_executable' };
  }
  const dir = p.reportBaseline.direction;
  const sign = dir === 'bullish' ? 1 : -1;
  const closeConfirm = /收盘/.test(p.entry.triggerTiming || '');
  const a5 = atr5(bars, anchorIdx);
  const close = bars[anchorIdx].close;
  if (anchorIdx + 1 >= bars.length) return { ...base, status: 'pending_data', atr5: round(a5, 2) };

  const t1Bar = bars[anchorIdx + 1];
  const triggered = closeConfirm
    ? (dir === 'bullish' ? t1Bar.close > p.entry.triggerLevel : t1Bar.close < p.entry.triggerLevel)
    : (dir === 'bullish' ? t1Bar.open > p.entry.triggerLevel : t1Bar.open < p.entry.triggerLevel);
  if (!triggered) return { ...base, status: 'trigger_miss', triggerVerifyDate: t1Bar.date, atr5: round(a5, 2) };

  const entryIdx = closeConfirm ? anchorIdx + 2 : anchorIdx + 1;
  if (entryIdx >= bars.length) return { ...base, status: 'triggered_pending_entry', triggerVerifyDate: t1Bar.date, atr5: round(a5, 2) };

  const entryBar = bars[entryIdx];
  const entryPrice = closeConfirm ? entryBar.open : t1Bar.open;
  const gapMul = /0\.75/.test(p.entry.execution || '') ? 0.75 : 0.5;
  const gap = Math.abs(entryPrice - p.entry.triggerLevel);
  if (gap > gapMul * a5) {
    return { ...base, status: 'gap_skip', entryDate: entryBar.date, entryPrice: round(entryPrice, 2), gap: round(gap, 2), atr5: round(a5, 2) };
  }

  const invText = p.invalidation?.hard?.[0] || '';
  const invLevel = invalidationResolver(invText, bars, entryIdx - 1);
  const stop = p.stop.stopPrice;
  const risk = Math.abs(entryPrice - stop);
  const t1 = entryPrice + sign * 2 * risk; // V8 口径：T1 = 2R（目标解析的保守下界）
  let exit = null;
  let exitType = 'time_exit';
  let exitDate = null;
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
    exit = b.close;
    exitDate = b.date;
  }
  const directionCorrect = dir === 'bullish' ? exit > entryPrice : exit < entryPrice;
  const pnlPct = dir === 'bullish' ? ((exit - entryPrice) / entryPrice) * 100 : ((entryPrice - exit) / entryPrice) * 100;
  const costPct = (0.25 * risk) / entryPrice * 100;
  return {
    ...base,
    status: 'verified',
    triggerVerifyDate: t1Bar.date,
    entryDate: bars[entryIdx].date,
    entryPrice: round(entryPrice, 2),
    exitDate,
    exitPrice: round(exit, 2),
    exitType,
    directionCorrect,
    pnlPct: round(pnlPct, 2),
    costPct: round(costPct, 2),
    netPnlPct: round(pnlPct - costPct, 2),
    atr5: round(a5, 2),
    gap: round(gap, 2),
  };
}

function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--runId');
  const runId = i >= 0 ? args[i + 1] : null;
  if (!runId) throw new Error('--runId required');

  const planFile = path.join(ROOT, 'output', 'runs', runId, 'strategy-plan.json');
  if (!fs.existsSync(planFile)) throw new Error(`production strategy-plan not found: ${planFile}`);
  const planDoc = readJson(planFile);
  const signalDate = planDoc.meta?.signalDate || null;
  const rows = [];
  for (const p of planDoc.plans || []) {
    let daily;
    try {
      daily = loadDaily(p.symbol);
    } catch (e) {
      rows.push({ symbol: p.symbol, status: 'no_daily_data', error: String(e.message || e) });
      continue;
    }
    rows.push(verifyPlan(p, daily, signalDate));
  }
  const verified = rows.filter((r) => r.status === 'verified');
  const out = {
    schema: 'futures-radar-experiment-line-forward/1',
    generatedAt: new Date().toISOString(),
    runId,
    planFile: `output/runs/${runId}/strategy-plan.json`,
    semantics: 'V8 T+1 open / T+1 close-confirm; stop-first; T1=2R; cost 0.25×risk; params frozen in plan',
    summary: {
      plans: rows.length,
      verified: verified.length,
      notExecutable: rows.filter((r) => r.status === 'not_executable').length,
      triggerMiss: rows.filter((r) => r.status === 'trigger_miss').length,
      pendingData: rows.filter((r) => ['pending_data', 'triggered_pending_entry'].includes(r.status)).length,
      gapSkip: rows.filter((r) => r.status === 'gap_skip').length,
      directionCorrectRate: verified.length ? round(verified.filter((r) => r.directionCorrect).length / verified.length * 100, 1) : null,
      avgNetPnlPct: verified.length ? round(mean(verified.map((r) => r.netPnlPct)), 2) : null,
    },
    rows,
  };
  const outDir = path.join(EL, 'results', 'forward');
  fs.mkdirSync(outDir, { recursive: true });
  writeJson(path.join(outDir, `${runId}.json`), out);
  console.log(`forward rows: ${rows.length}; verified=${out.summary.verified} pending=${out.summary.pendingData} miss=${out.summary.triggerMiss}`);
  for (const r of rows) console.log(`  ${r.symbol}: ${r.status}${r.netPnlPct != null ? ` net=${r.netPnlPct}%` : ''}`);
  return out;
}

if (require.main === module) main();
module.exports = { main, verifyPlan };
