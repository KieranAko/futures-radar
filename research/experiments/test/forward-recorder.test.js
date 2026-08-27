/**
 * Test: Forward Recorder — 新日期登记 → H10 成熟结算 → 进度查询 最小闭环
 *
 * Spec (缅因猫 2026-08-13):
 * - 主配置固定 ER>=0.20+D0，对照 ER>=0.18+D0，均 topN=null/H10/slope=0.3
 * - 旧日期拒绝（freeze 之前）、重复/乱序拒绝
 * - 冻结配置不可漂移（manifest 与代码不一致 -> fail closed）
 * - pending 无收益；未来 bar 不足（无 T+11 close）不成熟
 * - 成熟后才写 outcomes/trades；main/control 原子配对
 * - 零候选/零信号日期保留
 * - settle 时 cohort/D0 漂移拒绝（fail closed）
 * - manifest 原子写入、损坏拒绝
 *
 * 2026-08-24 审计：manifest guard（内容哈希/version/记录状态/runId 溯源）测试
 * 见 forward-manifest.test.js；fixtures 共享于 helpers/forward-fixtures.js。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  registerForwardDate,
  settleForwardDate,
  getForwardStatus
} from '../lib/forward-recorder.js';
import {
  FORWARD_CONFIGS,
  FORWARD_FREEZE,
  loadManifest
} from '../lib/forward-manifest.js';
import {
  DATE_MAIN,
  DATE_ZERO,
  RAW_MAIN,
  TRUNC_MAIN,
  TRUNC_ZERO,
  createFreshManifest,
  truncateRaw
} from './helpers/forward-fixtures.js';

// ─── Manifest integrity ─────────────────────────────────────────────────

test('corrupted manifest -> load/register/settle/status all throw', () => {
  const p = createFreshManifest().manifestPath;
  fs.writeFileSync(p, '{not valid json', 'utf8');
  assert.throws(() => loadManifest(p), /manifest/i);
  assert.throws(() => registerForwardDate(p, TRUNC_MAIN, DATE_MAIN), /manifest/i);
  assert.throws(() => settleForwardDate(p, RAW_MAIN, DATE_MAIN), /manifest/i);
  assert.throws(() => getForwardStatus(p), /manifest/i);
});

test('frozen config drift in manifest -> register and settle rejected', () => {
  const p = createFreshManifest().manifestPath;
  const m = JSON.parse(fs.readFileSync(p, 'utf8'));
  m.frozenConfigs.main.erThreshold = 0.3;
  fs.writeFileSync(p, JSON.stringify(m, null, 2), 'utf8');
  assert.throws(() => registerForwardDate(p, TRUNC_MAIN, DATE_MAIN), /frozen/i);
  assert.throws(() => settleForwardDate(p, RAW_MAIN, DATE_MAIN), /frozen/i);
});

test('FORWARD_CONFIGS is deeply frozen (no drift in code)', () => {
  assert.ok(Object.isFrozen(FORWARD_CONFIGS));
  assert.ok(Object.isFrozen(FORWARD_CONFIGS.main));
  assert.ok(Object.isFrozen(FORWARD_CONFIGS.control));
});

test('FORWARD_FREEZE is deeply frozen (no drift in code)', () => {
  assert.ok(Object.isFrozen(FORWARD_FREEZE));
});

// ─── Registration gates ─────────────────────────────────────────────────

test('minimumSignalDate not set -> any registration rejected', () => {
  const p = createFreshManifest().manifestPath;
  const m = JSON.parse(fs.readFileSync(p, 'utf8'));
  m.minimumSignalDate = null;
  fs.writeFileSync(p, JSON.stringify(m, null, 2), 'utf8');
  assert.throws(() => registerForwardDate(p, TRUNC_MAIN, DATE_MAIN), /minimumSignalDate/i);
});

test('signalDate before minimumSignalDate -> rejected (old dates never replayed)', () => {
  const p = createFreshManifest().manifestPath;
  assert.throws(() => registerForwardDate(p, TRUNC_MAIN, '2026-08-05'), /before/i);
});

test('missing freezeCommit/frozenAt -> register and settle rejected (fail closed)', () => {
  for (const field of ['freezeCommit', 'frozenAt']) {
    const p = createFreshManifest().manifestPath;
    const m = JSON.parse(fs.readFileSync(p, 'utf8'));
    delete m[field];
    fs.writeFileSync(p, JSON.stringify(m, null, 2), 'utf8');
    assert.throws(() => registerForwardDate(p, TRUNC_MAIN, DATE_MAIN), new RegExp(field));
    assert.throws(() => settleForwardDate(p, RAW_MAIN, DATE_MAIN), new RegExp(field));
    assert.throws(() => getForwardStatus(p), new RegExp(field));
  }
});

test('tampered freeze metadata values -> register/settle/status rejected (fail closed)', () => {
  const cases = [
    ['minimumSignalDate', '2026-99-99'],
    ['minimumSignalDate', '2020-01-01'],
    ['freezeCommit', 'attacker-rewrite'],
    ['frozenAt', 'not-a-date']
  ];
  for (const [field, value] of cases) {
    const p = createFreshManifest().manifestPath;
    const m = JSON.parse(fs.readFileSync(p, 'utf8'));
    m[field] = value;
    fs.writeFileSync(p, JSON.stringify(m, null, 2), 'utf8');
    assert.throws(() => registerForwardDate(p, TRUNC_MAIN, DATE_MAIN), new RegExp(field));
    assert.throws(() => settleForwardDate(p, RAW_MAIN, DATE_MAIN), new RegExp(field));
    assert.throws(() => getForwardStatus(p), new RegExp(field));
  }
});

test('commit-date boundary: 2026-08-05/08-13 rejected, 08-14 registrable', () => {
  const p = createFreshManifest().manifestPath;
  assert.throws(() => registerForwardDate(p, TRUNC_MAIN, '2026-08-05'), /before/i);
  assert.throws(() => registerForwardDate(p, TRUNC_MAIN, '2026-08-13'), /before/i);
  const rec = registerForwardDate(p, TRUNC_MAIN, DATE_MAIN);
  assert.equal(rec.main.candidateCount, 4);
});

test('duplicate registration rejected', () => {
  const p = createFreshManifest().manifestPath;
  registerForwardDate(p, TRUNC_MAIN, DATE_MAIN);
  assert.throws(() => registerForwardDate(p, TRUNC_MAIN, DATE_MAIN), /duplicate|already/i);
});

test('out-of-order registration rejected', () => {
  const p = createFreshManifest().manifestPath;
  registerForwardDate(p, truncateRaw(RAW_MAIN, '2026-08-15'), '2026-08-15');  // later date first
  assert.throws(() => registerForwardDate(p, TRUNC_MAIN, DATE_MAIN), /order/i);
});

test('signalDate absent from raw -> rejected', () => {
  const p = createFreshManifest().manifestPath;
  assert.throws(() => registerForwardDate(p, TRUNC_MAIN, '2026-10-20'), /raw|signalDate/i);
});

// ─── Pending has no returns ─────────────────────────────────────────────

test('registered date is pending: no trades/outcomes until settled', () => {
  const p = createFreshManifest().manifestPath;
  const rec = registerForwardDate(p, TRUNC_MAIN, DATE_MAIN);
  assert.equal(rec.settled, undefined);
  assert.equal('trades' in rec.main, false);
  assert.equal('outcomes' in rec.main, false);
  const m = loadManifest(p);
  assert.equal(m.dates[DATE_MAIN].settled, undefined);
});

test('main/control recorded atomically in one entry', () => {
  const p = createFreshManifest().manifestPath;
  const rec = registerForwardDate(p, TRUNC_MAIN, DATE_MAIN);
  assert.ok(rec.main && rec.control, 'both cohorts in same entry');
  assert.equal(rec.main.candidateCount, 4);
  assert.ok(rec.control.candidateCount >= rec.main.candidateCount);
  for (const sym of rec.main.candidateSymbols) {
    assert.ok(rec.control.candidateSymbols.includes(sym), `main symbol ${sym} missing from control`);
  }
  assert.ok(rec.main.d0Signals.length >= 1);
});

test('zero-candidate date retained with empty cohorts', () => {
  const p = createFreshManifest().manifestPath;
  const rec = registerForwardDate(p, TRUNC_ZERO, DATE_ZERO);
  assert.equal(rec.main.candidateCount, 0);
  assert.equal(rec.control.candidateCount, 0);
  assert.deepEqual(rec.main.d0Signals, []);
  assert.deepEqual(rec.control.d0Signals, []);
  const status = getForwardStatus(p);
  assert.ok(status.zeroCandidateDates.includes(DATE_ZERO));
});

// ─── Settlement gates ───────────────────────────────────────────────────

test('settle unregistered date rejected', () => {
  const p = createFreshManifest().manifestPath;
  assert.throws(() => settleForwardDate(p, RAW_MAIN, DATE_MAIN), /registered/i);
});

test('settle with no future bars -> rejected (not mature)', () => {
  const p = createFreshManifest().manifestPath;
  registerForwardDate(p, TRUNC_MAIN, DATE_MAIN);
  assert.throws(() => settleForwardDate(p, TRUNC_MAIN, DATE_MAIN), /mature/i);
  const m = loadManifest(p);
  assert.equal(m.dates[DATE_MAIN].settled, undefined);
});

test('settle with full raw writes d0 trades and outcomes', () => {
  const p = createFreshManifest().manifestPath;
  registerForwardDate(p, TRUNC_MAIN, DATE_MAIN);
  const settled = settleForwardDate(p, RAW_MAIN, DATE_MAIN);
  assert.equal(settled.driftStatus, 'ok');
  assert.ok(settled.settledAt);
  assert.ok(Array.isArray(settled.main.trades));
  assert.ok(Array.isArray(settled.control.trades));
  assert.ok(settled.main.trades.length >= 1, 'expected at least one d0 trade for 2026-08-14');
  for (const t of [...settled.main.trades, ...settled.control.trades]) {
    assert.ok(Number.isFinite(t.netReturn), `trade ${t.symbol} netReturn not finite`);
  }
  const m = loadManifest(p);
  assert.ok(m.dates[DATE_MAIN].settled, 'settled persisted to manifest');
});

test('double settle rejected', () => {
  const p = createFreshManifest().manifestPath;
  registerForwardDate(p, TRUNC_MAIN, DATE_MAIN);
  settleForwardDate(p, RAW_MAIN, DATE_MAIN);
  assert.throws(() => settleForwardDate(p, RAW_MAIN, DATE_MAIN), /settled|already/i);
});

test('cohort/d0 drift at settle -> fail closed, nothing written', () => {
  const p = createFreshManifest().manifestPath;
  registerForwardDate(p, TRUNC_MAIN, DATE_MAIN);
  const tampered = structuredClone(RAW_MAIN);
  // EC0 is the d0 short candidate on 2026-08-14; force its pre-T closes upward -> D0 flips
  const ec = tampered.contracts.EC0.ohlcv;
  const T = ec.dates.indexOf(DATE_MAIN);
  for (let i = 0; i <= T; i++) ec.close[i] = 3000 + i;
  assert.throws(() => settleForwardDate(p, tampered, DATE_MAIN), /drift/i);
  const m = loadManifest(p);
  assert.equal(m.dates[DATE_MAIN].settled, undefined, 'fail closed: no settlement written');
});

test('non-finite T+11 close at settle -> rejected, nothing written', () => {
  const p = createFreshManifest().manifestPath;
  registerForwardDate(p, TRUNC_MAIN, DATE_MAIN);
  const tampered = structuredClone(RAW_MAIN);
  const T = tampered.contracts.EC0.ohlcv.dates.indexOf(DATE_MAIN);
  tampered.contracts.EC0.ohlcv.close[T + 11] = NaN;
  assert.throws(() => settleForwardDate(p, tampered, DATE_MAIN), /finite/i);
  const m = loadManifest(p);
  assert.equal(m.dates[DATE_MAIN].settled, undefined, 'fail closed: no settlement written');
});

test('non-finite T+1 open at settle -> rejected, nothing written', () => {
  const p = createFreshManifest().manifestPath;
  registerForwardDate(p, TRUNC_MAIN, DATE_MAIN);
  const tampered = structuredClone(RAW_MAIN);
  const T = tampered.contracts.EC0.ohlcv.dates.indexOf(DATE_MAIN);
  tampered.contracts.EC0.ohlcv.open[T + 1] = NaN;
  assert.throws(() => settleForwardDate(p, tampered, DATE_MAIN), /finite/i);
  const m = loadManifest(p);
  assert.equal(m.dates[DATE_MAIN].settled, undefined, 'fail closed: no settlement written');
});

test('status summary reflects register/settle progress', () => {
  const p = createFreshManifest().manifestPath;
  assert.equal(getForwardStatus(p).registered, 0);
  registerForwardDate(p, TRUNC_MAIN, DATE_MAIN);
  registerForwardDate(p, TRUNC_ZERO, DATE_ZERO);
  let status = getForwardStatus(p);
  assert.equal(status.registered, 2);
  assert.equal(status.pendingCount, 2);
  assert.equal(status.settledCount, 0);
  settleForwardDate(p, RAW_MAIN, DATE_MAIN);
  status = getForwardStatus(p);
  assert.equal(status.settledCount, 1);
  assert.equal(status.pendingCount, 1);
  assert.deepEqual(status.pendingDates, [DATE_ZERO]);
  assert.deepEqual(status.settledDates, [DATE_MAIN]);
});
