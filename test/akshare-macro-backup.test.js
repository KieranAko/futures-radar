// test/akshare-macro-backup.test.js — P2 sina_fx 备用通道单元测试（无网络，mock）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import macro from '../collector/akshare-macro.cjs';
const { fetchSeriesWithBackup, fetchSinaFxSnapshot } = macro;

test('fetchSeriesWithBackup: 主通道成功 → 不触发备用', async () => {
  let snapCalls = 0;
  const r = await fetchSeriesWithBackup(
    { kind: 'sina_fx', symbol: 'DINIW' },
    { fetchSeriesFn: async () => ({ ok: true, kind: 'sina_fx', series: [['2026-08-27', 99.1]], fetchedAt: 'x' }), fetchSnapshotFn: async () => { snapCalls++; throw new Error('should not call'); } }
  );
  assert.equal(r.ok, true);
  assert.equal(snapCalls, 0);
});

test('fetchSeriesWithBackup: 主通道失败 + USDCNH → 实时快照兜底（今日日期校验）', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const r = await fetchSeriesWithBackup(
    { kind: 'sina_fx', symbol: 'USDCNH' },
    {
      attempts: 1,
      fetchSeriesFn: async () => ({ ok: false, error: '456 Client Error', fetchedAt: 'x' }),
      fetchSnapshotFn: async () => ({ ok: true, kind: 'sina_fx_snapshot', series: [[today, 6.7198]], fetchedAt: 'x', snapshotTime: '17:01:32' }),
      today
    }
  );
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'sina_fx_snapshot');
  assert.equal(r.series[0][1], 6.7198);
  assert.match(r.primaryError, /456/);
});

test('fetchSeriesWithBackup: 快照日期 != 今日 → 拒绝兜底，返回主通道错误', async () => {
  const r = await fetchSeriesWithBackup(
    { kind: 'sina_fx', symbol: 'USDCNH' },
    {
      attempts: 1,
      fetchSeriesFn: async () => ({ ok: false, error: '456', fetchedAt: 'x' }),
      fetchSnapshotFn: async () => ({ ok: true, kind: 'sina_fx_snapshot', series: [['2026-08-26', 6.7]], fetchedAt: 'x' }),
      today: '2026-08-27'
    }
  );
  assert.equal(r.ok, false);
  assert.equal(r.backupTried, 'sina_fx_snapshot');
});

test('fetchSeriesWithBackup: DXY 失败 → 无备用（保持 missing 语义）', async () => {
  const r = await fetchSeriesWithBackup(
    { kind: 'sina_fx', symbol: 'DINIW' },
    { attempts: 1, fetchSeriesFn: async () => ({ ok: false, error: '456', fetchedAt: 'x' }) }
  );
  assert.equal(r.ok, false);
  assert.equal(r.backupTried, undefined);
});

test('fetchSinaFxSnapshot: 解析 hq.sinajs.cn fx_susdcnh 行（真实字段序）', async () => {
  // 2026-08-27 实测行：0=时间, 3=昨收 6.7216（=日线昨收）, 8=现价, 17=日期
  const line = 'var hq_str_fx_susdcnh="17:01:32,6.719800,6.720000,6.721600,61,6.722600,6.722900,6.716800,6.719800,离岸人民币（香港）,-0.030000,-0.001800,0.0009074,,6.995700,6.715000,,2026-08-27";';
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => new TextEncoder().encode(line).buffer });
  try {
    const r = await fetchSinaFxSnapshot('USDCNH');
    assert.equal(r.ok, true);
    assert.equal(r.series[0][0], '2026-08-27');
    assert.equal(r.series[0][1], 6.7198);
    assert.equal(r.snapshotTime, '17:01:32');
  } finally {
    globalThis.fetch = origFetch;
  }
});
