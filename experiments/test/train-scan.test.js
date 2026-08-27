import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterTrainDates, expandGrid } from '../lib/train-scan.js';

test('filterTrainDates keeps only dates within the inclusive train window', () => {
  const dates = ['2023-12-29', '2024-01-02', '2024-03-15', '2026-06-16', '2026-06-17'];
  assert.deepEqual(filterTrainDates(dates, '2024-01-02', '2026-06-16'), [
    '2024-01-02', '2024-03-15', '2026-06-16'
  ]);
  assert.deepEqual(filterTrainDates(dates, '2024-01-01', '2024-01-01'), []);
});

test('expandGrid produces the full cross product in er-major order', () => {
  const pairs = expandGrid([0.2, 0.25], [0.3, 0.4, 0.5]);
  assert.deepEqual(pairs, [
    { erThreshold: 0.2, slopeThreshold: 0.3 },
    { erThreshold: 0.2, slopeThreshold: 0.4 },
    { erThreshold: 0.2, slopeThreshold: 0.5 },
    { erThreshold: 0.25, slopeThreshold: 0.3 },
    { erThreshold: 0.25, slopeThreshold: 0.4 },
    { erThreshold: 0.25, slopeThreshold: 0.5 }
  ]);
  assert.equal(expandGrid([], [0.3]).length, 0);
});
