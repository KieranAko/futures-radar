import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { prefillOne } = require('../analysis/v2/prefill-v2.cjs');
const { validateLlmOutputShape } = require('../analysis/v2/assemble-v2.cjs');

function makePacket() {
  return {
    exchange: 'shfe',
    multiplier: 10,
    price_data: { close: 3000, ma20: 3100, ma60: 2900, change5dPct: 1.5, volMultiplier: 1.1, limitPct: 5 },
    volume_oi: { oiChange5dPct: 2 },
  };
}

function makeOutput(overrides = {}) {
  return {
    symbol: 'RB0',
    direction: 'short',
    confidence: 'medium',
    passReason: null,
    q1_driver: { primary: '驱动', secondary: '', evidence: '', source: '' },
    q2_trendOrImpulse: { assessment: '趋势未破坏但短线偏弱' },
    q3_odds: { bias: 'bearish', summary: '偏空' },
    q4_confirmations: { selected: 'short', signals: ['反抽至 3119 不破'] },
    q5_invalidation: { conditions: ['收盘站上 3132'] },
    q6_eventRisk: '隔夜跳空与流动性收紧',
    mechanismRef: { family: 'momentum', mechanismId: null, matchStatus: 'unknown' },
    ...overrides,
  };
}

describe('analyze-v2 权威错位修复（AUTH-01/03/05/06/08）', () => {
  it('prefill 不再产出 Q2 判断，Q6 只保留确定性数值事实并带 provenance', () => {
    const out = prefillOne('RB0', makePacket(), null);
    assert.equal(out.q2, null);
    assert.equal(out.q6.provenance.kind, 'deterministic-facts');
    assert.equal(out.q6.contractValue, 30000);
    assert.ok(!('judgment' in out.q6));
  });

  it('LLM 输出字段齐全时 shape 校验通过', () => {
    const r = validateLlmOutputShape(makeOutput());
    assert.equal(r.ok, true, r.errors.join('; '));
  });

  it('pass 缺 passReason 时 fail-closed，不默认 model_abstain', () => {
    const r = validateLlmOutputShape(makeOutput({ direction: 'pass', passReason: '' }));
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes('passReason')));
  });

  it('q4/q5 缺失时 fail-closed，不兜底 selected:long/空数组', () => {
    const r = validateLlmOutputShape(makeOutput({ q4_confirmations: undefined, q5_invalidation: undefined }));
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes('q4_confirmations')));
    assert.ok(r.errors.some((e) => e.includes('q5_invalidation')));
  });

  it('q2 assessment / q6_eventRisk 缺失时 fail-closed', () => {
    const r = validateLlmOutputShape(makeOutput({ q2_trendOrImpulse: undefined, q6_eventRisk: '' }));
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes('q2_trendOrImpulse')));
    assert.ok(r.errors.some((e) => e.includes('q6_eventRisk')));
  });

  it('mechanismRef 缺失时 fail-closed，不默认 none 占位', () => {
    const r = validateLlmOutputShape(makeOutput({ mechanismRef: undefined }));
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes('mechanismRef')));
  });
});
