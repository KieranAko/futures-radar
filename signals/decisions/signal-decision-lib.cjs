// signals/decisions/signal-decision-lib.cjs — 人类信号决策契约
//
// dashboard 上的“采用新报价 / 维持旧单 / 暂停 / 关闭”会导出本契约 JSON；
// 由 signals/cli/signal-pool-decision-cli.cjs 回填到信号文件。
// 决策归人类；引擎只校验形式并执行记录。

'use strict';

const DECISION_SCHEMA = 'futures-radar-signal-decisions/1';
const DECISION_RECORD_SCHEMA = 'futures-radar-signal-decision-record/1';
const ACTIONS = ['adopt', 'keep', 'pause', 'close'];

function actionLabel(action) {
  return { adopt: '采用新报价', keep: '维持旧单', pause: '暂停信号', close: '关闭信号' }[action] || action;
}

function validateDecisionRecords(records) {
  const errors = [];
  if (!Array.isArray(records)) return { ok: false, errors: ['decisionRecords 必须为数组'] };
  records.forEach((r, i) => {
    if (!r || typeof r !== 'object') { errors.push(`decisionRecords[${i}] 必须是对象`); return; }
    if (r.schema && r.schema !== DECISION_RECORD_SCHEMA) errors.push(`decisionRecords[${i}].schema 非法`);
    if (!r.recordId) errors.push(`decisionRecords[${i}].recordId 缺失`);
    if (!r.signalId) errors.push(`decisionRecords[${i}].signalId 缺失`);
    if (!r.quoteVersionId) errors.push(`decisionRecords[${i}].quoteVersionId 缺失`);
    if (r.livingVersionIdBefore != null && typeof r.livingVersionIdBefore !== 'string') errors.push(`decisionRecords[${i}].livingVersionIdBefore 必须是字符串`);
    if (!ACTIONS.includes(r.action)) errors.push(`decisionRecords[${i}].action 必须是 ${ACTIONS.join('/')}`);
    if (typeof r.reason !== 'string' || !r.reason.trim()) errors.push(`decisionRecords[${i}].reason 必须是非空理由`);
  });
  return { ok: errors.length === 0, errors };
}

function validateDecisions(doc) {
  const errors = [];
  if (!doc || typeof doc !== 'object') return { ok: false, errors: ['决策文件必须是对象'] };
  if (doc.schema !== DECISION_SCHEMA) errors.push(`schema 必须为 ${DECISION_SCHEMA}`);
  if (!doc.runId || typeof doc.runId !== 'string') errors.push('runId 缺失');
  if (!Array.isArray(doc.decisions)) errors.push('decisions 必须为数组');
  else {
    const seen = new Set();
    doc.decisions.forEach((d, i) => {
      if (!d || typeof d !== 'object') { errors.push(`decisions[${i}] 必须是对象`); return; }
      if (!d.signalId) errors.push(`decisions[${i}].signalId 缺失`);
      if (!d.quoteVersionId) errors.push(`decisions[${i}].quoteVersionId 缺失`);
      if (!ACTIONS.includes(d.action)) errors.push(`decisions[${i}].action 必须是 ${ACTIONS.join('/')}`);
      if (typeof d.reason !== 'string' || !d.reason.trim()) errors.push(`decisions[${i}].reason 必须是非空理由`);
      const key = `${d.signalId}|${d.quoteVersionId}`;
      if (key !== '|' && seen.has(key)) errors.push(`decisions[${i}] 重复决策 ${key}`);
      if (key !== '|') seen.add(key);
      if (d.action === 'close' && d.closeReason && !['flipped', 'invalidated_q5', 'faded', 'expired', 'fulfilled'].includes(d.closeReason)) {
        errors.push(`decisions[${i}].closeReason 非法：${d.closeReason}`);
      }
    });
  }
  return { ok: errors.length === 0, errors };
}

module.exports = { DECISION_SCHEMA, DECISION_RECORD_SCHEMA, ACTIONS, validateDecisions, validateDecisionRecords, actionLabel };
