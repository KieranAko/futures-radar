import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { applyTrackingSeats } = require('../signals/seats/apply-tracking-seats.cjs');

function poolSignal(symbol, overrides = {}) {
  return {
    signalId: `SIG-${symbol}-20260911-01`,
    symbol,
    name: symbol,
    direction: 'bullish',
    poolStatus: 'downgraded',
    createdDate: '2026-09-11',
    thesis: '测试驱动',
    versions: [{ versionId: `SIG-${symbol}-20260911-01:V1`, executionStatus: 'watch', confidence: 'medium' }],
    currentVersionId: `SIG-${symbol}-20260911-01:V1`,
    ...overrides
  };
}

describe('signal-pool 追踪席位注入', () => {
  it('把池内信号加入 KEEP 并从 downgraded 移除', () => {
    const filtered = {
      meta: { runId: 'r1', outputCount: 1, note: '初筛' },
      candidates: [{ symbol: 'PP0', rank: 1, directionHint: 'bullish', directionBias: 'bullish', decision: 'KEEP', confidence: 'medium', reason: 'x', informationGap: 'y' }],
      downgraded: [{ symbol: 'TA0', reason: '降级' }]
    };
    const { filtered: out, added } = applyTrackingSeats(filtered, [poolSignal('TA0')], '2026-09-15T00:00:00Z');
    assert.deepEqual(added, ['TA0']);
    assert.equal(out.candidates.length, 2);
    const t = out.candidates.find((c) => c.symbol === 'TA0');
    assert.equal(t.decision, 'KEEP');
    assert.equal(t.tracking, true);
    assert.equal(t.signalId, 'SIG-TA0-20260911-01');
    assert.equal(t.directionHint, 'bullish');
    assert.equal(t.author, 'machine-seat');
    assert.equal(out.meta.seatAuthor, 'machine-seat');
    assert.equal(out.downgraded.length, 0);
    assert.equal(out.meta.outputCount, 2);
    assert.equal(out.meta.trackingSeats, 1);
  });

  it('已在 KEEP 中的池内信号不重复添加', () => {
    const filtered = {
      meta: { runId: 'r1', outputCount: 1 },
      candidates: [{ symbol: 'TA0', rank: 1, directionHint: 'bullish', directionBias: 'bullish', decision: 'KEEP', confidence: 'medium', reason: 'x', informationGap: 'y' }],
      downgraded: []
    };
    const { filtered: out, added } = applyTrackingSeats(filtered, [poolSignal('TA0')], '2026-09-15T00:00:00Z');
    assert.deepEqual(added, []);
    assert.equal(out.candidates.length, 1);
    assert.equal(out.meta.trackingSeats, 0);
  });

  it('空池不变更 filtered', () => {
    const filtered = {
      meta: { runId: 'r1', outputCount: 1 },
      candidates: [{ symbol: 'PP0', rank: 1, directionHint: 'bullish', directionBias: 'bullish', decision: 'KEEP', confidence: 'medium', reason: 'x', informationGap: 'y' }],
      downgraded: [{ symbol: 'TA0', reason: '降级' }]
    };
    const { filtered: out, added } = applyTrackingSeats(filtered, [], '2026-09-15T00:00:00Z');
    assert.deepEqual(added, []);
    assert.equal(out.candidates.length, 1);
    assert.equal(out.downgraded.length, 1);
  });
});
