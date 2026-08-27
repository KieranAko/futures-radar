// strategies/lib/feedback.cjs — 证伪反馈机制（v0.1.7）
//
// 闭环：
//   1. build-strategy-plan 完成后，把 executionStatus=executable 的 plan 冻结到
//      data/strategy-feedback/ledger/<runId>.json（只记录，不修改）。
//   2. 下一次运行调用 verifyPlans()：用当前可得的锚定合约 bars（contract-bars，
//      fallback 主力连续 raw.json）验证上期计划是否触发、止损/目标是否兑现。
//   3. 生成 strategy-feedback.json，由报告策略板块回显上一期证伪结果。
//
// 纪律：确定性、不联网、不调用 LLM、不新增 OI 依赖；只在验证阶段读取价格序列。
'use strict';

const fs = require('fs');
const path = require('path');
const { skillRoot, runDir } = require('../../lib/workspace.cjs');

const FEEDBACK_ROOT = path.join(skillRoot, 'data', 'strategy-feedback');
const LEDGER_DIR = path.join(FEEDBACK_ROOT, 'ledger');
const RESULTS_DIR = path.join(FEEDBACK_ROOT, 'results');
const SCHEMA = 'futures-radar-strategy-feedback/1';

function dirsFor(root) {
  const base = root || FEEDBACK_ROOT;
  return {
    base,
    ledger: path.join(base, 'ledger'),
    results: path.join(base, 'results')
  };
}

function ensureDirs(root) {
  const d = dirsFor(root);
  for (const p of [d.base, d.ledger, d.results]) fs.mkdirSync(p, { recursive: true });
}

function readJSON(p, fallback = null) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function writeJSONAtomic(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

function parseFirstNumber(text) {
  if (!text) return null;
  const paren = String(text).match(/[（(]\s*(\d+(?:\.\d+)?)\s*[)）]/);
  if (paren) return parseFloat(paren[1]);
  const m = String(text).match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}

/**
 * 冻结可执行计划。只记录 executionStatus === 'executable' 的 plan。
 */
function recordExecutablePlans(plan, now = new Date().toISOString(), rootOverride = null) {
  ensureDirs(rootOverride);
  const dirs = dirsFor(rootOverride);
  const records = [];
  for (const p of plan.plans || []) {
    if (p.executionStatus !== 'executable') continue;
    records.push({
      schema: SCHEMA,
      recordId: `${plan.meta.runId}:${p.symbol}`,
      runId: plan.meta.runId,
      signalDate: plan.meta.signalDate,
      recordedAt: now,
      symbol: p.symbol,
      name: p.name,
      contract: p.contract || null,
      direction: p.reportBaseline.direction,
      confidence: p.reportBaseline.confidence,
      strategyId: p.matchedStrategies[0] ? p.matchedStrategies[0].strategyId : 'BASE-01',
      playbookId: p.playbook.playbookId,
      entryTrigger: p.entry.trigger,
      triggerLevel: p.entry.triggerLevel,
      triggerTiming: p.entry.triggerTiming,
      stopPrice: p.stop.stopPrice,
      target1Text: p.targets.t1,
      target1Level: parseFirstNumber(p.targets.t1),
      maxHoldingDays: p.riskAssessment.maxHoldingDays || 5,
      invalidation: p.invalidation.hard || [],
      executionStatus: 'pending_verification'
    });
  }
  if (records.length > 0) {
    writeJSONAtomic(path.join(dirs.ledger, `${plan.meta.runId}.json`), records);
  }
  return records.length;
}

function loadContractBars(contract, raw) {
  // 精确：data/contract-bars/<contract>.json 中所有 run 的 bars 合并（同日后者覆盖）
  const p = path.join(skillRoot, 'data', 'contract-bars', `${contract}.json`);
  const wrapper = readJSON(p);
  const map = new Map();
  if (wrapper && wrapper.runs) {
    const runIds = Object.keys(wrapper.runs).sort();
    for (const rid of runIds) {
      const bars = wrapper.runs[rid] && wrapper.runs[rid].bars;
      if (!Array.isArray(bars)) continue;
      for (const b of bars) {
        if (b && b.date) map.set(b.date, b);
      }
    }
  }
  const bars = [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
  if (bars.length >= 2) return { source: 'contract-bars', bars };
  // fallback：当前 run raw.json 的主力连续（代理口径，必须标注）
  const c = raw && raw.contracts && raw.contracts[Object.keys(raw.contracts).find(s => s === null)];
  return { source: null, bars: [] };
}

function barsForSymbol(raw, symbol) {
  const c = raw && raw.contracts && raw.contracts[symbol];
  if (!c || !c.ohlcv || !Array.isArray(c.ohlcv.dates)) return { source: 'main-continuous-proxy', bars: [] };
  const o = c.ohlcv;
  const bars = [];
  for (let i = 0; i < o.dates.length; i++) {
    bars.push({
      date: o.dates[i], open: o.open[i], high: o.high[i], low: o.low[i], close: o.close[i]
    });
  }
  return { source: 'main-continuous-proxy', bars };
}

function verifyRecord(record, raw, currentRunId) {
  const exact = record.contract ? loadContractBars(record.contract, raw) : { source: null, bars: [] };
  const series = exact.bars.length >= 2 ? exact : barsForSymbol(raw, record.symbol);
  const bars = series.bars;
  const tIdx = bars.findIndex(b => b.date === record.signalDate);
  if (tIdx === -1) {
    return {
      recordId: record.recordId, status: 'unverifiable',
      attribution: [{ code: 'signal_date_missing', detail: `序列中找不到信号日 ${record.signalDate}` }],
      verificationSeries: series.source
    };
  }
  if (tIdx + 1 >= bars.length) {
    return { recordId: record.recordId, status: 'pending_data', verificationSeries: series.source };
  }

  // 触发只在 T+1 判定：收盘确认型取 T+1 close，开盘执行型取 T+1 open
  const t1 = bars[tIdx + 1];
  const closeConfirm = /收盘/.test(record.triggerTiming || '');
  const triggerLevel = record.triggerLevel;
  let triggered = false;
  if (closeConfirm) {
    triggered = record.direction === 'bullish' ? t1.close > triggerLevel : t1.close < triggerLevel;
  } else {
    triggered = record.direction === 'bullish' ? t1.open > triggerLevel : t1.open < triggerLevel;
  }
  if (!triggered) {
    return {
      recordId: record.recordId, status: 'invalidated_not_triggered',
      signalDate: record.signalDate, verifyDate: t1.date, verificationSeries: series.source,
      attribution: [{ code: 'trigger_miss', detail: `T+1 未触发入场（${record.direction} 触发价 ${triggerLevel}），计划按契约作废` }]
    };
  }

  // 确认后下一交易日开盘执行
  if (tIdx + 2 >= bars.length) {
    return { recordId: record.recordId, status: 'triggered_pending_entry', verifyDate: t1.date, verificationSeries: series.source };
  }
  const entryBar = bars[tIdx + 2];
  const entryPrice = entryBar.open;
  const gapThreshold = (record.stopPrice && record.stopPrice !== record.triggerLevel)
    ? Math.abs(record.stopPrice - record.triggerLevel) * 0.5
    : null;
  const gapPts = Math.abs(entryPrice - (record.triggerLevel || entryPrice));
  if (gapThreshold && gapPts > gapThreshold) {
    return {
      recordId: record.recordId, status: 'skipped_gap', verifyDate: entryBar.date, entryPrice, verificationSeries: series.source,
      attribution: [{ code: 'gap_skip', detail: `跳空 ${gapPts.toFixed(1)} > ${gapThreshold.toFixed(1)}（0.75×ATR5 约束），放弃执行` }]
    };
  }

  // 模拟持有：先检查止损与目标1；最长持有到 maxHoldingDays
  const maxEnd = Math.min(bars.length - 1, tIdx + 2 + record.maxHoldingDays);
  let exit = null;
  let exitType = 'time_exit';
  let exitDate = null;
  const stop = record.stopPrice;
  let target1 = record.target1Level;
  // R 口径目标（如 "2R 平 50%"）需按风险距离换算成实际价位
  if (target1 != null && stop != null && /R/.test(record.target1Text || '')) {
    const sign = record.direction === 'bullish' ? 1 : -1;
    target1 = entryPrice + sign * target1 * (entryPrice - stop);
  }
  for (let i = tIdx + 2; i <= maxEnd; i++) {
    const b = bars[i];
    if (record.direction === 'bullish') {
      if (stop != null && b.low <= stop) { exit = stop; exitType = 'stopped_out'; exitDate = b.date; break; }
      if (target1 != null && b.high >= target1) { exit = target1; exitType = 'target1_hit'; exitDate = b.date; break; }
    } else {
      if (stop != null && b.high >= stop) { exit = stop; exitType = 'stopped_out'; exitDate = b.date; break; }
      if (target1 != null && b.low <= target1) { exit = target1; exitType = 'target1_hit'; exitDate = b.date; break; }
    }
    exit = b.close;
    exitType = 'time_exit';
    exitDate = b.date;
  }

  const directionCorrect = record.direction === 'bullish' ? exit > entryPrice : exit < entryPrice;
  const attribution = [];
  if (exitType === 'stopped_out') attribution.push({ code: 'stop_hit', detail: `止损 ${stop} 被触发；需归因：止损过紧 / 方向错误 / 事件冲击` });
  if (exitType === 'target1_hit') attribution.push({ code: 'target1_hit', detail: `第一目标 ${target1} 兑现` });
  if (!directionCorrect) attribution.push({ code: 'direction_wrong', detail: `实际方向与报告方向相反（entry=${entryPrice}, exit=${exit}）` });
  else attribution.push({ code: 'direction_correct', detail: `实际方向与报告方向一致（entry=${entryPrice}, exit=${exit}）` });

  return {
    recordId: record.recordId,
    status: 'verified',
    signalDate: record.signalDate,
    verifyDate: entryBar.date,
    entryDate: entryBar.date,
    exitDate,
    entryPrice,
    exitPrice: exit,
    exitType,
    stoppedOut: exitType === 'stopped_out',
    target1Hit: exitType === 'target1_hit',
    directionCorrect,
    verificationSeries: series.source,
    attribution
  };
}

/**
 * 验证所有尚未验证的 pending 计划。返回 { meta, results }。
 */
function verifyPlans(currentRunId, raw, rootOverride = null) {
  ensureDirs(rootOverride);
  const dirs = dirsFor(rootOverride);
  const results = [];
  const verifiedIds = new Set();
  const current = new Date().toISOString();
  if (fs.existsSync(dirs.ledger)) {
    for (const f of fs.readdirSync(dirs.ledger).sort()) {
      if (!f.endsWith('.json')) continue;
      const records = readJSON(path.join(dirs.ledger, f), []);
      for (const rec of records) {
        if (rec.runId === currentRunId) continue; // 当期只记录，下期验证
        const res = verifyRecord(rec, raw, currentRunId);
        res.verifiedRunId = currentRunId;
        results.push(res);
        if (res.status !== 'pending_data') verifiedIds.add(rec.recordId);
      }
    }
  }
  const out = {
    schema: SCHEMA,
    meta: {
      currentRunId,
      verifiedAt: current,
      pendingBefore: results.filter(r => r.status === 'pending_data').length,
      verified: results.filter(r => r.status !== 'pending_data').length
    },
    results
  };
  writeJSONAtomic(path.join(dirs.results, `${currentRunId}.json`), out);
  return out;
}

/**
 * 用截断到 signalDate 的 bars 构造一个可证伪计划（回测/测试用）。
 * 只允许读取 bars[0..signalIdx]，禁止任何未来数据。
 */
function buildHistoricalPlan(bars, signalDate, opts = {}) {
  const idx = bars.findIndex(b => b.date === signalDate);
  if (idx < 5) throw new Error(`buildHistoricalPlan: signalDate ${signalDate} needs at least 6 bars`);
  const slice = bars.slice(0, idx + 1);
  const closes = slice.map(b => b.close);
  const highs = slice.map(b => b.high);
  const lows = slice.map(b => b.low);
  let trs = [];
  for (let i = 1; i < slice.length; i++) {
    trs.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  }
  const atr5 = trs.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const ma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, closes.length);
  const close = closes[closes.length - 1];
  const direction = opts.direction || (close >= ma20 ? 'bullish' : 'bearish');
  const sign = direction === 'bullish' ? 1 : -1;
  const triggerLevel = parseFloat((close + sign * 0.5 * atr5).toFixed(1));
  const stopPrice = parseFloat((close - sign * 1.5 * atr5).toFixed(1));
  const target1 = parseFloat((close + sign * 2 * atr5).toFixed(1));
  return {
    signalDate,
    direction,
    close,
    atr5: parseFloat(atr5.toFixed(2)),
    ma20: parseFloat(ma20.toFixed(2)),
    triggerLevel,
    stopPrice,
    target1Level: target1,
    target1Text: `${target1}（回测目标）`,
    triggerTiming: 'T+1 收盘确认；确认后下一交易日开盘执行'
  };
}

module.exports = { recordExecutablePlans, verifyPlans, parseFirstNumber, buildHistoricalPlan };
