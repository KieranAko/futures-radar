/**
 * Prompt Renderer
 * 将packet渲染成四臂prompt（SP/UST-CoT/ST-CoT/FinCoT）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// fincot 模板自该分隔符起为宏观区块；legacy packet（无 macro_context）渲染时截断以保持字节一致
const MACRO_SECTION_DELIMITER = '\n\n---\n\n## 宏观上下文（macro_context）';

/**
 * 渲染evidence为可读文本
 * @param {object} packet - evidence-packet
 * @returns {string} 渲染后的证据文本
 */
function renderEvidence(packet) {
  const lines = [];

  for (const [fieldName, fieldData] of Object.entries(packet.fields)) {
    lines.push(`### ${fieldName}`);
    lines.push(`- source: ${fieldData.source}`);
    lines.push(`- asOf: ${fieldData.asOf}`);
    lines.push(`- fetchedAt: ${fieldData.fetchedAt}`);
    if (fieldData._published_at) {
      lines.push(`- _published_at: ${fieldData._published_at}`);
    }
    lines.push(`- freshness: ${fieldData.freshness}`);
    lines.push(`- gap: ${fieldData.gap}`);

    // 渲染具体数据字段
    for (const [key, value] of Object.entries(fieldData)) {
      if (['source', 'asOf', 'fetchedAt', '_published_at', 'freshness', 'gap'].includes(key)) {
        continue;
      }
      if (Array.isArray(value)) {
        lines.push(`- ${key}: [${value.join(', ')}]`);
      } else {
        lines.push(`- ${key}: ${value}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * 渲染 macro_context 为可读文本（Phase 3 阶段二）
 * @param {object} mc - packet.macro_context
 * @returns {string}
 */
function renderMacroContextBlock(mc) {
  if (mc.status === 'available') {
    const lines = [
      `状态：available（快照冻结于 ${mc.snapshot.snapshotFrozenAt}，schema ${mc.snapshot.schemaVersion}）`,
      `相关锚点：${mc.relevant_anchor_ids.join('、')}`,
      '证据：'
    ];
    for (const e of mc.evidence) {
      lines.push(`- ${e.id}：值 ${e.value}，5日变化 ${e.change5d}%，状态 ${e.status}，asOf ${e.asOf}，来源 ${e.source}`);
    }
    if (mc.gaps.length > 0) {
      lines.push('缺口：');
      for (const g of mc.gaps) {
        lines.push(`- ${g.id}：${g.reason}`);
      }
    }
    return lines.join('\n');
  }
  if (mc.status === 'not_applicable') {
    return '状态：not_applicable —— 该品种无适用日频宏观锚点（传导表路由为空）。禁止引入美元/利率等宏观解释。';
  }
  return `状态：unavailable —— 宏观快照不可用（原因：${mc.reason}）。禁止补写或猜测宏观数据；宏观证据一律视为缺失。`;
}

/**
 * 渲染 FinCoT prompt：macro packet 渲染宏观区块，legacy packet 自分隔符截断（四臂隔离）
 * @param {object} packet - evidence-packet
 * @returns {string}
 */
function renderFincotPrompt(packet) {
  let template = fs.readFileSync(path.join(__dirname, '../prompts/fincot-prompt.md'), 'utf-8');
  const hasMacro = packet.macro_context !== undefined;

  if (!hasMacro) {
    const delimiterIndex = template.indexOf(MACRO_SECTION_DELIMITER);
    if (delimiterIndex >= 0) {
      template = template.slice(0, delimiterIndex + 1);
    }
  }

  const evidence = renderEvidence(packet);

  return template
    .replace(/\{\{symbol\}\}/g, packet.symbol)
    .replace(/\{\{signalDate\}\}/g, packet.signalDate)
    .replace(/\{\{evidence\}\}/g, evidence)
    .replace(/\{\{macro_context\}\}/g, hasMacro ? renderMacroContextBlock(packet.macro_context) : '');
}

/**
 * 渲染单个prompt模板
 * @param {string} templatePath - 模板文件路径
 * @param {object} packet - evidence-packet
 * @returns {string} 渲染后的prompt
 */
function renderPromptTemplate(templatePath, packet) {
  const template = fs.readFileSync(templatePath, 'utf-8');
  const evidence = renderEvidence(packet);

  return template
    .replace(/\{\{symbol\}\}/g, packet.symbol)
    .replace(/\{\{signalDate\}\}/g, packet.signalDate)
    .replace(/\{\{evidence\}\}/g, evidence);
}

/**
 * 渲染四臂prompt
 * @param {object} packet - evidence-packet
 * @returns {{sp: string, ustCot: string, stCot: string, finCot: string}}
 */
export function renderFourArmPrompts(packet) {
  const promptsDir = path.join(__dirname, '../prompts');

  return {
    sp: renderPromptTemplate(path.join(promptsDir, 'sp-prompt.md'), packet),
    ustCot: renderPromptTemplate(path.join(promptsDir, 'ust-cot-prompt.md'), packet),
    stCot: renderPromptTemplate(path.join(promptsDir, 'st-cot-prompt.md'), packet),
    finCot: renderFincotPrompt(packet)
  };
}
