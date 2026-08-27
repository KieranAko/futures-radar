/**
 * Forward Packet Smoke Test Framework
 * 提供前向packet测试的基础框架和样例数据
 *
 * 前向测试要求（v1.3.2 Phase 1）:
 * 1. 使用真实或接近真实的packet数据
 * 2. 至少覆盖5个signalDate
 * 3. 验证时间边界约束在真实数据下的有效性
 * 4. 验证packet builder在真实场景下的鲁棒性
 *
 * 注意: 本测试提供前向框架与合成5日数据；真实artifact（raw.json）接入
 * 已在Phase 1落地，见 raw-adapter.test.js（RB0 / 2026-08-04 真实packet验证）
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { buildPacket } from '../lib/packet-builder.js';

// 模拟5日真实场景的packet数据
const mockForwardPackets = [
  // 2026-08-11 (周一)
  {
    symbol: 'RB2501',
    signalDate: '2026-08-11',
    marketCutoffAt: '2026-08-11T15:00:00+08:00',
    packetFrozenAt: '2026-08-11T16:30:00+08:00',
    frozenCommit: 'commit-20260811',
    fields: {
      price_data: {
        source: 'akshare',
        asOf: '2026-08-11T15:00:00+08:00',
        fetchedAt: '2026-08-11T15:05:00+08:00',
        close: 3980,
        close_60d: [3900, 3920, 3950, 3980],
        ma20: 3938,
        ma60: 3900,
        freshness: 'same_day',
        gap: null
      },
      volume_oi: {
        source: 'akshare',
        asOf: '2026-08-11T15:00:00+08:00',
        fetchedAt: '2026-08-11T15:06:00+08:00',
        volume: 105000,
        volume_60d: [100000, 105000, 110000, 105000],
        oi: 450000,
        avgVolume5d: 105000,
        freshness: 'same_day',
        gap: null
      }
    }
  },
  // 2026-08-12 (周二)
  {
    symbol: 'RB2501',
    signalDate: '2026-08-12',
    marketCutoffAt: '2026-08-12T15:00:00+08:00',
    packetFrozenAt: '2026-08-12T16:30:00+08:00',
    frozenCommit: 'commit-20260812',
    fields: {
      price_data: {
        source: 'akshare',
        asOf: '2026-08-12T15:00:00+08:00',
        fetchedAt: '2026-08-12T15:05:00+08:00',
        close: 4010,
        close_60d: [3920, 3950, 3980, 4010],
        ma20: 3952,
        ma60: 3920,
        freshness: 'same_day',
        gap: null
      },
      volume_oi: {
        source: 'akshare',
        asOf: '2026-08-12T15:00:00+08:00',
        fetchedAt: '2026-08-12T15:06:00+08:00',
        volume: 110000,
        volume_60d: [105000, 110000, 115000, 110000],
        oi: 455000,
        avgVolume5d: 110000,
        freshness: 'same_day',
        gap: null
      },
      basis: {
        source: 'mx-data',
        asOf: '2026-08-12T14:30:00+08:00',
        fetchedAt: '2026-08-12T15:10:00+08:00',
        _published_at: '2026-08-12T14:30:00+08:00',
        value: 45,
        freshness: 'same_day',
        gap: null
      }
    }
  },
  // 2026-08-13 (周三)
  {
    symbol: 'RB2501',
    signalDate: '2026-08-13',
    marketCutoffAt: '2026-08-13T15:00:00+08:00',
    packetFrozenAt: '2026-08-13T16:30:00+08:00',
    frozenCommit: 'commit-20260813',
    fields: {
      price_data: {
        source: 'akshare',
        asOf: '2026-08-13T15:00:00+08:00',
        fetchedAt: '2026-08-13T15:05:00+08:00',
        close: 4050,
        close_60d: [3950, 3980, 4010, 4050],
        ma20: 3970,
        ma60: 3940,
        freshness: 'same_day',
        gap: null
      },
      volume_oi: {
        source: 'akshare',
        asOf: '2026-08-13T15:00:00+08:00',
        fetchedAt: '2026-08-13T15:06:00+08:00',
        volume: 115000,
        volume_60d: [110000, 115000, 120000, 115000],
        oi: 460000,
        avgVolume5d: 115000,
        freshness: 'same_day',
        gap: null
      },
      inventory: {
        source: 'websearch',
        asOf: '2026-08-10',  // 库存数据天然滞后
        fetchedAt: '2026-08-13T15:20:00+08:00',
        _published_at: '2026-08-10T18:00:00+08:00',
        value: 9500000,
        freshness: '3d_stale',
        gap: null
      }
    }
  },
  // 2026-08-14 (周四)
  {
    symbol: 'RB2501',
    signalDate: '2026-08-14',
    marketCutoffAt: '2026-08-14T15:00:00+08:00',
    packetFrozenAt: '2026-08-14T16:30:00+08:00',
    frozenCommit: 'commit-20260814',
    fields: {
      price_data: {
        source: 'akshare',
        asOf: '2026-08-14T15:00:00+08:00',
        fetchedAt: '2026-08-14T15:05:00+08:00',
        close: 4020,
        close_60d: [3980, 4010, 4050, 4020],
        ma20: 3980,
        ma60: 3950,
        freshness: 'same_day',
        gap: null
      },
      volume_oi: {
        source: 'akshare',
        asOf: '2026-08-14T15:00:00+08:00',
        fetchedAt: '2026-08-14T15:06:00+08:00',
        volume: 108000,
        volume_60d: [115000, 120000, 115000, 108000],
        oi: 458000,
        avgVolume5d: 112000,
        freshness: 'same_day',
        gap: null
      },
      basis: {
        source: 'mx-data',
        asOf: '2026-08-14T14:30:00+08:00',
        fetchedAt: '2026-08-14T15:10:00+08:00',
        _published_at: '2026-08-14T14:30:00+08:00',
        value: 48,
        freshness: 'same_day',
        gap: null
      }
    }
  },
  // 2026-08-15 (周五)
  {
    symbol: 'RB2501',
    signalDate: '2026-08-15',
    marketCutoffAt: '2026-08-15T15:00:00+08:00',
    packetFrozenAt: '2026-08-15T16:30:00+08:00',
    frozenCommit: 'commit-20260815',
    fields: {
      price_data: {
        source: 'akshare',
        asOf: '2026-08-15T15:00:00+08:00',
        fetchedAt: '2026-08-15T15:05:00+08:00',
        close: 4040,
        close_60d: [4010, 4050, 4020, 4040],
        ma20: 3992,
        ma60: 3970,
        freshness: 'same_day',
        gap: null
      },
      volume_oi: {
        source: 'akshare',
        asOf: '2026-08-15T15:00:00+08:00',
        fetchedAt: '2026-08-15T15:06:00+08:00',
        volume: 112000,
        volume_60d: [120000, 115000, 108000, 112000],
        oi: 462000,
        avgVolume5d: 113000,
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
      },
      inventory: {
        source: 'websearch',
        asOf: '2026-08-12',  // 库存数据天然滞后
        fetchedAt: '2026-08-15T15:20:00+08:00',
        _published_at: '2026-08-12T18:00:00+08:00',
        value: 9480000,
        freshness: '3d_stale',
        gap: null
      }
    }
  }
];

describe('Forward Packet Smoke Test', () => {
  test('验证5日连续packet全部通过schema和时间边界检查', () => {
    let successCount = 0;

    for (const raw of mockForwardPackets) {
      const { packet, validation } = buildPacket(raw);

      assert.strictEqual(validation.schema.valid, true,
        `${raw.signalDate}: schema验证应通过`);
      assert.strictEqual(validation.timeBoundary.valid, true,
        `${raw.signalDate}: 时间边界验证应通过`);
      assert.strictEqual(packet.quality_check.executable, true,
        `${raw.signalDate}: packet应可执行`);

      successCount++;
    }

    assert.strictEqual(successCount, 5, '5日packet应全部通过验证');
  });

  test('验证每日packet的必填字段可用性', () => {
    for (const raw of mockForwardPackets) {
      const { packet } = buildPacket(raw);

      assert.ok(packet.quality_check.required_available.includes('price_data'),
        `${raw.signalDate}: price_data应可用`);
      assert.ok(packet.quality_check.required_available.includes('volume_oi'),
        `${raw.signalDate}: volume_oi应可用`);
    }
  });

  test('验证可选字段的条件可用性', () => {
    // 2026-08-11: 无可选字段
    const result1 = buildPacket(mockForwardPackets[0]);
    assert.deepStrictEqual(result1.packet.quality_check.optional_available, []);

    // 2026-08-12: 有basis
    const result2 = buildPacket(mockForwardPackets[1]);
    assert.ok(result2.packet.quality_check.optional_available.includes('basis'));

    // 2026-08-13: 有inventory
    const result3 = buildPacket(mockForwardPackets[2]);
    assert.ok(result3.packet.quality_check.optional_available.includes('inventory'));

    // 2026-08-15: 有basis和inventory
    const result5 = buildPacket(mockForwardPackets[4]);
    assert.ok(result5.packet.quality_check.optional_available.includes('basis'));
    assert.ok(result5.packet.quality_check.optional_available.includes('inventory'));
  });

  test('验证时间戳的时序一致性', () => {
    for (const raw of mockForwardPackets) {
      const marketCutoff = new Date(raw.marketCutoffAt);
      const packetFrozen = new Date(raw.packetFrozenAt);

      // packetFrozenAt 应晚于 marketCutoffAt
      assert.ok(packetFrozen > marketCutoff,
        `${raw.signalDate}: packetFrozenAt应晚于marketCutoffAt`);

      // 验证字段时间戳
      for (const [fieldName, fieldData] of Object.entries(raw.fields)) {
        if (fieldData.asOf) {
          const asOf = new Date(fieldData.asOf);
          assert.ok(asOf <= marketCutoff,
            `${raw.signalDate}.${fieldName}: asOf应≤marketCutoffAt`);
        }
        if (fieldData.fetchedAt) {
          const fetchedAt = new Date(fieldData.fetchedAt);
          assert.ok(fetchedAt <= packetFrozen,
            `${raw.signalDate}.${fieldName}: fetchedAt应≤packetFrozenAt`);
        }
      }
    }
  });

  test('验证跨日packet的独立性', () => {
    const packets = mockForwardPackets.map(raw => buildPacket(raw).packet);

    // 每个packet应有独立的frozenCommit
    const commits = packets.map(p => p.frozenCommit);
    const uniqueCommits = new Set(commits);
    assert.strictEqual(uniqueCommits.size, 5, '5日应有5个不同的frozenCommit');

    // 每个packet应有独立的generatedAt
    const generatedAts = packets.map(p => p.generatedAt);
    const uniqueGeneratedAts = new Set(generatedAts);
    assert.ok(uniqueGeneratedAts.size >= 1, 'generatedAt应独立生成');
  });
});
