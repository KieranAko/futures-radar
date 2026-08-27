import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyKnobs, aggregate, FROZEN } from '../lib/opportunity-knob-scan.js';

function row(overrides = {}) {
  return {
    symbol: 'S1',
    signalDate: '2024-03-15',
    hvRatio: 1.3,
    atrPct: 3.0,
    er: 0.25,
    adx: 28,
    absMove: 0.04,
    ...overrides
  };
}

test('applyKnobs reproduces frozen filters on the ER gate (null er excluded)', () => {
  const rows = [row(), row({ er: null }), row({ er: 0.15 })];
  assert.equal(applyKnobs(rows, {}).length, 1);
});

test('applyKnobs erThreshold 0 disables the ER gate including null-er rows', () => {
  const rows = [row(), row({ er: null }), row({ er: 0.15 })];
  assert.equal(applyKnobs(rows, { erThreshold: 0 }).length, 3);
});

test('applyKnobs topN slices after atrPct descending sort', () => {
  const rows = [
    row({ symbol: 'A', atrPct: 2.2 }),
    row({ symbol: 'B', atrPct: 4.0 }),
    row({ symbol: 'C', atrPct: 3.1 })
  ];
  const top2 = applyKnobs(rows, { topN: 2 });
  assert.deepEqual(top2.map(r => r.symbol), ['B', 'C']);
});

test('applyKnobs topN slices per date, not across the pooled table', () => {
  const rows = [
    row({ symbol: 'A', signalDate: '2024-03-15', atrPct: 5.0 }),
    row({ symbol: 'B', signalDate: '2024-03-15', atrPct: 2.2 }),
    row({ symbol: 'C', signalDate: '2024-03-16', atrPct: 2.5 })
  ];
  const top1 = applyKnobs(rows, { topN: 1 });
  assert.deepEqual(top1.map(r => r.symbol), ['A', 'C']);
});

test('applyKnobs hv bounds exclude independently', () => {
  const rows = [
    row({ symbol: 'A' }),
    row({ symbol: 'B', hvRatio: 1.7 }),
    row({ symbol: 'C', hvRatio: 1.05 })
  ];
  assert.deepEqual(applyKnobs(rows, { hvMax: 1.5 }).map(r => r.symbol), ['A', 'C']);
  assert.deepEqual(applyKnobs(rows, { hvMin: 1.2 }).map(r => r.symbol), ['A', 'B']);
});

test('applyKnobs atr floor excludes independently', () => {
  const rows = [
    row({ symbol: 'A' }),
    row({ symbol: 'G', atrPct: 2.4 }),
    row({ symbol: 'H', atrPct: 1.5 })
  ];
  assert.deepEqual(applyKnobs(rows, {}).map(r => r.symbol), ['A', 'G']);
  assert.deepEqual(applyKnobs(rows, { atrFloor: 2.5 }).map(r => r.symbol), ['A']);
});

test('applyKnobs adx floor excludes null and below-threshold', () => {
  const rows = [
    row({ symbol: 'A' }),
    row({ symbol: 'E', adx: 15 }),
    row({ symbol: 'F', adx: null })
  ];
  assert.deepEqual(applyKnobs(rows, { adxFloor: 20 }).map(r => r.symbol), ['A']);
});

test('applyKnobs scanner-raw profile keeps rows with null hvRatio', () => {
  const rows = [row(), row({ hvRatio: null }), row({ atrPct: 1.0 })];
  const picked = applyKnobs(rows, { erThreshold: 0, hvMin: null, atrFloor: 0 });
  assert.equal(picked.length, 3);
});

test('aggregate counts hit rate over withOutcome only and splits byYear', () => {
  const rows = [
    row({ symbol: 'A', absMove: 0.05 }),
    row({ symbol: 'B', absMove: 0.01 }),
    row({ symbol: 'C', absMove: null }),
    row({ symbol: 'D', absMove: 0.04, signalDate: '2025-06-10' })
  ];
  const agg = aggregate(rows);
  assert.equal(agg.candidates, 4);
  assert.equal(agg.withOutcome, 3);
  assert.equal(agg.strong, 2);
  assert.ok(Math.abs(agg.hitRate - 2 / 3) < 1e-9);
  assert.deepEqual(agg.byYear['2024'], { withOutcome: 2, strong: 1 });
  assert.deepEqual(agg.byYear['2025'], { withOutcome: 1, strong: 1 });
});

test('FROZEN constants match the frozen production cohort', () => {
  assert.deepEqual(FROZEN, {
    erThreshold: 0.2,
    topN: null,
    hvMin: 1.0,
    hvMax: null,
    adxFloor: 0,
    atrFloor: 2.0
  });
});
