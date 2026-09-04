// strategies/lib/semantic-fact-validate.cjs — 语义事实校验（v1）
//
// 目标：校验 Strategy-LLM 的交易表达与价格位置事实一致。
// 不生成模板，只做事实比对：现价相对价值区的位置必须与 expression.type 匹配，
// 触发文案的第一动作词必须与 expression.type 匹配。不一致则要求重新生成。
'use strict';

const { computeNearTermStructure } = require('./near-term-structure.cjs');

const LONG_TYPES = ['breakout', 'pullback', 'confirmation', 'reclaim', 'conditional-watch'];
const SHORT_TYPES = ['breakdown', 'rally', 'confirmation', 'reclaim', 'conditional-watch'];

function parseNumber(text) {
  if (text == null) return null;
  const m = String(text).match(/(\d{2,}(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}

function positionOf(close, low, high) {
  if (!Number.isFinite(close) || !Number.isFinite(low) || !Number.isFinite(high)) return 'unknown';
  if (close < low) return 'below';
  if (close > high) return 'above';
  return 'inside';
}

function firstActionWord(text) {
  const s = String(text || '');
  if (/回踩/.test(s)) return 'pullback';
  if (/突破|站上/.test(s)) return 'breakout';
  if (/跌破/.test(s)) return 'breakdown';
  if (/确认|站稳/.test(s)) return 'confirmation';
  if (/观察|等待/.test(s)) return 'conditional-watch';
  return 'unknown';
}

function allowedTypesForPosition(direction, position) {
  if (direction === 'bullish') {
    if (position === 'above') return ['pullback', 'conditional-watch', 'breakout'];
    if (position === 'inside') return ['confirmation', 'breakout', 'conditional-watch'];
    if (position === 'below') return ['breakout', 'reclaim', 'conditional-watch'];
  } else {
    if (position === 'below') return ['rally', 'conditional-watch', 'breakdown'];
    if (position === 'inside') return ['confirmation', 'breakdown', 'conditional-watch'];
    if (position === 'above') return ['breakdown', 'reclaim', 'conditional-watch'];
  }
  return ['conditional-watch'];
}

function typeMatchesAction(type, action) {
  if (type === 'conditional-watch') return true;
  if (type === 'confirmation') return action === 'confirmation';
  if (type === 'pullback') return action === 'pullback';
  if (type === 'breakout') return action === 'breakout';
  if (type === 'breakdown') return action === 'breakdown';
  if (type === 'reclaim') return action === 'confirmation' || action === 'breakout';
  if (type === 'rally') return action === 'confirmation' || action === 'breakdown';
  return true;
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
    const type = r.expression?.type || 'conditional-watch';
    const action = firstActionWord(r.entry?.trigger);
    const direction = r.direction || opp.thesis?.finalDirection || 'bullish';
    const allowed = allowedTypesForPosition(direction, position);
    const check = { symbol: r.symbol, close, zoneLow, zoneHigh, position, type, action, allowed };
    checks.push(check);

    if (!allowed.includes(type)) {
      errors.push(`${r.symbol}: 现价 ${close} 相对价值区 [${zoneLow}, ${zoneHigh}] 为 ${position}，表达类型 ${type} 不匹配（允许：${allowed.join('/')}）`);
    }
    if (!typeMatchesAction(type, action)) {
      errors.push(`${r.symbol}: 表达类型 ${type} 与触发文案首动作词 ${action} 不一致`);
    }
  }
  return { ok: errors.length === 0, errors, checks };
}

/**
 * 校验 analyze outputs-v2 的 Q4 信号与近端位置事实一致。
 * 现价在价值区内时，多头 Q4 不得使用“回踩”；空头镜像。
 */
function validateQ4Semantics(outputs, packets) {
  const errors = [];
  const results = outputs?.results || [];
  for (const r of results) {
    const p = packets?.[r.symbol];
    const near = p?.near_term;
    if (!near || !p?.price_data) {
      errors.push(`${r.symbol}: 缺少 near_term/price_data，无法校验 Q4 语义`);
      continue;
    }
    const close = p.price_data.close;
    const position = positionOf(close, near.valueAreaLow, near.valueAreaHigh);
    if (position === 'unknown') continue;
    const dir = r.direction;
    if (dir === 'pass' || dir === 'neutral') continue;
    const signals = r.q4_confirmations?.signals || r.q4_confirmations?.signals || [];
    for (const signal of signals) {
      const action = firstActionWord(signal);
      if (dir === 'long' || dir === 'bullish') {
        if (action === 'pullback' && position !== 'above') {
          errors.push(`${r.symbol}: Q4 信号“${signal}”语义错误：现价在价值区${position === 'inside' ? '内' : '下方'}，不应使用“回踩”`);
        }
      } else if (dir === 'short' || dir === 'bearish') {
        if (action === 'rally' && position !== 'below') {
          errors.push(`${r.symbol}: Q4 信号“${signal}”语义错误：现价在价值区${position === 'inside' ? '内' : '上方'}，不应使用“反抽/回抽”`);
        }
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

module.exports = { validateSemanticFacts, validateQ4Semantics, positionOf, firstActionWord };
