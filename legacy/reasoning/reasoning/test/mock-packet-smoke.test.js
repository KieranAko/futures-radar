/**
 * Mock Packet Smoke Test
 * 验证整个流程的schema一致性和可复现性
 *
 * 测试目标:
 * 1. Schema一致性: 手工构造的packet通过schema和时间边界验证
 * 2. 可复现性: 相同packet多次处理产生相同的验证结果
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { buildPacket } from '../lib/packet-builder.js';
import { validatePacketSchema, validateTimeBoundary } from '../lib/packet-validator.js';
import { extractResult } from '../lib/post-processor.js';
import { validateGrounding } from '../lib/grounding-validator.js';

describe('Mock Packet Smoke Test', () => {
  test('完整流程: 构建packet → 验证schema → 验证时间边界 → 处理输出 → 验证grounding', () => {
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

    const { packet, validation } = buildPacket(raw);

    // 2. 验证schema
    assert.strictEqual(validation.schema.valid, true, 'schema验证应通过');

    // 3. 验证时间边界
    assert.strictEqual(validation.timeBoundary.valid, true, '时间边界验证应通过');

    // 4. 验证quality_check
    assert.strictEqual(packet.quality_check.executable, true, 'packet应可执行');
    assert.deepStrictEqual(packet.quality_check.required_available, ['price_data', 'volume_oi']);
    assert.deepStrictEqual(packet.quality_check.optional_available, ['basis']);

    // 5. 模拟LLM输出并提取结果
    const mockLLMOutput = `{
  "symbol": "RB2501",
  "signalDate": "2026-08-15",
  "strategy": "sp",
  "direction": "long",
  "confidence": "high",
  "pass_reason": null,
  "evidence_ids": ["price_data.close_60d", "volume_oi.avgVolume5d"],
  "opposing_ids": ["basis.value"],
  "reasoning_summary": "价格上穿MA20且成交量放大",
  "invalidate_if": ["若价格跌破MA20"],
  "branch_status": null
}`;

    const result = extractResult(mockLLMOutput);

    assert.strictEqual(result.symbol, 'RB2501');
    assert.strictEqual(result.signalDate, '2026-08-15');
    assert.strictEqual(result.strategy, 'sp');
    assert.strictEqual(result.direction, 'long');
    assert.strictEqual(result.confidence, 'high');

    // 6. 验证grounding
    const groundingValidation = validateGrounding(result, packet);

    assert.strictEqual(groundingValidation.grounded, true, 'grounding验证应通过');
    assert.deepStrictEqual(groundingValidation.ungrounded_evidence, []);
    assert.deepStrictEqual(groundingValidation.ungrounded_opposing, []);
  });

  test('可复现性: 相同输入产生相同验证结果', () => {
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
          close_60d: [4000, 4100]
        },
        volume_oi: {
          source: 'akshare',
          asOf: '2026-08-15T15:00:00+08:00',
          fetchedAt: '2026-08-15T15:06:00+08:00',
          volume_60d: [100000, 110000]
        }
      }
    };

    // 运行3次
    const results = [];
    for (let i = 0; i < 3; i++) {
      const { packet, validation } = buildPacket(raw);
      results.push({
        schemaValid: validation.schema.valid,
        timeBoundaryValid: validation.timeBoundary.valid,
        executable: packet.quality_check.executable,
        requiredAvailable: packet.quality_check.required_available,
        optionalAvailable: packet.quality_check.optional_available
      });
    }

    // 验证3次结果完全一致
    assert.deepStrictEqual(results[0], results[1]);
    assert.deepStrictEqual(results[1], results[2]);
  });

  test('时间边界负例: asOf晚于marketCutoffAt应被排除', () => {
    const raw = {
      symbol: 'RB2501',
      signalDate: '2026-08-15',
      marketCutoffAt: '2026-08-15T15:00:00+08:00',
      packetFrozenAt: '2026-08-15T16:30:00+08:00',
      frozenCommit: 'abc123',
      fields: {
        price_data: {
          source: 'akshare',
          asOf: '2026-08-15T15:01:00+08:00',  // 晚于marketCutoffAt
          fetchedAt: '2026-08-15T15:05:00+08:00',
          close_60d: [4000, 4100]
        },
        volume_oi: {
          source: 'akshare',
          asOf: '2026-08-15T15:00:00+08:00',
          fetchedAt: '2026-08-15T15:06:00+08:00',
          volume_60d: [100000, 110000]
        }
      }
    };

    const { packet } = buildPacket(raw);

    // price_data违反时间边界应被排除
    assert.strictEqual(packet.quality_check.executable, false, 'price_data被排除后应不可执行');
    assert.ok(!packet.quality_check.required_available.includes('price_data'));
    assert.ok(packet.quality_check.missing.includes('price_data'));
  });

  test('时间边界负例: fetchedAt晚于packetFrozenAt应被排除', () => {
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
          close_60d: [4000, 4100]
        },
        volume_oi: {
          source: 'akshare',
          asOf: '2026-08-15T15:00:00+08:00',
          fetchedAt: '2026-08-15T15:06:00+08:00',
          volume_60d: [100000, 110000]
        },
        basis: {
          source: 'mx-data',
          asOf: '2026-08-15T14:30:00+08:00',
          fetchedAt: '2026-08-15T16:31:00+08:00',  // 晚于packetFrozenAt
          _published_at: '2026-08-15T14:30:00+08:00',
          value: 50
        }
      }
    };

    const { packet } = buildPacket(raw);

    // basis违反时间边界应被排除
    assert.ok(!packet.quality_check.optional_available.includes('basis'));
    assert.ok(packet.quality_check.missing.includes('basis'));
  });

  test('时间边界负例: _published_at晚于marketCutoffAt应被排除', () => {
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
          close_60d: [4000, 4100]
        },
        volume_oi: {
          source: 'akshare',
          asOf: '2026-08-15T15:00:00+08:00',
          fetchedAt: '2026-08-15T15:06:00+08:00',
          volume_60d: [100000, 110000]
        },
        inventory: {
          source: 'websearch',
          asOf: '2026-08-12',
          fetchedAt: '2026-08-15T15:20:00+08:00',
          _published_at: '2026-08-15T15:01:00+08:00',  // 晚于marketCutoffAt
          value: 1000
        }
      }
    };

    const { packet } = buildPacket(raw);

    // inventory违反时间边界应被排除
    assert.ok(!packet.quality_check.optional_available.includes('inventory'));
    assert.ok(packet.quality_check.missing.includes('inventory'));
  });
});
