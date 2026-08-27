/**
 * Test: Forward Manifest Guard — 内容哈希 / schema / 状态校验 / runId 溯源
 *
 * Spec (缅因猫 2026-08-24 不变量审计):
 * - manifest 内容自哈希：封存于每次原子写入，读取时校验，篡改 fail closed
 * - version 必须为 1
 * - dates 记录结构校验：pending 无收益、settled 结构完整、数值 finite
 * - 正式样本必须有 runId 溯源（register 与 settle 均强制）
 * - settle 严格复用 T+1 open / T+11 close 索引语义（shared-backtest-lib）
 * - 成熟判定边界：T+11 close 恰好是最后一根 bar 时成熟，少一根即拒绝
 * - 原子写入不留 tmp 残留
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  registerForwardDate,
  settleForwardDate,
  getForwardStatus
} from '../lib/forward-recorder.js';
import {
  DATE_MAIN,
  RAW_MAIN,
  TRUNC_MAIN,
  createFreshManifest
} from './helpers/forward-fixtures.js';

function plainRewrite(manifestPath, mutate) {
  const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  mutate(m);
  fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2), 'utf8');
}

function stripRunId(raw) {
  const r = structuredClone(raw);
  delete r.meta.runId;
  return r;
}

// ─── Content hash ───────────────────────────────────────────────────────

test('saved manifest carries a 64-hex sha256 content hash', () => {
  const { manifestPath } = createFreshManifest();
  const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.match(m.hash, /^[0-9a-f]{64}$/);
  registerForwardDate(manifestPath, TRUNC_MAIN, DATE_MAIN);
  const after = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.match(after.hash, /^[0-9a-f]{64}$/);
  assert.notEqual(after.hash, m.hash, 'hash must change after registration');
});

test('tampered content with valid structure -> register/settle/status fail closed on hash', () => {
  const { manifestPath } = createFreshManifest();
  registerForwardDate(manifestPath, TRUNC_MAIN, DATE_MAIN);
  // 改写 registeredAt 为另一合法 ISO：结构校验通过，但内容哈希必然失配
  plainRewrite(manifestPath, (m) => {
    m.dates[DATE_MAIN].registeredAt = '2026-08-15T00:00:00.000Z';
  });
  assert.throws(() => registerForwardDate(manifestPath, TRUNC_MAIN, '2026-08-15'), /hash/i);
  assert.throws(() => settleForwardDate(manifestPath, RAW_MAIN, DATE_MAIN), /hash/i);
  assert.throws(() => getForwardStatus(manifestPath), /hash/i);
});

test('missing hash -> all entry points fail closed', () => {
  const { manifestPath } = createFreshManifest();
  plainRewrite(manifestPath, (m) => { delete m.hash; });
  assert.throws(() => registerForwardDate(manifestPath, TRUNC_MAIN, DATE_MAIN), /hash/i);
  assert.throws(() => getForwardStatus(manifestPath), /hash/i);
});

test('atomic save leaves no tmp files behind', () => {
  const { tmpDir, manifestPath } = createFreshManifest();
  registerForwardDate(manifestPath, TRUNC_MAIN, DATE_MAIN);
  const leftovers = fs.readdirSync(tmpDir).filter((f) => f.includes('.tmp-'));
  assert.deepEqual(leftovers, []);
});

// ─── Version & schema ───────────────────────────────────────────────────

test('version missing or != 1 -> fail closed', () => {
  for (const mutate of [(m) => { delete m.version; }, (m) => { m.version = 2; }]) {
    const { manifestPath } = createFreshManifest();
    plainRewrite(manifestPath, mutate);
    assert.throws(() => registerForwardDate(manifestPath, TRUNC_MAIN, DATE_MAIN), /version/i);
    assert.throws(() => getForwardStatus(manifestPath), /version/i);
  }
});

test('record structure tamper -> status fail closed', () => {
  const { manifestPath } = createFreshManifest();
  registerForwardDate(manifestPath, TRUNC_MAIN, DATE_MAIN);
  plainRewrite(manifestPath, (m) => {
    m.dates[DATE_MAIN].main.candidateCount = 999;  // 与 candidateSymbols.length 不一致
  });
  assert.throws(() => getForwardStatus(manifestPath), /candidateCount|fail closed/i);
  assert.throws(() => settleForwardDate(manifestPath, RAW_MAIN, DATE_MAIN), /candidateCount|fail closed/i);
});

test('record key/signalDate mismatch or invalid direction -> fail closed', () => {
  const { manifestPath } = createFreshManifest();
  registerForwardDate(manifestPath, TRUNC_MAIN, DATE_MAIN);
  plainRewrite(manifestPath, (m) => {
    m.dates[DATE_MAIN].signalDate = '2026-08-15';
  });
  assert.throws(() => getForwardStatus(manifestPath), /signalDate|fail closed/i);
  const p2 = createFreshManifest().manifestPath;
  registerForwardDate(p2, TRUNC_MAIN, DATE_MAIN);
  plainRewrite(p2, (m) => {
    m.dates[DATE_MAIN].main.d0Signals[0].direction = 'sideways';
  });
  assert.throws(() => getForwardStatus(p2), /d0Signals|fail closed/i);
});

test('settled state tamper (driftStatus != ok) -> fail closed', () => {
  const { manifestPath } = createFreshManifest();
  registerForwardDate(manifestPath, TRUNC_MAIN, DATE_MAIN);
  settleForwardDate(manifestPath, RAW_MAIN, DATE_MAIN);
  plainRewrite(manifestPath, (m) => {
    m.dates[DATE_MAIN].settled.driftStatus = 'tampered';
  });
  assert.throws(() => getForwardStatus(manifestPath), /driftStatus|fail closed/i);
});

// ─── runId provenance ───────────────────────────────────────────────────

test('register without meta.runId -> fail closed (forward samples need provenance)', () => {
  const { manifestPath } = createFreshManifest();
  assert.throws(() => registerForwardDate(manifestPath, stripRunId(TRUNC_MAIN), DATE_MAIN), /runId/i);
  const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(m.dates[DATE_MAIN], undefined, 'nothing written');
});

test('register with non-string runId -> fail closed', () => {
  const { manifestPath } = createFreshManifest();
  const r = structuredClone(TRUNC_MAIN);
  r.meta.runId = 42;
  assert.throws(() => registerForwardDate(manifestPath, r, DATE_MAIN), /runId/i);
});

test('settle raw without meta.runId -> fail closed, nothing written', () => {
  const { manifestPath } = createFreshManifest();
  registerForwardDate(manifestPath, TRUNC_MAIN, DATE_MAIN);
  assert.throws(() => settleForwardDate(manifestPath, stripRunId(RAW_MAIN), DATE_MAIN), /runId/i);
  const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(m.dates[DATE_MAIN].settled, undefined, 'nothing written');
});

// ─── T+1 / T+11 trading semantics ───────────────────────────────────────

test('settle strictly reuses T+1 open entry / T+11 close exit', () => {
  const { manifestPath } = createFreshManifest();
  registerForwardDate(manifestPath, TRUNC_MAIN, DATE_MAIN);
  const settled = settleForwardDate(manifestPath, RAW_MAIN, DATE_MAIN);
  assert.ok(settled.main.trades.length >= 1, 'fixture must have at least one d0 trade');
  for (const t of settled.main.trades) {
    const c = RAW_MAIN.contracts[t.symbol];
    const T = c.ohlcv.dates.indexOf(DATE_MAIN);
    assert.equal(t.entryDate, c.ohlcv.dates[T + 1], `${t.symbol} entry must be T+1`);
    assert.equal(t.entryPrice, c.ohlcv.open[T + 1], `${t.symbol} entry price must be T+1 open`);
    assert.equal(t.exitDate, c.ohlcv.dates[T + 11], `${t.symbol} exit must be T+11`);
    assert.equal(t.exitPrice, c.ohlcv.close[T + 11], `${t.symbol} exit price must be T+11 close`);
  }
});

test('maturity boundary: T+11 close as last bar settles, one bar less rejected', () => {
  const { manifestPath } = createFreshManifest();
  registerForwardDate(manifestPath, TRUNC_MAIN, DATE_MAIN);
  const settled = settleForwardDate(manifestPath, RAW_MAIN, DATE_MAIN);
  assert.equal(settled.driftStatus, 'ok');

  const p2 = createFreshManifest().manifestPath;
  registerForwardDate(p2, TRUNC_MAIN, DATE_MAIN);
  // 逐合约截断到长度 T+11（T+10 close 为最后一根）：T+11 close 缺失
  const t10 = structuredClone(RAW_MAIN);
  for (const c of Object.values(t10.contracts)) {
    const T = c.ohlcv.dates.indexOf(DATE_MAIN);
    for (const [k, v] of Object.entries(c.ohlcv)) {
      if (Array.isArray(v)) c.ohlcv[k] = v.slice(0, T + 11);
    }
  }
  assert.throws(() => settleForwardDate(p2, t10, DATE_MAIN), /mature/i);
});
