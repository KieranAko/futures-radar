import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { validateStrategyReasoning } = require('../strategies/strategy-reasoning-validate.cjs');

const reportModel = {
  opportunities: [
    { symbol: 'FU0', thesis: { finalDirection: 'bullish', finalConfidence: 'medium' } },
    { symbol: 'SA0', thesis: { finalDirection: 'neutral', finalConfidence: 'low' } }
  ]
};

function strategy(overrides = {}) {
  return {
    symbol: 'FU0',
    direction: 'bullish',
    strategyConfidence: 'medium',
    confidenceDowngradeReasons: [],
    theoryFit: 'approximate',
    theoryGapNote: '趋势动量大致符合，但量能未确认',
    expression: { type: 'pullback', reason: '触发位过远，回踩确认' },
    entry: { trigger: 'x', triggerSource: 'x', triggerLevel: 100, triggerTiming: 'T+1 开盘执行', execution: 'T+1 开盘' },
    stop: { stopPrice: 95, basis: '概率尾' },
    targets: { t1: '110', t2: '120', basis: '概率锥' },
    ...overrides
  };
}

function reasoningWith(s) {
  return { schema: 'futures-radar-strategy-reasoning/1', runId: 'test', strategies: [s] };
}

describe('strategy-reasoning 校验', () => {
  it('approximate + gap note 通过', () => {
    const out = validateStrategyReasoning(reasoningWith(strategy()), reportModel);
    assert.equal(out.ok, true);
  });

  it('none 必须给出降级原因与 gap note', () => {
    const out = validateStrategyReasoning(reasoningWith(strategy({
      symbol: 'SA0',
      direction: 'neutral',
      strategyConfidence: 'low',
      theoryFit: 'none',
      theoryGapNote: null,
      confidenceDowngradeReasons: []
    })), reportModel);
    assert.equal(out.ok, false);
    assert.ok(out.errors.some((e) => e.includes('theoryGapNote')));
    assert.ok(out.errors.some((e) => e.includes('confidenceDowngradeReasons')));
  });

  it('策略置信度不得高于报告置信度', () => {
    const out = validateStrategyReasoning(reasoningWith(strategy({ strategyConfidence: 'high' })), reportModel);
    assert.equal(out.ok, false);
    assert.ok(out.errors.some((e) => e.includes('高于报告置信度')));
  });

  it('reasoning 方向不得与报告 finalDirection 冲突', () => {
    const out = validateStrategyReasoning(reasoningWith(strategy({ direction: 'bearish' })), reportModel);
    assert.equal(out.ok, false);
    assert.ok(out.errors.some((e) => e.includes('finalDirection')));
  });
});
