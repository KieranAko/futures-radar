/**
 * Two-Layer Backtest Evaluator
 *
 * Layer 1: Opportunity Model - "Is there enough movement worth trading?"
 * Layer 2: Direction Model - "Which direction (long/short/uncertain)?"
 *
 * Evaluates each layer separately, then reports combined results.
 */

import { evaluateOpportunity } from './opportunity-evaluator.js';
import { evaluatePredictionQuality } from './prediction-quality-evaluator.js';

/**
 * Evaluate two-layer model: Opportunity + Direction
 *
 * @param {Array<Object>} allTrades - All trades from opportunity model selection
 * @param {number} totalMarketContracts - Total contracts scanned per date
 * @param {number} minMoveThreshold - Minimum absolute move for opportunity hit (default 3%)
 * @returns {Object} Layered evaluation results
 */
export function evaluateTwoLayerModel(allTrades, totalMarketContracts, minMoveThreshold = 0.03) {
  // Layer 1: Opportunity Model Evaluation
  const opportunityMetrics = evaluateOpportunity(allTrades, minMoveThreshold);
  const coverageRate = allTrades.length / (totalMarketContracts * 29); // 29 dates

  // Layer 2: Direction Model Evaluation (only on opportunity-selected trades)
  const directionMetrics = evaluatePredictionQuality(allTrades);

  // Combined Results: Both layers must succeed
  const combinedTrades = allTrades.filter(trade => {
    const absMove = Math.abs((trade.exitPrice - trade.entryPrice) / trade.entryPrice);
    const opportunityHit = absMove >= minMoveThreshold;

    // Direction hit check
    const priceChange = trade.exitPrice - trade.entryPrice;
    const directionCorrect = trade.direction === 'long'
      ? priceChange > 0
      : priceChange < 0;

    return opportunityHit && directionCorrect;
  });

  const combinedHitRate = allTrades.length > 0 ? combinedTrades.length / allTrades.length : null;

  return {
    // Layer 1: Opportunity
    opportunity: {
      ...opportunityMetrics,
      coverageRate,
      totalMarketContracts,
    },

    // Layer 2: Direction
    direction: {
      totalSignals: directionMetrics.totalSignals,
      hitRate: directionMetrics.overall?.hitRate ?? null,
      longHitRate: directionMetrics.long?.hitRate ?? null,
      shortHitRate: directionMetrics.short?.hitRate ?? null,
    },

    // Combined: Both must succeed
    combined: {
      totalSignals: allTrades.length,
      bothCorrectCount: combinedTrades.length,
      combinedHitRate,
      avgNetReturn: directionMetrics.overall?.netReturnMean ?? null,
    },
  };
}

/**
 * Format two-layer results as comparison table
 */
export function formatTwoLayerResults(results) {
  console.log('\n╔═══════════════════════════════════════════════════════════════════╗');
  console.log('║              TWO-LAYER MODEL EVALUATION (29 dates)               ║');
  console.log('╚═══════════════════════════════════════════════════════════════════╝\n');

  console.log('━━━ LAYER 1: OPPORTUNITY MODEL (Is there enough movement?) ━━━\n');
  console.log(`Total Opportunities Selected: ${results.opportunity.totalOpportunities}`);
  console.log(`Opportunity Hit Rate: ${results.opportunity.opportunityHitRate !== null ? (results.opportunity.opportunityHitRate * 100).toFixed(1) + '%' : 'N/A'}`);
  console.log(`  (contracts with ≥${(results.opportunity.minMoveThreshold * 100).toFixed(0)}% absolute movement)`);
  console.log(`Average Absolute Move: ${results.opportunity.avgAbsoluteMove !== null ? (results.opportunity.avgAbsoluteMove * 100).toFixed(2) + '%' : 'N/A'}`);
  console.log(`  - When Hit: ${results.opportunity.avgHitMove !== null ? (results.opportunity.avgHitMove * 100).toFixed(2) + '%' : 'N/A'}`);
  console.log(`  - When Miss: ${results.opportunity.avgMissMove !== null ? (results.opportunity.avgMissMove * 100).toFixed(2) + '%' : 'N/A'}`);
  console.log(`Coverage Rate: ${results.opportunity.coverageRate !== null ? (results.opportunity.coverageRate * 100).toFixed(1) + '%' : 'N/A'}`);
  console.log(`  (${results.opportunity.totalOpportunities} selected / ${results.opportunity.totalMarketContracts * 29} total market slots)`);

  console.log('\n━━━ LAYER 2: DIRECTION MODEL (Which way - long/short?) ━━━\n');
  console.log(`Total Signals: ${results.direction.totalSignals}`);
  console.log(`Direction Hit Rate: ${results.direction.hitRate !== null ? (results.direction.hitRate * 100).toFixed(1) + '%' : 'N/A'}`);
  console.log(`  - Long Hit Rate: ${results.direction.longHitRate !== null ? (results.direction.longHitRate * 100).toFixed(1) + '%' : 'N/A'}`);
  console.log(`  - Short Hit Rate: ${results.direction.shortHitRate !== null ? (results.direction.shortHitRate * 100).toFixed(1) + '%' : 'N/A'}`);

  console.log('\n━━━ COMBINED: Both Opportunity AND Direction Correct ━━━\n');
  console.log(`Total Signals: ${results.combined.totalSignals}`);
  console.log(`Both Correct: ${results.combined.bothCorrectCount}`);
  console.log(`Combined Hit Rate: ${results.combined.combinedHitRate !== null ? (results.combined.combinedHitRate * 100).toFixed(1) + '%' : 'N/A'}`);
  console.log(`  (opportunity hit AND direction correct)`);
  console.log(`Avg Per-Signal Net Return: ${results.combined.avgNetReturn !== null ? (results.combined.avgNetReturn * 100).toFixed(2) + '%' : 'N/A'}`);

  console.log('\n');
}
