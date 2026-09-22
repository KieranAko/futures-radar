// signals/reconciliation/ticket-reconciliation-lib.cjs — 交易单对账结果契约
//
// 对账 LLM 的定位：只发现差异、解释冲突，辅助人类快速理解；不判胜负、不改单。
// 输出为解释性文本，挂到信号版本（quote）上，由 dashboard 展示。
//
// 纪律：确定性校验（引擎侧）；解释内容由 LLM 写。

'use strict';

const RECONCILIATION_SCHEMA = 'futures-radar-ticket-reconciliation/1';

const SEVERITIES = ['info', 'attention', 'conflict'];

function validateReconciliation(doc) {
  const errors = [];
  if (!doc || typeof doc !== 'object') return { ok: false, errors: ['对账结果必须是对象'] };
  if (doc.schema !== RECONCILIATION_SCHEMA) errors.push(`schema 必须为 ${RECONCILIATION_SCHEMA}`);
  if (!doc.runId || typeof doc.runId !== 'string') errors.push('runId 缺失');
  if (!Array.isArray(doc.signals)) errors.push('signals 必须为数组');
  else {
    const seen = new Set();
    doc.signals.forEach((s, i) => {
      if (!s || typeof s !== 'object') { errors.push(`signals[${i}] 必须是对象`); return; }
      if (!s.signalId) { errors.push(`signals[${i}].signalId 缺失`); return; }
      if (seen.has(s.signalId)) { errors.push(`signals[${i}] 重复 signalId=${s.signalId}`); return; }
      seen.add(s.signalId);
      if (!Array.isArray(s.quotes)) errors.push(`${s.signalId}.quotes 必须为数组`);
      else {
        s.quotes.forEach((q, j) => {
          if (!q || !q.versionId) { errors.push(`${s.signalId}.quotes[${j}].versionId 缺失`); return; }
          if (typeof q.summary !== 'string' || !q.summary.trim()) errors.push(`${s.signalId}.quotes[${j}].summary 必须是非空解释文字`);
          if (!Array.isArray(q.conflicts)) errors.push(`${s.signalId}.quotes[${j}].conflicts 必须为数组`);
          else {
            q.conflicts.forEach((c, k) => {
              if (!c || typeof c !== 'object') { errors.push(`${s.signalId}.quotes[${j}].conflicts[${k}] 必须是对象`); return; }
              if (!c.field) errors.push(`${s.signalId}.quotes[${j}].conflicts[${k}].field 缺失`);
              if (typeof c.explanation !== 'string' || !c.explanation.trim()) errors.push(`${s.signalId}.quotes[${j}].conflicts[${k}].explanation 必须是非空解释文字`);
              if (!SEVERITIES.includes(c.severity)) errors.push(`${s.signalId}.quotes[${j}].conflicts[${k}].severity 必须是 ${SEVERITIES.join('/')}`);
            });
          }
        });
      }
    });
  }
  return { ok: errors.length === 0, errors };
}

module.exports = { RECONCILIATION_SCHEMA, SEVERITIES, validateReconciliation };
