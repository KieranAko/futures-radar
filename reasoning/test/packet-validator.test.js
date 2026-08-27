/**
 * Evidence-Packet Schema + Time Boundary Validator
 * 验证 evidence-packet 的时间边界约束和字段完整性
 *
 * 时间边界约束（4条，v1.3.2 §3）:
 * 1. asOf ≤ marketCutoffAt
 * 2. fetchedAt ≤ packetFrozenAt
 * 3. _published_at ≤ marketCutoffAt
 * 4. 正式packet仅使用 fetchedAt ≤ packetFrozenAt 的evidence
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { validatePacketSchema, validateTimeBoundary } from '../lib/packet-validator.js';

describe('Evidence-Packet Schema Validator', () => {
  test('合法packet通过schema验证', () => {
    const validPacket = {
      symbol: 'RB2501',
      signalDate: '2026-08-15',
      marketCutoffAt: '2026-08-15T15:00:00+08:00',
      packetFrozenAt: '2026-08-15T16:30:00+08:00',
      generatedAt: '2026-08-15T16:30:00+08:00',
      frozenCommit: 'abc123',
      quality_check: {
        executable: true,
        required_available: ['price_data', 'volume_oi'],
        optional_available: ['basis'],
        missing: ['inventory', 'member_position'],
        max_staleness: '3d'
      },
      fields: {
        price_data: {
          source: 'akshare',
          asOf: '2026-08-15T15:00:00+08:00',
          fetchedAt: '2026-08-15T15:05:00+08:00',
          close_60d: [4000, 4100],
          ma20: 4050,
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

    const result = validatePacketSchema(validPacket);
    assert.strictEqual(result.valid, true, '合法packet应通过验证');
    assert.strictEqual(result.errors.length, 0);
  });

  test('缺少必填字段应失败', () => {
    const invalidPacket = {
      symbol: 'RB2501',
      // 缺少 signalDate
      marketCutoffAt: '2026-08-15T15:00:00+08:00',
      packetFrozenAt: '2026-08-15T16:30:00+08:00',
      fields: {}
    };

    const result = validatePacketSchema(invalidPacket);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('signalDate')));
  });
});

describe('Time Boundary Validator', () => {
  test('约束1: asOf ≤ marketCutoffAt', () => {
    const packet = {
      marketCutoffAt: '2026-08-15T15:00:00+08:00',
      packetFrozenAt: '2026-08-15T16:30:00+08:00',
      fields: {
        price_data: {
          asOf: '2026-08-15T15:01:00+08:00',  // 晚于marketCutoffAt
          fetchedAt: '2026-08-15T15:05:00+08:00'
        }
      }
    };

    const result = validateTimeBoundary(packet);
    assert.strictEqual(result.valid, false);
    assert.ok(result.violations.some(v => v.constraint === 'asOf <= marketCutoffAt'));
  });

  test('约束2: fetchedAt ≤ packetFrozenAt', () => {
    const packet = {
      marketCutoffAt: '2026-08-15T15:00:00+08:00',
      packetFrozenAt: '2026-08-15T16:30:00+08:00',
      fields: {
        basis: {
          asOf: '2026-08-15T14:30:00+08:00',
          fetchedAt: '2026-08-15T16:31:00+08:00',  // 晚于packetFrozenAt
          _published_at: '2026-08-15T14:30:00+08:00'
        }
      }
    };

    const result = validateTimeBoundary(packet);
    assert.strictEqual(result.valid, false);
    assert.ok(result.violations.some(v => v.constraint === 'fetchedAt <= packetFrozenAt'));
  });

  test('约束3: _published_at ≤ marketCutoffAt', () => {
    const packet = {
      marketCutoffAt: '2026-08-15T15:00:00+08:00',
      packetFrozenAt: '2026-08-15T16:30:00+08:00',
      fields: {
        inventory: {
          asOf: '2026-08-12T18:00:00+08:00',
          fetchedAt: '2026-08-15T15:20:00+08:00',
          _published_at: '2026-08-15T15:01:00+08:00'  // 晚于marketCutoffAt
        }
      }
    };

    const result = validateTimeBoundary(packet);
    assert.strictEqual(result.valid, false);
    assert.ok(result.violations.some(v => v.constraint === '_published_at <= marketCutoffAt'));
  });

  test('所有约束满足应通过', () => {
    const packet = {
      marketCutoffAt: '2026-08-15T15:00:00+08:00',
      packetFrozenAt: '2026-08-15T16:30:00+08:00',
      fields: {
        price_data: {
          asOf: '2026-08-15T15:00:00+08:00',
          fetchedAt: '2026-08-15T15:05:00+08:00'
        },
        basis: {
          asOf: '2026-08-15T14:30:00+08:00',
          fetchedAt: '2026-08-15T15:10:00+08:00',
          _published_at: '2026-08-15T14:30:00+08:00'
        }
      }
    };

    const result = validateTimeBoundary(packet);
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.violations.length, 0);
  });

  test('price_data缺少asOf应报violation', () => {
    const packet = {
      marketCutoffAt: '2026-08-15T15:00:00+08:00',
      packetFrozenAt: '2026-08-15T16:30:00+08:00',
      fields: {
        price_data: {
          // 缺少asOf
          fetchedAt: '2026-08-15T15:05:00+08:00'
        },
        volume_oi: {
          asOf: '2026-08-15T15:00:00+08:00',
          fetchedAt: '2026-08-15T15:06:00+08:00'
        }
      }
    };

    const result = validateTimeBoundary(packet);
    assert.strictEqual(result.valid, false);
    assert.ok(result.violations.some(v => v.constraint === 'required asOf' && v.field === 'price_data'));
  });

  test('volume_oi缺少fetchedAt应报violation', () => {
    const packet = {
      marketCutoffAt: '2026-08-15T15:00:00+08:00',
      packetFrozenAt: '2026-08-15T16:30:00+08:00',
      fields: {
        price_data: {
          asOf: '2026-08-15T15:00:00+08:00',
          fetchedAt: '2026-08-15T15:05:00+08:00'
        },
        volume_oi: {
          asOf: '2026-08-15T15:00:00+08:00'
          // 缺少fetchedAt
        }
      }
    };

    const result = validateTimeBoundary(packet);
    assert.strictEqual(result.valid, false);
    assert.ok(result.violations.some(v => v.constraint === 'required fetchedAt' && v.field === 'volume_oi'));
  });

  test('无效asOf日期应报violation', () => {
    const packet = {
      marketCutoffAt: '2026-08-15T15:00:00+08:00',
      packetFrozenAt: '2026-08-15T16:30:00+08:00',
      fields: {
        price_data: {
          asOf: 'invalid-date',
          fetchedAt: '2026-08-15T15:05:00+08:00'
        },
        volume_oi: {
          asOf: '2026-08-15T15:00:00+08:00',
          fetchedAt: '2026-08-15T15:06:00+08:00'
        }
      }
    };

    const result = validateTimeBoundary(packet);
    assert.strictEqual(result.valid, false);
    assert.ok(result.violations.some(v => v.constraint === 'valid asOf'));
  });

  test('无效marketCutoffAt应报violation', () => {
    const packet = {
      marketCutoffAt: 'invalid-cutoff',
      packetFrozenAt: '2026-08-15T16:30:00+08:00',
      fields: {
        price_data: {
          asOf: '2026-08-15T15:00:00+08:00',
          fetchedAt: '2026-08-15T15:05:00+08:00'
        },
        volume_oi: {
          asOf: '2026-08-15T15:00:00+08:00',
          fetchedAt: '2026-08-15T15:06:00+08:00'
        }
      }
    };

    const result = validateTimeBoundary(packet);
    assert.strictEqual(result.valid, false);
    assert.ok(result.violations.some(v => v.constraint === 'valid marketCutoffAt'));
  });

  test('可选字段缺少asOf不报violation', () => {
    const packet = {
      marketCutoffAt: '2026-08-15T15:00:00+08:00',
      packetFrozenAt: '2026-08-15T16:30:00+08:00',
      fields: {
        price_data: {
          asOf: '2026-08-15T15:00:00+08:00',
          fetchedAt: '2026-08-15T15:05:00+08:00'
        },
        volume_oi: {
          asOf: '2026-08-15T15:00:00+08:00',
          fetchedAt: '2026-08-15T15:06:00+08:00'
        },
        basis: {
          // 可选字段缺少asOf不应报violation
          fetchedAt: '2026-08-15T15:10:00+08:00'
        }
      }
    };

    const result = validateTimeBoundary(packet);
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.violations.length, 0);
  });
});
