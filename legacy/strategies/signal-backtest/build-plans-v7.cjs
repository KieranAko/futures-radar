// strategies/signal-backtest/build-plans-v7.cjs — V7 T2 确定性计划模板（无 LLM）
//
// 输入：recordings/v7/fincot-v7-<SYM>.json + evidence 行 + reasoning-blueprints/blueprints.json
// 输出：recordings/v7/plans-v7-<SYM>.json（FinCoT 蓝图模板适配）
// 纪律：T2 是确定性模板，不做数值调参；LLM 只存在于 T1 FinCoT。
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = __dirname;

function buildPlans(symbol) {
  const fin = JSON.parse(fs.readFileSync(path.join(ROOT, 'recordings', 'v7', `fincot-v7-${symbol}.json`), 'utf8'));
  const evidence = JSON.parse(fs.readFileSync(path.join(ROOT, 'recordings', 'v7', `evidence-${symbol}.json`), 'utf8'));
  const bps = JSON.parse(fs.readFileSync(path.join(ROOT, 'reasoning-blueprints', 'blueprints.json'), 'utf8')).blueprints;
  const rowByDate = Object.fromEntries(evidence.rows.map(r => [r.d, r]));
  const anchors = fin.entries.map(e => {
    const row = rowByDate[e.anchorDate];
    const bp = bps[e.blueprintId] || bps['BP-TREND'];
    const tpl = bp.planTemplate;
    if (e.direction === 'neutral') {
      return {
        date: e.anchorDate, direction: 'neutral', confidence: e.confidence, regime: e.regime,
        edge: null, triggerType: null, triggerAtrMult: null, stopAtrMult: null, targetR: null,
        maxHoldDays: null, pullbackLevel: null, invalidationLevel: null,
        qualityFlags: [], macroBias: e.macroSupport, sectorBias: e.sectorSupport, eventRisk: e.eventRisk,
        executionStatus: 'watch', blueprintId: e.blueprintId,
        finCotAlignment: 'aligned', finCotMode: e.mode, finCotReusedFrom: e.reusedFrom || null,
        thesis: `FinCoT neutral（${e.q.q1_driver.text}）`, driver: '无方向', rationale: e.q.q1_driver.text,
        invalidationReason: e.q.q5_invalidation.reason || '无', contextRefs: [], finCotRefs: []
      };
    }
    const triggerType = tpl.triggerType === 'pullback' ? 'pullback' : 'breakout';
    const q4Level = e.q.q4_confirmation.level;
    const pullbackLevel = triggerType === 'pullback' ? q4Level : null;
    const riskExec = e.q.q6_risk.riskExecution || { positionScale: 1, weekendRule: 'hold', maxAdverseExcursionR: 1.0 };
    const contextRefs = [...new Set([...(e.q.q1_driver.evidenceRefs || []), ...(e.q.q2_trend.structureRefs || [])])];
    return {
      date: e.anchorDate,
      direction: e.direction,
      confidence: e.confidence,
      regime: e.regime,
      edge: e.edge,
      triggerType,
      triggerAtrMult: triggerType === 'breakout' ? tpl.triggerAtrMult : null,
      stopAtrMult: tpl.stopAtrMult,
      targetR: tpl.targetR,
      maxHoldDays: tpl.timeStopDays,
      pullbackLevel,
      invalidationLevel: e.q.q5_invalidation.level,
      qualityFlags: [],
      macroBias: e.macroSupport,
      sectorBias: e.sectorSupport,
      eventRisk: e.eventRisk,
      executionStatus: 'executable',
      blueprintId: e.blueprintId,
      riskExecution: riskExec,
      exitManagement: { timeStopDays: tpl.timeStopDays, breakevenAfterR: tpl.breakevenAfterR, trailingAfterR: tpl.trailingAfterR, invalidationExit: true },
      finCotAlignment: 'aligned',
      finCotMode: e.mode,
      finCotReusedFrom: e.reusedFrom || null,
      finCotRefs: ['q4', 'q5', 'q6', ...(e.q.q1_driver.evidenceRefs || []).slice(0, 2)],
      contextRefs,
      thesis: `${bp.name}蓝图：${e.q.q1_driver.text}`,
      driver: e.q.q1_driver.text,
      rationale: `thinking=${e.thinking}; selfCheck=${JSON.stringify(e.selfCheck)}`,
      invalidationReason: e.q.q5_invalidation.reason,
      q4Confirmation: { level: q4Level, levelType: e.q.q4_confirmation.levelType, type: e.q.q4_confirmation.type }
    };
  });
  return {
    schema: 'futures-radar-signal-plan-v7/1',
    arm: 'C',
    symbol,
    generatedAt: new Date().toISOString(),
    note: 'T2 确定性模板：蓝图默认执行参数 + FinCoT 结构化字段，无 LLM 数值生成',
    anchors
  };
}

function buildAll() {
  const manifest = { schema: 'futures-radar-signal-plan-v7-manifest/1', generatedAt: new Date().toISOString(), symbols: [] };
  for (const sym of ['RB0', 'M0', 'SC0']) {
    const plan = buildPlans(sym);
    const p = path.join(ROOT, 'recordings', 'v7', `plans-v7-${sym}.json`);
    fs.writeFileSync(p, JSON.stringify(plan, null, 2), 'utf8');
    manifest.symbols.push({ symbol: sym, path: path.relative(ROOT, p), anchors: plan.anchors.length });
  }
  fs.writeFileSync(path.join(ROOT, 'recordings', 'v7', 'plans-v7-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return manifest;
}

if (require.main === module) console.log(JSON.stringify(buildAll(), null, 2));

module.exports = { buildPlans, buildAll };
