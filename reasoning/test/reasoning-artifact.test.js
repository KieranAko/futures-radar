/**
 * Reasoning Artifact Test
 * 验证 evidence-packet canonical hash 与 reasoning-results artifact 契约
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';
import {
  hashPacket,
  buildReasoningArtifact,
  validateReasoningArtifact
} from '../lib/reasoning-artifact.js';

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
      price_data: { close_60d: [3000, 3100], ma20: 3050, ma60: 2900 },
      volume_oi: { volume_60d: [100, 200], avgVolume5d: 150 }
    },
    point_in_time: { eligible: true, reasons: [] },
    ...overrides
  };
}

function makeAcceptedResult(overrides = {}) {
  return {
    symbol: 'RB0',
    signalDate: '2026-08-24',
    strategy: 'fincot',
    direction: 'long',
    confidence: 'medium',
    pass_reason: null,
    evidence_ids: ['price_data.close_60d'],
    opposing_ids: [],
    reasoning_summary: '价格上穿MA20。',
    invalidate_if: [],
    branch_status: {
      regime: 'available',
      macro_fundamental: 'abstain',
      position_flow: 'abstain'
    },
    ...overrides
  };
}

function makeMeta(overrides = {}) {
  return {
    runId: '20260824-1503-auto',
    createdAt: '2026-08-24T16:25:00+08:00',
    mode: 'daily',
    providerMode: 'recorded',
    model: {
      provider: 'anthropic',
      modelId: 'mock-model',
      temperature: 0,
      maxTokens: 1200
    },
    promptVersion: 'fincot-prompt@sha256:abc',
    resultSchemaVersion: '1.0.0',
    ...overrides
  };
}

describe('hashPacket', () => {
  test('canonical hash 不受对象键顺序影响', () => {
    const a = makePacket();
    const b = makePacket({
      fields: {
        volume_oi: { avgVolume5d: 150, volume_60d: [100, 200] },
        price_data: { ma20: 3050, close_60d: [3000, 3100], ma60: 2900 }
      }
    });
    assert.strictEqual(hashPacket(a), hashPacket(b));
  });

  test('canonical hash 不受 generatedAt 影响', () => {
    const a = makePacket();
    const b = makePacket({ generatedAt: '2026-08-24T18:00:00+08:00' });
    assert.strictEqual(hashPacket(a), hashPacket(b));
  });

  test('hash 随 evidence 数值变化', () => {
    const a = makePacket();
    const b = makePacket({
      fields: {
        price_data: { close_60d: [3000, 3200], ma20: 3050, ma60: 2900 },
        volume_oi: { volume_60d: [100, 200], avgVolume5d: 150 }
      }
    });
    assert.notStrictEqual(hashPacket(a), hashPacket(b));
  });

  test('hash 前缀为 sha256:', () => {
    assert.match(hashPacket(makePacket()), /^sha256:[0-9a-f]{64}$/);
  });
});

describe('buildReasoningArtifact', () => {
  test('构建完整 artifact 并含 packetHash', () => {
    const packet = makePacket();
    const packetHash = hashPacket(packet);
    const artifact = buildReasoningArtifact(makeMeta(), [
      {
        symbol: 'RB0',
        packetHash,
        arm: 'fincot',
        status: 'accepted',
        result: makeAcceptedResult(),
        grounding: { grounded: true, ungrounded_evidence: [], ungrounded_opposing: [] }
      }
    ]);
    assert.strictEqual(artifact.meta.resultSchemaVersion, '1.0.0');
    assert.strictEqual(artifact.results.length, 1);
    assert.strictEqual(artifact.results[0].packetHash, packetHash);
  });

  test('拒绝缺 model metadata 的结果', () => {
    const packet = makePacket();
    const meta = makeMeta({ model: { provider: 'anthropic' } });
    assert.throws(
      () =>
        buildReasoningArtifact(meta, [
          {
            symbol: 'RB0',
            packetHash: hashPacket(packet),
            arm: 'fincot',
            status: 'accepted',
            result: makeAcceptedResult(),
            grounding: { grounded: true, ungrounded_evidence: [], ungrounded_opposing: [] }
          }
        ]),
      /model/
    );
  });

  test('拒绝缺 packetHash 的结果', () => {
    assert.throws(
      () =>
        buildReasoningArtifact(makeMeta(), [
          {
            symbol: 'RB0',
            arm: 'fincot',
            status: 'accepted',
            result: makeAcceptedResult(),
            grounding: { grounded: true, ungrounded_evidence: [], ungrounded_opposing: [] }
          }
        ]),
      /packetHash/
    );
  });

  test('拒绝缺 grounding 的结果', () => {
    const packet = makePacket();
    assert.throws(
      () =>
        buildReasoningArtifact(makeMeta(), [
          {
            symbol: 'RB0',
            packetHash: hashPacket(packet),
            arm: 'fincot',
            status: 'accepted',
            result: makeAcceptedResult()
          }
        ]),
      /grounding/
    );
  });

  test('拒绝 raw_thinking / chain_of_thought 字段', () => {
    const packet = makePacket();
    for (const forbidden of ['raw_thinking', 'chain_of_thought']) {
      assert.throws(
        () =>
          buildReasoningArtifact(makeMeta(), [
            {
              symbol: 'RB0',
              packetHash: hashPacket(packet),
              arm: 'fincot',
              status: 'accepted',
              result: makeAcceptedResult({ [forbidden]: 'hidden reasoning' }),
              grounding: { grounded: true, ungrounded_evidence: [], ungrounded_opposing: [] }
            }
          ]),
        /forbidden/i,
        `should reject ${forbidden}`
      );
    }
  });

  test('accepted 必须 grounding.grounded=true', () => {
    const packet = makePacket();
    assert.throws(
      () =>
        buildReasoningArtifact(makeMeta(), [
          {
            symbol: 'RB0',
            packetHash: hashPacket(packet),
            arm: 'fincot',
            status: 'accepted',
            result: makeAcceptedResult(),
            grounding: { grounded: false, ungrounded_evidence: ['ghost.path'], ungrounded_opposing: [] }
          }
        ]),
      /grounded/
    );
  });
});

describe('validateReasoningArtifact', () => {
  test('合法 artifact 通过', () => {
    const packet = makePacket();
    const artifact = buildReasoningArtifact(makeMeta(), [
      {
        symbol: 'RB0',
        packetHash: hashPacket(packet),
        arm: 'fincot',
        status: 'accepted',
        result: makeAcceptedResult(),
        grounding: { grounded: true, ungrounded_evidence: [], ungrounded_opposing: [] }
      }
    ]);
    const { valid, errors } = validateReasoningArtifact(artifact);
    assert.strictEqual(valid, true, errors.join('; '));
  });

  test('grounding_failed 状态可携带 grounded=false', () => {
    const packet = makePacket();
    const artifact = buildReasoningArtifact(makeMeta(), [
      {
        symbol: 'RB0',
        packetHash: hashPacket(packet),
        arm: 'fincot',
        status: 'grounding_failed',
        result: makeAcceptedResult(),
        grounding: { grounded: false, ungrounded_evidence: ['ghost.path'], ungrounded_opposing: [] }
      }
    ]);
    assert.strictEqual(validateReasoningArtifact(artifact).valid, true);
  });

  test('grounding_degraded 状态合法（降级为 pass/model_abstain）', () => {
    const packet = makePacket();
    const artifact = buildReasoningArtifact(makeMeta(), [
      {
        symbol: 'RB0',
        packetHash: hashPacket(packet),
        arm: 'fincot',
        status: 'grounding_degraded',
        result: { ...makeAcceptedResult(), direction: 'pass', pass_reason: 'model_abstain' },
        grounding: { grounded: true, ungrounded_evidence: [], ungrounded_opposing: [] }
      }
    ]);
    assert.strictEqual(validateReasoningArtifact(artifact).valid, true);
  });
});
