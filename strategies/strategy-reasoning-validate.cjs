// strategies/strategy-reasoning-validate.cjs — Strategy-LLM 输出校验
//
// 只做结构性 + 逻辑一致性校验（置信度不高于报告、理论缺口说明等）。
// 不校验“理论是否正确”——理论只作软参照，允许 approximate/none。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { runDir } = require('../lib/workspace.cjs');

const CONF_LEVEL = { high: 3, medium: 2, low: 1 };
const THEORY_FIT = ['aligned', 'approximate', 'none'];
const EXPRESSION_TYPES = ['breakout', 'confirmation', 'pullback', 'event-confirmation', 'conditional-watch'];

function readJSON(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function confLte(a, b) {
  return (CONF_LEVEL[a] || 0) <= (CONF_LEVEL[b] || 0);
}

function validateStrategyReasoning(reasoning, reportModel) {
  const errors = [];
  if (!reasoning || typeof reasoning !== 'object') return { ok: false, errors: ['reasoning is not an object'] };
  if (!Array.isArray(reasoning.strategies) || reasoning.strategies.length === 0) {
    errors.push('strategies must be a non-empty array');
    return { ok: false, errors };
  }
  const opps = new Map((reportModel?.opportunities || []).map((o) => [o.symbol, o]));
  for (const r of reasoning.strategies) {
    const opp = opps.get(r.symbol);
    if (!opp) { errors.push(`${r.symbol}: 不在报告 TOP3 机会中`); continue; }
    const reportConf = opp.thesis?.finalConfidence || 'low';
    const stratConf = r.strategyConfidence || 'low';
    if (!CONF_LEVEL[stratConf]) errors.push(`${r.symbol}: invalid strategyConfidence ${stratConf}`);
    if (!confLte(stratConf, reportConf)) {
      errors.push(`${r.symbol}: strategyConfidence ${stratConf} 高于报告置信度 ${reportConf}`);
    }
    if (!THEORY_FIT.includes(r.theoryFit)) errors.push(`${r.symbol}: theoryFit 必须为 ${THEORY_FIT.join('/')}`);
    if (r.theoryFit === 'none' || r.theoryFit === 'approximate') {
      if (!r.theoryGapNote || !String(r.theoryGapNote).trim()) {
        errors.push(`${r.symbol}: theoryFit=${r.theoryFit} 时必须给出 theoryGapNote`);
      }
    }
    if (r.theoryFit === 'none') {
      if (!Array.isArray(r.confidenceDowngradeReasons) || r.confidenceDowngradeReasons.length === 0) {
        errors.push(`${r.symbol}: theoryFit=none 时必须给出 confidenceDowngradeReasons`);
      }
    }
    if (!EXPRESSION_TYPES.includes(r.expression?.type)) {
      errors.push(`${r.symbol}: expression.type 必须为 ${EXPRESSION_TYPES.join('/')}`);
    }
    if (!r.entry || !r.stop || !r.targets) {
      errors.push(`${r.symbol}: 必须包含 entry/stop/targets`);
    }
    if (opp.thesis && opp.thesis.finalDirection !== undefined) {
      // 报告方向只读校验：reasoning 不应携带与报告不同的方向
      if (r.direction && r.direction !== opp.thesis.finalDirection) {
        errors.push(`${r.symbol}: direction 与报告 finalDirection 不一致`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--runId');
  const runId = i >= 0 ? args[i + 1] : null;
  if (!runId) throw new Error('--runId required');
  const dir = runDir(runId);
  const reasoning = readJSON(path.join(dir, 'strategy-reasoning.json'));
  if (!reasoning) {
    console.error('strategy-reasoning.json not found');
    process.exit(1);
  }
  const reportModel = readJSON(path.join(dir, 'report-model.json'));
  const result = validateStrategyReasoning(reasoning, reportModel);
  if (!result.ok) {
    console.error('strategy-reasoning-validate FAILED:');
    for (const e of result.errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log(`strategy-reasoning-validate ok (${reasoning.strategies.length} strategies)`);
  return result;
}

if (require.main === module) main();
module.exports = { validateStrategyReasoning, CONF_LEVEL };
