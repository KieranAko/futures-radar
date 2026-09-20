// strategies/signal-backtest/runner-v7.cjs — V7 试点回测（FinCoT 蓝图 + T2 模板 + v6.1 安全执行）
//
// 本轮：最近 10 锚点 × RB0/M0/SC0。
//   T1：FinCoT 蓝图推理（recordings/v7/fincot-v7-*.json，blueprint/thinking/output/selfCheck）
//   T2：确定性模板计划（recordings/v7/plans-v7-*.json）
//   L3：复用 runner-v6-1 安全执行引擎（G1 作用域/G2 结构化确认位/G3-G5）
// 对照：同 10 锚点上 v5 原引擎 C 臂 与 v6.1 C 臂。
'use strict';

const fs = require('fs');
const path = require('path');
const { simulateSafeArm, aggregateSafe } = require('./runner-v6-1.cjs');

const ROOT = __dirname;
const V7 = path.join(ROOT, 'recordings', 'v7');
const OUT_DIR = path.join(ROOT, 'output');
const SYMBOLS = ['RB0', 'M0', 'SC0'];
const LAST10 = ['2026-06-11', '2026-06-18', '2026-06-26', '2026-07-03', '2026-07-10', '2026-07-17', '2026-07-24', '2026-07-31', '2026-08-07', '2026-08-14'];

const round = (v, d = 4) => (v == null || !isFinite(v) ? v : Math.round(v * Math.pow(10, d)) / Math.pow(10, d));
const loadJSON = p => JSON.parse(fs.readFileSync(p, 'utf8'));

function loadV7Plans(symbol) {
  const plan = loadJSON(path.join(V7, `plans-v7-${symbol}.json`));
  const evidence = loadJSON(path.join(V7, `evidence-${symbol}.json`));
  const rowByDate = Object.fromEntries(evidence.rows.map(r => [r.d, r]));
  return plan.anchors.map(p => ({
    ...p,
    anchorDate: p.date,
    q4Numbers: p.q4Confirmation ? [p.q4Confirmation.level] : [],
    anchorRow: rowByDate[p.date] || null
  }));
}

function tableMd(title, headers, rows) {
  const L = [`## ${title}`, '', `| ${headers.join(' | ')} |`, `|${headers.map(() => '---').join('|')}|`];
  for (const r of rows) L.push(`| ${r.join(' | ')} |`);
  L.push('');
  return L;
}

function main() {
  const signals = [];
  let totalPlans = 0; let executablePlans = 0; let gateSkipped = 0;
  const reasons = [];
  for (const sym of SYMBOLS) {
    const sim = simulateSafeArm('C', sym, loadV7Plans(sym));
    signals.push(...sim.signals);
    totalPlans += sim.totalPlans; executablePlans += sim.executablePlans; gateSkipped += sim.gateSkipped;
    reasons.push(...sim.gateReasons);
  }
  const agg = aggregateSafe(signals);

  // 对照：同 10 锚点上的 v5 与 v6.1 C 臂
  const v5 = loadJSON(path.join(OUT_DIR, 'signal-quality-baseline-v5.json'));
  const v61 = loadJSON(path.join(OUT_DIR, 'signal-quality-baseline-v6-1.json'));
  const subset = (all, arm) => aggregateSafe(all.signals[arm].filter(s => LAST10.includes(s.anchorDate)));
  const oldV5 = subset(v5, 'C');
  const oldV61 = subset(v61, 'C');

  // 闸门成本：v7 被闸信号在 v5 原引擎下的反事实
  let cfTrades = 0; let savedPnl = 0; let costPnl = 0; let correct = 0;
  for (const gated of signals.filter(s => s.status === 'gate_skipped')) {
    const v5t = v5.signals.C.find(x => x.status === 'verified' && x.symbol === gated.symbol && x.signalDate === gated.signalDate);
    if (!v5t) continue;
    cfTrades++;
    if (v5t.directionCorrect) correct++;
    if (v5t.pnlPct < 0) savedPnl += -v5t.pnlPct; else costPnl += v5t.pnlPct;
  }
  const skippedCF = { gated: gateSkipped, v5Trades: cfTrades, correct, savedPnl: round(savedPnl, 2), costPnl: round(costPnl, 2), netBenefit: round(savedPnl - costPnl, 2) };

  // FinCoT 统计
  const fincotStats = { fresh: 0, reused: 0, blueprints: {} };
  for (const sym of SYMBOLS) {
    const fin = loadJSON(path.join(V7, `fincot-v7-${sym}.json`));
    for (const e of fin.entries) {
      fincotStats[e.mode]++;
      fincotStats.blueprints[e.blueprintId] = (fincotStats.blueprints[e.blueprintId] || 0) + 1;
    }
  }

  const falsification = [
    `C-v7（10 锚点）：${agg.verifiedCount} 笔成交，方向正确率 ${agg.directionCorrectRate}%，毛 ${agg.avgPnlPct}% / 净 ${agg.avgNetPnlPct}%；闸跳过 ${gateSkipped}，其中 v5 反事实成交 ${cfTrades} 笔，saved ${skippedCF.savedPnl}% / cost ${skippedCF.costPnl}%。`,
    `对照（同 10 锚点）：v5 原引擎 ${oldV5.verifiedCount} 笔 ${oldV5.directionCorrectRate}%（${oldV5.avgPnlPct}%）；v6.1 ${oldV61.verifiedCount} 笔 ${oldV61.directionCorrectRate}%（${oldV61.avgPnlPct}%）。`,
    `FinCoT 统计：fresh ${fincotStats.fresh}、reused ${fincotStats.reused}；蓝图分布 ${JSON.stringify(fincotStats.blueprints)}。`,
    '本轮仍为 inSample 试点（10 锚点曾参与 v5/v6 校准），只验证框架可运行，不作为策略证据。riskExecution 已记录但本引擎仍固定 1 手。'
  ];

  const report = {
    schema: 'futures-radar-signal-backtest/7',
    meta: {
      generatedAt: new Date().toISOString(),
      arm: 'C',
      universe: SYMBOLS,
      anchorsPerSymbol: 10,
      anchorDates: LAST10,
      engine: 'v6.1-safe + FinCoT-blueprints',
      inSample: true,
      costPerTradeR: 0.25,
      barsSource: 'data-store daily merged（500 bars）'
    },
    aggregate: agg,
    comparison: { v5C: oldV5, v61C: oldV61 },
    skippedCF,
    fincotStats,
    gateReasons: reasons,
    falsification,
    signals: signals.map(s => ({
      symbol: s.symbol, anchorDate: s.anchorDate, signalDate: s.signalDate, status: s.status,
      direction: s.direction, confidence: s.confidence, regime: s.regime, edge: s.edge, triggerType: s.triggerType,
      blueprintId: s.blueprintId, macroBias: s.macroBias, sectorBias: s.sectorBias, eventRisk: s.eventRisk,
      finCotMode: s.finCotMode, blueprintId: s.blueprintId, riskExecution: s.riskExecution, exitManagement: s.exitManagement, gateReasons: s.gateReasons || [], lintWarnings: s.lintWarnings || [],
      triggerLevel: s.triggerLevel, stopPrice: s.stopPrice, target1Level: s.target1Level,
      entryDate: s.entryDate, entryPrice: s.entryPrice, exitDate: s.exitDate, exitPrice: s.exitPrice,
      exitType: s.exitType, directionCorrect: s.directionCorrect, pnlPct: s.pnlPct, costPct: s.costPct, netPnlPct: s.netPnlPct,
      mfePct: s.mfePct, maePct: s.maePct, invalidationApplicable: s.invalidationApplicable
    }))
  };
  const jsonPath = path.join(OUT_DIR, 'signal-quality-baseline-v7.json');
  const mdPath = path.join(OUT_DIR, 'signal-quality-baseline-v7.md');
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');

  const L = ['# 信号质量回测基线 V7（FinCoT 蓝图 + 模板计划 + 安全执行）', '',
    '> 本轮：10 锚点 × RB0/M0/SC0。T1 FinCoT 蓝图推理 → T2 确定性模板计划 → L3 v6.1 安全执行引擎。', ''];
  L.push(...tableMd('V7 C 臂 vs 同窗口 v5/v6.1', ['版本', '信号', '成交', '方向正确率', '毛盈亏', '净盈亏(0.25R)', '闸跳过'], [
    ['v5 原引擎', oldV5.signalCount, oldV5.verifiedCount, `${oldV5.directionCorrectRate}%`, `${oldV5.avgPnlPct}%`, '-', 0],
    ['v6.1', oldV61.signalCount, oldV61.verifiedCount, `${oldV61.directionCorrectRate}%`, `${oldV61.avgPnlPct}%`, `${oldV61.avgNetPnlPct}%`, oldV61.gateSkippedCount],
    ['v7', agg.signalCount, agg.verifiedCount, `${agg.directionCorrectRate}%`, `${agg.avgPnlPct}%`, `${agg.avgNetPnlPct}%`, agg.gateSkippedCount]
  ]));
  L.push(...tableMd('V7 闸门成本', ['闸跳过', 'v5 反事实成交', 'savedPnl', 'costPnl', '净收益'], [[gateSkipped, cfTrades, `${skippedCF.savedPnl}%`, `${skippedCF.costPnl}%`, `${skippedCF.netBenefit}%`]]));
  L.push(...tableMd('V7 FinCoT 统计', ['fresh', 'reused', '蓝图分布'], [[fincotStats.fresh, fincotStats.reused, JSON.stringify(fincotStats.blueprints)]]));
  L.push('## 证伪结论', '');
  for (const line of falsification) L.push(`- ${line}`);
  L.push('');
  fs.writeFileSync(mdPath, `${L.join('\n')}\n`, 'utf8');

  console.log(JSON.stringify({ meta: report.meta, aggregate: report.aggregate, comparison: report.comparison, skippedCF: report.skippedCF, fincotStats: report.fincotStats, falsification: report.falsification, jsonPath, mdPath }, null, 2));
}

if (require.main === module) main();

module.exports = { loadV7Plans, main };
