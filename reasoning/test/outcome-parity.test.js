/**
 * Outcome Parity Test
 * 验证 FinCoT outcome 计算器与 shared-backtest-lib 真相源完全一致
 *
 * 场景覆盖：
 * 1. long 上涨 → 正收益
 * 2. short 下跌 → 正收益
 * 3. long 但下跌 → 负收益（方向判断错误）
 * 4. pass → 收益=0
 * 5. 成本已且仅已扣除一次（数值恒等式验证）
 * 6. short 上涨亏损（补充完整性）
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { calculateOutcome } from '../lib/fincot-outcome.js';
import { calculateCosts } from '../../backtest/shared-backtest-lib.cjs';

describe('Outcome Parity Test', () => {
  test('场景1: long 上涨 → 正收益', () => {
    const direction = 'long';
    const entryPrice = 4000;
    const exitPrice = 4100;
    const expectedNetReturn = 0.025 - calculateCosts(4000, 4100);

    const actual = calculateOutcome(direction, entryPrice, exitPrice);

    assert.ok(
      Math.abs(actual - expectedNetReturn) < 1e-6,
      `direction=${direction}, expected=${expectedNetReturn}, actual=${actual}`
    );
  });

  test('场景2: short 下跌 → 正收益', () => {
    const direction = 'short';
    const entryPrice = 4000;
    const exitPrice = 3900;
    const expectedNetReturn = 0.025 - calculateCosts(4000, 3900);

    const actual = calculateOutcome(direction, entryPrice, exitPrice);

    assert.ok(
      Math.abs(actual - expectedNetReturn) < 1e-6,
      `direction=${direction}, expected=${expectedNetReturn}, actual=${actual}`
    );
  });

  test('场景3: long 但下跌 → 负收益（方向判断错误）', () => {
    const direction = 'long';
    const entryPrice = 4000;
    const exitPrice = 3900;
    const expectedNetReturn = -0.025 - calculateCosts(4000, 3900);

    const actual = calculateOutcome(direction, entryPrice, exitPrice);

    assert.ok(
      Math.abs(actual - expectedNetReturn) < 1e-6,
      `direction=${direction}, expected=${expectedNetReturn}, actual=${actual}`
    );
    assert.ok(actual < 0, 'long 但下跌应返回负收益');
  });

  test('场景4: pass → 收益=0', () => {
    const direction = 'pass';
    const entryPrice = 4000;
    const exitPrice = 4100;
    const expectedNetReturn = 0;

    const actual = calculateOutcome(direction, entryPrice, exitPrice);

    assert.strictEqual(actual, expectedNetReturn, 'pass 必须返回 0');
  });

  test('场景5: 成本已且仅已扣除一次（数值恒等式验证）', () => {
    const direction = 'long';
    const entryPrice = 4000;
    const exitPrice = 4100;
    const gross = (4100 - 4000) / 4000;  // = 0.025
    const costs = calculateCosts(4000, 4100);

    const actual = calculateOutcome(direction, entryPrice, exitPrice);

    // 验证: actual = gross - costs (扣除一次)
    assert.ok(
      Math.abs(actual - (gross - costs)) < 1e-12,
      `成本应扣除一次: actual=${actual}, gross=${gross}, costs=${costs}`
    );

    // 验证: actual ≠ gross - 2*costs (不是扣除两次)
    assert.ok(
      Math.abs(actual - (gross - 2 * costs)) > 1e-12,
      `成本不应扣除两次: actual=${actual}, gross-2*costs=${gross - 2 * costs}`
    );

    // 验证: actual ≠ gross (不是零成本)
    assert.ok(
      Math.abs(actual - gross) > 1e-12,
      `成本不应为零: actual=${actual}, gross=${gross}`
    );
  });

  test('场景6: short 上涨亏损（补充完整性）', () => {
    const direction = 'short';
    const entryPrice = 4000;
    const exitPrice = 4100;
    const expectedNetReturn = -0.025 - calculateCosts(4000, 4100);

    const actual = calculateOutcome(direction, entryPrice, exitPrice);

    assert.ok(
      Math.abs(actual - expectedNetReturn) < 1e-6,
      `direction=${direction}, expected=${expectedNetReturn}, actual=${actual}`
    );
    assert.ok(actual < 0, 'short 但上涨应返回负收益');
  });
});
