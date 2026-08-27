// test/strategy-matcher.test.js — t8 单元测试
// 覆盖 t6 acceptance AC-1~AC-8 与 t7 契约 T-1~T-4：
// 库加载/校验、真实 run 复现（workedExample 关键值）、确定性、BASE-01 保底、
// 集中度仲裁、PB-02 禁用、schema 校验、数据纪律（无 OI 字段/无收益承诺）。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const matcher = require('../strategies/lib/strategy-matcher.cjs');
const {
  buildStrategyPlan,
  validateLibrary,
  validatePlan,
  riskScores,
  matchStrategies,
  selectPlaybook,
  arbitrateConcentration,
  applyGuarantee
} = matcher;
const skillRoot = path.resolve(import.meta.dirname, '..');
const libraryPath = path.join(skillRoot, 'strategies', 'strategy-library.json');
const schemaPath = path.join(skillRoot, 'report', 'strategy-plan.schema.json');
const RUN_ID = '20260827-1910-auto';

const library = JSON.parse(fs.readFileSync(libraryPath, 'utf8'));
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

function stripGenerated(plan) {
  const p = JSON.parse(JSON.stringify(plan));
  p.meta.generatedAt = null;
  return JSON.stringify(p);
}

describe('strategy-matcher: 库加载与校验', () => {
  it('strategy-library.json 可加载并通过结构校验', () => {
    const res = validateLibrary(library);
    assert.equal(res.ok, true, res.errors.join('; '));
  });
  it('库含 23 条策略（7 宏观 + 8 品类 + 8 执行），PB-02 默认禁用', () => {
    assert.equal(library.strategies.macro.length, 7);
    assert.equal(library.strategies.category.length, 8);
    assert.equal(library.strategies.execution.length, 8);
    const pb02 = library.strategies.execution.find(s => s.id === 'PB-02');
    assert.equal(pb02.defaultStatus, 'disabled');
  });
});

describe('strategy-matcher: 真实 run 复现（workedExample 关键值）', () => {
  const { plan } = buildStrategyPlan({ runId: RUN_ID });
  const bySym = Object.fromEntries(plan.plans.map(p => [p.symbol, p]));

  it('输出 3 个 plan（RM0/EG0/PX0，按第三章顺序）', () => {
    assert.deepEqual(plan.plans.map(p => p.symbol), ['RM0', 'EG0', 'PX0']);
  });

  it('AC-1: 每个 TOP3 matchedStrategies ≥ 1', () => {
    for (const p of plan.plans) assert.ok(p.matchedStrategies.length >= 1, p.symbol);
  });

  it('AC-2: plan 含 riskAssessment（15 键）与 executionStatus + statusReasons ≥1', () => {
    for (const p of plan.plans) {
      assert.equal(Object.keys(p.riskAssessment).length, 15, p.symbol);
      assert.ok(['executable', 'watch', 'skip'].includes(p.executionStatus));
      assert.ok(p.statusReasons.length >= 1);
    }
  });

  it('RM0：CS-06=5.0 / MS-06=3.0 / MS-01=2.0（div27×0.5），PB-07(pending)，executable 1 手', () => {
    const p = bySym.RM0;
    const scores = Object.fromEntries(p.matchedStrategies.map(m => [m.strategyId, m.score]));
    assert.equal(scores['CS-06'], 5);
    assert.equal(scores['MS-06'], 3);
    assert.equal(scores['MS-01'], 2);
    assert.equal(p.playbook.playbookId, 'PB-07');
    assert.equal(p.playbook.gateStatus, 'pending');
    assert.equal(p.executionStatus, 'executable');
    assert.equal(p.position.lots, 1);
    assert.equal(p.riskAssessment.stopPrice, 2275.1);
    assert.equal(p.riskAssessment.stopDistancePts, 72.9);
    assert.equal(p.riskAssessment.unitRiskCny, 729);
    assert.equal(p.riskAssessment.marginPerLotCny, 1878);
    assert.equal(p.riskAssessment.marginUtilizationPct, 1.88);
    assert.equal(p.riskAssessment.volContributionPctAnnual, 3.5);
    assert.equal(p.riskAssessment.stressRiskCny, 1174);
    assert.ok(p.statusReasons.some(r => r.includes('区间模型失稳 divergencePct=27')));
  });

  it('EG0：MS-02=2.25（riskOff=3，2 个 stale 锚点），PB-08(pending)，watch', () => {
    const p = bySym.EG0;
    const scores = Object.fromEntries(p.matchedStrategies.map(m => [m.strategyId, m.score]));
    assert.equal(scores['MS-02'], 2.25);
    assert.equal(p.playbook.playbookId, 'PB-08');
    assert.equal(p.playbook.gateStatus, 'pending');
    assert.equal(p.executionStatus, 'watch');
    assert.equal(p.position.lots, 0);
    assert.equal(p.riskAssessment.stopPrice, 5188.9);
    assert.equal(p.riskAssessment.stopDistancePts, 160.9);
    assert.ok(p.statusReasons.some(r => r.includes('风险预算不足')));
    assert.ok(p.statusReasons.some(r => r.includes('波动率分位 87.8≥85 且非 high 置信')));
    assert.ok(p.statusReasons.some(r => r.includes('尾部') && r.includes('-9.6%')));
  });

  it('PX0：MS-01=4.0 + MS-02=2.25，PB-08(pending)，watch（波动率目标否决）', () => {
    const p = bySym.PX0;
    const scores = Object.fromEntries(p.matchedStrategies.map(m => [m.strategyId, m.score]));
    assert.equal(scores['MS-01'], 4);
    assert.equal(scores['MS-02'], 2.25);
    assert.equal(p.playbook.playbookId, 'PB-08');
    assert.equal(p.playbook.gateStatus, 'pending');
    assert.equal(p.executionStatus, 'watch');
    assert.equal(p.riskAssessment.stopPrice, 8062);
    assert.equal(p.riskAssessment.stopDistancePts, 114);
    assert.ok(p.statusReasons.some(r => r.includes('波动率目标否决') && r.includes('11.6 万')));
    assert.ok(p.statusReasons.some(r => r.includes('尾部') && r.includes('-6.2%')));
  });

  it('t13-1: MS-01 证据串按方向取符号（bullish 用 >、bearish 用 <）', () => {
    const rm0 = bySym.RM0.matchedStrategies.find(m => m.strategyId === 'MS-01');
    const px0 = bySym.PX0.matchedStrategies.find(m => m.strategyId === 'MS-01');
    assert.ok(rm0.matchEvidence.includes('2348>MA20'), rm0.matchEvidence);
    assert.ok(px0.matchEvidence.includes('7948<MA20'), px0.matchEvidence);
    assert.ok(!/close 7948>MA20/.test(px0.matchEvidence), 'bearish 证据串不得出现 close X>MA20 形态');
  });

  it('t13-2: top-3 截断后的 ≥阈值落选者并入 supportingEvidence 并标注', () => {
    const rm0 = bySym.RM0;
    assert.ok(!rm0.matchedStrategies.some(m => m.strategyId === 'MS-07'));
    const overflow = rm0.supportingEvidence.find(s => s.strategyId === 'MS-07');
    assert.ok(overflow, 'MS-07 应并入 supportingEvidence');
    assert.ok(overflow.matchEvidence.includes('超出展示上限'), overflow.matchEvidence);
    assert.ok(overflow.score >= 1.5);
  });

  it('t13-3: 风控参数以 library.riskConfig 为权威（effectiveRiskConfig 归一）', () => {
    const eff = matcher.effectiveRiskConfig(library.riskConfig);
    assert.equal(eff.stopK.high, 2.0);
    assert.equal(eff.stopK.medium, 1.5);
    assert.deepEqual(eff.confidenceScale, { high: 1, medium: 0.75, low: 0 });
    assert.equal(eff.volPercentileWarn, 85);
    assert.equal(eff.volPercentileSkip, 95);
    assert.equal(eff.divergenceDegrade, 20);
    assert.equal(eff.riskPerTradePct, 0.01);
    assert.equal(eff.minRR, 1.5);
    assert.equal(eff.maxHoldingDays, 5);
  });

  it('t13-4: 执行条款按方向选择（bullish 不含空头专用约束）', () => {
    const rm0 = bySym.RM0;
    assert.ok(rm0.playbook.executionConvention.includes('多头距跌停'), rm0.playbook.executionConvention);
    assert.ok(!rm0.playbook.executionConvention.includes('空头距涨停'));
    const eg0 = bySym.EG0;
    assert.ok(eg0.playbook.executionConvention.includes('空头距涨停'), eg0.playbook.executionConvention);
    assert.ok(!eg0.playbook.executionConvention.includes('多头距跌停'));
  });

  it('watch 计划不省略策略适配内容（队长裁定）', () => {
    for (const p of [bySym.EG0, bySym.PX0]) {
      assert.ok(p.matchedStrategies.length >= 1);
      assert.ok(p.playbook.playbookId);
      assert.ok(p.entry.trigger.length > 0);
      assert.ok(p.invalidation.hard.length >= 1);
      assert.ok(p.statusReasons.length >= 1);
    }
  });

  it('schema 校验通过（t7 report/strategy-plan.schema.json）', () => {
    const res = validatePlan(plan, schema);
    assert.equal(res.ok, true, res.errors.join('; '));
  });

  it('AC-7: PB-02 绝不出现；数据纪律：plan 不含 OI 字段与收益承诺', () => {
    for (const p of plan.plans) assert.notEqual(p.playbook.playbookId, 'PB-02');
    const plansStr = JSON.stringify(plan.plans);
    assert.ok(!plansStr.includes('openInterest'));
    assert.ok(!plansStr.includes('avgOI'));
    // 免责声明自带否定表述（“不含任何收益承诺或预期收益”），收益承诺断言需剔除声明文本后检查
    const bodyStr = plan.plans.map(p => JSON.stringify({ ...p, disclaimer: '' })).join('');
    assert.ok(!/年化收益|预期收益|目标收益|胜率|稳赚|保本/.test(bodyStr));
  });

  it('免责声明存在且含不构成投资建议', () => {
    assert.ok(plan.disclaimer.includes('不构成投资建议'));
    assert.ok(plan.disclaimer.includes('不执行真实交易'));
  });
});

describe('strategy-matcher: 确定性', () => {
  it('AC-3: 同输入两次运行输出一致（忽略 generatedAt）', () => {
    const a = buildStrategyPlan({ runId: RUN_ID }).plan;
    const b = buildStrategyPlan({ runId: RUN_ID }).plan;
    assert.equal(stripGenerated(a), stripGenerated(b));
  });
});

describe('strategy-matcher: BASE-01 保底与集中度仲裁', () => {
  it('AC-1 fallback: 全策略未命中 → BASE-01 补足一条', () => {
    const fakeCtx = {
      rm: {
        sector: 'precious',
        thesis: { finalDirection: 'neutral', driver: { primary: '', secondary: '' }, odds: { reasoning: '' }, confirmations: { signals: [] }, trendOrImpulse: { assessment: '' } }
      },
      sectorSnapshot: { sectors: { precious: { direction: 'flat', advanceRatio1d: 10 } } },
      sectorDriver: { sectors: {} },
      probEntry: {},
      macroIndicators: {}
    };
    const ind = { close: 100, ma20: 100, ma60: 100, ema20Slope: 0, high20: 100, low20: 100, volumeRatio: 1, change5d: 0, change1d: 0, trToday: 1, nr7: false };
    const formulas = { riskScores: riskScores({}), quadrantConflict: false };
    const { matched } = matchStrategies(library, fakeCtx, ind, formulas);
    const eff = applyGuarantee(matched);
    assert.equal(eff.length, 1);
    assert.equal(eff[0].strategyId, 'BASE-01');
  });

  it('AC-5: 集中度仲裁——同板块同向两个 executable 恰保留一个，另一个 watch+集中度冲突', () => {
    const mk = (symbol, confidence, rrDist, stopDist, rank) => ({
      symbol, rank, sector: 'energy_chemical',
      reportBaseline: { direction: 'bearish', confidence },
      riskAssessment: { stopDistancePts: stopDist },
      _rrT2Distance: rrDist,
      executionStatus: 'executable',
      position: { lots: 1 },
      statusReasons: []
    });
    const plans = [mk('EG0', 'medium', 251.5, 160.9, 2), mk('PX0', 'medium', 254.5, 114, 3)];
    const decisions = arbitrateConcentration(plans);
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].keptSymbol, 'PX0'); // RR 更高者保留
    const eg0 = plans.find(p => p.symbol === 'EG0');
    assert.equal(eg0.executionStatus, 'watch');
    assert.equal(eg0.position.lots, 0);
    assert.ok(eg0.statusReasons.some(r => r.includes('集中度冲突')));
    const px0 = plans.find(p => p.symbol === 'PX0');
    assert.equal(px0.executionStatus, 'executable');
  });

  it('AC-7: PB-02 禁用——pairsWith 仅含 PB-02 时不选中', () => {
    const fakeCtx = {
      rm: { thesis: { finalDirection: 'bullish', driver: { primary: '无事件' }, confirmations: { signals: [] } }, priceRanges: [{ divergence: { pct: 10 }, atrBand: { atr5: 10 } }], marketFacts: { hv: { percentile90d: 50 } } },
      probEntry: { cone: { '3d': { p68: [90, 110], p95: [80, 120] } } },
      sectorSnapshot: { sectors: {} }, sectorDriver: { sectors: {} }
    };
    const ind = { close: 100, ma20: 95, ma60: 90, ema20Slope: 0.005, high20: 105, low20: 85, volumeRatio: 1.2, change5d: 1, change1d: 1, trToday: 1, nr7: false };
    const matched = [{ strategyId: 'MS-01', pairsWith: ['PB-02', 'PB-01'] }];
    const sel = selectPlaybook(library, matched, fakeCtx, ind);
    assert.notEqual(sel.playbookId, 'PB-02');
    assert.equal(sel.playbookId, 'PB-01');
  });
});

describe('strategy-matcher: 无网络/LLM 依赖（静态检查）', () => {
  it('源码不含网络与随机调用', () => {
    const src = fs.readFileSync(path.join(skillRoot, 'strategies', 'lib', 'strategy-matcher.cjs'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''); // 去注释后检查
    assert.ok(!/https?:\/\//.test(code));
    assert.ok(!/Math\.random/.test(code));
    assert.ok(!/fetch\(|XMLHttpRequest|http\.request|https\.request/.test(code));
  });
});
