/**
 * Evidence-Packet Builder Test
 * 验证packet构建器能正确处理原始数据并生成符合schema的packet
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { buildPacket } from '../lib/packet-builder.js';

describe('Packet Builder', () => {
  test('构建合法packet并通过验证', () => {
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

    const result = buildPacket(raw);

    assert.strictEqual(result.validation.schema.valid, true, 'schema验证应通过');
    assert.strictEqual(result.validation.timeBoundary.valid, true, '时间边界验证应通过');
    assert.strictEqual(result.packet.quality_check.executable, true, 'packet应可执行');
    assert.deepStrictEqual(result.packet.quality_check.required_available, ['price_data', 'volume_oi']);
    assert.deepStrictEqual(result.packet.quality_check.optional_available, ['basis']);
  });

  test('缺少必填字段时executable=false', () => {
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
        }
        // 缺少 volume_oi
      }
    };

    const result = buildPacket(raw);

    assert.strictEqual(result.packet.quality_check.executable, false, '缺少必填字段应不可执行');
    assert.ok(result.packet.quality_check.missing.includes('volume_oi'), 'missing应包含volume_oi');
  });

  test('字段违反时间边界时排除该字段', () => {
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
          fetchedAt: '2026-08-15T16:31:00+08:00',  // 晚于packetFrozenAt
          _published_at: '2026-08-15T14:30:00+08:00',
          value: 50,
          freshness: 'same_day',
          gap: null
        }
      }
    };

    const result = buildPacket(raw);

    assert.strictEqual(result.packet.quality_check.executable, true, '必填字段满足时应可执行');
    assert.ok(!result.packet.quality_check.optional_available.includes('basis'), 'basis违反时间边界应被排除');
    assert.ok(result.packet.quality_check.missing.includes('basis'), 'basis应出现在missing中');
  });

  test('packet包含所有必填顶层字段', () => {
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

    const result = buildPacket(raw);

    assert.ok('symbol' in result.packet);
    assert.ok('signalDate' in result.packet);
    assert.ok('marketCutoffAt' in result.packet);
    assert.ok('packetFrozenAt' in result.packet);
    assert.ok('generatedAt' in result.packet);
    assert.ok('frozenCommit' in result.packet);
    assert.ok('quality_check' in result.packet);
    assert.ok('fields' in result.packet);
  });

  test('price_data缺少必填字段时executable=false', () => {
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
          // 缺少close_60d, ma20, ma60
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

    const result = buildPacket(raw);

    assert.strictEqual(result.packet.quality_check.executable, false);
    assert.ok(result.packet.quality_check.missing.includes('price_data'));
  });

  test('freshness超过1d_stale时字段被排除', () => {
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
          freshness: '3d_stale',  // 超过1d_stale
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

    const result = buildPacket(raw);

    assert.strictEqual(result.packet.quality_check.executable, false);
    assert.ok(result.packet.quality_check.missing.includes('price_data'));
  });

  test('gap不为null时字段被排除', () => {
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
          gap: 'missing'  // gap不为null
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

    const result = buildPacket(raw);

    assert.strictEqual(result.packet.quality_check.executable, false);
    assert.ok(result.packet.quality_check.missing.includes('price_data'));
  });

  test('无效日期时字段被排除', () => {
    const raw = {
      symbol: 'RB2501',
      signalDate: '2026-08-15',
      marketCutoffAt: '2026-08-15T15:00:00+08:00',
      packetFrozenAt: '2026-08-15T16:30:00+08:00',
      frozenCommit: 'abc123',
      fields: {
        price_data: {
          source: 'akshare',
          asOf: 'invalid-date',  // 无效日期
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

    const result = buildPacket(raw);

    assert.strictEqual(result.packet.quality_check.executable, false);
    assert.ok(result.packet.quality_check.missing.includes('price_data'));
  });

  test('price_data缺少asOf时executable=false', () => {
    const raw = {
      symbol: 'RB2501',
      signalDate: '2026-08-15',
      marketCutoffAt: '2026-08-15T15:00:00+08:00',
      packetFrozenAt: '2026-08-15T16:30:00+08:00',
      frozenCommit: 'abc123',
      fields: {
        price_data: {
          source: 'akshare',
          // 缺少asOf
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

    const result = buildPacket(raw);

    assert.strictEqual(result.packet.quality_check.executable, false);
    assert.ok(result.packet.quality_check.missing.includes('price_data'));
  });

  test('price_data缺少fetchedAt时executable=false', () => {
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
          // 缺少fetchedAt
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

    const result = buildPacket(raw);

    assert.strictEqual(result.packet.quality_check.executable, false);
    assert.ok(result.packet.quality_check.missing.includes('price_data'));
  });

  test('volume_oi缺少asOf时executable=false', () => {
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
          // 缺少asOf
          fetchedAt: '2026-08-15T15:06:00+08:00',
          volume_60d: [100000, 110000],
          avgVolume5d: 105000,
          freshness: 'same_day',
          gap: null
        }
      }
    };

    const result = buildPacket(raw);

    assert.strictEqual(result.packet.quality_check.executable, false);
    assert.ok(result.packet.quality_check.missing.includes('volume_oi'));
  });

  test('volume_oi缺少fetchedAt时executable=false', () => {
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
          // 缺少fetchedAt
          volume_60d: [100000, 110000],
          avgVolume5d: 105000,
          freshness: 'same_day',
          gap: null
        }
      }
    };

    const result = buildPacket(raw);

    assert.strictEqual(result.packet.quality_check.executable, false);
    assert.ok(result.packet.quality_check.missing.includes('volume_oi'));
  });

  test('term_structure可用时记录到optional_available且不影响executable', () => {
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
        term_structure: {
          source: 'akshare',
          asOf: '2026-08-15T15:00:00+08:00',
          fetchedAt: '2026-08-15T15:10:00+08:00',
          near_contract: 'RB2501',
          main_contract: 'RB0',
          far_contract: 'RB2505',
          near_price: 3520,
          main_price: 3545,
          far_price: 3580,
          spread_pct: 0.99,
          shape: 'contango',
          freshness: 'same_day',
          gap: null
        }
      }
    };

    const result = buildPacket(raw);

    assert.strictEqual(result.packet.quality_check.executable, true);
    assert.ok(result.packet.quality_check.optional_available.includes('term_structure'));
    assert.ok(!result.packet.quality_check.missing.includes('term_structure'));
  });

  test('term_structure缺失时记录到missing且不影响executable', () => {
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
        term_structure: {
          source: 'akshare',
          asOf: '2026-08-15T15:00:00+08:00',
          fetchedAt: '2026-08-15T15:10:00+08:00',
          gap: 'missing'
        }
      }
    };

    const result = buildPacket(raw);

    assert.strictEqual(result.packet.quality_check.executable, true);
    assert.ok(result.packet.quality_check.missing.includes('term_structure'));
    assert.ok(!result.packet.quality_check.optional_available.includes('term_structure'));
  });

  test('term_structure字段不完整（缺spread_pct）→ 降级为missing', () => {
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
        term_structure: {
          source: 'akshare',
          asOf: '2026-08-15T15:00:00+08:00',
          fetchedAt: '2026-08-15T15:10:00+08:00',
          near_contract: 'RB2501',
          main_contract: 'RB0',
          far_contract: 'RB2505',
          near_price: 3520,
          main_price: 3545,
          far_price: 3580,
          shape: 'contango',
          freshness: 'same_day',
          gap: null
        }
      }
    };

    const result = buildPacket(raw);

    assert.strictEqual(result.packet.quality_check.executable, true);
    assert.ok(result.packet.quality_check.missing.includes('term_structure'));
  });

  test('term_structure非法shape → 降级为missing', () => {
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
        term_structure: {
          source: 'akshare',
          asOf: '2026-08-15T15:00:00+08:00',
          fetchedAt: '2026-08-15T15:10:00+08:00',
          near_contract: 'RB2501',
          main_contract: 'RB0',
          far_contract: 'RB2505',
          near_price: 3520,
          main_price: 3545,
          far_price: 3580,
          spread_pct: 0.99,
          shape: 'flat',
          freshness: 'same_day',
          gap: null
        }
      }
    };

    const result = buildPacket(raw);

    assert.strictEqual(result.packet.quality_check.executable, true);
    assert.ok(result.packet.quality_check.missing.includes('term_structure'));
  });
});
