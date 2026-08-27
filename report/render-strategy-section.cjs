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
function renderStrategySection(plan, library) {
  const lines = [];
  lines.push('## 五、交易策略板块（执行参考）');
  lines.push('');
  lines.push(`> 运行 ID: ${plan.meta.runId} | 信号日: ${plan.meta.signalDate} | 示例权益: ${plan.meta.equityCny} CNY`);
  lines.push('> 确定性生成，仅作执行参考；**不改变报告方向与置信度**。');
  lines.push('');

  // 策略总览
  lines.push('### 策略总览');
  lines.push('');
  lines.push('| 品种 | 锚定合约 | 方向 | 置信度 | 主策略/模板 | 状态 |');
  lines.push('|------|---------|------|--------|-------------|------|');
  for (const p of plan.plans) {
    const primary = p.matchedStrategies[0];
    lines.push(`| ${p.symbol} ${p.name} | ${p.contract || '—'} | ${directionLabel(p.reportBaseline.direction)} | ${confidenceLabel(p.reportBaseline.confidence)} | ${primary.strategyId} + ${p.playbook.playbookId} | ${statusBadge(p.executionStatus)} |`);
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
    lines.push(`- **入场机会点**: ${p.entry.trigger}（触发价 ${triggerLevel}）`);
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
