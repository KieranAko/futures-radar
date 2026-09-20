/**
 * Grounding Validator Test
 * 验证grounding检查和分层样本覆盖率统计（支持嵌套路径）
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { validateGrounding, stratifyGroundingSamples } from '../lib/grounding-validator.js';

describe('Grounding Validator', () => {
  test('嵌套路径存在时grounding通过', () => {
    const result = {
      direction: 'long',
      confidence: 'high',
      evidence_ids: ['price_data.close_60d', 'volume_oi.avgVolume5d'],
      opposing_ids: ['basis.basis_pct']
    };

    const packet = {
      fields: {
        price_data: { close_60d: [4000, 4100], ma20: 4050 },
        volume_oi: { avgVolume5d: 100000, volume_60d: [90000, 100000] },
        basis: { basis_pct: -0.5 }
      }
    };

    const validation = validateGrounding(result, packet);

    assert.strictEqual(validation.grounded, true);
    assert.deepStrictEqual(validation.ungrounded_evidence, []);
    assert.deepStrictEqual(validation.ungrounded_opposing, []);
  });

  test('顶层字段不存在时grounding失败', () => {
    const result = {
      direction: 'long',
      confidence: 'high',
      evidence_ids: ['price_data.close_60d', 'nonexistent.field'],
      opposing_ids: []
    };

    const packet = {
      fields: {
        price_data: { close_60d: [4000, 4100] },
        volume_oi: { avgVolume5d: 100000 }
      }
    };

    const validation = validateGrounding(result, packet);

    assert.strictEqual(validation.grounded, false);
    assert.deepStrictEqual(validation.ungrounded_evidence, ['nonexistent.field']);
  });

  test('嵌套字段不存在时grounding失败', () => {
    const result = {
      direction: 'short',
      confidence: 'medium',
      evidence_ids: ['price_data.close_60d'],
      opposing_ids: ['basis.nonexistent_field']
    };

    const packet = {
      fields: {
        price_data: { close_60d: [4000, 4100], ma20: 4050 },
        basis: { basis_pct: -0.5 }
      }
    };

    const validation = validateGrounding(result, packet);

    assert.strictEqual(validation.grounded, false);
    assert.deepStrictEqual(validation.ungrounded_opposing, ['basis.nonexistent_field']);
  });

  test('字段值为null时grounding失败', () => {
    const result = {
      direction: 'long',
      confidence: 'high',
      evidence_ids: ['price_data.close_60d'],
      opposing_ids: []
    };

    const packet = {
      fields: {
        price_data: { close_60d: null }
      }
    };

    const validation = validateGrounding(result, packet);

    assert.strictEqual(validation.grounded, false);
    assert.deepStrictEqual(validation.ungrounded_evidence, ['price_data.close_60d']);
  });

  test('pass方向空evidence_ids时grounding通过', () => {
    const result = {
      direction: 'pass',
      confidence: 'low',
      evidence_ids: [],
      opposing_ids: []
    };

    const packet = {
      fields: {
        price_data: { close_60d: [4000] }
      }
    };

    const validation = validateGrounding(result, packet);

    assert.strictEqual(validation.grounded, true);
  });
});

describe('Stratified Grounding Coverage', () => {
  test('统计3×4分层矩阵覆盖率', () => {
    const samples = [
      { arm: 'SP', result: { direction: 'long', evidence_ids: ['price_data.close_60d'], opposing_ids: [] }, packet: { fields: { price_data: { close_60d: [4000] } } } },
      { arm: 'UST-CoT', result: { direction: 'long', evidence_ids: ['price_data.close_60d'], opposing_ids: [] }, packet: { fields: { price_data: { close_60d: [4000] } } } },
      { arm: 'ST-CoT', result: { direction: 'short', evidence_ids: ['price_data.close_60d'], opposing_ids: [] }, packet: { fields: { price_data: { close_60d: [4000] } } } },
      { arm: 'FinCoT', result: { direction: 'short', evidence_ids: ['price_data.close_60d'], opposing_ids: [] }, packet: { fields: { price_data: { close_60d: [4000] } } } },
      { arm: 'SP', result: { direction: 'pass', evidence_ids: [], opposing_ids: [] }, packet: { fields: { price_data: { close_60d: [4000] } } } }
    ];

    const stratified = stratifyGroundingSamples(samples);

    assert.strictEqual(stratified.coverage.total_cells, 12);
    assert.strictEqual(stratified.coverage.covered_cells, 5);
    assert.strictEqual(stratified.coverage.matrix.long.SP, 1);
    assert.strictEqual(stratified.coverage.matrix.long['UST-CoT'], 1);
    assert.strictEqual(stratified.coverage.matrix.short['ST-CoT'], 1);
    assert.strictEqual(stratified.coverage.matrix.short.FinCoT, 1);
    assert.strictEqual(stratified.coverage.matrix.pass.SP, 1);
  });

  test('记录每个样本的grounding结果', () => {
    const samples = [
      { arm: 'SP', result: { direction: 'long', evidence_ids: ['price_data.close_60d'], opposing_ids: [] }, packet: { fields: { price_data: { close_60d: [4000] } } } },
      { arm: 'FinCoT', result: { direction: 'short', evidence_ids: ['fake.field'], opposing_ids: [] }, packet: { fields: { price_data: { close_60d: [4000] } } } }
    ];

    const stratified = stratifyGroundingSamples(samples);

    assert.strictEqual(stratified.groundingResults.length, 2);
    assert.strictEqual(stratified.groundingResults[0].grounded, true);
    assert.strictEqual(stratified.groundingResults[1].grounded, false);
    assert.deepStrictEqual(stratified.groundingResults[1].ungrounded_evidence, ['fake.field']);
  });

  test('完整覆盖12个cell时covered_cells=12', () => {
    const samples = [];
    const arms = ['SP', 'UST-CoT', 'ST-CoT', 'FinCoT'];
    const directions = ['long', 'short', 'pass'];

    for (const direction of directions) {
      for (const arm of arms) {
        samples.push({
          arm,
          result: { direction, evidence_ids: ['price_data.close_60d'], opposing_ids: [] },
          packet: { fields: { price_data: { close_60d: [4000] } } }
        });
      }
    }

    const stratified = stratifyGroundingSamples(samples);

    assert.strictEqual(stratified.coverage.covered_cells, 12);
  });
});
