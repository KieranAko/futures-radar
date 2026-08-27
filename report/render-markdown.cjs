// report/render-markdown.cjs — Stage 5C: Markdown Renderer
// Phase 8-A implementation
//
// Responsibility: Template-driven markdown generation from report-model.json
// - Generate 4 chapters + appendix structure
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

// ── Stage 5C Entry ───────────────────────────────────────────
console.log('=== Stage 5C: Markdown Renderer ===');
console.log(`runId: ${runId}`);
console.log(`runDir: ${RUN_DIR}\n`);

// ── Load report-model.json ───────────────────────────────────
console.log('[1/5] Loading report-model.json...');
const modelPath = path.join(RUN_DIR, 'report-model.json');
const model = readJSON(modelPath);
console.log(`  ✓ Loaded ${model.opportunities.length} opportunities`);

// ── Chapter 1: 市场雷达 ──────────────────────────────────────
console.log('[2/5] Rendering Chapter 1: 市场雷达...');

const macro = model.macro;

const ch1 = [];
ch1.push('## 一、市场雷达\n');
ch1.push('### 宏观锚点');
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
  ch1.push(`> **宏观背景** (signalDate ${asOf}): ${parts.join(' · ')}\n`);
} else {
  const reason = macro && macro.reason ? macro.reason : '本 run 未采集宏观快照';
  ch1.push(`> ⚠️ 宏观数据不可用（${reason}）。以下分析基于品种自身量价数据。\n`);
}

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

ch1.push('### 板块异动');
ch1.push('| 板块 | 方向 | 1日 | 5日 | 上涨广度 | 代表品种 | 驱动线索 |');
ch1.push('|------|------|-----|-----|---------|----------|----------|');
if (model.sector && model.sector.sectors && Object.keys(model.sector.sectors).length > 0) {
  for (const [sectorId, sec] of Object.entries(model.sector.sectors)) {
    const leader = sec.leaderSymbol
      ? `${sec.leaderName || sec.leaderSymbol} (${sec.leaderSymbol})`
      : '—';
    ch1.push(
      `| ${sec.label} | ${directionSymbol(sec.direction)} | ${fmtPct(sec.ret1d)} | ${fmtPct(sec.ret5d)} | ` +
      `${sec.advanceRatio1d != null ? `${sec.advanceRatio1d.toFixed(0)}%` : '—'} | ${leader} | ${sectorDriverClue(sectorId)} |`
    );
  }
  ch1.push(`\n> 板块指数由 raw.json 成员等权日收益链式构建（基点 1000）。驱动线索来自板块驱动 LLM（sector-driver.json），只解释板块整体，不构成任何个股方向判断。\n`);
  ch1.push('**板块指标口径**\n');
  ch1.push('- **上涨广度**：板块内当日上涨成员数 ÷ 成员总数 × 100%（成员当日收益 = 当日收盘/前一收盘 - 1）。');
  ch1.push('- 例如广度 81% 表示 22 个成员中约 18 个上涨；广度 14% 表示多数成员下跌。');
  ch1.push('- 广度 ≥ 50% 且与板块方向一致 → 多数成员共振，板块异动可信度较高；广度 < 50% 或明显分化 → 可能只是少数领涨/领跌品种拉动，不是真正的板块性行情。');
  ch1.push('- 该指标只使用价格/成交量数据，不使用持仓数据。\n');
} else {
  ch1.push('| — | — | — | — | — | — | 板块快照不可用 |\n');
}

console.log(`  ✓ Chapter 1: ${ch1.length} lines`);

// ── Chapter 2: 候选品种筛选 ──────────────────────────────────
console.log('[3/5] Rendering Chapter 2: 候选品种筛选...');

const ch2 = [];
ch2.push('## 二、候选品种筛选\n');
ch2.push('### Top 10 异动排名\n');
ch2.push('| # | 品种 | 代码 | 得分 | ATR% | Vol%ile | Vol× | 5dΔ | 方向 | 趋势(vs20/60) |');
ch2.push('|---|------|------|------|------|---------|------|-----|------|---------------|');

for (const item of model.screening.top10) {
  ch2.push(`| ${item.rank} | ${item.name} | ${item.symbol} | ${fmt(item.score, 1)} | ${fmtPct(item.indicators.atrPct)} | ${fmtPct(item.indicators.volPercentile, 0)} | ${fmt(item.indicators.volMultiplier, 2)}× | ${fmtPct(item.indicators.change5d)} | ${directionSymbol(item.trend.direction)} | ${fmtPct(item.trend.vsMA20)}/${fmtPct(item.trend.vsMA60)} |`);
}

ch2.push('\n### 过滤决策\n');
ch2.push('| 品种 | 决定 | 理由 |');
ch2.push('|------|------|------|');

for (const dec of model.screening.decisions) {
  const badge = dec.decision === 'KEEP' ? '✅ KEEP' : dec.decision === 'DOWNGRADE' ? '❌ DROP' : dec.decision;
  const reason = dec.decision === 'KEEP'
    ? `${directionLabel(dec.initialDirection)} | ${confidenceLabel(dec.initialConfidence)}置信`
    : dec.reason;
  ch2.push(`| ${dec.symbol} ${dec.name} | ${badge} | ${reason} |`);
}

ch2.push('');
console.log(`  ✓ Chapter 2: ${ch2.length} lines`);

// ── Chapter 3: 重点机会分析 ──────────────────────────────────
console.log('[4/5] Rendering Chapter 3: 重点机会分析...');

const ch3 = [];
ch3.push('## 三、重点机会分析\n');

for (const opp of model.opportunities) {
  const thesis = opp.thesis;

  ch3.push(`### ${opp.symbol} ${opp.name}\n`);
  ch3.push(`**方向**: ${directionLabel(thesis.finalDirection)} | **置信度**: ${confidenceLabel(thesis.finalConfidence)}置信\n`);

  // 锚定合约（Analyze 阶段冻结的主导合约）
  if (opp.contract) {
    ch3.push(`**锚定合约**: ${opp.contract}\n`);
  }

  // Judgment change annotation
  if (thesis.assessmentChanged) {
    ch3.push(`> ⚠️ **判断变化**: 筛选阶段评估为「${directionLabel(opp.screening.initialDirection)}/${confidenceLabel(opp.screening.initialConfidence)}置信」，深度分析后调整为「${directionLabel(thesis.finalDirection)}/${confidenceLabel(thesis.finalConfidence)}置信」\n`);
  }

  // 相关宏观锚点（Phase 3 阶段一：仅展示快照值，不输出宏观多空）
  if (macro && macro.available && macro.relevance) {
    const anchors = macro.relevance[opp.symbol] || [];
    if (anchors.length > 0) {
      const anchorText = anchors.map((a) => {
        const disp = (macro.display && macro.display[a]) || { label: a, unit: '', decimals: 2 };
        const ind = macro.indicators[a];
        if (!ind || ind.status === 'missing') return `${disp.label} —`;
        return `${disp.label} ${fmtMacroValue(ind.value, disp)}`;
      }).join('；');
      ch3.push(`**相关宏观锚点**: ${anchorText}\n`);
    } else {
      ch3.push('**相关宏观锚点**: 无适用日频宏观锚点\n');
    }
  }

  // 板块背景：观察值与驱动结论分离展示；只作背景，不构成本品种驱动证据
  if (opp.sector && model.sector && model.sector.sectors && model.sector.sectors[opp.sector]) {
    const sec = model.sector.sectors[opp.sector];
    const secObserved = `${sec.label} 1日 ${fmtPct(sec.ret1d)} / 5日 ${fmtPct(sec.ret5d)}，广度 ${
      sec.advanceRatio1d != null ? `${sec.advanceRatio1d.toFixed(0)}%` : '—'
    }`;
    ch3.push(`**板块背景（仅上下文，不作为本品种驱动证据）**: ${secObserved}；板块驱动：${sectorDriverClue(opp.sector)}\n`);
  }

  // Price ranges table
  ch3.push('**价格区间对比**:\n');
  ch3.push('| 方法 | 3日 68% 区间 | 3日 95% 区间 | 说明 |');
  ch3.push('|------|-------------|-------------|------|');

  const range3d = opp.priceRanges.find(r => r.period === '3d');
  const hv = opp.marketFacts.hv;

  if (range3d) {
    // HV cone row
    const hvRow = range3d.hvCone
      ? `| HV概率锥 | ${fmtRange(range3d.hvCone.p68)} | ${fmtRange(range3d.hvCone.p95)} | HV ${fmtPct(hv.annual * 100, 1)} (P${hv.percentile90d || '—'}) ${hv.estimator}${hv.correctionCount > 0 ? ` ⚠️修正${hv.correctionCount}根` : ''} |`
      : `| HV概率锥 | — | — | HV 数据不足，无法计算概率锥 |`;
    ch3.push(hvRow);

    // ATR row
    ch3.push(`| ATR通道 | — | ${fmtRange(range3d.atrBand.band)} | ATR5=${fmt(range3d.atrBand.atr5)} (2×ATR) |`);

    // Divergence row
    const divPct = range3d.divergence.pct !== null ? fmtPct(range3d.divergence.pct) : '—';
    const divInterpret = range3d.divergence.interpretation;
    ch3.push(`| 偏差分析 | — | ${divPct} | ${divInterpret} |`);
  }

  ch3.push('');

  // Data quality warning
  if (hv && (hv.degraded || hv.correctionCount > 0)) {
    const corrPct = ((hv.correctionCount / hv.totalBars) * 100).toFixed(1);
    ch3.push(`> ⚠️ **数据质量**: OHLC 修正 ${hv.correctionCount} 根 (${corrPct}%)${hv.degraded ? '，修正率 >20%，HV 估算降级，概率锥可信度降低' : ''}\n`);
  }

  // 6-question analysis
  ch3.push(`**驱动 (Q1)**: ${thesis.driver.primary}；${thesis.driver.secondary}。${thesis.driver.evidence.substring(0, 100)}... (来源: ${thesis.driver.source})\n`);
  ch3.push(`**趋势/脉冲 (Q2)**: ${thesis.trendOrImpulse.assessment}\n`);
  ch3.push(`**赔率 (Q3)**: ${thesis.odds.reasoning} → ${thesis.odds.bias}\n`);

  ch3.push('**确认信号 (Q4)**:');
  thesis.confirmations.signals.forEach(sig => ch3.push(`- ${sig}`));
  ch3.push('');

  ch3.push('**失效条件 (Q5)**:');
  thesis.invalidations.conditions.forEach(cond => ch3.push(`- ${cond}`));
  ch3.push('');

  ch3.push(`**风险 (Q6)**: ${thesis.risks.items.join('；')}\n`);
  ch3.push('---\n');
}

console.log(`  ✓ Chapter 3: ${ch3.length} lines`);

// ── Chapter 4: 今日不做什么 + Appendix ───────────────────────
console.log('[5/5] Rendering Chapter 4 + Appendix...');

const ch4 = [];
ch4.push('## 四、今日不做什么\n');
ch4.push('| 品种 | 为什么不碰 |');
ch4.push('|------|-----------|');

for (const rej of model.rejected.slice(0, 3)) {
  ch4.push(`| ${rej.symbol} ${rej.name} | ${rej.reason} |`);
}

ch4.push('\n---\n');

// Appendix (copied from template.md, static content)
ch4.push('## 价格区间方法说明\n');
ch4.push('### HV 概率锥（统计置信区间）\n');
ch4.push('**计算方法**: 基于 Yang-Zhang 20日历史波动率（HV）的几何布朗运动（GBM）闭式解。68% 对应 1σ，95% 对应 1.96σ。\n');
ch4.push('**数学基础**:');
ch4.push('- 上沿 = close × exp(z × σ_daily × √days)');
ch4.push('- 下沿 = close × exp(-z × σ_daily × √days)');
ch4.push('- σ_daily = HV_annual / √242（242为中国期货年交易日）\n');
ch4.push('**性质**: 统计学置信区间，表示"假设价格服从对数正态分布，有 68%/95% 概率落在区间内"。\n');
ch4.push('**数据来源**: `close` = 最新收盘价，`HV` = 20日 Yang-Zhang 波动率（含隔夜跳空），`percentile` = HV 在 90日历史中的分位数。\n');
ch4.push('**估算器**: Yang-Zhang（优先）> Garman-Klass（缺 Open）> Close-to-Close（仅 Close）。若 OHLC 数据修正率 >20%，标记 `degraded=true`。\n');
ch4.push('### ATR 通道（经验波动带）\n');
ch4.push('**计算公式**: `上轨 = close + 2×ATR5`, `下轨 = close - 2×ATR5`\n');
ch4.push('**性质**: 基于历史波动幅度的经验波动带，不是统计学置信区间。2×ATR 表示价格在该通道外波动属于"显著偏离历史常态"，但不等同于"95% 概率覆盖"。\n');
ch4.push('**数据来源**: `close` = 当前收盘价，`ATR5` = 5日平均真实波动幅度（来自 probability.json）\n');
ch4.push('### 偏差分析\n');
ch4.push('**计算**: |ATR通道宽度 - HV 95%区间宽度| / HV 95%区间宽度 × 100%\n');
ch4.push('**解释**:');
ch4.push('- <10%: 两种方法区间基本一致，波动率模型稳定 ✅');
ch4.push('- 10-20%: 两种方法区间存在差异，波动率结构可能变化 ⚠️');
ch4.push('- >20%: 两种方法区间严重背离，波动率模型不稳定 ❌\n');
ch4.push('### 使用建议\n');
ch4.push('1. ✅ **HV 概率锥作为主参考**: 统计学基础更严谨，提供 68%/95% 置信区间');
ch4.push('2. ✅ **ATR 通道作为辅助**: 经验波动带，结合日内波动特征');
ch4.push('3. ⚠️ **偏差 <10% 时可信度更高**: 两种方法一致时，价格区间参考价值更大');
ch4.push('4. ⚠️ **偏差 >20% 时谨慎使用**: 波动结构剧变期，历史波动率失效');
ch4.push('5. ⚠️ **突发事件失效**: 地缘政治、政策变化等黑天鹅事件会使两种方法同时失效');
ch4.push('6. ⚠️ **品种差异**: EC0（集运）等超高波动品种需特殊解读（HV 可达 200-400%）\n');
ch4.push('---\n');
ch4.push('*免责声明：本报告由 AI 生成，仅为投机机会发现工具，不构成投资建议。所有交易决策需自行判断。*');
ch4.push(`*数据来源：akshare (行情) | 波动率方法：Yang-Zhang HV + 2×ATR5 | 管道版本：${model.meta.pipelineVersion}*`);

console.log(`  ✓ Chapter 4 + Appendix: ${ch4.length} lines`);

// ── Assemble final report ────────────────────────────────────
const reportDate = new Date(model.meta.generatedAt).toISOString().slice(0, 10);
const header = [
  `# 期货投机机会雷达 — ${reportDate}\n`,
  `> 运行 ID: ${model.meta.runId} | 扫描品种: ${model.meta.totalSymbols} | 候选: ${model.meta.top10Count} | 深挖: ${model.meta.keepCount}\n`
];

// 数据时效说明卡片（v0.1.2）：header 之后、第一章之前；旧 run 无 freshness 时跳过
const freshnessCard = model.freshness ? renderFreshnessCard(model.freshness) : [];

// ── 交易策略板块（t9）：可选章节「五、交易策略板块（执行参考）」 ──
// 契约 strategies/report-strategy-section.md §3.2：strategy-plan.json 存在且非空时，
// 在第四章之后、附录「价格区间方法说明」之前插入；缺失/为空时跳过，四章+附录不变。
const { renderStrategySection, composeReportWithStrategy } = require('./render-strategy-section.cjs');
let strategySection = null;
const strategyPlanPath = path.join(RUN_DIR, 'strategy-plan.json');
if (fs.existsSync(strategyPlanPath)) {
  try {
    const strategyPlan = JSON.parse(fs.readFileSync(strategyPlanPath, 'utf8'));
    if (strategyPlan && Array.isArray(strategyPlan.plans) && strategyPlan.plans.length > 0) {
      const library = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'strategies', 'strategy-library.json'), 'utf8'));
      strategySection = renderStrategySection(strategyPlan, library);
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

const baseReport = [...header, ...freshnessCard, ...ch1, ...ch2, ...ch3, ...ch4].join('\n');
const report = strategySection ? composeReportWithStrategy(baseReport, strategySection) : baseReport;

// ── Write report.md ──────────────────────────────────────────
const outputPath = path.join(RUN_DIR, 'report.md');
fs.writeFileSync(outputPath, report, 'utf8');

console.log(`\n✓ Written to: ${outputPath}`);
console.log(`\n=== Stage 5C Complete ===`);
console.log(`Total lines: ${report.split('\n').length}`);
console.log(`Output: report.md (${report.length} bytes)`);

