import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  planStateOf,
  planReasonsOf,
  verificationEventOf,
  versionStateOf,
  signalStatusOf,
  normalizeEvent,
  eventCodesOf,
  directionResultOfCodes,
  directionEvidenceOfCodes,
  executionEventOfCodes,
  executionResultOfCodes,
  directionResultLabel,
  executionResultLabel
} = require('../strategies/lib/strategy-state.cjs');

describe('strategy-state 统一状态词汇', () => {
  it('plan 初始动作：新 state 优先，旧 executionStatus 兼容映射', () => {
    assert.equal(planStateOf({ state: 'armed' }), 'armed');
    assert.equal(planStateOf({ state: 'watching' }), 'watching');
    assert.equal(planStateOf({ state: 'suspended' }), 'suspended');
    assert.equal(planStateOf({ executionStatus: 'executable' }), 'armed');
    assert.equal(planStateOf({ executionStatus: 'watch' }), 'watching');
    assert.equal(planStateOf({ executionStatus: 'skip' }), 'suspended');
    assert.equal(planStateOf(null), 'watching');
  });

  it('planReasonsOf 新字段优先，旧字段兼容', () => {
    assert.deepEqual(planReasonsOf({ stateReasons: ['a'], statusReasons: ['b'] }), ['a']);
    assert.deepEqual(planReasonsOf({ statusReasons: ['b'] }), ['b']);
    assert.deepEqual(planReasonsOf({}), []);
  });

  it('verificationEventOf：verified 按 exitType 映射', () => {
    assert.equal(verificationEventOf('verified', { exitType: 'target1_hit' }, 'trade'), 'target_hit');
    assert.equal(verificationEventOf('verified', { exitType: 'stopped_out' }, 'trade'), 'stopped_out');
    assert.equal(verificationEventOf('verified', { exitType: 'time_exit', entryPrice: 100, exitPrice: 110 }, 'trade'), 'time_exit_profit');
    assert.equal(verificationEventOf('verified', { exitType: 'time_exit', entryPrice: 100, exitPrice: 90 }, 'trade'), 'time_exit_loss');
    assert.equal(verificationEventOf('invalidated_not_triggered', null, 'trade'), 'trigger_missed');
    assert.equal(verificationEventOf('invalidated_not_triggered', null, 'signal'), 'watch_missed');
    assert.equal(verificationEventOf('skipped_gap', null, 'trade'), 'gap_skipped');
    assert.equal(verificationEventOf('holding', null, 'trade'), 'holding');
    assert.equal(verificationEventOf('suppressed', null, 'trade'), 'suspended');
  });

  it('versionStateOf：终态验证结果优先于初始状态', () => {
    const v = (state, status, lastResult = null) => ({
      state,
      executionStatus: state === 'armed' ? 'executable' : state === 'suspended' ? 'skip' : 'watch',
      verification: { status, lastResult }
    });
    assert.equal(versionStateOf(v('armed', 'pending_verification')), 'armed');
    assert.equal(versionStateOf(v('watching', 'pending_verification')), 'watching');
    assert.equal(versionStateOf(v('suspended', 'pending_verification')), 'suspended');
    assert.equal(versionStateOf(v('armed', 'verified', { exitType: 'time_exit', entryPrice: 100, exitPrice: 90 })), 'time_exit_loss');
    assert.equal(versionStateOf(v('armed', 'holding')), 'holding');
  });

  it('signalStatusOf 投影：closed > holding > ready > armed > observing > suspended', () => {
    assert.equal(signalStatusOf({ poolStatus: 'closed', versions: [] }), 'closed');
    assert.equal(signalStatusOf({ poolStatus: 'active', versions: [{ state: 'holding', verification: { status: 'holding' } }] }), 'holding');
    assert.equal(signalStatusOf({ poolStatus: 'active', versions: [{ state: 'triggered', verification: { status: 'triggered_pending_entry' } }] }), 'ready');
    assert.equal(signalStatusOf({ poolStatus: 'active', versions: [{ state: 'armed', verification: { status: 'pending_verification' } }] }), 'armed');
    assert.equal(signalStatusOf({ poolStatus: 'active', versions: [{ state: 'watching', verification: { status: 'pending_verification' } }] }), 'observing');
    assert.equal(signalStatusOf({ poolStatus: 'active', versions: [{ state: 'suspended', verification: { status: 'pending_verification' } }] }), 'suspended');
  });

  it('事件流投影：方向层与执行层从同一组事件独立得出', () => {
    const codes = eventCodesOf(['armed', 'triggered', 'gap_skipped', 'close_favorable']);
    assert.equal(directionResultOfCodes(codes), 'hit');
    assert.equal(directionEvidenceOfCodes(codes), 'close_favorable');
    assert.equal(executionEventOfCodes(codes), 'gap_skipped');
    assert.equal(executionResultOfCodes(codes), 'noexec');

    const pp = eventCodesOf(['armed', 'triggered', 'holding', 'favorable_1atr', 'time_exit_loss']);
    assert.equal(directionResultOfCodes(pp), 'hit');
    assert.equal(directionEvidenceOfCodes(pp), 'favorable_1atr');
    assert.equal(executionEventOfCodes(pp), 'time_exit_loss');
    assert.equal(executionResultOfCodes(pp), 'loss');

    const against = eventCodesOf(['adverse_1atr', 'stopped_out']);
    assert.equal(directionResultOfCodes(against), 'miss');
    assert.equal(directionEvidenceOfCodes(against), 'adverse_1atr');
    assert.equal(executionResultOfCodes(against), 'loss');

    const win = eventCodesOf(['target_hit']);
    assert.equal(executionEventOfCodes(win), 'target_hit');
    assert.equal(executionResultOfCodes(win), 'profit');
  });

  it('normalizeEvent 兼容字符串事件并推断 kind', () => {
    assert.deepEqual(normalizeEvent('gap_skip'), { code: 'gap_skipped', kind: 'execution', label: '跳空放弃', at: null, versionId: null });
    assert.deepEqual(normalizeEvent('close_favorable').kind, 'direction');
    assert.deepEqual(normalizeEvent('faded').kind, 'exit');
    const obj = normalizeEvent({ code: 'triggered', kind: 'execution', at: '2026-09-16', versionId: 'V1' });
    assert.equal(obj.label, '已触发待入场');
    assert.equal(obj.at, '2026-09-16');
  });

  it('结果标签直接表达因果事件', () => {
    assert.equal(directionResultLabel('hit', 'close_favorable'), '方向正确（终值顺向）');
    assert.equal(directionResultLabel('hit', 'favorable_1atr'), '方向正确（顺向 1 ATR 后回落）');
    assert.equal(directionResultLabel('miss', 'adverse_1atr'), '方向错误（逆向 1 ATR）');
    assert.equal(directionResultLabel('miss', 'none'), '方向错误（双向未出）');
    assert.equal(executionResultLabel('loss', 'time_exit_loss'), '亏损（时间离场亏损）');
    assert.equal(executionResultLabel('noexec', 'gap_skipped'), '未执行（跳空放弃）');
  });
});
