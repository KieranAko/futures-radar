// strategies/lib/family-infer.js — 机制来源族分类 v2（驱动优先，04-R1）
//
// v1（关键词规则）的缺陷：驱动文本含"趋势"就把产业驱动策略归入 momentum 族，
// 导致可信度标签与正文驱动叙事不同源。
// v2 规则：先按驱动机制归类（carry/value/event），只有无驱动线索时才按量价归 momentum。
//
// 规则（预注册式，修改须记录）：
//   carry    基差/贴水/升水/展期/期限结构/库存/现货/供给冲击/替代需求/季节性供需
//   value    价差/利润/成本传导/协整/均值回归/产业链
//   event    事件/政策/突发/冲击/避险/利率/美元/宏观/FOMC/地缘
//   momentum 趋势/动量/突破/均线/量能（仅当 carry/value/event 均未命中）
//   none     无匹配
'use strict';

function inferFamily(text) {
  const t = String(text || '');
  if (/基差|贴水|升水|展期|期限结构|库存|现货|供给冲击|替代需求|季节性|供需|套利收敛|carry/i.test(t)) return 'carry';
  if (/价差|利润|成本传导|协整|均值回归|产业链|value/i.test(t)) return 'value';
  if (/事件|政策|突发|冲击|避险|利率|美元|宏观|FOMC|地缘|央行|汇率|event|shock/i.test(t)) return 'event';
  if (/趋势|动量|突破|均线|量能|momentum|trend/i.test(t)) return 'momentum';
  return 'none';
}

// 族级证据分数：validated=3；g1 且有正向前瞻=2；g1/instance_gate_failed=1；其余=0
function familyScore(family, familyEvidence) {
  const f = familyEvidence && familyEvidence.families && familyEvidence.families[family];
  if (!f) return 0;
  if (f.level === 'validated') return 3;
  if (f.level === 'g1' && (f.previews || []).length) return 2;
  if (f.level === 'g1' || f.level === 'instance_gate_failed') return 1;
  return 0;
}

// 三层合成（P9/AD-10）：缺一层强制降档
function trustRating({ family, familyEvidence, match, fidelity }) {
  const fs = familyScore(family, familyEvidence);
  if (fs >= 3 && match === 2 && fidelity === 2) return { grade: 'A', why: '族级证据已验证 + 状态匹配 + 保真' };
  if (fs >= 2 && match >= 1 && fidelity >= 1) return { grade: 'B', why: '族级证据较强（状态匹配 unknown）' };
  if (fs >= 1) return { grade: 'C', why: '族级证据不足（该族历史验证未达标）' };
  return { grade: 'D', why: '无族级证据' };
}

module.exports = { inferFamily, familyScore, trustRating };
