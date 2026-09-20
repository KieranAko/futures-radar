/**
 * test/pipeline-contract.test.js — V2 六模块管道契约测试
 *
 * 验收：
 * 1. 六大模块按用户架构编号 1-6 全部存在（stories/analysis/signals/collection/storage/output）。
 * 2. 阶段扁平化列表按数据流执行顺序排列。
 * 3. 每个 auto 阶段脚本文件存在，且输入/输出 artifact id 可解析。
 * 4. filter-llm / scanner / quantitative-filter 不再出现在管道阶段中。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const { artifacts, phases, stages } = require('../pipeline/contracts.cjs');

const byId = (id) => artifacts.find((a) => a.id === id);
const stageById = (id) => stages.find((s) => s.id === id);

describe('V2 六模块管道契约', () => {
  test('六大模块 phases 全部存在且 seq 按用户架构编号', () => {
    assert.deepEqual(
      phases.map((p) => p.seq).sort((a, b) => a - b),
      [1, 2, 3, 4, 5, 6]
    );
    const bySeq = Object.fromEntries(phases.map((p) => [p.seq, p]));
    assert.equal(bySeq[1].module, 'stories');
    assert.equal(bySeq[2].module, 'analysis');
    assert.equal(bySeq[3].module, 'signals');
    assert.equal(bySeq[4].module, 'collection');
    assert.equal(bySeq[5].module, 'storage');
    assert.equal(bySeq[6].module, 'output');
  });

  test('阶段按数据流执行顺序排列：采集 → 文件库 → 故事链 → 机会分析 → 信号池 → 输出', () => {
    const phaseOrder = [];
    for (const s of stages) {
      if (!phaseOrder.includes(s.phase)) phaseOrder.push(s.phase);
    }
    assert.deepEqual(phaseOrder, [
      'data-collection',
      'file-library',
      'story-chain',
      'opportunity-analysis',
      'signal-pool',
      'result-output'
    ]);
  });

  test('filter-llm / scanner / quantitative-filter 已退役，不出现在管道阶段中', () => {
    const scripts = stages.map((s) => s.script || '').join(' ');
    assert.ok(!scripts.includes('filter/'), scripts);
    assert.ok(!scripts.includes('scanner/'), scripts);
    assert.ok(!scripts.includes('filter-llm'), scripts);
  });

  test('每个 auto 阶段的脚本存在', () => {
    for (const s of stages.filter((x) => x.auto)) {
      assert.ok(s.script, `${s.id} 缺少 script`);
      assert.ok(fs.existsSync(path.join(ROOT, s.script)), `${s.id} 脚本不存在: ${s.script}`);
    }
  });

  test('阶段输入/输出引用的 artifact id 全部可解析', () => {
    for (const s of stages) {
      for (const id of [...(s.inputs || []), ...(s.outputs || [])]) {
        assert.ok(byId(id), `${s.id} 引用了未定义 artifact: ${id}`);
      }
    }
  });

  test('关键 V2 artifact 契约存在', () => {
    const expect = [
      'story-pool-ledger',
      'filtered-json',
      'candidates-json',
      'packets-v2-json',
      'outputs-v2-json',
      'analysis-json',
      'probability-json',
      'report-model-json',
      'strategy-plan-json',
      'signal-pool-json',
      'report'
    ];
    for (const id of expect) assert.ok(byId(id), `${id} artifact 缺失`);
  });

  test('story-filtered 阶段是 filtered.json 的唯一 KEEP 来源（filter-llm 退役）', () => {
    const s = stageById('story-filtered');
    assert.ok(s.outputs.includes('filtered-json'));
    assert.ok(s.script.endsWith('build-filtered-from-story-pool.cjs'));
  });

  test('strategy-plan 阶段属于信号池模块并产出 signal-pool-json', () => {
    const s = stageById('strategy-plan');
    assert.equal(s.phase, 'signal-pool');
    assert.ok(s.outputs.includes('signal-pool-json'));
  });
});
