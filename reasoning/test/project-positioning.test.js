/**
 * Project Positioning Test
 * 文档断言：项目重定位为"短期机会分析 + 离线模型回测"
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');

function readDoc(rel) {
  return readFileSync(path.join(ROOT, rel), 'utf8');
}

const SKILL = readDoc('SKILL.md');
const README = readDoc(path.join('backtest', 'README.md'));
const BLUEPRINT = readDoc(path.join('backtest', 'blueprint.md'));
const STATUS = readDoc(path.join('experiments', 'STATUS.md'));
const PHASE1 = readDoc(path.join('reasoning', 'PHASE1_REPORT.md'));

describe('project positioning 文档断言', () => {
  test('SKILL.md 声明"短期机会分析 + 离线模型回测"定位', () => {
    assert.ok(SKILL.includes('短期机会分析 + 离线模型回测'));
  });

  test('SKILL.md 声明 FinCoT 是 Analyze 增强组件', () => {
    assert.ok(SKILL.includes('FinCoT 是 Analyze 增强组件'));
  });

  test('SKILL.md 声明不构成投资建议、不执行真实交易', () => {
    assert.ok(SKILL.includes('不构成投资建议、不执行真实交易'));
  });

  test('backtest/README.md 区分机会命中率与方向优势', () => {
    assert.ok(README.includes('机会命中率不等于方向优势'));
  });

  test('backtest/README.md 声明无 point-in-time 元数据不进 LLM 有效性统计', () => {
    assert.ok(README.includes('历史 cache 无 point-in-time 元数据时不得进入 LLM 有效性统计'));
  });

  test('backtest/blueprint.md 以 T+1 open→T+11 close 为方向收益主口径', () => {
    assert.ok(BLUEPRINT.includes('T+1 open 入场'));
    assert.ok(BLUEPRINT.includes('T+11 close 出场'));
    assert.ok(BLUEPRINT.includes('方向收益主口径'));
  });

  test('STATUS.md 下一步不再是累计未来日期，改为日常分析/离线回测', () => {
    assert.ok(!STATUS.includes('累计正式未来日期'));
    assert.ok(!STATUS.includes('累计真实未来日期'));
    assert.ok(STATUS.includes('日常分析'));
    assert.ok(STATUS.includes('离线回测'));
    assert.ok(STATUS.includes('未启用历史机制'));
  });

  test('STATUS.md header 反映 2026-08-26 当前定位，不残留旧监控口径', () => {
    assert.ok(!STATUS.includes('真实未来记录继续作为长期监控'));
    assert.ok(!STATUS.includes('前向验证工具已就绪，等待后续指示'));
    assert.ok(STATUS.includes('**Last Updated:** 2026-08-26'));
    assert.ok(STATUS.includes('日常分析（pipeline/）'));
    assert.ok(STATUS.includes('离线回测（backtest/'));
  });

  test('PHASE1_REPORT.md 状态标注预测有效性未证明', () => {
    assert.ok(PHASE1.includes('预测有效性未证明'));
    assert.ok(PHASE1.includes('现作为 Analyze/回测基础'));
  });
});
