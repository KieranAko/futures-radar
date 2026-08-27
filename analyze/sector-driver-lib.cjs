#!/usr/bin/env node
/**
 * analyze/sector-driver-lib.cjs — 板块驱动 LLM 的共享库（v0.1.5）
 *
 * 原则：
 *   - 板块驱动只解释板块整体，不预测任何单个品种。
 *   - 板块级 packet 只含观察值；个股 Q1 结论绝不进入板块 packet。
 *   - sector driver 是 LLM 结论，以独立 context 进入个股 FinCoT prompt，
 *     绝不写入个股 packet.fields，不能作为 evidence_ids。
 */

const fs = require('fs');
const path = require('path');
const { skillRoot } = require('../lib/workspace.cjs');

const PROMPT_TEMPLATE = path.join(skillRoot, 'reasoning', 'prompts', 'sector-driver-prompt.md');
const VALID_STATUS = ['analyzed', 'unknown', 'not_moved', 'abstain_insufficient'];
const VALID_STRUCTURE = ['broad_based', 'bifurcated', 'isolated', 'not_enough_members'];
const VALID_DIRECTION = ['up', 'down', 'flat'];
const VALID_CATEGORY = ['macro', 'industry', 'policy', 'external', 'flow'];

function readJSON(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function buildRelevantAnchorsForSector(memberSymbols) {
  const cfg = readJSON(path.join(skillRoot, 'config', 'macro-transmission.json'));
  const anchors = new Set();
  for (const sym of memberSymbols) {
    const prefix = String(sym).replace(/0$/, '');
    for (const rule of cfg.rules || []) {
      if ((rule.prefixes || []).includes(prefix)) {
        for (const a of rule.anchors || []) anchors.add(a);
        break;
      }
    }
  }
  return [...anchors];
}

/**
 * 把 sector-snapshot + macro-snapshot 组装成板块级证据包。
 */
function buildSectorDriverPackets({ sectorSnapshot, macroSnapshot, symbolsConfig, runId }) {
  const signalDate = sectorSnapshot.meta && sectorSnapshot.meta.signalDate;
  const packets = {};
  const macroIndicators = macroSnapshot && macroSnapshot.indicators ? macroSnapshot.indicators : {};

  for (const [sectorId, sec] of Object.entries(sectorSnapshot.sectors || {})) {
    const memberSymbols = (symbolsConfig.symbols || [])
      .filter((s) => s.active && s.sector === sectorId)
      .map((s) => s.symbol);
    const relevantAnchors = buildRelevantAnchorsForSector(memberSymbols);

    const macroEvidence = relevantAnchors
      .map((id) => {
        const ind = macroIndicators[id];
        if (!ind || ind.status === 'missing') return null;
        return {
          id: `macro.${id}`,
          value: ind.value,
          change5d: ind.change5d,
          status: ind.status,
          asOf: ind.asOf,
          source: ind.source
        };
      })
      .filter(Boolean);

    packets[sectorId] = {
      sector: sectorId,
      label: sec.label,
      signalDate,
      runId,
      observed: {
        direction: sec.direction,
        indexLevel: sec.indexLevel,
        ret1d: sec.ret1d,
        ret5d: sec.ret5d,
        ret20d: sec.ret20d,
        advanceRatio1d: sec.advanceRatio1d,
        advanceRatio5d: sec.advanceRatio5d,
        coherence1d: sec.coherence1d,
        volumeRatio20d: sec.volumeRatio20d,
        members: sec.members,
        leaders: sec.leaders || [],
        laggards: sec.laggards || []
      },
      macro_context: {
        status: macroSnapshot ? 'available' : 'unavailable',
        relevant_anchor_ids: relevantAnchors,
        evidence: macroEvidence
      }
    };
  }

  return {
    meta: {
      runId,
      signalDate,
      generatedAt: new Date().toISOString(),
      mode: 'sector-driver',
      source: 'sector-snapshot.json + macro-snapshot.json'
    },
    packets
  };
}

function fmtArr(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return '[]';
  return '[' + arr.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(', ') + ']';
}

function renderPacketEvidence(packet) {
  const o = packet.observed;
  const lines = [];
  lines.push('### observed');
  lines.push(`- direction: ${o.direction}`);
  lines.push(`- indexLevel: ${o.indexLevel}`);
  lines.push(`- ret1d: ${o.ret1d}`);
  lines.push(`- ret5d: ${o.ret5d}`);
  lines.push(`- ret20d: ${o.ret20d}`);
  lines.push(`- advanceRatio1d: ${o.advanceRatio1d}`);
  lines.push(`- advanceRatio5d: ${o.advanceRatio5d}`);
  lines.push(`- coherence1d: ${o.coherence1d}`);
  lines.push(`- volumeRatio20d: ${o.volumeRatio20d}`);
  lines.push(`- members: ${o.members}`);
  lines.push(`- leaders: ${fmtArr(o.leaders)}`);
  lines.push(`- laggards: ${fmtArr(o.laggards)}`);
  lines.push('');
  lines.push('### macro_context');
  lines.push(`- status: ${packet.macro_context.status}`);
  lines.push(`- relevant_anchor_ids: ${fmtArr(packet.macro_context.relevant_anchor_ids)}`);
  for (const e of packet.macro_context.evidence) {
    lines.push(`- ${e.id}: value=${e.value} change5d=${e.change5d} status=${e.status} asOf=${e.asOf} source=${e.source}`);
  }
  return lines.join('\n');
}

function renderSectorDriverPrompt(packet) {
  const template = fs.readFileSync(PROMPT_TEMPLATE, 'utf8');
  return template
    .replace(/\{\{sector_label\}\}/g, packet.label)
    .replace(/\{\{sector\}\}/g, packet.sector)
    .replace(/\{\{signalDate\}\}/g, packet.signalDate)
    .replace(/\{\{evidence\}\}/g, renderPacketEvidence(packet));
}

/**
 * 渲染个股 FinCoT prompt 的 sector_driver_context 区块（独立 LLM 结论，非 packet 证据）。
 */
function renderSectorDriverContextBlock(sectorDriver, sectorId) {
  const sec = sectorDriver && sectorDriver.sectors ? sectorDriver.sectors[sectorId] : null;
  if (!sec) {
    return '状态：unavailable —— 本 run 未生成板块驱动结论。禁止自行将个股 Q1 或板块量价关系当作板块驱动。';
  }
  if (sec.status === 'analyzed' && sec.driver) {
    const lines = [
      `状态：analyzed（板块归因，非本品种结论）`,
      `- 板块结构：${sec.member_structure}`,
      `- 驱动：${sec.driver.primary}（category=${sec.driver.category}, confidence=${sec.driver.confidence}）`,
      `- 失效条件：${fmtArr(sec.driver.invalidation)}`,
      `纪律：此区块是 LLM 结论，不是 packet 证据；不得写入 evidence_ids/opposing_ids，不得机械决定本品种方向。`
    ];
    return lines.join('\n');
  }
  if (sec.status === 'unknown') {
    return '状态：unknown —— 未找到板块级驱动证据（' + (sec.reason || '无') + '）。不得用个股驱动填补。';
  }
  if (sec.status === 'abstain_insufficient') {
    return '状态：abstain_insufficient —— ' + (sec.reason || '成员不足或结构不支持板块归因') + '。';
  }
  return '状态：' + sec.status + ' —— ' + (sec.reason || '未形成板块级异动') + '。';
}

function validateSectorDriverOutput(output, packets) {
  const errors = [];
  if (!output || !output.meta) {
    return { ok: false, errors: ['missing meta'] };
  }
  if (output.meta.mode !== 'sector-driver') errors.push('meta.mode must be sector-driver');
  if (!output.sectors || typeof output.sectors !== 'object') return { ok: false, errors: ['missing sectors'] };

  for (const [sectorId, packet] of Object.entries(packets)) {
    const entry = output.sectors[sectorId];
    if (!entry) {
      errors.push(`${sectorId}: missing entry`);
      continue;
    }
    if (entry.sector !== sectorId) errors.push(`${sectorId}: sector mismatch`);
    if (entry.signalDate !== packet.signalDate) errors.push(`${sectorId}: signalDate mismatch`);
    if (!VALID_STATUS.includes(entry.status)) errors.push(`${sectorId}: invalid status ${entry.status}`);
    if (!VALID_DIRECTION.includes(entry.direction_observed)) errors.push(`${sectorId}: invalid direction_observed`);
    if (entry.direction_observed !== packet.observed.direction) {
      errors.push(`${sectorId}: direction_observed ${entry.direction_observed} != observed ${packet.observed.direction}`);
    }
    if (!VALID_STRUCTURE.includes(entry.member_structure)) errors.push(`${sectorId}: invalid member_structure`);
    if (entry.relation_to_individual !== 'context_only') errors.push(`${sectorId}: relation_to_individual must be context_only`);

    if (entry.status === 'analyzed') {
      if (!entry.driver || typeof entry.driver.primary !== 'string' || entry.driver.primary.trim().length === 0) {
        errors.push(`${sectorId}: analyzed requires driver.primary`);
      }
      if (entry.driver) {
        if (!VALID_CATEGORY.includes(entry.driver.category)) errors.push(`${sectorId}: invalid driver.category`);
        if (!['high', 'medium', 'low'].includes(entry.driver.confidence)) errors.push(`${sectorId}: invalid driver.confidence`);
        if (!Array.isArray(entry.driver.evidence) || entry.driver.evidence.length === 0) {
          errors.push(`${sectorId}: analyzed requires >=1 evidence`);
        }
        if (!Array.isArray(entry.driver.invalidation) || entry.driver.invalidation.length === 0) {
          errors.push(`${sectorId}: analyzed requires >=1 invalidation`);
        }
      }
      if (entry.reason != null) errors.push(`${sectorId}: analyzed reason must be null`);
    } else {
      if (!entry.reason || typeof entry.reason !== 'string') errors.push(`${sectorId}: ${entry.status} requires reason`);
      if (entry.driver != null) errors.push(`${sectorId}: ${entry.status} requires driver=null`);
    }
  }
  return { ok: errors.length === 0, errors };
}

function parseOutputFromDoc(docText) {
  const m = String(docText).match(/```json\s*([\s\S]*?)\s*```/);
  if (!m) return null;
  try {
    return JSON.parse(m[1].trim());
  } catch {
    return null;
  }
}

module.exports = {
  buildSectorDriverPackets,
  renderSectorDriverPrompt,
  renderSectorDriverContextBlock,
  validateSectorDriverOutput,
  parseOutputFromDoc
};
