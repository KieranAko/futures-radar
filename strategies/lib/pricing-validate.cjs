// strategies/lib/pricing-validate.cjs — 交易定价硬校验（v1）
//
// 五条硬校验中的后三条：
//   1) 入场距离现价 ≤1×ATR5（conditional-watch 除外）
//   2) 止损距离入场 ≤1.5×ATR5（conditional-watch 除外）
//   3) T1 盈亏比 ≥1.5R（conditional-watch 除外）
// 方向/置信度由 strategy-reasoning-validate 负责。
'use strict';

function parseFirstNumber(text) {
  if (!text) return null;
  const m = String(text).match(/(\d{2,}(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}

function validatePricing(reasoning, reportModel, probability) {
  const errors = [];
  const checks = [];
  if (!reasoning || !Array.isArray(reasoning.strategies)) {
    return { ok: false, errors: ['reasoning.strategies must be array'], checks };
  }
  const opps = new Map((reportModel?.opportunities || []).map((o) => [o.symbol, o]));
  const probs = new Map((probability?.probabilities || []).map((p) => [p.symbol, p]));
  const isConditional = (r) => ['conditional-watch', 'conditional'].includes(r.expression?.type);

  for (const r of reasoning.strategies) {
    const opp = opps.get(r.symbol);
    const prob = probs.get(r.symbol);
    if (!opp || !prob) { errors.push(`${r.symbol}: 缺少 report/probability 上下文`); continue; }
    const close = opp.marketFacts?.close;
    const atr5 = opp.priceRanges?.[0]?.atrBand?.atr5 ?? prob.atrComparison?.atr5;
    const entry = r.entry?.triggerLevel;
    const stop = r.stop?.stopPrice;
    const target1 = parseFirstNumber(r.targets?.t1);
    if (!Number.isFinite(close) || !Number.isFinite(atr5) || atr5 <= 0) {
      errors.push(`${r.symbol}: close/atr5 不可用，无法校验定价`);
      continue;
    }
    const entryDistAtr = Number.isFinite(entry) ? Math.abs(entry - close) / atr5 : null;
    const stopDistAtr = Number.isFinite(entry) && Number.isFinite(stop) ? Math.abs(entry - stop) / atr5 : null;
    const rr = Number.isFinite(entry) && Number.isFinite(stop) && Number.isFinite(target1) && Math.abs(entry - stop) > 0
      ? Math.abs(target1 - entry) / Math.abs(entry - stop)
      : null;
    const check = { symbol: r.symbol, entryDistAtr, stopDistAtr, rr, conditional: isConditional(r) };
    checks.push(check);

    if (isConditional(r)) continue;
    if (entryDistAtr != null && entryDistAtr > 1.0) {
      errors.push(`${r.symbol}: 入场距离现价 ${entryDistAtr.toFixed(2)}×ATR > 1.0×ATR，应为 conditional`);
    }
    if (stopDistAtr != null && stopDistAtr > 1.5) {
      errors.push(`${r.symbol}: 止损距离入场 ${stopDistAtr.toFixed(2)}×ATR > 1.5×ATR`);
    }
    if (rr != null && rr < 1.5) {
      errors.push(`${r.symbol}: T1 盈亏比 ${rr.toFixed(2)}R < 1.5R`);
    }
  }
  return { ok: errors.length === 0, errors, checks };
}

module.exports = { validatePricing, parseFirstNumber };
