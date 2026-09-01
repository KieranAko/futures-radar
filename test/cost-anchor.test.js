import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const EL = path.join(ROOT, 'experiment-line', 'cost-anchor');

const { loadPolicy, freshness, deriveConfidence } = require(path.join(EL, 'policy.cjs'));
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

  it('deriveConfidence 不信任单一来源', () => {
    const policy = loadPolicy();
    assert.equal(deriveConfidence({ sourceTiers: [], sourceDates: [] }, policy), 'unknown');
    assert.equal(deriveConfidence({ sourceTiers: ['B'], sourceDates: ['x'], valueLow: 100, valueHigh: 110 }, policy), 'low');
  });
});
