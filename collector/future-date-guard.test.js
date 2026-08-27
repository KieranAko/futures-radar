/**
 * collector/future-date-guard.test.js — 日线未来日期防御守卫单元测试
 *
 * 背景（2026-08-27 冻结不变量 #1）：日线接口只返回完整 bar；末 bar 日期 > 本地今日
 * 视为源行为异常（应永不触发），守卫在数据进入 raw.json 前剔除并记录诊断。
 * P1 修复（缅因猫复审 43427885b）：日期必须严格校验 YYYY-MM-DD + 真实日历日期，
 * 带时间戳/非法输入拒绝（fail-closed），不得静默截断；todayStr 同样校验。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  guardFutureDates,
  normalizeBarDate,
  isValidDateStr,
  rejectFutureDateContracts,
} = require('../collector/future-date-guard.cjs');

function makeContract(symbol, dates, fetchedAt) {
  return {
    symbol,
    fetchedAt: fetchedAt || '2026-08-26T16:00:00.000Z',
    totalBars: dates.length,
    ohlcv: { dates, close: dates.map(() => 100) },
  };
}

describe('isValidDateStr', () => {
  it('严格 YYYY-MM-DD 通过（含闰年）', () => {
    assert.strictEqual(isValidDateStr('2026-08-26'), true);
    assert.strictEqual(isValidDateStr('2024-02-29'), true);
  });

  it('真实日历日期校验：不存在的日期拒绝', () => {
    assert.strictEqual(isValidDateStr('2026-02-30'), false); // 2 月没有 30 日
    assert.strictEqual(isValidDateStr('2023-02-29'), false); // 平年 2 月 29 日
    assert.strictEqual(isValidDateStr('2026-13-01'), false); // 13 月
    assert.strictEqual(isValidDateStr('2026-00-10'), false); // 0 月
    assert.strictEqual(isValidDateStr('2026-08-00'), false); // 0 日
  });

  it('非严格格式拒绝', () => {
    assert.strictEqual(isValidDateStr('2026-08-28junk'), false); // 后缀
    assert.strictEqual(isValidDateStr('2026-08-26 15:00:00'), false); // 带时间戳
    assert.strictEqual(isValidDateStr('0000-invalid'), false);
    assert.strictEqual(isValidDateStr('2026/08/26'), false); // 错误分隔符
    assert.strictEqual(isValidDateStr('2026-8-26'), false); // 未补零
    assert.strictEqual(isValidDateStr(''), false);
    assert.strictEqual(isValidDateStr(null), false);
    assert.strictEqual(isValidDateStr(undefined), false);
  });
});

describe('normalizeBarDate', () => {
  it('严格 ISO 日期原样返回', () => {
    assert.strictEqual(normalizeBarDate('2026-08-26'), '2026-08-26');
  });

  it('带时间戳输入拒绝（不再静默截断）', () => {
    assert.strictEqual(normalizeBarDate('2026-08-26 15:00:00'), null);
  });

  it('非法日历日期拒绝', () => {
    assert.strictEqual(normalizeBarDate('2026-02-30'), null);
    assert.strictEqual(normalizeBarDate('0000-invalid'), null);
  });

  it('空值返回 null', () => {
    assert.strictEqual(normalizeBarDate(null), null);
    assert.strictEqual(normalizeBarDate(''), null);
    assert.strictEqual(normalizeBarDate(undefined), null);
  });
});

describe('guardFutureDates', () => {
  const TODAY = '2026-08-27';

  it('正常历史日期放行（lastBarDate < today）', () => {
    const contracts = { SA0: makeContract('SA0', ['2026-08-25', '2026-08-26']) };
    const result = guardFutureDates(contracts, TODAY);
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.rejected, []);
    assert.deepStrictEqual(result.passed, ['SA0']);
  });

  it('当天日期放行（lastBarDate == today）', () => {
    const contracts = { SA0: makeContract('SA0', ['2026-08-26', '2026-08-27']) };
    const result = guardFutureDates(contracts, TODAY);
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.rejected, []);
    assert.deepStrictEqual(result.passed, ['SA0']);
  });

  it('未来日期剔除（lastBarDate > today）', () => {
    const contracts = { SA0: makeContract('SA0', ['2026-08-26', '2026-08-28']) };
    const result = guardFutureDates(contracts, TODAY);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.rejected.length, 1);
    assert.strictEqual(result.rejected[0].symbol, 'SA0');
    assert.deepStrictEqual(result.passed, []);
  });

  it('剔除诊断包含 symbol、rawDate、异常日期、fetchedAt', () => {
    const fetchedAt = '2026-08-27T02:00:00.000Z';
    const contracts = { SA0: makeContract('SA0', ['2026-08-28'], fetchedAt) };
    const result = guardFutureDates(contracts, TODAY);
    const diag = result.rejected[0];
    assert.strictEqual(diag.symbol, 'SA0');
    assert.strictEqual(diag.rawDate, '2026-08-28');
    assert.strictEqual(diag.lastBarDate, '2026-08-28');
    assert.strictEqual(diag.fetchedAt, fetchedAt);
    assert.match(diag.reason, /future date/i);
  });

  it('非法日历日期剔除（不存在的日期，保留 rawDate）', () => {
    const contracts = { SA0: makeContract('SA0', ['2026-08-26', '2026-02-30']) };
    const result = guardFutureDates(contracts, TODAY);
    assert.strictEqual(result.ok, false);
    const diag = result.rejected[0];
    assert.strictEqual(diag.symbol, 'SA0');
    assert.strictEqual(diag.rawDate, '2026-02-30');
    assert.strictEqual(diag.lastBarDate, null);
    assert.match(diag.reason, /invalid date/i);
  });

  it('带时间戳末 bar 剔除（fail-closed，不静默截断）', () => {
    const contracts = { SA0: makeContract('SA0', ['2026-08-26 15:00:00']) };
    const result = guardFutureDates(contracts, TODAY);
    assert.strictEqual(result.ok, false);
    const diag = result.rejected[0];
    assert.strictEqual(diag.rawDate, '2026-08-26 15:00:00');
    assert.strictEqual(diag.lastBarDate, null);
    assert.match(diag.reason, /invalid date/i);
  });

  it('混合合约只剔除异常的，保留正常的', () => {
    const contracts = {
      SA0: makeContract('SA0', ['2026-08-26']),
      SA1: makeContract('SA1', ['2026-08-29']),
      SA2: makeContract('SA2', ['2026-08-26', '2026-08-27']),
      SA3: makeContract('SA3', ['2026-13-01']),
    };
    const result = guardFutureDates(contracts, TODAY);
    assert.deepStrictEqual(result.rejected.map((r) => r.symbol).sort(), ['SA1', 'SA3']);
    assert.deepStrictEqual(result.passed.sort(), ['SA0', 'SA2']);
  });

  it('空 dates 序列按异常剔除（无日期可校验）', () => {
    const contracts = { SA0: makeContract('SA0', []) };
    const result = guardFutureDates(contracts, TODAY);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.rejected[0].symbol, 'SA0');
    assert.match(result.rejected[0].reason, /no dates/i);
  });

  it('非法 todayStr 直接抛错（fail-closed，调用方 bug）', () => {
    const contracts = { SA0: makeContract('SA0', ['2026-08-26']) };
    assert.throws(() => guardFutureDates(contracts, 'not-a-date'), /todayStr/i);
    assert.throws(() => guardFutureDates(contracts, '2026-13-01'), /todayStr/i);
    assert.throws(() => guardFutureDates(contracts, '2026-08-26 00:00:00'), /todayStr/i);
  });

  it('localToday 由调用方传入，守卫不做时钟推断', () => {
    const contracts = { SA0: makeContract('SA0', ['2026-08-31']) };
    const result = guardFutureDates(contracts, '2026-08-31');
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.rejected, []);
  });
});

describe('rejectFutureDateContracts（collector 集成，持久化前剔除）', () => {
  it('被拒合约从 contracts 移除，降级为 gaps（future_date_rejected）', () => {
    const rawData = {
      meta: {},
      contracts: {
        SA0: makeContract('SA0', ['2026-08-26']),
        SA1: makeContract('SA1', ['2026-02-30']),
        SA2: makeContract('SA2', ['2026-08-28']),
      },
      gaps: {},
    };
    const result = rejectFutureDateContracts(rawData, '2026-08-27');
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(Object.keys(rawData.contracts), ['SA0']); // SA1 非法日期、SA2 未来日期均被剔除
    assert.strictEqual(rawData.gaps.SA1.symbol, 'SA1');
    assert.match(rawData.gaps.SA1.reason, /future_date_rejected.*invalid date.*2026-02-30/);
    assert.match(rawData.gaps.SA2.reason, /future_date_rejected.*future date/);
    assert.strictEqual(rawData.gaps.SA0, undefined);
  });

  it('全部被拒时 contracts 清空（collector 应 fatal 不落 artifacts）', () => {
    const rawData = {
      meta: {},
      contracts: { SA0: makeContract('SA0', ['2026-08-28']) },
      gaps: {},
    };
    const result = rejectFutureDateContracts(rawData, '2026-08-27');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.contractsLeft, 0);
    assert.deepStrictEqual(rawData.contracts, {});
    assert.strictEqual(rawData.gaps.SA0.symbol, 'SA0');
  });

  it('无异常时 contracts 原样保留，gaps 不新增', () => {
    const rawData = {
      meta: {},
      contracts: { SA0: makeContract('SA0', ['2026-08-26']) },
      gaps: {},
    };
    const result = rejectFutureDateContracts(rawData, '2026-08-27');
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.contractsLeft, 1);
    assert.strictEqual(Object.keys(rawData.gaps).length, 0);
    assert.ok(rawData.contracts.SA0);
  });
});
