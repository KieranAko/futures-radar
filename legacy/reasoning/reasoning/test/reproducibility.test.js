/**
 * P1-4: 四臂重复输出一致性（可复现性）测试
 *
 * 固定 packet（真实 raw.json artifact）→ render → mock LLM → parse → grounding，
 * 每臂重复 RUNS_PER_ARM 次，验证：
 * 1. prompt 渲染逐次一致（render 层无隐藏非确定性）
 * 2. 同一语义模型输出在不同文本包裹格式下解析结果一致（parse 层稳健）
 * 3. direction / pass_reason / evidence_ids 跨次一致率 = 100%
 * 4. grounding 跨次一致
 *
 * 边界声明：mock provider 本身是确定性的；本测试证明"管线注入的非确定性为 0"。
 * 真实 LLM 的输出可复现性（temperature 采样）属 Phase 2 模型层评估，不在 Phase 1 范围。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { buildPacketFromRawJson } from '../lib/raw-adapter.js';
import { buildPacket } from '../lib/packet-builder.js';
import { renderFourArmPrompts } from '../lib/prompt-renderer.js';
import { extractResult } from '../lib/post-processor.js';
import { validateGrounding } from '../lib/grounding-validator.js';
import { RAW_JSON_PATH } from './helpers/fixtures.mjs';
const RUNS_PER_ARM = 12;

// 每臂固定语义输出（11 字段冻结 schema，branch 名与 post-processor 一致）
const ARM_RESULTS = {
  sp: {
    symbol: 'RB0',
    signalDate: '2026-08-04',
    strategy: 'sp',
    direction: 'long',
    confidence: 'high',
    pass_reason: null,
    evidence_ids: ['price_data.close_60d', 'volume_oi.avgVolume5d'],
    opposing_ids: [],
    reasoning_summary: '价格上行且成交量配合',
    invalidate_if: [],
    branch_status: null
  },
  'ust-cot': {
    symbol: 'RB0',
    signalDate: '2026-08-04',
    strategy: 'ust-cot',
    direction: 'long',
    confidence: 'medium',
    pass_reason: null,
    evidence_ids: ['price_data.ma20', 'volume_oi.avgVolume5d'],
    opposing_ids: [],
    reasoning_summary: '价格位于MA20上方',
    invalidate_if: [],
    branch_status: null
  },
  'st-cot': {
    symbol: 'RB0',
    signalDate: '2026-08-04',
    strategy: 'st-cot',
    direction: 'pass',
    confidence: 'low',
    pass_reason: 'conflict_unresolved',
    evidence_ids: ['price_data.close_60d'],
    opposing_ids: ['volume_oi.avgVolume5d'],
    reasoning_summary: '价格与量能信号冲突',
    invalidate_if: [],
    branch_status: null
  },
  fincot: {
    symbol: 'RB0',
    signalDate: '2026-08-04',
    strategy: 'fincot',
    direction: 'long',
    confidence: 'medium',
    pass_reason: null,
    evidence_ids: ['price_data.close_60d', 'volume_oi.avgVolume5d'],
    opposing_ids: [],
    reasoning_summary: 'Regime趋势向上',
    invalidate_if: [],
    branch_status: {
      regime: 'available',
      macro_fundamental: 'abstain',
      position_flow: 'available'
    }
  }
};

const ARM_KEYS = Object.keys(ARM_RESULTS); // ['sp', 'ust-cot', 'st-cot', 'fincot']

// 同一 JSON 语义 × 4 种包裹变体，模拟真实 LLM 输出文本差异
function wrapVariant(result, i) {
  const bare = JSON.stringify(result);
  const variant = i % 4;
  if (variant === 0) return '```json\n' + bare + '\n```';
  if (variant === 1) return '```\n' + bare + '\n```';
  if (variant === 2) return bare;
  return '\n\n' + bare + '\n';
}

function buildRealPacket() {
  const raw = buildPacketFromRawJson(RAW_JSON_PATH, 'RB0', '2026-08-04');
  const { packet, validation } = buildPacket(raw);
  assert.strictEqual(validation.schema.valid, true, '前置：真实packet schema有效');
  assert.strictEqual(validation.timeBoundary.valid, false, '前置：历史artifact应保留真实时间并被时间门禁拒绝');
  assert.strictEqual(packet.quality_check.executable, false, '前置：历史artifact不得作为可执行point-in-time packet');
  return packet;
}

describe('P1-4 四臂重复输出一致性', () => {
  test(`固定真实packet下四臂各重复${RUNS_PER_ARM}次：direction一致率100%`, () => {
    const packet = buildRealPacket();
    let firstPrompts = null;

    for (const arm of ARM_KEYS) {
      const directions = [];
      const passReasons = [];
      const evidenceIds = [];
      let groundedCount = 0;

      for (let i = 0; i < RUNS_PER_ARM; i++) {
        const prompts = renderFourArmPrompts(packet);
        const promptKey = arm === 'sp' ? 'sp' : arm === 'ust-cot' ? 'ustCot' : arm === 'st-cot' ? 'stCot' : 'finCot';
        const prompt = prompts[promptKey];

        // render 层确定性：prompt 逐次一致
        if (i === 0) {
          firstPrompts = prompts;
        } else {
          assert.strictEqual(prompt, firstPrompts[promptKey], `${arm} 第${i + 1}次prompt渲染不一致`);
        }

        const mockOutput = wrapVariant(ARM_RESULTS[arm], i);
        const result = extractResult(mockOutput);
        const grounding = validateGrounding(result, packet);

        directions.push(result.direction);
        passReasons.push(result.pass_reason);
        evidenceIds.push(result.evidence_ids.join(','));
        if (grounding.grounded) groundedCount++;
      }

      const uniqueDirections = new Set(directions);
      assert.strictEqual(uniqueDirections.size, 1,
        `${arm}: direction跨次不一致 ${JSON.stringify(directions)}`);
      assert.strictEqual(directions[0], ARM_RESULTS[arm].direction,
        `${arm}: direction与mock语义输出不符`);

      assert.strictEqual(new Set(passReasons).size, 1,
        `${arm}: pass_reason跨次不一致`);
      assert.strictEqual(new Set(evidenceIds).size, 1,
        `${arm}: evidence_ids跨次不一致`);

      assert.strictEqual(groundedCount, RUNS_PER_ARM,
        `${arm}: grounding跨次不一致 (${groundedCount}/${RUNS_PER_ARM})`);
    }
  });

  test('四个策略名与方向覆盖 long/pass 两类（SP/UST-CoT/FinCoT=long, ST-CoT=pass）', () => {
    // 语义锁定：防止 mock 结果被无意识改动
    assert.strictEqual(ARM_RESULTS.sp.direction, 'long');
    assert.strictEqual(ARM_RESULTS['ust-cot'].direction, 'long');
    assert.strictEqual(ARM_RESULTS['st-cot'].direction, 'pass');
    assert.strictEqual(ARM_RESULTS['st-cot'].pass_reason, 'conflict_unresolved');
    assert.strictEqual(ARM_RESULTS.fincot.direction, 'long');
    assert.deepStrictEqual(Object.keys(ARM_RESULTS.fincot.branch_status).sort(),
      ['macro_fundamental', 'position_flow', 'regime']);
  });
});
