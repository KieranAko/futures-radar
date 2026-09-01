// experiment-line/cost-anchor/validate.cjs — 确定性门禁（theory-base/05 §五）
//
// 两类错误：
//   - 合法性错误（无来源/无日期/未来数据）→ fail-closed，拒绝入主档；
//   - 结构性异常（区间过宽/多工艺合并/缺失路线/仅B级来源）→ fail-visible，
//     保留数据并写入 problems[]，报告必须展示，不得拒绝输出。
'use strict';

const { loadPolicy, deriveConfidence } = require('./policy.cjs');

const REQUIRED_LEGAL = ['anchorType', 'indicator', 'unit', 'asOf', 'sourceDates', 'sourceTiers'];
const ALLOWED_CONFIDENCE = ['high', 'medium', 'low', 'unknown'];
const ALLOWED_TYPES = ['extraction', 'processing_margin', 'import_parity', 'production_cost', 'none', 'unknown'];

function rangeWidthPct(lo, hi) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= 0) return null;
  return ((hi - lo) / hi) * 100;
}

function problem(code, detail) {
  return { code, detail };
}

/**
 * 结构评估：只标记问题，不拒绝记录。
 */
function assessStructure(record, policy) {
  const problems = [];
  const maxWidth = policy.validation && policy.validation.maxMeaningfulRangeWidthPct
    ? policy.validation.maxMeaningfulRangeWidthPct
    : 30;
  const routes = Array.isArray(record.routes) ? record.routes : null;
  record.structure = routes && routes.length > 0 ? 'route_curve' : 'single_range';

  if (routes && routes.length > 0) {
    const known = routes.filter((r) => r && r.status !== 'unknown' && r.route);
    const unknownRoutes = routes.filter((r) => r && r.status === 'unknown').map((r) => r.route);
    if (known.length === 0) problems.push(problem('missing_routes', 'routes 均为 unknown，无可用分工艺数值'));
    if (record.fallbackRange) {
      problems.push(problem('multi_process_collapsed', `存在 routes，但仍携带合并区间 fallbackRange [${record.fallbackRange.valueLow}, ${record.fallbackRange.valueHigh}]`));
    }
    if (unknownRoutes.length > 0) {
      problems.push(problem('missing_routes', `缺失工艺路线: ${unknownRoutes.join(',')}`));
    }
    // 每一条已知路线自身宽度也暴露，而不是拒绝
    for (const r of known) {
      const w = rangeWidthPct(r.valueLow, r.valueHigh);
      if (w != null && w > maxWidth) {
        problems.push(problem('range_width_pct', `route ${r.route} 宽度 ${w.toFixed(1)}% > ${maxWidth}%`));
      }
    }
  } else if (record.confidence !== 'unknown') {
    const width = rangeWidthPct(record.valueLow, record.valueHigh);
    if (width != null && width > maxWidth) {
      problems.push(problem('range_width_pct', `单区间宽度 ${width.toFixed(1)}% > ${maxWidth}%`));
      if (record.anchorType === 'processing_margin' || /工艺|分工艺|路线/.test(String(record.indicator || ''))) {
        problems.push(problem('multi_process_collapsed', '区间疑似跨多条工艺成本带，但未按 route 拆分'));
      }
      problems.push(problem('fallback_range_only', '仅有合并区间，无 routes 拆分'));
    }
    if (Array.isArray(record.missingRoutes) && record.missingRoutes.length > 0) {
      problems.push(problem('missing_routes', `缺失工艺路线: ${record.missingRoutes.join(',')}`));
    }
  }

  const tiers = Array.isArray(record.sourceTiers) ? record.sourceTiers : [];
  if (tiers.length > 0 && !tiers.some((t) => t === 'S' || t === 'A')) {
    problems.push(problem('source_tier_only_b', `来源层级仅有 ${[...new Set(tiers)].join('/')}，无 S/A 级来源`));
  }

  record.problems = problems;
  return record;
}

function validateRecord(record, signalDate, policy = loadPolicy()) {
  const errors = [];
  if (!record || typeof record !== 'object') return { ok: false, errors: ['record is not an object'], record: null };

  for (const k of REQUIRED_LEGAL) {
    if (record[k] === undefined || record[k] === null || record[k] === '') errors.push(`missing ${k}`);
  }
  if (!ALLOWED_TYPES.includes(record.anchorType)) errors.push(`invalid anchorType ${record.anchorType}`);
  if (!Array.isArray(record.sourceDates) || record.sourceDates.length === 0) errors.push('sourceDates must be non-empty array');
  if (!Array.isArray(record.sourceTiers) || record.sourceTiers.length === 0) errors.push('sourceTiers must be non-empty array');
  if (!ALLOWED_CONFIDENCE.includes(record.confidence)) errors.push(`invalid confidence ${record.confidence}`);

  const asOf = String(record.asOf || '').slice(0, 10);
  if (asOf && signalDate && asOf > signalDate) errors.push(`asOf ${asOf} > signalDate ${signalDate}`);

  const routes = Array.isArray(record.routes) && record.routes.length > 0 ? record.routes : null;
  if (record.confidence !== 'unknown' && !routes) {
    if (!Number.isFinite(record.valueLow) || !Number.isFinite(record.valueHigh)) errors.push('valueLow/valueHigh must be finite numbers');
    else if (record.valueLow > record.valueHigh) errors.push('valueLow > valueHigh');
  }
  if (routes) {
    for (const r of routes) {
      if (!r || !r.route) errors.push('each route needs route name');
      if (r.status !== 'unknown') {
        if (!Number.isFinite(r.valueLow) || !Number.isFinite(r.valueHigh)) errors.push(`route ${r && r.route}: valueLow/valueHigh must be finite`);
        else if (r.valueLow > r.valueHigh) errors.push(`route ${r && r.route}: valueLow > valueHigh`);
      }
    }
  }
  if (record.fallbackRange) {
    if (!Number.isFinite(record.fallbackRange.valueLow) || !Number.isFinite(record.fallbackRange.valueHigh)) {
      errors.push('fallbackRange values must be finite');
    }
  }

  if (record.sources && Array.isArray(record.sources)) {
    for (const s of record.sources) {
      if (!s || !s.url || !s.title) errors.push('source entries need title+url');
    }
  }

  if (errors.length > 0) return { ok: false, errors, record: null };

  if (!record.confidence) record.confidence = deriveConfidence(record, policy);
  assessStructure(record, policy);
  // 结构性异常不拒绝，但置信度不得超过 low（暴露给报告）
  if (record.problems.length > 0 && !['low', 'unknown'].includes(record.confidence)) {
    record.confidence = 'low';
  }
  return { ok: true, errors, record };
}

function validateResearchBatch(results, symbols, signalDate) {
  const out = { ok: true, errors: [], records: {} };
  for (const sym of symbols) {
    const raw = (results || []).find((r) => r.symbol === sym);
    if (!raw) {
      out.ok = false;
      out.errors.push(`${sym}: no research result`);
      continue;
    }
    const check = validateRecord(raw, signalDate);
    if (!check.ok) {
      out.ok = false;
      for (const e of check.errors) out.errors.push(`${sym}: ${e}`);
      continue;
    }
    out.records[sym] = check.record;
  }
  return out;
}

module.exports = { validateRecord, validateResearchBatch, assessStructure, rangeWidthPct, ALLOWED_CONFIDENCE, ALLOWED_TYPES };
