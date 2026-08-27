/**
 * Macro Context Test（Phase 3 阶段二）
 * 验证 buildMacroContext 三态构建（available/not_applicable/unavailable）、
 * validateMacroContext 形状校验、packet hash 覆盖、四臂 prompt 隔离。
 * 冻结口径：缅因猫阶段二实施规格（thread 0001787736242943）。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { buildMacroContext, validateMacroContext } from '../lib/macro-context.js';
import { buildPacket } from '../lib/packet-builder.js';
import { hashPacket } from '../lib/reasoning-artifact.js';
import { renderFourArmPrompts } from '../lib/prompt-renderer.js';

const RUN_ID = '20260826-1622-auto';
const SIGNAL_DATE = '2026-08-26';

function makeSnapshot(overrides = {}) {
  const snapshot = {
    meta: {
      runId: RUN_ID,
      signalDate: SIGNAL_DATE,
      snapshotFrozenAt: '2026-08-26T08:23:27.596Z',
      marketCutoffAt: SIGNAL_DATE,
      schemaVersion: '1.0.0'
    },
    indicators: {
      DXY: {
        status: 'fresh',
        value: 98.9774,
        change5d: 0.19,
        asOf: '2026-08-26',
        fetchedAt: '2026-08-26T08:23:23Z',
        source: 'sina',
        _timestamp_origin: 'observed'
      },
      US10Y: {
        status: 'missing',
        source: 'akshare',
        fetchedAt: '2026-08-26T08:23:25Z',
        _timestamp_origin: 'observed',
        reason: 'fetch failed'
      },
      SC0: {
        status: 'stale',
        value: 584.1,
        change5d: -0.12,
        asOf: '2026-08-25',
        fetchedAt: '2026-08-26T08:23:23.346Z',
        source: 'raw.json',
        _timestamp_origin: 'observed'
      }
    },
    quality: { available: 2, missing: 1, eligible: true }
  };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete snapshot[k];
    else snapshot[k] = v;
  }
  return snapshot;
}

const VALID_VALIDATION = { ok: true, errors: [] };

function makeLegacyRaw() {
  return {
    symbol: 'RB2501',
    signalDate: '2026-08-15',
    marketCutoffAt: '2026-08-15T15:00:00+08:00',
    packetFrozenAt: '2026-08-15T16:30:00+08:00',
    frozenCommit: 'abc123',
    fields: {
      price_data: {
        source: 'akshare',
        asOf: '2026-08-15T15:00:00+08:00',
        fetchedAt: '2026-08-15T15:05:00+08:00',
        close_60d: [4000, 4100],
        ma20: 4050,
        ma60: 3980,
        freshness: 'same_day',
        gap: null
      },
      volume_oi: {
        source: 'akshare',
        asOf: '2026-08-15T15:00:00+08:00',
        fetchedAt: '2026-08-15T15:06:00+08:00',
        volume_60d: [100000, 110000],
        avgVolume5d: 105000,
        freshness: 'same_day',
        gap: null
      }
    }
  };
}

function makePacketWithMacro(mc) {
  return {
    symbol: 'AU0',
    signalDate: SIGNAL_DATE,
    fields: {
      price_data: { source: 'akshare', asOf: '2026-08-26T15:00:00+08:00', fetchedAt: '2026-08-26T15:05:00+08:00', freshness: 'same_day', gap: null, close_60d: [500, 510], ma20: 505, ma60: 490 },
      volume_oi: { source: 'akshare', asOf: '2026-08-26T15:00:00+08:00', fetchedAt: '2026-08-26T15:06:00+08:00', freshness: 'same_day', gap: null, volume_60d: [1000, 1100], avgVolume5d: 1050 }
    },
    macro_context: mc
  };
}

describe('buildMacroContext', () => {
  test('available：路由命中 + 部分 missing → evidence/gaps 正确且值逐字透传', () => {
    const mc = buildMacroContext({
      snapshot: makeSnapshot(),
      validation: VALID_VALIDATION,
      runId: RUN_ID,
      signalDate: SIGNAL_DATE,
      symbol: 'AU0',
      relevantAnchors: ['DXY', 'US10Y']
    });

    assert.strictEqual(mc.status, 'available');
    assert.deepStrictEqual(mc.relevant_anchor_ids, ['DXY', 'US10Y']);
    assert.strictEqual(mc.reason, null);
    assert.strictEqual(mc.evidence.length, 1);
    assert.deepStrictEqual(mc.evidence[0], {
      id: 'macro.DXY',
      anchor: 'DXY',
      value: 98.9774,
      change5d: 0.19,
      status: 'fresh',
      asOf: '2026-08-26',
      fetchedAt: '2026-08-26T08:23:23Z',
      source: 'sina',
      _timestamp_origin: 'observed'
    });
    assert.strictEqual(mc.gaps.length, 1);
    assert.deepStrictEqual(mc.gaps[0], { id: 'macro.US10Y', anchor: 'US10Y', reason: 'fetch failed' });
    assert.deepStrictEqual(mc.snapshot, {
      signalDate: SIGNAL_DATE,
      marketCutoffAt: SIGNAL_DATE,
      snapshotFrozenAt: '2026-08-26T08:23:27.596Z',
      schemaVersion: '1.0.0'
    });
  });

  test('available：stale 锚点进 evidence（带 stale 状态）', () => {
    const mc = buildMacroContext({
      snapshot: makeSnapshot(),
      validation: VALID_VALIDATION,
      runId: RUN_ID,
      signalDate: SIGNAL_DATE,
      symbol: 'SC0',
      relevantAnchors: ['SC0']
    });

    assert.strictEqual(mc.status, 'available');
    assert.strictEqual(mc.evidence.length, 1);
    assert.strictEqual(mc.evidence[0].id, 'macro.SC0');
    assert.strictEqual(mc.evidence[0].status, 'stale');
    assert.strictEqual(mc.evidence[0].value, 584.1);
    assert.deepStrictEqual(mc.gaps, []);
  });

  test('空路由 → not_applicable（evidence/gaps 均空，快照元信息保留）', () => {
    const mc = buildMacroContext({
      snapshot: makeSnapshot(),
      validation: VALID_VALIDATION,
      runId: RUN_ID,
      signalDate: SIGNAL_DATE,
      symbol: 'AP0',
      relevantAnchors: []
    });

    assert.strictEqual(mc.status, 'not_applicable');
    assert.deepStrictEqual(mc.relevant_anchor_ids, []);
    assert.deepStrictEqual(mc.evidence, []);
    assert.deepStrictEqual(mc.gaps, []);
    assert.strictEqual(mc.reason, null);
    assert.strictEqual(mc.snapshot.schemaVersion, '1.0.0');
  });

  test('快照缺失 → unavailable（reason 必填，禁止伪造 evidence）', () => {
    const mc = buildMacroContext({
      snapshot: null,
      validation: null,
      runId: RUN_ID,
      signalDate: SIGNAL_DATE,
      symbol: 'AU0',
      relevantAnchors: ['DXY']
    });

    assert.strictEqual(mc.status, 'unavailable');
    assert.deepStrictEqual(mc.evidence, []);
    assert.deepStrictEqual(mc.gaps, []);
    assert.deepStrictEqual(mc.relevant_anchor_ids, []);
    assert.strictEqual(mc.snapshot, null);
    assert.ok(mc.reason && mc.reason.length > 0, 'unavailable 必须带 reason');
  });

  test('快照不可读 → unavailable（reason 带读取错误）', () => {
    const mc = buildMacroContext({
      snapshot: null,
      validation: null,
      readError: 'Unexpected token } in JSON',
      runId: RUN_ID,
      signalDate: SIGNAL_DATE,
      symbol: 'AU0',
      relevantAnchors: ['DXY']
    });

    assert.strictEqual(mc.status, 'unavailable');
    assert.ok(mc.reason.includes('Unexpected token'), 'reason 应包含读取错误');
    assert.deepStrictEqual(mc.evidence, []);
  });

  test('validator 失败 → unavailable（fail-closed）', () => {
    const mc = buildMacroContext({
      snapshot: makeSnapshot(),
      validation: { ok: false, errors: ['schemaVersion mismatch: expected 1.0.0, got 9.9.9'] },
      runId: RUN_ID,
      signalDate: SIGNAL_DATE,
      symbol: 'AU0',
      relevantAnchors: ['DXY']
    });

    assert.strictEqual(mc.status, 'unavailable');
    assert.strictEqual(mc.snapshot, null);
    assert.ok(mc.reason.includes('schemaVersion mismatch'));
    assert.deepStrictEqual(mc.evidence, []);
  });

  test('runId 不符 → unavailable', () => {
    const mc = buildMacroContext({
      snapshot: makeSnapshot(),
      validation: VALID_VALIDATION,
      runId: 'another-run-id',
      signalDate: SIGNAL_DATE,
      symbol: 'AU0',
      relevantAnchors: ['DXY']
    });

    assert.strictEqual(mc.status, 'unavailable');
    assert.ok(mc.reason.includes('runId'));
    assert.deepStrictEqual(mc.evidence, []);
  });

  test('signalDate 不符 → unavailable（point-in-time fail-closed）', () => {
    const mc = buildMacroContext({
      snapshot: makeSnapshot(),
      validation: VALID_VALIDATION,
      runId: RUN_ID,
      signalDate: '2026-08-25',
      symbol: 'AU0',
      relevantAnchors: ['DXY']
    });

    assert.strictEqual(mc.status, 'unavailable');
    assert.ok(mc.reason.includes('signalDate'));
  });
});

describe('validateMacroContext', () => {
  test('available 形状合法', () => {
    const mc = buildMacroContext({
      snapshot: makeSnapshot(),
      validation: VALID_VALIDATION,
      runId: RUN_ID,
      signalDate: SIGNAL_DATE,
      symbol: 'AU0',
      relevantAnchors: ['DXY', 'US10Y']
    });
    assert.deepStrictEqual(validateMacroContext(mc), { valid: true, errors: [] });
  });

  test('not_applicable 形状合法', () => {
    const mc = buildMacroContext({
      snapshot: makeSnapshot(),
      validation: VALID_VALIDATION,
      runId: RUN_ID,
      signalDate: SIGNAL_DATE,
      symbol: 'AP0',
      relevantAnchors: []
    });
    assert.deepStrictEqual(validateMacroContext(mc), { valid: true, errors: [] });
  });

  test('unavailable 形状合法（reason 必填）', () => {
    const mc = buildMacroContext({
      snapshot: null,
      validation: null,
      runId: RUN_ID,
      signalDate: SIGNAL_DATE,
      symbol: 'AU0',
      relevantAnchors: ['DXY']
    });
    assert.deepStrictEqual(validateMacroContext(mc), { valid: true, errors: [] });
  });

  test('非法 status → invalid', () => {
    const v = validateMacroContext({ status: 'weird', relevant_anchor_ids: [], evidence: [], gaps: [], reason: null, snapshot: null });
    assert.strictEqual(v.valid, false);
    assert.ok(v.errors.some((e) => e.includes('status')));
  });

  test('unavailable 缺 reason → invalid', () => {
    const v = validateMacroContext({ status: 'unavailable', relevant_anchor_ids: [], evidence: [], gaps: [], reason: null, snapshot: null });
    assert.strictEqual(v.valid, false);
    assert.ok(v.errors.some((e) => e.includes('reason')));
  });

  test('evidence 缺 id → invalid', () => {
    const v = validateMacroContext({
      status: 'available',
      relevant_anchor_ids: ['DXY'],
      evidence: [{ anchor: 'DXY', value: 99, status: 'fresh' }],
      gaps: [],
      reason: null,
      snapshot: null
    });
    assert.strictEqual(v.valid, false);
    assert.ok(v.errors.some((e) => e.includes('evidence[0]')));
  });
});

describe('packet hash 覆盖 macro_context', () => {
  test('legacy packet 不含 macro_context 且 hash 稳定', () => {
    const raw = makeLegacyRaw();
    const p1 = buildPacket(raw).packet;
    const p2 = buildPacket(makeLegacyRaw()).packet;
    assert.ok(!('macro_context' in p1));
    assert.strictEqual(hashPacket(p1), hashPacket(p2));
  });

  test('macro value 变化 → hash 变化', () => {
    const base = buildMacroContext({ snapshot: makeSnapshot(), validation: VALID_VALIDATION, runId: RUN_ID, signalDate: SIGNAL_DATE, symbol: 'AU0', relevantAnchors: ['DXY', 'US10Y'] });
    const changedValue = JSON.parse(JSON.stringify(base));
    changedValue.evidence[0].value = 99.9999;

    const raw = makeLegacyRaw();
    const h1 = hashPacket(buildPacket({ ...raw, macro_context: base }).packet);
    const h2 = hashPacket(buildPacket({ ...raw, macro_context: changedValue }).packet);
    assert.notStrictEqual(h1, h2);
  });

  test('macro status 变化 → hash 变化', () => {
    const base = buildMacroContext({ snapshot: makeSnapshot(), validation: VALID_VALIDATION, runId: RUN_ID, signalDate: SIGNAL_DATE, symbol: 'AU0', relevantAnchors: ['DXY', 'US10Y'] });
    const changedStatus = JSON.parse(JSON.stringify(base));
    changedStatus.evidence[0].status = 'stale';

    const raw = makeLegacyRaw();
    const h1 = hashPacket(buildPacket({ ...raw, macro_context: base }).packet);
    const h2 = hashPacket(buildPacket({ ...raw, macro_context: changedStatus }).packet);
    assert.notStrictEqual(h1, h2);
  });

  test('macro asOf 变化 → hash 变化', () => {
    const base = buildMacroContext({ snapshot: makeSnapshot(), validation: VALID_VALIDATION, runId: RUN_ID, signalDate: SIGNAL_DATE, symbol: 'AU0', relevantAnchors: ['DXY', 'US10Y'] });
    const changedAsOf = JSON.parse(JSON.stringify(base));
    changedAsOf.evidence[0].asOf = '2026-08-25';

    const raw = makeLegacyRaw();
    const h1 = hashPacket(buildPacket({ ...raw, macro_context: base }).packet);
    const h2 = hashPacket(buildPacket({ ...raw, macro_context: changedAsOf }).packet);
    assert.notStrictEqual(h1, h2);
  });
});

describe('四臂 prompt 隔离', () => {
  const LEGACY_SENTINEL = '只输出JSON，不要有任何解释或额外文本';

  test('legacy packet（无 macro_context）：四臂 prompt 均无宏观区块', () => {
    const raw = makeLegacyRaw();
    const packet = buildPacket(raw).packet;
    const prompts = renderFourArmPrompts(packet);

    for (const [arm, text] of Object.entries(prompts)) {
      assert.ok(!text.includes('宏观上下文'), `${arm} 不应渲染宏观区块`);
      assert.ok(!text.includes('macro.DXY'), `${arm} 不应泄漏宏观证据`);
    }
    assert.ok(prompts.finCot.includes(LEGACY_SENTINEL), 'legacy fincot 保持原模板尾部');
  });

  test('macro packet available：仅 FinCoT 渲染宏观证据与缺口，其余三臂无泄漏', () => {
    const mc = buildMacroContext({ snapshot: makeSnapshot(), validation: VALID_VALIDATION, runId: RUN_ID, signalDate: SIGNAL_DATE, symbol: 'AU0', relevantAnchors: ['DXY', 'US10Y'] });
    const prompts = renderFourArmPrompts(makePacketWithMacro(mc));

    assert.ok(prompts.finCot.includes('宏观上下文'));
    assert.ok(prompts.finCot.includes('macro.DXY'));
    assert.ok(prompts.finCot.includes('98.9774'));
    assert.ok(prompts.finCot.includes('macro.US10Y'));
    assert.ok(prompts.finCot.includes('fetch failed'));
    assert.ok(prompts.finCot.includes('macro_support'), 'FinCoT 输出契约三字段应出现');
    for (const arm of ['sp', 'ustCot', 'stCot']) {
      assert.ok(!prompts[arm].includes('宏观上下文'), `${arm} 不得渲染宏观区块`);
      assert.ok(!prompts[arm].includes('macro.DXY'), `${arm} 不得泄漏宏观证据`);
    }
  });

  test('macro packet not_applicable：FinCoT 明确无适用锚点', () => {
    const mc = buildMacroContext({ snapshot: makeSnapshot(), validation: VALID_VALIDATION, runId: RUN_ID, signalDate: SIGNAL_DATE, symbol: 'AP0', relevantAnchors: [] });
    const prompts = renderFourArmPrompts(makePacketWithMacro(mc));

    assert.ok(prompts.finCot.includes('not_applicable'));
    assert.ok(prompts.finCot.includes('无适用日频宏观锚点'));
    assert.ok(!prompts.finCot.includes('macro.DXY'));
  });

  test('macro packet unavailable：FinCoT 明确快照不可用并禁止补写', () => {
    const mc = buildMacroContext({ snapshot: null, validation: null, runId: RUN_ID, signalDate: SIGNAL_DATE, symbol: 'AU0', relevantAnchors: ['DXY'] });
    const prompts = renderFourArmPrompts(makePacketWithMacro(mc));

    assert.ok(prompts.finCot.includes('unavailable'));
    assert.ok(prompts.finCot.includes('禁止补写'));
    assert.ok(prompts.finCot.includes(mc.reason));
  });
});
