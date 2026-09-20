/**
 * Reasoning Runner
 * provider-neutral 单臂执行：门禁 → 渲染 prompt → provider → parser → grounding
 */

import crypto from 'node:crypto';
import { renderFourArmPrompts } from './prompt-renderer.js';
import { extractResult } from './post-processor.js';
import { validateGrounding } from './grounding-validator.js';
import { validatePacketSchema, validateTimeBoundary } from './packet-validator.js';
import { validateMacroContext } from './macro-context.js';
import { hashPacket } from './reasoning-artifact.js';

const ARM_PROMPT_KEYS = {
  sp: 'sp',
  'ust-cot': 'ustCot',
  'st-cot': 'stCot',
  fincot: 'finCot'
};

function sha256(text) {
  return `sha256:${crypto.createHash('sha256').update(text).digest('hex')}`;
}

/**
 * 执行单臂 reasoning
 * @param {object} args
 * @param {object} args.packet - evidence-packet
 * @param {string} args.arm - sp | ust-cot | st-cot | fincot
 * @param {object} args.provider - { complete({prompt, model, metadata}) → {text, provider, modelId, temperature, maxTokens} }
 * @param {object} args.model - { provider, modelId, temperature, maxTokens }
 * @param {string} args.promptVersion - prompt 版本标识
 * @param {number} args.parseRetries - extractResult 失败后的额外重试次数（默认 2）
 * @returns {Promise<{symbol, packetHash, arm, status, result, grounding, promptHash}>}
 */
export async function runReasoningArm({
  packet,
  arm,
  provider,
  model,
  promptVersion,
  parseRetries = 2
}) {
  const promptKey = ARM_PROMPT_KEYS[arm];
  if (!promptKey) {
    throw new Error(`Unknown arm: ${arm}`);
  }

  const schema = validatePacketSchema(packet);
  const timeBoundary = validateTimeBoundary(packet);
  // 顶层 macro_context 结构校验纳入 eligibility 门禁（P1：malformed context 不得进入 provider，fail-closed）
  const macroContextShape = packet.macro_context !== undefined
    ? validateMacroContext(packet.macro_context)
    : { valid: true, errors: [] };
  const executable = packet.quality_check?.executable === true;
  const packetHash = hashPacket(packet);

  if (!schema.valid || !timeBoundary.valid || !macroContextShape.valid || !executable) {
    return {
      symbol: packet.symbol,
      packetHash,
      arm,
      status: 'packet_ineligible',
      result: null,
      grounding: { grounded: false, ungrounded_evidence: [], ungrounded_opposing: [], ungrounded_macro: [] },
      promptHash: null
    };
  }

  const prompts = renderFourArmPrompts(packet);
  const prompt = prompts[promptKey];
  const promptHash = sha256(prompt);

  // 三字段契约仅 FinCoT 臂输出（四臂隔离）；其余臂不传 macroContext，保持既有 11 字段
  const macroContext = packet.macro_context && arm === 'fincot'
    ? {
        status: packet.macro_context.status,
        hasEvidence: Array.isArray(packet.macro_context.evidence) && packet.macro_context.evidence.length > 0
      }
    : null;

  const completeOnce = (attempt) =>
    provider.complete({
      prompt,
      model,
      metadata: {
        symbol: packet.symbol,
        signalDate: packet.signalDate,
        arm,
        packetHash,
        promptHash,
        promptVersion,
        attempt
      }
    });

  let response = await completeOnce(0);
  let result = null;
  let parseError = null;

  for (let attempt = 0; attempt <= parseRetries; attempt++) {
    try {
      result = extractResult(response.text, {
        expectedSymbol: packet.symbol,
        expectedSignalDate: packet.signalDate,
        expectedStrategy: arm,
        macroContext
      });
      parseError = null;
      break;
    } catch (err) {
      parseError = err.message;
      if (attempt < parseRetries) {
        response = await completeOnce(attempt + 1);
      }
    }
  }

  if (!result) {
    return {
      symbol: packet.symbol,
      packetHash,
      arm,
      status: 'parse_failed',
      result: null,
      grounding: { grounded: false, ungrounded_evidence: [], ungrounded_opposing: [], ungrounded_macro: [] },
      promptHash,
      parseError
    };
  }

  const grounding = validateGrounding(result, packet);

  if (!grounding.grounded) {
    const ungroundedPaths = [...grounding.ungrounded_evidence, ...grounding.ungrounded_opposing, ...(grounding.ungrounded_macro || [])];
    return {
      symbol: packet.symbol,
      packetHash,
      arm,
      status: 'grounding_degraded',
      result: {
        symbol: packet.symbol,
        signalDate: packet.signalDate,
        strategy: arm,
        direction: 'pass',
        confidence: 'low',
        pass_reason: 'model_abstain',
        evidence_ids: [],
        opposing_ids: [],
        reasoning_summary: `grounding 校验失败（${ungroundedPaths.join(', ')} 不存在于 packet），降级为 pass`,
        invalidate_if: [],
        branch_status: { regime: 'available', macro_fundamental: 'abstain', position_flow: 'abstain' },
        ...(macroContext ? { macro_support: null, macro_conflict: null, macro_evidence_ids: [] } : {})
      },
      grounding: { grounded: true, ungrounded_evidence: [], ungrounded_opposing: [], ungrounded_macro: [] },
      originalGrounding: grounding,
      promptHash
    };
  }

  return {
    symbol: packet.symbol,
    packetHash,
    arm,
    status: 'accepted',
    result,
    grounding,
    promptHash
  };
}
