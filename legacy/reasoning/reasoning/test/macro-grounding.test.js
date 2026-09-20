/**
 * Macro Grounding Test（Phase 3 阶段二）
 * 验证 validateGrounding 的 macro_evidence_ids 独立域 fail-closed、
 * extractResult 对新 packet 三字段的条件式强制（旧归档不强制）、
 * runReasoningArm 的降级路径保留三字段 null/null/[]。
 * 冻结口径：缅因猫阶段二实施规格（thread 0001787736242943）。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { validateGrounding } from '../lib/grounding-validator.js';
import { extractResult } from '../lib/post-processor.js';
import { runReasoningArm } from '../lib/reasoning-runner.js';
import { buildPacket } from '../lib/packet-builder.js';

const MODEL = { provider: 'test', modelId: 'test-model', temperature: 0, maxTokens: 1024 };

function makeMacroPacket() {
  return {
    symbol: 'AU0',
    signalDate: '2026-08-26',
    marketCutoffAt: '2026-08-26T15:00:00+08:00',
    packetFrozenAt: '2026-08-26T16:30:00+08:00',
    generatedAt: '2026-08-26T16:20:00+08:00',
    frozenCommit: 'test-commit',
    quality_check: {
      executable: true,
      required_available: ['price_data', 'volume_oi'],
      optional_available: [],
      missing: [],
      max_staleness: '3d'
    },
    fields: {
      price_data: {
        source: 'akshare',
        asOf: '2026-08-26T15:00:00+08:00',
        fetchedAt: '2026-08-26T15:05:00+08:00',
        _timestamp_origin: 'observed',
        freshness: 'same_day',
        gap: null,
        close_60d: [500, 510],
        ma20: 505,
        ma60: 490
      },
      volume_oi: {
        source: 'akshare',
        asOf: '2026-08-26T15:00:00+08:00',
        fetchedAt: '2026-08-26T15:06:00+08:00',
        _timestamp_origin: 'observed',
        freshness: 'same_day',
        gap: null,
        volume_60d: [1000, 1100],
        avgVolume5d: 1050
      }
    },
    macro_context: {
      status: 'available',
      relevant_anchor_ids: ['DXY'],
      evidence: [
        {
          id: 'macro.DXY',
          anchor: 'DXY',
          value: 98.9774,
          change5d: 0.19,
          status: 'fresh',
          asOf: '2026-08-26',
          fetchedAt: '2026-08-26T08:23:23Z',
          source: 'sina',
          _timestamp_origin: 'observed'
        }
      ],
      gaps: [],
      reason: null,
      snapshot: {
        signalDate: '2026-08-26',
        marketCutoffAt: '2026-08-26',
        snapshotFrozenAt: '2026-08-26T08:23:27.596Z',
        schemaVersion: '1.0.0'
      }
    }
  };
}

describe('validateGrounding macro 域', () => {
  test('macro_evidence_ids 全部存在于 macro_context.evidence → grounded', () => {
    const result = {
      direction: 'long',
      evidence_ids: ['price_data.close_60d'],
      opposing_ids: [],
      macro_evidence_ids: ['macro.DXY']
    };
    const validation = validateGrounding(result, makeMacroPacket());
    assert.strictEqual(validation.grounded, true);
    assert.deepStrictEqual(validation.ungrounded_macro, []);
  });

  test('引用不存在的宏观 ID → grounded=false 且列出', () => {
    const result = {
      direction: 'long',
      evidence_ids: ['price_data.close_60d'],
      opposing_ids: [],
      macro_evidence_ids: ['macro.VIX']
    };
    const validation = validateGrounding(result, makeMacroPacket());
    assert.strictEqual(validation.grounded, false);
    assert.deepStrictEqual(validation.ungrounded_macro, ['macro.VIX']);
  });

  test('legacy result 无 macro_evidence_ids → 不要求，ungrounded_macro 为空', () => {
    const result = {
      direction: 'long',
      evidence_ids: ['price_data.close_60d'],
      opposing_ids: []
    };
    const validation = validateGrounding(result, makeMacroPacket());
    assert.strictEqual(validation.grounded, true);
    assert.deepStrictEqual(validation.ungrounded_macro, []);
  });

  test('packet 无 macro_context 但引用宏观 ID → fail-closed', () => {
    const packet = makeMacroPacket();
    delete packet.macro_context;
    const result = {
      direction: 'long',
      evidence_ids: ['price_data.close_60d'],
      opposing_ids: [],
      macro_evidence_ids: ['macro.DXY']
    };
    const validation = validateGrounding(result, packet);
    assert.strictEqual(validation.grounded, false);
    assert.deepStrictEqual(validation.ungrounded_macro, ['macro.DXY']);
  });
});

describe('extractResult 三字段条件式强制', () => {
  const CTX_AVAILABLE = { expectedSymbol: 'AU0', expectedSignalDate: '2026-08-26', expectedStrategy: 'fincot', macroContext: { status: 'available', hasEvidence: true } };

  function fincotJson(overrides = {}) {
    const base = {
      symbol: 'AU0',
      signalDate: '2026-08-26',
      strategy: 'fincot',
      direction: 'long',
      confidence: 'medium',
      pass_reason: null,
      evidence_ids: ['price_data.close_60d', 'volume_oi.avgVolume5d'],
      opposing_ids: [],
      reasoning_summary: '价格站上MA20且量仓配合，宏观美元走弱构成顺风',
      invalidate_if: ['跌破MA20'],
      branch_status: { regime: 'available', macro_fundamental: 'available', position_flow: 'abstain' },
      macro_support: 'supportive',
      macro_conflict: false,
      macro_evidence_ids: ['macro.DXY']
    };
    const merged = { ...base, ...overrides };
    return JSON.stringify(merged);
  }

  test('available+evidence+long：三字段合法 → 解析通过并携带', () => {
    const result = extractResult(fincotJson(), CTX_AVAILABLE);
    assert.strictEqual(result.macro_support, 'supportive');
    assert.strictEqual(result.macro_conflict, false);
    assert.deepStrictEqual(result.macro_evidence_ids, ['macro.DXY']);
  });

  test('新 packet 缺三字段 → 抛错', () => {
    const json = fincotJson({ macro_support: undefined, macro_conflict: undefined, macro_evidence_ids: undefined });
    assert.throws(() => extractResult(json, CTX_AVAILABLE), /macro_support/);
  });

  test('非法 enum macro_support → 抛错', () => {
    assert.throws(() => extractResult(fincotJson({ macro_support: 'bullish' }), CTX_AVAILABLE), /macro_support/);
  });

  test('无证据却用 false 冒充无冲突 → 抛错', () => {
    const ctxNoEvidence = { ...CTX_AVAILABLE, macroContext: { status: 'available', hasEvidence: false } };
    assert.throws(() => extractResult(fincotJson(), ctxNoEvidence), /macro_conflict|macro_support/);
  });

  test('direction=pass 必须 null/null/[] → 非 null 抛错', () => {
    const passJson = fincotJson({
      direction: 'pass',
      confidence: 'low',
      pass_reason: 'data_insufficient',
      evidence_ids: [],
      branch_status: { regime: 'available', macro_fundamental: 'abstain', position_flow: 'abstain' },
      macro_support: 'neutral'
    });
    assert.throws(() => extractResult(passJson, CTX_AVAILABLE), /macro_support/);
  });

  test('direction=pass 且 null/null/[] → 通过', () => {
    const passJson = fincotJson({
      direction: 'pass',
      confidence: 'low',
      pass_reason: 'data_insufficient',
      evidence_ids: [],
      branch_status: { regime: 'available', macro_fundamental: 'abstain', position_flow: 'abstain' },
      macro_support: null,
      macro_conflict: null,
      macro_evidence_ids: []
    });
    const result = extractResult(passJson, CTX_AVAILABLE);
    assert.strictEqual(result.direction, 'pass');
    assert.strictEqual(result.macro_support, null);
    assert.strictEqual(result.macro_conflict, null);
    assert.deepStrictEqual(result.macro_evidence_ids, []);
  });

  test('macro_support 非 null 但 macro_evidence_ids 为空 → 抛错', () => {
    assert.throws(() => extractResult(fincotJson({ macro_evidence_ids: [] }), CTX_AVAILABLE), /macro_evidence_ids/);
  });

  test('not_applicable：null/null/[] → 通过', () => {
    const ctx = { ...CTX_AVAILABLE, macroContext: { status: 'not_applicable', hasEvidence: false } };
    const result = extractResult(
      fincotJson({ macro_support: null, macro_conflict: null, macro_evidence_ids: [] }),
      ctx
    );
    assert.strictEqual(result.macro_support, null);
    assert.strictEqual(result.macro_conflict, null);
    assert.deepStrictEqual(result.macro_evidence_ids, []);
  });

  test('unavailable：null/null/[] → 通过；非空 ids → 抛错', () => {
    const ctx = { ...CTX_AVAILABLE, macroContext: { status: 'unavailable', hasEvidence: false } };
    const result = extractResult(
      fincotJson({ macro_support: null, macro_conflict: null, macro_evidence_ids: [] }),
      ctx
    );
    assert.strictEqual(result.macro_support, null);
    assert.throws(
      () => extractResult(fincotJson({ macro_support: null, macro_conflict: null }), ctx),
      /macro_evidence_ids/
    );
  });

  test('legacy（无 macroContext context）：返回对象不带三字段，即使 JSON 里有', () => {
    const result = extractResult(fincotJson(), { expectedSymbol: 'AU0', expectedSignalDate: '2026-08-26', expectedStrategy: 'fincot' });
    assert.ok(!('macro_support' in result), 'legacy 结果不得新增 macro_support 键');
    assert.ok(!('macro_conflict' in result));
    assert.ok(!('macro_evidence_ids' in result));
    assert.strictEqual(result.direction, 'long');
  });
});

const validMacroFincot = JSON.stringify({
  symbol: 'AU0',
  signalDate: '2026-08-26',
  strategy: 'fincot',
  direction: 'long',
  confidence: 'medium',
  pass_reason: null,
  evidence_ids: ['price_data.close_60d', 'volume_oi.avgVolume5d'],
  opposing_ids: [],
  reasoning_summary: '宏观美元走弱与量价方向一致',
  invalidate_if: ['跌破MA20'],
  branch_status: { regime: 'available', macro_fundamental: 'available', position_flow: 'abstain' },
  macro_support: 'supportive',
  macro_conflict: false,
  macro_evidence_ids: ['macro.DXY']
});

describe('runReasoningArm 宏路径', () => {
  function providerWith(text) {
    return {
      async complete() {
        return { text, provider: 'recorded', modelId: MODEL.modelId, temperature: MODEL.temperature, maxTokens: MODEL.maxTokens };
      }
    };
  }

  test('accepted：三字段随结果写入', async () => {
    const entry = await runReasoningArm({
      packet: makeMacroPacket(),
      arm: 'fincot',
      provider: providerWith(validMacroFincot),
      model: MODEL,
      promptVersion: 'v1.3-fincot-macro',
      parseRetries: 0
    });
    assert.strictEqual(entry.status, 'accepted');
    assert.strictEqual(entry.result.macro_support, 'supportive');
    assert.strictEqual(entry.result.macro_conflict, false);
    assert.deepStrictEqual(entry.result.macro_evidence_ids, ['macro.DXY']);
    assert.strictEqual(entry.grounding.grounded, true);
  });

  test('grounding 失败按既有机制降级 pass/model_abstain 且三字段 null/null/[]', async () => {
    const badGrounding = JSON.parse(validMacroFincot);
    badGrounding.evidence_ids = ['nonexistent.field'];
    const entry = await runReasoningArm({
      packet: makeMacroPacket(),
      arm: 'fincot',
      provider: providerWith(JSON.stringify(badGrounding)),
      model: MODEL,
      promptVersion: 'v1.3-fincot-macro',
      parseRetries: 0
    });
    assert.strictEqual(entry.status, 'grounding_degraded');
    assert.strictEqual(entry.result.direction, 'pass');
    assert.strictEqual(entry.result.pass_reason, 'model_abstain');
    assert.strictEqual(entry.result.macro_support, null);
    assert.strictEqual(entry.result.macro_conflict, null);
    assert.deepStrictEqual(entry.result.macro_evidence_ids, []);
  });

  test('新 packet 三字段缺失 → parse 失败（fail-closed，非静默通过）', async () => {
    const missing = JSON.parse(validMacroFincot);
    delete missing.macro_support;
    delete missing.macro_conflict;
    delete missing.macro_evidence_ids;
    const entry = await runReasoningArm({
      packet: makeMacroPacket(),
      arm: 'fincot',
      provider: providerWith(JSON.stringify(missing)),
      model: MODEL,
      promptVersion: 'v1.3-fincot-macro',
      parseRetries: 0
    });
    assert.strictEqual(entry.status, 'parse_failed');
    assert.ok(entry.parseError && entry.parseError.includes('macro_support'));
  });
});

describe('runner eligibility 门禁（P1 修复：malformed macro_context 必须在 provider 边界被拦截）', () => {
  function countingProvider(text) {
    let calls = 0;
    return {
      calls() {
        return calls;
      },
      async complete() {
        calls += 1;
        return { text, provider: 'recorded', modelId: MODEL.modelId, temperature: MODEL.temperature, maxTokens: MODEL.maxTokens };
      }
    };
  }

  test('malformed macro_context（status 非法）→ packet_ineligible 且 provider 不被调用', async () => {
    const packet = makeMacroPacket();
    packet.macro_context.status = 'bogus';
    const provider = countingProvider(validMacroFincot);
    const entry = await runReasoningArm({
      packet,
      arm: 'fincot',
      provider,
      model: MODEL,
      promptVersion: 'v1.3-fincot-macro',
      parseRetries: 0
    });
    assert.strictEqual(entry.status, 'packet_ineligible');
    assert.strictEqual(provider.calls(), 0, 'provider.complete 不得被调用');
  });

  test('malformed macro_context（evidence value 非有限数字）→ packet_ineligible 且 provider 不被调用', async () => {
    const packet = makeMacroPacket();
    packet.macro_context.evidence[0].value = '98.9';
    const provider = countingProvider(validMacroFincot);
    const entry = await runReasoningArm({
      packet,
      arm: 'fincot',
      provider,
      model: MODEL,
      promptVersion: 'v1.3-fincot-macro',
      parseRetries: 0
    });
    assert.strictEqual(entry.status, 'packet_ineligible');
    assert.strictEqual(provider.calls(), 0, 'provider.complete 不得被调用');
  });

  test('buildPacket 识别 malformed macro_context → validation.macroContext.valid=false', () => {
    const packet = makeMacroPacket();
    packet.macro_context.status = 'bogus';
    const raw = {
      symbol: packet.symbol,
      signalDate: packet.signalDate,
      marketCutoffAt: packet.marketCutoffAt,
      packetFrozenAt: packet.packetFrozenAt,
      frozenCommit: packet.frozenCommit,
      fields: packet.fields,
      macro_context: packet.macro_context
    };
    const { validation } = buildPacket(raw);
    assert.strictEqual(validation.macroContext.valid, false);
  });

  test('合法三态（unavailable+reason）不被误杀 → provider 被调用', async () => {
    const packet = makeMacroPacket();
    packet.macro_context = {
      status: 'unavailable',
      relevant_anchor_ids: [],
      evidence: [],
      gaps: [],
      reason: 'macro-snapshot.json missing',
      snapshot: null
    };
    const unavailableFincot = JSON.stringify({
      symbol: 'AU0',
      signalDate: '2026-08-26',
      strategy: 'fincot',
      direction: 'long',
      confidence: 'medium',
      pass_reason: null,
      evidence_ids: ['price_data.close_60d', 'volume_oi.avgVolume5d'],
      opposing_ids: [],
      reasoning_summary: '无宏观证据，纯产业判断',
      invalidate_if: ['跌破MA20'],
      branch_status: { regime: 'available', macro_fundamental: 'available', position_flow: 'abstain' },
      macro_support: null,
      macro_conflict: null,
      macro_evidence_ids: []
    });
    const provider = countingProvider(unavailableFincot);
    const entry = await runReasoningArm({
      packet,
      arm: 'fincot',
      provider,
      model: MODEL,
      promptVersion: 'v1.3-fincot-macro',
      parseRetries: 0
    });
    assert.strictEqual(entry.status, 'accepted');
    assert.strictEqual(provider.calls(), 1, '合法三态应正常进入 provider');
  });
});
