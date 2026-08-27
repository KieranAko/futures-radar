/**
 * Replay Adapter — Load 29-date conditional OOS artifact and provide unified interface
 *
 * Step 1 of 缅因猫's 7-step fix: establish shared replay-adapter from purged-walkforward artifact
 *
 * Purpose:
 * - Load testRunDateMetadata (29 OOS dates)
 * - Load allOOSTrades (baseline trades with entry/exit prices)
 * - Provide clean interface for E1-E4b experiments to replay from raw signals
 *
 * NOT a post-processor: this provides the ground truth for parity verification
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Load the latest purged-walkforward artifact
 * @returns {Object} Full artifact with testRunDateMetadata, allOOSTrades, foldsDetail
 */
export function loadWalkForwardArtifact() {
  const backtestDir = path.join(__dirname, '../../backtest');
  const files = fs.readdirSync(backtestDir)
    .filter(f => f.startsWith('purged-walkforward-') && f.endsWith('.json'))
    .sort()
    .reverse();

  if (files.length === 0) {
    throw new Error('No purged-walkforward artifact found. Run backtest/purged-walkforward.cjs first.');
  }

  const latest = path.join(backtestDir, files[0]);
  return JSON.parse(fs.readFileSync(latest, 'utf8'));
}

/**
 * Get 29 test run date metadata
 * @param {Object} artifact - Walk-forward artifact
 * @returns {Array<{runId, signalDate, entryDate, labelEndDate}>}
 */
export function getTestRunDates(artifact) {
  if (!artifact.testRunDateMetadata || artifact.testRunDateMetadata.length !== 29) {
    throw new Error(`Expected exactly 29 test run dates, got ${artifact.testRunDateMetadata?.length || 0}`);
  }
  return artifact.testRunDateMetadata;
}

/**
 * Get all baseline OOS trades (HV=1 frozen config)
 * @param {Object} artifact - Walk-forward artifact
 * @returns {Array<{runId, signalDate, symbol, direction, entryDate, exitDate, entryPrice, exitPrice, grossReturn, costs, netReturn}>}
 */
export function getBaselineTrades(artifact) {
  if (!artifact.allOOSTrades || !Array.isArray(artifact.allOOSTrades)) {
    throw new Error('allOOSTrades not found in artifact');
  }
  return artifact.allOOSTrades;
}

/**
 * Group baseline trades by signal date
 * @param {Array} trades - Baseline trades
 * @returns {Map<string, Array>} Map of signalDate -> trades
 */
export function groupTradesBySignalDate(trades) {
  const grouped = new Map();
  for (const trade of trades) {
    if (!grouped.has(trade.signalDate)) {
      grouped.set(trade.signalDate, []);
    }
    grouped.get(trade.signalDate).push(trade);
  }
  return grouped;
}

/**
 * Get zero-signal dates (dates with no trades)
 * @param {Array} dateMetadata - Test run date metadata
 * @param {Map} tradesByDate - Trades grouped by signal date
 * @returns {Array<string>} Signal dates with no trades
 */
export function getZeroSignalDates(dateMetadata, tradesByDate) {
  return dateMetadata
    .map(d => d.signalDate)
    .filter(date => !tradesByDate.has(date) || tradesByDate.get(date).length === 0);
}

/**
 * Validate 29-date structure
 * @param {Array} dateMetadata - Test run date metadata
 * @throws {Error} If validation fails
 */
export function validate29DateStructure(dateMetadata) {
  if (dateMetadata.length !== 29) {
    throw new Error(`Expected 29 dates, got ${dateMetadata.length}`);
  }

  const dates = dateMetadata.map(d => d.signalDate);
  const uniqueDates = new Set(dates);
  if (uniqueDates.size !== 29) {
    throw new Error(`Duplicate signal dates found: ${dates.length - uniqueDates.size} duplicates`);
  }

  // Check chronological order
  for (let i = 1; i < dates.length; i++) {
    if (new Date(dates[i]) <= new Date(dates[i - 1])) {
      throw new Error(`Signal dates not strictly increasing: ${dates[i - 1]} >= ${dates[i]}`);
    }
  }

  // Validate structure
  for (const meta of dateMetadata) {
    if (!meta.runId || !meta.signalDate || !meta.entryDate || !meta.labelEndDate) {
      throw new Error(`Invalid date metadata: ${JSON.stringify(meta)}`);
    }
  }
}
