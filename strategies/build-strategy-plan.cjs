#!/usr/bin/env node
// strategies/build-strategy-plan.cjs — t8 CLI：生成 strategy-plan.json
//
// 用法:
//   node strategies/build-strategy-plan.cjs --runId 20260827-1910-auto [--equity 100000]
//
// 输出:
//   output/runs/<runId>/strategy-plan.json（按 t7 契约 + report/strategy-plan.schema.json 校验）
//
// 确定性：同 runId 同 artifacts 两次运行输出逐字节一致（meta.generatedAt 由输入派生）。
// FORBIDDEN: 不联网、不调用 LLM、不新增数据源。

'use strict';

const fs = require('fs');
const path = require('path');
const { skillRoot, runDir } = require('../lib/workspace.cjs');
const { buildStrategyPlan, validatePlan } = require('./lib/strategy-matcher.cjs');
const { recordPlans, verifyIncremental } = require('./lib/feedback.cjs');

const args = process.argv.slice(2);
function flagVal(flag) {
  const i = args.indexOf(flag);
  return i === -1 ? null : args[i + 1];
}

const runId = flagVal('--runId');
if (!runId) {
  console.error('FATAL: --runId required');
  process.exit(1);
}
const equityCny = flagVal('--equity') ? Number(flagVal('--equity')) : 100000;
if (!Number.isFinite(equityCny) || equityCny <= 0) {
  console.error('FATAL: --equity must be a positive number');
  process.exit(1);
}

const { plan, schema } = buildStrategyPlan({ runId, equityCny });

// 自检：按 t7 schema 机械校验（t8 acceptance：schema 完整、字段可校验）
const check = validatePlan(plan, schema);
if (!check.ok) {
  console.error('strategy-plan.json schema validation FAILED:');
  for (const e of check.errors) console.error('  - ' + e);
  process.exit(1);
}

const outPath = path.join(runDir(runId), 'strategy-plan.json');
fs.writeFileSync(outPath, JSON.stringify(plan, null, 2) + '\n', 'utf8');

// 证伪反馈闭环：冻结本期全部策略（executable/watch/skip）；只对非终态往期记录做增量验证
const recorded = recordPlans(plan);
const rawPath = path.join(runDir(runId), 'raw.json');
const raw = fs.existsSync(rawPath) ? JSON.parse(fs.readFileSync(rawPath, 'utf8')) : { contracts: {} };
const feedback = verifyIncremental(runId, raw);
feedback.meta.recordedThisRun = recorded;
fs.writeFileSync(path.join(runDir(runId), 'strategy-feedback.json'), JSON.stringify(feedback, null, 2) + '\n', 'utf8');

const lines = plan.plans.map(p =>
  `  ${p.rank}. ${p.symbol} ${p.name} | ${p.reportBaseline.direction}/${p.reportBaseline.confidence} | 主策略 ${p.matchedStrategies[0].strategyId} | ${p.playbook.playbookId}(${p.playbook.gateStatus}) | ${p.executionStatus} ${p.position.lots}手`
);
console.log(`Output: ${outPath}`);
console.log(`Plans: ${plan.plans.length} | concentrationDecisions: ${plan.concentrationDecisions.length} | inputsSha: ${plan.meta.inputsSha.slice(0, 12)}…`);
console.log(`Feedback: recorded ${recorded} plan(s) for falsification; incremental verified ${feedback.meta.incrementalAttempted} pending record(s)`);
console.log(lines.join('\n'));
