/**
 * Grounding Validator
 * 验证LLM输出的evidence_ids和opposing_ids是否在packet中真实存在（支持嵌套路径）
 *
 * Grounding定义（v1.2）:
 * - evidence_ids中的所有路径必须存在于packet.fields中（支持嵌套，如"price_data.close_60d"）
 * - opposing_ids中的所有路径必须存在于packet.fields中
 * - 不存在的路径视为grounding失败
 */

/**
 * 验证嵌套路径是否存在
 * @param {object} fields - packet.fields对象
 * @param {string} path - 嵌套路径，如"price_data.close_60d"
 * @returns {boolean}
 */
function pathExists(fields, path) {
  const parts = path.split('.');
  let current = fields;

  for (const part of parts) {
    if (!current || typeof current !== 'object' || !(part in current)) {
      return false;
    }
    current = current[part];
  }

  // 值不能是undefined或null
  return current !== undefined && current !== null;
}

/**
 * 验证grounding
 * @param {object} result - Post-processor提取的结果
 * @param {object} packet - Evidence-packet
 * @returns {{grounded: boolean, ungrounded_evidence: string[], ungrounded_opposing: string[], ungrounded_macro: string[]}}
 */
export function validateGrounding(result, packet) {
  const fields = packet.fields || {};

  const ungrounded_evidence = result.evidence_ids.filter(path => !pathExists(fields, path));
  const ungrounded_opposing = result.opposing_ids.filter(path => !pathExists(fields, path));

  // 宏域独立校验（Phase 3 阶段二）：macro_evidence_ids → packet.macro_context.evidence[].id，fail-closed
  const macroIds = Array.isArray(result.macro_evidence_ids) ? result.macro_evidence_ids : [];
  const macroEvidenceIds = new Set((packet.macro_context?.evidence || []).map((e) => e.id));
  const ungrounded_macro = macroIds.filter((id) => !macroEvidenceIds.has(id));

  const grounded = ungrounded_evidence.length === 0 && ungrounded_opposing.length === 0 && ungrounded_macro.length === 0;

  return {
    grounded,
    ungrounded_evidence,
    ungrounded_opposing,
    ungrounded_macro
  };
}

/**
 * 生成分层样本矩阵（3×4=12样本）用于验证覆盖率
 *
 * 分层维度（v1.3.2要求）:
 * - 方向层: long / short / pass
 * - prompt臂层: SP / UST-CoT / ST-CoT / FinCoT
 *
 * @param {Array<{arm: string, result: object, packet: object}>} samples - 样本集合
 * @returns {object} 分层统计
 */
export function stratifyGroundingSamples(samples) {
  const matrix = {
    long: { SP: 0, 'UST-CoT': 0, 'ST-CoT': 0, FinCoT: 0 },
    short: { SP: 0, 'UST-CoT': 0, 'ST-CoT': 0, FinCoT: 0 },
    pass: { SP: 0, 'UST-CoT': 0, 'ST-CoT': 0, FinCoT: 0 }
  };

  const groundingResults = [];

  for (const sample of samples) {
    const validation = validateGrounding(sample.result, sample.packet);
    const direction = sample.result.direction;
    const arm = sample.arm;

    if (matrix[direction] && arm in matrix[direction]) {
      matrix[direction][arm]++;
    }

    groundingResults.push({
      arm,
      direction,
      grounded: validation.grounded,
      ungrounded_evidence: validation.ungrounded_evidence,
      ungrounded_opposing: validation.ungrounded_opposing
    });
  }

  // 计算覆盖率
  const coverage = {
    total_cells: 12,
    covered_cells: 0,
    matrix
  };

  for (const direction of ['long', 'short', 'pass']) {
    for (const arm of ['SP', 'UST-CoT', 'ST-CoT', 'FinCoT']) {
      if (matrix[direction][arm] > 0) {
        coverage.covered_cells++;
      }
    }
  }

  return {
    coverage,
    groundingResults
  };
}
