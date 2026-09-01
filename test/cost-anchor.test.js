import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const EL = path.join(ROOT, 'experiment-line', 'cost-anchor');

const { loadPolicy, freshness, deriveConfidence, capProvidedConfidence, countIndependentSources } = require(path.join(EL, 'policy.cjs'));
const { validateRecord, validateResearchBatch } = require(path.join(EL, 'validate.cjs'));
const { normalizeResearchResult } = require(path.join(EL, 'extract.cjs'));
const { fillTemplate } = require(path.join(EL, 'research-runner.cjs'));

describe('cost-anchor 模块（theory-base/05 实现）', () => {
  it('freshness 按锚类型策略判定，不读 run 快照', () => {
    const policy = loadPolicy();
    assert.equal(policy.anchorTypes.processing_margin.maxStaleDays, 7);
    const fresh = {
      anchorType: 'processing_margin', asOf: '2026-08-31', confidence: 'medium'
    };
    assert.equal(freshness(fresh, '2026-09-01').fresh, true);
    assert.equal(freshness(fresh, '2026-09-20').fresh, false);
    // YYYY-MM 口径归一化为月末：8 月数据在 9-01 仍新鲜
    const monthly = { anchorType: 'processing_margin', asOf: '2026-08', confidence: 'low' };
    assert.equal(freshness(monthly, '2026-09-01').fresh, true);
    assert.deepEqual(freshness({ anchorType: 'extraction', asOf: '2026-07-01', confidence: 'medium' }, '2026-09-01').reasons, ['extraction 记录 age=62d > 30d']);
    assert.equal(freshness(null, '2026-09-01').fresh, false);
    assert.equal(freshness({ anchorType: 'processing_margin', asOf: '2026-09-02', confidence: 'medium' }, '2026-09-01').fresh, false);
  });

  it('validateRecord 拒绝无来源/未来日期/非法区间', () => {
    const ok = {
      symbol: 'SA0', anchorType: 'processing_margin', indicator: '分工艺完全成本',
      valueLow: 550, valueHigh: 1550, unit: '元/吨', asOf: '2026-08',
      sourceDates: ['2026-08-31'], sourceTiers: ['A', 'B'], confidence: 'medium'
    };
    assert.equal(validateRecord(ok, '2026-08-31').ok, true);
    assert.equal(validateRecord({ ...ok, sourceTiers: [] }, '2026-08-31').ok, false);
    assert.equal(validateRecord({ ...ok, asOf: '2026-09-02' }, '2026-08-31').ok, false);
    assert.equal(validateRecord({ ...ok, valueLow: 1600, valueHigh: 1500 }, '2026-08-31').ok, false);
    assert.equal(validateRecord({ ...ok, anchorType: 'nonsense' }, '2026-08-31').ok, false);
    assert.equal(validateRecord({ ...ok, valueLow: null, valueHigh: null, confidence: 'unknown' }, '2026-08-31').ok, true);
  });

  it('结构异常 fail-visible：宽区间不拒绝，而是写入 problems[]', () => {
    const wide = {
      symbol: 'SA0', anchorType: 'processing_margin', indicator: '分工艺完全成本',
      valueLow: 550, valueHigh: 1554, unit: '元/吨', asOf: '2026-08',
      sourceDates: ['2026-08-31'], sourceTiers: ['B', 'B'], confidence: 'low',
      routes: [
        { route: '天然碱法', valueLow: 550, valueHigh: 679 },
        { route: '联碱法', status: 'unknown' },
        { route: '氨碱法', valueLow: 1386, valueHigh: 1554 }
      ],
      missingRoutes: ['联碱法'],
      fallbackRange: { valueLow: 550, valueHigh: 1554, unit: '元/吨' }
    };
    const check = validateRecord(wide, '2026-08-31');
    assert.equal(check.ok, true, '结构性异常不得拒绝记录');
    assert.equal(check.record.structure, 'route_curve');
    const codes = check.record.problems.map((p) => p.code);
    assert.ok(codes.includes('multi_process_collapsed'));
    assert.ok(codes.includes('missing_routes'));
    assert.ok(codes.includes('source_tier_only_b'));
  });

  it('normalizeResearchResult 支持 unknown 墓碑记录', () => {
    const tomb = normalizeResearchResult({ symbol: 'SA0', status: 'unknown', reason: '无来源' }, { runId: 'r', signalDate: '2026-08-31' });
    assert.equal(tomb.confidence, 'unknown');
    assert.equal(tomb.valueLow, null);
    assert.equal(tomb.anchorType, 'unknown');
    const rec = normalizeResearchResult({ symbol: 'SA0', anchorType: 'processing_margin', valueLow: '550', valueHigh: '1550' }, { runId: 'r', signalDate: '2026-08-31' });
    assert.equal(rec.valueLow, 550);
  });

  it('validateResearchBatch 要求每个待研究品种都有结果', () => {
    const ok = {
      symbol: 'SA0', anchorType: 'processing_margin', indicator: 'x', valueLow: 1, valueHigh: 2,
      unit: '元/吨', asOf: '2026-08-31', sourceDates: ['2026-08-31'], sourceTiers: ['A'], confidence: 'low'
    };
    const r = validateResearchBatch([ok], ['SA0'], '2026-08-31');
    assert.equal(r.ok, true);
    assert.equal(validateResearchBatch([], ['SA0'], '2026-08-31').ok, false);
  });

  it('检索模板使用方法学指标名而非泛搜', () => {
    const q = fillTemplate('{name} {indicator} {year} 成本曲线', { name: '铜', indicator: 'C1 cash cost', year: '2026' });
    assert.equal(q, '铜 C1 cash cost 2026 成本曲线');
  });

  it('deriveConfidence 严格按来源层级与独立来源数', () => {
    const policy = loadPolicy();
    const base = { valueLow: 100, valueHigh: 110 };
    // 无有效来源层级 → unknown
    assert.equal(deriveConfidence({ ...base, sourceTiers: [], sourceDates: [] }, policy), 'unknown');
    assert.equal(deriveConfidence({ ...base, sourceTiers: ['C'], sourceDates: ['x'] }, policy), 'unknown');
    // 单一 B 级来源 → low
    assert.equal(deriveConfidence({ ...base, sourceTiers: ['B'], sourceDates: ['x'] }, policy), 'low');
    // 两个独立 B 来源也不得 medium（文档：medium 必须有 S/A）
    const twoB = {
      ...base,
      sourceTiers: ['B', 'B'],
      sources: [
        { url: 'https://a.example.com/r1', title: 'a' },
        { url: 'https://b.example.com/r2', title: 'b' }
      ]
    };
    assert.equal(deriveConfidence(twoB, policy), 'low');
    // 两个独立 A 来源 + spread<15 → high
    const twoA = {
      ...base,
      sourceTiers: ['A', 'A'],
      sources: [
        { url: 'https://a.example.com/r1', title: 'a' },
        { url: 'https://b.example.com/r2', title: 'b' }
      ]
    };
    assert.equal(deriveConfidence(twoA, policy), 'high');
    // A+B 两个独立来源 + 15%≤spread<20% → medium
    const ab = { ...base, valueHigh: 118, sourceTiers: ['A', 'B'], sources: twoB.sources };
    assert.equal(deriveConfidence(ab, policy), 'medium');
    // 同域名不同 URL 不虚增独立来源
    const sameHost = {
      ...twoA,
      sources: [
        { url: 'https://a.example.com/r1', title: 'a' },
        { url: 'https://a.example.com/r2', title: 'a2' }
      ]
    };
    assert.equal(countIndependentSources(sameHost), 1);
    assert.equal(deriveConfidence(sameHost, policy), 'low');
  });

  it('手工提供的置信度不能越级（capProvidedConfidence）', () => {
    assert.equal(capProvidedConfidence('high', { sourceTiers: ['B', 'B'] }), 'low');
    assert.equal(capProvidedConfidence('medium', { sourceTiers: ['B'] }), 'low');
    assert.equal(capProvidedConfidence('medium', { sourceTiers: ['A', 'B'] }), 'medium');
    assert.equal(capProvidedConfidence('high', { sourceTiers: ['C'] }), 'unknown');
  });

  it('方向置信度护栏：legacy 放行、枚举/ref/unknown 约束 fail-closed', () => {
    const asm = require(path.join(ROOT, 'analyze', 'v2', 'assemble-v2.cjs'));
    const packet = { price_data: { change5dPct: 0.66, volMultiplier: 1.1 }, volume_oi: { oiChange5dPct: 8.72 }, sector_context: { advanceRatio1d: 95.5 }, cost_anchor: { routes: [{ route: 'x', valueLow: 1, valueHigh: 2 }], problems: [] } };
    const valid = {
      symbol: 'SA0', direction: 'long', confidence: 'medium',
      q1_driver: { primary: '检修预期' },
      confidenceRationale: {
        supportingFactors: [
          { type: 'numeric', ref: 'volume_oi.oiChange5dPct', note: '增仓' },
          { type: 'text', ref: 'q1_driver', note: '检修' }
        ],
        opposingFactors: [{ type: 'numeric', ref: 'price_data.volMultiplier', note: '量能温和' }],
        uncertainties: ['检修未确认']
      }
    };
    assert.deepEqual(asm.validateConfidenceRationale(valid, packet).errors, []);
    // 旧 run 无 rationale → 放行
    const legacy = { symbol: 'SA0', direction: 'long', confidence: 'medium', q1_driver: { primary: 'x' } };
    assert.deepEqual(asm.validateConfidenceRationale(legacy, packet).errors, []);
    // 非法枚举 / unknown 却 high / numeric ref 不存在 / 支持反向都为空
    assert.match(asm.validateConfidenceRationale({ ...valid, confidence: 'high', q1_driver: { primary: 'unknown' } }, packet).errors.join('|'), /unknown 不得为 high/);
    assert.match(asm.validateConfidenceRationale({ ...valid, confidence: 'nope' }, packet).errors.join('|'), /invalid confidence/);
    const badRef = { ...valid, confidenceRationale: { ...valid.confidenceRationale, supportingFactors: [{ type: 'numeric', ref: 'price_data.nope', note: 'x' }], opposingFactors: [], uncertainties: [] } };
    assert.match(asm.validateConfidenceRationale(badRef, packet).errors.join('|'), /grounding failed/);
    const empty = { ...valid, confidenceRationale: { supportingFactors: [], opposingFactors: [], uncertainties: [] } };
    assert.match(asm.validateConfidenceRationale(empty, packet).errors.join('|'), /至少一侧非空/);
  });

  it('FinCoT costAnchorRef 必须 grounding 到 packet.cost_anchor 证据', () => {
    const asm = require(path.join(ROOT, 'analyze', 'v2', 'assemble-v2.cjs'));
    const packet = {
      cost_anchor: {
        recordId: 'SA0:r:1',
        routes: [{ route: '天然碱法', valueLow: 550, valueHigh: 679 }],
        valueLow: 550,
        valueHigh: 1554,
        problems: [{ code: 'multi_process_collapsed', detail: 'x' }],
        confidence: 'low',
        asOf: '2026-08'
      }
    };
    const ref = asm.buildCostAnchorRef(
      { symbol: 'SA0', costAnchorRef: { used: true, routeRefs: ['天然碱法'], evidenceIds: ['cost_anchor.routes', 'cost_anchor.problems'] } },
      packet
    );
    assert.equal(ref.error, null);
    assert.equal(ref.ref.recordId, 'SA0:r:1');
    assert.equal(ref.ref.problems[0], 'multi_process_collapsed');
    // used=true 但 packet 缺失
    assert.match(asm.buildCostAnchorRef({ symbol: 'SA0', costAnchorRef: { used: true, evidenceIds: ['cost_anchor.routes'] } }, {}).error, /cost_anchor 缺失/);
    // used=true 但 evidenceIds 为空
    assert.match(asm.buildCostAnchorRef({ symbol: 'SA0', costAnchorRef: { used: true, evidenceIds: [] } }, packet).error, /evidenceIds 为空/);
    // 引用不存在的字段 → grounding failed
    assert.match(asm.buildCostAnchorRef({ symbol: 'SA0', costAnchorRef: { used: true, evidenceIds: ['cost_anchor.nope'] } }, packet).error, /grounding failed/);
    // 未使用 → null
    assert.equal(asm.buildCostAnchorRef({ symbol: 'SA0', costAnchorRef: { used: false } }, packet).ref, null);
  });
});
