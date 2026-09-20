/**
 * Macro Context（Phase 3 阶段二）
 * 从冻结 macro-snapshot.json 构建 packet 顶层 macro_context 三态
 * （available / not_applicable / unavailable），并提供形状校验。
 * 冻结口径：缅因猫阶段二实施规格（thread 0001787736242943）。
 */

export const MACRO_STATUSES = ['available', 'not_applicable', 'unavailable'];

function unavailable(reason) {
  return {
    status: 'unavailable',
    relevant_anchor_ids: [],
    evidence: [],
    gaps: [],
    reason,
    snapshot: null
  };
}

function snapshotMeta(snapshot) {
  const meta = snapshot.meta;
  return {
    signalDate: meta.signalDate,
    marketCutoffAt: meta.marketCutoffAt,
    snapshotFrozenAt: meta.snapshotFrozenAt,
    schemaVersion: meta.schemaVersion
  };
}

export function buildMacroContext({
  snapshot,
  validation,
  readError = null,
  runId,
  signalDate,
  symbol,
  relevantAnchors
}) {
  if (!snapshot) {
    return unavailable(
      readError ? `macro-snapshot.json unreadable: ${readError}` : 'macro-snapshot.json missing'
    );
  }
  if (!validation || !validation.ok) {
    const errors = validation && Array.isArray(validation.errors)
      ? validation.errors
      : ['validation failed'];
    return unavailable(`snapshot failed validation: ${errors.join('; ')}`);
  }
  if (snapshot.meta?.runId !== runId) {
    return unavailable(`snapshot runId ${snapshot.meta?.runId} != run ${runId}`);
  }
  if (snapshot.meta?.signalDate !== signalDate) {
    return unavailable(`snapshot signalDate ${snapshot.meta?.signalDate} != packet signalDate ${signalDate}`);
  }

  const meta = snapshotMeta(snapshot);

  if (!Array.isArray(relevantAnchors) || relevantAnchors.length === 0) {
    return {
      status: 'not_applicable',
      relevant_anchor_ids: [],
      evidence: [],
      gaps: [],
      reason: null,
      snapshot: meta
    };
  }

  const indicators = snapshot.indicators || {};
  const evidence = [];
  const gaps = [];

  for (const anchor of relevantAnchors) {
    const ind = indicators[anchor];
    if (!ind || ind.status === 'missing') {
      gaps.push({ id: `macro.${anchor}`, anchor, reason: ind?.reason || 'indicator missing' });
      continue;
    }
    evidence.push({
      id: `macro.${anchor}`,
      anchor,
      value: ind.value,
      change5d: ind.change5d,
      status: ind.status,
      asOf: ind.asOf,
      fetchedAt: ind.fetchedAt,
      source: ind.source,
      _timestamp_origin: 'observed'
    });
  }

  return {
    status: 'available',
    relevant_anchor_ids: [...relevantAnchors],
    evidence,
    gaps,
    reason: null,
    snapshot: meta
  };
}

export function validateMacroContext(mc) {
  const errors = [];
  if (!mc || typeof mc !== 'object') {
    return { valid: false, errors: ['macro_context must be an object'] };
  }
  if (!MACRO_STATUSES.includes(mc.status)) {
    errors.push(`macro_context.status invalid: ${mc.status}`);
  }
  if (!Array.isArray(mc.relevant_anchor_ids)) {
    errors.push('macro_context.relevant_anchor_ids must be an array');
  }
  if (!Array.isArray(mc.evidence)) {
    errors.push('macro_context.evidence must be an array');
  }
  if (!Array.isArray(mc.gaps)) {
    errors.push('macro_context.gaps must be an array');
  }
  if (Array.isArray(mc.evidence)) {
    mc.evidence.forEach((e, i) => {
      if (!e || typeof e !== 'object' || typeof e.id !== 'string' || e.id.length === 0) {
        errors.push(`macro_context.evidence[${i}].id missing`);
        return;
      }
      if (!e.id.startsWith('macro.')) {
        errors.push(`macro_context.evidence[${i}].id must start with 'macro.'`);
      }
      if (typeof e.anchor !== 'string' || e.anchor.length === 0) {
        errors.push(`macro_context.evidence[${i}].anchor missing`);
      }
      if (typeof e.value !== 'number' || !Number.isFinite(e.value)) {
        errors.push(`macro_context.evidence[${i}].value must be a finite number`);
      }
      if (!['fresh', 'stale'].includes(e.status)) {
        errors.push(`macro_context.evidence[${i}].status invalid: ${e.status}`);
      }
      for (const key of ['asOf', 'fetchedAt', 'source']) {
        if (typeof e[key] !== 'string') {
          errors.push(`macro_context.evidence[${i}].${key} must be a string`);
        }
      }
    });
  }
  if (mc.status === 'unavailable') {
    if (typeof mc.reason !== 'string' || mc.reason.length === 0) {
      errors.push('macro_context.reason required when unavailable');
    }
    if (mc.snapshot !== null) {
      errors.push('macro_context.snapshot must be null when unavailable');
    }
  }
  return { valid: errors.length === 0, errors };
}
