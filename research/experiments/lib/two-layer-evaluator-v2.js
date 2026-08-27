/**
 * Two-Layer Evaluator V2
 *
 * Evaluates separated opportunity and direction models with independent sample sets.
 *
 * Key improvements over V1:
 * - Layer 1 evaluated on ALL opportunity candidates (not post-direction filtered)
 * - Four-table cross analysis: opportunity hit × direction correctness
 * - No independence assumption for combined rate calculation
 * - Coverage based on actual daily contract counts
 */

/**
 * Evaluate Layer 1: Opportunity Model
 *
 * @param {Array<Object>} allCandidates - All opportunity candidates across dates
 * @param {Array<Object>} allCandidateOutcomes - Direction-neutral outcomes for all candidates
 * @param {number} minMoveThreshold - Minimum absolute move (default 3%)
 * @returns {Object} Opportunity metrics
 */
export function evaluateOpportunityLayer(allCandidates, allCandidateOutcomes, minMoveThreshold = 0.03) {
  const outcomeMap = new Map();
  for (const outcome of allCandidateOutcomes) {
    if (!outcome.outcomeAvailable) continue;
    outcomeMap.set(`${outcome.signalDate}:${outcome.symbol}`, outcome.absMove);
  }

  let hitCount = 0;
  let totalAbsMove = 0;
  let hitAbsMove = 0;
  let missAbsMove = 0;

  for (const candidate of allCandidates) {
    const key = `${candidate.signalDate}:${candidate.symbol}`;
    const absMove = outcomeMap.get(key);

    if (absMove === undefined) continue; // No trade data for this candidate

    totalAbsMove += absMove;

    if (absMove >= minMoveThreshold) {
      hitCount++;
      hitAbsMove += absMove;
    } else {
      missAbsMove += absMove;
    }
  }

  const totalWithOutcome = allCandidates.filter(c =>
    outcomeMap.has(`${c.signalDate}:${c.symbol}`)
  ).length;

  const opportunityHitRate = totalWithOutcome > 0 ? hitCount / totalWithOutcome : null;
  const avgAbsoluteMove = totalWithOutcome > 0 ? totalAbsMove / totalWithOutcome : null;
  const avgHitMove = hitCount > 0 ? hitAbsMove / hitCount : null;
  const avgMissMove = (totalWithOutcome - hitCount) > 0 ? missAbsMove / (totalWithOutcome - hitCount) : null;

  return {
    totalCandidates: allCandidates.length,
    totalWithOutcome,
    opportunityHits: hitCount,
    opportunityMisses: totalWithOutcome - hitCount,
    opportunityHitRate,
    avgAbsoluteMove,
    avgHitMove,
    avgMissMove,
    minMoveThreshold,
  };
}

/**
 * Evaluate Layer 2: Direction Model
 *
 * @param {Array<Object>} allDirectionSignals - All direction signals (including 'uncertain')
 * @param {Array<Object>} allTrades - All executed trades
 * @returns {Object} Direction metrics
 */
export function evaluateDirectionLayer(allDirectionSignals, allTrades) {
  const outcomeMap = new Map();
  for (const trade of allTrades) {
    const priceChange = trade.exitPrice - trade.entryPrice;
    outcomeMap.set(`${trade.signalDate}:${trade.symbol}`, priceChange);
  }

  let totalSignals = 0;
  let uncertainCount = 0;
  let longCorrect = 0;
  let longTotal = 0;
  let shortCorrect = 0;
  let shortTotal = 0;

  for (const signal of allDirectionSignals) {
    totalSignals++;

    if (signal.direction === 'uncertain') {
      uncertainCount++;
      continue;
    }

    const key = `${signal.signalDate}:${signal.symbol}`;
    const priceChange = outcomeMap.get(key);
    if (priceChange === undefined) continue; // No trade data

    const directionCorrect = signal.direction === 'long' ? priceChange > 0 : priceChange < 0;

    if (signal.direction === 'long') {
      longTotal++;
      if (directionCorrect) longCorrect++;
    } else if (signal.direction === 'short') {
      shortTotal++;
      if (directionCorrect) shortCorrect++;
    }
  }

  const totalDirectional = longTotal + shortTotal;
  const totalCorrect = longCorrect + shortCorrect;

  return {
    totalSignals,
    uncertainCount,
    uncertainRate: totalSignals > 0 ? uncertainCount / totalSignals : null,
    totalDirectional,
    totalCorrect,
    directionHitRate: totalDirectional > 0 ? totalCorrect / totalDirectional : null,
    longHitRate: longTotal > 0 ? longCorrect / longTotal : null,
    shortHitRate: shortTotal > 0 ? shortCorrect / shortTotal : null,
  };
}

/**
 * Four-table cross analysis: Opportunity × Direction
 *
 * @param {Array<Object>} allTrades - All executed trades
 * @param {number} minMoveThreshold - Minimum absolute move
 * @returns {Object} Cross-table metrics
 */
export function evaluateCrossTable(allTrades, minMoveThreshold = 0.03) {
  let oppHit_dirCorrect = 0;   // A: Strong opportunity + correct direction
  let oppHit_dirWrong = 0;     // B: Strong opportunity + wrong direction
  let oppMiss_dirCorrect = 0;  // C: Weak opportunity + correct direction
  let oppMiss_dirWrong = 0;    // D: Weak opportunity + wrong direction

  for (const trade of allTrades) {
    const absMove = Math.abs((trade.exitPrice - trade.entryPrice) / trade.entryPrice);
    const oppHit = absMove >= minMoveThreshold;

    const priceChange = trade.exitPrice - trade.entryPrice;
    const dirCorrect = trade.direction === 'long' ? priceChange > 0 : priceChange < 0;

    if (oppHit && dirCorrect) oppHit_dirCorrect++;
    else if (oppHit && !dirCorrect) oppHit_dirWrong++;
    else if (!oppHit && dirCorrect) oppMiss_dirCorrect++;
    else oppMiss_dirWrong++;
  }

  const totalTrades = allTrades.length;
  const strongOpportunityTotal = oppHit_dirCorrect + oppHit_dirWrong;
  const weakOpportunityTotal = oppMiss_dirCorrect + oppMiss_dirWrong;

  return {
    oppHit_dirCorrect,
    oppHit_dirWrong,
    oppMiss_dirCorrect,
    oppMiss_dirWrong,
    totalTrades,
    combinedHitRate: totalTrades > 0 ? oppHit_dirCorrect / totalTrades : null,
    directionHitRate_strongOpp: strongOpportunityTotal > 0 ? oppHit_dirCorrect / strongOpportunityTotal : null,
    directionHitRate_weakOpp: weakOpportunityTotal > 0 ? oppMiss_dirCorrect / weakOpportunityTotal : null,
  };
}

/**
 * Evaluate full two-layer model with separated sample sets
 *
 * @param {Array<Object>} allCandidates - All opportunity candidates
 * @param {Array<Object>} allCandidateOutcomes - Direction-neutral candidate outcomes
 * @param {Array<Object>} allDirectionSignals - All direction signals
 * @param {Array<Object>} allTrades - All executed trades
 * @param {number} totalMarketContracts - Total contracts scanned across all dates
 * @param {number} minMoveThreshold - Minimum absolute move threshold
 * @returns {Object} Full two-layer evaluation
 */
export function evaluateTwoLayerModelV2(
  allCandidates,
  allCandidateOutcomes,
  allDirectionSignals,
  allTrades,
  totalMarketContracts,
  minMoveThreshold = 0.03
) {
  const opportunityMetrics = evaluateOpportunityLayer(allCandidates, allCandidateOutcomes, minMoveThreshold);
  const directionMetrics = evaluateDirectionLayer(allDirectionSignals, allTrades);
  const crossMetrics = evaluateCrossTable(allTrades, minMoveThreshold);

  const coverageRate = totalMarketContracts > 0 ? allCandidates.length / totalMarketContracts : null;

  // Average per-signal net return
  const totalNetReturn = allTrades.reduce((sum, t) => sum + t.netReturn, 0);
  const avgNetReturn = allTrades.length > 0 ? totalNetReturn / allTrades.length : null;

  return {
    opportunity: {
      ...opportunityMetrics,
      coverageRate,
      totalMarketContracts,
    },
    direction: directionMetrics,
    cross: crossMetrics,
    combined: {
      totalTrades: allTrades.length,
      combinedHitRate: crossMetrics.combinedHitRate,
      avgNetReturn,
    },
  };
}

/**
 * Format two-layer V2 results
 */
export function formatTwoLayerResultsV2(results) {
  console.log('\n╔═══════════════════════════════════════════════════════════════════╗');
  console.log('║          TWO-LAYER MODEL EVALUATION V2 (29 dates)                ║');
  console.log('╚═══════════════════════════════════════════════════════════════════╝\n');

  console.log('━━━ LAYER 1: OPPORTUNITY MODEL (Independent Sample) ━━━\n');
  console.log(`Total Opportunity Candidates: ${results.opportunity.totalCandidates}`);
  console.log(`Candidates with Outcome Data: ${results.opportunity.totalWithOutcome}`);
  console.log(`Opportunity Hits: ${results.opportunity.opportunityHits}`);
  console.log(`Opportunity Misses: ${results.opportunity.opportunityMisses}`);
  console.log(`Opportunity Hit Rate: ${results.opportunity.opportunityHitRate !== null ? (results.opportunity.opportunityHitRate * 100).toFixed(1) + '%' : 'N/A'}`);
  console.log(`  (contracts with ≥${(results.opportunity.minMoveThreshold * 100).toFixed(0)}% absolute movement)`);
  console.log(`Average Absolute Move: ${results.opportunity.avgAbsoluteMove !== null ? (results.opportunity.avgAbsoluteMove * 100).toFixed(2) + '%' : 'N/A'}`);
  console.log(`  - When Hit: ${results.opportunity.avgHitMove !== null ? (results.opportunity.avgHitMove * 100).toFixed(2) + '%' : 'N/A'}`);
  console.log(`  - When Miss: ${results.opportunity.avgMissMove !== null ? (results.opportunity.avgMissMove * 100).toFixed(2) + '%' : 'N/A'}`);
  console.log(`Coverage Rate: ${results.opportunity.coverageRate !== null ? (results.opportunity.coverageRate * 100).toFixed(1) + '%' : 'N/A'}`);
  console.log(`  (${results.opportunity.totalCandidates} selected / ${results.opportunity.totalMarketContracts} total market slots)`);

  console.log('\n━━━ LAYER 2: DIRECTION MODEL (Consumes Opportunity Candidates) ━━━\n');
  console.log(`Total Direction Signals: ${results.direction.totalSignals}`);
  console.log(`Uncertain Signals: ${results.direction.uncertainCount} (${results.direction.uncertainRate !== null ? (results.direction.uncertainRate * 100).toFixed(1) + '%' : 'N/A'})`);
  console.log(`Directional Signals (long/short): ${results.direction.totalDirectional}`);
  console.log(`Direction Hit Rate: ${results.direction.directionHitRate !== null ? (results.direction.directionHitRate * 100).toFixed(1) + '%' : 'N/A'}`);
  console.log(`  - Long Hit Rate: ${results.direction.longHitRate !== null ? (results.direction.longHitRate * 100).toFixed(1) + '%' : 'N/A'}`);
  console.log(`  - Short Hit Rate: ${results.direction.shortHitRate !== null ? (results.direction.shortHitRate * 100).toFixed(1) + '%' : 'N/A'}`);

  console.log('\n━━━ CROSS-TABLE: Opportunity × Direction ━━━\n');
  console.log('                          | Direction Correct | Direction Wrong |');
  console.log('--------------------------|-------------------|-----------------|');
  console.log(`Opportunity Hit (≥3%)     | ${String(results.cross.oppHit_dirCorrect).padStart(17)} | ${String(results.cross.oppHit_dirWrong).padStart(15)} |`);
  console.log(`Opportunity Miss (<3%)    | ${String(results.cross.oppMiss_dirCorrect).padStart(17)} | ${String(results.cross.oppMiss_dirWrong).padStart(15)} |`);
  console.log('\nKey Metrics:');
  console.log(`  - Direction Hit Rate in Strong Opportunities: ${results.cross.directionHitRate_strongOpp !== null ? (results.cross.directionHitRate_strongOpp * 100).toFixed(1) + '%' : 'N/A'}`);
  console.log(`  - Direction Hit Rate in Weak Opportunities: ${results.cross.directionHitRate_weakOpp !== null ? (results.cross.directionHitRate_weakOpp * 100).toFixed(1) + '%' : 'N/A'}`);

  console.log('\n━━━ COMBINED: Both Layers ━━━\n');
  console.log(`Total Executed Trades: ${results.combined.totalTrades}`);
  console.log(`Combined Hit Rate: ${results.combined.combinedHitRate !== null ? (results.combined.combinedHitRate * 100).toFixed(1) + '%' : 'N/A'}`);
  console.log(`  (opportunity hit AND direction correct)`);
  console.log(`Avg Per-Signal Net Return: ${results.combined.avgNetReturn !== null ? (results.combined.avgNetReturn * 100).toFixed(2) + '%' : 'N/A'}`);

  console.log('\n');
}
