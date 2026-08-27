/**
 * E4b Account-Level Validation Gate Tests
 *
 * Tests economic viability checks on assembled challenger configuration.
 * Registry v1.3 Section 7.2 - Nine gates + economic thresholds
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAccountGate, compareAccountPerformance } from '../research/experiments/e4b-account-gate.js';

test('E4b Account Gate', async (t) => {
  await t.test('should pass when all criteria met', () => {
    const trades = [
      { netReturn: 0.05, entryDate: '2024-01-02', exitDate: '2024-01-12' },
      { netReturn: 0.03, entryDate: '2024-01-05', exitDate: '2024-01-15' },
      { netReturn: -0.02, entryDate: '2024-01-10', exitDate: '2024-01-20' },
      { netReturn: 0.04, entryDate: '2024-01-15', exitDate: '2024-01-25' },
    ];

    const result = validateAccountGate(trades, {
      initialCapital: 1000000,
      minFinalEquity: 1.05,  // > 1.05M
      maxDrawdown: 0.15,     // <= 15%
    });

    assert.equal(result.pass, true);
    assert.equal(result.finalEquity > 1050000, true);
    assert.equal(result.maxDrawdown <= 0.15, true);
  });

  await t.test('should fail when final equity below threshold', () => {
    const trades = [
      { netReturn: -0.02, entryDate: '2024-01-02', exitDate: '2024-01-12' },
      { netReturn: 0.01, entryDate: '2024-01-05', exitDate: '2024-01-15' },
    ];

    const result = validateAccountGate(trades, {
      initialCapital: 1000000,
      minFinalEquity: 1.05,
      maxDrawdown: 0.15,
    });

    assert.equal(result.pass, false);
    assert.ok(result.violations.includes('final_equity_insufficient'));
  });

  await t.test('should fail when max drawdown exceeded', () => {
    const trades = [
      { netReturn: -0.20, entryDate: '2024-01-02', exitDate: '2024-01-12' },
      { netReturn: 0.10, entryDate: '2024-01-05', exitDate: '2024-01-15' },
      { netReturn: 0.15, entryDate: '2024-01-10', exitDate: '2024-01-20' },
    ];

    const result = validateAccountGate(trades, {
      initialCapital: 1000000,
      minFinalEquity: 1.05,
      maxDrawdown: 0.15,
    });

    assert.equal(result.pass, false);
    assert.ok(result.violations.includes('max_drawdown_exceeded'));
  });

  await t.test('should handle zero trades (neutral cohort)', () => {
    const trades = [];

    const result = validateAccountGate(trades, {
      initialCapital: 1000000,
      minFinalEquity: 1.05,
      maxDrawdown: 0.15,
    });

    assert.equal(result.pass, false);
    assert.ok(result.violations.includes('final_equity_insufficient'));
    assert.equal(result.finalEquity, 1000000); // No change
  });

  await t.test('should track cumulative equity curve', () => {
    const trades = [
      { netReturn: 0.10, entryDate: '2024-01-02', exitDate: '2024-01-12' },
      { netReturn: -0.05, entryDate: '2024-01-05', exitDate: '2024-01-15' },
      { netReturn: 0.08, entryDate: '2024-01-10', exitDate: '2024-01-20' },
    ];

    const result = validateAccountGate(trades, {
      initialCapital: 1000000,
      minFinalEquity: 1.05,
      maxDrawdown: 0.15,
    });

    assert.ok(Array.isArray(result.equityCurve));
    assert.equal(result.equityCurve.length, 4); // initial + 3 trades
    assert.equal(result.equityCurve[0], 1000000);
    assert.equal(result.equityCurve[3], result.finalEquity);
  });

  await t.test('should compare baseline vs challenger performance', () => {
    const baselineTrades = [
      { netReturn: 0.05, entryDate: '2024-01-02', exitDate: '2024-01-12' },
      { netReturn: 0.03, entryDate: '2024-01-05', exitDate: '2024-01-15' },
    ];

    const challengerTrades = [
      { netReturn: 0.08, entryDate: '2024-01-02', exitDate: '2024-01-12' },
      { netReturn: 0.05, entryDate: '2024-01-05', exitDate: '2024-01-15' },
    ];

    const baselineResult = validateAccountGate(baselineTrades, {
      initialCapital: 1000000,
      minFinalEquity: 1.05,
      maxDrawdown: 0.15,
    });

    const challengerResult = validateAccountGate(challengerTrades, {
      initialCapital: 1000000,
      minFinalEquity: 1.05,
      maxDrawdown: 0.15,
    });

    const comparison = compareAccountPerformance(baselineResult, challengerResult, {
      maxDDTolerance: 0.03,
      minEquityGain: 0.02,
    });

    assert.equal(comparison.pass, true, 'Challenger should pass when equity gain > 2% and DD within tolerance');
    assert.ok(comparison.comparison.equityDiff > 20000, 'Equity diff should exceed 2% of initial capital');
  });

  await t.test('should fail comparison when challenger equity gain insufficient', () => {
    const baselineTrades = [
      { netReturn: 0.08, entryDate: '2024-01-02', exitDate: '2024-01-12' },
    ];

    const challengerTrades = [
      { netReturn: 0.09, entryDate: '2024-01-02', exitDate: '2024-01-12' }, // Only 1% better
    ];

    const baselineResult = validateAccountGate(baselineTrades, {
      initialCapital: 1000000,
      minFinalEquity: 1.05,
      maxDrawdown: 0.15,
    });

    const challengerResult = validateAccountGate(challengerTrades, {
      initialCapital: 1000000,
      minFinalEquity: 1.05,
      maxDrawdown: 0.15,
    });

    // Baseline: 1M * 1.08 = 1.08M
    // Challenger: 1M * 1.09 = 1.09M
    // Diff = 10K = 1% of initial capital
    // Threshold = 2% of initial capital = 20K
    // Should fail because 10K < 20K

    const comparison = compareAccountPerformance(baselineResult, challengerResult, {
      maxDDTolerance: 0.03,
      minEquityGain: 0.02,
    });

    assert.equal(comparison.pass, false, 'Challenger should fail when equity gain < 2%');
    assert.ok(comparison.violations.includes('challenger_equity_insufficient'));
    assert.ok(comparison.comparison.equityDiff < 20000, 'Equity diff should be less than 2% threshold');
  });
});
