// analysis/strategy/semantic-fact-validate.cjs — 语义事实校验（v1）
//
// 权威错位修复（SR-B-001/SR-B-002）：
// 表达类型与触发文案的语义判断归 LLM；本模块只做数值事实比对
// （现价相对价值区的位置），不再用正则/决策表替 LLM 决定
// expression.type 或触发措辞，也不再因此打回 LLM。
// 上下文缺失仍 fail-closed（结构校验）。
'use strict';

const { computeNearTermStructure } = require('./near-term-structure.cjs');

function positionOf(close, low, high) {
  if (!Number.isFinite(close) || !Number.isFinite(low) || !Number.isFinite(high)) return 'unknown';
  if (close < low) return 'below';
  if (close > high) return 'above';
  return 'inside';
}

function deriveSignalDate(raw) {
  let latest = null;
  for (const c of Object.values(raw?.contracts || {})) {
    const dates = c?.ohlcv?.dates;
    if (Array.isArray(dates) && dates.length) {
      const last = dates[dates.length - 1];
      if (!latest || last > latest) latest = last;
    }
  }
  return latest;
}

function validateSemanticFacts(reasoning, reportModel, raw) {
  const errors = [];
  const checks = [];
  if (!reasoning || !Array.isArray(reasoning.strategies)) {
    return { ok: false, errors: ['reasoning.strategies must be array'], checks };
  }
  const signalDate = deriveSignalDate(raw);
  const opps = new Map((reportModel?.opportunities || []).map((o) => [o.symbol, o]));

  for (const r of reasoning.strategies) {
    const opp = opps.get(r.symbol);
    const contract = raw?.contracts?.[r.symbol];
    const o = contract?.ohlcv;
    if (!opp || !o || !Array.isArray(o.dates)) {
      errors.push(`${r.symbol}: 缺少 report/raw 上下文`);
      continue;
    }
    const bars = o.dates.map((date, i) => ({ date, open: o.open[i], high: o.high[i], low: o.low[i], close: o.close[i] }));
    const near = computeNearTermStructure(bars, signalDate);
    if (!near) {
      errors.push(`${r.symbol}: 近端结构不可用`);
      continue;
    }
    const close = opp.marketFacts?.close ?? near.close;
    const zoneLow = near.valueAreaLow;
    const zoneHigh = near.valueAreaHigh;
    const position = positionOf(close, zoneLow, zoneHigh);
    // 位置是冻结事实，仅供诊断与下游参考；表达类型与措辞是否一致由 LLM 自检。
    checks.push({ symbol: r.symbol, close, zoneLow, zoneHigh, position });
  }
  return { ok: errors.length === 0, errors, checks };
}

/**
 * 校验 analyze outputs-v2 的 Q4 信号上下文可用性（结构校验）。
 * 语义是否与价格位置一致由 LLM selfCheck 负责，不再用正则替 LLM 判断。
 */
function validateQ4Semantics(outputs, packets) {
  const errors = [];
  const results = outputs?.results || [];
  for (const r of results) {
    const p = packets?.[r.symbol];
    const near = p?.near_term;
    if (!near || !p?.price_data) {
      errors.push(`${r.symbol}: 缺少 near_term/price_data，无法校验 Q4 事实上下文`);
    }
  }
  return { ok: errors.length === 0, errors };
}

module.exports = { validateSemanticFacts, validateQ4Semantics, positionOf };
