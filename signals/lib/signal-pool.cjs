// signals/lib/signal-pool.cjs — 信号池（Signal Pool）
//
// 设计基线（v5）：
//   - 信号池是跨 run、跨时间、跨周期存续的信号台账，替代原证伪反馈板块。
//   - 入池：executable 策略版本诞生信号（该版本即 V1）。
//   - 追踪：每期 run 给池内品种一个完整分析席位，追加新策略版本；
//           同时做上期版本事后验证与信号级价格追踪。
//   - 出池：closeReason（事件轴）只有 flipped / invalidated_q5 / faded / expired / fulfilled；
//           closeClass（质量轴）四类：方向错误 / 方向正确·执行盈利 / 方向正确·未执行 / 方向正确·执行亏损。
//           降级（watch/skip）不出池。
//   - 报告：池内信号全量明细 + 最近出池 5 个明细 + 历史统计。
//
// 纪律：确定性、不联网、不调用 LLM；只读 strategy-plan.json 与本地行情。
'use strict';

const fs = require('fs');
const path = require('path');
const { skillRoot, runtimeRoot, runDir } = require('../../shared/workspace.cjs');
const {
  verifyRecord,
  barsForRecord,
  isTerminalStatus
} = require('../../analysis/strategy/feedback.cjs');
const {
  planStateOf,
  planReasonsOf,
  versionStateOf,
  signalStatusOf,
  verificationEventOf,
  normalizeEvent,
  eventLabel,
  eventCodesOf,
  directionResultOfCodes,
  directionEvidenceOfCodes,
  executionEventOfCodes,
  executionResultOfCodes,
  EXECUTION_STATES,
  DIRECTION_EVENTS,
  EXIT_EVENTS
} = require('../../shared/strategy-state.cjs');

const SIGNAL_SCHEMA = 'futures-radar-signal-pool-signal/1';
const LEDGER_SCHEMA = 'futures-radar-signal-pool-ledger/1';
const VIEW_SCHEMA = 'futures-radar-signal-pool-view/1';

const POOL_STATUSES = ['active', 'downgraded', 'closed'];
const CLOSE_REASONS = ['fulfilled', 'flipped', 'invalidated_q5', 'faded', 'expired'];
const CLOSE_CLASSES = ['direction_wrong', 'direction_hit_profit', 'direction_hit_noexec', 'direction_hit_loss'];
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
  return planStateOf(p) === 'armed' ? 'executable' : planStateOf(p) === 'suspended' ? 'skip' : 'watch';
}

function versionInitialState(v) {
  if (v && EXECUTION_STATES[v.state]) return v.state;
  if (!v) return 'watching';
  if (v.executionStatus === 'executable') return 'armed';
  if (v.executionStatus === 'skip') return 'suspended';
  return 'watching';
}

function transitionLabel(prevExec, curExec) {
  if (prevExec == null) return 'signal_created';
  if (prevExec === 'executable' && curExec === 'executable') return '维持执行';
  if (prevExec === 'executable' && curExec !== 'executable') return '降级观察';
  if (prevExec !== 'executable' && curExec === 'executable') return '升级执行';
  return '维持观察';
}

function versionFromPlan(signal, n, plan, p, prevVersion) {
  const curState = planStateOf(p);
  const curExec = executionOfPlan(p);
  const prevExec = prevVersion ? prevVersion.executionStatus : null;
  return {
    versionId: `${signal.signalId}:V${n}`,
    runId: plan.meta.runId,
    signalDate: plan.meta.signalDate,
    contract: p.contract || null,
    storyChainId: p.storyChainId || signal.storyChainId || null, // V2 前向盖章：版本级血缘
    state: curState,
    executionStatus: curExec,
    stateReasons: planReasonsOf(p),
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
    storyChainId: p.storyChainId || null, // V2 前向盖章：故事席位血缘
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
  if (version.contract) signal.contract = version.contract;
  if (version.state === 'armed') {
    signal.poolStatus = 'active';
    signal.consecutiveNonExecutable = 0;
  } else {
    signal.poolStatus = 'downgraded';
    signal.consecutiveNonExecutable = (signal.consecutiveNonExecutable || 0) + 1;
  }
  return version;
}

// ── 同一天只允许一个策略：同交易日重复 plan 覆盖旧版而非追加 ──
function versionNumber(v) {
  const s = String((v && v.versionId) || '');
  const i = s.lastIndexOf(':V');
  if (i >= 0) {
    const n = Number(s.slice(i + 2));
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function sameDayVersionOf(signal, date) {
  if (!date) return null;
  return (signal.versions || []).find((v) => v.signalDate === date) || null;
}

function refreshPoolState(signal, version) {
  signal.lastSeenRunId = version.runId;
  signal.lastSeenDate = version.signalDate;
  signal.currentVersionId = version.versionId;
  if (version.contract) signal.contract = version.contract;
  if (version.state === 'armed') {
    signal.poolStatus = 'active';
    signal.consecutiveNonExecutable = 0;
  } else {
    signal.poolStatus = 'downgraded';
    signal.consecutiveNonExecutable = (signal.consecutiveNonExecutable || 0) + 1;
  }
}

const MARKET_PROGRESSED_STATUSES = new Set([
  'holding', 'triggered_pending_entry', 'verified',
  'skipped_gap', 'invalidated_not_triggered', 'confirmed', 'watch_missed',
  'target_hit', 'time_exit_profit', 'stopped_out', 'time_exit_loss', 'unverifiable'
]);

function refreshVersionFromPlan(signal, version, plan, p) {
  const idx = (signal.versions || []).findIndex((v) => v.versionId === version.versionId);
  const prev = idx > 0 ? signal.versions[idx - 1] : null;
  const refreshed = versionFromPlan(signal, idx + 1, plan, p, prev);
  Object.assign(version, refreshed, {
    versionId: version.versionId,
    verification: { status: 'pending_verification', terminal: false, verifiedRunId: null, lastResult: null }
  });
  return version;
}

// 视图/持久化前归一：同一天只保留最新版本，并按交易日重新编号 V1..Vn。
// 返回是否有变化；历史重复版本只收敛不丢弃有效信息（最新计划覆盖旧计划）。
function normalizeVersions(signal) {
  const versions = Array.isArray(signal.versions) ? signal.versions : [];
  if (versions.length === 0) return false;
  const byDate = new Map();
  for (const v of versions) {
    const key = v.signalDate || '';
    const prev = byDate.get(key);
    if (!prev || versionNumber(v) > versionNumber(prev)) byDate.set(key, v);
  }
  const collapsed = [...byDate.values()].sort((a, b) => {
    const d = String(a.signalDate || '').localeCompare(String(b.signalDate || ''));
    if (d !== 0) return d;
    return versionNumber(a) - versionNumber(b);
  });
  const keptNewIds = new Map();
  let changed = collapsed.length !== versions.length;
  collapsed.forEach((v, i) => {
    const newId = `${signal.signalId}:V${i + 1}`;
    keptNewIds.set(v.signalDate || '', newId);
    if (v.versionId !== newId) changed = true;
    if (v.verification && v.verification.lastResult && v.verification.lastResult.recordId === v.versionId) {
      v.verification.lastResult.recordId = newId;
    }
    v.versionId = newId;
  });
  const oldToNew = new Map();
  for (const v of versions) {
    oldToNew.set(v.versionId, keptNewIds.get(v.signalDate || '') || v.versionId);
  }
  signal.versions = collapsed;
  if (signal.currentVersionId && oldToNew.has(signal.currentVersionId)) {
    const mapped = oldToNew.get(signal.currentVersionId);
    if (mapped && signal.currentVersionId !== mapped) {
      signal.currentVersionId = mapped;
      changed = true;
    }
  } else if (!collapsed.some((v) => v.versionId === signal.currentVersionId)) {
    signal.currentVersionId = collapsed[collapsed.length - 1].versionId;
    changed = true;
  }
  for (const o of Array.isArray(signal.observations) ? signal.observations : []) {
    for (const e of Array.isArray(o.events) ? o.events : []) {
      if (e && e.versionId && oldToNew.has(e.versionId)) e.versionId = oldToNew.get(e.versionId);
    }
  }
  return changed;
}

// ── 出池质量分类（方向 × 执行）────────────────────────────
// 维度 A：信号预测方向（价格追踪口径，与是否执行无关）。
//   终值优先：多头 latest > startClose，空头 latest < startClose。
//   过程补认：顺向最大有利偏移 ≥ 1×ATR5 且 ≥ |逆向最大不利偏移|。
// 维度 B：执行是否盈利（只看 executable 版本）。
//   盈利 = 任一已入场版本实现盈亏 > 0；亏损 = 有入场但全部 ≤ 0；未执行 = 无入场。
// closeClass：方向错 → direction_wrong；方向对+盈利 → direction_hit_profit；
//             方向对+未执行 → direction_hit_noexec；方向对+亏损 → direction_hit_loss。
function directionVerdictOf(signal) {
  const dir = signal.direction;
  const start = Number(signal.startClose);
  const latest = Number(signal.latestClose);
  const maxFav = Number(signal.maxFavorablePts);
  const maxAdv = Number(signal.maxAdversePts);
  const atr = Number(signal.atr5AtCreation);
  if (Number.isFinite(start) && Number.isFinite(latest)) {
    const finalHit = dir === 'bullish' ? latest > start : dir === 'bearish' ? latest < start : false;
    if (finalHit) return 'hit';
  }
  if (Number.isFinite(maxFav) && maxFav > 0) {
    const favDominates = Number.isFinite(maxAdv) ? maxFav >= Math.abs(maxAdv) : true;
    const atrFloor = Number.isFinite(atr) && atr > 0 ? atr : 0;
    if (favDominates && maxFav >= atrFloor) return 'hit';
  }
  return 'miss';
}

function executedOutcomesOf(signal) {
  const sign = signal.direction === 'bearish' ? -1 : 1;
  const outcomes = [];
  for (const v of signal.versions || []) {
    if (versionInitialState(v) !== 'armed') continue;
    const r = v.verification && v.verification.lastResult;
    const st = v.verification && v.verification.status;
    if (!r) continue;
    if (st === 'verified' && r.entryPrice != null && r.exitPrice != null) {
      const pnl = (r.exitPrice - r.entryPrice) * sign;
      outcomes.push({ versionId: v.versionId, exitType: r.exitType || 'exited', pnlPts: Math.round(pnl * 100) / 100 });
    } else if (st === 'holding' && r.entryPrice != null && signal.latestClose != null) {
      // 持仓中因 flipped/Q5 强制出池：按最新价结算浮动盈亏参与分类
      const pnl = (signal.latestClose - r.entryPrice) * sign;
      outcomes.push({ versionId: v.versionId, exitType: 'holding', pnlPts: Math.round(pnl * 100) / 100 });
    }
  }
  return outcomes;
}

function executionVerdictOf(signal) {
  const outcomes = executedOutcomesOf(signal);
  if (outcomes.length === 0) return { verdict: 'noexec', bestPnlPts: null, outcomes };
  const best = outcomes.reduce((a, b) => (b.pnlPts > a.pnlPts ? b : a), outcomes[0]);
  return { verdict: best.pnlPts > 0 ? 'profit' : 'loss', bestPnlPts: best.pnlPts, outcomes };
}

function closeClassOf(signal) {
  if (directionVerdictOf(signal) !== 'hit') return 'direction_wrong';
  const exec = executionVerdictOf(signal);
  if (exec.verdict === 'profit') return 'direction_hit_profit';
  if (exec.verdict === 'loss') return 'direction_hit_loss';
  return 'direction_hit_noexec';
}

function backfillCloseClass(signal) {
  if (!signal || signal.poolStatus !== 'closed' || signal.closeClass) return false;
  signal.directionVerdict = directionVerdictOf(signal);
  const exec = executionVerdictOf(signal);
  signal.executionVerdict = exec.verdict;
  signal.executionBestPnlPts = exec.bestPnlPts;
  signal.closeClass = closeClassOf(signal);
  signal.verdict = signal.closeClass === 'direction_hit_profit' ? 'fulfilled' : 'invalidated';
  return true;
}

// ── 事件流两层归因投影 ────────────────────────────────────────
function allSignalEventCodes(signal, extraEvents) {
  const codes = new Set();
  for (const o of Array.isArray(signal.observations) ? signal.observations : []) {
    for (const code of eventCodesOf(o.events)) codes.add(code);
  }
  for (const code of eventCodesOf(extraEvents)) codes.add(code);
  return codes;
}

function applyExitProjection(signal, extraEvents = []) {
  const codes = allSignalEventCodes(signal, extraEvents);
  signal.directionResult = directionResultOfCodes(codes);
  signal.directionEvidence = directionEvidenceOfCodes(codes);
  signal.executionEvent = executionEventOfCodes(codes);
  signal.executionResult = executionResultOfCodes(codes);
}

function closeSignal(signal, reason, verdict = null) {
  if (!CLOSE_REASONS.includes(reason)) throw new Error(`invalid closeReason: ${reason}`);
  signal.poolStatus = 'closed';
  signal.closeReason = reason;
  signal.closedAt = new Date().toISOString();
  signal.directionVerdict = directionVerdictOf(signal);
  const exec = executionVerdictOf(signal);
  signal.executionVerdict = exec.verdict;
  signal.executionBestPnlPts = exec.bestPnlPts;
  signal.closeClass = closeClassOf(signal);
  signal.verdict = verdict || (signal.closeClass === 'direction_hit_profit' ? 'fulfilled' : 'invalidated');
}

function computeVerdict(signal) {
  return closeClassOf(signal) === 'direction_hit_profit' ? 'fulfilled' : 'invalidated';
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
  return signal.versions.filter((v) => versionInitialState(v) === 'armed');
}

function versionFulfillProgress(version, direction, latestClose) {
  const r = version.verification && version.verification.lastResult;
  const status = version.verification && version.verification.status;
  if (status === 'holding' && r && r.entryPrice != null && latestClose != null) {
    const target = parseTarget1Level(version.targets && version.targets.t1);
    if (target == null) return 0;
    const denom = direction === 'bullish' ? target - r.entryPrice : r.entryPrice - target;
    const gain = direction === 'bullish' ? latestClose - r.entryPrice : r.entryPrice - latestClose;
    if (denom <= 0) return 0;
    return Math.max(0, Math.min(1, Math.round((gain / denom) * 100) / 100));
  }
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
  return Math.max(...execs.map((v) => versionFulfillProgress(v, signal.direction, signal.latestClose)));
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

function hasPendingExecutable(signal) {
  return executableVersionsOf(signal).some((v) =>
    !v.verification.terminal && ['holding', 'triggered_pending_entry', 'pending_data', 'pending_verification'].includes(v.verification.status)
  );
}

function hasOpenPosition(signal) {
  return executableVersionsOf(signal).some((v) =>
    ['holding', 'triggered_pending_entry'].includes(v.verification.status)
  );
}

function positionStatusOf(signal) {
  const v = anchorVersionOf(signal);
  if (!v) return 'none';
  const st = v.verification.status;
  if (st === 'holding') return 'holding';
  if (st === 'triggered_pending_entry') return 'triggered';
  if (st === 'verified') return v.verification.lastResult ? v.verification.lastResult.exitType || 'exited' : 'exited';
  if (st === 'pending_data' || st === 'pending_verification') return 'pending';
  return 'none';
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
  const entered = (status === 'verified' || status === 'holding') && r && r.entryPrice != null;
  const entryPrice = entered ? r.entryPrice : null;
  const exitPrice = status === 'verified' ? r.exitPrice : null;
  const exitType = status === 'verified' ? r.exitType : null;
  const sign = signal.direction === 'bearish' ? -1 : 1;
  let realizedPnlPts = null;
  let realizedPnlPct = null;
  if (status === 'verified' && entryPrice != null && exitPrice != null) {
    realizedPnlPts = Math.round((exitPrice - entryPrice) * sign * 100) / 100;
    realizedPnlPct = entryPrice !== 0 ? Math.round((realizedPnlPts / entryPrice) * 10000) / 100 : null;
  }
  let floatingPnlPts = null;
  let floatingPnlPct = null;
  if (status === 'holding' && entryPrice != null && signal.latestClose != null) {
    floatingPnlPts = Math.round((signal.latestClose - entryPrice) * sign * 100) / 100;
    floatingPnlPct = entryPrice !== 0 ? Math.round((floatingPnlPts / entryPrice) * 10000) / 100 : null;
  }
  return {
    versionId: v.versionId,
    signalDate: v.signalDate,
    executionStatus: v.executionStatus,
    status,
    positionStatus: positionStatusOf(signal),
    triggerLevel: v.entry && v.entry.triggerLevel != null ? v.entry.triggerLevel : null,
    triggerDate: r ? r.triggerDate : null,
    entryDate: r ? r.entryDate : null,
    entryPrice,
    exitPrice,
    exitType,
    exitDate: status === 'verified' && r ? r.exitDate : null,
    timeStop: v.invalidation && v.invalidation.timeStop ? v.invalidation.timeStop : '',
    realizedPnlPts,
    realizedPnlPct,
    floatingPnlPts,
    floatingPnlPct,
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
    existing.positionStatus = positionStatusOf(signal);
    existing.events = Array.isArray(events) ? [...new Set(events)] : [];
    return;
  }
  signal.observations.push({
    runId,
    date,
    close: signal.latestClose,
    fulfillProgress: signal.fulfillProgress,
    invalidationDistance: signal.invalidationDistance,
    positionStatus: positionStatusOf(signal),
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
    verificationMode: versionInitialState(version) === 'watching' ? 'signal' : 'trade',
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
  if (versionInitialState(version) === 'suspended') {
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
    storyChainId: signal.storyChainId || null,
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
      contract: cur.contract || signal.contract,
      storyChainId: cur.storyChainId || signal.storyChainId || null,
      state: versionStateOf(cur),
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
    signalStatus: signalStatusOf(signal),
    anchor: anchorSummaryOf(signal),
    observations: (Array.isArray(signal.observations) ? signal.observations.slice(-12) : []).map((o) => ({
      ...o,
      events: Array.isArray(o.events) ? o.events.map(normalizeEvent).filter(Boolean) : []
    })),
    closedAt: signal.closedAt,
    closeReason: signal.closeReason,
    closeClass: signal.closeClass || null,
    directionResult: signal.directionResult || null,
    directionEvidence: signal.directionEvidence || null,
    executionResult: signal.executionResult || null,
    executionEvent: signal.executionEvent || null,
    directionVerdict: signal.directionVerdict || null,
    executionVerdict: signal.executionVerdict || null,
    executionBestPnlPts: signal.executionBestPnlPts != null ? signal.executionBestPnlPts : null,
    verdict: signal.verdict
  };
}

function deriveDirectionEvidence(signal) {
  const dir = signal.direction;
  const start = Number(signal.startClose);
  const latest = Number(signal.latestClose);
  if (Number.isFinite(start) && Number.isFinite(latest)) {
    const finalHit = dir === 'bearish' ? latest < start : latest > start;
    if (finalHit) return 'close_favorable';
  }
  const fav = Number(signal.maxFavorablePts);
  const adv = Number(signal.maxAdversePts);
  const atr = Number(signal.atr5AtCreation);
  if (Number.isFinite(fav) && Number.isFinite(adv) && Number.isFinite(atr) && atr > 0) {
    if (fav >= atr && fav >= Math.abs(adv)) return 'favorable_1atr';
    if (Math.abs(adv) >= atr && Math.abs(adv) > fav) return 'adverse_1atr';
  }
  return 'none';
}

function deriveExecutionEvidence(signal) {
  const outcomes = executedOutcomesOf(signal);
  if (outcomes.length > 0) {
    const best = outcomes.reduce((a, b) => (b.pnlPts > a.pnlPts ? b : a), outcomes[0]);
    if (best.pnlPts > 0) return outcomes.some((o) => o.exitType === 'target1_hit') ? 'target_hit' : 'time_exit_profit';
    return best.exitType === 'stopped_out' ? 'stopped_out' : 'time_exit_loss';
  }
  const execVersions = signal.versions.filter((v) => versionInitialState(v) === 'armed');
  if (execVersions.some((v) => v.verification && v.verification.status === 'skipped_gap')) return 'gap_skipped';
  if (execVersions.some((v) => v.verification && v.verification.status === 'invalidated_not_triggered')) return 'trigger_missed';
  const watchVersions = signal.versions.filter((v) => versionInitialState(v) === 'watching');
  if (watchVersions.some((v) => v.verification && v.verification.status === 'confirmed')) return 'confirmed';
  if (watchVersions.some((v) => v.verification && v.verification.status === 'invalidated_not_triggered')) return 'watch_missed';
  if (signal.versions.some((v) => v.verification && v.verification.status === 'unverifiable')) return 'unverifiable';
  return 'suspended';
}

function backfillExitProjection(signal) {
  if (!signal || signal.poolStatus !== 'closed' || signal.directionResult) return false;
  const codes = allSignalEventCodes(signal, [{ code: signal.closeReason === 'flipped' ? 'flipped' : signal.closeReason === 'invalidated_q5' ? 'q5_hit' : signal.closeReason === 'fulfilled' ? 'fulfilled' : signal.closeReason === 'expired' ? 'expired' : signal.closeReason === 'faded' ? 'faded' : null, kind: 'exit' }].filter((e) => e.code));
  const evFromCodes = executionEventOfCodes(codes);
  const dirFromCodes = directionEvidenceOfCodes(codes);
  // 旧 closed 信号事件流不完整：方向证据缺失时用价格追踪直接推导
  const dirEvidence = dirFromCodes !== 'none' ? dirFromCodes : deriveDirectionEvidence(signal);
  signal.directionEvidence = dirEvidence;
  signal.directionResult = (dirEvidence === 'close_favorable' || dirEvidence === 'favorable_1atr') ? 'hit' : 'miss';
  signal.executionEvent = evFromCodes || deriveExecutionEvidence(signal);
  signal.executionResult = evFromCodes ? executionResultOfCodes(codes) : executionResultOfCodes(new Set([signal.executionEvent]));
  return true;
}

function buildView(runId, ledger, root = null) {
  const all = [];
  for (const row of ledger.signals) {
    const sig = loadSignal(row.signalId, root);
    if (sig) {
      const migratedVersions = normalizeVersions(sig);
      const migratedClass = backfillCloseClass(sig);
      const migratedProjection = backfillExitProjection(sig);
      if (migratedVersions || migratedClass || migratedProjection) saveSignal(sig, root);
      all.push(sig);
    }
  }
  const pool = all.filter((s) => s.poolStatus !== 'closed');
  const closed = all.filter((s) => s.poolStatus === 'closed').sort((a, b) => String(b.closedAt || '').localeCompare(String(a.closedAt || '')));
  const byCloseReason = {};
  const byCloseClass = {};
  const byOutcome = { fulfilled: 0, invalidated: 0 };
  const directionLayer = {
    hit: 0, miss: 0,
    byEvent: { close_favorable: 0, favorable_1atr: 0, adverse_1atr: 0, none: 0 }
  };
  const executionLayer = {
    profit: 0, loss: 0, noexec: 0,
    byEvent: { target_hit: 0, time_exit_profit: 0, stopped_out: 0, time_exit_loss: 0, gap_skipped: 0, trigger_missed: 0, confirmed: 0, watch_missed: 0, suspended: 0, unverifiable: 0 }
  };
  for (const c of closed) {
    byCloseReason[c.closeReason || 'unknown'] = (byCloseReason[c.closeReason || 'unknown'] || 0) + 1;
    byCloseClass[c.closeClass || 'legacy'] = (byCloseClass[c.closeClass || 'legacy'] || 0) + 1;
    if (c.verdict === 'fulfilled') byOutcome.fulfilled++;
    else byOutcome.invalidated++;
    const dr = c.directionResult || (c.directionVerdict === 'hit' ? 'hit' : 'miss');
    const de = c.directionEvidence || (dr === 'hit' && c.directionVerdict === 'hit' ? (c.latestClose != null && c.startClose != null && (c.direction === 'bearish' ? c.latestClose < c.startClose : c.latestClose > c.startClose) ? 'close_favorable' : 'favorable_1atr') : 'none');
    const er = c.executionResult || (c.executionVerdict || 'noexec');
    const ee = c.executionEvent || (c.closeReason === 'fulfilled' ? 'target_hit' : null);
    if (dr === 'hit') directionLayer.hit++; else directionLayer.miss++;
    if (de && directionLayer.byEvent[de] != null) directionLayer.byEvent[de]++;
    else directionLayer.byEvent.none++;
    if (er === 'profit') executionLayer.profit++; else if (er === 'loss') executionLayer.loss++; else executionLayer.noexec++;
    if (ee && executionLayer.byEvent[ee] != null) executionLayer.byEvent[ee]++;
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
      directionLayer,
      executionLayer,
      byCloseClass,
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
    if (sig && sig.poolStatus !== 'closed') {
      if (normalizeVersions(sig)) saveSignal(sig, root);
      activeBySymbol.set(sig.symbol, sig);
    }
  }

  const cache = new Map();
  let createdThisRun = 0;
  let versionsAddedThisRun = 0;
  let versionsUpdatedThisRun = 0;

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
      // 同一天只允许一个策略：同交易日新 plan 覆盖旧版本，不追加 V2/V3…
      const sameDay = sameDayVersionOf(existing, plan.meta.signalDate);
      if (sameDay) {
        if (sameDay.runId === plan.meta.runId) {
          // 幂等重跑：只补/改锚定合约，不重置验证状态、不重写计划要素
          if (p.contract && (sameDay.contract !== p.contract || existing.contract !== p.contract)) {
            sameDay.contract = p.contract;
            existing.contract = p.contract;
            saveSignal(existing, root);
          }
          continue;
        }
        if (!MARKET_PROGRESSED_STATUSES.has(sameDay.verification && sameDay.verification.status)) {
          refreshVersionFromPlan(existing, sameDay, plan, p);
          refreshPoolState(existing, sameDay);
          versionsUpdatedThisRun++;
          saveSignal(existing, root);
        }
        continue;
      }
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
          const flipEvents = [{ code: 'flipped', kind: 'exit', label: eventLabel('flipped', 'exit') }];
          applyExitProjection(existing, flipEvents);
          appendObservation(existing, runId, plan.meta.signalDate, flipEvents);
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

  // 2) 追踪：验证 + 价格追踪 + 事件流 + 出池判定 + 两层归因投影
  const updatedSignalIds = [];
  for (const sig of activeBySymbol.values()) {
    // 幂等：同一 run 已处理过该信号（有 observation）则跳过追踪/退出判定
    if (Array.isArray(sig.observations) && sig.observations.some((o) => o.runId === runId)) continue;
    const events = [];
    const pushEvent = (code, kind, extra = {}) => {
      if (events.some((e) => e.code === code && (e.versionId || null) === (extra.versionId || null))) return;
      events.push({ code, kind, label: eventLabel(code, kind), versionId: extra.versionId || null });
    };
    // 本期新版本：初始状态事件（armed / watching / suspended）
    for (const version of sig.versions) {
      if (version.runId === runId) pushEvent(versionInitialState(version), 'execution', { versionId: version.versionId });
    }
    // 版本验证：状态转移事件（旧 verification 状态映射为统一事件）
    for (const version of sig.versions) {
      if (version.runId === runId) continue; // 本期版本下期才开始验证
      if (version.verification.terminal) continue;
      const result = verifyVersion(sig, version, rawData, runId, cache);
      version.verification.status = result.status;
      version.verification.terminal = result.terminal === true || result.status === 'suppressed';
      version.verification.verifiedRunId = runId;
      version.verification.lastResult = result;
      const mode = versionInitialState(version) === 'watching' ? 'signal' : 'trade';
      const evCode = verificationEventOf(result.status, result, mode);
      if (evCode) pushEvent(evCode, 'execution', { versionId: version.versionId });
    }
    // 价格追踪 + 方向事件
    const track = updatePriceTracking(sig, rawData, cache);
    const obsDate = track.bars.length ? track.bars[track.bars.length - 1].date : sig.lastSeenDate;
    if (track.expanded) pushEvent('price_new_high', 'direction');
    const atr = Number(sig.atr5AtCreation);
    const fav = Number(sig.maxFavorablePts);
    const adv = Number(sig.maxAdversePts);
    const start = Number(sig.startClose);
    const latest = Number(sig.latestClose);
    const dirSign = sig.direction === 'bearish' ? -1 : 1;
    if (Number.isFinite(atr) && atr > 0 && Number.isFinite(fav) && Number.isFinite(adv)) {
      if (fav >= atr && fav >= Math.abs(adv)) pushEvent('favorable_1atr', 'direction');
      else if (Math.abs(adv) >= atr && Math.abs(adv) > fav) pushEvent('adverse_1atr', 'direction');
    }
    if (Number.isFinite(start) && Number.isFinite(latest) && (latest - start) * dirSign > 0) pushEvent('close_favorable', 'direction');
    sig.fulfillProgress = fulfillProgressOf(sig);
    sig.invalidationDistance = invalidationDistanceOf(sig);
    // 持仓优先：锚定版本处于持仓/待入场时，信号保持 active，降级计数暂停生效
    if (hasOpenPosition(sig)) sig.poolStatus = 'active';
    // 出池判定：先兑现，后失效（flipped 已在匹配阶段处理）
    if (sig.poolStatus !== 'closed') {
      const cur = currentVersionOf(sig);
      const q5Hit = cur && track.bars.length > 0 ? q5Triggered(sig, cur, track.bars) : false;
      if (hasFulfilled(sig)) {
        closeSignal(sig, 'fulfilled');
        pushEvent('fulfilled', 'exit');
      } else if (q5Hit) {
        closeSignal(sig, 'invalidated_q5');
        pushEvent('q5_hit', 'exit');
      } else if (!hasPendingExecutable(sig)) {
        const barsCount = track.bars.length ? track.bars.length - track.startIdx : 0;
        if (barsCount > 10) {
          closeSignal(sig, 'expired');
          pushEvent('expired', 'exit');
        } else if (sig.consecutiveNonExecutable >= 3 && track.expanded === false) {
          closeSignal(sig, 'faded');
          pushEvent('faded', 'exit');
        }
      }
      if (sig.poolStatus === 'closed') sig.closedAt = obsDate;
    }
    if (sig.poolStatus === 'closed') applyExitProjection(sig, events);
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
      versionsUpdatedThisRun,
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
  hasPendingExecutable,
  hasOpenPosition,
  positionStatusOf,
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
  CLOSE_CLASSES,
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
  versionNumber,
  sameDayVersionOf,
  refreshVersionFromPlan,
  normalizeVersions,
  closeSignal,
  computeVerdict,
  directionVerdictOf,
  executedOutcomesOf,
  executionVerdictOf,
  closeClassOf,
  backfillCloseClass,
  backfillExitProjection,
  applyExitProjection,
  allSignalEventCodes,
  versionInitialState,
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
