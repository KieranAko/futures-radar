/**
 * Opportunity Model Evaluator
 *
 * Purpose: Assess whether a contract presents a tradeable opportunity
 * (sufficient absolute price movement regardless of direction)
 *
 * NOT a direction predictor - only answers "is there enough movement?"
 */

/**
 * Evaluate opportunity quality for a set of trades
 *
 * @param {Array<Object>} trades - Array of trade objects with entry/exit prices
 * @param {number} minMoveThreshold - Minimum absolute price move to qualify (e.g., 0.03 = 3%)
 * @returns {Object} Opportunity metrics
 */
export function evaluateOpportunity(trades, minMoveThreshold = 0.03) {
  if (!trades || trades.length === 0) {
    return {
      totalOpportunities: 0,
      opportunityHitRate: null,
      avgAbsoluteMove: null,
      avgHitMove: null,
      avgMissMove: null,
      coverageRate: null,
    };
  }

  let hitCount = 0;
  let totalAbsMove = 0;
  let hitAbsMove = 0;
  let missAbsMove = 0;

  for (const trade of trades) {
    const { entryPrice, exitPrice } = trade;

    // Calculate absolute price movement (ignore direction)
    const absMove = Math.abs((exitPrice - entryPrice) / entryPrice);
    totalAbsMove += absMove;

    // Check if movement exceeds minimum threshold
    if (absMove >= minMoveThreshold) {
      hitCount++;
      hitAbsMove += absMove;
    } else {
      missAbsMove += absMove;
    }
  }

  const opportunityHitRate = hitCount / trades.length;
  const avgAbsoluteMove = totalAbsMove / trades.length;
  const avgHitMove = hitCount > 0 ? hitAbsMove / hitCount : 0;
  const avgMissMove = (trades.length - hitCount) > 0 ? missAbsMove / (trades.length - hitCount) : 0;

  return {
    totalOpportunities: trades.length,
    opportunityHitRate,
    avgAbsoluteMove,
    avgHitMove,
    avgMissMove,
    minMoveThreshold,
  };
}

/**
 * Evaluate opportunity model with coverage tracking
 *
 * @param {Array<Object>} selectedTrades - Trades from contracts selected by opportunity model
 * @param {number} totalMarketContracts - Total number of contracts in market
 * @param {number} minMoveThreshold - Minimum absolute move threshold
 * @returns {Object} Opportunity metrics with coverage
 */
export function evaluateOpportunityWithCoverage(selectedTrades, totalMarketContracts, minMoveThreshold = 0.03) {
  const opportunityMetrics = evaluateOpportunity(selectedTrades, minMoveThreshold);

  // Calculate coverage rate (how many contracts were selected vs total market)
  const coverageRate = selectedTrades.length / totalMarketContracts;

  return {
    ...opportunityMetrics,
    coverageRate,
    totalMarketContracts,
  };
}
