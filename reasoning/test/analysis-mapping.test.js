/**
 * Analysis Mapping Test
 * 验证 FinCoT 方向 → analysis 方向的确定性映射与 override 契约
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { mapReasoningDirection, resolveAnalysisDirection } from '../lib/analysis-mapping.js';

describe('mapReasoningDirection', () => {
  test('fincot long → bullish', () => {
    assert.strictEqual(mapReasoningDirection('long'), 'bullish');
  });

  test('fincot short → bearish', () => {
    assert.strictEqual(mapReasoningDirection('short'), 'bearish');
  });

  test('fincot pass → neutral', () => {
    assert.strictEqual(mapReasoningDirection('pass'), 'neutral');
  });

  test('未知方向抛错', () => {
    assert.throws(() => mapReasoningDirection('nonsense'), /direction/);
  });
});

describe('resolveAnalysisDirection', () => {
  test('无 override 且一致时返回映射方向', () => {
    assert.strictEqual(resolveAnalysisDirection('long', 'bullish', null), 'bullish');
    assert.strictEqual(resolveAnalysisDirection('pass', 'neutral', null), 'neutral');
  });

  test('无 override 时方向不一致 fail closed', () => {
    assert.throws(
      () => resolveAnalysisDirection('long', 'bearish', null),
      /override/
    );
    assert.throws(
      () => resolveAnalysisDirection('pass', 'bullish', null),
      /override/
    );
  });

  test('override 预留契约：合法 override 返回 to', () => {
    const override = {
      from: 'neutral',
      to: 'bearish',
      reason: '引用 packet 路径 price_data.ma20 下穿 ma60 的可审计理由'
    };
    assert.strictEqual(resolveAnalysisDirection('pass', 'bearish', override), 'bearish');
  });

  test('override 缺 reason 拒绝', () => {
    assert.throws(
      () => resolveAnalysisDirection('pass', 'bearish', { from: 'neutral', to: 'bearish' }),
      /reason/
    );
  });
});
