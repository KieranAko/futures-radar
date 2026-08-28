// report/render-strategy-section.cjs — t9：报告「五、交易策略板块（执行参考）」渲染器
//
// 契约：strategies/report-strategy-section.md §3（t7）
// 输入：output/runs/<runId>/strategy-plan.json（t8 产出）+ strategies/strategy-library.json（证据 URL）
// 输出：markdown 章节片段（纯函数，字符串进字符串出）
//
// FORBIDDEN（与 render-markdown.cjs 同纪律）:
// - 添加或修改数据 / 调用 LLM / 重新计算数值 / 联网
// - 修改报告方向与置信度（reportBaseline 只读直出）
// - 输出收益/胜率承诺（t7 §3.6 禁用词表在 test/strategy-section.test.js 断言）

'use strict';

const { inferFamily, trustRating } = require('../strategies/lib/family-infer.cjs');
const symbolsConfig = require('../config/symbols.json');

// ── 格式化（沿用 render-markdown.cjs 口径：价格 1 位小数、百分比 1-2 位、金额整数） ──
function fmt(x, d) {
  if (x === null || x === undefined || Number.isNaN(Number(x))) return '—';
  return Number(x).toFixed(d === undefined ? 1 : d);
}

function statusBadge(status) {
  if (status === 'executable') return '✅ 可执行';
  if (status === 'watch') return '👀 观察';
  return '⛔ 跳过';
}

function directionLabel(dir) {
  if (dir === 'bullish') return '↑ 多';
  if (dir === 'bearish') return '↓ 空';
  return '→ 中性';
}

function confidenceLabel(conf) {
  return conf === 'high' ? '高' : conf === 'medium' ? '中' : '低';
}

// 按策略 id 在库中查证据 URL（最多 3 条）；BASE-01 无库条目 → 空
// OBS-1：内部仓库路径（非 http）渲染为纯文本路径并标注「内部」，不生成 markdown 链接
function evidenceUrls(strategyId, library) {
  const all = [
    ...(library.strategies.macro || []),
    ...(library.strategies.category || []),
    ...(library.strategies.execution || [])
  ];
  const s = all.find(x => x.id === strategyId);
  if (!s || !Array.isArray(s.evidenceSources)) return [];
  return s.evidenceSources.slice(0, 3).map(e => ({
    title: e.title,
    url: e.url,
    internal: !/^https?:\/\//i.test(e.url || '')
  }));
}

// ── 章节渲染 ──────────────────────────────────────────────────
// 可信度：共享实现 strategies/lib/family-infer.cjs（v2 驱动优先分类，04-R1）
function planFamilyText(p) {
  // 主策略名称为族分类主依据（与 Q1 驱动叙事同源）；辅助证据只展示、不参与分类
  return [
    (p.matchedStrategies || []).slice(0, 1).map((m) => `${m.strategyId} ${m.name || ''}`).join(' '),
    p.playbook?.playbookId || '',
  ].join(' ');
}

function planTrust(p, familyEvidence) {
  // 生产侧固定：状态匹配 unknown（无机制识别输入）、实现保真 high（matcher 确定性）
  return trustRating({ family: inferFamily(planFamilyText(p)), familyEvidence, match: 1, fidelity: 2 });
}

function renderStrategySection(plan, library, feedback = null, familyEvidence = null, forwardLedger = null) {
  const lines = [];
  lines.push('## 五、交易策略板块（执行参考）');
  lines.push('');
  lines.push(`> 运行 ID: ${plan.meta.runId} | 信号日: ${plan.meta.signalDate} | 示例权益: ${plan.meta.equityCny} CNY`);
  lines.push('> 确定性生成，仅作执行参考；**不改变报告方向与置信度**。');
  if (feedback && feedback.meta) {
    const recorded = feedback.meta.recorded == null ? '—' : feedback.meta.recorded;
    const verified = feedback.meta.verified == null ? 0 : feedback.meta.verified;
    lines.push(`> 证伪反馈机制：本期冻结 ${recorded} 个可执行计划；本次验证往期计划 ${verified} 个。`);
  }
  // 前向账本滚动（01-L7：今天的报告引用往期计划的验证状态）
  if (forwardLedger && forwardLedger.previousRun && forwardLedger.previousRun !== plan.meta.runId) {
    const prev = forwardLedger.runs[forwardLedger.previousRun];
    if (prev) {
      const detail = (prev.rows || []).map((r) => `${r.symbol}:${r.status}${r.netPnlPct != null ? `(${r.netPnlPct}%)` : ''}`).join('；');
      lines.push(`> 前向验证（上期 ${forwardLedger.previousRun}）：计划 ${prev.summary.plans} 条，已完成 ${prev.summary.verified}，待数据 ${prev.summary.pendingData}，未触发 ${prev.summary.triggerMiss}；${detail || '无明细'}`);
    }
  }
  // 族级证据状态（实验线 promote 的负面结论，不改变方向/置信度，只提示证据充分程度）
  if (familyEvidence && familyEvidence.families) {
    const closed = Object.entries(familyEvidence.families)
      .filter(([, f]) => ['g1', 'instance_gate_failed', 'not_evaluable_or_falsified', 'not_evaluable'].includes(f.level))
      .map(([name]) => name);
    if (closed.length) {
      lines.push(`> 族级证据状态（实验线 ${familyEvidence.updatedAt || ''}）：${closed.join('、')} 族当前证据不足以支持完整策略；本板块仍为执行参考，可信度评级见 experiment-line/results/trust/。`);
    }
  }
  lines.push('');

  // 策略总览
  lines.push('### 策略总览');
  lines.push('');
  lines.push('| 品种 | 锚定合约 | 方向 | 置信度 | 主策略/模板 | 状态 | 可信度 |');
  lines.push('|------|---------|------|--------|-------------|------|--------|');
  for (const p of plan.plans) {
    const primary = p.matchedStrategies[0];
    const t = planTrust(p, familyEvidence);
    lines.push(`| ${p.symbol} ${p.name} | ${p.contract || '—'} | ${directionLabel(p.reportBaseline.direction)} | ${confidenceLabel(p.reportBaseline.confidence)} | ${primary.strategyId} + ${p.playbook.playbookId} | ${statusBadge(p.executionStatus)} | ${t.grade} |`);
  }
  lines.push('');
  lines.push('> 可信度 = 族级证据 × 状态匹配 × 实现保真（实验线三层合成）；不是胜率/收益预期，只表示证据充分程度。');
  // 板块集中度提示（03-S1/S6：组合风险是设计出来的；报告只提示，不替人决定）
  const sectorCount = {};
  for (const p of plan.plans) {
    const cfgSym = Object.values(symbolsConfig.symbols || {}).find((v) => v && v.symbol === p.symbol);
    const sector = cfgSym?.sector || 'unknown';
    sectorCount[sector] = sectorCount[sector] || [];
    sectorCount[sector].push(p.symbol);
  }
  const concentrated = Object.entries(sectorCount).filter(([, syms]) => syms.length >= 2);
  if (concentrated.length) {
    lines.push(`> 板块集中度提示：${concentrated.map(([sec, syms]) => `${sec} ${syms.join('/')} 同板块`).join('；')}——若同时执行，同板块风险不分散。`);
  }
  lines.push('');

  // 每品种小节：只保留可执行关键信息
  for (const p of plan.plans) {
    const triggerLevel = p.entry.triggerLevel == null ? '—' : fmt(p.entry.triggerLevel, 0);
    const primary = p.matchedStrategies[0];
    const supporting = (p.supportingEvidence || []).map(s => `${s.strategyId} ${s.name}`).join('、');
    const ra = p.riskAssessment;

    lines.push(`### ${p.symbol} ${p.name}（锚定合约 ${p.contract || '—'}）`);
    lines.push('');
    lines.push(`- **报告基准**: ${directionLabel(p.reportBaseline.direction)} / ${confidenceLabel(p.reportBaseline.confidence)}置信；主策略 ${primary.strategyId} ${primary.name}；执行模板 ${p.playbook.playbookId}`);
    {
      const t = planTrust(p, familyEvidence);
      lines.push(`- **实验线可信度**: ${t.grade}（${t.why}）`);
    }
    lines.push(`- **入场机会点**: ${p.entry.trigger}（触发价 ${triggerLevel}）`);
    lines.push(`- **触发/执行时点**: ${p.entry.triggerTiming}`);
    lines.push(`- **执行口径**: ${p.playbook.executionConvention}`);
    lines.push(`- **止损**: ${fmt(p.stop.stopPrice)}（距离 ${fmt(p.stop.stopDistancePts)} 点）`);
    lines.push(`- **目标**: T1 ${p.targets.t1}；T2 ${p.targets.t2}`);
    lines.push(`- **仓位**: ${p.position.lots} 手（${p.position.lotsBasis}）`);
    lines.push(`- **证伪/失效**: ${p.invalidation.hard.join('；')}；${p.invalidation.timeStop}；T+1 未触发入场则本计划作废`);
    lines.push(`- **风险要点**: 每手风险 ${Math.round(ra.unitRiskCny)} CNY；保证金/手 ${Math.round(ra.marginPerLotCny)} CNY；尾部 3d p95 反向边距 ${fmt(ra.tailGapPct3d)}%；事件：${ra.eventRiskNote || '—'}`);
    lines.push(`- **策略依据**: ${primary.strategyId} ${primary.name}${supporting ? `；辅证：${supporting}` : ''}`);
    lines.push(`- **状态**: ${statusBadge(p.executionStatus)}${p.statusReasons.length ? ` — ${p.statusReasons.join('；')}` : ''}`);
    if (p.executionStatus === 'watch' || p.executionStatus === 'skip') {
      lines.push(`- **转执行触发**: ${p.entry.trigger}`);
    }
    if (p.notes && p.notes.length > 0) lines.push(`- **备注**: ${p.notes.join('；')}`);
    lines.push('');
  }

  // 证伪反馈（往期 executable plans）
  if (feedback && Array.isArray(feedback.results) && feedback.results.length > 0) {
    const done = feedback.results.filter(r => r.status !== 'pending_data');
    if (done.length > 0) {
      lines.push('### 上一期策略证伪反馈');
      lines.push('');
      lines.push('| 计划 | 信号日 | 验证结果 | 归因 |');
      lines.push('|------|--------|---------|------|');
      for (const r of done) {
        const resultLabel = r.status === 'verified'
          ? `${r.exitType === 'stopped_out' ? '止损离场' : r.exitType === 'target1_hit' ? '目标1兑现' : '时间离场'}${r.directionCorrect ? '（方向正确）' : '（方向错误）'}`
          : r.status === 'invalidated_not_triggered' ? '未触发，计划作废' : r.status;
        const attr = (r.attribution || []).map(a => `${a.code}: ${a.detail}`).join('；');
        lines.push(`| ${r.recordId} | ${r.signalDate} | ${resultLabel} | ${attr} |`);
      }
      lines.push('');
    }
  }

  // 集中度说明
  if (plan.concentrationDecisions && plan.concentrationDecisions.length > 0) {
    lines.push('### 集中度说明');
    lines.push('');
    for (const d of plan.concentrationDecisions) {
      lines.push(`- ${d.conflictGroup}：保留 ${d.keptSymbol} executable，${d.downgradedSymbols.join('、')} 降级为观察（${d.reason}）`);
    }
    lines.push('');
  }

  // 免责声明
  lines.push('### 免责声明与风险边界');
  lines.push('');
  lines.push(plan.disclaimer || '策略为分析工具输出，不构成投资建议，不执行真实交易。');
  return lines.join('\n');
}

// ── 插入点（t7 §3.2）：第四章之后、附录「价格区间方法说明」之前 ──
function composeReportWithStrategy(baseReport, sectionMarkdown) {
  const anchor = '\n## 价格区间方法说明';
  const idx = baseReport.indexOf(anchor);
  if (idx === -1) return `${baseReport}\n\n${sectionMarkdown}\n`;
  return `${baseReport.slice(0, idx)}\n${sectionMarkdown}\n${baseReport.slice(idx)}`;
}

module.exports = { renderStrategySection, composeReportWithStrategy };
