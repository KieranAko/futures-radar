/**
 * Reasoning Artifact
 * 冻结 reasoning-results.json 契约：canonical packet hash + artifact 构建/校验
 */

import crypto from 'node:crypto';

const FORBIDDEN_RESULT_FIELDS = ['raw_thinking', 'chain_of_thought'];
const FORBIDDEN_PATTERN = /raw_thinking|chain_of_thought/;

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = canonicalize(value[key]);
    }
    return out;
  }
  return value;
}

/**
 * canonical packet hash：排除 generatedAt/packetHash/point_in_time，递归键排序后 SHA-256
 * @param {object} packet - evidence-packet
 * @returns {string} sha256:<hex>
 */
export function hashPacket(packet) {
  const clone = JSON.parse(JSON.stringify(packet));
  delete clone.generatedAt;
  delete clone.packetHash;
  delete clone.point_in_time;
  const canonical = JSON.stringify(canonicalize(clone));
  return `sha256:${crypto.createHash('sha256').update(canonical).digest('hex')}`;
}

/**
 * 校验模型元数据（provider/modelId/temperature/maxTokens 必填）
 * @param {object} model - meta.model
 * @returns {string[]} errors
 */
function validateModelMeta(model) {
  const errors = [];
  if (!model || typeof model !== 'object') {
    return ['meta.model is required'];
  }
  if (!model.provider || typeof model.provider !== 'string') {
    errors.push('meta.model.provider is required');
  }
  if (!model.modelId || typeof model.modelId !== 'string') {
    errors.push('meta.model.modelId is required');
  }
  if (typeof model.temperature !== 'number') {
    errors.push('meta.model.temperature must be a number');
  }
  if (typeof model.maxTokens !== 'number') {
    errors.push('meta.model.maxTokens must be a number');
  }
  return errors;
}

/**
 * 构建 reasoning-results artifact；非法 entry 直接抛错（fail closed）
 * @param {object} meta - artifact meta（含 model metadata）
 * @param {Array<{symbol, packetHash, arm, status, result, grounding}>} entries
 * @returns {{meta: object, results: object[]}}
 */
export function buildReasoningArtifact(meta, entries) {
  const errors = validateModelMeta(meta?.model);
  if (errors.length > 0) {
    throw new Error(`Invalid model metadata: ${errors.join('; ')}`);
  }
  if (!Array.isArray(entries)) {
    throw new Error('entries must be an array');
  }

  const results = entries.map((entry) => {
    if (!entry.packetHash || typeof entry.packetHash !== 'string') {
      throw new Error(`Entry for ${entry.symbol} missing packetHash`);
    }
    if (!entry.grounding || typeof entry.grounding.grounded !== 'boolean') {
      throw new Error(`Entry for ${entry.symbol} missing grounding`);
    }
    if (entry.status === 'accepted' && entry.grounding.grounded !== true) {
      throw new Error(`Entry for ${entry.symbol}: accepted requires grounding.grounded=true`);
    }
    const resultJson = JSON.stringify(entry.result ?? null);
    if (FORBIDDEN_PATTERN.test(resultJson)) {
      for (const field of FORBIDDEN_RESULT_FIELDS) {
        if (resultJson.includes(`"${field}"`)) {
          throw new Error(`Entry for ${entry.symbol}: forbidden field ${field}`);
        }
      }
    }
    return entry;
  });

  const artifact = { meta, results };
  const validation = validateReasoningArtifact(artifact);
  if (!validation.valid) {
    throw new Error(`Artifact validation failed: ${validation.errors.join('; ')}`);
  }
  return artifact;
}

/**
 * 校验 reasoning-results artifact 结构
 * @param {object} artifact
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateReasoningArtifact(artifact) {
  const errors = [];

  if (!artifact || typeof artifact !== 'object') {
    return { valid: false, errors: ['artifact must be an object'] };
  }

  errors.push(...validateModelMeta(artifact.meta?.model));

  if (!Array.isArray(artifact.results)) {
    errors.push('results must be an array');
    return { valid: false, errors };
  }

  const validStatuses = [
    'accepted',
    'parse_failed',
    'grounding_failed',
    'grounding_degraded',
    'packet_ineligible'
  ];

  for (const entry of artifact.results) {
    if (!entry.packetHash || typeof entry.packetHash !== 'string') {
      errors.push(`Entry for ${entry.symbol} missing packetHash`);
    }
    if (!entry.arm || typeof entry.arm !== 'string') {
      errors.push(`Entry for ${entry.symbol} missing arm`);
    }
    if (!validStatuses.includes(entry.status)) {
      errors.push(`Entry for ${entry.symbol} has invalid status: ${entry.status}`);
    }
    if (!entry.grounding || typeof entry.grounding.grounded !== 'boolean') {
      errors.push(`Entry for ${entry.symbol} missing grounding`);
    }
    if (entry.status === 'accepted' && entry.grounding?.grounded !== true) {
      errors.push(`Entry for ${entry.symbol}: accepted requires grounding.grounded=true`);
    }
    const resultJson = JSON.stringify(entry.result ?? null);
    for (const field of FORBIDDEN_RESULT_FIELDS) {
      if (resultJson.includes(`"${field}"`)) {
        errors.push(`Entry for ${entry.symbol}: forbidden field ${field}`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
