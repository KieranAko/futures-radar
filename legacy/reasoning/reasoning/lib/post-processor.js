/**
 * Post-Processor
 * 从LLM原始输出中提取结构化结果
 * v1.2冻结Schema: 11个字段，不保存完整推理过程
 */

/**
 * 提取结构化结果
 * @param {string} rawOutput - LLM原始输出文本
 * @param {{expectedSymbol?: string, expectedSignalDate?: string, expectedStrategy?: string}} [context] - 可选输入一致性校验
 * @returns {{symbol, signalDate, strategy, direction, confidence, pass_reason, evidence_ids, opposing_ids, reasoning_summary, invalidate_if, branch_status}}
 */
export function extractResult(rawOutput, context = null) {
  // 提取JSON（支持markdown代码块包裹）
  const jsonMatch = rawOutput.match(/```json\s*([\s\S]*?)\s*```/) ||
                    rawOutput.match(/```\s*([\s\S]*?)\s*```/) ||
                    [null, rawOutput];

  const cleanJson = jsonMatch[1].trim();

  try {
    const result = JSON.parse(cleanJson);

    // 验证必填字段
    if (!result.symbol || typeof result.symbol !== 'string') {
      throw new Error(`Missing or invalid symbol: ${result.symbol}`);
    }

    if (!result.signalDate || typeof result.signalDate !== 'string') {
      throw new Error(`Missing or invalid signalDate: ${result.signalDate}`);
    }

    if (!result.strategy || typeof result.strategy !== 'string') {
      throw new Error(`Missing or invalid strategy: ${result.strategy}`);
    }

    // 输入一致性校验（仅传 context 时执行）
    if (context) {
      if (context.expectedSymbol && result.symbol !== context.expectedSymbol) {
        throw new Error(`symbol mismatch: expected ${context.expectedSymbol}, got ${result.symbol}`);
      }
      if (context.expectedSignalDate && result.signalDate !== context.expectedSignalDate) {
        throw new Error(`signalDate mismatch: expected ${context.expectedSignalDate}, got ${result.signalDate}`);
      }
      if (context.expectedStrategy && result.strategy !== context.expectedStrategy) {
        throw new Error(`strategy mismatch: expected ${context.expectedStrategy}, got ${result.strategy}`);
      }
    }

    if (!result.direction || !['long', 'short', 'pass'].includes(result.direction)) {
      throw new Error(`Invalid direction: ${result.direction}`);
    }

    if (!result.confidence || !['high', 'medium', 'low'].includes(result.confidence)) {
      throw new Error(`Invalid confidence: ${result.confidence}`);
    }

    // pass时必须有pass_reason
    if (result.direction === 'pass') {
      const validReasons = ['data_insufficient', 'model_abstain', 'conflict_unresolved'];
      if (!result.pass_reason || !validReasons.includes(result.pass_reason)) {
        throw new Error(`Pass direction requires valid pass_reason, got: ${result.pass_reason}`);
      }
    } else if (result.pass_reason !== null && result.pass_reason !== undefined) {
      throw new Error(`Non-pass direction must not carry pass_reason, got: ${result.pass_reason}`);
    }

    if (!Array.isArray(result.evidence_ids)) {
      throw new Error('evidence_ids must be an array');
    }

    // opposing_ids, invalidate_if 可选
    const opposing_ids = Array.isArray(result.opposing_ids) ? result.opposing_ids : [];
    const invalidate_if = Array.isArray(result.invalidate_if) ? result.invalidate_if : [];

    // reasoning_summary必填且≤150字
    if (!result.reasoning_summary || typeof result.reasoning_summary !== 'string') {
      throw new Error('reasoning_summary is required');
    }
    if (result.reasoning_summary.length > 150) {
      throw new Error(`reasoning_summary too long: ${result.reasoning_summary.length} chars (max 150)`);
    }

    // branch_status: fincot必须有，其他策略为null
    if (result.strategy === 'fincot') {
      if (!result.branch_status || typeof result.branch_status !== 'object') {
        throw new Error('FinCoT requires branch_status object');
      }
      const branchKeys = Object.keys(result.branch_status).sort();
      const expectedKeys = ['macro_fundamental', 'position_flow', 'regime'];
      if (JSON.stringify(branchKeys) !== JSON.stringify(expectedKeys)) {
        throw new Error(`branch_status must contain exactly regime/macro_fundamental/position_flow, got: ${branchKeys.join(',')}`);
      }
      const validStatuses = ['available', 'abstain'];
      if (result.branch_status.regime !== 'available') {
        throw new Error(`branch_status.regime must be available, got: ${result.branch_status.regime}`);
      }
      if (!validStatuses.includes(result.branch_status.macro_fundamental)) {
        throw new Error(`Invalid branch_status.macro_fundamental: ${result.branch_status.macro_fundamental}`);
      }
      if (!validStatuses.includes(result.branch_status.position_flow)) {
        throw new Error(`Invalid branch_status.position_flow: ${result.branch_status.position_flow}`);
      }

      // 决策门禁：可用分支数必须与 direction/pass_reason 自洽（冻结规则）
      const availableCount = [
        result.branch_status.regime,
        result.branch_status.macro_fundamental,
        result.branch_status.position_flow
      ].filter((s) => s === 'available').length;

      if (result.direction !== 'pass') {
        if (availableCount < 2) {
          throw new Error(
            `FinCoT ${result.direction} requires >=2 available branches, got ${availableCount}: fewer than two must be pass/data_insufficient`
          );
        }
      } else if (result.pass_reason === 'data_insufficient') {
        if (availableCount >= 2) {
          throw new Error(
            `FinCoT pass/data_insufficient requires fewer than 2 available branches, got ${availableCount}`
          );
        }
      } else if (availableCount < 2) {
        throw new Error(
          `FinCoT pass/${result.pass_reason} requires >=2 available branches, got ${availableCount}`
        );
      }
    } else {
      if (result.branch_status !== null) {
        throw new Error(`Non-FinCoT strategy must have branch_status=null`);
      }
    }

    // 宏观三字段条件式强制（Phase 3 阶段二）：仅 context.macroContext 存在（新 packet）时执行；
    // legacy（旧归档无 macro_context）保持 11 字段返回，不强制。
    const macroCtx = context && context.macroContext ? context.macroContext : null;
    let macro_support = null;
    let macro_conflict = null;
    let macro_evidence_ids = null;

    if (macroCtx) {
      const missingMacro = [];
      if (!('macro_support' in result)) missingMacro.push('macro_support');
      if (!('macro_conflict' in result)) missingMacro.push('macro_conflict');
      if (!Array.isArray(result.macro_evidence_ids)) missingMacro.push('macro_evidence_ids');
      if (missingMacro.length > 0) {
        throw new Error(`FinCoT with macro_context requires: ${missingMacro.join(', ')}`);
      }

      const support = result.macro_support;
      const conflict = result.macro_conflict;
      const ids = result.macro_evidence_ids;

      if (support !== null && !['supportive', 'neutral', 'unsupportive'].includes(support)) {
        throw new Error(`macro_support must be supportive|neutral|unsupportive|null, got: ${support}`);
      }
      if (conflict !== null && typeof conflict !== 'boolean') {
        throw new Error(`macro_conflict must be true|false|null, got: ${conflict}`);
      }

      const effective = macroCtx.status === 'available' && macroCtx.hasEvidence === true && result.direction !== 'pass';

      if (!effective) {
        if (support !== null) {
          throw new Error(`macro_support must be null when macro evidence unavailable or direction=pass, got: ${support}`);
        }
        if (conflict !== null) {
          throw new Error(`macro_conflict must be null when macro evidence unavailable or direction=pass, got: ${conflict}`);
        }
        if (ids.length !== 0) {
          throw new Error(`macro_evidence_ids must be [] when macro evidence unavailable or direction=pass, got ${ids.length} ids`);
        }
      } else {
        if (support === null) {
          throw new Error('macro_support must be non-null when macro evidence is available');
        }
        if (typeof conflict !== 'boolean') {
          throw new Error('macro_conflict must be a boolean when macro evidence is available');
        }
        if (ids.length < 1) {
          throw new Error('macro_evidence_ids must reference >=1 macro evidence id when macro evidence is available');
        }
      }

      macro_support = support;
      macro_conflict = conflict;
      macro_evidence_ids = ids;
    }

    const output = {
      symbol: result.symbol,
      signalDate: result.signalDate,
      strategy: result.strategy,
      direction: result.direction,
      confidence: result.confidence,
      pass_reason: result.pass_reason || null,
      evidence_ids: result.evidence_ids,
      opposing_ids,
      reasoning_summary: result.reasoning_summary,
      invalidate_if,
      branch_status: result.branch_status
    };

    if (macroCtx) {
      output.macro_support = macro_support;
      output.macro_conflict = macro_conflict;
      output.macro_evidence_ids = macro_evidence_ids;
    }

    return output;
  } catch (error) {
    throw new Error(`Failed to parse LLM output: ${error.message}\nRaw output: ${rawOutput.slice(0, 200)}...`);
  }
}

