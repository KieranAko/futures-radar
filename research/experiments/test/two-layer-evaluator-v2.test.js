import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateDirectionLayer,
  evaluateOpportunityLayer,
  evaluateTwoLayerModelV2,
} from '../lib/two-layer-evaluator-v2.js';

const candidates = [
  { symbol: 'A', signalDate: '2026-01-01' },
  { symbol: 'B', signalDate: '2026-01-01' },
  { symbol: 'C', signalDate: '2026-01-01' },
];

const candidateOutcomes = [
  { symbol: 'A', signalDate: '2026-01-01', absMove: 0.04, outcomeAvailable: true },
  { symbol: 'B', signalDate: '2026-01-01', absMove: 0.02, outcomeAvailable: true },
  { symbol: 'C', signalDate: '2026-01-01', outcomeAvailable: false },
];

test('opportunity layer includes uncertain direction candidates', () => {
  const result = evaluateOpportunityLayer(candidates, candidateOutcomes, 0.03);

  assert.equal(result.totalCandidates, 3);
  assert.equal(result.totalWithOutcome, 2);
  assert.equal(result.opportunityHits, 1);
  assert.equal(result.opportunityMisses, 1);
  assert.equal(result.opportunityHitRate, 0.5);
});

test('direction threshold changes do not alter opportunity metrics', () => {
  const looseSignals = [
    { symbol: 'A', signalDate: '2026-01-01', direction: 'long' },
    { symbol: 'B', signalDate: '2026-01-01', direction: 'short' },
    { symbol: 'C', signalDate: '2026-01-01', direction: 'uncertain' },
  ];
  const strictSignals = looseSignals.map(signal => ({ ...signal, direction: 'uncertain' }));
  const looseTrades = [
    { symbol: 'A', signalDate: '2026-01-01', direction: 'long', entryPrice: 100, exitPrice: 104, netReturn: 0.039 },
    { symbol: 'B', signalDate: '2026-01-01', direction: 'short', entryPrice: 100, exitPrice: 102, netReturn: -0.021 },
  ];

  const loose = evaluateTwoLayerModelV2(
    candidates,
    candidateOutcomes,
    looseSignals,
    looseTrades,
    10,
    0.03
  );
  const strict = evaluateTwoLayerModelV2(
    candidates,
    candidateOutcomes,
    strictSignals,
    [],
    10,
    0.03
  );

  assert.deepEqual(loose.opportunity, strict.opportunity);
  assert.equal(loose.direction.totalDirectional, 2);
  assert.equal(strict.direction.totalDirectional, 0);
});

test('direction layer evaluates long and short signs correctly', () => {
  const signals = [
    { symbol: 'LONG_HIT', signalDate: '2026-01-01', direction: 'long' },
    { symbol: 'LONG_MISS', signalDate: '2026-01-01', direction: 'long' },
    { symbol: 'SHORT_HIT', signalDate: '2026-01-01', direction: 'short' },
    { symbol: 'SHORT_MISS', signalDate: '2026-01-01', direction: 'short' },
  ];
  const trades = [
    { symbol: 'LONG_HIT', signalDate: '2026-01-01', direction: 'long', entryPrice: 100, exitPrice: 101 },
    { symbol: 'LONG_MISS', signalDate: '2026-01-01', direction: 'long', entryPrice: 100, exitPrice: 99 },
    { symbol: 'SHORT_HIT', signalDate: '2026-01-01', direction: 'short', entryPrice: 100, exitPrice: 99 },
    { symbol: 'SHORT_MISS', signalDate: '2026-01-01', direction: 'short', entryPrice: 100, exitPrice: 101 },
  ];

  const result = evaluateDirectionLayer(signals, trades);

  assert.equal(result.directionHitRate, 0.5);
  assert.equal(result.longHitRate, 0.5);
  assert.equal(result.shortHitRate, 0.5);
});
