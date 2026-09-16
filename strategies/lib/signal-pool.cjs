// strategies/lib/signal-pool.cjs — 信号池（Signal Pool）
//
// 设计基线（v5）：
//   - 信号池是跨 run、跨时间、跨周期存续的信号台账，替代原证伪反馈板块。
//   - 入池：executable 策略版本诞生信号（该版本即 V1）。
//   - 追踪：每期 run 给池内品种一个完整分析席位，追加新策略版本；
//           同时做上期版本事后验证与信号级价格追踪。
//   - 出池：只有 flipped / invalidated_q5 / faded / expired 四种原因；
//           降级（watch/skip）不出池。
//   - 报告：池内信号全量明细 + 最近出池 5 个明细 + 历史统计。
//
// 纪律：确定性、不联网、不调用 LLM；只读 strategy-plan.json 与本地行情。
'use strict';

const fs = require('fs');
const path = require('path');
const { skillRoot, runtimeRoot, runDir } = require('../../lib/workspace.cjs');
const {
  verifyRecord,
  barsForRecord,
  isTerminalStatus
} = require('./feedback.cjs');

const SIGNAL_SCHEMA = 'futures-radar-signal-pool-signal/1';
const LEDGER_SCHEMA = 'futures-radar-signal-pool-ledger/1';
const VIEW_SCHEMA = 'futures-radar-signal-pool-view/1';

const POOL_STATUSES = ['active', 'downgraded', 'closed'];
const CLOSE_REASONS = ['fulfilled', 'flipped', 'invalidated_q5', 'faded', 'expired'];
const EXECUTION_STATUSES = ['executable', 'watch', 'skip'];

function poolRoot(rootOverride = null) {
  if (rootOverride) return rootOverride;
  if (process.env.FUTURES_RUNTIME_ROOT) return path.join(runtimeRoot, 'data', 'signal-pool');
  return path.join(skillRoot, 'data', 'signal-pool');
}

function dirsFor(root) {
  const base = root || poolRoot();
  return { base, signals: path.join(base, 'signals'), observations: path.join(base, 'observations') };
}

function ledgerPath(root) {
  return path.join(root || poolRoot(), 'ledger.json');
}

function ensureDirs(root = null) {
  const d = dirsFor(root || poolRoot());
  for (const p of [d.base, d.signals, d.observations]) fs.mkdirSync(p, { recursive: true });
}

function readJSON(p, fallback = null) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function writeJSONAtomic(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, p);
}

function normDate(d) {
  const s = String(d || '');
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s;
}

function dateCompact(d) {
  const s = normDate(d);
  return s.replace(/-/g, '');
}

function parseFirstNumber(text) {
  if (!text) return null;
  const m = String(text).match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}

function parseTarget1Level(text) {
  const m = String(text || '').match(/(\d{3,}(?:\.\d+)?)/);
  if (m) return parseFloat(m[1]);
  return parseFirstNumber(text);
}

// ── Ledger / signal file ────────────────────────────────────
function defaultLedger() {
  return { schema: LEDGER_SCHEMA, updatedRunId: null, updatedAt: null, signals: [] };
}

function loadLedger(root = null) {
  ensureDirs(root);
  const ledger = readJSON(ledgerPath(root), null);
  if (ledger && ledger.schema === LEDGER_SCHEMA && Array.isArray(ledger.signals)) return ledger;
  return defaultLedger();
}

function saveLedger(ledger, root = null) {
  ensureDirs(root);
  ledger.updatedAt = new Date().toISOString();
  writeJSONAtomic(ledgerPath(root), ledger);
}

function signalFilePath(signalId, root = null) {
  return path.join(dirsFor(root).signals, `${signalId}.json`);
}

function loadSignal(signalId, root = null) {
  return readJSON(signalFilePath(signalId, root), null);
}

function saveSignal(signal, root = null) {
  ensureDirs(root);
  writeJSONAtomic(signalFilePath(signal.signalId, root), signal);
}

function nextSignalId(symbol, date, root = null) {
  const prefix = `SIG-${symbol}-${dateCompact(date)}-`;
  const ledger = loadLedger(root);
  const nums = ledger.signals
    .map((s) => s.signalId)
    .filter((id) => id.startsWith(prefix))
    .map((id) => parseInt(id.slice(prefix.length), 10))
    .filter((n) => Number.isFinite(n));
  const next = (nums.length ? Math.max(...nums) : 0) + 1;
  return `${prefix}${String(next).padStart(2, '0')}`;
}

// ── Version building ────────────────────────────────────────
function directionOfPlan(p) {
  return (p.reportBaseline && p.reportBaseline.direction) || 'neutral';
}

function executionOfPlan(p) {
  return EXECUTION_STATUSES.includes(p.executionStatus) ? p.executionStatus : 'watch';
}

function transitionLabel(prevExec, curExec) {
  if (prevExec == null) return 'signal_created';
  if (prevExec === 'executable' && curExec === 'executable') return '维持执行';
  if (prevExec === 'executable' && curExec !== 'executable') return '降级观察';
  if (prevExec !== 'executable' && curExec === 'executable') return '升级执行';
  return '维持观察';
}

function versionFromPlan(signal, n, plan, p, prevVersion) {
  const curExec = executionOfPlan(p);
  const prevExec = prevVersion ? prevVersion.executionStatus : null;
  return {
    versionId: `${signal.signalId}:V${n}`,
    runId: plan.meta.runId,
    signalDate: plan.meta.signalDate,
    executionStatus: curExec,
    direction: directionOfPlan(p),
    confidence: (p.reportBaseline && p.reportBaseline.confidence) || 'low',
    strategyId: p.matchedStrategies && p.matchedStrategies[0] ? p.matchedStrategies[0].strategyId : 'BASE-01',
    playbookId: p.playbook && p.playbook.playbookId ? p.playbook.playbookId : 'PB-01',
    stateTransition: transitionLabel(prevExec, curExec),
    entry: {
      trigger: (p.entry && p.entry.trigger) || '',
      triggerLevel: p.entry && Number.isFinite(Number(p.entry.triggerLevel)) ? Number(p.entry.triggerLevel) : null,
      triggerSource: (p.entry && p.entry.triggerSource) || '',
      triggerTiming: (p.entry && p.entry.triggerTiming) || 'T+1 收盘确认；确认后下一交易日开盘执行',
      execution: (p.entry && p.entry.execution) || '',
      gapThresholdPts: p.entry && Number.isFinite(Number(p.entry.gapThresholdPts)) ? Number(p.entry.gapThresholdPts) : null,
      triggerStyle: (p.entry && p.entry.triggerStyle) || null
    },
    stop: {
      stopPrice: p.stop && Number.isFinite(Number(p.stop.stopPrice)) ? Number(p.stop.stopPrice) : null,
      basis: (p.stop && p.stop.basis) || ''
    },
    targets: {
      t1: (p.targets && p.targets.t1) || '',
      t2: (p.targets && p.targets.t2) || '',
      basis: (p.targets && p.targets.basis) || ''
    },
    invalidation: {
      hard: p.invalidation && Array.isArray(p.invalidation.hard) ? p.invalidation.hard : [],
      timeStop: (p.invalidation && p.invalidation.timeStop) || ''
    },
    regime: {
      grade: p.riskAssessment && p.riskAssessment.regimeGrade ? p.riskAssessment.regimeGrade : 'unknown',
      direction: p.riskAssessment && p.riskAssessment.regimeDirection ? p.riskAssessment.regimeDirection : 'stable'
    },
    atr5: p.riskAssessment && Number.isFinite(Number(p.riskAssessment.atr5)) ? Number(p.riskAssessment.atr5) : null,
    maxHoldingDays: p.riskAssessment && Number.isFinite(Number(p.riskAssessment.maxHoldingDays)) ? Number(p.riskAssessment.maxHoldingDays) : 5,
    verification: {
      status: 'pending_verification',
      terminal: false,
      verifiedRunId: null,
      lastResult: null
    }
  };
}

function createSignal(plan, p, root = null) {
  const signalId = nextSignalId(p.symbol, plan.meta.signalDate, root);
  const signal = {
    schema: SIGNAL_SCHEMA,
    signalId,
    symbol: p.symbol,
    name: p.name || p.symbol,
    contract: p.contract || null,
    direction: directionOfPlan(p),
    thesis: (p.reportBaseline && p.reportBaseline.driver) || '',
    poolStatus: 'active',
    createdRunId: plan.meta.runId,
    createdDate: plan.meta.signalDate,
    lastSeenRunId: plan.meta.runId,
    lastSeenDate: plan.meta.signalDate,
    currentVersionId: `${signalId}:V1`,
    consecutiveNonExecutable: 0,
    atr5AtCreation: p.riskAssessment && Number.isFinite(Number(p.riskAssessment.atr5)) ? Number(p.riskAssessment.atr5) : null,
    startClose: null,
    latestClose: null,
    maxFavorablePts: null,
    maxAdversePts: null,
    fulfillProgress: null,
    invalidationDistance: null,
    observations: [],
    closedAt: null,
    closeReason: null,
    verdict: null,
    versions: []
  };
  const v1 = versionFromPlan(signal, 1, plan, p, null);
  signal.versions.push(v1);
  return signal;
}

function appendVersion(signal, plan, p) {
  const prev = signal.versions[signal.versions.length - 1] || null;
  const n = signal.versions.length + 1;
  const version = versionFromPlan(signal, n, plan, p, prev);
  signal.versions.push(version);
  signal.lastSeenRunId = plan.meta.runId;
  signal.lastSeenDate = plan.meta.signalDate;
  signal.currentVersionId = version.versionId;
  if (version.executionStatus === 'executable') {
    signal.poolStatus = 'active';
    signal.consecutiveNonExecutable = 0;
  } else {
    signal.poolStatus = 'downgraded';
    signal.consecutiveNonExecutable = (signal.consecutiveNonExecutable || 0) + 1;
  }
  return version;
}

function closeSignal(signal, reason, verdict = null) {
  if (!CLOSE_REASONS.includes(reason)) throw new Error(`invalid closeReason: ${reason}`);
  signal.poolStatus = 'closed';
  signal.closeReason = reason;
  signal.closedAt = new Date().toISOString();
  signal.verdict = verdict || (reason === 'fulfilled' ? 'fulfilled' : 'invalidated');
}

function computeVerdict(signal) {
  return hasFulfilled(signal) ? 'fulfilled' : 'invalidated';
}

function currentVersionOf(signal) {
  return signal.versions.find((v) => v.versionId === signal.currentVersionId) || signal.versions[signal.versions.length - 1] || null;
}

function invalidationLevelOf(signal) {
  const cur = currentVersionOf(signal);
  if (cur && cur.stop && Number.isFinite(Number(cur.stop.stopPrice))) return Number(cur.stop.stopPrice);
  const hard = cur && cur.invalidation ? cur.invalidation.hard : [];
  if (Array.isArray(hard) && hard.length > 0) {
    const n = parseFirstNumber(hard[0]);
    if (n != null) return n;
  }
  return null;
}

function executableVersionsOf(signal) {
  return signal.versions.filter((v) => v.executionStatus === 'executable');
}

function versionFulfillProgress(version, direction) {
  const r = version.verification && version.verification.lastResult;
  const status = version.verification && version.verification.status;
  if (status === 'verified') {
    if (r && r.exitType === 'target1_hit') return 1;
    if (r && r.exitType === 'stopped_out') return 0;
    // 时间离场：按实际盈亏相对目标1的进度
    const entry = r && r.entryPrice;
    const exit = r && r.exitPrice;
    const target = parseTarget1Level(version.targets && version.targets.t1);
    if (entry == null || exit == null || target == null) return r && r.directionCorrect ? 0.5 : 0;
    const denom = direction === 'bullish' ? target - entry : entry - target;
    const gain = direction === 'bullish' ? exit - entry : entry - exit;
    if (denom <= 0) return r && r.directionCorrect ? 0.5 : 0;
    return Math.max(0, Math.min(1, Math.round((gain / denom) * 100) / 100));
  }
  if (status === 'triggered_pending_entry') return 0.05;
  if (status === 'invalidated_not_triggered' || status === 'skipped_gap') return 0;
  return 0;
}

function fulfillProgressOf(signal) {
  const execs = executableVersionsOf(signal);
  if (execs.length === 0) return 0;
  return Math.max(...execs.map((v) => versionFulfillProgress(v, signal.direction)));
}

function hasFulfilled(signal) {
  return executableVersionsOf(signal).some((v) =>
    v.verification.status === 'verified' && v.verification.lastResult && v.verification.lastResult.exitType === 'target1_hit'
  );
}

function invalidationDistanceOf(signal) {
  const level = invalidationLevelOf(signal);
  const atr = signal.atr5AtCreation;
  const close = signal.latestClose;
  if (level == null || atr == null || close == null) return null;
  const dist = signal.direction === 'bullish' ? close - level : level - close;
  return Math.round((dist / atr) * 100) / 100;
}

function anchorVersionOf(signal) {
  const execs = executableVersionsOf(signal);
  return execs[execs.length - 1] || null;
}

function anchorSummaryOf(signal) {
  const v = anchorVersionOf(signal);
  if (!v) return null;
  const r = v.verification && v.verification.lastResult;
  const status = v.verification && v.verification.status;
  const entered = status === 'verified' && r && r.entryPrice != null;
  const entryPrice = entered ? r.entryPrice : null;
  const exitPrice = entered ? r.exitPrice : null;
  const exitType = entered ? r.exitType : null;
  const sign = signal.direction === 'bearish' ? -1 : 1;
  let realizedPnlPts = null;
  let realizedPnlPct = null;
  if (entryPrice != null && exitPrice != null) {
    realizedPnlPts = Math.round((exitPrice - entryPrice) * sign * 100) / 100;
    realizedPnlPct = entryPrice !== 0 ? Math.round((realizedPnlPts / entryPrice) * 10000) / 100 : null;
  }
  return {
    versionId: v.versionId,
    signalDate: v.signalDate,
    executionStatus: v.executionStatus,
    status,
    triggerLevel: v.entry && v.entry.triggerLevel != null ? v.entry.triggerLevel : null,
    entryPrice,
    exitPrice,
    exitType,
    exitDate: entered && r ? r.exitDate : null,
    timeStop: v.invalidation && v.invalidation.timeStop ? v.invalidation.timeStop : '',
    realizedPnlPts,
    realizedPnlPct,
    direction: signal.direction
  };
}

function appendObservation(signal, runId, date, events) {
  if (!Array.isArray(signal.observations)) signal.observations = [];
  const existing = signal.observations.find((o) => o.runId === runId);
  if (existing) {
    existing.date = date;
    existing.close = signal.latestClose;
    existing.fulfillProgress = signal.fulfillProgress;
    existing.invalidationDistance = signal.invalidationDistance;
    existing.events = Array.isArray(events) ? [...new Set(events)] : [];
    return;
  }
  signal.observations.push({
    runId,
    date,
    close: signal.latestClose,
    fulfillProgress: signal.fulfillProgress,
    invalidationDistance: signal.invalidationDistance,
    events: Array.isArray(events) ? [...new Set(events)] : []
  });
}

// ── Verification ─────────────────────────────────────────────
function versionToRecord(signal, version) {
  return {
    recordId: version.versionId,
    runId: version.runId,
    signalDate: version.signalDate,
    symbol: signal.symbol,
    name: signal.name,
    contract: signal.contract,
    direction: version.direction,
    verificationMode: version.executionStatus === 'watch' ? 'signal' : 'trade',
    signalDirection: version.direction === 'bullish' ? 'bullish' : version.direction === 'bearish' ? 'bearish' : null,
    executionStatus: version.executionStatus,
    plannedLots: null,
    confidence: version.confidence,
    strategyId: version.strategyId,
    playbookId: version.playbookId,
    entryTrigger: version.entry.trigger,
    triggerLevel: version.entry.triggerLevel,
    triggerTiming: version.entry.triggerTiming,
    stopPrice: version.stop.stopPrice,
    target1Text: version.targets.t1,
    target1Level: parseTarget1Level(version.targets.t1),
    maxHoldingDays: version.maxHoldingDays,
    gapThresholdPts: version.entry.gapThresholdPts,
    triggerStyle: version.entry.triggerStyle,
    regimeGrade: version.regime.grade,
    regimeDirection: version.regime.direction,
    invalidation: version.invalidation.hard
  };
}

function verifyVersion(signal, version, raw, currentRunId, cache) {
  if (version.executionStatus === 'skip') {
    return {
      status: 'suppressed',
      terminal: true,
      signalDate: version.signalDate,
      verificationSeries: null,
      attribution: [{ code: 'suppressed', detail: '信号池 skip 版本：策略被降级/跳过，不做交易模拟' }]
    };
  }
  const record = versionToRecord(signal, version);
  const result = verifyRecord(record, raw, currentRunId, cache);
  return { ...result, terminal: isTerminalStatus(result.status) };
}

// ── Price tracking ───────────────────────────────────────────
function signalBars(signal, raw, cache) {
  const key = `signal-bars:${signal.symbol}`;
  if (!cache.has(key)) {
    const probe = { contract: signal.contract, symbol: signal.symbol, signalDate: signal.createdDate };
    cache.set(key, barsForRecord(probe, raw, cache));
  }
  return cache.get(key);
}

function updatePriceTracking(signal, raw, cache) {
  const series = signalBars(signal, raw, cache);
  const bars = series.bars || [];
  const idx = bars.findIndex((b) => b.date === signal.createdDate);
  if (idx === -1 || idx >= bars.length) return { expanded: false, bars: [] };
  const startClose = bars[idx].close;
  let maxFav = 0;
  let maxAdv = 0;
  for (let i = idx; i < bars.length; i++) {
    const b = bars[i];
    if (signal.direction === 'bullish') {
      maxFav = Math.max(maxFav, b.high - startClose);
      maxAdv = Math.min(maxAdv, b.low - startClose);
    } else {
      maxFav = Math.max(maxFav, startClose - b.low);
      maxAdv = Math.min(maxAdv, startClose - b.high);
    }
  }
  const prevFav = signal.maxFavorablePts;
  const roundedFav = Math.round(maxFav * 100) / 100;
  const roundedAdv = Math.round(maxAdv * 100) / 100;
  signal.startClose = startClose;
  signal.latestClose = bars[bars.length - 1].close;
  signal.maxFavorablePts = roundedFav;
  signal.maxAdversePts = roundedAdv;
  const expanded = prevFav == null || roundedFav > prevFav;
  return { expanded, bars, startIdx: idx };
}

// ── Q5 invalidation check ────────────────────────────────────
function q5Triggered(signal, version, bars) {
  const hard = Array.isArray(version.invalidation.hard) ? version.invalidation.hard : [];
  if (hard.length === 0) return false;
  const idx = bars.findIndex((b) => b.date === version.signalDate);
  if (idx === -1) return false;
  for (const cond of hard) {
    const num = parseFirstNumber(cond);
    if (num == null) continue;
    if (signal.direction === 'bullish') {
      if (/跌破|下破|失守/.test(cond)) {
        for (let i = idx + 1; i < bars.length; i++) {
          if (bars[i].close < num) return true;
        }
      }
    } else if (signal.direction === 'bearish') {
      if (/站上|涨破|上破|突破|收复/.test(cond)) {
        for (let i = idx + 1; i < bars.length; i++) {
          if (bars[i].close > num) return true;
        }
      }
    }
  }
  return false;
}

// ── Observations ─────────────────────────────────────────────
function writeObservation(root, runId, plan, p, note) {
  const d = dirsFor(root);
  const file = path.join(d.observations, `${runId}.json`);
  const existing = readJSON(file, []);
  const records = Array.isArray(existing) ? existing : [];
  const dup = records.some((r) => r.runId === runId && r.symbol === p.symbol);
  if (!dup) {
    records.push({
      runId,
      signalDate: plan.meta.signalDate,
      symbol: p.symbol,
      name: p.name || p.symbol,
      direction: directionOfPlan(p),
      executionStatus: executionOfPlan(p),
      note
    });
  }
  writeJSONAtomic(file, records);
}

// ── View building ────────────────────────────────────────────
function summarizeSignal(signal) {
  const cur = signal.versions.find((v) => v.versionId === signal.currentVersionId) || signal.versions[signal.versions.length - 1];
  const latestVerified = signal.versions
    .filter((v) => v.verification && (v.verification.terminal || v.verification.status !== 'pending_verification'))
    .slice(-1)[0] || null;
  return {
    signalId: signal.signalId,
    symbol: signal.symbol,
    name: signal.name,
    contract: signal.contract,
    direction: signal.direction,
    thesis: signal.thesis,
    poolStatus: signal.poolStatus,
    createdRunId: signal.createdRunId,
    createdDate: signal.createdDate,
    lastSeenRunId: signal.lastSeenRunId,
    lastSeenDate: signal.lastSeenDate,
    versionCount: signal.versions.length,
    consecutiveNonExecutable: signal.consecutiveNonExecutable || 0,
    currentVersion: cur ? {
      versionId: cur.versionId,
      runId: cur.runId,
      signalDate: cur.signalDate,
      executionStatus: cur.executionStatus,
      direction: cur.direction,
      confidence: cur.confidence,
      strategyId: cur.strategyId,
      playbookId: cur.playbookId,
      stateTransition: cur.stateTransition,
      entryTrigger: cur.entry.trigger,
      triggerLevel: cur.entry.triggerLevel,
      triggerTiming: cur.entry.triggerTiming,
      stopPrice: cur.stop.stopPrice,
      t1: cur.targets.t1
    } : null,
    latestVerification: latestVerified ? {
      versionId: latestVerified.versionId,
      status: latestVerified.verification.status,
      exitType: latestVerified.verification.lastResult && latestVerified.verification.lastResult.exitType ? latestVerified.verification.lastResult.exitType : null,
      directionCorrect: latestVerified.verification.lastResult && latestVerified.verification.lastResult.directionCorrect != null ? latestVerified.verification.lastResult.directionCorrect : null,
      verifyDate: latestVerified.verification.lastResult && latestVerified.verification.lastResult.verifyDate ? latestVerified.verification.lastResult.verifyDate : null,
      attribution: latestVerified.verification.lastResult && Array.isArray(latestVerified.verification.lastResult.attribution) ? latestVerified.verification.lastResult.attribution : []
    } : null,
    priceTracking: {
      startClose: signal.startClose,
      latestClose: signal.latestClose,
      maxFavorablePts: signal.maxFavorablePts,
      maxAdversePts: signal.maxAdversePts
    },
    fulfillProgress: signal.fulfillProgress,
    invalidationDistance: signal.invalidationDistance,
    anchor: anchorSummaryOf(signal),
    observations: Array.isArray(signal.observations) ? signal.observations.slice(-12) : [],
    closedAt: signal.closedAt,
    closeReason: signal.closeReason,
    verdict: signal.verdict
  };
}

function buildView(runId, ledger, root = null) {
  const all = [];
  for (const row of ledger.signals) {
    const sig = loadSignal(row.signalId, root);
    if (sig) all.push(sig);
  }
  const pool = all.filter((s) => s.poolStatus !== 'closed');
  const closed = all.filter((s) => s.poolStatus === 'closed').sort((a, b) => String(b.closedAt || '').localeCompare(String(a.closedAt || '')));
  const byCloseReason = {};
  const byOutcome = { fulfilled: 0, invalidated: 0 };
  for (const c of closed) {
    byCloseReason[c.closeReason || 'unknown'] = (byCloseReason[c.closeReason || 'unknown'] || 0) + 1;
    if (c.verdict === 'fulfilled') byOutcome.fulfilled++;
    else byOutcome.invalidated++;
  }
  const details = {};
  for (const s of [...pool, ...closed.slice(0, 5)]) {
    details[s.signalId] = s;
  }
  return {
    schema: VIEW_SCHEMA,
    meta: {
      runId,
      generatedAt: new Date().toISOString(),
      poolCount: pool.length,
      closedTotal: closed.length
    },
    pool: pool.map(summarizeSignal),
    recentClosed: closed.slice(0, 5).map(summarizeSignal),
    historyStats: {
      totalClosed: closed.length,
      byCloseReason,
      byOutcome
    },
    details
  };
}

// ── Main update ──────────────────────────────────────────────
function updateSignalPool({ runId, raw, rootOverride = null, plan = null }) {
  const root = rootOverride || poolRoot();
  ensureDirs(root);
  const planPath = path.join(runDir(runId), 'strategy-plan.json');
  plan = plan || readJSON(planPath, null);
  const plans = plan && Array.isArray(plan.plans) ? plan.plans : [];
  const rawData = raw || readJSON(path.join(runDir(runId), 'raw.json'), { contracts: {} });

  const ledger = loadLedger(root);
  const activeBySymbol = new Map();
  for (const row of ledger.signals) {
    const sig = loadSignal(row.signalId, root);
    if (sig && sig.poolStatus !== 'closed') activeBySymbol.set(sig.symbol, sig);
  }

  const cache = new Map();
  let createdThisRun = 0;
  let versionsAddedThisRun = 0;

  // 1) 入池 / 版本追加 / 反向翻转（先处理本期 plan）
  for (const p of plans) {
    const dir = directionOfPlan(p);
    const existing = activeBySymbol.get(p.symbol);
    if (!existing) {
      if (executionOfPlan(p) === 'executable') {
        const sig = createSignal(plan, p, root);
        activeBySymbol.set(sig.symbol, sig);
        ledger.signals.push({ signalId: sig.signalId, symbol: sig.symbol });
        createdThisRun++;
        saveSignal(sig, root);
      } else {
        writeObservation(root, runId, plan, p, '无主信号的 watch/skip 不入池');
      }
      continue;
    }

    if (existing.direction === dir) {
      // 幂等：同一 run 已追加过该信号版本则不重复追加
      const already = existing.versions.some((v) => v.runId === plan.meta.runId);
      if (!already) {
        appendVersion(existing, plan, p);
        versionsAddedThisRun++;
        saveSignal(existing, root);
      }
    } else if (dir !== 'neutral') {
      if (executionOfPlan(p) === 'executable') {
        const already = existing.versions.some((v) => v.runId === plan.meta.runId);
        if (!already) {
          closeSignal(existing, 'flipped');
          existing.closedAt = plan.meta.signalDate;
          saveSignal(existing, root);
          const sig = createSignal(plan, p, root);
          activeBySymbol.set(sig.symbol, sig);
          ledger.signals.push({ signalId: sig.signalId, symbol: sig.symbol });
          createdThisRun++;
          saveSignal(sig, root);
        }
      } else {
        writeObservation(root, runId, plan, p, '反向 watch/skip：只记录，不推翻在池信号');
      }
    }
  }

  // 2) 追踪：验证 + 价格追踪 + 两态出池判定（兑现 / 失效）
  const updatedSignalIds = [];
  for (const sig of activeBySymbol.values()) {
    const events = [];
    // 版本验证（收集关键事件）
    for (const version of sig.versions) {
      if (version.runId === runId) continue; // 本期版本下期才开始验证
      if (version.verification.terminal) continue;
      const prevStatus = version.verification.status;
      const result = verifyVersion(sig, version, rawData, runId, cache);
      version.verification.status = result.status;
      version.verification.terminal = result.terminal === true || result.status === 'suppressed';
      version.verification.verifiedRunId = runId;
      version.verification.lastResult = result;
      if (result.status === 'triggered_pending_entry') events.push('triggered');
      else if (result.status === 'verified' && result.exitType === 'stopped_out') events.push('stopped_out');
      else if (result.status === 'verified' && result.exitType === 'target1_hit') events.push('target1_hit');
      else if (result.status === 'skipped_gap') events.push('gap_skip');
      else if (result.status === 'invalidated_not_triggered') events.push('not_triggered');
    }
    // 价格追踪 + 两指标更新
    const track = updatePriceTracking(sig, rawData, cache);
    const obsDate = track.bars.length ? track.bars[track.bars.length - 1].date : sig.lastSeenDate;
    if (track.expanded) events.push('price_new_high');
    sig.fulfillProgress = fulfillProgressOf(sig);
    sig.invalidationDistance = invalidationDistanceOf(sig);
    // 出池判定：先兑现，后失效（flipped 已在匹配阶段处理）
    if (sig.poolStatus !== 'closed') {
      const progress = sig.fulfillProgress;
      const cur = currentVersionOf(sig);
      const q5Hit = cur && track.bars.length > 0 ? q5Triggered(sig, cur, track.bars) : false;
      if (hasFulfilled(sig)) {
        closeSignal(sig, 'fulfilled');
        events.push('fulfilled');
      } else if (q5Hit) {
        closeSignal(sig, 'invalidated_q5');
        events.push('invalidated');
      } else {
        const barsCount = track.bars.length ? track.bars.length - track.startIdx : 0;
        if (barsCount > 10) {
          closeSignal(sig, 'expired');
          events.push('invalidated');
        } else if (sig.consecutiveNonExecutable >= 3 && track.expanded === false) {
          closeSignal(sig, 'faded');
          events.push('invalidated');
        }
      }
      if (sig.poolStatus === 'closed') sig.closedAt = obsDate;
    }
    appendObservation(sig, runId, obsDate, events);
    saveSignal(sig, root);
    updatedSignalIds.push(sig.signalId);
  }

  // 3) 出池信号若本期刚关闭，确保已保存（已在上方 saveSignal）
  ledger.updatedRunId = runId;
  saveLedger(ledger, root);

  const view = buildView(runId, ledger, root);
  return {
    view,
    meta: {
      createdThisRun,
      versionsAddedThisRun,
      poolCount: view.pool.length,
      closedTotal: view.historyStats.totalClosed
    }
  };
}

module.exports = {
  currentVersionOf,
  invalidationLevelOf,
  executableVersionsOf,
  versionFulfillProgress,
  fulfillProgressOf,
  hasFulfilled,
  anchorVersionOf,
  anchorSummaryOf,
  invalidationDistanceOf,
  appendObservation,

  // constants
  SIGNAL_SCHEMA,
  LEDGER_SCHEMA,
  VIEW_SCHEMA,
  POOL_STATUSES,
  CLOSE_REASONS,
  EXECUTION_STATUSES,
  // paths & io
  poolRoot,
  ledgerPath,
  signalFilePath,
  ensureDirs,
  loadLedger,
  saveLedger,
  loadSignal,
  saveSignal,
  nextSignalId,
  // lifecycle
  createSignal,
  appendVersion,
  closeSignal,
  computeVerdict,
  versionFromPlan,
  transitionLabel,
  // verification / tracking
  verifyVersion,
  updatePriceTracking,
  q5Triggered,
  // main
  updateSignalPool,
  buildView,
  summarizeSignal
};
