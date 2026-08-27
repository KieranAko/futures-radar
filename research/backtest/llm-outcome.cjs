/**
 * LLM Outcome
 * reasoning 方向 → T+1 open 入场 / T+11 close 出场 outcome
 * 复用 shared-backtest-lib 的 simulateEntry/simulateExit/calculateCosts，不复制常数
 */

const { simulateEntry, simulateExit, calculateCosts } = require('./shared-backtest-lib.cjs');

const HOLD_DAYS = 10;

/**
 * 对 reasoning 结果评分：T 收盘决策、T+1 open 入场、T+11 close 出场
 * @param {object} args
 * @param {object} args.result - reasoning 结果（direction: long|short|pass）
 * @param {string} args.symbol
 * @param {string} args.signalDate
 * @param {object} args.raw - raw OHLCV 数据（raw.contracts[symbol].ohlcv）
 * @returns {{outcome: object|null, scoringStatus: string}}
 *   scoringStatus: scored | pass | entry_unavailable | outcome_immature
 */
function scoreReasoningOutcome({ result, symbol, signalDate, raw }) {
  if (!result || result.direction === 'pass') {
    return { outcome: null, scoringStatus: 'pass' };
  }

  const dates = raw?.contracts?.[symbol]?.ohlcv?.dates;
  if (!Array.isArray(dates) || dates.indexOf(signalDate) < 0) {
    return { outcome: null, scoringStatus: 'outcome_immature' };
  }

  const entry = simulateEntry(symbol, raw, signalDate);
  if (!entry) {
    return { outcome: null, scoringStatus: 'entry_unavailable' };
  }

  const exit = simulateExit(symbol, raw, entry.entryIdx, HOLD_DAYS);
  if (!exit) {
    return { outcome: null, scoringStatus: 'outcome_immature' };
  }

  const { entryPrice, exitPrice } = { entryPrice: entry.entryPrice, exitPrice: exit.exitPrice };
  if (!Number.isFinite(entryPrice) || !Number.isFinite(exitPrice)) {
    throw new Error(
      `Non-finite price rejected: entryPrice=${entryPrice}, exitPrice=${exitPrice}`
    );
  }

  const sign = result.direction === 'long' ? 1 : -1;
  const grossReturn = sign * ((exitPrice - entryPrice) / entryPrice);
  const cost = calculateCosts(entryPrice, exitPrice);
  const netReturn = grossReturn - cost;

  return {
    outcome: {
      entryDate: entry.entryDate,
      entryPrice,
      exitDate: exit.exitDate,
      exitPrice,
      grossReturn,
      cost,
      netReturn
    },
    scoringStatus: 'scored'
  };
}

module.exports = { scoreReasoningOutcome, HOLD_DAYS };
