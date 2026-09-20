/**
 * Evidence-Packet Builder
 * 从原始数据构造符合schema的evidence-packet
 */

import { validatePacketSchema, validateTimeBoundary } from './packet-validator.js';
import { validateMacroContext } from './macro-context.js';

/**
 * 构建 evidence-packet
 * @param {object} raw - 原始数据
 * @param {string} raw.symbol - 合约代码
 * @param {string} raw.signalDate - 信号日期 YYYY-MM-DD
 * @param {string} raw.marketCutoffAt - 行情截断时点 ISO8601
 * @param {string} raw.packetFrozenAt - packet冻结时点 ISO8601
 * @param {string} raw.frozenCommit - git commit hash
 * @param {object} raw.fields - 各字段原始数据
 * @returns {{packet: object, validation: {schema: object, timeBoundary: object}}}
 */
export function buildPacket(raw) {
  const packet = {
    symbol: raw.symbol,
    signalDate: raw.signalDate,
    marketCutoffAt: raw.marketCutoffAt,
    packetFrozenAt: raw.packetFrozenAt,
    generatedAt: new Date().toISOString(),
    frozenCommit: raw.frozenCommit,
    quality_check: buildQualityCheck(raw.fields, raw.marketCutoffAt, raw.packetFrozenAt),
    fields: raw.fields
  };

  // 顶层 macro_context 仅在新 packet 显式携带时写入（legacy 归档无此键，四臂渲染字节不变）
  if (raw.macro_context !== undefined) {
    packet.macro_context = raw.macro_context;
  }

  const schemaValidation = validatePacketSchema(packet);
  const timeBoundaryValidation = validateTimeBoundary(packet);

  return {
    packet,
    validation: {
      schema: schemaValidation,
      timeBoundary: timeBoundaryValidation,
      macroContext: raw.macro_context !== undefined ? validateMacroContext(raw.macro_context) : null
    }
  };
}

/**
 * 构建 quality_check 对象
 * @param {object} fields - 字段数据
 * @param {string} marketCutoffAt - 行情截断时点
 * @param {string} packetFrozenAt - packet冻结时点
 * @returns {object}
 */
function buildQualityCheck(fields, marketCutoffAt, packetFrozenAt) {
  const requiredFields = ['price_data', 'volume_oi'];
  const optionalFields = ['basis', 'inventory', 'member_position', 'term_structure', 'sector_movement'];

  const required_available = [];
  const optional_available = [];
  const missing = [];

  for (const field of requiredFields) {
    if (field in fields && isFieldValid(fields[field], field, marketCutoffAt, packetFrozenAt)) {
      required_available.push(field);
    } else {
      missing.push(field);
    }
  }

  for (const field of optionalFields) {
    if (field in fields && isFieldValid(fields[field], field, marketCutoffAt, packetFrozenAt)) {
      optional_available.push(field);
    } else {
      missing.push(field);
    }
  }

  const executable = required_available.length === requiredFields.length;

  return {
    executable,
    required_available,
    optional_available,
    missing,
    max_staleness: '3d'
  };
}

/**
 * 验证字段是否有效（满足时间边界约束 + freshness + gap + 必填字段）
 * @param {object} fieldData - 字段数据
 * @param {string} fieldName - 字段名称
 * @param {string} marketCutoffAt - 行情截断时点
 * @param {string} packetFrozenAt - packet冻结时点
 * @returns {boolean}
 */
function isFieldValid(fieldData, fieldName, marketCutoffAt, packetFrozenAt) {
  if (!fieldData) return false;

  const marketCutoff = new Date(marketCutoffAt);
  const packetFrozen = new Date(packetFrozenAt);

  // 验证日期有效性
  if (isNaN(marketCutoff.getTime()) || isNaN(packetFrozen.getTime())) {
    return false;
  }

  // 必填时间戳：price_data/volume_oi必须有asOf和fetchedAt
  const requiresTimestamps = ['price_data', 'volume_oi'].includes(fieldName);

  // 约束1: asOf ≤ marketCutoffAt
  if (requiresTimestamps && !fieldData.asOf) {
    return false; // 必填字段缺少asOf
  }
  if (fieldData.asOf) {
    const asOf = new Date(fieldData.asOf);
    if (isNaN(asOf.getTime()) || asOf > marketCutoff) return false;
  }

  // 约束2: fetchedAt ≤ packetFrozenAt
  if (requiresTimestamps && !fieldData.fetchedAt) {
    return false; // 必填字段缺少fetchedAt
  }
  if (fieldData.fetchedAt) {
    const fetchedAt = new Date(fieldData.fetchedAt);
    if (isNaN(fetchedAt.getTime()) || fetchedAt > packetFrozen) return false;
  }

  // 约束3: _published_at ≤ marketCutoffAt
  if (fieldData._published_at) {
    const publishedAt = new Date(fieldData._published_at);
    if (isNaN(publishedAt.getTime()) || publishedAt > marketCutoff) return false;
  }

  // 约束4: gap必须为null
  if (fieldData.gap !== null && fieldData.gap !== undefined) {
    return false;
  }

  // 约束5: freshness验证
  const validFreshness = ['same_day', '1d_stale', '3d_stale', '1w_stale'];
  if (fieldData.freshness && !validFreshness.includes(fieldData.freshness)) {
    return false;
  }

  // 必填字段检查（根据字段类型）
  if (fieldName === 'price_data') {
    // price_data必须有close_60d, ma20, ma60
    if (!fieldData.close_60d || !Array.isArray(fieldData.close_60d) || fieldData.close_60d.length === 0) {
      return false;
    }
    if (typeof fieldData.ma20 !== 'number') return false;
    if (typeof fieldData.ma60 !== 'number') return false;
    // freshness必须≤1d_stale
    const freshnessRank = { same_day: 0, '1d_stale': 1, '3d_stale': 2, '1w_stale': 3 };
    if (!fieldData.freshness || freshnessRank[fieldData.freshness] > 1) {
      return false;
    }
  }

  if (fieldName === 'volume_oi') {
    // volume_oi必须有volume_60d, avgVolume5d
    if (!fieldData.volume_60d || !Array.isArray(fieldData.volume_60d) || fieldData.volume_60d.length === 0) {
      return false;
    }
    if (typeof fieldData.avgVolume5d !== 'number') return false;
    // freshness必须≤1d_stale
    const freshnessRank = { same_day: 0, '1d_stale': 1, '3d_stale': 2, '1w_stale': 3 };
    if (!fieldData.freshness || freshnessRank[fieldData.freshness] > 1) {
      return false;
    }
  }

  if (fieldName === 'term_structure') {
    // term_structure必须有近/主/远三价 + spread_pct + 合法shape（optional，失败仅降级为missing）
    if (typeof fieldData.near_price !== 'number') return false;
    if (typeof fieldData.main_price !== 'number') return false;
    if (typeof fieldData.far_price !== 'number') return false;
    if (typeof fieldData.spread_pct !== 'number') return false;
    if (!['contango', 'backwardation'].includes(fieldData.shape)) return false;
  }

  if (fieldName === 'sector_movement') {
    // sector_movement 必须带板块方向量化字段（optional，失败仅降级为missing）
    if (typeof fieldData.sector !== 'string' || fieldData.sector.length === 0) return false;
    if (typeof fieldData.sector_ret1d !== 'number') return false;
    if (typeof fieldData.sector_ret5d !== 'number') return false;
    if (typeof fieldData.advance_ratio_1d !== 'number') return false;
    if (typeof fieldData.leader_symbol !== 'string') return false;
  }

  return true;
}
