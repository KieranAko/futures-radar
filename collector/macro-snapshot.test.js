/**
 * collector/macro-snapshot.test.js — Phase 3 阶段一宏观快照 schema 不变量测试
 *
 * 验收口径：
 * 1. 每个值都有 source/asOf/fetchedAt
 * 2. asOf <= marketCutoffAt
 * 3. fetchedAt <= snapshotFrozenAt
 * 4. 缺失值显示 missing，不伪造
 * 5. 单个指标失败不会阻断整条期货雷达（missing 合法）
 *
 * 另含配置文件交叉校验：传导表引用的锚点必须全部在指标配置中声明，
 * 防止配置漂移导致报告阶段静默丢失锚点。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { validateMacroSnapshot, SCHEMA_VERSION } = require('../collector/macro-probe.cjs');
const { skillRoot } = require('../lib/workspace.cjs');

function freshInd(overrides = {}) {
  return {
    status: 'fresh',
    value: 100,
    change5d: 1.2,
    asOf: '2026-08-25',
    fetchedAt: '2026-08-26T05:59:00Z',
    source: 'sina',
    _timestamp_origin: 'observed',
    ...overrides,
  };
}

function validSnapshot(indicators = null, quality = null) {
  const inds = indicators || {
    DXY: freshInd(),
    USDCNH: freshInd(),
    US10Y: freshInd({ source: 'akshare' }),
    DR007: { status: 'missing', reason: 'source down', fetchedAt: '2026-08-26T05:59:00Z', source: 'akshare', _timestamp_origin: 'observed' },
    SC0: freshInd({ source: 'raw.json' }),
  };
  const available = Object.values(inds).filter((r) => r.status !== 'missing').length;
  const missing = Object.values(inds).length - available;
  return {
    meta: {
      runId: 'R1',
      signalDate: '2026-08-25',
      snapshotFrozenAt: '2026-08-26T06:00:00Z',
      marketCutoffAt: '2026-08-25',
      schemaVersion: SCHEMA_VERSION,
    },
    indicators: inds,
    quality: quality || { available, missing, eligible: available >= 1 },
  };
}

describe('macro-snapshot schema invariants', () => {
  it('合法快照通过校验', () => {
    const v = validateMacroSnapshot(validSnapshot());
    assert.strictEqual(v.ok, true, JSON.stringify(v.errors));
  });

  it('meta 缺字段被拒绝', () => {
    for (const field of ['runId', 'signalDate', 'snapshotFrozenAt', 'marketCutoffAt', 'schemaVersion']) {
      const snap = validSnapshot();
      delete snap.meta[field];
      const v = validateMacroSnapshot(snap);
      assert.strictEqual(v.ok, false, `meta.${field} 缺失应被拒绝`);
    }
  });

  it('schemaVersion 不匹配被拒绝', () => {
    const snap = validSnapshot();
    snap.meta.schemaVersion = '0.9.0';
    assert.strictEqual(validateMacroSnapshot(snap).ok, false);
  });

  it('非 missing 指标必须有 source/asOf/fetchedAt/有限 value', () => {
    for (const field of ['source', 'asOf', 'fetchedAt', 'value']) {
      const inds = validSnapshot().indicators;
      delete inds.DXY[field];
      const snap = validSnapshot(inds, { available: 4, missing: 1, eligible: true });
      const v = validateMacroSnapshot(snap);
      assert.strictEqual(v.ok, false, `DXY.${field} 缺失应被拒绝`);
    }
  });

  it('asOf > marketCutoffAt 被拒绝（禁止使用盘中未完成 bar）', () => {
    const inds = validSnapshot().indicators;
    inds.DXY = freshInd({ asOf: '2026-08-26' });
    assert.strictEqual(validateMacroSnapshot(validSnapshot(inds)).ok, false);
  });

  it('fetchedAt > snapshotFrozenAt 被拒绝', () => {
    const inds = validSnapshot().indicators;
    inds.DXY = freshInd({ fetchedAt: '2026-08-26T07:00:00Z' });
    assert.strictEqual(validateMacroSnapshot(validSnapshot(inds)).ok, false);
  });

  it('missing 指标必须有 reason 且不得有 value', () => {
    const noReasonInds = validSnapshot().indicators;
    noReasonInds.DXY = { status: 'missing', source: 'sina', fetchedAt: '2026-08-26T05:59:00Z', _timestamp_origin: 'observed' };
    assert.strictEqual(validateMacroSnapshot(validSnapshot(noReasonInds)).ok, false);

    const withValueInds = validSnapshot().indicators;
    withValueInds.DXY = { status: 'missing', reason: 'x', value: 99, source: 'sina', fetchedAt: '2026-08-26T05:59:00Z', _timestamp_origin: 'observed' };
    assert.strictEqual(validateMacroSnapshot(validSnapshot(withValueInds)).ok, false);
  });

  it('stale 状态合法（asOf < signalDate 但取到数据）', () => {
    const inds = validSnapshot().indicators;
    inds.DXY = freshInd({ status: 'stale', asOf: '2026-08-22' });
    const snap = validSnapshot(inds);
    assert.strictEqual(validateMacroSnapshot(snap).ok, true, JSON.stringify(validateMacroSnapshot(snap).errors));
  });

  it('change5d 允许 null（序列不足），但不得非有限', () => {
    const okInds = validSnapshot().indicators;
    okInds.DXY = freshInd({ change5d: null });
    assert.strictEqual(validateMacroSnapshot(validSnapshot(okInds)).ok, true);

    const badInds = validSnapshot().indicators;
    badInds.DXY = freshInd({ change5d: NaN });
    assert.strictEqual(validateMacroSnapshot(validSnapshot(badInds)).ok, false);
  });

  it('value 非有限被拒绝', () => {
    const inds = validSnapshot().indicators;
    inds.DXY = freshInd({ value: Infinity });
    assert.strictEqual(validateMacroSnapshot(validSnapshot(inds)).ok, false);
  });

  it('quality 计数与 indicators 实际不符被拒绝', () => {
    const snap = validSnapshot();
    snap.quality.available = 5;
    assert.strictEqual(validateMacroSnapshot(snap).ok, false);
    snap.quality = { available: 4, missing: 0, eligible: true };
    assert.strictEqual(validateMacroSnapshot(snap).ok, false);
  });

  it('quality.eligible 必须为布尔', () => {
    const snap = validSnapshot();
    snap.quality.eligible = 'yes';
    assert.strictEqual(validateMacroSnapshot(snap).ok, false);
  });

  it('indicators 为空对象时（全部 missing 且未申报）拒绝 quality.eligible=true', () => {
    const snap = validSnapshot({}, { available: 0, missing: 0, eligible: true });
    assert.strictEqual(validateMacroSnapshot(snap).ok, false);
  });
});

describe('hardening: 恰好5锚点/ISO日期/source白名单/_timestamp_origin', () => {
  it('锚点集合缺失任一 → 拒绝', () => {
    for (const missing of ['DXY', 'USDCNH', 'US10Y', 'DR007', 'SC0']) {
      const inds = validSnapshot().indicators;
      delete inds[missing];
      const snap = validSnapshot(inds);
      const v = validateMacroSnapshot(snap);
      assert.strictEqual(v.ok, false, `缺 ${missing} 应被拒绝`);
    }
  });

  it('锚点集合多出未声明 id → 拒绝', () => {
    const inds = validSnapshot().indicators;
    inds.FAKE = freshInd({ source: 'akshare' });
    assert.strictEqual(validateMacroSnapshot(validSnapshot(inds)).ok, false);
  });

  it('锚点被替换为其他 id → 拒绝', () => {
    const inds = validSnapshot().indicators;
    const dxy = inds.DXY;
    delete inds.DXY;
    inds.DXY_ALT = dxy;
    assert.strictEqual(validateMacroSnapshot(validSnapshot(inds)).ok, false);
  });

  it('meta.signalDate / marketCutoffAt 非 ISO 日期格式 → 拒绝', () => {
    for (const [field, bad] of [['signalDate', '2026/08/25'], ['marketCutoffAt', '08-25-2026']]) {
      const snap = validSnapshot();
      snap.meta[field] = bad;
      const v = validateMacroSnapshot(snap);
      assert.strictEqual(v.ok, false, `meta.${field}=${bad} 应被拒绝`);
    }
  });

  it('非真实日历日期（2026-02-30）→ 拒绝', () => {
    const snap = validSnapshot();
    snap.meta.signalDate = '2026-02-30';
    snap.meta.marketCutoffAt = '2026-02-30';
    assert.strictEqual(validateMacroSnapshot(snap).ok, false);
  });

  it('指标 asOf 非 ISO 日期格式 → 拒绝', () => {
    const inds = validSnapshot().indicators;
    inds.DXY = freshInd({ asOf: '2026/08/25' });
    assert.strictEqual(validateMacroSnapshot(validSnapshot(inds)).ok, false);
  });

  it('snapshotFrozenAt / fetchedAt 非 ISO 时间戳 → 拒绝', () => {
    for (const [field, bad] of [['snapshotFrozenAt', '2026-08-26 06:00:00'], ['snapshotFrozenAt', '2026-08-26T06:00:00+08:00']]) {
      const snap = validSnapshot();
      snap.meta[field] = bad;
      assert.strictEqual(validateMacroSnapshot(snap).ok, false, `meta.${field}=${bad} 应被拒绝`);
    }
    const inds = validSnapshot().indicators;
    inds.DXY = freshInd({ fetchedAt: '2026-08-26T05:59:00' });
    assert.strictEqual(validateMacroSnapshot(validSnapshot(inds)).ok, false);
  });

  it('_timestamp_origin 缺失或非 observed → 拒绝（含 missing 指标）', () => {
    const noOrigin = validSnapshot().indicators;
    delete noOrigin.DXY._timestamp_origin;
    assert.strictEqual(validateMacroSnapshot(validSnapshot(noOrigin)).ok, false);

    const badOrigin = validSnapshot().indicators;
    badOrigin.DR007 = { status: 'missing', reason: 'x', source: 'akshare', fetchedAt: '2026-08-26T05:59:00Z', _timestamp_origin: 'estimated' };
    assert.strictEqual(validateMacroSnapshot(validSnapshot(badOrigin)).ok, false);
  });

  it('source 与配置声明不符（DXY 用 wind）→ 拒绝', () => {
    const inds = validSnapshot().indicators;
    inds.DXY = freshInd({ source: 'wind' });
    assert.strictEqual(validateMacroSnapshot(validSnapshot(inds)).ok, false);
  });

  it('source 与配置声明不符（SC0 用 akshare）→ 拒绝', () => {
    const inds = validSnapshot().indicators;
    inds.SC0 = freshInd({ source: 'akshare' });
    assert.strictEqual(validateMacroSnapshot(validSnapshot(inds)).ok, false);
  });
});

describe('config 交叉校验', () => {
  const indicators = JSON.parse(fs.readFileSync(path.join(skillRoot, 'config', 'macro-indicators.json'), 'utf8'));
  const transmission = JSON.parse(fs.readFileSync(path.join(skillRoot, 'config', 'macro-transmission.json'), 'utf8'));

  it('冻结锚点恰好 5 个（DXY/USDCNH/US10Y/DR007/SC0）', () => {
    assert.deepStrictEqual(Object.keys(indicators.indicators).sort(), ['DR007', 'DXY', 'SC0', 'US10Y', 'USDCNH']);
  });

  it('每个指标声明 id/label/unit/source/fetch.kind', () => {
    for (const [id, cfg] of Object.entries(indicators.indicators)) {
      assert.strictEqual(cfg.id, id);
      for (const field of ['label', 'unit', 'source', 'fetch']) {
        assert.ok(cfg[field] !== undefined, `${id}.${field} 未声明`);
      }
      assert.ok(typeof cfg.fetch.kind === 'string' && cfg.fetch.kind.length > 0, `${id}.fetch.kind 未声明`);
    }
  });

  it('传导表引用的锚点全部在指标配置中声明', () => {
    const declared = new Set(Object.keys(indicators.indicators));
    for (const rule of transmission.rules) {
      for (const anchor of rule.anchors) {
        assert.ok(declared.has(anchor), `传导表引用未声明锚点: ${anchor}`);
      }
    }
  });

  it('传导表前缀不携带合约尾号 0，且规则间无重复前缀', () => {
    const seen = new Set();
    for (const rule of transmission.rules) {
      for (const p of rule.prefixes) {
        assert.ok(!p.endsWith('0'), `前缀 ${p} 不应携带合约尾号`);
        assert.ok(!seen.has(p), `前缀重复: ${p}`);
        seen.add(p);
      }
    }
  });

  it('SC0 是唯一 raw_contract 型指标（不重复抓取）', () => {
    const rawKinds = Object.values(indicators.indicators).filter((c) => c.fetch.kind === 'raw_contract');
    assert.strictEqual(rawKinds.length, 1);
    assert.strictEqual(rawKinds[0].id, 'SC0');
  });
});
