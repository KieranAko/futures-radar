/**
 * Reasoning Runner Test
 * 验证 provider-neutral 的 runReasoningArm：门禁、臂映射、parser+grounding 串联
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runReasoningArm } from '../lib/reasoning-runner.js';
import { renderFourArmPrompts } from '../lib/prompt-renderer.js';
import { hashPacket } from '../lib/reasoning-artifact.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function makePacket(overrides = {}) {
  return {
    symbol: 'RB0',
    signalDate: '2026-08-24',
    marketCutoffAt: '2026-08-24T15:00:00+08:00',
    packetFrozenAt: '2026-08-24T16:30:00+08:00',
    generatedAt: '2026-08-24T16:20:00+08:00',
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
        fetchedAt: '2026-08-24T15:03:00+08:00',
        freshness: 'same_day',
        gap: null,
        close_60d: [3000, 3050, 3100],
        ma20: 3050,
        ma60: 2900
      },
      volume_oi: {
        source: 'akshare',
        asOf: '2026-08-21T15:00:00+08:00',
        fetchedAt: '2026-08-24T15:03:00+08:00',
        freshness: 'same_day',
        gap: null,
        volume_60d: [100, 200, 300],
        avgVolume5d: 150
      }
    },
    point_in_time: { eligible: true, reasons: [] },
    ...overrides
  };
}

function fixtureText(name) {
  return fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf-8');
}

function mockProvider(text, { capture } = {}) {
  return {
    calls: [],
    async complete({ prompt, model, metadata }) {
      this.calls.push({ prompt, model, metadata });
      if (capture) capture({ prompt, model, metadata });
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

const MODEL = { provider: 'mock', modelId: 'mock-model', temperature: 0, maxTokens: 1200 };

describe('runReasoningArm 门禁', () => {
  test('packet schema 无效时不调用 provider，status=packet_ineligible', async () => {
    const provider = mockProvider(fixtureText('fincot-long.json'));
    const packet = makePacket();
    delete packet.fields;
    const out = await runReasoningArm({
      packet,
      arm: 'fincot',
      provider,
      model: MODEL,
      promptVersion: 'fincot-prompt@sha256:test'
    });
    assert.strictEqual(provider.calls.length, 0);
    assert.strictEqual(out.status, 'packet_ineligible');
  });

  test('时间边界违规时不调用 provider，status=packet_ineligible', async () => {
    const provider = mockProvider(fixtureText('fincot-long.json'));
    const packet = makePacket();
    packet.fields.price_data.asOf = '2026-08-25T09:00:00+08:00'; // > marketCutoffAt
    const out = await runReasoningArm({
      packet,
      arm: 'fincot',
      provider,
      model: MODEL,
      promptVersion: 'fincot-prompt@sha256:test'
    });
    assert.strictEqual(provider.calls.length, 0);
    assert.strictEqual(out.status, 'packet_ineligible');
  });

  test('quality_check.executable=false 时不调用 provider', async () => {
    const provider = mockProvider(fixtureText('fincot-long.json'));
    const packet = makePacket({ quality_check: { executable: false, required_available: [], optional_available: [], missing: ['price_data', 'volume_oi'], max_staleness: '3d' } });
    const out = await runReasoningArm({
      packet,
      arm: 'fincot',
      provider,
      model: MODEL,
      promptVersion: 'fincot-prompt@sha256:test'
    });
    assert.strictEqual(provider.calls.length, 0);
    assert.strictEqual(out.status, 'packet_ineligible');
  });
});

describe('runReasoningArm 臂映射与解析', () => {
  test("arm='fincot' 只使用 renderFourArmPrompts(packet).finCot", async () => {
    const packet = makePacket();
    let captured = null;
    const provider = mockProvider(fixtureText('fincot-long.json'), { capture: (c) => { captured = c; } });
    await runReasoningArm({
      packet,
      arm: 'fincot',
      provider,
      model: MODEL,
      promptVersion: 'fincot-prompt@sha256:test'
    });
    assert.strictEqual(provider.calls.length, 1);
    assert.strictEqual(captured.prompt, renderFourArmPrompts(packet).finCot);
  });

  test('long fixture → accepted + grounded + 返回 promptHash', async () => {
    const packet = makePacket();
    const provider = mockProvider(fixtureText('fincot-long.json'));
    const out = await runReasoningArm({
      packet,
      arm: 'fincot',
      provider,
      model: MODEL,
      promptVersion: 'fincot-prompt@sha256:test'
    });
    assert.strictEqual(out.status, 'accepted');
    assert.strictEqual(out.grounding.grounded, true);
    assert.strictEqual(out.result.direction, 'long');
    assert.strictEqual(out.packetHash, hashPacket(packet));
    const expectedPromptHash = `sha256:${crypto.createHash('sha256').update(renderFourArmPrompts(packet).finCot).digest('hex')}`;
    assert.strictEqual(out.promptHash, expectedPromptHash);
  });

  test('pass fixture 保留 pass_reason=data_insufficient', async () => {
    const packet = makePacket();
    const provider = mockProvider(fixtureText('fincot-pass.json'));
    const out = await runReasoningArm({
      packet,
      arm: 'fincot',
      provider,
      model: MODEL,
      promptVersion: 'fincot-prompt@sha256:test'
    });
    assert.strictEqual(out.status, 'accepted');
    assert.strictEqual(out.result.direction, 'pass');
    assert.strictEqual(out.result.pass_reason, 'data_insufficient');
  });

  test('ungrounded evidence → grounding_degraded，降级为 pass/model_abstain', async () => {
    const packet = makePacket();
    const ungrounded = fixtureText('fincot-long.json').replace(
      '"evidence_ids": ["price_data.close_60d", "volume_oi.avgVolume5d"]',
      '"evidence_ids": ["price_data.close_60d", "ghost.path"]'
    );
    const provider = mockProvider(ungrounded);
    const out = await runReasoningArm({
      packet,
      arm: 'fincot',
      provider,
      model: MODEL,
      promptVersion: 'fincot-prompt@sha256:test'
    });
    assert.strictEqual(out.status, 'grounding_degraded');
    assert.strictEqual(out.result.direction, 'pass');
    assert.strictEqual(out.result.pass_reason, 'model_abstain');
    assert.deepStrictEqual(out.result.evidence_ids, []);
    assert.deepStrictEqual(out.result.opposing_ids, []);
    assert.strictEqual(out.grounding.grounded, true, '返回的 grounding 已清洗');
    assert.deepStrictEqual(out.originalGrounding.ungrounded_evidence, ['ghost.path'], '原始 grounding 信息保留在 originalGrounding');
    assert.ok(out.result.reasoning_summary.includes('ghost.path'), '降级摘要说明未接地路径');
  });

  test('返回对象不含完整 prompt 与 raw hidden reasoning', async () => {
    const packet = makePacket();
    const provider = mockProvider(fixtureText('fincot-long.json'));
    const out = await runReasoningArm({
      packet,
      arm: 'fincot',
      provider,
      model: MODEL,
      promptVersion: 'fincot-prompt@sha256:test'
    });
    const serialized = JSON.stringify(out);
    assert.ok(!('prompt' in out), '不返回完整 prompt');
    assert.ok(!serialized.includes('raw_thinking'));
    assert.ok(!serialized.includes('chain_of_thought'));
  });

  test('输出不符合 schema → parse_failed', async () => {
    const packet = makePacket();
    const provider = mockProvider('{"not": "the schema"}');
    const out = await runReasoningArm({
      packet,
      arm: 'fincot',
      provider,
      model: MODEL,
      promptVersion: 'fincot-prompt@sha256:test'
    });
    assert.strictEqual(out.status, 'parse_failed');
    assert.strictEqual(provider.calls.length, 3, '默认 parseRetries=2，共 3 次尝试');
    assert.strictEqual(out.parseError.length > 0, true);
  });

  test('parse 首次失败重试后成功 → accepted，metadata 带 attempt', async () => {
    const packet = makePacket();
    const bad = '{"not": "the schema"}';
    const texts = [bad, bad, fixtureText('fincot-long.json')];
    const provider = {
      calls: [],
      async complete({ prompt, model, metadata }) {
        this.calls.push({ prompt, model, metadata });
        return {
          text: texts[Math.min(this.calls.length - 1, texts.length - 1)],
          provider: 'mock',
          modelId: model?.modelId ?? 'mock-model',
          temperature: model?.temperature ?? 0,
          maxTokens: model?.maxTokens ?? 1200
        };
      }
    };
    const out = await runReasoningArm({
      packet,
      arm: 'fincot',
      provider,
      model: MODEL,
      promptVersion: 'fincot-prompt@sha256:test',
      parseRetries: 3
    });
    assert.strictEqual(out.status, 'accepted');
    assert.strictEqual(out.result.direction, 'long');
    assert.strictEqual(provider.calls.length, 3);
    assert.strictEqual(provider.calls[0].metadata.attempt, 0);
    assert.strictEqual(provider.calls[1].metadata.attempt, 1);
    assert.strictEqual(provider.calls[2].metadata.attempt, 2);
  });
});
