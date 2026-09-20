/**
 * Four-Arm End-to-End Test
 * 验证完整链路：packet → render → mock LLM → parse → validate
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { buildPacket } from '../lib/packet-builder.js';
import { renderFourArmPrompts } from '../lib/prompt-renderer.js';
import { extractResult } from '../lib/post-processor.js';
import { validateGrounding } from '../lib/grounding-validator.js';

describe('Four-Arm End-to-End', () => {
  test('SP: packet → render → parse → validate 完整链路', () => {
    // 1. 构建packet
    const raw = {
      symbol: 'RB2501',
      signalDate: '2026-08-15',
      marketCutoffAt: '2026-08-15T15:00:00+08:00',
      packetFrozenAt: '2026-08-15T16:30:00+08:00',
      frozenCommit: 'abc123',
      fields: {
        price_data: {
          source: 'akshare',
          asOf: '2026-08-15T15:00:00+08:00',
          fetchedAt: '2026-08-15T15:05:00+08:00',
          close_60d: [4000, 4100],
          ma20: 4050,
          ma60: 3980,
          freshness: 'same_day',
          gap: null
        },
        volume_oi: {
          source: 'akshare',
          asOf: '2026-08-15T15:00:00+08:00',
          fetchedAt: '2026-08-15T15:06:00+08:00',
          volume_60d: [100000, 110000],
          avgVolume5d: 105000,
          freshness: 'same_day',
          gap: null
        }
      }
    };

    const { packet, validation } = buildPacket(raw);
    assert.strictEqual(validation.schema.valid, true);
    assert.strictEqual(packet.quality_check.executable, true);

    // 2. 渲染prompt
    const prompts = renderFourArmPrompts(packet);
    assert.ok(prompts.sp.includes('RB2501'));
    assert.ok(prompts.sp.includes('2026-08-15'));
    assert.ok(!prompts.sp.includes('{{symbol}}'));

    // 3. 模拟LLM输出（SP策略）
    const mockLLMOutput = `{
  "symbol": "RB2501",
  "signalDate": "2026-08-15",
  "strategy": "sp",
  "direction": "long",
  "confidence": "high",
  "pass_reason": null,
  "evidence_ids": ["price_data.close_60d", "volume_oi.avgVolume5d"],
  "opposing_ids": [],
  "reasoning_summary": "价格突破MA20且成交量放大",
  "invalidate_if": ["价格跌破MA20"],
  "branch_status": null
}`;

    // 4. 解析输出
    const result = extractResult(mockLLMOutput);
    assert.strictEqual(result.symbol, 'RB2501');
    assert.strictEqual(result.strategy, 'sp');
    assert.strictEqual(result.direction, 'long');

    // 5. 验证grounding
    const groundingValidation = validateGrounding(result, packet);
    assert.strictEqual(groundingValidation.grounded, true);
  });

  test('FinCoT: packet → render → parse → validate 完整链路', () => {
    const raw = {
      symbol: 'RB2501',
      signalDate: '2026-08-15',
      marketCutoffAt: '2026-08-15T15:00:00+08:00',
      packetFrozenAt: '2026-08-15T16:30:00+08:00',
      frozenCommit: 'abc123',
      fields: {
        price_data: {
          source: 'akshare',
          asOf: '2026-08-15T15:00:00+08:00',
          fetchedAt: '2026-08-15T15:05:00+08:00',
          close_60d: [4000, 4100],
          ma20: 4050,
          ma60: 3980,
          freshness: 'same_day',
          gap: null
        },
        volume_oi: {
          source: 'akshare',
          asOf: '2026-08-15T15:00:00+08:00',
          fetchedAt: '2026-08-15T15:06:00+08:00',
          volume_60d: [100000, 110000],
          avgVolume5d: 105000,
          freshness: 'same_day',
          gap: null
        },
        basis: {
          source: 'mx-data',
          asOf: '2026-08-15T14:30:00+08:00',
          fetchedAt: '2026-08-15T15:10:00+08:00',
          _published_at: '2026-08-15T14:30:00+08:00',
          value: 50,
          freshness: 'same_day',
          gap: null
        }
      }
    };

    const { packet } = buildPacket(raw);

    // 渲染FinCoT prompt
    const prompts = renderFourArmPrompts(packet);
    assert.ok(prompts.finCot.includes('Regime'));
    assert.ok(prompts.finCot.includes('RB2501'));

    // 模拟FinCoT输出（包含branch_status）
    const mockLLMOutput = `{
  "symbol": "RB2501",
  "signalDate": "2026-08-15",
  "strategy": "fincot",
  "direction": "long",
  "confidence": "medium",
  "pass_reason": null,
  "evidence_ids": ["price_data.ma20", "volume_oi.avgVolume5d", "basis.value"],
  "opposing_ids": [],
  "reasoning_summary": "Regime趋势向上，Macro基差支持",
  "invalidate_if": ["基差转负"],
  "branch_status": {
    "regime": "available",
    "macro_fundamental": "available",
    "position_flow": "abstain"
  }
}`;

    const result = extractResult(mockLLMOutput);
    assert.strictEqual(result.strategy, 'fincot');
    assert.strictEqual(result.branch_status.regime, 'available');
    assert.strictEqual(result.branch_status.macro_fundamental, 'available');
    assert.strictEqual(result.branch_status.position_flow, 'abstain');

    // 验证grounding
    const groundingValidation = validateGrounding(result, packet);
    assert.strictEqual(groundingValidation.grounded, true);
  });

  test('UST-CoT: pass方向必须有pass_reason', () => {
    const raw = {
      symbol: 'RB2501',
      signalDate: '2026-08-15',
      marketCutoffAt: '2026-08-15T15:00:00+08:00',
      packetFrozenAt: '2026-08-15T16:30:00+08:00',
      frozenCommit: 'abc123',
      fields: {
        price_data: {
          source: 'akshare',
          asOf: '2026-08-15T15:00:00+08:00',
          fetchedAt: '2026-08-15T15:05:00+08:00',
          close_60d: [4000],
          ma20: 4050,
          ma60: 3980,
          freshness: 'same_day',
          gap: null
        },
        volume_oi: {
          source: 'akshare',
          asOf: '2026-08-15T15:00:00+08:00',
          fetchedAt: '2026-08-15T15:06:00+08:00',
          volume_60d: [100000],
          avgVolume5d: 105000,
          freshness: 'same_day',
          gap: null
        }
      }
    };

    const { packet } = buildPacket(raw);
    const prompts = renderFourArmPrompts(packet);
    assert.ok(prompts.ustCot.includes('RB2501'));

    // 模拟UST-CoT输出pass方向
    const mockLLMOutput = `{
  "symbol": "RB2501",
  "signalDate": "2026-08-15",
  "strategy": "ust-cot",
  "direction": "pass",
  "confidence": "low",
  "pass_reason": "data_insufficient",
  "evidence_ids": [],
  "opposing_ids": [],
  "reasoning_summary": "数据不足，无法判断",
  "invalidate_if": [],
  "branch_status": null
}`;

    const result = extractResult(mockLLMOutput);
    assert.strictEqual(result.direction, 'pass');
    assert.strictEqual(result.pass_reason, 'data_insufficient');
  });

  test('ST-CoT: 冲突场景应输出pass/conflict_unresolved', () => {
    const raw = {
      symbol: 'RB2501',
      signalDate: '2026-08-15',
      marketCutoffAt: '2026-08-15T15:00:00+08:00',
      packetFrozenAt: '2026-08-15T16:30:00+08:00',
      frozenCommit: 'abc123',
      fields: {
        price_data: {
          source: 'akshare',
          asOf: '2026-08-15T15:00:00+08:00',
          fetchedAt: '2026-08-15T15:05:00+08:00',
          close_60d: [4000, 4100],
          ma20: 4050,
          ma60: 3980,
          freshness: 'same_day',
          gap: null
        },
        volume_oi: {
          source: 'akshare',
          asOf: '2026-08-15T15:00:00+08:00',
          fetchedAt: '2026-08-15T15:06:00+08:00',
          volume_60d: [100000, 90000],
          avgVolume5d: 95000,
          freshness: 'same_day',
          gap: null
        }
      }
    };

    const { packet } = buildPacket(raw);
    const prompts = renderFourArmPrompts(packet);
    assert.ok(prompts.stCot.includes('RB2501'));

    // 模拟ST-CoT冲突输出
    const mockLLMOutput = `{
  "symbol": "RB2501",
  "signalDate": "2026-08-15",
  "strategy": "st-cot",
  "direction": "pass",
  "confidence": "low",
  "pass_reason": "conflict_unresolved",
  "evidence_ids": ["price_data.ma20"],
  "opposing_ids": ["volume_oi.avgVolume5d"],
  "reasoning_summary": "价格看多但成交量萎缩，冲突",
  "invalidate_if": [],
  "branch_status": null
}`;

    const result = extractResult(mockLLMOutput);
    assert.strictEqual(result.direction, 'pass');
    assert.strictEqual(result.pass_reason, 'conflict_unresolved');
  });
});
