/**
 * collector/macro-probe.test.js — Phase 3 阶段一宏观锚点采集单元测试
 *
 * 覆盖：change5d 计算、signalDate 判定、SC0 提取、asOf bar 选择、
 * 单指标失败降级（missing 不伪造）、快照组装与落盘、新鲜度门禁。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const macroProbe = require('../collector/macro-probe.cjs');
const {
  computeChange5d,
  determineSignalDate,
  selectAsOfBar,
  extractSc0FromRaw,
  buildIndicatorFromSeries,
  buildSnapshot,
  runMacroProbe,
  validateMacroSnapshot,
} = macroProbe;

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'macro-probe-test-'));
}

function makeRaw(runId, contracts) {
  return {
    meta: { runId, collectedAt: '2026-08-26T05:41:57Z', source: 'akshare' },
    contracts,
  };
}

function makeSc0(dates, close) {
  return { name: '原油', sector: 'energy_chemical', ohlcv: { dates, close } };
}

// ── computeChange5d ───────────────────────────────────────────
describe('computeChange5d', () => {
  it('计算相对百分比变化 (v_t/v_{t-5}-1)*100', () => {
    assert.strictEqual(computeChange5d([100, 101, 102, 103, 104, 105], 5), 5);
    assert.strictEqual(computeChange5d([105, 104, 103, 102, 101, 100], 5), Math.round((100 / 105 - 1) * 10000) / 100);
  });

  it('序列不足 6 根时返回 null', () => {
    assert.strictEqual(computeChange5d([100, 105], 1), null);
    assert.strictEqual(computeChange5d([], 0), null);
  });

  it('v5 为 0 或非有限值时返回 null', () => {
    assert.strictEqual(computeChange5d([0, 1, 2, 3, 4, 5], 5), null);
    assert.strictEqual(computeChange5d([NaN, 1, 2, 3, 4, 5], 5), null);
    assert.strictEqual(computeChange5d([100, 101, 102, 103, 104, NaN], 5), null);
  });
});

// ── determineSignalDate ───────────────────────────────────────
describe('determineSignalDate', () => {
  it('取全部合约最新日期的最大值', () => {
    const raw = makeRaw('R1', {
      AU0: { ohlcv: { dates: ['2026-08-20', '2026-08-21'] } },
      AG0: { ohlcv: { dates: ['2026-08-21', '2026-08-25'] } },
    });
    assert.strictEqual(determineSignalDate(raw), '2026-08-25');
  });

  it('无合约时返回 null', () => {
    assert.strictEqual(determineSignalDate(makeRaw('R2', {})), null);
    assert.strictEqual(determineSignalDate({ contracts: { X0: { ohlcv: { dates: [] } } } }), null);
  });
});

// ── selectAsOfBar ─────────────────────────────────────────────
describe('selectAsOfBar', () => {
  const series = [
    { date: '2026-08-21', value: 1 },
    { date: '2026-08-24', value: 2 },
    { date: '2026-08-25', value: 3 },
    { date: '2026-08-26', value: 4 },
  ];

  it('取 date <= signalDate 的最后一根（跳过盘中未完成 bar）', () => {
    const bar = selectAsOfBar(series, '2026-08-25');
    assert.strictEqual(bar.date, '2026-08-25');
    assert.strictEqual(bar.value, 3);
    assert.strictEqual(bar.index, 2);
  });

  it('signalDate 等于最新 bar 时取最新 bar', () => {
    const bar = selectAsOfBar(series, '2026-08-26');
    assert.strictEqual(bar.date, '2026-08-26');
  });

  it('全部 bar 晚于 signalDate 时返回 null', () => {
    assert.strictEqual(selectAsOfBar([{ date: '2026-08-26', value: 4 }], '2026-08-25'), null);
  });

  it('空序列返回 null', () => {
    assert.strictEqual(selectAsOfBar([], '2026-08-25'), null);
  });
});

// ── extractSc0FromRaw ─────────────────────────────────────────
describe('extractSc0FromRaw', () => {
  const dates = ['2026-08-18', '2026-08-19', '2026-08-20', '2026-08-21', '2026-08-24', '2026-08-25'];
  const close = [580, 581, 582, 583, 584.8, 584.1];

  it('SC0 末日 == signalDate → fresh，change5d 用自身 close 序列', () => {
    const raw = makeRaw('R1', { SC0: makeSc0(dates, close) });
    const r = extractSc0FromRaw(raw, '2026-08-25', '2026-08-26T06:00:00Z');
    assert.strictEqual(r.status, 'fresh');
    assert.strictEqual(r.value, 584.1);
    assert.strictEqual(r.asOf, '2026-08-25');
    assert.strictEqual(r.source, 'raw.json');
    assert.strictEqual(r.change5d, Math.round((584.1 / 580 - 1) * 10000) / 100);
    assert.strictEqual(r._timestamp_origin, 'observed');
  });

  it('SC0 末日 < signalDate → stale', () => {
    const raw = makeRaw('R1', { SC0: makeSc0(dates.slice(0, 5), close.slice(0, 5)) });
    const r = extractSc0FromRaw(raw, '2026-08-25', '2026-08-26T06:00:00Z');
    assert.strictEqual(r.status, 'stale');
    assert.strictEqual(r.asOf, '2026-08-24');
  });

  it('SC0 不在 raw.json → missing 带 reason', () => {
    const r = extractSc0FromRaw(makeRaw('R1', {}), '2026-08-25', '2026-08-26T06:00:00Z');
    assert.strictEqual(r.status, 'missing');
    assert.ok(typeof r.reason === 'string' && r.reason.length > 0);
  });

  it('SC0 末日 > signalDate（防御）→ missing', () => {
    const raw = makeRaw('R1', { SC0: makeSc0(dates, close) });
    const r = extractSc0FromRaw(raw, '2026-08-24', '2026-08-26T06:00:00Z');
    assert.strictEqual(r.status, 'missing');
  });

  it('不足 6 根时 change5d 为 null 但 value 保留', () => {
    const raw = makeRaw('R1', { SC0: makeSc0(['2026-08-21', '2026-08-24', '2026-08-25'], [581, 582, 583]) });
    const r = extractSc0FromRaw(raw, '2026-08-25', '2026-08-26T06:00:00Z');
    assert.strictEqual(r.value, 583);
    assert.strictEqual(r.change5d, null);
  });

  it('dates/close 长度不一致 → missing 带 reason', () => {
    const raw = makeRaw('R1', { SC0: makeSc0(dates, close.slice(0, 5)) });
    const r = extractSc0FromRaw(raw, '2026-08-25', '2026-08-26T06:00:00Z');
    assert.strictEqual(r.status, 'missing');
    assert.ok(r.reason.includes('length'), r.reason);
  });

  it('dates 非严格升序 → missing 带 reason', () => {
    const bad = ['2026-08-18', '2026-08-19', '2026-08-18', '2026-08-21', '2026-08-24', '2026-08-25'];
    const raw = makeRaw('R1', { SC0: makeSc0(bad, close) });
    const r = extractSc0FromRaw(raw, '2026-08-25', '2026-08-26T06:00:00Z');
    assert.strictEqual(r.status, 'missing');
    assert.ok(r.reason.includes('ascending'), r.reason);
  });

  it('末值非有限（NaN）→ missing 带 reason', () => {
    const raw = makeRaw('R1', { SC0: makeSc0(dates, [580, 581, 582, 583, 584.8, NaN]) });
    const r = extractSc0FromRaw(raw, '2026-08-25', '2026-08-26T06:00:00Z');
    assert.strictEqual(r.status, 'missing');
    assert.ok(r.reason.includes('finite'), r.reason);
  });
});

// ── buildIndicatorFromSeries ──────────────────────────────────
describe('buildIndicatorFromSeries', () => {
  const cfg = { source: 'sina', sourceNote: '测试源' };
  const now = '2026-08-26T06:00:00Z';

  it('fresh：取 <= signalDate 最后一根并计算 change5d', () => {
    const seriesResult = {
      ok: true,
      fetchedAt: '2026-08-26T05:59:00Z',
      series: [
        ['2026-08-18', 100], ['2026-08-19', 101], ['2026-08-20', 102],
        ['2026-08-21', 103], ['2026-08-24', 104], ['2026-08-25', 105],
        ['2026-08-26', 106],
      ],
    };
    const r = buildIndicatorFromSeries('DXY', cfg, seriesResult, '2026-08-25', now);
    assert.strictEqual(r.status, 'fresh');
    assert.strictEqual(r.value, 105);
    assert.strictEqual(r.asOf, '2026-08-25');
    assert.strictEqual(r.change5d, 5);
    assert.strictEqual(r.source, 'sina');
    assert.strictEqual(r.fetchedAt, '2026-08-26T05:59:00Z');
  });

  it('最新 bar < signalDate → stale', () => {
    const seriesResult = {
      ok: true,
      fetchedAt: '2026-08-26T05:59:00Z',
      series: [
        { date: '2026-08-21', value: 100 }, { date: '2026-08-22', value: 101 },
      ],
    };
    const r = buildIndicatorFromSeries('DXY', cfg, seriesResult, '2026-08-25', now);
    assert.strictEqual(r.status, 'stale');
    assert.strictEqual(r.asOf, '2026-08-22');
  });

  it('抓取失败 → missing 带 reason，不伪造', () => {
    const seriesResult = { ok: false, error: 'connection refused', fetchedAt: now };
    const r = buildIndicatorFromSeries('DXY', cfg, seriesResult, '2026-08-25', now);
    assert.strictEqual(r.status, 'missing');
    assert.ok(r.reason.includes('connection refused'));
    assert.strictEqual(r.value, undefined);
  });

  it('无 <= signalDate 的 bar → missing', () => {
    const seriesResult = {
      ok: true,
      fetchedAt: now,
      series: [{ date: '2026-08-26', value: 106 }],
    };
    const r = buildIndicatorFromSeries('DXY', cfg, seriesResult, '2026-08-25', now);
    assert.strictEqual(r.status, 'missing');
  });

  it('过滤非有限值行', () => {
    const seriesResult = {
      ok: true,
      fetchedAt: now,
      series: [
        ['2026-08-21', 'abc'], ['2026-08-22', null],
        ['2026-08-25', 105],
      ],
    };
    const r = buildIndicatorFromSeries('DXY', cfg, seriesResult, '2026-08-25', now);
    assert.strictEqual(r.value, 105);
    assert.strictEqual(r.change5d, null);
  });

  it('非严格升序 series → missing 带 reason（禁止乱序序列进入快照）', () => {
    const seriesResult = {
      ok: true,
      fetchedAt: now,
      series: [
        ['2026-08-21', 100], ['2026-08-24', 101], ['2026-08-22', 102],
        ['2026-08-25', 103],
      ],
    };
    const r = buildIndicatorFromSeries('DXY', cfg, seriesResult, '2026-08-25', now);
    assert.strictEqual(r.status, 'missing');
    assert.ok(r.reason.includes('ascending'), r.reason);
  });

  it('重复日期（非严格升序）→ missing 带 reason', () => {
    const seriesResult = {
      ok: true,
      fetchedAt: now,
      series: [
        ['2026-08-21', 100], ['2026-08-21', 101], ['2026-08-25', 105],
      ],
    };
    const r = buildIndicatorFromSeries('DXY', cfg, seriesResult, '2026-08-25', now);
    assert.strictEqual(r.status, 'missing');
    assert.ok(r.reason.includes('ascending'), r.reason);
  });
});

// ── buildSnapshot + validateMacroSnapshot ─────────────────────
describe('buildSnapshot / validateMacroSnapshot', () => {
  function mkInd(id, overrides = {}) {
    return {
      status: 'fresh', value: 100, change5d: 1.5, asOf: '2026-08-25',
      fetchedAt: '2026-08-26T05:59:00Z', source: 'sina', _timestamp_origin: 'observed',
      ...overrides,
    };
  }

  // 恰好 5 个冻结锚点（与 config/macro-indicators.json 声明一致）
  function allFive(overrides = {}) {
    return {
      DXY: mkInd('DXY'),
      USDCNH: mkInd('USDCNH'),
      US10Y: mkInd('US10Y', { source: 'akshare' }),
      DR007: { status: 'missing', reason: 'timeout', source: 'akshare', fetchedAt: '2026-08-26T05:59:00Z', _timestamp_origin: 'observed' },
      SC0: mkInd('SC0', { source: 'raw.json' }),
      ...overrides,
    };
  }

  it('quality 计数与 eligible 判定', () => {
    const snap = buildSnapshot({
      runId: 'R1', signalDate: '2026-08-25', nowIso: '2026-08-26T06:00:00Z',
      indicatorResults: {
        DXY: mkInd('DXY'),
        US10Y: mkInd('US10Y'),
        DR007: { status: 'missing', reason: 'timeout', source: 'akshare', fetchedAt: '2026-08-26T05:59:00Z', _timestamp_origin: 'observed' },
      },
    });
    assert.strictEqual(snap.quality.available, 2);
    assert.strictEqual(snap.quality.missing, 1);
    assert.strictEqual(snap.quality.eligible, true);
    assert.strictEqual(snap.meta.schemaVersion, '1.0.0');
    assert.strictEqual(snap.meta.marketCutoffAt, '2026-08-25');
  });

  it('全部 missing 时 eligible=false', () => {
    const snap = buildSnapshot({
      runId: 'R1', signalDate: '2026-08-25', nowIso: '2026-08-26T06:00:00Z',
      indicatorResults: {
        DXY: { status: 'missing', reason: 'x', source: 'sina', fetchedAt: '2026-08-26T05:59:00Z' },
      },
    });
    assert.strictEqual(snap.quality.eligible, false);
  });

  it('validator 接受合法快照', () => {
    const snap = buildSnapshot({
      runId: 'R1', signalDate: '2026-08-25', nowIso: '2026-08-26T06:00:00Z',
      indicatorResults: allFive(),
    });
    const v = validateMacroSnapshot(snap);
    assert.strictEqual(v.ok, true, JSON.stringify(v.errors));
  });

  it('validator 拒绝 asOf > marketCutoffAt', () => {
    const snap = buildSnapshot({
      runId: 'R1', signalDate: '2026-08-25', nowIso: '2026-08-26T06:00:00Z',
      indicatorResults: allFive({ DXY: mkInd('DXY', { asOf: '2026-08-26' }) }),
    });
    const v = validateMacroSnapshot(snap);
    assert.strictEqual(v.ok, false);
    assert.ok(v.errors.some((e) => e.includes('asOf')));
  });

  it('validator 拒绝 fetchedAt > snapshotFrozenAt', () => {
    const snap = buildSnapshot({
      runId: 'R1', signalDate: '2026-08-25', nowIso: '2026-08-26T06:00:00Z',
      indicatorResults: allFive({ DXY: mkInd('DXY', { fetchedAt: '2026-08-26T07:00:00Z' }) }),
    });
    const v = validateMacroSnapshot(snap);
    assert.strictEqual(v.ok, false);
    assert.ok(v.errors.some((e) => e.includes('fetchedAt')));
  });

  it('validator 拒绝无 reason 的 missing 指标', () => {
    const snap = buildSnapshot({
      runId: 'R1', signalDate: '2026-08-25', nowIso: '2026-08-26T06:00:00Z',
      indicatorResults: allFive({
        DXY: { status: 'missing', source: 'sina', fetchedAt: '2026-08-26T05:59:00Z', _timestamp_origin: 'observed' },
      }),
    });
    const v = validateMacroSnapshot(snap);
    assert.strictEqual(v.ok, false);
  });

  it('validator 拒绝 quality 计数与实际不符', () => {
    const snap = buildSnapshot({
      runId: 'R1', signalDate: '2026-08-25', nowIso: '2026-08-26T06:00:00Z',
      indicatorResults: allFive(),
    });
    snap.quality.available = 5;
    const v = validateMacroSnapshot(snap);
    assert.strictEqual(v.ok, false);
  });

  it('validator 拒绝非有限 value', () => {
    const snap = buildSnapshot({
      runId: 'R1', signalDate: '2026-08-25', nowIso: '2026-08-26T06:00:00Z',
      indicatorResults: allFive({ DXY: mkInd('DXY', { value: Infinity }) }),
    });
    const v = validateMacroSnapshot(snap);
    assert.strictEqual(v.ok, false);
  });
});

// ── runMacroProbe 集成（临时 runtime root + 假抓取器） ─────────
describe('runMacroProbe', () => {
  function makeProbeFixture(tmp) {
    const runId = 'PROBE-RUN';
    const runDir = path.join(tmp, 'runs', runId);
    fs.mkdirSync(runDir, { recursive: true });
    const dates = ['2026-08-18', '2026-08-19', '2026-08-20', '2026-08-21', '2026-08-24', '2026-08-25'];
    const close = [580, 581, 582, 583, 584.8, 584.1];
    const raw = makeRaw(runId, {
      SC0: makeSc0(dates, close),
      AU0: { name: '黄金', ohlcv: { dates, close: [1000, 1001, 1002, 1003, 1004, 1005] } },
    });
    fs.writeFileSync(path.join(runDir, 'raw.json'), JSON.stringify(raw, null, 2));
    return { runId, runDir };
  }

  const fakeFetch = (fetchSpec) => {
    const base = {
      DXY: { series: [['2026-08-18', 99], ['2026-08-19', 98], ['2026-08-20', 97], ['2026-08-21', 96], ['2026-08-24', 95], ['2026-08-25', 94], ['2026-08-26', 93]], fetchedAt: '2026-08-26T05:59:00Z' },
      USDCNH: { series: [['2026-08-18', 7.1], ['2026-08-19', 7.11], ['2026-08-20', 7.12], ['2026-08-21', 7.13], ['2026-08-24', 7.14], ['2026-08-25', 7.15]], fetchedAt: '2026-08-26T05:59:00Z' },
      US10Y: { series: [['2026-08-18', 4.2], ['2026-08-19', 4.21], ['2026-08-20', 4.22], ['2026-08-21', 4.23], ['2026-08-24', 4.24], ['2026-08-25', 4.25]], fetchedAt: '2026-08-26T05:59:00Z' },
      DR007: { error: 'chinamoney timeout' },
    };
    const key = fetchSpec.kind === 'sina_fx' ? (fetchSpec.symbol === 'DINIW' ? 'DXY' : fetchSpec.symbol)
      : fetchSpec.kind === 'akshare_bond_zh_us_rate' ? 'US10Y'
      : fetchSpec.kind === 'akshare_repo_rate' ? 'DR007'
      : 'UNKNOWN';
    if (!base[key] || base[key].error) return { ok: false, error: (base[key] && base[key].error) || 'no data', fetchedAt: '2026-08-26T05:59:00Z' };
    return { ok: true, ...base[key] };
  };

  it('写出 macro-snapshot.json：SC0 复用 raw.json，外部指标走抓取器，失败标 missing', async () => {
    const tmp = makeTempRoot();
    const { runId, runDir } = makeProbeFixture(tmp);
    const snap = await runMacroProbe({
      runId,
      runtimeRootOverride: tmp,
      fetchSeriesFn: fakeFetch,
      nowIso: '2026-08-26T06:00:00Z',
    });

    assert.strictEqual(snap.meta.signalDate, '2026-08-25');
    assert.strictEqual(snap.indicators.SC0.status, 'fresh');
    assert.strictEqual(snap.indicators.SC0.value, 584.1);
    assert.strictEqual(snap.indicators.SC0.source, 'raw.json');
    assert.strictEqual(snap.indicators.DXY.status, 'fresh');
    assert.strictEqual(snap.indicators.DXY.value, 94); // 跳过 08-26 盘中 bar
    assert.strictEqual(snap.indicators.DR007.status, 'missing');
    assert.ok(snap.indicators.DR007.reason.length > 0);
    assert.strictEqual(snap.quality.available, 4);
    assert.strictEqual(snap.quality.missing, 1);
    assert.strictEqual(snap.quality.eligible, true);

    const written = JSON.parse(fs.readFileSync(path.join(runDir, 'macro-snapshot.json'), 'utf8'));
    assert.strictEqual(written.meta.runId, runId);
    const v = validateMacroSnapshot(written);
    assert.strictEqual(v.ok, true, JSON.stringify(v.errors));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('全部外部指标失败也不抛出，快照仍写出（不阻断管道）', async () => {
    const tmp = makeTempRoot();
    const { runId, runDir } = makeProbeFixture(tmp);
    const snap = await runMacroProbe({
      runId,
      runtimeRootOverride: tmp,
      fetchSeriesFn: () => ({ ok: false, error: 'network down', fetchedAt: '2026-08-26T05:59:00Z' }),
      nowIso: '2026-08-26T06:00:00Z',
    });
    assert.strictEqual(snap.indicators.SC0.status, 'fresh');
    assert.strictEqual(snap.indicators.DXY.status, 'missing');
    assert.strictEqual(snap.quality.available, 1);
    assert.strictEqual(snap.quality.eligible, true);
    assert.ok(fs.existsSync(path.join(runDir, 'macro-snapshot.json')));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('raw.json 缺失时抛错（由管道 failurePolicy=warn 兜底）', async () => {
    const tmp = makeTempRoot();
    const runDir = path.join(tmp, 'runs', 'NO-RAW');
    fs.mkdirSync(runDir, { recursive: true });
    await assert.rejects(runMacroProbe({ runId: 'NO-RAW', runtimeRootOverride: tmp, fetchSeriesFn: fakeFetch }));
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
