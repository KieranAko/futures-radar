// analysis/strategy/ticket-elements.cjs — 交易单要素（录入员产物）
//
// 角色分工（契约）：
//   - 交易员（LLM）：对六问结论做交易判断，输出自然语言交易单；
//   - 录入员（LLM）：把交易单原样拆成要素，不补、不改、不解释；
//   - 构造器（本模块 + strategy-matcher）：只做存在性校验、数字绑定与含糊追问，
//     不做确认方式的分类，也不把交易员文本机械复制进计划。
//
// 要素字段本身是“交易单上写了什么”，而不是“机器规定交易员必须怎么写”。
// 边界原则：判断与文字归 LLM；引擎只做数值读取、算术与数值校验，不生成/拼接策略句子。

'use strict';

const ELEMENTS_SCHEMA = 'futures-radar-strategy-elements/1';

const DIRECTIONS = ['bullish', 'bearish', 'neutral'];

function firstNumber(text) {
  if (text == null) return null;
  const m = String(text).match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

function parseMaxHoldDays(text) {
  if (text == null) return null;
  const s = String(text);
  const tn = s.match(/T\+\s*(\d{1,2})/);
  if (tn) return Number(tn[1]);
  const dn = s.match(/(\d{1,2})\s*个?交易日/);
  if (dn) return Number(dn[1]);
  return null;
}

// 机械保真检查：数字必须原样出现在交易单原文里（不判断语义，只做字符串匹配）。
function containsNumberInText(text, value) {
  if (text == null || !Number.isFinite(value)) return false;
  const v = String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^0-9.])${v}([^0-9.]|$)`).test(String(text));
}

function requiredString(el, key, errors, label) {
  if (el == null || typeof el[key] !== 'string' || !String(el[key]).trim()) {
    errors.push(`${label || key} 缺失：录入员未从交易单中拆出该要素`);
    return null;
  }
  return String(el[key]).trim();
}

// 触发语义：从交易员自然语言识别验证引擎需要的执行原语（不做展示分类）。
function triggerModeOf(el) {
  const s = `${el && el.activation || ''} ${el && el.confirmation || ''}`;
  if (/反抽|回踩|回抽|不破/.test(s)) return 'pullback';
  if (/突破|跌破|站上|站回|站稳/.test(s)) return 'breakout';
  return null;
}

// 结构校验：只查“该有的要素在不在”，不查“写得好不好”。
function validateElements(elements) {
  const errors = [];
  if (!elements || elements.schema !== ELEMENTS_SCHEMA) {
    return { ok: false, errors: [`schema 必须为 ${ELEMENTS_SCHEMA}`] };
  }
  if (!Array.isArray(elements.tickets) || elements.tickets.length === 0) {
    return { ok: false, errors: ['tickets 必须为非空数组'] };
  }
  const seen = new Set();
  for (const t of elements.tickets) {
    if (!t || typeof t !== 'object') {
      errors.push('ticket 必须是对象');
      continue;
    }
    if (!t.symbol || seen.has(t.symbol)) {
      errors.push(`ticket.symbol 缺失或重复：${t && t.symbol}`);
    }
    if (t.symbol) seen.add(t.symbol);
    if (!DIRECTIONS.includes(t.direction)) errors.push(`${t.symbol || '?'}: direction 必须是 ${DIRECTIONS.join('/')}`);
    requiredString(t, 'activation', errors, `${t.symbol || '?'}: activation`);
    requiredString(t, 'confirmation', errors, `${t.symbol || '?'}: confirmation`);
    requiredString(t, 'entry', errors, `${t.symbol || '?'}: entry`);
    requiredString(t, 'note', errors, `${t.symbol || '?'}: note`);
    if (!t.stop || typeof t.stop !== 'object' || t.stop.level == null || !Number.isFinite(Number(t.stop.level))) {
      errors.push(`${t.symbol || '?'}: stop.level 缺失或不是数字（交易单必须给出止损价）`);
    } else {
      requiredString(t.stop, 'basis', errors, `${t.symbol || '?'}: stop.basis`);
    }
    if (!t.targets || typeof t.targets !== 'object' || !String(t.targets.t1 || '').trim()) {
      errors.push(`${t.symbol || '?'}: targets.t1 缺失（交易单必须给出第一目标）`);
    }
    if (!t.targets || typeof t.targets !== 'object' || !String(t.targets.t2 || '').trim()) {
      errors.push(`${t.symbol || '?'}: targets.t2 缺失（交易单必须给出第二目标）`);
    }
    if (!Array.isArray(t.invalidation) || t.invalidation.length === 0) {
      errors.push(`${t.symbol || '?'}: invalidation 缺失（交易单必须写清逻辑作废条件）`);
    }
    if (t.direction !== 'neutral') {
      const abandon = requiredString(t, 'abandon', errors, `${t.symbol || '?'}: abandon`);
      if (abandon && firstNumber(abandon) == null) {
        errors.push(`${t.symbol || '?'}: abandon 必须给出具体点数（如 偏离 >X 放弃），不允许只写公式或空泛表述`);
      }
      if (!t.entryZone || typeof t.entryZone !== 'object'
        || !Number.isFinite(Number(t.entryZone.lower)) || !Number.isFinite(Number(t.entryZone.upper))) {
        errors.push(`${t.symbol || '?'}: entryZone 缺失或 lower/upper 不是数字（交易单必须写明入场执行区间）`);
      } else {
        requiredString(t.entryZone, 'lowerBasis', errors, `${t.symbol || '?'}: entryZone.lowerBasis`);
        requiredString(t.entryZone, 'upperBasis', errors, `${t.symbol || '?'}: entryZone.upperBasis`);
      }
    }
    const maxHoldDays = parseMaxHoldDays(t.maxHold);
    if (!Number.isFinite(maxHoldDays) || maxHoldDays < 1 || maxHoldDays > 10) {
      errors.push(`${t.symbol || '?'}: maxHold 必须写成 T+N 交易日且 N 在 1–10 之间（交易单必须给出最长持有时间）`);
    }
    if (t.direction !== 'neutral') {
      const mode = triggerModeOf(t);
      if (!mode) {
        errors.push(`${t.symbol || '?'}: activation 无法识别触发语义（应为反抽/回踩不破或突破/跌破类，供验证引擎执行）`);
      }
    }
    // 录入员保真：拆出的数字必须能在交易单原文（note）里找到，找不到就回问，不给修正值。
    const note = typeof t.note === 'string' ? t.note : '';
    const checkNumberInNote = (value, label) => {
      if (value == null || !Number.isFinite(Number(value))) return;
      if (!containsNumberInText(note, Number(value))) {
        errors.push(`${t.symbol || '?'}: ${label} ${Number(value)} 在交易单原文（note）中找不到，录入员不得改写或补充数字`);
      }
    };
    checkNumberInNote(t.activationLevel, 'activationLevel');
    if (t.stop && typeof t.stop === 'object') checkNumberInNote(t.stop.level, 'stop.level');
    if (t.entryZone && typeof t.entryZone === 'object') {
      checkNumberInNote(t.entryZone.lower, 'entryZone.lower');
      checkNumberInNote(t.entryZone.upper, 'entryZone.upper');
    }
    const abandonPts = firstNumber(t.abandon);
    if (abandonPts != null) checkNumberInNote(abandonPts, 'abandon 点数');
    if (Number.isFinite(maxHoldDays) && !new RegExp(`T\\+\\s*${maxHoldDays}`).test(note)) {
      errors.push(`${t.symbol || '?'}: maxHold 的 T+${maxHoldDays} 在交易单原文（note）中找不到，录入员不得改写或补充数字`);
    }
  }
  return { ok: errors.length === 0, errors };
}

function elementForSymbol(elements, symbol) {
  if (!elements || !Array.isArray(elements.tickets)) return null;
  return elements.tickets.find((t) => t && t.symbol === symbol) || null;
}

// 要素 → plan.entry 的编译：从交易员的多个要素拼出计划字段，而不是复制一段文本。
function entryFromElements(el) {
  const activationLevel = Number.isFinite(Number(el.activationLevel)) ? Number(el.activationLevel) : firstNumber(el.activation);
  const triggerParts = [String(el.activation || '').trim()];
  if (el.confirmation) triggerParts.push(`确认：${String(el.confirmation).trim()}`);
  const executionParts = [String(el.entry || '').trim()];
  if (el.abandon) executionParts.push(String(el.abandon).trim());
  return {
    trigger: triggerParts.filter(Boolean).join('；'),
    triggerLevel: activationLevel,
    triggerSource: [el.activationSource, el.activationQuote].filter(Boolean).join(' / ') || String(el.activation || '').trim(),
    triggerTiming: String(el.confirmation || '').trim(),
    execution: executionParts.filter(Boolean).join('；'),
    triggerMode: triggerModeOf(el),
    entryZone: el.entryZone && typeof el.entryZone === 'object' ? {
      lower: Number(el.entryZone.lower),
      upper: Number(el.entryZone.upper),
      lowerBasis: String(el.entryZone.lowerBasis || '').trim(),
      upperBasis: String(el.entryZone.upperBasis || '').trim()
    } : null
  };
}

// 绑定检查：数字必须落在冻结数据近端价位附近，或录入员已给出来源。
// 绑不上就回问交易员，不允许构造器自己猜一个价位。
function bindCheck(el, reportOpp) {
  const issues = [];
  const near = reportOpp && reportOpp.marketFacts ? reportOpp.marketFacts : null;
  const candidates = [];
  if (near) {
    if (Number.isFinite(Number(near.pdh))) candidates.push({ label: 'near_term.pdh', value: Number(near.pdh) });
    if (Number.isFinite(Number(near.pdl))) candidates.push({ label: 'near_term.pdl', value: Number(near.pdl) });
    if (Number.isFinite(Number(near.valueAreaHigh))) candidates.push({ label: 'near_term.valueAreaHigh', value: Number(near.valueAreaHigh) });
    if (Number.isFinite(Number(near.valueAreaLow))) candidates.push({ label: 'near_term.valueAreaLow', value: Number(near.valueAreaLow) });
  }
  const pr = reportOpp && Array.isArray(reportOpp.priceRanges) ? reportOpp.priceRanges[0] : null;
  if (pr && pr.hvCone) {
    for (const side of ['p68', 'p95']) {
      const cone = pr.hvCone[side];
      if (Array.isArray(cone)) {
        for (let i = 0; i < cone.length; i++) {
          if (Number.isFinite(Number(cone[i]))) candidates.push({ label: `priceRanges[0].hvCone.${side}[${i}]`, value: Number(cone[i]) });
        }
      }
    }
  }
  const level = Number(el.activationLevel);
  const source = String(el.activationSource || '').trim();
  if (!Number.isFinite(level)) {
    issues.push(`激活价缺失：交易单里没写清楚策略生效的具体价位（activationLevel 无法提取）`);
    return { ok: false, issues };
  }
  if (!source && candidates.length === 0) {
    issues.push(`激活价 ${level} 没有来源：请交易员补充该价位来自哪个冻结数据（PDH/PDL/价值区/概率区间）`);
    return { ok: false, issues };
  }
  if (!source) {
    const atr = pr && pr.atrBand && Number.isFinite(Number(pr.atrBand.atr5)) ? Number(pr.atrBand.atr5) : null;
    const tol = atr && atr > 0 ? atr * 0.35 : Math.max(Math.abs(level) * 0.02, 5);
    const hit = candidates.find((c) => Math.abs(c.value - level) <= tol);
    if (!hit) {
      issues.push(`激活价 ${level} 与冻结近端价位都对不上（容差 ${tol.toFixed(1)}），请交易员确认价位或补充来源`);
    }
  }
  // 组合算术校验（只验不修）：入场执行区间必须与止损/触发价自洽。
  const stopLevel = el.stop && Number.isFinite(Number(el.stop.level)) ? Number(el.stop.level) : null;
  const r2 = (x) => Math.round(x * 100) / 100;
  const zone = el.entryZone && typeof el.entryZone === 'object' ? el.entryZone : null;
  if (zone && stopLevel != null && el.direction !== 'neutral') {
    const lower = Number(zone.lower);
    const upper = Number(zone.upper);
    if (Number.isFinite(lower) && Number.isFinite(upper)) {
      if (!(lower < upper)) {
        issues.push(`入场区间下沿 ${r2(lower)} 必须小于上沿 ${r2(upper)}，请交易员改单`);
      }
      if (el.direction === 'bearish' && upper > stopLevel) {
        issues.push(`空单入场区间上沿 ${r2(upper)} 高于止损 ${r2(stopLevel)}，入场价不得高于止损，请交易员改单`);
      }
      if (el.direction === 'bullish' && lower < stopLevel) {
        issues.push(`多单入场区间下沿 ${r2(lower)} 低于止损 ${r2(stopLevel)}，入场价不得低于止损，请交易员改单`);
      }
      if (level < lower || level > upper) {
        issues.push(`触发价 ${r2(level)} 不在入场区间 [${r2(lower)}, ${r2(upper)}] 内，请交易员确认区间与触发条件一致`);
      }
    }
  } else if (!zone) {
    // 旧要素没有 entryZone 时，保留对称偏离带检查（legacy 兼容）。
    const abandonPts = firstNumber(el.abandon);
    if (stopLevel != null && abandonPts != null && abandonPts > 0) {
      if (el.direction === 'bearish' && level + abandonPts > stopLevel) {
        issues.push(`空单偏离带上沿 ${r2(level + abandonPts)}（=${r2(level)}+${r2(abandonPts)}）高于止损 ${r2(stopLevel)}，按偏离条款可能以高于止损的价格入场，交易单自相矛盾，请交易员改单`);
      } else if (el.direction === 'bullish' && level - abandonPts < stopLevel) {
        issues.push(`多单偏离带下沿 ${r2(level - abandonPts)}（=${r2(level)}−${r2(abandonPts)}）低于止损 ${r2(stopLevel)}，按偏离条款可能以低于止损的价格入场，交易单自相矛盾，请交易员改单`);
      }
    }
  }
  return { ok: issues.length === 0, issues };
}

// 含糊追问：构造器把问题用自然语言交回给交易员，而不是硬失败或默默改。
function askBackMessage(elements, errors) {
  const lines = [];
  lines.push('# 交易单要素回问');
  lines.push('');
  lines.push('录入员已把交易单拆成要素，但构造器无法把以下要素绑定到可执行计划。');
  lines.push('请交易员按下面的问题修订交易单，再由录入员重新拆要素。');
  lines.push('');
  for (const e of errors) lines.push(`- ${e}`);
  if (elements && Array.isArray(elements.tickets)) {
    lines.push('');
    lines.push('## 原始交易单');
    lines.push('');
    for (const t of elements.tickets) {
      lines.push(`### ${t.symbol || '?'} ${t.direction || ''}`);
      if (t.note) lines.push(t.note);
      lines.push('');
    }
  }
  return lines.join('\n');
}

module.exports = {
  ELEMENTS_SCHEMA,
  DIRECTIONS,
  validateElements,
  elementForSymbol,
  entryFromElements,
  bindCheck,
  askBackMessage,
  firstNumber,
  parseMaxHoldDays,
  triggerModeOf
};
