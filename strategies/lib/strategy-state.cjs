// strategies/lib/strategy-state.cjs — 统一状态词汇：事件即状态
//
// 跨板块共享（分析→交易策略→信号池→证伪反馈→渲染）：
//   - 一个版本的一生 = 一串执行事件；当前状态 = 最后一条执行事件；
//   - 方向事件由价格追踪产生，直接解释方向层结果；
//   - 出池时对事件流做两次独立投影：方向层果（hit/miss）+ 执行层果（profit/loss/noexec）；
//   - 出池方式（flipped/q5_hit/faded/expired/fulfilled）只做管理附注，不参与归因。
//
// 旧词兼容映射集中在此处；历史 artifact 只读不迁移。
'use strict';

// ── 执行事件/状态（code → label/terminal/result） ─────────────
const EXECUTION_STATES = {
  armed: { label: '生效观察', terminal: false, result: null, guidance: '按触发条件盯盘，条件到了执行' },
  watching: { label: '观察确认', terminal: false, result: null, guidance: '只观察确认信号，不交易' },
  triggered: { label: '已触发待入场', terminal: false, result: null, guidance: '准备 T+2 开盘执行，偏离超阈值放弃' },
  holding: { label: '持仓中', terminal: false, result: null, guidance: '按止损/目标/时间离场管理' },
  target_hit: { label: '目标兑现', terminal: true, result: 'profit' },
  time_exit_profit: { label: '时间离场盈利', terminal: true, result: 'profit' },
  stopped_out: { label: '止损离场', terminal: true, result: 'loss' },
  time_exit_loss: { label: '时间离场亏损', terminal: true, result: 'loss' },
  gap_skipped: { label: '跳空放弃', terminal: true, result: 'noexec' },
  trigger_missed: { label: '触发未成', terminal: true, result: 'noexec' },
  confirmed: { label: '确认兑现', terminal: true, result: 'noexec' },
  watch_missed: { label: '确认未兑现', terminal: true, result: 'noexec' },
  suspended: { label: '暂停', terminal: true, result: 'noexec' },
  unverifiable: { label: '不可验证', terminal: true, result: 'noexec' }
};

// ── 方向事件（信号级，价格追踪产生） ───────────────────────────
const DIRECTION_EVENTS = {
  price_new_high: '顺向偏移创新高',
  favorable_1atr: '顺向偏移达 1×ATR5',
  adverse_1atr: '逆向偏移达 1×ATR5',
  close_favorable: '终值顺向'
};

// ── 出池方式（管理事件，不参与归因） ───────────────────────────
const EXIT_EVENTS = {
  fulfilled: '目标兑现出池',
  flipped: '反向翻转',
  q5_hit: 'Q5 证伪',
  faded: '机会衰竭',
  expired: '窗口到期'
};

// ── 旧词兼容映射 ──────────────────────────────────────────────
const PLAN_STATE_ALIASES = { executable: 'armed', watch: 'watching', skip: 'suspended' };

const LEGACY_VERIFICATION_EVENT = {
  pending_verification: 'armed',
  pending_data: 'armed',
  triggered_pending_entry: 'triggered',
  holding: 'holding',
  suppressed: 'suspended',
  unverifiable: 'unverifiable',
  confirmed: 'confirmed',
  skipped_gap: 'gap_skipped'
};

// 历史 observation 里的事件字符串 → 统一事件代码
const LEGACY_STRING_ALIASES = {
  gap_skip: 'gap_skipped',
  not_triggered: 'trigger_missed',
  target1_hit: 'target_hit'
};

const EXECUTION_EVENT_PRIORITY = [
  'target_hit', 'time_exit_profit', 'stopped_out', 'time_exit_loss',
  'gap_skipped', 'trigger_missed', 'confirmed', 'watch_missed', 'suspended', 'unverifiable'
];

function isExecutionState(code) {
  return Object.prototype.hasOwnProperty.call(EXECUTION_STATES, code);
}

// plan 的初始动作 = 版本的第一个事件（armed/watching/suspended）
function planStateOf(plan) {
  if (!plan) return 'watching';
  if (isExecutionState(plan.state)) return plan.state;
  return PLAN_STATE_ALIASES[plan.executionStatus] || 'watching';
}

function planReasonsOf(plan) {
  if (Array.isArray(plan.stateReasons)) return plan.stateReasons;
  if (Array.isArray(plan.statusReasons)) return plan.statusReasons;
  return [];
}

// 旧验证状态 → 执行事件；trade 模式未触发 = trigger_missed，signal（watch）模式 = watch_missed
function verificationEventOf(status, result, mode) {
  if (status === 'verified') {
    const exitType = result && result.exitType;
    if (exitType === 'target1_hit') return 'target_hit';
    if (exitType === 'stopped_out') return 'stopped_out';
    if (exitType === 'time_exit') {
      if (result && result.entryPrice != null && result.exitPrice != null && result.exitPrice > result.entryPrice) {
        return 'time_exit_profit';
      }
      return 'time_exit_loss';
    }
    return null;
  }
  if (status === 'invalidated_not_triggered') return mode === 'signal' ? 'watch_missed' : 'trigger_missed';
  return LEGACY_VERIFICATION_EVENT[status] || null;
}

// 版本当前状态：终态验证结果优先；初始状态（armed/watching/suspended）仅在尚未验证时生效
function versionStateOf(version) {
  if (!version) return 'watching';
  const st = version.verification && version.verification.status;
  if (!st || st === 'pending_verification' || st === 'pending_data') {
    if (isExecutionState(version.state)) return version.state;
    return planStateOf(version);
  }
  const mode = version.verificationMode || (version.executionStatus === 'watch' ? 'signal' : 'trade');
  const mapped = verificationEventOf(st, version.verification && version.verification.lastResult, mode);
  if (mapped) return mapped;
  if (isExecutionState(version.state)) return version.state;
  return planStateOf(version);
}

// 信号当前状态投影：closed > holding > ready > armed > observing > suspended
function signalStatusOf(signal) {
  if (!signal || signal.poolStatus === 'closed') return 'closed';
  const states = new Set();
  for (const v of signal.versions || []) states.add(versionStateOf(v));
  if (states.has('holding')) return 'holding';
  if (states.has('triggered')) return 'ready';
  if (states.has('armed')) return 'armed';
  if (states.has('watching')) return 'observing';
  return 'suspended';
}

// ── 事件流工具 ─────────────────────────────────────────────────
function normalizeEvent(entry) {
  if (!entry) return null;
  if (typeof entry === 'string') {
    let code = entry;
    if (Object.prototype.hasOwnProperty.call(LEGACY_STRING_ALIASES, code)) code = LEGACY_STRING_ALIASES[code];
    if (isExecutionState(code)) return { code, kind: 'execution', label: EXECUTION_STATES[code].label, at: null, versionId: null };
    if (Object.prototype.hasOwnProperty.call(DIRECTION_EVENTS, code)) return { code, kind: 'direction', label: DIRECTION_EVENTS[code], at: null, versionId: null };
    if (Object.prototype.hasOwnProperty.call(EXIT_EVENTS, code)) return { code, kind: 'exit', label: EXIT_EVENTS[code], at: null, versionId: null };
    return { code, kind: 'legacy', label: code, at: null, versionId: null };
  }
  const code = entry.code;
  const kind = entry.kind || (isExecutionState(code) ? 'execution'
    : Object.prototype.hasOwnProperty.call(DIRECTION_EVENTS, code) ? 'direction'
    : Object.prototype.hasOwnProperty.call(EXIT_EVENTS, code) ? 'exit'
    : 'legacy');
  return {
    code,
    kind,
    label: entry.label || eventLabel(code, kind),
    at: entry.at || entry.date || null,
    versionId: entry.versionId || null
  };
}

function eventLabel(code, kind) {
  if (!code) return '—';
  if (kind === 'direction') return DIRECTION_EVENTS[code] || String(code);
  if (kind === 'exit') return EXIT_EVENTS[code] || String(code);
  const st = EXECUTION_STATES[code];
  return st ? st.label : String(code);
}

function eventCodesOf(events) {
  const codes = new Set();
  for (const e of events || []) {
    const n = normalizeEvent(e);
    if (n && n.code) codes.add(n.code);
  }
  return codes;
}

// ── 两层归因投影 ──────────────────────────────────────────────
function directionResultOfCodes(codes) {
  return codes.has('close_favorable') || codes.has('favorable_1atr') ? 'hit' : 'miss';
}

function directionEvidenceOfCodes(codes) {
  if (codes.has('close_favorable')) return 'close_favorable';
  if (codes.has('favorable_1atr')) return 'favorable_1atr';
  if (codes.has('adverse_1atr')) return 'adverse_1atr';
  return 'none';
}

function executionEventOfCodes(codes) {
  return EXECUTION_EVENT_PRIORITY.find((c) => codes.has(c)) || null;
}

function executionResultOfCodes(codes) {
  const event = executionEventOfCodes(codes);
  if (!event) return 'noexec';
  const st = EXECUTION_STATES[event];
  return st && st.result ? st.result : 'noexec';
}

// 方向结果中文标签（含依据事件）
function directionResultLabel(result, evidence) {
  const head = result === 'hit' ? '方向正确' : '方向错误';
  if (evidence === 'close_favorable') return `${head}（终值顺向）`;
  if (evidence === 'favorable_1atr') return `${head}（顺向 1 ATR 后回落）`;
  if (evidence === 'adverse_1atr') return `${head}（逆向 1 ATR）`;
  if (result === 'hit') return head;
  return `${head}（双向未出）`;
}

function executionResultLabel(result, evidence) {
  const head = result === 'profit' ? '盈利' : result === 'loss' ? '亏损' : '未执行';
  if (evidence) return `${head}（${eventLabel(evidence, 'execution')}）`;
  return head;
}

module.exports = {
  EXECUTION_STATES,
  DIRECTION_EVENTS,
  EXIT_EVENTS,
  PLAN_STATE_ALIASES,
  LEGACY_VERIFICATION_EVENT,
  EXECUTION_EVENT_PRIORITY,
  isExecutionState,
  planStateOf,
  planReasonsOf,
  verificationEventOf,
  versionStateOf,
  signalStatusOf,
  normalizeEvent,
  eventLabel,
  eventCodesOf,
  directionResultOfCodes,
  directionEvidenceOfCodes,
  executionEventOfCodes,
  executionResultOfCodes,
  directionResultLabel,
  executionResultLabel
};
