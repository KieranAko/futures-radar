/**
 * Test: prediction-quality-evaluator.js — Parameter backtest scoring engine
 * Core metrics: hitRate and netReturnMean
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePredictionQuality, evaluateBySignalDate } from '../lib/prediction-quality-evaluator.js';

test('prediction-quality: long signals with 100% hit rate', () => {
  const trades = [
    { symbol: 'TEST1', direction: 'bullish', entryPrice: 1000, exitPrice: 1050, signalDate: '2024-01-01' },
    { symbol: 'TEST2', direction: 'bullish', entryPrice: 2000, exitPrice: 2100, signalDate: '2024-01-01' },
  ];

  const result = evaluatePredictionQuality(trades);

  assert.equal(result.totalSignals, 2);
  assert.equal(result.longSignals, 2);
  assert.equal(result.shortSignals, 0);
  assert.equal(result.long.sampleSize, 2);
  assert.equal(result.long.hitRate, 1.0, 'All long signals should hit');
  assert.ok(result.long.netReturnMean > 0, 'Net return should be positive after costs');
});

test('prediction-quality: short signals with 100% hit rate', () => {
  const trades = [
    { symbol: 'TEST1', direction: 'bearish', entryPrice: 1050, exitPrice: 1000, signalDate: '2024-01-01' },
    { symbol: 'TEST2', direction: 'bearish', entryPrice: 2100, exitPrice: 2000, signalDate: '2024-01-01' },
  ];

  const result = evaluatePredictionQuality(trades);

  assert.equal(result.totalSignals, 2);
  assert.equal(result.longSignals, 0);
  assert.equal(result.shortSignals, 2);
  assert.equal(result.short.sampleSize, 2);
  assert.equal(result.short.hitRate, 1.0, 'All short signals should hit');
  assert.ok(result.short.netReturnMean > 0, 'Net return should be positive');
});

test('prediction-quality: mixed hit/miss long signals', () => {
  const trades = [
    { symbol: 'HIT', direction: 'bullish', entryPrice: 1000, exitPrice: 1050, signalDate: '2024-01-01' },
    { symbol: 'MISS', direction: 'bullish', entryPrice: 1000, exitPrice: 950, signalDate: '2024-01-01' },
  ];

  const result = evaluatePredictionQuality(trades);

  assert.equal(result.long.sampleSize, 2);
  assert.equal(result.long.hitRate, 0.5, 'Hit rate should be 50%');
  assert.ok(typeof result.long.netReturnMean === 'number', 'Net return should be calculated');
});

test('prediction-quality: date-level aggregation with zero-signal dates', () => {
  const trades = [
    { symbol: 'T1', direction: 'bullish', entryPrice: 1000, exitPrice: 1050, signalDate: '2024-01-01' },
    { symbol: 'T2', direction: 'bullish', entryPrice: 1000, exitPrice: 1040, signalDate: '2024-01-03' },
  ];

  const dates = ['2024-01-01', '2024-01-02', '2024-01-03'];

  const result = evaluateBySignalDate(trades, dates);

  assert.equal(result.totalDates, 3);
  assert.equal(result.activeSignalDates, 2);
  assert.equal(result.zeroSignalDates, 1);
  assert.equal(result.dateReturns.length, 3);
  assert.equal(result.dateReturns[1], 0, 'Zero-signal date should have return=0');
});

test('prediction-quality: empty trades array', () => {
  const result = evaluatePredictionQuality([]);

  assert.equal(result.totalSignals, 0);
  assert.equal(result.longSignals, 0);
  assert.equal(result.shortSignals, 0);
  assert.equal(result.long, null);
  assert.equal(result.short, null);
  assert.equal(result.overall, null);
});
