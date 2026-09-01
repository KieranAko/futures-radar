// experiment-line/cost-anchor/extract.cjs — 把检索结果规范化为主档记录
// 输入来自研究执行（人工/代理）的 cost-anchor-research-results.json；
// 本模块只做字段规范化，不做真伪判断（validate.cjs 负责门禁）。
'use strict';

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {object} raw LLM/检索结果条目
 * @param {object} ctx { runId, signalDate }
 */
function normalizeResearchResult(raw, ctx) {
  if (raw && raw.status === 'unknown') {
    return {
      symbol: raw.symbol,
      anchorType: 'unknown',
      indicator: raw.indicator || '无可用成本锚',
      valueLow: null,
      valueHigh: null,
      unit: raw.unit || '元/吨',
      asOf: raw.asOf || ctx.signalDate,
      sourceDates: Array.isArray(raw.sourceDates) ? raw.sourceDates : [],
      sourceTiers: Array.isArray(raw.sourceTiers) ? raw.sourceTiers : [],
      sources: Array.isArray(raw.sources) ? raw.sources : [],
      confidence: 'unknown',
      reason: raw.reason || '未检索到带来源与日期的成本锚证据'
    };
  }
  return {
    symbol: raw.symbol,
    anchorType: raw.anchorType,
    indicator: raw.indicator,
    valueLow: toNumber(raw.valueLow),
    valueHigh: toNumber(raw.valueHigh),
    unit: raw.unit || '元/吨',
    asOf: raw.asOf,
    sourceDates: Array.isArray(raw.sourceDates) ? raw.sourceDates.map(String) : [],
    sourceTiers: Array.isArray(raw.sourceTiers) ? raw.sourceTiers.map(String) : [],
    sources: Array.isArray(raw.sources) ? raw.sources : [],
    confidence: raw.confidence || 'low',
    reason: raw.reason || null,
    structure: raw.structure || null,
    routes: Array.isArray(raw.routes) ? raw.routes.map((r) => ({
      route: r.route,
      status: r.status || 'known',
      valueLow: toNumber(r.valueLow),
      valueHigh: toNumber(r.valueHigh),
      unit: r.unit || raw.unit || '元/吨',
      sources: Array.isArray(r.sources) ? r.sources : []
    })) : undefined,
    missingRoutes: Array.isArray(raw.missingRoutes) ? raw.missingRoutes : undefined,
    fallbackRange: raw.fallbackRange ? {
      valueLow: toNumber(raw.fallbackRange.valueLow),
      valueHigh: toNumber(raw.fallbackRange.valueHigh),
      unit: raw.fallbackRange.unit || raw.unit || '元/吨'
    } : undefined,
    problems: Array.isArray(raw.problems) ? raw.problems : undefined,
    signalDate: ctx.signalDate
  };
}

module.exports = { normalizeResearchResult };
