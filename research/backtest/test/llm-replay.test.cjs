/**
 * LLM Replay Test
 * 验证离线 reasoning replay 编排：臂展开、point-in-time 排除、provider 模式、确定性
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { replayReasoning } = require('../llm-replay.cjs');

const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures');
const PACKET_FIXTURE = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'point-in-time-packet.json'), 'utf-8')
);
const RECORDED_RESULTS = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'recorded-results.json'), 'utf-8')
);

const FINCOT_LONG_TEXT = RECORDED_RESULTS.find((r) => r.arm === 'fincot').text;

function clonePacket() {
  return JSON.parse(JSON.stringify(PACKET_FIXTURE));
}

function mockProvider(text) {
  return {
    calls: [],
    async complete({ prompt, model, metadata }) {
      this.calls.push({ prompt, model, metadata });
      return {
        text,
        provider: 'mock',
        modelId: model?.modelId ?? 'mock-model',
        temperature: model?.temperature ?? 0,
        maxTokens: model?.maxTokens ?? 1200
      };
    }
  };
}

describe('replayReasoning 臂展开', () => {
  test('默认 arms 只有 fincot', async () => {
    const provider = mockProvider(FINCOT_LONG_TEXT);
    const rows = await replayReasoning({
      replayId: 'llm-bt-001',
      packets: [clonePacket()],
      providerMode: 'mock',
      provider
    });
    assert.deepStrictEqual(rows.map((r) => r.arm), ['fincot']);
    assert.strictEqual(provider.calls.length, 1);
  });

  test("arms='four' 展开为 sp/ust-cot/st-cot/fincot", async () => {
    const provider = mockProvider(FINCOT_LONG_TEXT);
    const rows = await replayReasoning({
      replayId: 'llm-bt-002',
      packets: [clonePacket()],
      arms: 'four',
      providerMode: 'mock',
      provider
    });
    assert.deepStrictEqual(rows.map((r) => r.arm), ['sp', 'ust-cot', 'st-cot', 'fincot']);
    assert.strictEqual(provider.calls.length, 4);
  });
});

describe('replayReasoning point-in-time 排除', () => {
  test('字段时间违约 → 不调用 provider，scoringStatus=non_point_in_time', async () => {
    const packet = clonePacket();
    packet.fields.price_data.fetchedAt = '2026-07-02T09:00:00+08:00';
    const provider = mockProvider(FINCOT_LONG_TEXT);
    const rows = await replayReasoning({
      replayId: 'llm-bt-003',
      packets: [packet],
      providerMode: 'mock',
      provider
    });
    assert.strictEqual(provider.calls.length, 0);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].scoringStatus, 'non_point_in_time');
    assert.strictEqual(rows[0].pointInTimeEligible, false);
    assert.strictEqual(rows[0].result, null);
  });

  test('缓存 point_in_time.eligible=true 被时间违约字段推翻：必须重算（不得信任缓存）', async () => {
    const packet = clonePacket();
    packet.point_in_time = { eligible: true, reasons: [] };
    packet.fields.volume_oi.fetchedAt = '2026-07-02T09:00:00+08:00';
    const provider = mockProvider(FINCOT_LONG_TEXT);
    const rows = await replayReasoning({
      replayId: 'llm-bt-003b',
      packets: [packet],
      providerMode: 'mock',
      provider
    });
    assert.strictEqual(provider.calls.length, 0, '缓存 eligible=true 不得绕过字段重算');
    assert.strictEqual(rows[0].scoringStatus, 'non_point_in_time');
    assert.strictEqual(rows[0].pointInTimeEligible, false);
  });

  test('缓存 eligible=true 但必填字段缺 _timestamp_origin → 重算拒绝', async () => {
    const packet = clonePacket();
    packet.point_in_time = { eligible: true, reasons: [] };
    delete packet.fields.price_data._timestamp_origin;
    delete packet.fields.volume_oi._timestamp_origin;
    const provider = mockProvider(FINCOT_LONG_TEXT);
    const rows = await replayReasoning({
      replayId: 'llm-bt-003c',
      packets: [packet],
      providerMode: 'mock',
      provider
    });
    assert.strictEqual(provider.calls.length, 0, '缺 origin 的 packet 不得进入 provider');
    assert.strictEqual(rows[0].scoringStatus, 'non_point_in_time');
    assert.strictEqual(rows[0].pointInTimeEligible, false);
  });

  test('packet 无 point_in_time 字段时按 assessPointInTime 判定', async () => {
    const packet = clonePacket();
    delete packet.point_in_time;
    const provider = mockProvider(FINCOT_LONG_TEXT);
    const rows = await replayReasoning({
      replayId: 'llm-bt-004',
      packets: [packet],
      providerMode: 'mock',
      provider
    });
    assert.strictEqual(rows[0].pointInTimeEligible, true);
    assert.strictEqual(rows[0].scoringStatus, null, 'accepted 行待 Task 7 outcome 评分');
  });
});

describe('replayReasoning provider 模式', () => {
  test('recorded 模式按 packetHash+arm 读取最终 JSON，确定性复现', async () => {
    const opts = {
      replayId: 'llm-bt-005',
      packets: [clonePacket()],
      providerMode: 'recorded',
      recordedSource: RECORDED_RESULTS
    };
    const rows1 = await replayReasoning(opts);
    const rows2 = await replayReasoning(opts);

    assert.strictEqual(rows1.length, 1);
    assert.strictEqual(rows1[0].scoringStatus, null);
    assert.ok(rows1[0].result, 'recorded 输出被解析');
    assert.strictEqual(rows1[0].result.direction, 'long');

    assert.deepStrictEqual(rows1, rows2, '相同输入必须完全确定性复现');
    assert.strictEqual(rows1[0].packetHash, rows2[0].packetHash);
    assert.strictEqual(rows1[0].promptHash, rows2[0].promptHash);
    assert.strictEqual(rows1[0].providerMode, 'recorded');
  });

  test('live-model 无显式注入 provider 时抛错', async () => {
    await assert.rejects(
      () =>
        replayReasoning({
          replayId: 'llm-bt-006',
          packets: [clonePacket()],
          providerMode: 'live-model',
          provider: null
        }),
      /provider/
    );
  });
});

describe('replayReasoning 失败保留', () => {
  test('parse 失败原样记录，不静默删除', async () => {
    const provider = mockProvider('{"not": "the schema"}');
    const rows = await replayReasoning({
      replayId: 'llm-bt-007',
      packets: [clonePacket()],
      providerMode: 'mock',
      provider
    });
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].scoringStatus, 'parse_failed');
  });

  test('grounding 失败降级记录：pass/model_abstain 不静默删除', async () => {
    const ungrounded = FINCOT_LONG_TEXT.replace(
      '"evidence_ids": ["price_data.close_60d", "volume_oi.avgVolume5d"]',
      '"evidence_ids": ["ghost.path"]'
    );
    const provider = mockProvider(ungrounded);
    const rows = await replayReasoning({
      replayId: 'llm-bt-008',
      packets: [clonePacket()],
      providerMode: 'mock',
      provider
    });
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].scoringStatus, 'grounding_degraded');
    assert.strictEqual(rows[0].result.direction, 'pass');
    assert.strictEqual(rows[0].result.pass_reason, 'model_abstain');
    assert.ok(rows[0].result.reasoning_summary.includes('ghost.path'), '降级摘要保留未接地路径');
    assert.deepStrictEqual(rows[0].grounding.ungrounded_evidence, []);
  });
});

describe('replayReasoning 无文件副作用', () => {
  test('不产 current.md / report.md / forward record', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-replay-'));
    const provider = mockProvider(FINCOT_LONG_TEXT);
    const rows = await replayReasoning({
      replayId: 'llm-bt-009',
      packets: [clonePacket()],
      providerMode: 'mock',
      provider
    });

    assert.ok(Array.isArray(rows));
    for (const row of rows) {
      const serialized = JSON.stringify(row);
      assert.ok(!serialized.includes('forward'), '不产 forward record');
    }
    assert.deepStrictEqual(fs.readdirSync(tmpDir), [], '核心函数不写任何文件');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
