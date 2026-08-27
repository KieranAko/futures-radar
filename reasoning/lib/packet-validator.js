/**
 * Evidence-Packet Validator
 * Schema验证 + 时间边界约束验证
 */

/**
 * 验证 packet schema
 * @param {object} packet - evidence-packet 对象
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validatePacketSchema(packet) {
  const errors = [];

  // 必填顶层字段
  const requiredTopLevel = [
    'symbol',
    'signalDate',
    'marketCutoffAt',
    'packetFrozenAt',
    'generatedAt',
    'frozenCommit',
    'quality_check',
    'fields'
  ];

  for (const field of requiredTopLevel) {
    if (!(field in packet)) {
      errors.push(`Missing required field: ${field}`);
    }
  }

  // 验证 quality_check 结构
  if (packet.quality_check) {
    const qc = packet.quality_check;
    if (typeof qc.executable !== 'boolean') {
      errors.push('quality_check.executable must be boolean');
    }
    if (!Array.isArray(qc.required_available)) {
      errors.push('quality_check.required_available must be array');
    }
    if (!Array.isArray(qc.optional_available)) {
      errors.push('quality_check.optional_available must be array');
    }
    if (!Array.isArray(qc.missing)) {
      errors.push('quality_check.missing must be array');
    }
  }

  // 验证 fields 存在
  if (packet.fields && typeof packet.fields !== 'object') {
    errors.push('fields must be an object');
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * 验证时间边界约束（4条）
 * @param {object} packet - evidence-packet 对象
 * @returns {{valid: boolean, violations: Array<{constraint: string, field: string, detail: string}>}}
 */
export function validateTimeBoundary(packet) {
  const violations = [];
  const marketCutoff = new Date(packet.marketCutoffAt);
  const packetFrozen = new Date(packet.packetFrozenAt);

  // 验证顶层cutoff有效性
  if (isNaN(marketCutoff.getTime())) {
    violations.push({
      constraint: 'valid marketCutoffAt',
      field: 'packet',
      detail: `marketCutoffAt=${packet.marketCutoffAt} is invalid`
    });
  }
  if (isNaN(packetFrozen.getTime())) {
    violations.push({
      constraint: 'valid packetFrozenAt',
      field: 'packet',
      detail: `packetFrozenAt=${packet.packetFrozenAt} is invalid`
    });
  }

  // 必填字段列表（必须有asOf和fetchedAt）
  const requiredFields = ['price_data', 'volume_oi'];

  for (const [fieldName, fieldData] of Object.entries(packet.fields || {})) {
    const isRequired = requiredFields.includes(fieldName);

    // 对必填字段，验证asOf和fetchedAt存在
    if (isRequired) {
      if (!fieldData.asOf) {
        violations.push({
          constraint: 'required asOf',
          field: fieldName,
          detail: `${fieldName} is required but missing asOf`
        });
      }
      if (!fieldData.fetchedAt) {
        violations.push({
          constraint: 'required fetchedAt',
          field: fieldName,
          detail: `${fieldName} is required but missing fetchedAt`
        });
      }
    }

    // 约束1: asOf ≤ marketCutoffAt
    if (fieldData.asOf) {
      const asOf = new Date(fieldData.asOf);
      if (isNaN(asOf.getTime())) {
        violations.push({
          constraint: 'valid asOf',
          field: fieldName,
          detail: `asOf=${fieldData.asOf} is invalid`
        });
      } else if (asOf > marketCutoff) {
        violations.push({
          constraint: 'asOf <= marketCutoffAt',
          field: fieldName,
          detail: `asOf=${fieldData.asOf} > marketCutoffAt=${packet.marketCutoffAt}`
        });
      }
    }

    // 约束2: fetchedAt ≤ packetFrozenAt
    if (fieldData.fetchedAt) {
      const fetchedAt = new Date(fieldData.fetchedAt);
      if (isNaN(fetchedAt.getTime())) {
        violations.push({
          constraint: 'valid fetchedAt',
          field: fieldName,
          detail: `fetchedAt=${fieldData.fetchedAt} is invalid`
        });
      } else if (fetchedAt > packetFrozen) {
        violations.push({
          constraint: 'fetchedAt <= packetFrozenAt',
          field: fieldName,
          detail: `fetchedAt=${fieldData.fetchedAt} > packetFrozenAt=${packet.packetFrozenAt}`
        });
      }
    }

    // 约束3: _published_at ≤ marketCutoffAt
    if (fieldData._published_at) {
      const publishedAt = new Date(fieldData._published_at);
      if (isNaN(publishedAt.getTime())) {
        violations.push({
          constraint: 'valid _published_at',
          field: fieldName,
          detail: `_published_at=${fieldData._published_at} is invalid`
        });
      } else if (publishedAt > marketCutoff) {
        violations.push({
          constraint: '_published_at <= marketCutoffAt',
          field: fieldName,
          detail: `_published_at=${fieldData._published_at} > marketCutoffAt=${packet.marketCutoffAt}`
        });
      }
    }
  }

  return {
    valid: violations.length === 0,
    violations
  };
}
