// test/incremental-cache.test.js — P1 增量缓存单元测试（纯逻辑 + 临时目录夹具，无网络）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ic from '../collector/incremental-cache.cjs';
const { findLatestCacheRaw, isCacheStale, planIncremental, cloneContractsForReuse, validateCachedSeries, planSnapshotFirst, probeLatestSinaBarDates } = ic;

// 隔离 data-store，避免测试读到本地已 seed 的真实文件库
let storeTmp;
before(() => {
  storeTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-store-isolate-'));
  process.env.FUTURES_DATA_ROOT = storeTmp;
});
after(() => {
  delete process.env.FUTURES_DATA_ROOT;
  if (storeTmp) fs.rmSync(storeTmp, { recursive: true, force: true });
});

function makeContract(dataEnd, dates) {
  return {
    dataEnd,
    usedBars: dates.length,
    ohlcv: {
      dates,
      open: dates.map(() => 1), high: dates.map(() => 2), low: dates.map(() => 0.5),
      close: dates.map(() => 1.5), volume: dates.map(() => 100), open_interest: dates.map(() => 50), settle: dates.map(() => 1.5)
    }
  };
}

function writeRun(runtimeRoot, runId, raw) {
  const dir = path.join(runtimeRoot, 'runs', runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'raw.json'), JSON.stringify(raw));
}

test('findLatestCacheRaw: 选 runId 最大且含 raw.json 的 run，排除当前 run', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-cache-'));
  try {
    writeRun(tmp, '20260826-1000-auto', { meta: { runId: '20260826-1000-auto' }, contracts: {} });
    writeRun(tmp, '20260827-1529-auto', { meta: { runId: '20260827-1529-auto' }, contracts: {} });
    const res = findLatestCacheRaw(tmp, '20260827-1800-auto');
    assert.equal(res.runId, '20260827-1529-auto');
    // 排除当前 run
    const res2 = findLatestCacheRaw(tmp, '20260827-1529-auto');
    assert.equal(res2.runId, '20260826-1000-auto');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('findLatestCacheRaw: 无有效缓存 → null', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-cache-'));
  try {
    fs.mkdirSync(path.join(tmp, 'runs', 'x'), { recursive: true });
    assert.equal(findLatestCacheRaw(tmp, '20260827-1800-auto'), null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('isCacheStale: 5 天内可复用，超过 → 全量校准', () => {
  const fresh = { meta: { collectedAt: new Date(Date.now() - 86400000).toISOString() } };
  const old = { meta: { collectedAt: new Date(Date.now() - 6 * 86400000).toISOString() } };
  const noMeta = { contracts: {} };
  assert.equal(isCacheStale(fresh, {}), false);
  assert.equal(isCacheStale(old, {}), true);
  assert.equal(isCacheStale(noMeta, {}), true);
});

test('planIncremental: 末 bar == 最新日期 → reuse；缺失/落后 → fetch', () => {
  const cache = {
    contracts: {
      RB0: makeContract('2026-08-27', ['2026-06-01', '2026-08-27']),
      CU0: makeContract('2026-08-26', ['2026-06-01', '2026-08-26']),
      M0: makeContract('2026-08-27', ['2026-06-01', '2026-08-27'])
    }
  };
  const plan = planIncremental(['RB0', 'CU0', 'M0', 'SA0'], cache, { latestBarDate: '2026-08-27', today: '2026-08-27' });
  assert.deepEqual(plan.reuse.map((x) => x.symbol).sort(), ['M0', 'RB0']);
  assert.deepEqual(plan.fetch.sort(), ['CU0', 'SA0']);
  assert.deepEqual(plan.validationFailures, []);
});

test('planIncremental: 非法序列（非单调/未来日期）→ fetch + 记录失败', () => {
  const cache = {
    contracts: {
      RB0: makeContract('2026-08-27', ['2026-08-27', '2026-08-26']), // 非单调
      CU0: makeContract('2026-08-28', ['2026-06-01', '2026-08-28'])  // 未来日期
    }
  };
  const plan = planIncremental(['RB0', 'CU0'], cache, { latestBarDate: '2026-08-27', today: '2026-08-27' });
  assert.deepEqual(plan.fetch.sort(), ['CU0', 'RB0']);
  assert.equal(plan.validationFailures.length, 2);
  assert.deepEqual(plan.validationFailures.map((v) => v.symbol).sort(), ['CU0', 'RB0']);
});

test('validateCachedSeries: 空序列/坏日期拒绝', () => {
  assert.equal(validateCachedSeries({ ohlcv: { dates: [] } }, '2026-08-27').ok, false);
  assert.equal(validateCachedSeries({ ohlcv: { dates: ['junk'] } }, '2026-08-27').ok, false);
  assert.equal(validateCachedSeries({ ohlcv: { dates: ['2026-08-27'] } }, '2026-08-27').ok, true);
});

test('cloneContractsForReuse: 深拷贝 + 盖章，不互相引用', () => {
  const cache = { meta: { runId: '20260827-1529-auto' }, contracts: { RB0: makeContract('2026-08-27', ['2026-08-27']) } };
  const clones = cloneContractsForReuse(cache, [{ symbol: 'RB0', dataEnd: '2026-08-27' }]);
  assert.equal(clones.RB0.cacheReused, true);
  assert.equal(clones.RB0.cacheOriginRunId, '20260827-1529-auto');
  clones.RB0.ohlcv.dates.push('2026-08-28');
  assert.equal(cache.contracts.RB0.ohlcv.dates.length, 1); // 源不被改动
});

test('cloneContractsForReuse: enrich 后缓存形状归一化（openInterest→open_interest）', () => {
  // 模拟 enrich 后的 raw.json 形状（驼峰 openInterest + turnover）
  const cache = {
    meta: { runId: '20260827-1529-auto' },
    contracts: {
      RB0: {
        dataEnd: '2026-08-27',
        ohlcv: {
          dates: ['2026-08-27'], open: [3120], high: [3129], low: [3116], close: [3127],
          volume: [342426], turnover: [1e9], openInterest: [1033500], settle: [3121]
        }
      }
    }
  };
  const clones = cloneContractsForReuse(cache, [{ symbol: 'RB0', dataEnd: '2026-08-27' }]);
  assert.deepEqual(clones.RB0.ohlcv.open_interest, [1033500]);
  assert.equal(clones.RB0.ohlcv.openInterest, undefined);
  assert.equal(clones.RB0.ohlcv.turnover, undefined);
  assert.deepEqual(clones.RB0.ohlcv.volume, [342426]);
});

// ── v0.1.3 快照优先增量（snapshot-first）────────────────────────

test('planSnapshotFirst: 全部品种恰好落后一根（last===prev）→ eligible', () => {
  const cache = {
    contracts: {
      RB0: makeContract('2026-08-26', ['2026-06-01', '2026-08-26']),
      CU0: makeContract('2026-08-26', ['2026-06-01', '2026-08-26'])
    }
  };
  const r = planSnapshotFirst(cache, ['RB0', 'CU0'], { latest: '2026-08-27', prev: '2026-08-26', today: '2026-08-27' });
  assert.equal(r.eligible, true);
});

test('planSnapshotFirst: 日线尚未发布今日（latest != today）→ 不启用（走 fast-close 兜底）', () => {
  const cache = {
    contracts: { RB0: makeContract('2026-08-26', ['2026-06-01', '2026-08-26']) }
  };
  const r = planSnapshotFirst(cache, ['RB0'], { latest: '2026-08-26', prev: '2026-08-25', today: '2026-08-27' });
  assert.equal(r.eligible, false);
  assert.match(r.reason, /fast-close/);
});

test('planSnapshotFirst: 任一品种落后超过一根 → 不启用', () => {
  const cache = {
    contracts: {
      RB0: makeContract('2026-08-26', ['2026-06-01', '2026-08-26']), // 恰好落后一根
      CU0: makeContract('2026-08-24', ['2026-06-01', '2026-08-24'])  // 落后多根
    }
  };
  const r = planSnapshotFirst(cache, ['RB0', 'CU0'], { latest: '2026-08-27', prev: '2026-08-26', today: '2026-08-27' });
  assert.equal(r.eligible, false);
  assert.match(r.reason, /CU0/);
});

test('planSnapshotFirst: 缺失合约 / 非法序列 → 不启用', () => {
  const cache = {
    contracts: {
      RB0: makeContract('2026-08-26', ['2026-06-01', '2026-08-26']),
      CU0: makeContract('2026-08-28', ['2026-06-01', '2026-08-28']) // 未来日期（非法）
    }
  };
  assert.equal(planSnapshotFirst(cache, ['RB0', 'CU0'], { latest: '2026-08-27', prev: '2026-08-26', today: '2026-08-27' }).eligible, false);
  assert.equal(planSnapshotFirst(cache, ['RB0', 'SA0'], { latest: '2026-08-27', prev: '2026-08-26', today: '2026-08-27' }).eligible, false); // SA0 缺失
  assert.equal(planSnapshotFirst(cache, [], { latest: '2026-08-27', prev: '2026-08-26', today: '2026-08-27' }).eligible, false);
});

test('planSnapshotFirst: 日期缺失 / prev 不早于 today → 不启用', () => {
  const cache = { contracts: {} };
  assert.equal(planSnapshotFirst(cache, ['RB0'], { latest: null, prev: '2026-08-26', today: '2026-08-27' }).eligible, false);
  assert.equal(planSnapshotFirst(cache, ['RB0'], { latest: '2026-08-27', prev: '2026-08-27', today: '2026-08-27' }).eligible, false);
});

test('probeLatestSinaBarDates: 解析 LAST+PREV（假 python 脚本，无网络）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-probe-'));
  try {
    const fake = path.join(tmp, 'fake_probe.py');
    fs.writeFileSync(fake, 'print("LAST=2026-08-27")\nprint("PREV=2026-08-26")\n');
    const r = await probeLatestSinaBarDates(fake, 'RB0');
    assert.deepEqual(r, { latest: '2026-08-27', prev: '2026-08-26' });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('probeLatestSinaBarDates: 旧脚本无 PREV 行 → prev 退化为 latest；失败 → null', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-probe-'));
  try {
    const fake = path.join(tmp, 'fake_probe.py');
    fs.writeFileSync(fake, 'print("LAST=2026-08-26")\n');
    const r = await probeLatestSinaBarDates(fake, 'RB0');
    assert.deepEqual(r, { latest: '2026-08-26', prev: '2026-08-26' });
    const bad = path.join(tmp, 'bad_probe.py');
    fs.writeFileSync(bad, 'print("boom")\nraise SystemExit(2)\n');
    assert.equal(await probeLatestSinaBarDates(bad, 'RB0'), null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
