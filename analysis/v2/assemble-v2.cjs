// analysis/v2/assemble-v2.cjs — O1：把单轮合并输出组装为生产兼容结构
//
// 输入: outputs-v2.json（LLM 单轮输出）+ prefill-v2.json + packets-v2.json
// 输出: analyze/analysis-v2.json（六问，生产结构）+ analyze/reasoning-results-v2.json + analyze/sector-driver-v2.json
//        + analyze/equivalence-v2.json（六问等价性 + selfCheck 机器校验）
//
// 用法: node analysis/v2/assemble-v2.cjs --runId <runId>
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const EL = path.join(ROOT, 'research', 'archive-experiment-line', 'experiment-line'); // V2：归档保留，仅供历史工具兼容
const { runDir } = require(path.join(ROOT, 'shared', 'workspace.cjs'));
const { validateQ4Semantics } = require(path.join(ROOT, 'analysis', 'strategy', 'semantic-fact-validate.cjs'));
const { loadLedger, loadChain, isActive } = require(path.join(ROOT, 'stories', 'lib', 'story-chain.cjs'));
const auditLib = require('./audit-lib.cjs');
const reconLib = require('./reconciliation-lib.cjs');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function sha256(s) {
  return 'sha256:' + crypto.createHash('sha256').update(s).digest('hex');
}

function validateGrounding(evidenceIds, packet) {
  const fields = new Set();
  const walk = (obj, prefix) => {
    for (const [k, v] of Object.entries(obj || {})) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, p);
      else fields.add(p);
    }
  };
  walk(packet, '');
  return evidenceIds.filter((id) => !fields.has(id) && ![...fields].some((f) => f.startsWith(id + '.')));
}

const CONFIDENCE_VALUES = ['high', 'medium', 'low'];
const TEXT_REF_PREFIXES = ['q1_driver', 'q3_odds', 'cost_anchor', 'prevAnalysisCache', 'mechanismRef'];

/**
 * 权威错位修复（AUTH-03/05/06/08）：
 * LLM 决策字段缺失/非法时 fail-closed，不提供机器默认值。
 */
function validateLlmOutputShape(o) {
  const errors = [];
  const sym = o && o.symbol ? o.symbol : '?';
  if (!o) return { ok: false, errors: ['LLM output is missing'] };
  if (!CONFIDENCE_VALUES.includes(o.confidence)) errors.push(`${sym}: confidence 缺失或非法（须为 high|medium|low）`);
  if (o.direction === 'pass' && !String(o.passReason || '').trim()) errors.push(`${sym}: direction=pass 必须给出 passReason`);
  if (!o.q1_driver || !String(o.q1_driver.primary || '').trim()) errors.push(`${sym}: q1_driver.primary 缺失`);
  if (!o.q2_trendOrImpulse || !String(o.q2_trendOrImpulse.assessment || '').trim()) errors.push(`${sym}: q2_trendOrImpulse.assessment 缺失`);
  if (!o.q3_odds || !['bullish', 'bearish', 'neutral'].includes(o.q3_odds.bias)) errors.push(`${sym}: q3_odds.bias 缺失或非法`);
  if (!o.q4_confirmations || !['long', 'short'].includes(o.q4_confirmations.selected)
    || !Array.isArray(o.q4_confirmations.signals) || o.q4_confirmations.signals.length === 0) {
    errors.push(`${sym}: q4_confirmations 缺失（selected 须为 long|short 且 signals 非空）`);
  }
  if (!Array.isArray(o.q5_invalidation?.conditions) || o.q5_invalidation.conditions.length === 0) {
    errors.push(`${sym}: q5_invalidation.conditions 缺失或为空`);
  }
  if (!String(o.q6_eventRisk || '').trim()) errors.push(`${sym}: q6_eventRisk 缺失`);
  if (!o.mechanismRef || typeof o.mechanismRef.family !== 'string') errors.push(`${sym}: mechanismRef.family 缺失`);
  return { ok: errors.length === 0, errors };
}

function readOptionalJson(file) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

/**
 * 装载审计态：audit-findings.json 可选（向后兼容旧 run）；
 * 一旦存在 conflict 品种，reconciliation 修订缺一即 fail-closed，不允许机器兜底。
 */
function loadAuditState(runPath, outputSymbols) {
  const auditFile = path.join(runPath, 'analyze', 'audit-findings.json');
  const auditDoc = readOptionalJson(auditFile);
  if (!auditDoc) return { mode: 'unavailable', findingsBySymbol: new Map(), reconBySymbol: new Map(), conflictSymbols: [] };

  const activeChainIds = loadLedger().chains
    .filter((c) => isActive(c.status))
    .map((c) => c.chainId)
    .filter(Boolean);
  const check = auditLib.validateAuditFindings(auditDoc, { symbols: outputSymbols, chainIds: activeChainIds });
  if (!check.ok) {
    console.error('FATAL: audit-findings.json 校验失败');
    for (const e of check.errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  const findingsBySymbol = new Map((auditDoc.findings || []).map((f) => [f.symbol, f]));
  const conflictSymbols = (auditDoc.findings || [])
    .filter((f) => f.verdict === 'conflict')
    .map((f) => f.symbol);

  const reconFile = path.join(runPath, 'analyze', 'outputs-v2-reconciliation.json');
  const reconDoc = readOptionalJson(reconFile);
  let reconBySymbol = new Map();
  if (conflictSymbols.length > 0) {
    if (!reconDoc) {
      console.error('FATAL: 存在 conflict 品种但缺少 outputs-v2-reconciliation.json（六问第二遍未完成）');
      process.exit(1);
    }
    const reconCheck = reconLib.validateReconciliation(reconDoc, { symbols: conflictSymbols });
    if (!reconCheck.ok) {
      console.error('FATAL: outputs-v2-reconciliation.json 校验失败');
      for (const e of reconCheck.errors) console.error(`  - ${e}`);
      process.exit(1);
    }
    reconBySymbol = new Map((reconDoc.revisions || []).map((r) => [r.symbol, r]));
    for (const sym of conflictSymbols) {
      if (!reconBySymbol.has(sym)) {
        console.error(`FATAL: conflict 品种 ${sym} 缺少六问第二遍修订`);
        process.exit(1);
      }
    }
  }
  return { mode: 'active', findingsBySymbol, reconBySymbol, conflictSymbols };
}

/**
 * 把六问第二遍修订增量合并回第一遍输出（只覆盖明确出现的字段）。
 */
function applyRevisions(o, rev) {
  const next = { ...o };
  if (!rev || !rev.revisions) return next;
  for (const [k, v] of Object.entries(rev.revisions)) next[k] = v;
  return next;
}

/**
 * 方向置信度护栏（终稿方案）：
 *   - 等级只由 LLM 整链判断；确定性只校验枚举、pass、driver=unknown、rationale 完整性/grounding。
 *   - 旧 run 无 rationale → 允许（标记 legacy），但输出不携带 rationale。
 */
function validateConfidenceRationale(output, packet) {
  const errors = [];
  const rationale = output && output.confidenceRationale ? output.confidenceRationale : null;
  const symbol = output && output.symbol ? output.symbol : '?';
  if (output.direction !== 'pass') {
    if (!CONFIDENCE_VALUES.includes(output.confidence)) {
      errors.push(`${symbol}: invalid confidence ${output.confidence}`);
    }
    if (output.confidence === 'high' && output.q1_driver && output.q1_driver.primary === 'unknown') {
      errors.push(`${symbol}: q1_driver.primary=unknown 不得为 high`);
    }
  }
  if (!rationale) return { rationale: null, errors };

  for (const key of ['supportingFactors', 'opposingFactors', 'uncertainties']) {
    if (!Array.isArray(rationale[key])) errors.push(`${symbol}: confidenceRationale.${key} must be array`);
  }
  const factors = [...(rationale.supportingFactors || []), ...(rationale.opposingFactors || [])];
  if (factors.length === 0) errors.push(`${symbol}: confidenceRationale 支持/反向至少一侧非空`);
  for (const f of factors) {
    if (!f || !f.note || typeof f.note !== 'string') errors.push(`${symbol}: confidence factor needs note`);
    if (f.type !== 'numeric' && f.type !== 'text') errors.push(`${symbol}: confidence factor type must be numeric|text`);
    if (!f.ref || typeof f.ref !== 'string') errors.push(`${symbol}: confidence factor needs ref`);
    else if (f.type === 'numeric') {
      const bad = validateGrounding([f.ref], packet);
      if (bad.length) errors.push(`${symbol}: confidence factor ref grounding failed for ${f.ref}`);
    } else if (!TEXT_REF_PREFIXES.some((p) => f.ref === p || f.ref.startsWith(`${p}.`))) {
      errors.push(`${symbol}: text ref ${f.ref} 不在允许范围`);
    }
  }
  return { rationale, errors };
}

/**
 * 把 FinCoT 输出中的 costAnchorRef 绑定到 packet.cost_anchor 证据链。
 * used=true 时必须给出可 grounding 的 evidenceIds（cost_anchor.*）。
 */
function buildCostAnchorRef(output, packet) {
  const ref = output && output.costAnchorRef ? output.costAnchorRef : {};
  const ca = packet && packet.cost_anchor ? packet.cost_anchor : null;
  if (!ref.used && !ca) return { ref: null, error: null };
  if (ref.used && !ca) {
    return { ref: null, error: `${output.symbol}: costAnchorRef.used=true 但 packet.cost_anchor 缺失` };
  }
  if (!ref.used && ca) return { ref: null, error: null };
  const evidenceIds = Array.isArray(ref.evidenceIds) ? ref.evidenceIds.filter((s) => typeof s === 'string') : [];
  const routeRefs = Array.isArray(ref.routeRefs) ? ref.routeRefs : [];
  if (evidenceIds.length === 0) {
    return { ref: null, error: `${output.symbol}: costAnchorRef.used=true 但 evidenceIds 为空（必须引用 cost_anchor.*）` };
  }
  const bad = validateGrounding(evidenceIds, { cost_anchor: ca });
  if (bad.length) {
    return { ref: null, error: `${output.symbol}: costAnchorRef grounding failed for ${bad.join(',')}` };
  }
  return {
    error: null,
    ref: {
      recordId: ca.recordId,
      used: true,
      routeRefs,
      evidenceIds,
      problems: Array.isArray(ca.problems) ? ca.problems.map((x) => x.code) : [],
      confidence: ca.confidence,
      asOf: ca.asOf
    }
  };
}

// 生产 sector-driver 契约适配（只影响 --as-production）：
//   - v2 P1 的 status='ok' 映射为生产渲染器认识的 'analyzed'
//   - v2 P1 只覆盖聚焦板块，非聚焦板块补齐为 'unknown' / 'abstain_insufficient'
//     （成员不足 3 个按生产门禁 abstain），保证驱动线索列不再出现空白 '—'
function buildProductionSectorSectors({ signalDate, v2Sectors = {}, sectorSnapshot = {} }) {
  const normDir = (d) => (['up', 'down', 'flat'].includes(d) ? d : 'flat');
  const allIds = new Set([
    ...Object.keys((sectorSnapshot && sectorSnapshot.sectors) || {}),
    ...Object.keys(v2Sectors || {}),
  ]);
  const sectors = {};
  for (const name of allIds) {
    const s = v2Sectors[name] || null;
    const snap = ((sectorSnapshot && sectorSnapshot.sectors) || {})[name] || {};
    const primary = s && s.driver ? s.driver.primary : null;
    const hasDriver = typeof primary === 'string' && primary.trim() !== '' && primary.trim() !== 'unknown';
    const memberCount = Number.isFinite(snap.members)
      ? snap.members
      : Array.isArray(snap.members)
        ? snap.members.length
        : null;
    if (hasDriver) {
      sectors[name] = {
        sector: name,
        signalDate,
        status: 'analyzed',
        direction_observed: normDir(s.direction),
        member_structure: 'broad_based',
        driver: { primary, confidence: s.driver.confidence || 'medium' },
        reason: null,
        relation_to_individual: 'context_only',
      };
    } else if (memberCount != null && memberCount < 3) {
      sectors[name] = {
        sector: name,
        signalDate,
        status: 'abstain_insufficient',
        direction_observed: normDir(snap.direction || (s && s.direction)),
        member_structure: 'not_enough_members',
        driver: null,
        reason: `板块成员仅 ${memberCount} 个（不足 3 个），按门禁不做板块级归因`,
        relation_to_individual: 'context_only',
      };
    } else {
      sectors[name] = {
        sector: name,
        signalDate,
        status: 'unknown',
        direction_observed: normDir(snap.direction || (s && s.direction)),
        member_structure: 'broad_based',
        driver: null,
        reason: '非本 run 聚焦板块（analyze v2 P1 未覆盖），无板块级驱动证据，不强行归因',
        relation_to_individual: 'context_only',
      };
    }
  }
  return sectors;
}

function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--runId');
  const runId = i >= 0 ? args[i + 1] : null;
  if (!runId) throw new Error('--runId required');
  const asProduction = args.includes('--as-production');
  // 生产契约沿用 q4_confirmation（单数，report/build-model.cjs 读取）；实验线自用版保持 q4_confirmations（复数）
  const q4Key = asProduction ? 'q4_confirmation' : 'q4_confirmations';
  const runPath = runDir(runId);
  const outputs = readJson(path.join(runPath, 'analyze', 'outputs-v2.json'));
  const prefill = readJson(path.join(runPath, 'analyze', 'prefill-v2.json')).prefill;
  const packets = readJson(path.join(runPath, 'analyze', 'packets-v2.json')).packets;
  const signalDate = packets[Object.keys(packets)[0]].signalDate;

  // 审计态（可选向后兼容）：audit-findings 存在时，conflict 品种必须有六问第二遍修订。
  const outputSymbols = (outputs.results || []).map((o) => o.symbol);
  const auditState = loadAuditState(runPath, outputSymbols);

  // Q4 语义事实校验：现价在价值区内不得使用“回踩”，空头镜像。
  const q4Sem = validateQ4Semantics(outputs, packets);
  if (!q4Sem.ok) {
    console.error('FATAL: Q4 semantic-fact validation failed:');
    for (const e of q4Sem.errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  const analyses = [];
  const reasoningResults = [];
  const issues = [];
  for (const orig of outputs.results) {
    // 六问两遍：第一遍独立推理（orig）；conflict 品种合并第二遍修订增量（o）。
    const auditFinding = auditState.findingsBySymbol.get(orig.symbol) || null;
    const reconRev = auditState.reconBySymbol.get(orig.symbol) || null;
    if (auditFinding && auditFinding.verdict === 'conflict' && !reconRev) {
      console.error(`FATAL: ${orig.symbol} 是 conflict 品种但缺少修订（不应到达这里）`);
      process.exit(1);
    }
    const o = applyRevisions(orig, reconRev);
    const auditRef = auditFinding
      ? {
          artifactId: 'audit-findings-json',
          verdict: auditFinding.verdict,
          chainId: auditFinding.chainId,
          conflictCount: (auditFinding.conflicts || []).length,
          impact: reconRev ? reconRev.auditImpact : null,
          response: reconRev ? reconRev.auditResponse : null,
          conflicts: (auditFinding.conflicts || []).map((c) => ({
            dimension: c.dimension,
            chainClaim: c.chainClaim,
            analysisClaim: c.analysisClaim,
            question: c.question,
            factIds: c.factIds || [],
          })),
        }
      : null;
    const p = packets[o.symbol];
    if (!p) {
      issues.push(`${o.symbol}: no packet`);
      continue;
    }
    const pf = prefill[o.symbol];
    const direction = o.direction === 'long' ? 'bullish' : o.direction === 'short' ? 'bearish' : 'neutral';
    const confCheck = validateConfidenceRationale(o, p);
    if (confCheck.errors.length) {
      console.error('FATAL: confidence guardrails failed:');
      for (const e of confCheck.errors) console.error(`  - ${e}`);
      process.exit(1);
    }
    const shapeCheck = validateLlmOutputShape(o);
    if (!shapeCheck.ok) {
      console.error('FATAL: LLM output shape failed（决策字段缺失，不允许机器兜底）:');
      for (const e of shapeCheck.errors) console.error(`  - ${e}`);
      process.exit(1);
    }
    const costAnchor = buildCostAnchorRef(o, p);
    if (costAnchor.error) issues.push(costAnchor.error);
    // 六问组装：LLM 写 Q1/Q2/Q3/Q4/Q5/q6_eventRisk；Q6 数值事实来自 deterministic prefill。
    const q4 = o.q4_confirmations;
    const q5 = o.q5_invalidation;
    const analysesEntry = {
      symbol: o.symbol,
      name: p.name,
      storyChainId: p.story_chain_id || null, // V2 前向盖章：故事席位血缘
      reasoningRef: { artifactId: 'reasoning-results-v2-json', packetHash: sha256(JSON.stringify(p)), arm: 'fincot' },
      auditRef,
      auditImpact: (auditRef && auditRef.impact) || null,
      direction,
      confidence: o.confidence,
      confidenceRationale: confCheck.rationale,
      override: null,
      costAnchorRef: costAnchor.ref,
      q1_driver: o.q1_driver,
      q2_trendOrImpulse: {
        assessment: o.q2_trendOrImpulse.assessment,
        provenance: { artifactId: 'outputs-v2-json', field: 'q2_trendOrImpulse', kind: 'llm' },
      },
      q3_odds: o.q3_odds,
      [q4Key]: { signals: q4.signals },
      q5_invalidation: { conditions: q5.conditions },
      q6_risks: {
        limitDistance: pf.q6.limitDistance,
        overnightGap: pf.q6.overnightGap,
        margin: `合约价值约 ${pf.q6.contractValue} 元/手，保证金按 5%-15% 估算（${pf.q6.marginRange.low}-${pf.q6.marginRange.high}）`,
        eventRisk: o.q6_eventRisk,
        tailGap3d: pf.q6.tail3dP95ReversePct,
        provenance: { artifactId: 'prefill-v2', kind: 'deterministic-facts', eventRiskKind: 'llm' },
      },
      termStructure: p.term_structure,
    };
    analyses.push(analysesEntry);

    const self = o.selfCheck || {};
    const badIds = validateGrounding((self.evidenceCheck && self.evidenceCheck.evidenceIds) || [], p);
    if (badIds.length) issues.push(`${o.symbol}: grounding failed for ${badIds.join(',')}`);
    if (!self.unitCheck?.pass) issues.push(`${o.symbol}: unitCheck failed`);
    if (!self.opposingCheck?.pass) issues.push(`${o.symbol}: opposingCheck failed`);

    reasoningResults.push({
      symbol: o.symbol,
      packetHash: sha256(JSON.stringify(p)),
      arm: 'fincot',
      status: badIds.length ? 'grounding_degraded' : 'accepted',
      result: {
        symbol: o.symbol,
        signalDate,
        strategy: 'fincot',
        direction: o.direction,
        confidence: o.confidence,
        pass_reason: o.direction === 'pass' ? o.passReason : null,
        evidence_ids: (self.evidenceCheck && self.evidenceCheck.evidenceIds) || [],
        opposing_ids: (self.opposingCheck && self.opposingCheck.opposing) || [],
        reasoning_summary: o.q3_odds?.summary || '',
        invalidate_if: q5.conditions,
        branch_status: { regime: 'available', macro_fundamental: 'available', position_flow: 'available' },
        mechanismRef: o.mechanismRef,
        cost_anchor_ref: costAnchor.ref,
        audit_impact: (auditRef && auditRef.impact) || null,
        audit_verdict: (auditRef && auditRef.verdict) || null,
      },
    });
  }

  const analysis = {
    meta: { runId, analyzedAt: `${signalDate}T00:00:00Z`, candidateCount: analyses.length, mode: 'daily-v2', note: 'analyze candidate v2：六问两遍——第一遍独立推理；审计 LLM 只提炼冲突点，conflict 品种经第二遍修订增量合并（auditImpact 留痕）。Q6 数值事实确定性预填并带 provenance（O4）；所有输出不构成投资建议。' },
    analyses,
  };
  const reasoning = {
    meta: { mode: 'daily', signalDate, generatedAt: new Date().toISOString(), promptVersion: 'v2-single-pass-fincot', model: { provider: 'analyze-v2', modelId: 'single-pass', temperature: 0, maxTokens: 2048 } },
    results: reasoningResults,
  };

  const outDir = path.join(runPath, 'analyze');
  // 生产兼容文件：promote 后 analysis.json / reasoning-results.json 写 run 顶层（生产布局），
  // 实验线自用版本写 analyze/ 子目录（analysis-v2.json）
  writeJson(path.join(asProduction ? runPath : outDir, asProduction ? 'analysis.json' : 'analysis-v2.json'), analysis);
  writeJson(path.join(asProduction ? runPath : outDir, asProduction ? 'reasoning-results.json' : 'reasoning-results-v2.json'), reasoning);
  if (asProduction) {
    const outputs2 = readJson(path.join(outDir, 'outputs-v2.json'));
    // 生产 pipeline analyze 阶段要求的证据冻结产物（v2 从 packets-v2 直接转换）
    writeJson(path.join(runPath, 'evidence-packets.json'), {
      schema: 'futures-radar-evidence-packets/1',
      meta: { runId, signalDate, generatedAt: new Date().toISOString(), mode: 'analyze-v2' },
      packets,
    });
    const sectorSnapshot = readJson(path.join(runPath, 'sector-snapshot.json'));
    const sectorDriver = {
      meta: { runId, signalDate, generatedAt: new Date().toISOString(), mode: 'sector-driver' },
      sectors: buildProductionSectorSectors({
        signalDate,
        v2Sectors: outputs2.sectors || {},
        sectorSnapshot,
      }),
    };
    writeJson(path.join(runPath, 'sector-driver.json'), sectorDriver);
  }

  const equivalence = {
    schema: 'futures-radar-analyze-v2-equivalence/1',
    runId,
    generatedAt: new Date().toISOString(),
    sixQuestions: {
      q1: analyses.every((a) => a.q1_driver?.primary),
      q2: analyses.every((a) => a.q2_trendOrImpulse?.assessment),
      q3: analyses.every((a) => a.q3_odds?.bias),
      q4: analyses.every((a) => Array.isArray(a[q4Key]?.signals)),
      q5: analyses.every((a) => Array.isArray(a.q5_invalidation?.conditions)),
      q6: analyses.every((a) => a.q6_risks?.margin),
    },
    grounding: issues.length === 0,
    audit: {
      mode: auditState.mode,
      conflictCount: auditState.conflictSymbols ? auditState.conflictSymbols.length : 0,
      revisedDriver: analyses.filter((a) => a.auditImpact === 'revised_driver').length,
      revisedDirection: analyses.filter((a) => a.auditImpact === 'revised_direction').length,
      keptWithReasons: analyses.filter((a) => a.auditImpact === 'kept_with_reasons').length,
    },
    issues,
    mechanismRefCoverage: reasoningResults.filter((r) => r.result.mechanismRef?.family !== 'none').length,
    costAnchorCoverage: reasoningResults.filter((r) => r.result.cost_anchor_ref?.used).length,
    costAnchorEvidenceGrounded: analyses.every((a) => !a.costAnchorRef || a.costAnchorRef.evidenceIds.length > 0),
    note: '六问字段须能从四卡无损恢复；grounding fail-closed；costAnchorRef.used=true 时必须引用 cost_anchor.* 证据',
  };
  writeJson(path.join(outDir, 'equivalence-v2.json'), equivalence);
  console.log(`analysis-v2: ${analyses.length} symbols; grounding=${equivalence.grounding}; issues=${issues.length}`);
  for (const iss of issues) console.log(`  ISSUE ${iss}`);
  return { analysis, reasoning, equivalence };
}

if (require.main === module) main();
module.exports = {
  main,
  validateGrounding,
  buildProductionSectorSectors,
  buildCostAnchorRef,
  validateConfidenceRationale,
  validateLlmOutputShape,
  loadAuditState,
  applyRevisions,
};
