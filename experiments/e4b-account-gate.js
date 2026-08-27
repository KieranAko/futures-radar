/**
 * E4b Account-Level Validation Gate
 *
 * Registry v1.3 Section 7.2:
 * - Verify winning configuration passes economic viability checks
 * - Nine gates validator (simplified for Phase 1)
 * - Pass criteria: no liquidation, equity > 1.05M, max DD <= 15%
 *
 * Phase 1 Implementation:
 * - Simplified account simulation (sequential trade execution)
 * - Basic equity curve tracking
 * - Economic threshold validation
 *
 * Future Phase (Full Event-Driven):
 * - Intraday position reconciliation
 * - Cash flow identity checks
 * - All 9 gates enumerated in Registry v1.3
 */

/**
 * Validate account-level gate on a sequence of trades
 * @param {Array} trades - Array of {netReturn, entryDate, exitDate}
 * @param {Object} config - {initialCapital, minFinalEquity, maxDrawdown}
 * @returns {Object} - {pass, finalEquity, maxDrawdown, equityCurve, violations}
 */
export function validateAccountGate(trades, config) {
  const {
    initialCapital = 1000000,
    minFinalEquity = 1.05,  // Multiplier (1.05 = 5% gain required)
    maxDrawdown = 0.15,     // 15% max drawdown
  } = config;

  const violations = [];
  const equityCurve = [initialCapital];
  let currentEquity = initialCapital;
  let peakEquity = initialCapital;
  let maxDD = 0;

  // Sequential trade execution
  for (const trade of trades) {
    // Apply trade return to current equity
    const tradeReturn = trade.netReturn;
    const tradeProfit = currentEquity * tradeReturn;
    currentEquity += tradeProfit;

    equityCurve.push(currentEquity);

    // Update peak and drawdown
    if (currentEquity > peakEquity) {
      peakEquity = currentEquity;
    }

    const drawdown = (peakEquity - currentEquity) / peakEquity;
    if (drawdown > maxDD) {
      maxDD = drawdown;
    }

    // Check for liquidation (equity <= 0)
    if (currentEquity <= 0) {
      violations.push('liquidation');
      break;
    }
  }

  const finalEquity = currentEquity;
  const minEquityThreshold = initialCapital * minFinalEquity;

  // Check pass criteria
  if (finalEquity <= minEquityThreshold) {
    violations.push('final_equity_insufficient');
  }

  if (maxDD > maxDrawdown) {
    violations.push('max_drawdown_exceeded');
  }

  const pass = violations.length === 0;

  return {
    pass,
    finalEquity,
    maxDrawdown: maxDD,
    equityCurve,
    violations,
    initialCapital, // Export for compareAccountPerformance
    summary: {
      initialCapital,
      finalEquity,
      totalReturn: (finalEquity - initialCapital) / initialCapital,
      maxDrawdown: maxDD,
      tradeCount: trades.length,
    }
  };
}

/**
 * Compare challenger vs baseline account performance
 * @param {Object} baselineResult - Result from validateAccountGate(baselineTrades)
 * @param {Object} challengerResult - Result from validateAccountGate(challengerTrades)
 * @param {Object} config - {maxDDTolerance, minEquityGain}
 * @returns {Object} - {pass, violations}
 */
export function compareAccountPerformance(baselineResult, challengerResult, config) {
  const {
    maxDDTolerance = 0.03,  // Challenger DD not worse than baseline + 3%
    minEquityGain = 0.02,   // Challenger equity > baseline + 2%
  } = config;

  const violations = [];

  // Check if both passed individual gates
  if (!baselineResult.pass) {
    violations.push('baseline_failed_gate');
  }

  if (!challengerResult.pass) {
    violations.push('challenger_failed_gate');
  }

  // Compare drawdowns
  const ddDiff = challengerResult.maxDrawdown - baselineResult.maxDrawdown;
  if (ddDiff > maxDDTolerance) {
    violations.push('challenger_drawdown_worse');
  }

  // Compare final equity
  const equityDiff = challengerResult.finalEquity - baselineResult.finalEquity;
  const minGainThreshold = baselineResult.initialCapital * minEquityGain;
  if (equityDiff <= minGainThreshold) {
    violations.push('challenger_equity_insufficient');
  }

  const pass = violations.length === 0;

  return {
    pass,
    violations,
    comparison: {
      baselineFinalEquity: baselineResult.finalEquity,
      challengerFinalEquity: challengerResult.finalEquity,
      equityDiff,
      baselineMaxDD: baselineResult.maxDrawdown,
      challengerMaxDD: challengerResult.maxDrawdown,
      ddDiff,
    }
  };
}
