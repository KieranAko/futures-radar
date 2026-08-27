import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertDevelopmentBoundary,
  assertExecutable,
  assertTradingCalendar,
  buildReplayRaw,
  loadHoldoutManifest,
  runHistoricalHoldout
} from '../lib/historical-holdout.js';

function fixtureCache() {
  const dates = Array.from({ length: 45 }, (_, i) =>
    `2026-01-${String(i + 1).padStart(2, '0')}`);
  const values = dates.map((_, i) => 100 + i);
  return {
    contracts: {
      X0: {
        symbol: 'X0',
        ohlcv: {
          dates,
          open: values,
          high: values.map(v => v + 1),
          low: values.map(v => v - 1),
          close: values,
          volume: values.map(() => 1000),
          open_interest: values.map(() => 2000)
        }
      }
    }
  };
}

function fixtureManifest(overrides = {}) {
  return {
    schemaVersion: 1,
    modelFreezeCommit: 'a'.repeat(40),
    configs: {
      main: { erThreshold: 0.2, topN: null, holdPeriod: 10, slopeThreshold: 0.3 },
      control: { erThreshold: 0.18, topN: null, holdPeriod: 10, slopeThreshold: 0.3 }
    },
    source: { path: 'cache.json', sha256: 'b'.repeat(64), contracts: 1 },
    lockedFiles: {},
    selection: {
      lastDevelopmentLabelEndDate: '2026-01-25',
      firstSignalDate: '2026-01-26',
      lastSignalDate: '2026-01-30'
    },
    signalDates: ['2026-01-26', '2026-01-27', '2026-01-28', '2026-01-29', '2026-01-30'],
    prohibitions: [],
    ...overrides
  };
}

test('loadHoldoutManifest rejects malformed and duplicate signal dates', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'holdout-'));
  const file = path.join(dir, 'manifest.json');
  fs.writeFileSync(file, JSON.stringify(fixtureManifest({ signalDates: ['2026-01-26', '2026-01-26'] })));
  assert.throws(() => loadHoldoutManifest(file), /duplicate/i);
});

test('assertManifest rejects structurally invalid configs instead of hardcoded values', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'holdout-'));
  const file = path.join(dir, 'manifest.json');
  for (const configs of [
    { main: { erThreshold: '0.2', topN: null, holdPeriod: 10, slopeThreshold: 0.3 } },
    { main: { erThreshold: 0.2, topN: null, holdPeriod: 10 } },
    { main: { erThreshold: 0.2, topN: null, holdPeriod: 10, slopeThreshold: -0.1 } },
    { main: { erThreshold: 0.2, topN: null, holdPeriod: 10, slopeThreshold: 0.3, extra: 1 } }
  ]) {
    fs.writeFileSync(file, JSON.stringify({ ...fixtureManifest(), configs }));
    assert.throws(() => loadHoldoutManifest(file), /config/);
  }
});

test('runHistoricalHoldout scores every config declared in the manifest', () => {
  const manifest = fixtureManifest({
    configs: {
      main: { erThreshold: 0.2, topN: null, holdPeriod: 10, slopeThreshold: 0.3 },
      control: { erThreshold: 0.18, topN: null, holdPeriod: 10, slopeThreshold: 0.3 },
      optimized: { erThreshold: 0.25, topN: null, holdPeriod: 10, slopeThreshold: 0.4 }
    }
  });
  const seen = [];
  const runDate = (date, raw, config) => {
    seen.push(config);
    return { candidates: [], outcomes: [], signals: [], trades: { d0: [], d1: [], d2: [], d3: [], d4: [] } };
  };
  const result = runHistoricalHoldout(manifest, fixtureCache(), runDate);
  assert.equal(seen.length, manifest.signalDates.length * 3);
  assert.ok(seen.some(c => c.erThreshold === 0.25 && c.slopeThreshold === 0.4));
  assert.ok(result.dates.every(d => 'optimized' in d && 'main' in d && 'control' in d));
});

test('runHistoricalHoldout rejects pre-dev dates at or after development first run', () => {
  const manifest = fixtureManifest({
    signalDates: ['2026-01-25'],
    selection: {
      developmentFirstRunDate: '2024-01-02',
      firstSignalDate: '2023-10-30',
      lastSignalDate: '2023-12-31'
    }
  });
  assert.throws(
    () => runHistoricalHoldout(manifest, fixtureCache(), () => assert.fail('must not run')),
    /development/
  );
});

test('runHistoricalHoldout accepts pre-dev dates strictly before development first run', () => {
  const manifest = fixtureManifest({
    signalDates: ['2026-01-26'],
    selection: {
      developmentFirstRunDate: '2026-02-01',
      firstSignalDate: '2026-01-01',
      lastSignalDate: '2026-01-31'
    }
  });
  const seen = [];
  const runDate = (date) => {
    seen.push(date);
    return { candidates: [], outcomes: [], signals: [], trades: { d0: [], d1: [], d2: [], d3: [], d4: [] } };
  };
  runHistoricalHoldout(manifest, fixtureCache(), runDate);
  assert.equal(seen.length, 2);
  assert.ok(seen.every(d => d === '2026-01-26'));
});

test('assertDevelopmentBoundary is exported and enforces the pre-dev boundary standalone', () => {
  const preDev = fixtureManifest({
    signalDates: ['2026-01-26'],
    selection: {
      developmentFirstRunDate: '2026-02-01',
      firstSignalDate: '2026-01-01',
      lastSignalDate: '2026-01-31'
    }
  });
  assert.doesNotThrow(() => assertDevelopmentBoundary(preDev));
  const violation = fixtureManifest({
    signalDates: ['2026-01-26', '2026-02-02'],
    selection: {
      developmentFirstRunDate: '2026-02-01',
      firstSignalDate: '2026-01-01',
      lastSignalDate: '2026-01-31'
    }
  });
  assert.throws(() => assertDevelopmentBoundary(violation), /development/);
});

test('assertDevelopmentBoundary rejects manifests declaring both or neither boundary', () => {
  const both = fixtureManifest({
    selection: {
      lastDevelopmentLabelEndDate: '2026-01-01',
      developmentFirstRunDate: '2024-01-02',
      firstSignalDate: '2023-10-30',
      lastSignalDate: '2023-12-31'
    }
  });
  assert.throws(() => runHistoricalHoldout(both, fixtureCache(), () => assert.fail('must not run')), /exactly one/i);
  const neither = fixtureManifest({
    selection: { firstSignalDate: '2023-10-30', lastSignalDate: '2023-12-31' }
  });
  assert.throws(() => runHistoricalHoldout(neither, fixtureCache(), () => assert.fail('must not run')), /exactly one/i);
});

test('buildReplayRaw preserves full history and future bars and normalizes open interest', () => {
  const raw = buildReplayRaw(fixtureCache());
  assert.equal(raw.contracts.X0.ohlcv.dates.length, 45);
  assert.deepEqual(raw.contracts.X0.ohlcv.openInterest, raw.contracts.X0.ohlcv.open_interest);
});

test('runHistoricalHoldout retains every paired date including zero-candidate dates', () => {
  const manifest = fixtureManifest();
  const cache = fixtureCache();
  const seen = [];
  const runDate = (date, raw, config) => {
    seen.push({ date, config, bars: raw.contracts.X0.ohlcv.dates.length });
    return { candidates: [], outcomes: [], signals: [], trades: { d0: [], d1: [], d2: [], d3: [], d4: [] } };
  };
  const result = runHistoricalHoldout(manifest, cache, runDate);
  assert.equal(result.pairedDates, manifest.signalDates.length);
  assert.equal(result.dates.length, manifest.signalDates.length);
  assert.ok(result.dates.every(d => d.main.candidates.length === 0 && d.control.candidates.length === 0));
  assert.equal(seen.length, manifest.signalDates.length * 2);
  assert.ok(seen.every(x => x.bars === 45));
});

test('runHistoricalHoldout fails closed when a listed date lacks T+11 for any contract', () => {
  const cache = fixtureCache();
  cache.contracts.X0.ohlcv.dates = cache.contracts.X0.ohlcv.dates.slice(0, 36);
  for (const key of ['open', 'high', 'low', 'close', 'volume', 'open_interest']) {
    cache.contracts.X0.ohlcv[key] = cache.contracts.X0.ohlcv[key].slice(0, 36);
  }
  assert.throws(
    () => runHistoricalHoldout(fixtureManifest(), cache, () => assert.fail('must not run')),
    /future bars|T\+11/i
  );
});

test('runHistoricalHoldout rejects dates at or before development label end', () => {
  const manifest = fixtureManifest({ signalDates: ['2026-01-25'] });
  assert.throws(
    () => runHistoricalHoldout(manifest, fixtureCache(), () => assert.fail('must not run')),
    /development/i
  );
});

test('assertExecutable accepts boundary signalIdx=25 (25 prior bars + T)', () => {
  assert.doesNotThrow(() => assertExecutable(buildReplayRaw(fixtureCache()), '2026-01-26'));
});

test('assertExecutable rejects boundary signalIdx=24 (only 24 prior bars)', () => {
  assert.throws(
    () => assertExecutable(buildReplayRaw(fixtureCache()), '2026-01-25'),
    /prior bars/
  );
});

test('assertExecutable fails closed when a contract lacks 25 prior bars', () => {
  assert.throws(
    () => assertExecutable(buildReplayRaw(fixtureCache()), '2026-01-10'),
    /prior bars/
  );
});

test('assertExecutable fails closed when the date is absent from a contract', () => {
  assert.throws(
    () => assertExecutable(buildReplayRaw(fixtureCache()), '2026-02-01'),
    /not found/
  );
});

test('assertTradingCalendar rejects a fixed date outside the trading calendar', () => {
  const manifest = fixtureManifest({ signalDates: ['2026-02-01'] });
  assert.throws(
    () => assertTradingCalendar(manifest, fixtureCache()),
    /trading day/
  );
});
