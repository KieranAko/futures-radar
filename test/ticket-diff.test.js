import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  DIFF_SCHEMA,
  diffTickets,
  diffTicketFields,
  relationOfDiff
} = require('../signals/lib/ticket-diff.cjs');

function ticket(overrides = {}) {
  return {
    direction: 'bearish',
    confidence: 'medium',
    entry: {
      trigger: '反抽至 3119 下方不破',
      triggerLevel: 3119,
      triggerSource: 'Q4 / near_term.valueAreaLow',
      triggerTiming: 'T+1 交易日收盘位于 3119 下方',
      execution: 'T+2 开盘入场',
      gapThresholdPts: 13,
      triggerStyle: 'close',
      triggerMode: 'pullback',
      entryZone: { lower: 3106, upper: 3119, lowerBasis: '偏离 >13 放弃', upperBasis: '反抽不破' }
    },
    stop: { stopPrice: 3132, basis: '收盘站上 3132（PDH）' },
    targets: { t1: '3065', t2: '3034', basis: '概率区间下沿' },
    invalidation: { hard: ['收盘站上 3132（PDH）'], timeStop: 'T+4 收盘前离场' },
    maxHoldingDays: 4,
    ...overrides
  };
}

describe('ticket-diff 交易单结构化差异', () => {
  it('相同交易单 → aligned，无差异字段', () => {
    const d = diffTickets(ticket(), ticket());
    assert.equal(d.schema, DIFF_SCHEMA);
    assert.equal(d.relation, 'aligned');
    assert.deepEqual(d.changedFields, []);
  });

  it('价位/止损微调 → refined，完整列出差异', () => {
    const oldT = ticket();
    const newT = ticket({ stop: { stopPrice: 3132, basis: '收盘站上 3132（PDH）' } });
    newT.stop.stopPrice = 3140;
    const d = diffTickets(oldT, newT);
    assert.equal(d.relation, 'refined');
    assert.ok(d.changedFields.some((f) => f.field === 'stop.stopPrice' && f.oldValue === 3132 && f.newValue === 3140));
  });

  it('方向翻转 → conflicted', () => {
    const d = diffTickets(ticket(), ticket({ direction: 'bullish' }));
    assert.equal(d.relation, 'conflicted');
    assert.ok(d.changedFields.some((f) => f.field === 'direction'));
  });

  it('触发结构变化（pullback→breakout）→ conflicted', () => {
    const d = diffTickets(ticket(), ticket({ entry: { ...ticket().entry, triggerMode: 'breakout', trigger: '突破 3119' } }));
    assert.equal(d.relation, 'conflicted');
    assert.ok(d.changedFields.some((f) => f.field === 'entry.triggerMode'));
  });

  it('diffTicketFields 覆盖完整结构化字段', () => {
    const oldT = ticket();
    const newT = JSON.parse(JSON.stringify(oldT));
    newT.entry.triggerLevel = 3120;
    newT.entry.entryZone.upper = 3121;
    newT.targets.t1 = '3050';
    newT.invalidation.timeStop = 'T+3 收盘前离场';
    newT.maxHoldingDays = 3;
    const fields = diffTicketFields(oldT, newT).map((f) => f.field);
    assert.ok(fields.includes('entry.triggerLevel'));
    assert.ok(fields.includes('entry.entryZone.upper'));
    assert.ok(fields.includes('targets.t1'));
    assert.ok(fields.includes('invalidation.timeStop'));
    assert.ok(fields.includes('maxHoldingDays'));
  });
});
