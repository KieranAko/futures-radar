// test/cfmmc-verify.test.js — CFMMC 交叉验证层单元测试（纯逻辑，无网络）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import cv from '../collector/cfmmc-verify.cjs';
const { verifyBarAgainstCfmmc, applyVerificationResults, varietyPrefix } = cv;

function makeBar(overrides = {}) {
  return {
    open: 3120, high: 3129, low: 3116, close: 3127, settle: 3121,
    volume: 342426, open_interest: 1033500,
    ...overrides
  };
}

function makeRows(overrides = []) {
  return [
    { symbol: 'RB2609', variety: 'RB', volume: 4056, open: 3048, high: 3055, low: 3030, close: 3045, settle: 3042, open_interest: 7107 },
    { symbol: 'RB2701', variety: 'RB', volume: 342426, open: 3120, high: 3129, low: 3116, close: 3127, settle: 3121, open_interest: 1033500 },
    { symbol: 'RB2705', variety: 'RB', volume: 6052, open: 3145, high: 3155, low: 3141, close: 3153, settle: 3146, open_interest: 30832 },
    ...overrides
  ];
}

test('varietyPrefix: 主力连续符号去尾 0', () => {
  assert.equal(varietyPrefix('RB0'), 'RB');
  assert.equal(varietyPrefix('I0'), 'I');
  assert.equal(varietyPrefix('LH0'), 'LH');
  assert.equal(varietyPrefix('EC0'), 'EC');
});

test('verifyBarAgainstCfmmc: 完全一致 → verified', () => {
  const r = verifyBarAgainstCfmmc(makeBar(), makeRows(), 'RB0');
  assert.equal(r.status, 'verified');
  assert.equal(r.contract, 'RB2701'); // 成交量最大者
  assert.equal(r.settleProvisional, false);
});

test('verifyBarAgainstCfmmc: close 超 0.1% 阈值 → diverged + diffs', () => {
  const bar = makeBar({ close: 3130 }); // 与 3127 差 0.096%… 接近阈值；用更大幅度
  const bar2 = makeBar({ close: 3160 }); // +1.06%
  const r = verifyBarAgainstCfmmc(bar2, makeRows(), 'RB0');
  assert.equal(r.status, 'diverged');
  assert.ok(r.diffs.some((d) => d.field === 'close'));
  assert.equal(r.settleProvisional, false);
  const r2 = verifyBarAgainstCfmmc(bar, makeRows(), 'RB0');
  assert.equal(r2.status, 'verified', JSON.stringify(r2));
});

test('verifyBarAgainstCfmmc: settle 不一致 → diverged + settleProvisional', () => {
  const bar = makeBar({ settle: 3130 });
  const r = verifyBarAgainstCfmmc(bar, makeRows(), 'RB0');
  assert.equal(r.status, 'diverged');
  assert.equal(r.settleProvisional, true);
  assert.ok(r.diffs.some((d) => d.field === 'settle'));
});

test('verifyBarAgainstCfmmc: volume/OI 超 5% 阈值 → diverged', () => {
  const bar = makeBar({ volume: 400000 }); // +16.8%
  const r = verifyBarAgainstCfmmc(bar, makeRows(), 'RB0');
  assert.equal(r.status, 'diverged');
  assert.ok(r.diffs.some((d) => d.field === 'volume'));
});

test('verifyBarAgainstCfmmc: 品种无当日行 → unverified', () => {
  const r = verifyBarAgainstCfmmc(makeBar(), [], 'RB0');
  assert.equal(r.status, 'unverified');
  assert.equal(r.reason, 'no_cfmmc_rows_for_variety');
});

test('verifyBarAgainstCfmmc: 其他品种行不串扰', () => {
  const rows = [{ symbol: 'CU2610', variety: 'CU', volume: 83805, open: 108480, high: 108660, low: 108040, close: 108300, settle: 108390, open_interest: 213168 }];
  const r = verifyBarAgainstCfmmc(makeBar(), rows, 'RB0');
  assert.equal(r.status, 'unverified');
});

test('applyVerificationResults: 只验证快照 bar，汇总三态计数', () => {
  const raw = {
    meta: {},
    contracts: {
      RB0: {
        lastBarSource: 'sina_close_snapshot',
        ohlcv: { dates: ['2026-08-26', '2026-08-27'], open: [1, 3120], high: [1, 3129], low: [1, 3116], close: [1, 3127], volume: [1, 342426], open_interest: [1, 1033500], settle: [1, 3121] }
      },
      CU0: {
        lastBarSource: 'sina_close_snapshot',
        ohlcv: { dates: ['2026-08-26', '2026-08-27'], open: [1, 108480], high: [1, 108660], low: [1, 108040], close: [1, 108300], volume: [1, 83805], open_interest: [1, 213168], settle: [1, 108390] }
      },
      M0: {
        lastBarSource: 'akshare_sina_daily',
        ohlcv: { dates: ['2026-08-27'], open: [1], high: [1], low: [1], close: [1], volume: [1], open_interest: [1], settle: [1] }
      }
    }
  };
  const cfmmc = {
    date: '20260827',
    markets: { SHFE: { status: 'ok', rows: 2 }, DCE: { status: 'ok', rows: 0 } },
    rows: [
      { symbol: 'RB2701', variety: 'RB', volume: 342426, open: 3120, high: 3129, low: 3116, close: 3127, settle: 3121, open_interest: 1033500 },
      { symbol: 'CU2610', variety: 'CU', volume: 83805, open: 108480, high: 108660, low: 108040, close: 108300, settle: 108390, open_interest: 213168 }
    ]
  };
  const res = applyVerificationResults(raw, cfmmc, {});
  assert.equal(res.summary.verified, 2);
  assert.equal(res.summary.diverged, 0);
  assert.equal(res.summary.unverified, 0);
  assert.equal(raw.contracts.RB0.lastBarVerification.status, 'verified');
  assert.equal(raw.contracts.M0.lastBarVerification.status, 'not_applicable');
  assert.equal(raw.meta.cfmmcVerify, undefined); // meta 由调用方（collector）写入
});

test('applyVerificationResults: 全部无法比对 → unverified 计数', () => {
  const raw = {
    meta: {},
    contracts: {
      RB0: {
        lastBarSource: 'sina_close_snapshot',
        ohlcv: { dates: ['2026-08-27'], open: [3120], high: [3129], low: [3116], close: [3127], volume: [342426], open_interest: [1033500], settle: [3121] }
      }
    }
  };
  const cfmmc = { date: '20260827', markets: { DCE: { status: 'failed', error: 'JSONDecodeError' } }, rows: [] };
  const res = applyVerificationResults(raw, cfmmc, {});
  assert.equal(res.summary.unverified, 1);
  assert.equal(raw.contracts.RB0.lastBarVerification.reason, 'no_cfmmc_rows_for_variety');
});
