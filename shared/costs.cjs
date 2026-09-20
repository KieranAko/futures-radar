/**
 * lib/costs.cjs — 交易成本真相源（回测与 reasoning 共享）
 *
 * 与 research/backtest/shared-backtest-lib.cjs 的 calculateCosts 同口径。
 * 从 backtest 中抽到根 lib/，使日常 reasoning 不再依赖 research/backtest。
 */

const CONFIG = {
  COMMISSION_RATE: 0.0003,
  SLIPPAGE_RATE: 0.0002
};

/**
 * 往返成本（按入场价归一化）。
 * @param {number} entryPrice
 * @param {number} exitPrice
 * @returns {number}
 */
function calculateCosts(entryPrice, exitPrice) {
  const avgPrice = (entryPrice + exitPrice) / 2;
  const commission = avgPrice * CONFIG.COMMISSION_RATE;
  const slippage = entryPrice * CONFIG.SLIPPAGE_RATE * 2;
  return (commission + slippage) / entryPrice;
}

module.exports = { CONFIG, calculateCosts };
