/**
 * Pipeline Contract Test
 * 验证 Analyze 阶段契约新增 evidence-packets / reasoning-results，且不改名 report 链路
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { artifacts, stages } from '../../pipeline/contracts.cjs';

describe('Pipeline Analyze 契约', () => {
  const byId = (id) => artifacts.find((a) => a.id === id);
  const stageById = (id) => stages.find((s) => s.id === id);

  test('新增 artifact: evidence-packets-json', () => {
    const a = byId('evidence-packets-json');
    assert.ok(a, 'evidence-packets-json artifact 存在');
    assert.strictEqual(a.stage, 'analyze');
    assert.strictEqual(a.required, true);
  });

  test('新增 artifact: reasoning-results-json', () => {
    const a = byId('reasoning-results-json');
    assert.ok(a, 'reasoning-results-json artifact 存在');
    assert.strictEqual(a.stage, 'analyze');
    assert.strictEqual(a.required, true);
  });

  test('Analyze inputs 保留 filtered-json / raw-json', () => {
    const analyze = stageById('analyze');
    assert.ok(analyze.inputs.includes('filtered-json'));
    assert.ok(analyze.inputs.includes('raw-json'));
  });

  test('Analyze outputs 恰好新增两个 artifact，不拆新 stage', () => {
    const analyze = stageById('analyze');
    assert.deepStrictEqual(analyze.outputs, [
      'evidence-packets-json',
      'reasoning-results-json',
      'analysis-json'
    ]);
  });

  test('report-5b 仍读取 analysis-json，report contract 不改名', () => {
    const report5b = stageById('report-5b');
    assert.ok(report5b.inputs.includes('analysis-json'));
    assert.ok(byId('analysis-json').consumedBy.includes('report-5b'));
  });
});
