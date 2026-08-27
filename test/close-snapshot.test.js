// test/close-snapshot.test.js — 收盘快照快速通道单元测试（无网络，夹具驱动）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import snap from '../collector/close-snapshot.cjs';
const { parseSnapshotLine, mergeSnapshotBars, todayStr, SNAPSHOT_SOURCE } = snap;

// 2026-08-27 实测 RB2701 收盘快照行（与 CFMMC 官方日线逐字段一致）
const RB2701_LINE =
  'var hq_str_nf_RB2701="螺纹钢2701,150000,3120.000,3129.000,3116.000,3127.000,3126.000,3127.000,3127.000,3121.000,3116.000,89,29,1033500.000,342426,沪,螺纹钢,2026-08-27,1,,,,,,,,";';

function makeContract(lastDate, overrides = {}) {
  return {
    symbol: 'RB0',
    dataStart: '2026-06-03',
    dataEnd: lastDate,
    usedBars: 2,
    ohlcv: {
      dates: [lastDate],
      open: [3071], high: [3080], low: [3057], close: [3076],
      volume: [725416], open_interest: [1386273], settle: [3070]
    },
    ...overrides
  };
}

function makeRawData(lastDate) {
  return { meta: { totalSymbols: 1, succeeded: 1, failed: 0 }, contracts: { RB0: makeContract(lastDate) }, gaps: {} };
}

test('parseSnapshotLine: 有效收盘快照行解析出完整 bar', () => {
  const r = parseSnapshotLine(RB2701_LINE, { localToday: '2026-08-27' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.symbol, 'RB2701');
  assert.deepEqual(r.bar, {
    open: 3120, high: 3129, low: 3116, close: 3127,
    settle: 3121, preSettle: 3116, volume: 342426, hold: 1033500
  });
  assert.equal(r.asOf, '2026-08-27 150000');
});

test('parseSnapshotLine: time < 15:00:00（盘中/午休）拒绝', () => {
  const line = RB2701_LINE.replace('150000,', '145959,');
  const r = parseSnapshotLine(line, { localToday: '2026-08-27' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'before_day_close');
});

test('parseSnapshotLine: date != 本地今日 拒绝', () => {
  const line = RB2701_LINE.replace('2026-08-27', '2026-08-26');
  const r = parseSnapshotLine(line, { localToday: '2026-08-27' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'date_not_today');
});

test('parseSnapshotLine: 非法日期拒绝', () => {
  const line = RB2701_LINE.replace('2026-08-27', '2026-02-30');
  const r = parseSnapshotLine(line, { localToday: '2026-02-30' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'date_invalid');
});

test('parseSnapshotLine: 价格为 0 拒绝', () => {
  // close 字段（f[8]）置 0：'...,3127.000(卖),3127.000(close),3121.000(结算),...' → close=0
  const line = RB2701_LINE.replace('3127.000,3127.000,3121.000', '3127.000,0.000,3121.000');
  const r = parseSnapshotLine(line, { localToday: '2026-08-27' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'price_invalid');
});

test('parseSnapshotLine: OHLC 结构不自洽拒绝', () => {
  // high 改为低于 low
  const line = RB2701_LINE.replace('3129.000,3116.000', '3100.000,3116.000');
  const r = parseSnapshotLine(line, { localToday: '2026-08-27' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'ohlc_inconsistent');
});

test('parseSnapshotLine: 成交量为负拒绝', () => {
  const line = RB2701_LINE.replace(',342426,', ',-5,');
  const r = parseSnapshotLine(line, { localToday: '2026-08-27' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'volume_oi_invalid');
});

test('parseSnapshotLine: 行格式非法拒绝', () => {
  const r = parseSnapshotLine('garbage', { localToday: '2026-08-27' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'line_format');
});

test('mergeSnapshotBars: 日线缺当日 bar → 追加 1 根并盖章', () => {
  const raw = makeRawData('2026-08-26');
  const snapshot = {
    localToday: '2026-08-27',
    bars: { RB0: { open: 3071, high: 3090, low: 3071, close: 3088, settle: 3080, preSettle: 3070, volume: 650663, hold: 1254003 } },
    asOf: { RB0: '2026-08-27 150000' }
  };
  const r = mergeSnapshotBars(raw, snapshot, { localToday: '2026-08-27' });
  assert.deepEqual(r.appended, ['RB0']);
  assert.deepEqual(r.skipped, []);
  assert.deepEqual(r.failed, []);
  const c = raw.contracts.RB0;
  assert.equal(c.ohlcv.dates.length, 2);
  assert.equal(c.ohlcv.dates[1], '2026-08-27');
  assert.equal(c.ohlcv.close[1], 3088);
  assert.equal(c.ohlcv.open_interest[1], 1254003);
  assert.equal(c.ohlcv.settle[1], 3080);
  assert.equal(c.dataEnd, '2026-08-27');
  assert.equal(c.usedBars, 2);
  assert.equal(c.lastBarSource, SNAPSHOT_SOURCE);
  assert.equal(c.lastBarAsOf, '2026-08-27 150000');
});

test('mergeSnapshotBars: 日线已含当日 → skip，不覆盖', () => {
  const raw = makeRawData('2026-08-27');
  const snapshot = { localToday: '2026-08-27', bars: { RB0: { open: 1, high: 2, low: 0.5, close: 1.5, settle: 1.5, preSettle: 1, volume: 1, hold: 1 } }, asOf: { RB0: '2026-08-27 150000' } };
  const r = mergeSnapshotBars(raw, snapshot, { localToday: '2026-08-27' });
  assert.deepEqual(r.appended, []);
  assert.deepEqual(r.skipped, ['RB0']);
  assert.equal(raw.contracts.RB0.ohlcv.close[0], 3076); // 原值未被覆盖
});

test('mergeSnapshotBars: 快照缺失该品种 → failed，序列不变', () => {
  const raw = makeRawData('2026-08-26');
  const snapshot = { localToday: '2026-08-27', bars: {}, asOf: {} };
  const r = mergeSnapshotBars(raw, snapshot, { localToday: '2026-08-27' });
  assert.deepEqual(r.failed, ['RB0']);
  assert.equal(raw.contracts.RB0.ohlcv.dates.length, 1);
});

test('mergeSnapshotBars: 幂等 — 再次合并不会重复追加', () => {
  const raw = makeRawData('2026-08-26');
  const snapshot = {
    localToday: '2026-08-27',
    bars: { RB0: { open: 3071, high: 3090, low: 3071, close: 3088, settle: 3080, preSettle: 3070, volume: 650663, hold: 1254003 } },
    asOf: { RB0: '2026-08-27 150000' }
  };
  mergeSnapshotBars(raw, snapshot, { localToday: '2026-08-27' });
  const r2 = mergeSnapshotBars(raw, snapshot, { localToday: '2026-08-27' });
  assert.deepEqual(r2.appended, []);
  assert.deepEqual(r2.skipped, ['RB0']);
  assert.equal(raw.contracts.RB0.ohlcv.dates.length, 2);
});

test('todayStr: 输出本地日期 YYYY-MM-DD', () => {
  assert.match(todayStr(new Date('2026-08-27T07:30:00Z')), /^\d{4}-\d{2}-\d{2}$/);
});
