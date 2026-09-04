// report/render-markdown.cjs — Stage 5C: Markdown Renderer
// Phase 8-A implementation
//
// Responsibility: Template-driven markdown generation from report-model.json
// - 主报告：结论速览 + 机会分析 + 交易策略（决策优先，只放结论与关键价位）
// - 附录：市场与筛选明细 / 机会证据链 / 证伪反馈明细 / 方法与数据说明（全量证据，全展开）
// - Format tables (Top 10/filter decisions/price ranges)
// - Generate data quality warnings by rules (degraded/correctionCount/divergencePct)
// - Display judgment change annotations (assessmentChanged)
// - Use "—" for missing values
//
// FORBIDDEN:
// - Adding or modifying data
// - Calling LLM
// - Recalculating numeric values

const fs = require('fs');
const path = require('path');
const { runtimeRoot } = require('../lib/workspace.cjs');
const { renderFreshnessCard } = require('./freshness.cjs');

// ── CLI ──────────────────────────────────────────────────────
const args = process.argv.slice(2);
function flagVal(flag) {
  const i = args.indexOf(flag);
  return i === -1 ? null : args[i + 1];
}

const runId = flagVal('--runId');
if (!runId) {
  console.error('FATAL: --runId required');
  process.exit(1);
}

const RUN_DIR = path.join(runtimeRoot, 'runs', runId);

// ── Helpers ──────────────────────────────────────────────────
function readJSON(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  const content = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(content);
}

function fmt(val, decimals = 2) {
  if (val === null || val === undefined) return '—';
  if (typeof val === 'number') return val.toFixed(decimals);
  return val;
}

function fmtPct(val, decimals = 1) {
  if (val === null || val === undefined) return '—';
  return `${val.toFixed(decimals)}%`;
}

function fmtRange(range) {
  if (!range || range.length !== 2) return '—';
  return `[${fmt(range[0])}, ${fmt(range[1])}]`;
}

function fmtMacroValue(value, disp) {
  const v = fmt(value, disp.decimals);
  if (disp.unit === '%') return `${v}%`;
  if (disp.unit === '汇率') return v;
  return disp.unit ? `${v}${disp.unit}` : v;
}

function directionSymbol(dir) {
  if (dir === 'up') return '↑';
  if (dir === 'down') return '↓';
  return '→';
}

function confidenceLabel(conf) {
  if (conf === 'high') return '高';
  if (conf === 'medium') return '中';
  if (conf === 'low') return '低';
  return '—';
}

function directionLabel(dir) {
  if (dir === 'bullish') return '看多';
  if (dir === 'bearish') return '看空';
  if (dir === 'neutral') return '观望';
  return '—';
}

const trimEndPunct = (s) => (s || '').replace(/[。；;.\s]+$/u, '');

// ── Stage 5C Entry ───────────────────────────────────────────
console.log('=== Stage 5C: Markdown Renderer ===');
console.log(`runId: ${runId}`);
console.log(`runDir: ${RUN_DIR}\n`);

// ── Load report-model.json ───────────────────────────────────
console.log('[1/6] Loading report-model.json...');
const modelPath = path.join(RUN_DIR, 'report-model.json');
const model = readJSON(modelPath);
console.log(`  ✓ Loaded ${model.opportunities.length} opportunities`);

// 成本锚快照（由文件库主档投影，见 analyze/v2/cost-anchor/；缺失时行内不展示）
const costAnchorPath = path.join(RUN_DIR, 'cost-anchor.json');
const costAnchor = fs.existsSync(costAnchorPath) ? readJSON(costAnchorPath) : null;

function costAnchorEntry(symbol) {
  return costAnchor && Array.isArray(costAnchor.symbols)
    ? costAnchor.symbols.find((s) => s.symbol === symbol)
    : null;
}

function costAnchorLines(symbol) {
  const entry = costAnchorEntry(symbol);
  if (!entry || entry.status === 'unavailable' || entry.confidence === 'unknown') return [];
  const lines = [];
  const conf = confidenceLabel(entry.confidence);
  const routes = Array.isArray(entry.routes) && entry.routes.length > 0 ? entry.routes : [];
  if (routes.length > 0) {
    const parts = routes.map((r) => r.status === 'unknown'
      ? `${r.route} unknown`
      : `${r.route} ${fmt(r.valueLow, 0)}–${fmt(r.valueHigh, 0)}${r.unit || entry.unit || ''}${r.confidence ? `（${confidenceLabel(r.confidence)}）` : ''}`);
    lines.push(`**成本锚**（asOf ${entry.asOf}, ${conf}置信）: ${entry.indicator} | ${parts.join(' | ')}`);
  } else {
    const range = Number.isFinite(entry.valueLow) && Number.isFinite(entry.valueHigh)
      ? `${fmt(entry.valueLow, 0)}–${fmt(entry.valueHigh, 0)}${entry.unit || ''}`
      : '—';
    lines.push(`**成本锚**（asOf ${entry.asOf}, ${conf}置信）: ${entry.indicator} ${range}（来源主档 ${entry.recordId}）`);
  }
  const problems = Array.isArray(entry.problems) ? entry.problems : [];
  if (problems.length > 0) {
    const codes = problems.map((p) => p.code).join('；');
    lines.push(`> ⚠️ 成本锚结构问题: ${codes}。该区间不是单一成本线，已保留原始证据供判断。`);
  }
  return lines;
}

const macro = model.macro;

function sectorDriverClue(sectorId) {
  const entry = model.sectorDriver && model.sectorDriver.sectors ? model.sectorDriver.sectors[sectorId] : null;
  if (!entry) return '—';
  if (entry.status === 'analyzed' && entry.driver) {
    return `${entry.driver.primary}（${confidenceLabel(entry.driver.confidence)}置信）`;
  }
  if (entry.status === 'unknown') return '无明确板块驱动';
  if (entry.status === 'abstain_insufficient') return '成员不足，不判定';
  if (entry.status === 'not_moved') return '未形成板块异动';
  return '—';
}

function spotBasisLine(opp) {
  if (!opp.spotBasis || opp.spotBasis.status === 'unavailable') return null;
  const b = opp.spotBasis;
  const sourceLabel = b.source === 'mysteel' ? '现货折盘面（Mysteel）' : '市场现货价（生意社）';
  const basis = b.basis != null ? `${b.basis > 0 ? '+' : ''}${fmt(b.basis, 1)}` : '—';
  const rate = b.basisRate != null ? `${b.basisRate > 0 ? '+' : ''}${fmt(b.basisRate * 100, 2)}%` : '—';
  const meaning = b.source === 'mysteel'
    ? (b.basisRate != null && b.basisRate < 0 ? '期货升水，追多安全边际较差' : b.basisRate != null && b.basisRate > 0 ? '现货升水，期货贴水' : '基差接近平水')
    : '市场综合价，不作为交割基差';
  return `${sourceLabel} ${fmt(b.spotAdjustedPrice != null ? b.spotAdjustedPrice : b.spotPrice, 1)}；基差 ${basis}；基差率 ${rate} — ${meaning}`;
}

function coreLogic(opp) {
  const parts = [];
  const q3 = opp.thesis?.odds?.reasoning;
  if (q3) parts.push(trimEndPunct(q3));
  const basisRate = opp.spotBasis?.basisRate;
  if (basisRate != null && opp.spotBasis?.source === 'mysteel') {
    parts.push(basisRate < 0 ? `期货升水 ${Math.abs(basisRate * 100).toFixed(1)}%` : `现货升水 ${Math.abs(basisRate * 100).toFixed(1)}%`);
  }
  return parts.join('；');
}

// ── Load strategy-plan.json（渲染结论速览/机会分析前需要 plan 数据）──
console.log('[2/6] Loading strategy-plan.json...');
const { renderStrategySection, renderFeedbackAppendix } = require('./render-strategy-section.cjs');
const strategyPlanPath = path.join(RUN_DIR, 'strategy-plan.json');
let strategyPlan = null;
let strategySection = null;
let feedbackAppendix = null;
if (fs.existsSync(strategyPlanPath)) {
  try {
    strategyPlan = JSON.parse(fs.readFileSync(strategyPlanPath, 'utf8'));
    if (strategyPlan && Array.isArray(strategyPlan.plans) && strategyPlan.plans.length > 0) {
      const library = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'strategies', 'strategy-library.json'), 'utf8'));
      const feedbackPath = path.join(RUN_DIR, 'strategy-feedback.json');
      const feedback = fs.existsSync(feedbackPath) ? JSON.parse(fs.readFileSync(feedbackPath, 'utf8')) : null;
      const familyEvidencePath = path.join(__dirname, '..', 'strategies', 'family-evidence.json');
      const familyEvidence = fs.existsSync(familyEvidencePath) ? JSON.parse(fs.readFileSync(familyEvidencePath, 'utf8')) : null;
      const forwardLedgerPath = path.join(__dirname, '..', 'strategies', 'forward-ledger.json');
      const forwardLedger = fs.existsSync(forwardLedgerPath) ? JSON.parse(fs.readFileSync(forwardLedgerPath, 'utf8')) : null;
      const closeMap = Object.fromEntries(model.opportunities.map((o) => [o.symbol, o.marketFacts && o.marketFacts.close]));
      strategySection = renderStrategySection(strategyPlan, library, familyEvidence, closeMap);
      feedbackAppendix = renderFeedbackAppendix(feedback, forwardLedger, strategyPlan.meta && strategyPlan.meta.runId);
      console.log(`  ✓ 交易策略板块: rendered (${strategyPlan.plans.length} plans, ${strategySection.length} chars)`);
    } else {
      console.log('  - 交易策略板块: strategy-plan.json 为空，跳过');
    }
  } catch (err) {
    console.warn(`  - 交易策略板块: 跳过（${err.message}）`);
  }
} else {
  console.log('  - 交易策略板块: strategy-plan.json 不存在，跳过');
}

const planMap = new Map((strategyPlan && Array.isArray(strategyPlan.plans) ? strategyPlan.plans : []).map((p) => [p.symbol, p]));
const executionLabel = (s) => (s === 'executable' ? '✅ 可执行' : s === 'watch' ? '👀 观察' : s === 'skip' ? '⛔ 跳过' : '—');

// ── Header ───────────────────────────────────────────────────
const reportDate = new Date(model.meta.generatedAt).toISOString().slice(0, 10);
const freshnessLine = model.freshness && model.freshness.latestBarDate
  ? `数据截至 ${model.freshness.latestBarDate} 15:00 收盘，${model.freshness.withLatestBar}/${model.freshness.totalSymbols} 品种已更新`
  : '数据时效见第四章附录';
const header = [
  `# 期货投机机会雷达 — ${reportDate}\n`,
  `> 运行 ID: ${model.meta.runId} | 品种 ${model.meta.totalSymbols} | 候选 ${model.meta.top10Count} | 深挖 ${model.meta.keepCount} | ${freshnessLine}\n`
];

// ── 结论速览 ─────────────────────────────────────────────────
console.log('[3/6] Rendering 结论速览...');

const summary = [];
summary.push('## 一、结论速览\n');
summary.push('| 品种 | 锚定合约 | 收盘价 | 方向 | 置信度 | 执行状态 |');
summary.push('|------|---------|--------|------|--------|---------|');
for (const opp of model.opportunities) {
  const p = planMap.get(opp.symbol);
  summary.push(`| ${opp.symbol} ${opp.name} | ${opp.contract || '—'} | ${fmt(opp.marketFacts && opp.marketFacts.close, 0)} | ${directionLabel(opp.thesis.finalDirection)} | ${confidenceLabel(opp.thesis.finalConfidence)} | ${p ? executionLabel(p.executionStatus) : '—'} |`);
}
summary.push('');

const coreBullets = model.opportunities
  .map((opp) => `- **${opp.symbol} ${opp.name}**：${coreLogic(opp) || '—'}`)
  .filter((line) => !line.endsWith('—'));
if (coreBullets.length > 0) {
  summary.push('**核心逻辑**');
  summary.push(...coreBullets);
  summary.push('');
}

const actionBullets = model.opportunities.map((opp) => {
  const p = planMap.get(opp.symbol);
  const st = p ? executionLabel(p.executionStatus) : '—';
  const reasons = p && Array.isArray(p.statusReasons) && p.statusReasons.length > 0
    ? `（${p.statusReasons.join('；')}）`
    : '';
  const turn = p && (p.executionStatus === 'watch' || p.executionStatus === 'skip') && p.entry && p.entry.trigger
    ? `；转执行：${p.entry.trigger}`
    : '';
  return `- ${opp.symbol} ${opp.name}：${st}${reasons}${turn}`;
});
if (actionBullets.length > 0) {
  summary.push('**本期动作**');
  summary.push(...actionBullets);
  summary.push('');
}

// ── 二、机会分析（主报告）+ 附录 B（机会证据链）────────────────
console.log('[4/6] Rendering 机会分析 + 附录 B...');

const mainCh = [];
mainCh.push('## 二、机会分析\n');

const appendixB = [];
appendixB.push('### 4.2 机会证据链\n');
appendixB.push('> 每品种完整六问与模型明细；宏观/板块仅作背景。\n');

for (const opp of model.opportunities) {
  const thesis = opp.thesis;

  // ── 主报告：机会分析 ──
  mainCh.push(`### ${opp.symbol} ${opp.name}\n`);
  const titleParts = [`${directionLabel(thesis.finalDirection)}`, `${confidenceLabel(thesis.finalConfidence)}置信`];
  if (opp.contract) titleParts.push(`锚定 ${opp.contract}`);
  if (opp.marketFacts && opp.marketFacts.close != null) titleParts.push(`收盘 ${fmt(opp.marketFacts.close, 0)}`);
  mainCh.push(`**${titleParts.join(' / ')}**\n`);

  const q3Core = thesis.odds && thesis.odds.reasoning ? trimEndPunct(thesis.odds.reasoning) : '';
  const basisCore = opp.spotBasis && opp.spotBasis.status !== 'unavailable' && opp.spotBasis.basisRate != null
    ? (opp.spotBasis.source === 'mysteel'
      ? `期现结构：${opp.spotBasis.basisRate < 0 ? '期货升水' : opp.spotBasis.basisRate > 0 ? '现货升水' : '基差平水'} ${Math.abs(opp.spotBasis.basisRate * 100).toFixed(2)}%`
      : '')
    : '';
  if (q3Core || basisCore) {
    mainCh.push(`> **核心逻辑**：${[q3Core, basisCore].filter(Boolean).join('；')}\n`);
  }

  if (thesis.assessmentChanged) {
    mainCh.push(`> ⚠️ **判断变化**：筛选阶段「${directionLabel(opp.screening.initialDirection)}/${confidenceLabel(opp.screening.initialConfidence)}置信」，深挖后「${directionLabel(thesis.finalDirection)}/${confidenceLabel(thesis.finalConfidence)}置信」\n`);
  }

  const rationale = thesis.confidenceRationale;
  if (rationale) {
    const notes = (arr) => (Array.isArray(arr) ? arr.map((f) => f.note).join('；') : '');
    const sup = notes(rationale.supportingFactors);
    const oppNotes = notes(rationale.opposingFactors);
    const unc = Array.isArray(rationale.uncertainties) ? rationale.uncertainties.join('；') : '';
    if (sup || oppNotes || unc) {
      mainCh.push('**关键多空**\n');
      mainCh.push('| 方向 | 关键证据 |');
      mainCh.push('|------|---------|');
      if (sup) mainCh.push(`| 支持 | ${sup} |`);
      if (oppNotes) mainCh.push(`| 反向 | ${oppNotes} |`);
      if (unc) mainCh.push(`| 不确定 | ${unc} |`);
      mainCh.push('');
    }
  }

  const signals = Array.isArray(thesis.confirmations && thesis.confirmations.signals) ? thesis.confirmations.signals : [];
  const conditions = Array.isArray(thesis.invalidations && thesis.invalidations.conditions) ? thesis.invalidations.conditions : [];
  const ref = opp.referenceInterval;
  const caLines = costAnchorLines(opp.symbol);
  if (signals.length > 0 || conditions.length > 0 || ref || caLines.length > 0) {
    mainCh.push('**关键价位**\n');
    mainCh.push('| 类型 | 价位 | 含义 |');
    mainCh.push('|------|------|------|');
    if (signals.length > 0) mainCh.push(`| 确认 | ${signals.join('；')} | Q4 确认信号 |`);
    if (conditions.length > 0) mainCh.push(`| 失效 | ${conditions.join('；')} | Q5 失效条件 |`);
    if (ref) {
      const m = (Array.isArray(opp.intervalModels) ? opp.intervalModels : []).find((x) => x.id === ref.modelId);
      if (m) {
        const i3 = (m.intervals || []).find((x) => x.period === 3);
        const i5 = (m.intervals || []).find((x) => x.period === 5);
        mainCh.push(`| 参考区间 | ${i3 ? fmtRange(i3.p95) : '—'} / ${i5 ? fmtRange(i5.p95) : '—'} | ${ref.modelName} 3日/5日 95% |`);
      } else {
        mainCh.push(`| 参考区间 | — | ${ref.modelName}（${ref.reason}） |`);
      }
    }
    if (caLines.length > 0) {
      const caText = caLines[0].replace(/^\*\*成本锚\*\*（asOf [^）]*）:\s*/, '');
      mainCh.push(`| 成本锚 | ${caText} | 成本背景，不单独决定方向 |`);
    }
    mainCh.push('');
  }

  if (Array.isArray(thesis.risks && thesis.risks.items) && thesis.risks.items.length > 0) {
    mainCh.push(`**主要风险**：${thesis.risks.items.join('；')}\n`);
  }
  mainCh.push('---\n');

  // ── 附录：完整证据链 ──
  appendixB.push(`#### ${opp.symbol} ${opp.name}\n`);

  if (opp.contract) {
    appendixB.push(`**锚定合约**: ${opp.contract}（收盘 ${fmt(opp.marketFacts && opp.marketFacts.close, 0)}）\n`);
  }

  const sbLine = spotBasisLine(opp);
  if (sbLine) appendixB.push(`**期现结构**: ${sbLine}\n`);

  if (macro && macro.available && macro.relevance) {
    const anchors = macro.relevance[opp.symbol] || [];
    if (anchors.length > 0) {
      const anchorText = anchors.map((a) => {
        const disp = (macro.display && macro.display[a]) || { label: a, unit: '', decimals: 2 };
        const ind = macro.indicators[a];
        if (!ind || ind.status === 'missing') return `${disp.label} —`;
        return `${disp.label} ${fmtMacroValue(ind.value, disp)}`;
      }).join('；');
      appendixB.push(`**相关宏观锚点**: ${anchorText}\n`);
    } else {
      appendixB.push('**相关宏观锚点**: 无适用日频宏观锚点\n');
    }
  }

  if (opp.sector && model.sector && model.sector.sectors && model.sector.sectors[opp.sector]) {
    const sec = model.sector.sectors[opp.sector];
    const secObserved = `${sec.label} 1日 ${fmtPct(sec.ret1d)} / 5日 ${fmtPct(sec.ret5d)}，广度 ${
      sec.advanceRatio1d != null ? `${sec.advanceRatio1d.toFixed(0)}%` : '—'
    }`;
    appendixB.push(`**板块背景**: ${secObserved}；板块驱动：${sectorDriverClue(opp.sector)}\n`);
  }

  appendixB.push('**价格区间**:\n');
  appendixB.push('| 模型 | 原理 | 3日95%区间 | 5日95%区间 | 当前判断 |');
  appendixB.push('|------|------|-----------|-----------|---------|');
  const hv = opp.marketFacts.hv;
  const range3d = opp.priceRanges.find((r) => r.period === '3d');
  const models = Array.isArray(opp.intervalModels) ? opp.intervalModels : [];
  if (models.length > 0) {
    for (const m of models) {
      const i3 = (m.intervals || []).find((x) => x.period === 3);
      const i5 = (m.intervals || []).find((x) => x.period === 5);
      const adopted = opp.referenceInterval && opp.referenceInterval.modelId === m.id;
      const current = adopted ? `✅ 当前更可能对：${opp.referenceInterval.reason}` : '—';
      appendixB.push(`| ${m.name} | ${m.principle} | ${i3 ? fmtRange(i3.p95) : '—'} | ${i5 ? fmtRange(i5.p95) : '—'} | ${current} |`);
    }
    if (opp.referenceInterval) {
      appendixB.push(`\n> 参考区间采用 ${opp.referenceInterval.modelName}（${opp.referenceInterval.reason}）。`);
    }
  } else if (range3d) {
    appendixB.push(`| HV概率锥 | 20日历史波动率对数正态外推 | ${fmtRange(range3d.hvCone.p68)} | ${fmtRange(range3d.hvCone.p95)} | — |`);
  }
  if (range3d) {
    appendixB.push(`> ATR5=${fmt(range3d.atrBand.atr5)}，2×ATR 通道 [${fmtRange(range3d.atrBand.band)}] 仅作止损/跳空口径，不参与区间判断。`);
  }
  appendixB.push('');

  if (hv && (hv.degraded || hv.correctionCount > 0)) {
    const corrPct = ((hv.correctionCount / hv.totalBars) * 100).toFixed(1);
    appendixB.push(`> ⚠️ **数据质量**: OHLC 修正 ${hv.correctionCount} 根 (${corrPct}%)${hv.degraded ? '，修正率 >20%，HV 估算降级，概率锥可信度降低' : ''}\n`);
  }

  for (const line of costAnchorLines(opp.symbol)) appendixB.push(`${line}\n`);

  appendixB.push('**驱动 (Q1)**:');
  if (thesis.driver.primary) appendixB.push(`- 主驱动: ${thesis.driver.primary}`);
  if (thesis.driver.secondary) appendixB.push(`- 次驱动: ${thesis.driver.secondary}`);
  if (thesis.driver.evidence) appendixB.push(`- 证据: ${thesis.driver.evidence}`);
  if (thesis.driver.source) appendixB.push(`- 来源: ${thesis.driver.source}`);
  appendixB.push(`**趋势/脉冲 (Q2)**: ${thesis.trendOrImpulse.assessment}\n`);
  appendixB.push(`**赔率 (Q3)**: ${thesis.odds.reasoning} → ${thesis.odds.bias}\n`);

  appendixB.push('**确认信号 (Q4)**:');
  thesis.confirmations.signals.forEach((sig) => appendixB.push(`- ${sig}`));
  appendixB.push('');

  appendixB.push('**失效条件 (Q5)**:');
  thesis.invalidations.conditions.forEach((cond) => appendixB.push(`- ${cond}`));
  appendixB.push('');

  appendixB.push(`**风险 (Q6)**: ${thesis.risks.items.join('；')}\n`);
  appendixB.push('---\n');
}

// ── 附录 A：市场与筛选明细 ──────────────────────────────────
console.log('[5/6] Rendering 第四章附录...');

const appendixA = [];
appendixA.push('### 4.1 市场与筛选明细\n');

appendixA.push('#### 宏观锚点\n');
if (macro && macro.available) {
  const asOf = (macro.meta && macro.meta.signalDate) || '—';
  const parts = [];
  for (const [id, ind] of Object.entries(macro.indicators)) {
    const disp = (macro.display && macro.display[id]) || { label: id, unit: '', decimals: 2 };
    if (!ind || ind.status === 'missing') {
      const reason = ind && ind.reason ? `: ${ind.reason}` : '';
      parts.push(`${disp.label} —(missing${reason.length > 40 ? reason.slice(0, 40) + '…' : reason})`);
    } else {
      const valueText = fmtMacroValue(ind.value, disp);
      const chgText = ind.change5d === null || ind.change5d === undefined
        ? '5d —'
        : `5d ${ind.change5d > 0 ? '+' : ''}${ind.change5d.toFixed(2)}%`;
      const staleNote = ind.status === 'stale' ? ` [asOf ${ind.asOf}，stale]` : '';
      parts.push(`${disp.label} ${valueText} (${chgText})${staleNote}`);
    }
  }
  appendixA.push(`> **宏观背景** (signalDate ${asOf}): ${parts.join(' · ')}\n`);
} else {
  const reason = macro && macro.reason ? macro.reason : '本 run 未采集宏观快照';
  appendixA.push(`> ⚠️ 宏观数据不可用（${reason}）。以下分析基于品种自身量价数据。\n`);
}

appendixA.push('#### 板块异动\n');
appendixA.push('| 板块 | 方向 | 1日 | 5日 | 上涨广度 | 方向一致度 | 代表品种 | 驱动线索 |');
appendixA.push('|------|------|-----|-----|---------|-----------|----------|----------|');
if (model.sector && model.sector.sectors && Object.keys(model.sector.sectors).length > 0) {
  for (const [sectorId, sec] of Object.entries(model.sector.sectors)) {
    const leader = sec.leaderSymbol
      ? `${sec.leaderName || sec.leaderSymbol} (${sec.leaderSymbol})`
      : '—';
    const coherence = sec.coherence1d != null ? `${sec.coherence1d.toFixed(0)}%` : '—';
    appendixA.push(
      `| ${sec.label} | ${directionSymbol(sec.direction)} | ${fmtPct(sec.ret1d)} | ${fmtPct(sec.ret5d)} | ` +
      `${sec.advanceRatio1d != null ? `${sec.advanceRatio1d.toFixed(0)}%` : '—'} | ${coherence} | ${leader} | ${sectorDriverClue(sectorId)} |`
    );
  }
  appendixA.push(`\n> 板块指数由 raw.json 成员等权日收益链式构建；驱动线索来自 sector-driver.json，只解释板块整体。口径见第四章附录。\n`);
} else {
  appendixA.push('| — | — | — | — | — | — | — | 板块快照不可用 |\n');
}

appendixA.push('#### Top 10 异动排名\n');
appendixA.push('| # | 品种 | 代码 | 收盘 | 得分 | ATR% | Vol%ile | Vol× | 5dΔ | 方向 | 趋势(vs20/60) |');
appendixA.push('|---|------|------|------|------|------|---------|------|-----|------|---------------|');
for (const item of model.screening.top10) {
  appendixA.push(`| ${item.rank} | ${item.name} | ${item.symbol} | ${fmt(item.trend.close, 0)} | ${fmt(item.score, 1)} | ${fmtPct(item.indicators.atrPct)} | ${fmtPct(item.indicators.volPercentile, 0)} | ${fmt(item.indicators.volMultiplier, 2)}× | ${fmtPct(item.indicators.change5d)} | ${directionSymbol(item.trend.direction)} | ${fmtPct(item.trend.vsMA20)}/${fmtPct(item.trend.vsMA60)} |`);
}

appendixA.push('\n#### 过滤决策\n');
appendixA.push('| 品种 | 决定 | 初判理由 | 待验证 |');
appendixA.push('|------|------|---------|--------|');
for (const dec of model.screening.decisions) {
  const badge = dec.decision === 'KEEP' ? '✅ KEEP' : dec.decision === 'DOWNGRADE' ? '❌ DROP' : dec.decision;
  const reason = dec.reason
    || (dec.decision === 'KEEP' ? `${directionLabel(dec.initialDirection)} | ${confidenceLabel(dec.initialConfidence)}置信` : dec.note || '—');
  const gap = dec.informationGap || '—';
  appendixA.push(`| ${dec.symbol} ${dec.name} | ${badge} | ${reason} | ${gap} |`);
}
appendixA.push('\n> 未入选品种及其理由见上表「❌ DROP」列，不再单列章节。\n');

// ── 4.4 方法与数据说明 ──────────────────────────────────────
const freshnessCard = model.freshness ? renderFreshnessCard(model.freshness) : [];

const appendixD = [];
appendixD.push('### 4.4 方法与数据说明\n');

if (freshnessCard.length > 0) {
  appendixD.push('#### 数据时效\n');
  appendixD.push(...freshnessCard);
}

appendixD.push('#### 板块指标口径\n');
appendixD.push('- **板块指数**：由 raw.json 成员等权日收益链式构建（基点 1000）；驱动线索来自 sector-driver.json，只解释板块整体。');
appendixD.push('- **上涨广度**：板块内当日上涨成员数 ÷ 成员总数 × 100%（成员当日收益 = 当日收盘/前一收盘 - 1）。');
appendixD.push('- **方向一致度**：成员方向与板块方向一致的比例；下跌板块该值越高，说明下跌共振越强。');
appendixD.push('- 广度 ≥ 50% 且与板块方向一致 → 多数成员共振，板块异动可信度较高；广度 < 50% 或明显分化 → 少数品种拉动，不是板块性行情。');
appendixD.push('- 该指标只使用价格/成交量数据，不使用持仓数据。\n');

appendixD.push('#### 价格区间方法\n');
appendixD.push('- 区间由五个条件型/自适应模型给出：EWMA（RiskMetrics 1996）、GARCH(1,1)（Bollerslev 1986）、FHS（Barone-Adesi et al. 1999）、EVT-POT（McNeil & Frey 2000）、ACI（Gibbs & Candès 2021，轻量近似）');
appendixD.push('- 表格列出全部模型与各自区间，✅ 标记当前状态更可能对的模型；参考区间采用该模型');
appendixD.push('- 当前适配只看当下状态：波动切换比、HV 分位、极端单日与收益肥尾，不做历史回测竞赛');
appendixD.push('- ATR 仅作止损与跳空口径，不参与区间判断；模型间差异是正常现象\n');

appendixD.push('#### 置信度定义\n');
appendixD.push('- 置信度是 LLM 对整条证据链（数值+文本）的方向支撑强度与矛盾程度的综合判断，分 high/medium/low 三个序数等级');
appendixD.push('- 它是判断参考标签，不是概率或胜率；等级之间允许容错，不使用证据计数或分值计算');
appendixD.push('- high：证据链实质收敛、无实质性未解决矛盾；medium：方向成立但存在可容忍的反向或不确定；low：支撑不足、矛盾未解决或驱动不可验证\n');

if (costAnchor) {
  appendixD.push('#### 成本锚方法\n');
  appendixD.push('- **理论依据**: `theory-base/05-cost-anchor-marginal-producer.md`（边际生产者/加工利润/进口平价/生产成本）');
  appendixD.push('- **存储**: 主档 `data/cost-anchor/<symbol>.json`；本期 `cost-anchor.json` 为文件库投影快照');
  appendixD.push('- **纪律**: 成本锚是证据上下文，不是支撑位，不单独决定方向；无来源/过期一律显示不可用');
  appendixD.push('- **门禁**: 合法性错误 fail-closed；结构性异常（区间过宽/多工艺合并/缺失路线）fail-visible，problems[] 必须展示\n');
}

appendixD.push('---\n');
appendixD.push('*免责声明：本报告由 AI 生成，仅为投机机会发现工具，不构成投资建议。所有交易决策需自行判断。*');
appendixD.push(`*数据来源：akshare (行情) | 预测区间：五模型参考（EWMA/GARCH/FHS/EVT-POT/ACI） | 管道版本：${model.meta.pipelineVersion}*`);

// ── 四、附录（整合单章，集中所有细节与口径）──────────────────
const appendixChapter = [
  '## 四、附录\n',
  '> 筛选明细、完整六问、证伪反馈与指标口径集中在本章；主报告只保留结论与关键价位。\n',
  '',
  ...appendixA,
  ...appendixB,
  feedbackAppendix,
  ...appendixD
].filter((s) => s != null);

// ── Assemble final report ────────────────────────────────────
const sections = [
  ...header,
  ...summary,
  ...mainCh,
  strategySection,
  ...appendixChapter
].filter((s) => s != null);
const report = sections.join('\n');

// ── Write report.md ──────────────────────────────────────────
const outputPath = path.join(RUN_DIR, 'report.md');
fs.writeFileSync(outputPath, report, 'utf8');

console.log(`\n✓ Written to: ${outputPath}`);
console.log(`\n=== Stage 5C Complete ===`);
console.log(`Total lines: ${report.split('\n').length}`);
console.log(`Output: report.md (${report.length} bytes)`);
