/**
 * Packet Bundle Test
 * 验证 point-in-time 资格评估与 evidence-packets.json bundle 构建
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { buildPacketBundle, assessPointInTime } from '../lib/packet-bundle.js';
import { hashPacket } from '../lib/reasoning-artifact.js';
import { buildPacketFromRawJson } from '../lib/raw-adapter.js';
import { buildPacket } from '../lib/packet-builder.js';
import { RAW_JSON_PATH } from './helpers/fixtures.mjs';

const FIXTURE_PACKET = {
  fixtureOnly: true,
  symbol: 'RB0',
  signalDate: '2026-08-21',
  marketCutoffAt: '2026-08-21T15:00:00+08:00',
  packetFrozenAt: '2026-08-21T16:30:00+08:00',
  generatedAt: '2026-08-21T16:20:00+08:00',
  frozenCommit: 'run-20260824-1503-auto',
  quality_check: {
    executable: true,
    required_available: ['price_data', 'volume_oi'],
    optional_available: [],
    missing: ['inventory'],
    max_staleness: '3d'
  },
  fields: {
    price_data: {
      source: 'akshare',
      asOf: '2026-08-21T15:00:00+08:00',
      fetchedAt: '2026-08-21T15:03:00+08:00',
      _timestamp_origin: 'observed',
      freshness: 'same_day',
      gap: null,
      close_60d: [3000, 3050, 3100],
      ma20: 3050,
      ma60: 2900
    },
    volume_oi: {
      source: 'akshare',
      asOf: '2026-08-21T15:00:00+08:00',
      fetchedAt: '2026-08-21T15:03:00+08:00',
      _timestamp_origin: 'observed',
      freshness: 'same_day',
      gap: null,
      volume_60d: [100, 200, 300],
      avgVolume5d: 150
    }
  }
};

function cloneFixture() {
  return JSON.parse(JSON.stringify(FIXTURE_PACKET));
}

describe('assessPointInTime', () => {
  test('自洽 fixture → eligible=true', () => {
    const { eligible, reasons } = assessPointInTime(cloneFixture());
    assert.strictEqual(eligible, true, reasons.join('; '));
    assert.deepStrictEqual(reasons, []);
  });

  test('fetchedAt > packetFrozenAt → eligible=false', () => {
    const packet = cloneFixture();
    packet.fields.price_data.fetchedAt = '2026-08-22T09:00:00+08:00';
    const { eligible, reasons } = assessPointInTime(packet);
    assert.strictEqual(eligible, false);
    assert.ok(reasons.some((r) => r.includes('fetchedAt')));
  });

  test('_published_at > marketCutoffAt → eligible=false', () => {
    const packet = cloneFixture();
    packet.fields.volume_oi._published_at = '2026-08-21T18:00:00+08:00';
    const { eligible, reasons } = assessPointInTime(packet);
    assert.strictEqual(eligible, false);
    assert.ok(reasons.some((r) => r.includes('_published_at')));
  });

  test('必填 evidence 缺真实 fetchedAt → eligible=false', () => {
    const packet = cloneFixture();
    delete packet.fields.price_data.fetchedAt;
    const { eligible, reasons } = assessPointInTime(packet);
    assert.strictEqual(eligible, false);
    assert.ok(reasons.some((r) => r.includes('fetchedAt')));
  });

  test('fetchedAt 被标记 synthetic/derived/assumed/forged → eligible=false', () => {
    for (const origin of ['synthetic', 'derived', 'assumed', 'forged']) {
      const packet = cloneFixture();
      packet.fields.price_data._timestamp_origin = origin;
      const { eligible, reasons } = assessPointInTime(packet);
      assert.strictEqual(eligible, false, `origin=${origin} 应拒绝`);
      assert.ok(reasons.some((r) => r.includes('_timestamp_origin')));
    }
  });

  test('带资格时间戳的必填字段缺 _timestamp_origin → eligible=false（回归：不得默认放行）', () => {
    const packet = cloneFixture();
    delete packet.fields.price_data._timestamp_origin;
    const { eligible, reasons } = assessPointInTime(packet);
    assert.strictEqual(eligible, false, '缺失 origin 的必填字段不得默认 eligible');
    assert.ok(reasons.some((r) => r.includes('_timestamp_origin')));
    assert.ok(reasons.some((r) => r.includes('price_data')));
  });

  test('volume_oi 缺 _timestamp_origin 同样拒绝', () => {
    const packet = cloneFixture();
    delete packet.fields.volume_oi._timestamp_origin;
    const { eligible, reasons } = assessPointInTime(packet);
    assert.strictEqual(eligible, false);
    assert.ok(reasons.some((r) => r.includes('volume_oi')));
  });

  test('仅 _published_at 的可选字段缺 origin 同样拒绝', () => {
    const packet = cloneFixture();
    packet.fields.member_position = { source: 'akshare', _published_at: '2026-08-20T18:00:00+08:00' };
    const { eligible, reasons } = assessPointInTime(packet);
    assert.strictEqual(eligible, false);
    assert.ok(reasons.some((r) => r.includes('member_position')));
  });

  test('无资格时间戳的字段缺 origin 不影响资格', () => {
    const packet = cloneFixture();
    packet.fields.basis = { source: 'akshare', spread: 12.5 };
    const { eligible, reasons } = assessPointInTime(packet);
    assert.strictEqual(eligible, true, reasons.join('; '));
  });

  test('历史 artifact（20260805-1027-auto）继续 eligible=false', () => {
    const rawJsonPath = RAW_JSON_PATH;
    const raw = buildPacketFromRawJson(rawJsonPath, 'RB0', '2026-08-04');
    const { packet } = buildPacket(raw);
    const { eligible } = assessPointInTime(packet);
    assert.strictEqual(eligible, false, '事后抓取的历史 artifact 不得具 point-in-time 资格');
  });
});

describe('buildPacketBundle', () => {
  test('构建 bundle 并写入 packetHash 与 point_in_time', () => {
    const packet = cloneFixture();
    const bundle = buildPacketBundle({
      runId: '20260824-1503-auto',
      signalDate: '2026-08-21',
      packets: [packet]
    });
    assert.strictEqual(bundle.meta.runId, '20260824-1503-auto');
    assert.strictEqual(bundle.meta.signalDate, '2026-08-21');
    assert.strictEqual(bundle.meta.packetSchemaVersion, '1.0.0');
    assert.strictEqual(bundle.meta.candidateCount, 1);
    assert.strictEqual(bundle.packets[0].packetHash, hashPacket(packet));
    assert.strictEqual(bundle.packets[0].point_in_time.eligible, true);
  });

  test('symbol 重复拒绝', () => {
    assert.throws(
      () =>
        buildPacketBundle({
          runId: 'r1',
          signalDate: '2026-08-21',
          packets: [cloneFixture(), cloneFixture()]
        }),
      /symbol/i
    );
  });

  test('signalDate 不一致拒绝', () => {
    const packet = cloneFixture();
    packet.signalDate = '2026-08-20';
    assert.throws(
      () =>
        buildPacketBundle({
          runId: 'r1',
          signalDate: '2026-08-21',
          packets: [packet]
        }),
      /signalDate/i
    );
  });
});
