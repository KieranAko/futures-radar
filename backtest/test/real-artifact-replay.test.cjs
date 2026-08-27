/**
 * Real Artifact Replay Smoke Test
 * 管道契约 smoke：真实 run 的 raw.json（副本）→ raw-adapter → replayReasoning → scorecard
 * 诚实口径断言：
 * - 20260824-1503-auto（last bar 2026-08-21，fetchedAt 2026-08-24 晚于冻结点）→ non_point_in_time
 * - 20260805-1027-auto（fetchedAt 2026-08-05 晚于 2026-08-04 冻结点）→ 保持 non_point_in_time
 * - recorded source 为空：任何 provider 调用即抛错 → 证明资格评估先于 provider 调用
 * - 真实 runs/ 目录只读（1503 复制到 scratch，after 清理，不触碰 forward manifest）
 */

const { describe, test, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { replayReasoning } = require('../llm-replay.cjs');
const { buildLlmScorecard } = require('../llm-scorecard.cjs');
const { runtimeRoot } = require('../../lib/workspace.cjs');

const RUNS_ROOT = path.join(runtimeRoot, 'runs');
const SCRATCH_DIR = path.join(__dirname, '..', 'runs', 'bt-smoke-20260824');

const reasoningLib = (name) =>
  pathToFileURL(path.join(__dirname, '..', '..', 'reasoning', 'lib', name)).href;

async function loadEsm(name) {
  return import(reasoningLib(name));
}

beforeEach(() => {
  fs.rmSync(SCRATCH_DIR, { recursive: true, force: true });
  fs.mkdirSync(SCRATCH_DIR, { recursive: true });
});

after(() => {
  fs.rmSync(SCRATCH_DIR, { recursive: true, force: true });
});

async function replayPacket(packet, replayId) {
  const rows = await replayReasoning({
    replayId,
    packets: [packet],
    arms: ['fincot'],
    providerMode: 'recorded',
    recordedSource: [] // 空源：任何 provider 调用即抛错
  });
  return { rows, scorecard: buildLlmScorecard(rows) };
}

function assertAllNonPointInTime(rows, scorecard, expectedCount = 1) {
  assert.strictEqual(rows.length, expectedCount);
  for (const row of rows) {
    assert.strictEqual(row.scoringStatus, 'non_point_in_time');
    assert.strictEqual(row.pointInTimeEligible, false);
    assert.strictEqual(row.outcome, null);
    assert.strictEqual(row.packetHash, null);
    assert.strictEqual(row.result, null);
  }
  const s = scorecard.arms.fincot;
  assert.strictEqual(s.candidateCount, 0);
  assert.strictEqual(s.directional.n, 0);
  assert.strictEqual(s.excluded.non_point_in_time, expectedCount);
}

// 冒烟测试依赖本地真实 runs 数据（runtimeRoot/runs）；独立安装/CI 无此数据时自动跳过
const REQUIRED_RUNS = ['20260824-1503-auto', '20260805-1027-auto'];
const hasRealRuns = REQUIRED_RUNS.every((r) => fs.existsSync(path.join(RUNS_ROOT, r, 'raw.json')));

describe('真实 artifact 回放 smoke', { skip: hasRealRuns ? false : '真实 runs 目录缺失（本地运行时数据，见 README）' }, () => {
  test('20260824-1503-auto 副本：fetchedAt 晚于信号日冻结点 → non_point_in_time', async () => {
    const { buildPacketFromRawJson } = await loadEsm('raw-adapter.js');
    const { buildPacket } = await loadEsm('packet-builder.js');

    const src = path.join(RUNS_ROOT, '20260824-1503-auto', 'raw.json');
    assert.ok(fs.existsSync(src), '真实 run 20260824-1503-auto 存在');
    const copy = path.join(SCRATCH_DIR, 'raw.json');
    fs.copyFileSync(src, copy);

    const raw = buildPacketFromRawJson(copy, 'RB0', '2026-08-21');
    assert.strictEqual(raw.fields.price_data.fetchedAt, '2026-08-24T15:03:53.715041');
    const { packet } = buildPacket(raw);

    const { rows, scorecard } = await replayPacket(packet, 'smoke-20260824');
    assertAllNonPointInTime(rows, scorecard);
  });

  test('20260805-1027-auto：保持 non_point_in_time（fetchedAt 晚于 2026-08-04 冻结点）', async () => {
    const { buildPacketFromRawJson } = await loadEsm('raw-adapter.js');
    const { buildPacket } = await loadEsm('packet-builder.js');

    const src = path.join(RUNS_ROOT, '20260805-1027-auto', 'raw.json');
    assert.ok(fs.existsSync(src), '真实 run 20260805-1027-auto 存在');

    const raw = buildPacketFromRawJson(src, 'RB0', '2026-08-04');
    assert.strictEqual(raw.fields.price_data.fetchedAt, '2026-08-05T10:28:05.739623');
    const { packet } = buildPacket(raw);

    const { rows, scorecard } = await replayPacket(packet, 'smoke-20260805');
    assertAllNonPointInTime(rows, scorecard);
  });

  test('真实 runs/ 目录未被 smoke 写入', () => {
    const files = fs.readdirSync(path.join(RUNS_ROOT, '20260824-1503-auto')).sort();
    assert.deepStrictEqual(files, [
      'candidates.json',
      'filtered-hard.json',
      'provenance.json',
      'raw-snapshot.md',
      'raw.json',
      'source-probe.json'
    ]);
    assert.ok(!fs.existsSync(path.join(RUNS_ROOT, 'bt-smoke-20260824')));
  });
});
