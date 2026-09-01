// experiment-line/cost-anchor/validate.cjs — 确定性门禁（theory-base/05 §五）
'use strict';

const { loadPolicy, deriveConfidence } = require('./policy.cjs');

const REQUIRED = ['anchorType', 'indicator', 'unit', 'asOf', 'sourceDates', 'sourceTiers'];
const ALLOWED_CONFIDENCE = ['high', 'medium', 'low', 'unknown'];
const ALLOWED_TYPES = ['extraction', 'processing_margin', 'import_parity', 'production_cost', 'none', 'unknown'];

function validateRecord(record, signalDate, policy = loadPolicy()) {
  const errors = [];
  if (!record || typeof record !== 'object') return { ok: false, errors: ['record is not an object'], record: null };

  for (const k of REQUIRED) {
    if (record[k] === undefined || record[k] === null || record[k] === '') errors.push(`missing ${k}`);
  }
  if (!ALLOWED_TYPES.includes(record.anchorType)) errors.push(`invalid anchorType ${record.anchorType}`);
  if (!Array.isArray(record.sourceDates) || record.sourceDates.length === 0) errors.push('sourceDates must be non-empty array');
  if (!Array.isArray(record.sourceTiers) || record.sourceTiers.length === 0) errors.push('sourceTiers must be non-empty array');
  if (!ALLOWED_CONFIDENCE.includes(record.confidence)) errors.push(`invalid confidence ${record.confidence}`);

  const asOf = String(record.asOf || '').slice(0, 10);
  if (asOf && signalDate && asOf > signalDate) errors.push(`asOf ${asOf} > signalDate ${signalDate}`);

  if (record.confidence !== 'unknown') {
    if (!Number.isFinite(record.valueLow) || !Number.isFinite(record.valueHigh)) errors.push('valueLow/valueHigh must be finite numbers');
    else if (record.valueLow > record.valueHigh) errors.push('valueLow > valueHigh');
  }

  if (record.sources && Array.isArray(record.sources)) {
    for (const s of record.sources) {
      if (!s || !s.url || !s.title) errors.push('source entries need title+url');
    }
  }

  if (errors.length === 0 && (record.confidence === undefined || record.confidence === null)) {
    record.confidence = deriveConfidence(record, policy);
  }
  return { ok: errors.length === 0, errors, record };
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

module.exports = { validateRecord, validateResearchBatch, ALLOWED_CONFIDENCE, ALLOWED_TYPES };
