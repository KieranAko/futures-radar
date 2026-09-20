// strategies/signal-backtest/pricing-layer-v8.cjs — V8 定价层（F1-F5 审计，只改机制不调参）
//
// 输入：生产 strategy-plan.json + V7 FinCoT + 证据行
// 输出：recordings/v7/pricing-layer-v8.json（每计划 effectiveExecutionStatus + 审计字段）
//
// F1 触发价必须落在锚点日可执行带（|trigger - close| ≤ 2×ATR5）
// F2 q4 类型与计划 triggerSource 类型必须一致
// F3 range/transition 不允许 breakout（只允许 pullback/stall）
// F5 breakout 必须有结构目标（前高/前低），不得用概率锥代理兜底
// F4 目标距离审计（只记录，不降级）
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = __dirname;
const V7 = path.join(ROOT, 'recordings', 'v7');
const PLAN_DIR = path.join(V7, 'strategy-plans');
const SYMBOLS = ['RB0', 'M0', 'SC0'];

function loadAll() {
  const out = [];
  for (const sym of SYMBOLS) {
    const evidence = JSON.parse(fs.readFileSync(path.join(V7, `evidence-${sym}.json`), 'utf8'));
    const fincot = JSON.parse(fs.readFileSync(path.join(V7, `fincot-v7-${sym}.json`), 'utf8'));
    const rowByDate = Object.fromEntries(evidence.rows.map(r => [r.d, r]));
    const finByDate = Object.fromEntries(fincot.entries.map(e => [e.anchorDate, e]));
    for (const date of Object.keys(rowByDate).sort()) {
      const planPath = path.join(PLAN_DIR, `${sym}-${date}.json`);
      if (!fs.existsSync(planPath)) continue;
      const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
      out.push({ symbol: sym, date, row: rowByDate[date], fin: finByDate[date], plan: plan.plans[0], planPath });
    }
  }
  return out;
}

function auditOne({ symbol, date, row, fin, plan, planPath }) {
  const original = plan.executionStatus;
  const reasons = [];
  const triggerLevel = plan.entry?.triggerLevel;
  const close = row.c;
  const atr5 = row.a5;

  // trigger 类型从生产 plan triggerSource 解析：BP-X:<type>@<level>
  const m = String(plan.entry?.triggerSource || '').match(/:(breakout|pullback|stall)@([0-9.]+)/);
  const triggerType = m ? m[1] : null;
  const sourceLevel = m ? parseFloat(m[2]) : null;

  // F1：触发价必须在锚点日可执行带内
  let f1BandAtr = null;
  if (triggerLevel != null && atr5 > 0) {
    f1BandAtr = Math.abs(triggerLevel - close) / atr5;
    if (f1BandAtr > 2) reasons.push('F1_trigger_outside_2ATR_band');
  }

  // F2：FinCoT q4 类型与计划触发类型一致
  const q4type = fin?.q?.q4_confirmation?.type || null;
  if (q4type && triggerType && q4type !== triggerType) reasons.push(`F2_q4_type_mismatch:${q4type}vs${triggerType}`);

  // F3：range/transition 不允许 breakout
  if ((fin?.regime === 'range' || fin?.regime === 'transition') && triggerType === 'breakout') reasons.push('F3_range_transition_breakout_forbidden');

  // F5：breakout 必须有结构目标（前高/前低），否则 watch
  const t1 = plan.targets?.t1 || '';
  const structuralTarget = /前高|前低/.test(t1);
  if (triggerType === 'breakout' && !structuralTarget) reasons.push('F5_breakout_without_structural_target');

  // F4：目标距离审计（只记录）
  let target1Atr = null; let target2Atr = null; let pricingBasis = plan.targets?.basis || '';
  if (triggerLevel != null && atr5 > 0) {
    const sign = plan.reportBaseline.direction === 'bullish' ? 1 : -1;
    const p68 = close + sign * 1.5 * atr5;
    const p95 = close + sign * 2 * atr5;
    if (/p68/.test(t1)) target1Atr = Math.abs(p68 - triggerLevel) / atr5;
    if (/p95/.test(plan.targets?.t2 || '')) target2Atr = Math.abs(p95 - triggerLevel) / atr5;
    if (/前高|前低|R 口径/.test(t1)) {
      const r = Math.abs(triggerLevel - plan.stop.stopPrice);
      const r2 = triggerLevel + sign * 2 * r;
      if (target1Atr == null) target1Atr = Math.abs(r2 - triggerLevel) / atr5;
    }
  }

  const effective = original === 'executable' && reasons.length === 0 ? 'executable' : (original === 'executable' ? 'watch' : original);
  return {
    symbol, date, originalExecutionStatus: original,
    effectiveExecutionStatus: effective,
    downgradeReasons: reasons,
    triggerType, q4type,
    triggerLevel, sourceLevel, close, atr5,
    f1BandAtr: f1BandAtr == null ? null : +f1BandAtr.toFixed(2),
    structuralTarget,
    target1Atr: target1Atr == null ? null : +target1Atr.toFixed(2),
    target2Atr: target2Atr == null ? null : +target2Atr.toFixed(2),
    pricingBasis,
    stopBasis: plan.stop?.basis || '',
    stopDistancePts: plan.stop?.stopDistancePts || null,
    planPath: planPath ? path.relative(ROOT, planPath) : ''
  };
}

function build() {
  const entries = loadAll().map(x => auditOne({ symbol: x.symbol, date: x.date, row: x.row, fin: x.fin, plan: x.plan, planPath: path.join(PLAN_DIR, `${x.symbol}-${x.date}.json`) }));
  const summary = {
    total: entries.length,
    executableOriginal: entries.filter(e => e.originalExecutionStatus === 'executable').length,
    executableEffective: entries.filter(e => e.effectiveExecutionStatus === 'executable').length,
    downgraded: entries.filter(e => e.originalExecutionStatus === 'executable' && e.effectiveExecutionStatus !== 'executable').map(e => ({ symbol: e.symbol, date: e.date, reasons: e.downgradeReasons })),
    reasonCounts: {}
  };
  for (const e of entries) for (const r of e.downgradeReasons) summary.reasonCounts[r] = (summary.reasonCounts[r] || 0) + 1;
  const out = { schema: 'futures-radar-pricing-layer-v8/1', generatedAt: new Date().toISOString(), summary, entries };
  fs.writeFileSync(path.join(V7, 'pricing-layer-v8.json'), JSON.stringify(out, null, 2), 'utf8');
  return out;
}

if (require.main === module) console.log(JSON.stringify(build(), null, 2));

module.exports = { loadAll, auditOne, build };
