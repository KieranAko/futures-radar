/**
 * FinCoT Outcome Calculator
 * 计算单个候选的净收益，严格对齐 shared-backtest-lib 真相源
 *
 * @param {string} direction - 'long' | 'short' | 'pass'
 * @param {number} entryPrice - 进场价格
 * @param {number} exitPrice - 出场价格
 * @returns {number} 净收益（归一化百分比，pass返回0）
 */

import { calculateCosts } from '../../backtest/shared-backtest-lib.cjs';

export function calculateOutcome(direction, entryPrice, exitPrice) {
  // pass 必须返回 0
  if (direction === 'pass') {
    return 0;
  }

  // 方向符号
  const sign = direction === 'long' ? 1 : -1;

  // 价格变化（归一化）
  const priceChange = (exitPrice - entryPrice) / entryPrice;

  // 成本（调用真相源，已且仅已调用一次）
  const costs = calculateCosts(entryPrice, exitPrice);

  // 净收益
  const netReturn = sign * priceChange - costs;

  return netReturn;
}
