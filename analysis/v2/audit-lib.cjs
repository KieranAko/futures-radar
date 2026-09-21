// analysis/v2/audit-lib.cjs — 审计 LLM 契约与提示词构建
//
// 定位（用户裁定）：审计 LLM 不是裁判，不判输赢。它在六问第一遍独立推理落盘后，
// 读「链推理卡 × 六问输出 × 共同冻结事实」，只找语义冲突，把少量冲突点与针对性
// 追问交给六问 LLM 做最终综合。传导链 LLM 不接受追问——链入池后其工作已结束。
//
// 输入（audit-prompt-builder.cjs 组装）：
//   - outputs-v2.json（六问第一遍独立推理）
//   - 故事池 active 链的 reasoningCard + 节点验证进度
//   - data/news/<runId>.json 新闻快照（共同事实底座）
//   - packets-v2.json 关键市场事实（仅事实，不掺结论）
//
// 输出（LLM 手动写）：
//   - output/runs/<runId>/analyze/audit-findings.json
'use strict';

const path = require('node:path');
const { runDir } = require('../../shared/workspace.cjs');

const AUDIT_FINDINGS_SCHEMA = 'futures-radar-audit-findings/1';
const AUDIT_VERDICTS = ['aligned', 'conflict'];
const CONFLICT_DIMENSIONS = ['direction', 'driver', 'mechanism', 'timing', 'confidence', 'evidence'];
const MAX_CONFLICTS_PER_SYMBOL = 3;

function auditFindingsPath(runId) {
  return path.join(runDir(runId), 'analyze', 'audit-findings.json');
}

/**
 * 纯函数：校验审计 LLM 输出（只验形态与引用存在性，不判语义）。
 */
function validateAuditFindings(doc, { symbols = [], chainIds = [] } = {}) {
  const errors = [];
  const symSet = new Set(symbols);
  const chainSet = new Set(chainIds);
  if (!doc || doc.schema !== AUDIT_FINDINGS_SCHEMA) {
    errors.push(`schema 必须为 ${AUDIT_FINDINGS_SCHEMA}`);
    return { ok: false, errors };
  }
  if (!doc.runId || String(doc.runId).trim().length === 0) errors.push('runId 缺失');
  if (!Array.isArray(doc.findings)) {
    errors.push('findings 必须为数组');
    return { ok: false, errors };
  }
  for (const [i, f] of doc.findings.entries()) {
    const tag = `findings[${i}]`;
    if (!f || typeof f !== 'object') { errors.push(`${tag} 非对象`); continue; }
    if (!f.symbol || !symSet.has(f.symbol)) errors.push(`${tag}.symbol 缺失或不在本期六问品种集合内`);
    if (f.chainId == null || !chainSet.has(f.chainId)) errors.push(`${tag}.chainId 缺失或不是本期活跃链`);
    if (!AUDIT_VERDICTS.includes(f.verdict)) errors.push(`${tag}.verdict 必须为 ${AUDIT_VERDICTS.join('|')}`);
    const conflicts = Array.isArray(f.conflicts) ? f.conflicts : null;
    if (!conflicts) errors.push(`${tag}.conflicts 必须为数组`);
    if (f.verdict === 'aligned') {
      if (conflicts && conflicts.length > 0) errors.push(`${tag}: verdict=aligned 时 conflicts 必须为空`);
    } else if (f.verdict === 'conflict') {
      if (!conflicts || conflicts.length === 0) errors.push(`${tag}: verdict=conflict 时至少 1 个冲突点`);
      else if (conflicts.length > MAX_CONFLICTS_PER_SYMBOL) {
        errors.push(`${tag}: 每个品种冲突点最多 ${MAX_CONFLICTS_PER_SYMBOL} 个（少量追问原则）`);
      }
    }
    for (const [j, c] of (conflicts || []).entries()) {
      const ct = `conflicts[${j}]`;
      if (!c || !CONFLICT_DIMENSIONS.includes(c.dimension)) errors.push(`${tag}.${ct}.dimension 必须为 ${CONFLICT_DIMENSIONS.join('|')}`);
      if (!c.chainClaim || String(c.chainClaim).trim().length < 2) errors.push(`${tag}.${ct}.chainClaim 缺失`);
      if (!c.analysisClaim || String(c.analysisClaim).trim().length < 2) errors.push(`${tag}.${ct}.analysisClaim 缺失`);
      if (!c.question || String(c.question).trim().length < 2) errors.push(`${tag}.${ct}.question 缺失（须是给六问的具体追问）`);
      if (c.factIds !== undefined && !Array.isArray(c.factIds)) errors.push(`${tag}.${ct}.factIds 必须为数组`);
    }
  }
  return { ok: errors.length === 0, errors };
}

function newsLinesForSectors(newsDoc, sectors) {
  const wanted = new Set([...(sectors || []), 'macro']);
  const items = (newsDoc && Array.isArray(newsDoc.items) ? newsDoc.items : [])
    .filter((it) => (it.sectors || []).some((s) => wanted.has(s)));
  if (items.length === 0) return '（本期新闻快照无直接相关条目）';
  return items.map((it) =>
    `- [${it.id}] ${it.date} ${it.type} ${it.sectors.join('/')}：${it.title}。${it.summary}（来源 ${(it.sources || []).length} 条${it.singleSource ? '，单源' : ''}）`
  ).join('\n');
}

function chainCardBlock(chain) {
  const card = (chain && (chain.reasoningCard || (chain.definition && chain.definition.reasoningCard))) || null;
  const progress = (chain.nodes || []).map((n) =>
    `${n.id}(${n.label || ''}) 预期${n.expectation === 1 ? '↑' : n.expectation === -1 ? '↓' : '—'} 状态${n.status || 'pending'} 同向${n.sameStreak || 0}/3 反向${n.oppStreak || 0}/2`
  ).join('；');
  if (!card) {
    return `链 ${chain.chainId} 暂无 reasoningCard（审计应把该项标记为 evidence 维度的缺口，不得补写链主张）`;
  }
  const claim = card.claim || {};
  const mechs = (card.mechanisms || []).map((m) => `- ${m.edgeId}: ${m.why}`).join('\n');
  return [
    `链 ${chain.chainId}（${chain.sourceClass || 'unknown'}，状态 ${chain.status}${chain.provisional ? '·provisional' : ''}）`,
    `claim.source=${claim.source || '—'} claim.direction=${claim.direction ?? '—'} claim.path=${(claim.path || []).join('→')}`,
    'mechanisms:',
    mechs || '（无）',
    `assumptions: ${(card.assumptions || []).join('；') || '—'}`,
    `uncertainties: ${(card.uncertainties || []).join('；') || '—'}`,
    `falsifiers: ${(card.falsifiers || []).join('；') || '—'}`,
    `当前验证进度: ${progress}`,
  ].join('\n');
}

function sixOutputBlock(o) {
  if (!o) return '（六问输出缺失）';
  const cr = o.confidenceRationale || {};
  return [
    `direction=${o.direction || '—'} confidence=${o.confidence || '—'}${o.passReason ? ` passReason=${o.passReason}` : ''}`,
    `q1_driver.primary=${(o.q1_driver && o.q1_driver.primary) || '—'}`,
    `q1_driver.evidence=${(o.q1_driver && o.q1_driver.evidence) || '—'}`,
    `q2=${(o.q2_trendOrImpulse && o.q2_trendOrImpulse.assessment) || '—'}`,
    `q3_bias=${(o.q3_odds && o.q3_odds.bias) || '—'} summary=${(o.q3_odds && o.q3_odds.summary) || '—'}`,
    `q4=${((o.q4_confirmations || o.q4_confirmation || {}).signals || []).join('；') || '—'}`,
    `q5=${((o.q5_invalidation || {}).conditions || []).join('；') || '—'}`,
    `supporting=${(cr.supportingFactors || []).map((x) => x.note).join('；') || '—'}`,
    `opposing=${(cr.opposingFactors || []).map((x) => x.note).join('；') || '—'}`,
    `uncertainties=${(cr.uncertainties || []).join('；') || '—'}`,
  ].join('\n');
}

/**
 * 纯函数：生成审计 LLM 提示词（只给对质所需信息，不塞整条链结构）。
 * @param {object} ctx { runId, pairs:[{symbol, chain}], outputsBySymbol, newsDoc, packetsBySymbol }
 */
function buildAuditPrompt({ runId, pairs = [], outputsBySymbol = {}, newsDoc = null, packetsBySymbol = {} }) {
  const L = [];
  L.push(`# 审计任务（runId=${runId}）`);
  L.push('');
  L.push('你是审计 LLM，不是裁判，也不是决策者。六问 LLM 与传导链 LLM 各自独立完成了推理；你的唯一职责是：');
  L.push('1. 找两者之间的语义冲突（方向/驱动/机制/时滞/置信度/证据使用）；');
  L.push('2. 把每个冲突提炼成一句给六问 LLM 的具体追问；');
  L.push('3. 不判谁对谁错、不给新结论、不追问传导链——传导链入池后其职责已结束。');
  L.push('');
  L.push('纪律：');
  L.push('- 每品种最多 3 个冲突点；没有冲突就写 aligned，不要制造冲突；');
  L.push('- 冲突点只引用双方原文与必要事实 id，不重述整条链；');
  L.push('- 六问的方向与驱动若只是用词不同但语义一致，不算冲突；');
  L.push('- 链的当前验证进度（同向 x/3）只用于评估该主张的证据成熟度，不是裁决依据。');
  L.push('');
  L.push('## 共同事实底座（新闻快照）');
  L.push('');
  if (newsDoc && Array.isArray(newsDoc.items)) {
    L.push(newsDoc.items.map((it) =>
      `- [${it.id}] ${it.date} ${it.type} ${(it.sectors || []).join('/')}：${it.title}。${it.summary}`
    ).join('\n'));
  } else {
    L.push('（本期无新闻快照）');
  }
  L.push('');
  L.push('## 待审计对（链推理卡 × 六问独立推理）');
  L.push('');
  if (pairs.length === 0) L.push('（没有活跃链与六问品种的交集，无需审计）');
  for (const { symbol, chain } of pairs) {
    L.push(`### ${symbol}`);
    L.push('');
    L.push('【传导链推理卡】');
    L.push(chainCardBlock(chain));
    L.push('');
    L.push('【六问独立推理】');
    L.push(sixOutputBlock(outputsBySymbol[symbol]));
    const p = packetsBySymbol[symbol];
    if (p) {
      L.push('');
      L.push('【关键市场事实（仅事实）】');
      L.push(`close=${p.price_data && p.price_data.close} ma20=${p.price_data && p.price_data.ma20} sector=${JSON.stringify(p.sector_context)}`);
    }
    L.push('');
  }
  L.push('## 输出 JSON（写入 analyze/audit-findings.json）');
  L.push('```json');
  L.push('{');
  L.push(`  "schema": "${AUDIT_FINDINGS_SCHEMA}",`);
  L.push('  "runId": "<runId>",');
  L.push('  "generatedAt": "<ISO>",');
  L.push('  "findings": [');
  L.push('    {');
  L.push('      "symbol": "RB0", "chainId": "CH-...", "verdict": "aligned|conflict",');
  L.push('      "conflicts": [');
  L.push('        { "dimension": "driver|direction|mechanism|timing|confidence|evidence", "chainClaim": "链原文", "analysisClaim": "六问原文", "question": "给六问的具体追问", "factIds": ["news-..."] }');
  L.push('      ]');
  L.push('    }');
  L.push('  ]');
  L.push('}');
  L.push('```');
  L.push('');
  L.push('verdict=aligned 时 conflicts 必须为空数组；verdict=conflict 时 1..3 个冲突点。');
  return L.join('\n');
}

module.exports = {
  AUDIT_FINDINGS_SCHEMA,
  AUDIT_VERDICTS,
  CONFLICT_DIMENSIONS,
  MAX_CONFLICTS_PER_SYMBOL,
  auditFindingsPath,
  validateAuditFindings,
  buildAuditPrompt,
  chainCardBlock,
  sixOutputBlock,
  newsLinesForSectors,
};
