// test/freshness.test.js — 数据时效说明卡（report/freshness.cjs）单元测试
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fres from '../report/freshness.cjs';
const { buildFreshness, renderFreshnessCard } = fres;

function makeRaw(overrides = {}) {
  return {
    meta: {
      collectedAt: '2026-08-27T07:57:11.339Z',
      sourceVersion: '1.18.81',
      fastClose: {
        used: true, source: 'sina_close_snapshot', fetchedAt: '2026-08-27T07:57:11.339Z',
        localToday: '2026-08-27', appended: 59, skipped: 0, failed: 0, errors: {}
      },
      ...(overrides.meta || {})
    },
    contracts: {
      EC0: { dataEnd: '2026-08-27', lastBarSource: 'sina_close_snapshot', lastBarAsOf: '2026-08-27 150000' },
      RB0: { dataEnd: '2026-08-27', lastBarSource: 'sina_close_snapshot' },
      M0: { dataEnd: '2026-08-26', lastBarSource: 'akshare_sina_daily' }
    },
    ...(overrides.contracts ? { contracts: overrides.contracts } : {})
  };
}

function makeMacro(overrides = {}) {
  return {
    meta: { signalDate: '2026-08-27', snapshotFrozenAt: '2026-08-27T07:57:16.342Z' },
    indicators: {
      DXY: { status: 'fresh', value: 99.1402, asOf: '2026-08-27' },
      USDCNH: { status: 'stale', value: 6.7216, asOf: '2026-08-26' },
      US10Y: { status: 'stale', value: 4.66, asOf: '2026-08-26' },
      DR007: { status: 'fresh', value: 1.39, asOf: '2026-08-27' },
      SC0: { status: 'fresh', value: 576.5, asOf: '2026-08-27' }
    },
    ...overrides
  };
}

test('buildFreshness: 统计末 bar 覆盖与来源分布', () => {
  const f = buildFreshness({ rawJson: makeRaw(), macroSnapshot: makeMacro() });
  assert.equal(f.totalSymbols, 3);
  assert.equal(f.latestBarDate, '2026-08-27');
  assert.equal(f.withLatestBar, 2);
  assert.deepEqual(f.barSources, { sina_close_snapshot: 2, akshare_sina_daily: 1 });
  assert.equal(f.fastClose.used, true);
  assert.equal(f.macro.available, true);
  assert.deepEqual(f.macro.fresh, ['DXY', 'DR007', 'SC0']);
  assert.equal(f.macro.stale.length, 2);
  assert.deepEqual(f.macro.missing, []);
});

test('buildFreshness: 旧 run 无 fastClose/宏观快照 → 优雅降级', () => {
  const raw = makeRaw({ meta: { collectedAt: '2026-08-26T10:00:00Z', sourceVersion: '1.18.81', fastClose: null } });
  const f = buildFreshness({ rawJson: raw, macroSnapshot: null });
  assert.equal(f.fastClose, null);
  assert.equal(f.macro.available, false);
  assert.equal(f.latestBarDate, '2026-08-27');
});

test('buildFreshness: 空合约 → 无末 bar 不崩溃', () => {
  const f = buildFreshness({ rawJson: { contracts: {} }, macroSnapshot: null });
  assert.equal(f.totalSymbols, 0);
  assert.equal(f.latestBarDate, null);
});

test('renderFreshnessCard: 快照通道使用时的卡片内容', () => {
  const f = buildFreshness({ rawJson: makeRaw(), macroSnapshot: makeMacro() });
  const lines = renderFreshnessCard(f);
  assert.ok(lines.length >= 6, JSON.stringify(lines));
  const text = lines.join('\n');
  assert.match(text, /数据时效说明/);
  assert.match(text, /2\/3 品种最后一根日线 = \*\*2026-08-27\*\*/);
  assert.match(text, /59 个由收盘快照通道补入/);
  assert.match(text, /sina_close_snapshot/);
  assert.match(text, /USDCNH\/US10Y asOf 2026-08-26/);
  assert.match(text, /append-only/);
});

test('renderFreshnessCard: 快照未启用 + 宏观缺失的降级文案', () => {
  const raw = makeRaw({ meta: { collectedAt: '2026-08-26T10:00:00Z', sourceVersion: '1.18.81', fastClose: null } });
  const f = buildFreshness({ rawJson: raw, macroSnapshot: null });
  const text = renderFreshnessCard(f).join('\n');
  assert.match(text, /全部来自 sina 日线接口/);
  assert.match(text, /本 run 未采集宏观快照/);
});

test('renderFreshnessCard: null → 空数组（5C 跳过卡片）', () => {
  assert.deepEqual(renderFreshnessCard(null), []);
});

test('buildFreshness: 透传 cfmmcVerify 摘要', () => {
  const raw = makeRaw({ meta: { cfmmcVerify: { checkedAt: '2026-08-27T08:10:00Z', date: '20260827', markets: { SHFE: { status: 'ok' }, DCE: { status: 'failed' } }, summary: { verified: 57, diverged: 1, unverified: 1, settleProvisionalCount: 1 } } } });
  const f = buildFreshness({ rawJson: raw, macroSnapshot: null });
  assert.equal(f.cfmmcVerify.summary.verified, 57);
});

test('renderFreshnessCard: CFMMC 验证行（全部一致）', () => {
  const raw = makeRaw({ meta: { cfmmcVerify: { date: '20260827', markets: { SHFE: { status: 'ok' } }, summary: { verified: 59, diverged: 0, unverified: 0, settleProvisionalCount: 0 } } } });
  const f = buildFreshness({ rawJson: raw, macroSnapshot: makeMacro() });
  const text = renderFreshnessCard(f).join('\n');
  assert.match(text, /当日 bar 验证/);
  assert.match(text, /59\/59 与 CFMMC 官方日线一致/);
});

test('renderFreshnessCard: CFMMC 验证行（有偏离/未验证/provisional）', () => {
  const raw = makeRaw({ meta: { cfmmcVerify: { date: '20260827', markets: { SHFE: { status: 'ok' }, CZCE: { status: 'pending' } }, summary: { verified: 56, diverged: 1, unverified: 2, settleProvisionalCount: 1 } } } });
  const f = buildFreshness({ rawJson: raw, macroSnapshot: makeMacro() });
  const text = renderFreshnessCard(f).join('\n');
  assert.match(text, /56\/59 与 CFMMC 官方日线一致/);
  assert.match(text, /1 个偏离/);
  assert.match(text, /2 个未验证/);
  assert.match(text, /1 个结算价为快照口径/);
});

test('renderFreshnessCard: CFMMC 验证失败 note → 降级文案', () => {
  const raw = makeRaw({ meta: { cfmmcVerify: { note: 'fetch_failed: boom' } } });
  const f = buildFreshness({ rawJson: raw, macroSnapshot: null });
  const text = renderFreshnessCard(f).join('\n');
  assert.match(text, /当日 bar 验证.*未执行/);
});

test('renderFreshnessCard: 无 cfmmcVerify → 无验证行', () => {
  const raw = makeRaw({ meta: { collectedAt: '2026-08-26T10:00:00Z', sourceVersion: '1.18.81', fastClose: null } });
  const f = buildFreshness({ rawJson: raw, macroSnapshot: null });
  const text = renderFreshnessCard(f).join('\n');
  assert.ok(!text.includes('当日 bar 验证'), text);
});
