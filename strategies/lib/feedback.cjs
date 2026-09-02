// strategies/lib/feedback.cjs — 证伪反馈机制（v0.2.0）
//
// 闭环（全策略证伪 + 增量验证）：
//   1. build-strategy-plan 完成后，把本期生成的【全部】策略（executable/watch/skip）
//      冻结到 data/strategy-feedback/ledger/<runId>.json（append-only，不修改）。
//   2. 验证状态存于 data/strategy-feedback/verifications.json：
//      - 终态记录不再重复验证；
//      - 每次 run 只对非终态记录做增量验证；
//      - 汇总统计从状态库聚合，展示全部历史的真实状态。
//   3. 生成 strategy-feedback.json（近 3 期明细 + 历史全量汇总），由报告策略板块回显。
//
// 纪律：确定性、不联网、不调用 LLM、不新增 OI 依赖；只在验证阶段读取价格序列。
'use strict';

const fs = require('fs');
const path = require('path');
const { skillRoot, runtimeRoot } = require('../../lib/workspace.cjs');

// 生产默认落在 skill/data/strategy-feedback；实验线镜像（FUTURES_RUNTIME_ROOT 覆盖）落到实验线根，
// 避免 mirror replay 污染生产证伪状态库。
const FEEDBACK_ROOT = process.env.FUTURES_RUNTIME_ROOT
  ? path.join(runtimeRoot, 'data', 'strategy-feedback')
  : path.join(skillRoot, 'data', 'strategy-feedback');
const LEDGER_DIR = path.join(FEEDBACK_ROOT, 'ledger');
const RESULTS_DIR = path.join(FEEDBACK_ROOT, 'results');
const SCHEMA = 'futures-radar-strategy-feedback/1';
const FEEDBACK_SCHEMA_V2 = 'futures-radar-strategy-feedback/2';
const STATE_SCHEMA = 'futures-radar-strategy-verification-state/1';

const TERMINAL_STATUSES = new Set(['verified', 'invalidated_not_triggered', 'skipped_gap', 'unverifiable', 'confirmed']);
const NON_TERMINAL_STATUSES = ['pending_verification', 'pending_data', 'triggered_pending_entry'];

function dirsFor(root) {
  const base = root || FEEDBACK_ROOT;
  return {
    base,
    ledger: path.join(base, 'ledger'),
    results: path.join(base, 'results')
  };
}

function statePath(root) {
  return path.join((root || FEEDBACK_ROOT), 'verifications.json');
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
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
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

function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(status);
}

function deriveSignalDirection(text) {
  const s = String(text || '');
  if (/多头|看多|上涨|上方|突破/.test(s)) return 'bullish';
  if (/空头|看空|下跌|下方|跌破/.test(s)) return 'bearish';
  return null;
}

/**
 * 从 strategy-plan.json 的一条 plan 构建证伪记录。
 * 全策略口径：executable / watch / skip 均记录。
 * 中性方向（无真实交易方向）使用 signal 验证模式，只验证确认信号是否兑现。
 */
function recordFromPlan(plan, p) {
  const direction = (p.reportBaseline && p.reportBaseline.direction) || 'neutral';
  const mode = direction === 'neutral' ? 'signal' : 'trade';
  const triggerText = [
    p.entry && p.entry.trigger,
    p.entry && p.entry.triggerSource,
    p.reportBaseline && Array.isArray(p.reportBaseline.confirmSignals) ? p.reportBaseline.confirmSignals.join(' ') : ''
  ].filter(Boolean).join(' ');
  const signalDirection = mode === 'signal' ? deriveSignalDirection(triggerText) : null;

  let triggerTiming = (p.entry && p.entry.triggerTiming) || '';
  if (mode === 'signal' && (!triggerTiming || /无执行时点|仅观察/.test(triggerTiming))) {
    triggerTiming = (p.entry && p.entry.execution)
      || (p.playbook && p.playbook.executionConvention)
      || 'T+1 收盘确认；确认后下一交易日开盘执行';
  }
  if (!triggerTiming) triggerTiming = 'T+1 收盘确认；确认后下一交易日开盘执行';

  return {
    schema: STATE_SCHEMA,
    recordId: `${plan.meta.runId}:${p.symbol}`,
    runId: plan.meta.runId,
    signalDate: plan.meta.signalDate,
    recordedAt: null,
    rank: p.rank == null ? null : p.rank,
    symbol: p.symbol,
    name: p.name || p.symbol,
    contract: p.contract || null,
    direction,
    verificationMode: mode,
    signalDirection,
    executionStatus: p.executionStatus || 'watch',
    plannedLots: p.position && p.position.lots != null ? p.position.lots : null,
    confidence: p.reportBaseline && p.reportBaseline.confidence ? p.reportBaseline.confidence : 'low',
    strategyId: p.matchedStrategies && p.matchedStrategies[0] ? p.matchedStrategies[0].strategyId : 'BASE-01',
    playbookId: p.playbook && p.playbook.playbookId ? p.playbook.playbookId : 'PB-01',
    entryTrigger: (p.entry && p.entry.trigger) || '',
    triggerLevel: p.entry && Number.isFinite(Number(p.entry.triggerLevel)) ? Number(p.entry.triggerLevel) : null,
    triggerTiming,
    stopPrice: p.stop && Number.isFinite(Number(p.stop.stopPrice)) ? Number(p.stop.stopPrice) : null,
    target1Text: (p.targets && p.targets.t1) || '',
    target1Level: parseFirstNumber(p.targets && p.targets.t1),
    maxHoldingDays: p.riskAssessment && p.riskAssessment.maxHoldingDays ? p.riskAssessment.maxHoldingDays : 5,
    invalidation: p.invalidation && Array.isArray(p.invalidation.hard) ? p.invalidation.hard : [],
    status: 'pending_verification',
    terminal: false,
    lastVerifiedRunId: null,
    lastResult: null
  };
}

/**
 * 旧账本格式中 executionStatus 存的是验证执行状态（pending_verification），
 * 不是计划执行状态（executable/watch/skip）；历史旧记录只可能来自 executable 计划。
 */
function legacyPlanExecutionStatus(value) {
  const verificationStatuses = new Set([
    ...NON_TERMINAL_STATUSES, ...TERMINAL_STATUSES
  ]);
  return verificationStatuses.has(value) ? 'executable' : (value || 'executable');
}

/**
 * 把旧账本记录（可能没有 executionStatus/verificationMode）规范化为状态记录。
 */
function normalizeLedgerRecord(rec) {
  const direction = rec.direction || 'neutral';
  const mode = rec.verificationMode || (direction === 'neutral' ? 'signal' : 'trade');
  const status = rec.status || 'pending_verification';
  return {
    schema: STATE_SCHEMA,
    recordId: rec.recordId || `${rec.runId}:${rec.symbol}`,
    runId: rec.runId,
    signalDate: rec.signalDate,
    recordedAt: rec.recordedAt || null,
    rank: rec.rank == null ? null : rec.rank,
    symbol: rec.symbol,
    name: rec.name || rec.symbol,
    contract: rec.contract || null,
    direction,
    verificationMode: mode,
    signalDirection: rec.signalDirection != null
      ? rec.signalDirection
      : (mode === 'signal' ? deriveSignalDirection(`${rec.entryTrigger || ''} ${rec.invalidation || ''}`) : null),
    executionStatus: legacyPlanExecutionStatus(rec.executionStatus),
    plannedLots: rec.plannedLots != null ? rec.plannedLots : null,
    confidence: rec.confidence || 'medium',
    strategyId: rec.strategyId || 'BASE-01',
    playbookId: rec.playbookId || 'PB-01',
    entryTrigger: rec.entryTrigger || rec.trigger || '',
    triggerLevel: Number.isFinite(Number(rec.triggerLevel)) ? Number(rec.triggerLevel) : null,
    triggerTiming: rec.triggerTiming || 'T+1 收盘确认；确认后下一交易日开盘执行',
    stopPrice: Number.isFinite(Number(rec.stopPrice)) ? Number(rec.stopPrice) : null,
    target1Text: rec.target1Text || '',
    target1Level: Number.isFinite(Number(rec.target1Level)) ? Number(rec.target1Level) : parseFirstNumber(rec.target1Text),
    maxHoldingDays: rec.maxHoldingDays || 5,
    invalidation: Array.isArray(rec.invalidation) ? rec.invalidation : [],
    status,
    terminal: rec.terminal === true || isTerminalStatus(status),
    lastVerifiedRunId: rec.lastVerifiedRunId || rec.verifiedRunId || null,
    lastResult: rec.lastResult || null
  };
}

/**
 * 记录本期生成的【全部】策略（executable/watch/skip）。
 * 账本保持 append-only；状态库由 verifyIncremental 统一同步。
 */
function recordPlans(plan, now = new Date().toISOString(), rootOverride = null) {
  ensureDirs(rootOverride);
  const d = dirsFor(rootOverride);
  const records = (plan.plans || []).map((p) => {
    const rec = recordFromPlan(plan, p);
    rec.recordedAt = now;
    return rec;
  });
  if (records.length > 0) {
    writeJSONAtomic(path.join(d.ledger, `${plan.meta.runId}.json`), records);
  }
  return records.length;
}

// 旧名保留（语义已升级为“记录全部策略”，不再只记录 executable）
const recordExecutablePlans = recordPlans;

function loadState(rootOverride = null) {
  ensureDirs(rootOverride);
  const p = statePath(rootOverride);
  const state = readJSON(p, null);
  if (state && state.schema === STATE_SCHEMA && state.records && typeof state.records === 'object') {
    if (state.runsScanned !== true) state.runsScanned = false;
    return state;
  }
  return {
    schema: STATE_SCHEMA,
    updatedRunId: null,
    updatedAt: null,
    runsScanned: false,
    records: {}
  };
}

function saveState(state, rootOverride = null) {
  ensureDirs(rootOverride);
  writeJSONAtomic(statePath(rootOverride), state);
}

function fillMissingStateFields(target, source) {
  for (const k of ['recordedAt', 'rank', 'name', 'contract', 'direction', 'verificationMode', 'signalDirection',
    'executionStatus', 'plannedLots', 'confidence', 'strategyId', 'playbookId', 'entryTrigger',
    'triggerLevel', 'triggerTiming', 'stopPrice', 'target1Text', 'target1Level', 'maxHoldingDays', 'invalidation']) {
    if (target[k] === undefined || target[k] === null) target[k] = source[k];
  }
  if (target.terminal !== true && isTerminalStatus(target.status)) target.terminal = true;
}

/**
 * strategy-plan 是计划层字段的权威来源；历史迁移时覆盖计划字段，
 * 但绝不覆盖验证状态（status/terminal/lastResult/lastVerifiedRunId）。
 */
function applyPlanFields(target, source) {
  for (const k of ['recordedAt', 'rank', 'name', 'contract', 'direction', 'verificationMode', 'signalDirection',
    'executionStatus', 'plannedLots', 'confidence', 'strategyId', 'playbookId', 'entryTrigger',
    'triggerLevel', 'triggerTiming', 'stopPrice', 'target1Text', 'target1Level', 'maxHoldingDays', 'invalidation']) {
    target[k] = source[k];
  }
}

/**
 * 把账本中尚未进入状态库的记录同步进去（只补缺，不覆盖验证状态）。
 */
function syncLedgersIntoState(state, rootOverride = null) {
  const d = dirsFor(rootOverride);
  if (!fs.existsSync(d.ledger)) return state;
  for (const f of fs.readdirSync(d.ledger).sort()) {
    if (!f.endsWith('.json')) continue;
    const records = readJSON(path.join(d.ledger, f), []);
    if (!Array.isArray(records)) continue;
    for (const rec of records) {
      if (!rec || !rec.runId || !rec.symbol) continue;
      const id = rec.recordId || `${rec.runId}:${rec.symbol}`;
      if (!state.records[id]) {
        state.records[id] = normalizeLedgerRecord(rec);
      } else {
        fillMissingStateFields(state.records[id], normalizeLedgerRecord(rec));
      }
    }
  }
  return state;
}

/**
 * 一次性迁移：扫描历史 run 的 strategy-plan.json，把 executable/watch/skip 全部纳入状态库。
 * 只在默认文件库执行一次（测试/试点使用 rootOverride 时不触发）。
 */
function migrateRunPlansIntoState(state, rootOverride = null) {
  if (rootOverride || process.env.FUTURES_RUNTIME_ROOT || state.runsScanned === true) return state;
  const runsRoot = path.join(skillRoot, 'output', 'runs');
  if (!fs.existsSync(runsRoot)) {
    state.runsScanned = true;
    return state;
  }
  const d = dirsFor(null);
  for (const name of fs.readdirSync(runsRoot).sort()) {
    const planFile = path.join(runsRoot, name, 'strategy-plan.json');
    if (!fs.existsSync(planFile)) continue;
    let plan = null;
    try { plan = JSON.parse(fs.readFileSync(planFile, 'utf8')); } catch { continue; }
    const runId = (plan.meta && plan.meta.runId) || name;
    if (!runId || !Array.isArray(plan.plans)) continue;
    const records = plan.plans.map((p) => {
      const rec = recordFromPlan(plan, p);
      rec.recordedAt = plan.meta && plan.meta.generatedAt ? plan.meta.generatedAt : null;
      return rec;
    });
    for (const rec of records) {
      if (!state.records[rec.recordId]) state.records[rec.recordId] = rec;
      else applyPlanFields(state.records[rec.recordId], rec);
    }
    // 把历史账本升级为全策略账本（原账本可能只含 executable）
    const ledgerPath = path.join(d.ledger, `${runId}.json`);
    const existing = readJSON(ledgerPath, []);
    const existingIds = new Set((Array.isArray(existing) ? existing : []).map((r) => r.recordId || `${r.runId}:${r.symbol}`));
    const missing = records.filter((r) => !existingIds.has(r.recordId));
    if (missing.length > 0) {
      const merged = [...(Array.isArray(existing) ? existing : []), ...missing];
      writeJSONAtomic(ledgerPath, merged);
    }
  }
  state.runsScanned = true;
  return state;
}

function loadContractBars(contract, raw) {
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
  return { source: null, bars: [] };
}

function barsForSymbol(raw, symbol) {
  const c = raw && raw.contracts && raw.contracts[symbol];
  if (!c || !c.ohlcv || !Array.isArray(c.ohlcv.dates)) return { source: 'main-continuous-proxy', bars: [] };
  const o = c.ohlcv;
  const bars = [];
  for (let i = 0; i < o.dates.length; i++) {
    bars.push({
      date: o.dates[i], open: o.open[i], high: o.high[i], low: o.low[i], close: o.close[i],
      volume: Array.isArray(o.volume) ? o.volume[i] : null
    });
  }
  return { source: 'main-continuous-proxy', bars };
}

function barsForRecord(record, raw, cache) {
  const key = record.contract ? `contract:${record.contract}` : `symbol:${record.symbol}`;
  if (!cache.has(key)) {
    const exact = record.contract ? loadContractBars(record.contract, raw) : { source: null, bars: [] };
    const exactHasSignalDate = exact.bars.some((b) => b && b.date === record.signalDate);
    // 具体合约序列缺失信号日时回退主力连续代理，避免把“可验证”误判为 unverifiable
    const chosen = exact.bars.length >= 2 && exactHasSignalDate ? exact : barsForSymbol(raw, record.symbol);
    cache.set(key, chosen);
  }
  return cache.get(key);
}

function findSignalIndex(bars, signalDate) {
  return bars.findIndex((b) => b.date === signalDate);
}

/**
 * 交易模式验证：与旧逻辑同口径（T+1 触发 → 跳空/止损/目标/时间退出）。
 */
function verifyTradeRecord(record, raw, currentRunId, cache) {
  const series = barsForRecord(record, raw, cache);
  const bars = series.bars;
  const tIdx = findSignalIndex(bars, record.signalDate);
  if (tIdx === -1) {
    return {
      recordId: record.recordId, status: 'unverifiable', signalDate: record.signalDate,
      attribution: [{ code: 'signal_date_missing', detail: `序列中找不到信号日 ${record.signalDate}` }],
      verificationSeries: series.source
    };
  }
  if (tIdx + 1 >= bars.length) {
    return { recordId: record.recordId, status: 'pending_data', signalDate: record.signalDate, verificationSeries: series.source };
  }

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

  if (tIdx + 2 >= bars.length) {
    return {
      recordId: record.recordId, status: 'triggered_pending_entry',
      signalDate: record.signalDate, verifyDate: t1.date, verificationSeries: series.source
    };
  }
  const entryBar = bars[tIdx + 2];
  const entryPrice = entryBar.open;
  const gapThreshold = (record.stopPrice != null && record.stopPrice !== record.triggerLevel)
    ? Math.abs(record.stopPrice - record.triggerLevel) * 0.5
    : null;
  const gapPts = Math.abs(entryPrice - (record.triggerLevel || entryPrice));
  if (gapThreshold && gapPts > gapThreshold) {
    return {
      recordId: record.recordId, status: 'skipped_gap', signalDate: record.signalDate,
      verifyDate: entryBar.date, entryPrice, verificationSeries: series.source,
      attribution: [{ code: 'gap_skip', detail: `跳空 ${gapPts.toFixed(1)} > ${gapThreshold.toFixed(1)}（0.75×ATR5 约束），放弃执行` }]
    };
  }

  const maxEnd = Math.min(bars.length - 1, tIdx + 2 + record.maxHoldingDays);
  let exit = null;
  let exitType = 'time_exit';
  let exitDate = null;
  const stop = record.stopPrice;
  const sign = record.direction === 'bullish' ? 1 : -1;
  let target1 = null;
  const tText = record.target1Text || '';
  const priceMatch = tText.match(/(\d{3,}(?:\.\d+)?)/);
  const rMatch = tText.match(/(\d+(?:\.\d+)?)\s*R/);
  if (priceMatch) {
    target1 = parseFloat(priceMatch[1]);
  } else if (rMatch && stop != null) {
    target1 = entryPrice + sign * parseFloat(rMatch[1]) * (entryPrice - stop);
  } else if (stop != null) {
    target1 = entryPrice + sign * 2 * (entryPrice - stop);
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
 * 信号模式验证：中性观察策略只验证“确认信号是否在观察窗口内兑现”。
 * 触发条件命中 → confirmed（证伪失败，策略成立）；窗口内未触发 → invalidated_not_triggered。
 */
function verifySignalRecord(record, raw, currentRunId, cache) {
  const series = barsForRecord(record, raw, cache);
  const bars = series.bars;
  const tIdx = findSignalIndex(bars, record.signalDate);
  if (tIdx === -1) {
    return {
      recordId: record.recordId, status: 'unverifiable', signalDate: record.signalDate,
      attribution: [{ code: 'signal_date_missing', detail: `序列中找不到信号日 ${record.signalDate}` }],
      verificationSeries: series.source
    };
  }
  if (record.triggerLevel == null || !record.signalDirection) {
    return {
      recordId: record.recordId, status: 'unverifiable', signalDate: record.signalDate,
      attribution: [{ code: 'signal_direction_missing', detail: '中性观察策略缺少可解析的确认方向或触发价' }],
      verificationSeries: series.source
    };
  }
  if (tIdx + 1 >= bars.length) {
    return { recordId: record.recordId, status: 'pending_data', signalDate: record.signalDate, verificationSeries: series.source };
  }

  const dir = record.signalDirection;
  const closeConfirm = /收盘/.test(`${record.triggerTiming || ''} ${record.entryTrigger || ''}`);
  const window = record.maxHoldingDays || 5;
  const fullWindowEnd = Math.min(bars.length - 1, tIdx + 1 + window);
  const availableEnd = bars.length - 1;
  for (let i = tIdx + 1; i <= availableEnd; i++) {
    const b = bars[i];
    const fired = closeConfirm
      ? (dir === 'bullish' ? b.close > record.triggerLevel : b.close < record.triggerLevel)
      : (dir === 'bullish' ? b.open > record.triggerLevel : b.open < record.triggerLevel);
    if (fired) {
      return {
        recordId: record.recordId, status: 'confirmed', signalDate: record.signalDate,
        verifyDate: b.date, verificationSeries: series.source,
        attribution: [{ code: 'confirmation_hit', detail: `确认信号兑现（${dir === 'bullish' ? '多头' : '空头'}，触发价 ${record.triggerLevel}）` }]
      };
    }
  }
  if (availableEnd >= fullWindowEnd) {
    return {
      recordId: record.recordId, status: 'invalidated_not_triggered', signalDate: record.signalDate,
      verifyDate: bars[fullWindowEnd].date, verificationSeries: series.source,
      attribution: [{ code: 'confirmation_miss', detail: `${window} 日观察窗口内未触发确认信号，观察策略作废` }]
    };
  }
  return { recordId: record.recordId, status: 'pending_data', signalDate: record.signalDate, verificationSeries: series.source };
}

function verifyRecord(record, raw, currentRunId, cache) {
  if (record.verificationMode === 'signal' || record.direction === 'neutral') {
    return verifySignalRecord(record, raw, currentRunId, cache);
  }
  return verifyTradeRecord(record, raw, currentRunId, cache);
}

function buildSummary(state) {
  const byExecutionStatus = { executable: 0, watch: 0, skip: 0 };
  const byStatus = {};
  for (const s of [...NON_TERMINAL_STATUSES, ...TERMINAL_STATUSES]) byStatus[s] = 0;
  const trade = {
    total: 0, terminal: 0, pending: 0, verified: 0, invalidatedNotTriggered: 0,
    skippedGap: 0, unverifiable: 0, stoppedOut: 0, target1Hit: 0, timeExit: 0,
    directionCorrect: 0, directionWrong: 0
  };
  const signal = { total: 0, terminal: 0, pending: 0, confirmed: 0, invalidatedNotTriggered: 0, unverifiable: 0 };

  for (const rec of Object.values(state.records || {})) {
    const exec = byExecutionStatus[rec.executionStatus] != null ? rec.executionStatus : 'watch';
    byExecutionStatus[exec] = (byExecutionStatus[exec] || 0) + 1;
    byStatus[rec.status] = (byStatus[rec.status] || 0) + 1;
    const mode = rec.verificationMode === 'signal' ? 'signal' : 'trade';
    const m = mode === 'signal' ? signal : trade;
    m.total++;
    if (rec.terminal) m.terminal++; else m.pending++;

    if (rec.status === 'verified') {
      trade.verified++;
      const r = rec.lastResult || {};
      if (r.exitType === 'stopped_out') trade.stoppedOut++;
      else if (r.exitType === 'target1_hit') trade.target1Hit++;
      else trade.timeExit++;
      if (r.directionCorrect === true) trade.directionCorrect++;
      else if (r.directionCorrect === false) trade.directionWrong++;
    } else if (rec.status === 'invalidated_not_triggered') {
      m.invalidatedNotTriggered++;
    } else if (rec.status === 'skipped_gap') {
      trade.skippedGap++;
    } else if (rec.status === 'unverifiable') {
      m.unverifiable++;
    } else if (rec.status === 'confirmed') {
      signal.confirmed++;
    }
  }

  const totalPlans = Object.keys(state.records || {}).length;
  const terminalPlans = trade.terminal + signal.terminal;
  const pendingPlans = trade.pending + signal.pending;
  const verifiedWithOutcome = trade.verified;
  const directionDenominator = trade.directionCorrect + trade.directionWrong;
  const directionCorrectPct = directionDenominator > 0
    ? Math.round((trade.directionCorrect / directionDenominator) * 1000) / 10
    : null;

  return {
    totalPlans,
    terminalPlans,
    pendingPlans,
    byExecutionStatus,
    byStatus,
    byMode: { trade, signal },
    verifiedWithOutcome,
    directionDenominator,
    directionCorrectPct
  };
}

function buildRecentRuns(state, limit = 3) {
  const byRun = new Map();
  for (const rec of Object.values(state.records || {})) {
    if (!byRun.has(rec.runId)) byRun.set(rec.runId, []);
    byRun.get(rec.runId).push(rec);
  }
  const allRunIds = [...byRun.keys()].sort((a, b) => b.localeCompare(a));
  const productionRunIds = allRunIds.filter((r) => /^\d{8}-\d{4}-auto$/.test(r));
  // 明细只展示生产 run；实验线 mirror 等记录仍进入全量统计
  const runIds = (productionRunIds.length > 0 ? productionRunIds : allRunIds).slice(0, limit);
  return runIds.map((runId) => {
    const rows = byRun.get(runId)
      .slice()
      .sort((a, b) => (a.rank == null ? 99 : a.rank) - (b.rank == null ? 99 : b.rank) || a.symbol.localeCompare(b.symbol))
      .map((rec) => ({
        recordId: rec.recordId,
        symbol: rec.symbol,
        name: rec.name,
        rank: rec.rank,
        executionStatus: rec.executionStatus,
        plannedLots: rec.plannedLots,
        direction: rec.direction,
        confidence: rec.confidence,
        strategyId: rec.strategyId,
        playbookId: rec.playbookId,
        signalDate: rec.signalDate,
        verificationMode: rec.verificationMode,
        status: rec.status,
        terminal: rec.terminal,
        lastResult: rec.lastResult
      }));
    return { runId, signalDate: rows[0] ? rows[0].signalDate : null, rows };
  });
}

function buildFeedbackView(state, currentRunId, extras = {}) {
  return {
    schema: FEEDBACK_SCHEMA_V2,
    meta: {
      currentRunId,
      verifiedAt: new Date().toISOString(),
      recordedThisRun: extras.recordedThisRun == null ? 0 : extras.recordedThisRun,
      incrementalAttempted: extras.incrementalAttempted || 0,
      incrementalTransitioned: extras.incrementalTransitioned || 0,
      totalPlans: extras.summary ? extras.summary.totalPlans : 0,
      terminalPlans: extras.summary ? extras.summary.terminalPlans : 0,
      pendingPlans: extras.summary ? extras.summary.pendingPlans : 0
    },
    recentRuns: buildRecentRuns(state, 3),
    summary: extras.summary || buildSummary(state)
  };
}

/**
 * 增量验证：只对非终态记录做一次验证，终态历史永不重算。
 * 返回新版 strategy-feedback.json 结构（近 3 期明细 + 全量汇总）。
 */
function verifyIncremental(currentRunId, raw, rootOverride = null) {
  ensureDirs(rootOverride);
  const state = loadState(rootOverride);
  syncLedgersIntoState(state, rootOverride);
  migrateRunPlansIntoState(state, rootOverride);
  const cache = new Map();
  let attempted = 0;
  let transitioned = 0;
  for (const rec of Object.values(state.records)) {
    if (rec.terminal) continue;
    if (rec.runId === currentRunId) continue; // 本期只记录，下期开始验证
    attempted++;
    const wasTerminal = rec.terminal === true;
    const result = verifyRecord(rec, raw, currentRunId, cache);
    rec.status = result.status;
    rec.terminal = isTerminalStatus(result.status);
    rec.lastResult = result;
    rec.lastVerifiedRunId = currentRunId;
    if (!wasTerminal && rec.terminal) transitioned++;
  }
  state.updatedRunId = currentRunId;
  state.updatedAt = new Date().toISOString();
  saveState(state, rootOverride);
  const summary = buildSummary(state);
  return buildFeedbackView(state, currentRunId, {
    recordedThisRun: extrasCountRecorded(state, currentRunId),
    incrementalAttempted: attempted,
    incrementalTransitioned: transitioned,
    summary
  });
}

function extrasCountRecorded(state, currentRunId) {
  return Object.values(state.records || {}).filter((r) => r.runId === currentRunId).length;
}

/**
 * 兼容旧接口：返回 old-shape { meta, results }，供回测/旧测试继续使用。
 * 内部仍走增量验证；results 从状态库聚合（不重新做 bar 验证）。
 */
function verifyPlans(currentRunId, raw, rootOverride = null) {
  const view = verifyIncremental(currentRunId, raw, rootOverride);
  const state = loadState(rootOverride);
  const results = Object.values(state.records).map((rec) => {
    const base = {
      recordId: rec.recordId,
      signalDate: rec.signalDate,
      symbol: rec.symbol,
      name: rec.name || rec.symbol,
      strategyId: rec.strategyId,
      playbookId: rec.playbookId,
      direction: rec.direction,
      confidence: rec.confidence,
      verificationSeries: rec.lastResult && rec.lastResult.verificationSeries ? rec.lastResult.verificationSeries : null
    };
    return { ...(rec.lastResult || {}), ...base, status: rec.status };
  });
  return {
    schema: SCHEMA,
    meta: {
      currentRunId,
      verifiedAt: view.meta.verifiedAt,
      pendingBefore: results.filter((r) => r.status === 'pending_data').length,
      verified: results.filter((r) => r.status !== 'pending_data').length
    },
    results
  };
}

/**
 * 用截断到 signalDate 的 bars 构造一个可证伪计划（回测/测试用）。
 * 只允许读取 bars[0..signalIdx]，禁止任何未来数据。
 */
function buildHistoricalPlan(bars, signalDate, opts = {}) {
  const idx = bars.findIndex((b) => b.date === signalDate);
  if (idx < 5) throw new Error(`buildHistoricalPlan: signalDate ${signalDate} needs at least 6 bars`);
  const slice = bars.slice(0, idx + 1);
  const closes = slice.map((b) => b.close);
  const highs = slice.map((b) => b.high);
  const lows = slice.map((b) => b.low);
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

module.exports = {
  recordPlans,
  recordExecutablePlans,
  verifyIncremental,
  verifyPlans,
  parseFirstNumber,
  buildHistoricalPlan,
  buildSummary,
  isTerminalStatus,
  STATE_SCHEMA,
  FEEDBACK_SCHEMA_V2
};
