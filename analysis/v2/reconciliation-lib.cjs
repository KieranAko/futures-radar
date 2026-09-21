// analysis/v2/reconciliation-lib.cjs — 六问第二遍（审计追问后的最终综合）契约
//
// 设计：六问第二遍只对审计 LLM 标记为 conflict 的品种运行；
// 输入是少量冲突点 + 必要事实 id；输出是「修订增量」而不是整份六问重写。
// assemble-v2 把修订确定性合并回六问第一遍输出（原字段优先，修订字段覆盖），
// 并带 auditImpact 留痕。这保证链证据不污染六问第一遍，也只以最小剂量进入第二遍。
'use strict';

const path = require('node:path');
const { runDir } = require('../../shared/workspace.cjs');

const RECONCILIATION_SCHEMA = 'futures-radar-sixq-reconciliation/1';
const AUDIT_IMPACT_VALUES = ['none', 'revised_driver', 'revised_direction', 'kept_with_reasons'];
const REVISABLE_FIELDS = [
  'direction', 'confidence', 'passReason', 'q1_driver', 'q2_trendOrImpulse', 'q3_odds',
  'q4_confirmations', 'q5_invalidation', 'q6_eventRisk', 'confidenceRationale', 'mechanismRef', 'costAnchorRef',
];

function reconciliationPath(runId) {
  return path.join(runDir(runId), 'analyze', 'outputs-v2-reconciliation.json');
}

/**
 * 纯函数：校验修订增量（只验形态与枚举，不验语义）。
 * @param {object} doc
 * @param {string[]} symbols 允许出现的冲突品种集合
 */
function validateReconciliation(doc, { symbols = [] } = {}) {
  const errors = [];
  const symSet = new Set(symbols);
  if (!doc || doc.schema !== RECONCILIATION_SCHEMA) {
    errors.push(`schema 必须为 ${RECONCILIATION_SCHEMA}`);
    return { ok: false, errors };
  }
  if (!doc.runId || String(doc.runId).trim().length === 0) errors.push('runId 缺失');
  if (!Array.isArray(doc.revisions)) {
    errors.push('revisions 必须为数组');
    return { ok: false, errors };
  }
  const seen = new Set();
  for (const [i, r] of doc.revisions.entries()) {
    const tag = `revisions[${i}]`;
    if (!r || typeof r !== 'object') { errors.push(`${tag} 非对象`); continue; }
    if (!r.symbol || !symSet.has(r.symbol)) errors.push(`${tag}.symbol 缺失或不在冲突品种集合内`);
    else if (seen.has(r.symbol)) errors.push(`${tag}.symbol 重复: ${r.symbol}`);
    else seen.add(r.symbol);
    if (!AUDIT_IMPACT_VALUES.includes(r.auditImpact)) errors.push(`${tag}.auditImpact 必须为 ${AUDIT_IMPACT_VALUES.join('|')}`);
    if (!r.auditResponse || String(r.auditResponse).trim().length < 2) errors.push(`${tag}.auditResponse 缺失（须回应审计追问）`);
    const revs = r.revisions;
    if (revs !== undefined && (typeof revs !== 'object' || Array.isArray(revs))) errors.push(`${tag}.revisions 必须为对象`);
    const keys = revs && typeof revs === 'object' ? Object.keys(revs) : [];
    for (const k of keys) {
      if (!REVISABLE_FIELDS.includes(k)) errors.push(`${tag}.revisions.${k} 不在允许修订字段内`);
    }
    if (r.auditImpact === 'revised_driver' || r.auditImpact === 'revised_direction') {
      if (keys.length === 0) errors.push(`${tag}: auditImpact=${r.auditImpact} 时 revisions 至少修订一个字段`);
    }
    if (revs && revs.direction !== undefined && !['long', 'short', 'pass'].includes(revs.direction)) {
      errors.push(`${tag}.revisions.direction 必须为 long|short|pass`);
    }
    if (revs && revs.confidence !== undefined && !['high', 'medium', 'low'].includes(revs.confidence)) {
      errors.push(`${tag}.revisions.confidence 必须为 high|medium|low`);
    }
  }
  return { ok: errors.length === 0, errors };
}

module.exports = {
  RECONCILIATION_SCHEMA,
  AUDIT_IMPACT_VALUES,
  REVISABLE_FIELDS,
  reconciliationPath,
  validateReconciliation,
};
