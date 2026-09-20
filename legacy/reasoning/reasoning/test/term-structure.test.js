/**
 * Term Structure Test
 * 纯函数测试：合约候选生成 / 合约挑选 / 字段构造（不依赖网络）
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';
import {
  commodityPrefix,
  resolveContractCandidates,
  pickContract,
  resolveDominantContract,
  resolveFarContract,
  buildTermStructureField,
  assembleTermStructure
} from '../lib/term-structure-core.js';
import { fetchNearFarCloses } from '../lib/term-structure.js';

describe('Term Structure — commodityPrefix', () => {
  test('主力连续代码剥离数字后缀', () => {
    assert.strictEqual(commodityPrefix('RB0'), 'RB');
    assert.strictEqual(commodityPrefix('SA0'), 'SA');
    assert.strictEqual(commodityPrefix('I0'), 'I');
    assert.strictEqual(commodityPrefix('IF0'), 'IF');
  });
});

describe('Term Structure — resolveContractCandidates', () => {
  test('2026-08-04：近月 [2609,2610,2608]，远月 [2611..2705]', () => {
    const { near, far } = resolveContractCandidates('2026-08-04');
    assert.deepStrictEqual(near, ['2609', '2610', '2608']);
    assert.deepStrictEqual(far, ['2611', '2612', '2701', '2702', '2703', '2704', '2705']);
  });

  test('2026-11-15：跨年滚动正确', () => {
    const { near, far } = resolveContractCandidates('2026-11-15');
    assert.deepStrictEqual(near, ['2612', '2701', '2611']);
    assert.deepStrictEqual(far, ['2702', '2703', '2704', '2705', '2706', '2707', '2708']);
  });

  test('2026-12-20：年底跨年', () => {
    const { near, far } = resolveContractCandidates('2026-12-20');
    assert.deepStrictEqual(near, ['2701', '2702', '2612']);
    assert.deepStrictEqual(far, ['2703', '2704', '2705', '2706', '2707', '2708', '2709']);
  });
});

describe('Term Structure — pickContract', () => {
  const contractsResult = {
    RB2608: { contract: 'RB2608', available: false, reason: 'illiquid' },
    RB2609: { contract: 'RB2609', available: true, close: 3520, hold: 30000 },
    RB2610: { contract: 'RB2610', available: true, close: 3545, hold: 900000 },
    RB2701: { contract: 'RB2701', available: true, close: 3580, hold: 500000 },
    RB2702: { contract: 'RB2702', available: true, close: 3560, hold: 10000 }
  };

  test('挑选持仓量最大的可用合约（RB2610 主力月）', () => {
    const near = pickContract(contractsResult, ['2609', '2610', '2608'], 'RB');
    assert.deepStrictEqual(near, { contract: 'RB2610', price: 3545 });
  });

  test('跳过不可用合约后仍按持仓量挑选', () => {
    const near = pickContract(contractsResult, ['2608', '2609', '2610'], 'RB');
    assert.deepStrictEqual(near, { contract: 'RB2610', price: 3545 });
  });

  test('排除与近月重复的远月，选剩余持仓量最大（RB2701）', () => {
    const far = pickContract(contractsResult, ['2610', '2701', '2702'], 'RB', 'RB2610');
    assert.deepStrictEqual(far, { contract: 'RB2701', price: 3580 });
  });

  test('候选内全部不可用 → null', () => {
    const result = pickContract(contractsResult, ['2703', '2704'], 'RB');
    assert.deepStrictEqual(result, { contract: null, price: null });
  });
});

describe('Term Structure — resolveFarContract', () => {
  test('主导月份在近月范围（RB2610）→ 远月取更深月份中持仓量最大（RB2701）', () => {
    const contractsResult = {
      RB2609: { contract: 'RB2609', available: true, close: 3030, hold: 30000 },
      RB2610: { contract: 'RB2610', available: true, close: 3066, hold: 900000 },
      RB2611: { contract: 'RB2611', available: true, close: 3060, hold: 5000 },
      RB2701: { contract: 'RB2701', available: true, close: 3115, hold: 862250 },
      RB2702: { contract: 'RB2702', available: true, close: 3120, hold: 10000 },
      RB2705: { contract: 'RB2705', available: true, close: 3150, hold: 20000 }
    };
    const far = resolveFarContract(contractsResult, ['2611', '2701', '2702', '2705'], 'RB');
    assert.deepStrictEqual(far, { contract: 'RB2701', price: 3115 });
  });

  test('主力连续跟踪 SA2701 → 跳过浅于主导月份的合约，取 SA2705', () => {
    const contractsResult = {
      SA2609: { contract: 'SA2609', available: true, close: 983, hold: 222217 },
      SA2611: { contract: 'SA2611', available: true, close: 1024, hold: 448821 },
      SA2612: { contract: 'SA2612', available: true, close: 1050, hold: 122498 },
      SA2701: { contract: 'SA2701', available: true, close: 1054, hold: 1078686 },
      SA2702: { contract: 'SA2702', available: true, close: 1060, hold: 8000 },
      SA2705: { contract: 'SA2705', available: true, close: 1108, hold: 300000 }
    };
    const far = resolveFarContract(contractsResult, ['2611', '2612', '2701', '2702', '2705'], 'SA');
    assert.deepStrictEqual(far, { contract: 'SA2705', price: 1108 });
  });

  test('主导月份已是最深月份 → 无合法远月 → null', () => {
    const contractsResult = {
      SA2705: { contract: 'SA2705', available: true, close: 1108, hold: 300000 }
    };
    const far = resolveFarContract(contractsResult, ['2705'], 'SA');
    assert.deepStrictEqual(far, { contract: null, price: null });
  });
});

describe('Term Structure — resolveDominantContract 前缀精确边界 (P1)', () => {
  test('单字母前缀 A 不碰撞 AP/AG（即使 AP/AG 持仓更高）', () => {
    const contractsResult = {
      AP2701: { contract: 'AP2701', available: true, close: 8000, hold: 5000 },
      AG2701: { contract: 'AG2701', available: true, close: 6000, hold: 4000 },
      A2701: { contract: 'A2701', available: true, close: 4000, hold: 1000 }
    };
    assert.strictEqual(resolveDominantContract(contractsResult, 'A'), 'A2701');
  });

  test('I 前缀不碰撞 IF', () => {
    const contractsResult = {
      IF2701: { contract: 'IF2701', available: true, close: 3900, hold: 80000 },
      I2701: { contract: 'I2701', available: true, close: 720, hold: 300000 }
    };
    assert.strictEqual(resolveDominantContract(contractsResult, 'I'), 'I2701');
  });

  test('正常品种：持仓量最大的可用合约（既有行为保持）', () => {
    const contractsResult = {
      SA2609: { contract: 'SA2609', available: true, close: 983, hold: 222217 },
      SA2701: { contract: 'SA2701', available: true, close: 1054, hold: 1078686 },
      SA2705: { contract: 'SA2705', available: true, close: 1108, hold: 300000 }
    };
    assert.strictEqual(resolveDominantContract(contractsResult, 'SA'), 'SA2701');
  });

  test('候选均不可用 → null', () => {
    const contractsResult = {
      SA2701: { contract: 'SA2701', available: false, reason: 'no_bar_on_or_before_date' }
    };
    assert.strictEqual(resolveDominantContract(contractsResult, 'SA'), null);
  });

  test('混前缀 dict 中不可用条目不参与挑选', () => {
    const contractsResult = {
      A2701: { contract: 'A2701', available: false, reason: 'illiquid' },
      AG2701: { contract: 'AG2701', available: true, close: 6000, hold: 4000 }
    };
    assert.strictEqual(resolveDominantContract(contractsResult, 'A'), null);
  });
});

describe('Term Structure — resolveFarContract 前缀精确边界 (P1)', () => {
  test('单字母前缀 A 的远月解析不受 AG 干扰', () => {
    const contractsResult = {
      A2701: { contract: 'A2701', available: true, close: 4000, hold: 1000 },
      A2705: { contract: 'A2705', available: true, close: 4100, hold: 500 },
      AG2701: { contract: 'AG2701', available: true, close: 6000, hold: 9000 },
      AG2705: { contract: 'AG2705', available: true, close: 6100, hold: 8000 }
    };
    // AG 持仓更高但前缀不匹配；主导月份必须从 A 合约解析（2701），远月= A2705
    const far = resolveFarContract(contractsResult, ['2703', '2704', '2705'], 'A');
    assert.deepStrictEqual(far, { contract: 'A2705', price: 4100 });
  });
});

describe('Term Structure — buildTermStructureField', () => {
  const base = {
    signalDate: '2026-08-04',
    fetchedAt: '2026-08-04T16:00:00+08:00'
  };

  test('contango：远月高于主力（主导合约口径，宪宪示例数据）', () => {
    const field = buildTermStructureField({
      ...base,
      nearContract: 'RB2609',
      nearPrice: 3520,
      mainContract: 'RB2610',
      farContract: 'RB2701',
      farPrice: 3580,
      mainPrice: 3545
    });
    assert.strictEqual(field.gap, null);
    assert.strictEqual(field.source, 'akshare');
    assert.strictEqual(field.asOf, '2026-08-04T15:00:00+08:00');
    assert.strictEqual(field.near_contract, 'RB2609');
    assert.strictEqual(field.main_contract, 'RB2610');
    assert.strictEqual(field.series_contract, 'RB2610');
    assert.strictEqual(field.far_contract, 'RB2701');
    assert.strictEqual(field.near_price, 3520);
    assert.strictEqual(field.main_price, 3545);
    assert.strictEqual(field.far_price, 3580);
    assert.strictEqual(field.spread_pct, 0.99);
    assert.strictEqual(field.shape, 'contango');
    assert.strictEqual(field.freshness, 'same_day');
    assert.strictEqual(field._timestamp_origin, 'observed');
  });

  test('backwardation：远月低于主力', () => {
    const field = buildTermStructureField({
      ...base,
      nearContract: 'I2609',
      nearPrice: 720,
      mainContract: 'I2701',
      farContract: 'I2705',
      farPrice: 705,
      mainPrice: 729.5
    });
    assert.strictEqual(field.gap, null);
    assert.strictEqual(field.shape, 'backwardation');
    assert.ok(field.spread_pct < 0);
    assert.strictEqual(field.spread_pct, -3.36);
  });

  test('缺近月价格 → gap missing', () => {
    const field = buildTermStructureField({
      ...base,
      nearContract: null,
      nearPrice: null,
      mainContract: 'RB2610',
      farContract: 'RB2701',
      farPrice: 3580,
      mainPrice: 3545
    });
    assert.strictEqual(field.gap, 'missing');
    assert.strictEqual(field.source, 'akshare');
  });

  test('主力价为0 → gap missing', () => {
    const field = buildTermStructureField({
      ...base,
      nearContract: 'RB2609',
      nearPrice: 3520,
      mainContract: 'RB2610',
      farContract: 'RB2701',
      farPrice: 3580,
      mainPrice: 0
    });
    assert.strictEqual(field.gap, 'missing');
  });

  test('主导合约未解析（mainContract=null）→ gap missing', () => {
    const field = buildTermStructureField({
      ...base,
      nearContract: 'RB2609',
      nearPrice: 3520,
      mainContract: null,
      farContract: 'RB2701',
      farPrice: 3580,
      mainPrice: null
    });
    assert.strictEqual(field.gap, 'missing');
  });

  test('spread为0 → contango（二元判定边界）', () => {
    const field = buildTermStructureField({
      ...base,
      nearContract: 'RB2609',
      nearPrice: 3500,
      mainContract: 'RB2610',
      farContract: 'RB2701',
      farPrice: 3500,
      mainPrice: 3500
    });
    assert.strictEqual(field.gap, null);
    assert.strictEqual(field.spread_pct, 0);
    assert.strictEqual(field.shape, 'contango');
  });
});

describe('Term Structure — assembleTermStructure 主导价口径 (P1)', () => {
  const contractsResult = {
    SA2609: { contract: 'SA2609', available: true, close: 983, hold: 222217 },
    SA2611: { contract: 'SA2611', available: true, close: 1024, hold: 448821 },
    SA2701: { contract: 'SA2701', available: true, close: 1054, hold: 1078686 },
    SA2705: { contract: 'SA2705', available: true, close: 1108, hold: 300000 }
  };

  test('main_price/main_contract/series_contract 全取主导合约（换月背离时不用主力连续价）', () => {
    const { field, dominantContract } = assembleTermStructure({
      symbol: 'SA0',
      signalDate: '2026-08-25',
      fetchedAt: '2026-08-26T02:24:00.000Z',
      contractsResult
    });
    assert.strictEqual(dominantContract, 'SA2701');
    assert.strictEqual(field.gap, null);
    assert.strictEqual(field.main_contract, 'SA2701');
    assert.strictEqual(field.main_price, 1054);
    assert.strictEqual(field.series_contract, 'SA2701');
    // near: 候选 [2609,2610,2608] 中仅 SA2609 可用
    assert.strictEqual(field.near_contract, 'SA2609');
    assert.strictEqual(field.near_price, 983);
    // far: 主导月份 2701 之后最深可用 → SA2705
    assert.strictEqual(field.far_contract, 'SA2705');
    assert.strictEqual(field.far_price, 1108);
    assert.strictEqual(field.spread_pct, 5.12);
    assert.strictEqual(field.shape, 'contango');
    assert.strictEqual(field._timestamp_origin, 'observed');
  });

  test('主导合约 close 非法 → gap missing 且 dominantContract 仍返回（供 clean series fallback 判断）', () => {
    const bad = {
      SA2701: { contract: 'SA2701', available: true, close: null, hold: 1078686 }
    };
    const { field, dominantContract } = assembleTermStructure({
      symbol: 'SA0',
      signalDate: '2026-08-25',
      fetchedAt: '2026-08-26T02:24:00.000Z',
      contractsResult: bad
    });
    assert.strictEqual(field.gap, 'missing');
    assert.strictEqual(dominantContract, 'SA2701');
  });

  test('候选均不可用 → gap missing + dominantContract null', () => {
    const { field, dominantContract } = assembleTermStructure({
      symbol: 'SA0',
      signalDate: '2026-08-25',
      fetchedAt: '2026-08-26T02:24:00.000Z',
      contractsResult: {
        SA2701: { contract: 'SA2701', available: false, reason: 'no_bar_on_or_before_date' }
      }
    });
    assert.strictEqual(field.gap, 'missing');
    assert.strictEqual(dominantContract, null);
  });
});

describe('Term Structure — fetchNearFarCloses 退避重试', () => {
  test('子进程连续失败 → 按退避重试后最终 reject', async () => {
    const start = Date.now();
    await assert.rejects(
      fetchNearFarCloses(['RB2610'], '2026-08-04', {
        python: process.execPath, // node 无法执行 .py，稳定触发 exit code 1
        retries: 2,
        backoffBaseMs: 5,
        timeout: 10000
      }),
      /exited with code/
    );
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 15, `退避等待应生效（5ms + 10ms，实际 ${elapsed}ms）`);
  });
});
