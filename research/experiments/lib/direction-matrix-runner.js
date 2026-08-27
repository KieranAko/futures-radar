/**
 * Direction Matrix Runner — Fixed opportunity cohort + cumulative direction layers
 *
 * Spec (缅因猫 2026-08-13):
 * - Cohort: real ER selector (selectOpportunitiesO1) with fixed ER threshold,
 *   topN=null (full candidate set). Direction features NEVER select candidates.
 * - Layers D0-D3 are cumulative confirmations; trades only for directional signals.
 * - Outcomes are direction-neutral (opportunity label): priceChange + absMove
 *   from T+1 open entry to T+11 close exit (H10), same cost model as baseline.
 */

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { selectOpportunitiesO1 } from './opportunity-orthogonal.js';
import {
  determineD0Direction,
  layerD1Direction,
  layerD2Direction,
  layerD3Direction
} from './direction-features.js';
import { loadSectorMap, layerD4Direction } from './direction-sync.js';

const require = createRequire(import.meta.url);
const lib = require('../../backtest/shared-backtest-lib.cjs');

export const DIRECTION_LAYERS = ['d0', 'd1', 'd2', 'd3', 'd4'];

const DEFAULT_SECTOR_MAP = loadSectorMap(
  JSON.parse(readFileSync(new URL('../../../config/symbols.json', import.meta.url), 'utf8'))
);

/**
 * Run the direction matrix on a single signal date
 * @param {string} signalDate - Signal date T
 * @param {Object} raw - Raw OHLCV data for the run
 * @param {Object} config - {erThreshold, topN, holdPeriod, slopeThreshold}
 * @returns {{candidates: Array, outcomes: Array, signals: Array, trades: Object}}
 */
export function runDirectionMatrixDate(signalDate, raw, config) {
  const {
    erThreshold,
    topN = null,
    holdPeriod = 10,
    slopeThreshold = 0.3,
    sectorMap
  } = config;

  // Fixed opportunity cohort — direction features do not participate
  const candidates = selectOpportunitiesO1(signalDate, raw, erThreshold, topN);

  const outcomes = [];
  const signals = [];
  const trades = Object.fromEntries(DIRECTION_LAYERS.map(layer => [layer, []]));

  for (const cand of candidates) {
    const contract = raw.contracts[cand.symbol];
    if (!contract?.ohlcv) continue;

    const { dates, high, low, close, volume, openInterest } = contract.ohlcv;
    const signalIdx = dates.indexOf(signalDate);
    if (signalIdx < 0) continue;

    const T = signalIdx;
    const trunc = (arr) => (Array.isArray(arr) ? arr.slice(0, T + 1) : []);
    const tHigh = trunc(high);
    const tLow = trunc(low);
    const tClose = trunc(close);
    const tVol = trunc(volume);
    const tOI = trunc(openInterest);

    const directions = {
      d0: determineD0Direction(tClose, slopeThreshold),
      d1: layerD1Direction(tHigh, tLow, tClose, slopeThreshold),
      d2: layerD2Direction(tHigh, tLow, tClose, tVol, slopeThreshold),
      d3: layerD3Direction(tHigh, tLow, tClose, tVol, tOI, slopeThreshold)
    };
    directions.d4 = layerD4Direction(
      signalDate, cand.symbol, raw, config.sectorMap ?? DEFAULT_SECTOR_MAP,
      directions.d3, slopeThreshold
    );

    // Direction-neutral opportunity outcome: T+1 open entry, T+11 close exit
    const entry = lib.simulateEntry(cand.symbol, raw, signalDate);
    const exit = entry ? lib.simulateExit(cand.symbol, raw, entry.entryIdx, holdPeriod) : null;
    const outcomeAvailable = Boolean(entry && exit);
    const priceChange = outcomeAvailable
      ? (exit.exitPrice - entry.entryPrice) / entry.entryPrice
      : null;

    outcomes.push({
      symbol: cand.symbol,
      signalDate,
      priceChange,
      absMove: priceChange !== null ? Math.abs(priceChange) : null,
      outcomeAvailable
    });

    signals.push({ symbol: cand.symbol, signalDate, ...directions });

    if (!outcomeAvailable) continue;

    for (const layer of DIRECTION_LAYERS) {
      const direction = directions[layer];
      if (direction === 'uncertain') continue;

      const sign = direction === 'long' ? 1 : -1;
      const grossReturn = sign * priceChange;
      const costs = lib.calculateCosts(entry.entryPrice, exit.exitPrice);

      trades[layer].push({
        symbol: cand.symbol,
        signalDate,
        direction,
        entryDate: entry.entryDate,
        exitDate: exit.exitDate,
        entryPrice: entry.entryPrice,
        exitPrice: exit.exitPrice,
        grossReturn,
        costs,
        netReturn: grossReturn - costs
      });
    }
  }

  return { candidates, outcomes, signals, trades };
}

/**
 * Evaluate direction matrix across dates, per layer
 * @param {Array} dateResults - Results from runDirectionMatrixDate per date
 * @param {number} minMoveThreshold - Strong opportunity threshold (0.03)
 * @returns {Object} Per-layer statistics
 */
export function evaluateDirectionMatrix(dateResults, minMoveThreshold = 0.03) {
  const allCandidates = dateResults.flatMap(r => r.candidates);
  const allSignals = dateResults.flatMap(r => r.signals);
  const outcomeMap = new Map(
    dateResults
      .flatMap(r => r.outcomes)
      .filter(o => o.outcomeAvailable)
      .map(o => [`${o.signalDate}:${o.symbol}`, o])
  );

  const totalCandidates = allCandidates.length;
  const totalWithOutcome = allSignals.filter(s => outcomeMap.has(`${s.signalDate}:${s.symbol}`)).length;
  const strongOpportunities = [...outcomeMap.values()].filter(o => o.absMove >= minMoveThreshold).length;

  const perLayer = {};
  for (const layer of DIRECTION_LAYERS) {
    const directional = allSignals.filter(s => s[layer] !== 'uncertain');
    const withOutcome = directional
      .map(s => ({ ...s, outcome: outcomeMap.get(`${s.signalDate}:${s.symbol}`) }))
      .filter(s => s.outcome);

    let longHit = 0, longTotal = 0, shortHit = 0, shortTotal = 0;
    let strongHit = 0, strongTotal = 0;
    let netSum = 0;

    for (const s of withOutcome) {
      const correct = s[layer] === 'long'
        ? s.outcome.priceChange > 0
        : s.outcome.priceChange < 0;

      if (s[layer] === 'long') {
        longTotal++;
        if (correct) longHit++;
      } else {
        shortTotal++;
        if (correct) shortHit++;
      }

      if (s.outcome.absMove >= minMoveThreshold) {
        strongTotal++;
        if (correct) strongHit++;
      }
    }

    const directionalWithOutcome = withOutcome.length;
    const totalHit = longHit + shortHit;
    const trades = dateResults.flatMap(r => r.trades[layer]);
    for (const t of trades) netSum += t.netReturn;

    const uncertain = totalCandidates - directional.length;
    perLayer[layer] = {
      layer,
      candidates: totalCandidates,
      withOutcome: totalWithOutcome,
      directional,
      directionalWithOutcome,
      uncertain,
      uncertainRate: totalCandidates > 0 ? uncertain / totalCandidates : null,
      longHit,
      longTotal,
      shortHit,
      shortTotal,
      directionHitRate: directionalWithOutcome > 0 ? totalHit / directionalWithOutcome : null,
      strongHit,
      strongTotal,
      strongHitRate: strongTotal > 0 ? strongHit / strongTotal : null,
      trades: trades.length,
      avgNetReturn: trades.length > 0 ? netSum / trades.length : null
    };
  }

  return {
    totalCandidates,
    totalWithOutcome,
    strongOpportunities,
    minMoveThreshold,
    perLayer
  };
}
