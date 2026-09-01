import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

describe('data-store 文件库', () => {
  let tmp;
  let dataStore;

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'futures-radar-store-'));
    process.env.FUTURES_DATA_ROOT = tmp;
    dataStore = require('../data-store/index.cjs');
    dataStore.init();
  });

  after(() => {
    delete process.env.FUTURES_DATA_ROOT;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function makeContract(symbol, dates, closeBase = 100, overrides = {}) {
    const n = dates.length;
    const ohlcv = {
      dates,
      open: dates.map((_, i) => closeBase + i),
      high: dates.map((_, i) => closeBase + i + 1),
      low: dates.map((_, i) => closeBase + i - 1),
      close: dates.map((_, i) => closeBase + i),
      volume: dates.map((_, i) => 1000 + i),
      turnover: dates.map((_, i) => 100000 + i),
      openInterest: dates.map((_, i) => 500 + i),
      settle: dates.map((_, i) => closeBase + i)
    };
    return {
      symbol,
      name: symbol,
      exchange: 'shfe',
      sector: 'black',
      multiplier: 10,
      unit: '吨/手',
      status: 'ok',
      fetchedAt: '2026-08-27T00:00:00.000Z',
      totalBars: n,
      usedBars: n,
      dataStart: dates[0],
      dataEnd: dates[dates.length - 1],
      lastBarSource: 'akshare_sina_daily',
      lastBarAsOf: dates[dates.length - 1],
      ohlcv,
      ...overrides
    };
  }

  it('ingestRunBars → loadHistoricalCache 无损往返', () => {
    const dates = ['2026-08-20', '2026-08-21'];
    const contract = makeContract('RB0', dates, 3000);
    const rawJson = {
      meta: { runId: 'run-1', collectedAt: '2026-08-27T00:00:00.000Z' },
      contracts: { RB0: contract },
      gaps: {}
    };

    const res = dataStore.ingestRunBars({ runId: 'run-1', rawJson, provenance: null });
    assert.equal(res.written, 1);
    assert.equal(res.barsChanged, 2);

    const cache = dataStore.loadHistoricalCache();
    assert.equal(cache.contracts.RB0.ohlcv.dates.length, 2);
    assert.deepEqual(cache.contracts.RB0.ohlcv.dates, dates);
    assert.deepEqual(cache.contracts.RB0.ohlcv.close, [3000, 3001]);
    assert.deepEqual(cache.contracts.RB0.ohlcv.sources, ['akshare_sina_dayline', 'akshare_sina_dayline']);
  });

  it('mergeContractBars：缺失日期插入并保持升序', () => {
    const existing = makeContract('CU0', ['2026-08-20', '2026-08-25']);
    const incoming = makeContract('CU0', ['2026-08-21']);
    const { contract, changed } = dataStore.mergeContractBars(existing, incoming);
    assert.deepEqual(contract.ohlcv.dates, ['2026-08-20', '2026-08-21', '2026-08-25']);
    assert.equal(changed.length, 1);
    assert.equal(changed[0].reason, 'added');
  });

  it('mergeContractBars：同来源 fetchedAt 更新者覆盖', () => {
    const existing = makeContract('AL0', ['2026-08-27'], 2000, {
      fetchedAt: '2026-08-27T01:00:00.000Z',
      ohlcv: {
        dates: ['2026-08-27'],
        open: [2000], high: [2001], low: [1999], close: [2000],
        volume: [100], turnover: [100000], openInterest: [50], settle: [2000],
        sources: ['akshare_sina_daily']
      }
    });
    const incoming = makeContract('AL0', ['2026-08-27'], 2010, {
      fetchedAt: '2026-08-27T02:00:00.000Z',
      ohlcv: {
        dates: ['2026-08-27'],
        open: [2010], high: [2011], low: [2009], close: [2010],
        volume: [110], turnover: [110000], openInterest: [55], settle: [2010],
        sources: ['akshare_sina_daily']
      }
    });
    const { contract, changed } = dataStore.mergeContractBars(existing, incoming);
    assert.equal(contract.ohlcv.close[0], 2010);
    assert.equal(changed.length, 1);
    assert.equal(changed[0].reason, 'replaced');
  });

  it('mergeContractBars：低优先级快照不覆盖高优先级日线', () => {
    const existing = makeContract('RB0', ['2026-08-27'], 3000);
    const incoming = makeContract('RB0', ['2026-08-27'], 9999, {
      lastBarSource: 'sina_close_snapshot',
      fetchedAt: '2026-08-27T03:00:00.000Z'
    });
    const { contract, changed } = dataStore.mergeContractBars(existing, incoming);
    assert.equal(contract.ohlcv.close[0], 3000);
    assert.equal(changed.length, 0);
  });

  it('getLatestCache 排除当前 run；文件库为空时返回 null', () => {
    const cache = dataStore.getLatestCache({ excludeRunId: 'run-1' });
    assert.equal(cache, null);

    const any = dataStore.getLatestCache({});
    assert.ok(any);
    assert.equal(any.raw.contracts.RB0.symbol, 'RB0');
  });

  it('macro 快照写入后可按 runId 精确读回', () => {
    const snapshot = {
      meta: { runId: 'macro-run', signalDate: '2026-08-27', snapshotFrozenAt: '2026-08-27T09:00:00.000Z', marketCutoffAt: '2026-08-27', schemaVersion: '1.0.0' },
      indicators: { DXY: { status: 'fresh', value: 99.1, change5d: 0.1, asOf: '2026-08-27', source: 'sina', fetchedAt: '2026-08-27T09:00:00Z' } },
      quality: { available: 1, missing: 0, eligible: true }
    };
    dataStore.ingestMacro({ runId: 'macro-run', snapshot });
    assert.deepEqual(dataStore.getMacroSnapshot('macro-run'), snapshot);
  });

  it('sector 快照写入后可按 runId 读回，并生成板块序列', () => {
    const snapshot = {
      schema: 'futures-radar-sector-snapshot/1',
      meta: { runId: 'sector-run', signalDate: '2026-08-27', generatedAt: '2026-08-27T09:00:00Z' },
      sectors: {
        black: {
          sector: 'black', label: '黑色系', direction: 'up', indexLevel: 1010.5,
          ret1d: 0.5, ret5d: 1.2, ret20d: null,
          advanceRatio1d: 60, advanceRatio5d: 70, coherence1d: 66.7, volumeRatio20d: 1.1,
          leaderSymbol: 'RB0', leaderName: '螺纹钢', leaderRet5d: 2.3, members: 9,
          dataStart: '2026-08-20', dataEnd: '2026-08-27'
        }
      }
    };
    dataStore.ingestSectorSnapshot({ runId: 'sector-run', snapshot });
    assert.deepEqual(dataStore.getSectorSnapshot('sector-run'), snapshot);
    const series = dataStore.getSectorSeries('black');
    assert.equal(series.rows.length, 1);
    assert.equal(series.rows[0].leaderSymbol, 'RB0');
  });

  it('contract bars 写入后可按 runId+symbol 读回', () => {
    const bars = [
      { date: '2026-08-26', open: 1, high: 2, low: 0.5, close: 1.5, volume: 10, hold: 20, settle: 1.4 },
      { date: '2026-08-27', open: 1.5, high: 2.5, low: 1.2, close: 2, volume: 11, hold: 21, settle: 1.9 }
    ];
    const res = dataStore.ingestContractBars({ runId: 'run-2', symbol: 'RB0', contract: 'RB2610', bars });
    assert.equal(res.written, true);
    assert.deepEqual(dataStore.getContractBarsForRun('run-2', 'RB0'), { contract: 'RB2610', bars });
    assert.equal(dataStore.getContractBarsForRun('missing', 'RB0'), null);
  });

  it('cost anchor 主档：ingest → asOf≤signalDate 查询 → 幂等覆盖 → 校验', () => {
    const base = {
      anchorType: 'processing_margin', indicator: '分工艺完全成本',
      valueLow: 550, valueHigh: 1550, unit: '元/吨', asOf: '2026-08',
      sourceDates: ['2026-08-31'], sourceTiers: ['A', 'B'], confidence: 'medium'
    };
    const res1 = dataStore.ingestCostAnchor({ runId: 'ca-run-1', symbol: 'SA0', record: base });
    assert.equal(res1.written, true);
    const rec = dataStore.getCostAnchor('SA0', '2026-08-31');
    assert.equal(rec.recordId, res1.recordId);
    assert.equal(rec.valueHigh, 1550);
    // asOf 晚于 signalDate → 不可见（防未来）
    assert.equal(dataStore.getCostAnchor('SA0', '2026-07-31'), null);
    // 同 runId 幂等覆盖
    const res2 = dataStore.ingestCostAnchor({ runId: 'ca-run-1', symbol: 'SA0', record: { ...base, valueHigh: 1600 } });
    assert.equal(res2.recordId, res1.recordId);
    assert.equal(dataStore.getCostAnchor('SA0', '2026-08-31').valueHigh, 1600);
    assert.equal(dataStore.getCostAnchorHistory('SA0').runs['ca-run-1'].valueHigh, 1600);
    assert.equal(dataStore.costAnchorStats().symbols, 1);
    assert.equal(dataStore.verifyCostAnchors().ok, true);
    // unknown 记录允许空区间
    const tomb = { ...base, anchorType: 'unknown', confidence: 'unknown', valueLow: null, valueHigh: null };
    assert.equal(dataStore.ingestCostAnchor({ runId: 'ca-run-2', symbol: 'SA0', record: tomb }).written, true);
    assert.equal(dataStore.verifyCostAnchors().ok, true);
  });
});
