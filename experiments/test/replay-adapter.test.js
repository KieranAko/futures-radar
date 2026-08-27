/**
 * Test: replay-adapter.js — Load and validate 29-date conditional OOS artifact
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadWalkForwardArtifact,
  getTestRunDates,
  getBaselineTrades,
  groupTradesBySignalDate,
  getZeroSignalDates,
  validate29DateStructure,
} from '../lib/replay-adapter.js';

test('replay-adapter: load artifact and validate 29-date structure', () => {
  const artifact = loadWalkForwardArtifact();

  assert.ok(artifact, 'Artifact loaded');
  assert.ok(artifact.testRunDateMetadata, 'testRunDateMetadata exists');
  assert.ok(artifact.allOOSTrades, 'allOOSTrades exists');
  assert.ok(Array.isArray(artifact.testRunDateMetadata), 'testRunDateMetadata is array');
  assert.ok(Array.isArray(artifact.allOOSTrades), 'allOOSTrades is array');
});

test('replay-adapter: getTestRunDates returns exactly 29 dates', () => {
  const artifact = loadWalkForwardArtifact();
  const dates = getTestRunDates(artifact);

  assert.equal(dates.length, 29, 'Exactly 29 test run dates');

  for (const d of dates) {
    assert.ok(d.runId, 'runId exists');
    assert.ok(d.signalDate, 'signalDate exists');
    assert.ok(d.entryDate, 'entryDate exists');
    assert.ok(d.labelEndDate, 'labelEndDate exists');
  }
});

test('replay-adapter: validate29DateStructure enforces uniqueness and chronology', () => {
  const artifact = loadWalkForwardArtifact();
  const dates = getTestRunDates(artifact);

  // Should not throw
  validate29DateStructure(dates);

  // Check uniqueness
  const signalDates = dates.map(d => d.signalDate);
  const uniqueDates = new Set(signalDates);
  assert.equal(uniqueDates.size, 29, 'All signal dates are unique');

  // Check chronological order
  for (let i = 1; i < signalDates.length; i++) {
    const prev = new Date(signalDates[i - 1]);
    const curr = new Date(signalDates[i]);
    assert.ok(curr > prev, `Date ${i} (${signalDates[i]}) is after date ${i - 1} (${signalDates[i - 1]})`);
  }
});

test('replay-adapter: getBaselineTrades returns valid trade structures', () => {
  const artifact = loadWalkForwardArtifact();
  const trades = getBaselineTrades(artifact);

  assert.ok(trades.length > 0, 'At least one baseline trade exists');

  for (const trade of trades) {
    assert.ok(trade.runId, 'runId exists');
    assert.ok(trade.signalDate, 'signalDate exists');
    assert.ok(trade.symbol, 'symbol exists');
    assert.ok(trade.direction === 'bullish' || trade.direction === 'bearish', 'direction is bullish or bearish');
    assert.ok(trade.entryDate, 'entryDate exists');
    assert.ok(trade.exitDate, 'exitDate exists');
    assert.ok(typeof trade.entryPrice === 'number', 'entryPrice is number');
    assert.ok(typeof trade.exitPrice === 'number', 'exitPrice is number');
    assert.ok(typeof trade.grossReturn === 'number', 'grossReturn is number');
    assert.ok(typeof trade.costs === 'number', 'costs is number');
    assert.ok(typeof trade.netReturn === 'number', 'netReturn is number');
  }
});

test('replay-adapter: groupTradesBySignalDate creates correct mapping', () => {
  const artifact = loadWalkForwardArtifact();
  const trades = getBaselineTrades(artifact);
  const grouped = groupTradesBySignalDate(trades);

  assert.ok(grouped instanceof Map, 'Returns a Map');
  assert.ok(grouped.size > 0, 'Map has at least one entry');

  // Verify no trade appears in multiple dates
  const seenTrades = new Set();
  for (const [date, dateTrades] of grouped) {
    assert.ok(typeof date === 'string', 'Date key is string');
    assert.ok(Array.isArray(dateTrades), 'Value is array');

    for (const trade of dateTrades) {
      const key = `${trade.runId}-${trade.symbol}`;
      assert.ok(!seenTrades.has(key), `Trade ${key} appears only once`);
      seenTrades.add(key);
      assert.equal(trade.signalDate, date, 'Trade signalDate matches map key');
    }
  }
});

test('replay-adapter: getZeroSignalDates identifies dates with no trades', () => {
  const artifact = loadWalkForwardArtifact();
  const dates = getTestRunDates(artifact);
  const trades = getBaselineTrades(artifact);
  const grouped = groupTradesBySignalDate(trades);
  const zeroDates = getZeroSignalDates(dates, grouped);

  assert.ok(Array.isArray(zeroDates), 'Returns array');

  // Verify zero dates have no trades
  for (const date of zeroDates) {
    assert.ok(!grouped.has(date) || grouped.get(date).length === 0, `${date} has no trades`);
  }

  // Verify non-zero dates have trades
  const allSignalDates = dates.map(d => d.signalDate);
  const nonZeroDates = allSignalDates.filter(d => !zeroDates.includes(d));
  for (const date of nonZeroDates) {
    assert.ok(grouped.has(date) && grouped.get(date).length > 0, `${date} has trades`);
  }
});

test('replay-adapter: zero-signal dates must be preserved in 29-date structure', () => {
  const artifact = loadWalkForwardArtifact();
  const dates = getTestRunDates(artifact);
  const trades = getBaselineTrades(artifact);
  const grouped = groupTradesBySignalDate(trades);
  const zeroDates = getZeroSignalDates(dates, grouped);

  // Even if some dates have zero trades, all 29 dates must be in metadata
  assert.equal(dates.length, 29, '29 dates preserved including zero-signal dates');

  console.log(`  ℹ Zero-signal dates: ${zeroDates.length}/${dates.length}`);
  for (const date of zeroDates) {
    console.log(`    - ${date} (no trades)`);
  }
});
