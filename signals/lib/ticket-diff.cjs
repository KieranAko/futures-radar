// signals/lib/ticket-diff.cjs — 交易单结构化差异比较
//
// 定位：交易单是高度结构化的数据。本模块只做“差异发现”，不做判断：
//   - 完整字段级 diff（旧单 vs 新单）；
//   - 归类 aligned / refined / conflicted，仅用于展示与过滤；
//   - 冲突的实质解释交给对账 LLM，采纳与否交给人类分析师。
//
// 纪律：确定性、不联网、不调用 LLM。

'use strict';

const DIFF_SCHEMA = 'futures-radar-ticket-diff/1';
const RELATIONS = ['aligned', 'refined', 'conflicted'];

const FIELD_LABELS = {
  direction: '方向',
  confidence: '置信度',
  'entry.trigger': '触发条件',
  'entry.triggerLevel': '触发价',
  'entry.triggerSource': '触发价来源',
  'entry.triggerTiming': '确认时点',
  'entry.execution': '执行约定',
  'entry.gapThresholdPts': '偏离阈值',
  'entry.triggerStyle': '触发判定口径',
  'entry.triggerMode': '触发结构',
  'entry.entryZone.lower': '入场区间下沿',
  'entry.entryZone.upper': '入场区间上沿',
  'stop.stopPrice': '止损价',
  'stop.basis': '止损依据',
  'targets.t1': '目标1',
  'targets.t2': '目标2',
  'targets.basis': '目标依据',
  'invalidation.hard': '硬失效条件',
  'invalidation.timeStop': '时间止损',
  maxHoldingDays: '最长持有'
};

function pick(obj, path) {
  if (obj == null) return null;
  const parts = path.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return null;
    cur = cur[p];
  }
  return cur;
}

function fmtVal(v) {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.map((x) => (x == null ? '' : String(x))).join('；');
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

function valueChanged(a, b) {
  const fa = fmtVal(a);
  const fb = fmtVal(b);
  if (fa === fb) return false;
  if (Number.isFinite(Number(fa)) && Number.isFinite(Number(fb))) return Number(fa) !== Number(fb);
  return true;
}

function diffTicketFields(prev, next) {
  const changedFields = [];
  for (const path of Object.keys(FIELD_LABELS)) {
    const a = pick(prev, path);
    const b = pick(next, path);
    if (!valueChanged(a, b)) continue;
    changedFields.push({
      field: path,
      label: FIELD_LABELS[path],
      oldValue: fmtVal(a),
      newValue: fmtVal(b)
    });
  }
  return changedFields;
}

// 归类只做结构化判别：方向或触发结构变了 → conflicted；只有参数调整 → refined。
function relationOfDiff(prev, next, changedFields) {
  if (changedFields.length === 0) return 'aligned';
  const changed = new Set(changedFields.map((d) => d.field));
  if (changed.has('direction') || changed.has('entry.triggerMode')) return 'conflicted';
  // 方向未变但入场/止损的结构性矛盾交给对账 LLM 解释；此处仍标 refined，不替人判断。
  return 'refined';
}

function diffTickets(prev, next) {
  const changedFields = diffTicketFields(prev || {}, next || {});
  return {
    schema: DIFF_SCHEMA,
    relation: relationOfDiff(prev || {}, next || {}, changedFields),
    changedFields
  };
}

module.exports = {
  DIFF_SCHEMA,
  RELATIONS,
  FIELD_LABELS,
  diffTicketFields,
  relationOfDiff,
  diffTickets
};
