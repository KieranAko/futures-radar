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

function feedbackStatusLabel(r) {
  const status = r.status || '—';
  if (status === 'verified') {
    const r0 = r.lastResult || r;
    const exit = r0.exitType === 'stopped_out' ? '止损离场' : r0.exitType === 'target1_hit' ? '目标1兑现' : '时间离场';
    const dir = r0.directionCorrect === true ? '（方向正确）' : r0.directionCorrect === false ? '（方向错误）' : '';
    return `${exit}${dir}`;
  }
  if (status === 'invalidated_not_triggered') return '未触发，计划作废';
  if (status === 'skipped_gap') return '跳空放弃';
  if (status === 'confirmed') return '确认信号兑现';
  if (status === 'unverifiable') return '不可验证';
  if (status === 'pending_data') return '待数据';
  if (status === 'triggered_pending_entry') return '已触发待入场数据';
  if (status === 'pending_verification') return '待验证';
  return status;
}

function feedbackAttribution(r) {
  const res = r.lastResult || r;
  return ((res && res.attribution) || []).map((a) => `${a.code}: ${a.detail}`).join('；');
}

function feedbackDirectionConfidenceCell(r) {
  return `${r.direction ? directionLabel(r.direction) : '—'}/${r.confidence ? confidenceLabel(r.confidence) : '—'}`;
}

/**
 * v2 证伪反馈：近 3 期明细 + 历史全量汇总 + 统计口径说明。
 * 只读展示，不修改报告方向与置信度。
 */
function renderFeedbackV2(feedback) {
  const lines = [];
  lines.push('#### 证伪反馈（近3期明细 + 历史汇总）');
  lines.push('');

  const recent = Array.isArray(feedback.recentRuns) ? feedback.recentRuns : [];
  if (recent.length > 0) {
    lines.push('**近 3 期明细**');
    lines.push('');
    for (const run of recent) {
      lines.push(`**${run.runId}**（信号日 ${run.signalDate || '—'}）`);
      lines.push('');
      lines.push('| 计划 | 品种 | 执行状态 | 方向/置信度 | 策略 | 信号日 | 验证结果 | 归因 |');
      lines.push('|------|------|---------|------------|------|--------|---------|------|');
      for (const r of run.rows || []) {
        const symbolCell = `${r.name || r.symbol || '—'} (${r.symbol || '—'})`;
        const strategyCell = `${r.strategyId || '—'} + ${r.playbookId || '—'}`;
        lines.push(`| ${r.recordId || '—'} | ${symbolCell} | ${statusBadge(r.executionStatus)} | ${feedbackDirectionConfidenceCell(r)} | ${strategyCell} | ${r.signalDate || '—'} | ${feedbackStatusLabel(r)} | ${feedbackAttribution(r)} |`);
      }
      lines.push('');
    }
  }

  const s = feedback.summary || {};
  const t = (s.byMode && s.byMode.trade) || {};
  const sg = (s.byMode && s.byMode.signal) || {};
  const exec = s.byExecutionStatus || {};
  const st = s.byStatus || {};

  lines.push('**历史汇总（全量统计）**');
  lines.push('');
  lines.push('| 覆盖度 | 数量 |');
  lines.push('|--------|------|');
  lines.push(`| 历史策略总数 | ${s.totalPlans == null ? '—' : s.totalPlans} |`);
  lines.push(`| 已终态 | ${s.terminalPlans == null ? '—' : s.terminalPlans} |`);
  lines.push(`| 待验证 | ${s.pendingPlans == null ? '—' : s.pendingPlans} |`);
  lines.push('');
  lines.push('| 执行状态 | 数量 |');
  lines.push('|---------|------|');
  lines.push(`| 可执行 | ${exec.executable == null ? '—' : exec.executable} |`);
  lines.push(`| 观察 | ${exec.watch == null ? '—' : exec.watch} |`);
  lines.push(`| 跳过 | ${exec.skip == null ? '—' : exec.skip} |`);
  lines.push('');
  lines.push('| 验证模式 | 记录数 | 已终态 | 待验证 |');
  lines.push('|---------|-------|--------|--------|');
  lines.push(`| 交易模拟（多/空） | ${t.total == null ? '—' : t.total} | ${t.terminal == null ? '—' : t.terminal} | ${t.pending == null ? '—' : t.pending} |`);
  lines.push(`| 信号观察（中性） | ${sg.total == null ? '—' : sg.total} | ${sg.terminal == null ? '—' : sg.terminal} | ${sg.pending == null ? '—' : sg.pending} |`);
  lines.push('');
  lines.push('| 验证状态 | 数量 |');
  lines.push('|---------|------|');
  lines.push(`| 已完整验证（交易模式） | ${st.verified == null ? '—' : st.verified} |`);
  lines.push(`| 未触发作废（交易+信号合计） | ${st.invalidated_not_triggered == null ? '—' : st.invalidated_not_triggered} |`);
  lines.push(`| 跳空放弃 | ${st.skipped_gap == null ? '—' : st.skipped_gap} |`);
  lines.push(`| 确认信号兑现（中性观察） | ${st.confirmed == null ? '—' : st.confirmed} |`);
  lines.push(`| 不可验证 | ${st.unverifiable == null ? '—' : st.unverifiable} |`);
  lines.push(`| 待验证 | ${s.pendingPlans == null ? '—' : s.pendingPlans} |`);
  lines.push('');
  lines.push('| 交易结果（仅已完整验证的交易模式） | 数量 |');
  lines.push('|----------------------------------|------|');
  lines.push(`| 止损离场 | ${t.stoppedOut == null ? '—' : t.stoppedOut} |`);
  lines.push(`| 目标1兑现 | ${t.target1Hit == null ? '—' : t.target1Hit} |`);
  lines.push(`| 时间离场 | ${t.timeExit == null ? '—' : t.timeExit} |`);
  lines.push(`| 方向正确 | ${t.directionCorrect == null ? '—' : t.directionCorrect} |`);
  lines.push(`| 方向错误 | ${t.directionWrong == null ? '—' : t.directionWrong} |`);
  const pct = s.directionCorrectPct == null ? '—' : `${fmt(s.directionCorrectPct, 1)}%`;
  lines.push(`| 方向正确率 | ${pct}${s.directionDenominator ? `（分母 ${s.directionDenominator} 条）` : ''} |`);
  lines.push('');
  lines.push('**统计口径说明**');
  lines.push('');
  lines.push('- 统计对象：历史所有 run 生成的**全部**交易策略（可执行/观察/跳过均纳入），每期最多 3 条，历史记录只增不减。');
  lines.push('- 状态库是唯一事实源：近 3 期明细与历史汇总同源；明细只展示最近 3 个生产 run，其余历史（含实验线 mirror 回放计划）全部进入本汇总。');
  lines.push('- 已终态：完整验证、未触发作废、跳空放弃、不可验证、确认信号兑现；待验证：待验证、待数据、已触发待入场数据。');
  lines.push('- 交易模拟（多/空）：按 T+1 触发 → 跳空放弃 → 止损/目标/时间退出进行假想执行验证。');
  lines.push('- 信号观察（中性）：只验证观察窗口内确认信号是否兑现；不进入交易结果统计，也不进入方向正确率。');
  lines.push('- 方向正确率 = 已完整验证的交易模式中方向正确条数 ÷ 可判定条数；未触发、跳空放弃、不可验证、待验证均不计入分母。');
  return lines.join('\n');
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

function renderStrategySection(plan, library, familyEvidence = null, closeMap = null) {
  const lines = [];
  lines.push('## 三、交易策略');
  lines.push('');
  lines.push(`> 运行 ID: ${plan.meta.runId} | 信号日: ${plan.meta.signalDate} | 示例权益: ${plan.meta.equityCny} CNY`);
  lines.push('> 由报告结论确定性生成，不改变方向与置信度。');
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
    const primary = p.matchedStrategies[0];
    const supporting = (p.supportingEvidence || []).map(s => `${s.strategyId} ${s.name}`).join('、');
    const ra = p.riskAssessment;
    const triggerLevel = p.entry.triggerLevel == null ? '—' : fmt(p.entry.triggerLevel, 0);

    if (p.strategyConfidence) {
      // Strategy-LLM 版：分组表格呈现，信息按“结论 → 执行 → 风险”排列
      const downgrade = p.confidenceDowngradeReasons && p.confidenceDowngradeReasons.length
        ? `（${p.confidenceDowngradeReasons.join('；')}）`
        : '';
      const fitLabel = p.theoryFit === 'aligned' ? '较好符合' : p.theoryFit === 'approximate' ? '大致符合' : '无合适理论';
      const t = planTrust(p, familyEvidence);

      lines.push(`### ${p.symbol} ${p.name}（锚定合约 ${p.contract || '—'}）`);
      lines.push('');
      lines.push(`> **报告** ${directionLabel(p.reportBaseline.direction)} / ${confidenceLabel(p.reportBaseline.confidence)}置信 · **策略表达** ${confidenceLabel(p.strategyConfidence)}置信${downgrade} · **状态** ${statusBadge(p.executionStatus)} · **理论** ${fitLabel}`);
      if (p.theoryGapNote) lines.push(`> ${p.theoryGapNote}`);
      lines.push('');
      lines.push('| 执行要素 | 内容 |');
      lines.push('|---------|------|');
      if (closeMap && closeMap[p.symbol] != null) {
        lines.push(`| 收盘价基准 | ${fmt(closeMap[p.symbol], 0)}（锚定合约 ${p.contract || '—'}） |`);
      }
      lines.push(`| 入场机会点 | ${p.entry.trigger}（触发价 ${triggerLevel}） |`);
      lines.push(`| 触发/执行时点 | ${p.entry.triggerTiming} |`);
      lines.push(`| 执行口径 | ${p.playbook.executionConvention} |`);
      lines.push(`| 止损 | ${fmt(p.stop.stopPrice)}（距离 ${fmt(p.stop.stopDistancePts)} 点；${p.stop.basis}） |`);
      lines.push(`| 目标 | T1 ${p.targets.t1}；T2 ${p.targets.t2} |`);
      lines.push(`| 仓位 | ${p.position.lots} 手（${p.position.lotsBasis}） |`);
      lines.push(`| 证伪/失效 | ${p.invalidation.hard.join('；')}；${p.invalidation.timeStop} |`);
      if (p.executionStatus === 'watch' || p.executionStatus === 'skip') {
        lines.push(`| 转执行触发 | ${p.entry.trigger} |`);
      }
      lines.push('');
      lines.push('| 风险与依据 | 内容 |');
      lines.push('|-----------|------|');
      lines.push(`| 每手风险 | ${Math.round(ra.unitRiskCny)} CNY |`);
      lines.push(`| 保证金/手 | ${Math.round(ra.marginPerLotCny)} CNY |`);
      lines.push(`| 尾部 3d p95 反向边距 | ${fmt(ra.tailGapPct3d)}% |`);
      lines.push(`| 事件风险 | ${ra.eventRiskNote || '—'} |`);
      lines.push(`| 策略依据 | ${primary.strategyId} ${primary.name}${supporting ? `；辅证：${supporting}` : ''} |`);
      lines.push(`| 状态说明 | ${p.statusReasons.length ? p.statusReasons.join('；') : '—'} |`);
      lines.push(`| 可信度 | ${t.grade}（${t.why}） |`);
      if (p.notes && p.notes.length > 0) lines.push(`| 备注 | ${p.notes.join('；')} |`);
      lines.push('');
      continue;
    }

    // 旧版计划：保持原格式，历史 run 回放一致
    lines.push(`### ${p.symbol} ${p.name}（锚定合约 ${p.contract || '—'}）`);
    lines.push('');
    lines.push(`- **报告基准**: ${directionLabel(p.reportBaseline.direction)} / ${confidenceLabel(p.reportBaseline.confidence)}置信；主策略 ${primary.strategyId} ${primary.name}；执行模板 ${p.playbook.playbookId}`);
    if (closeMap && closeMap[p.symbol] != null) {
      lines.push(`- **收盘价基准**: ${fmt(closeMap[p.symbol], 0)}（锚定合约 ${p.contract || '—'}）`);
    }
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
  return `${lines.join('\n')}\n`;
}

// 证伪反馈明细：从交易策略主章节移出，集中到附录 C（全展开）。
// 输入：strategy-feedback.json + forward-ledger.json；两者都无有效内容时返回空字符串。
function renderFeedbackAppendix(feedback, forwardLedger = null, planRunId = null) {
  const hasMeta = !!(feedback && feedback.meta);
  const hasV2 = !!(feedback && feedback.schema === 'futures-radar-strategy-feedback/2');
  const hasLegacy = !!(feedback && Array.isArray(feedback.results) && feedback.results.length > 0);
  const prevRun = forwardLedger && forwardLedger.previousRun && forwardLedger.previousRun !== planRunId
    ? forwardLedger.previousRun
    : null;
  const prev = prevRun ? forwardLedger.runs[prevRun] : null;
  if (!hasMeta && !hasV2 && !hasLegacy && !prev) return '';

  const lines = [];
  lines.push('### 4.3 证伪反馈明细');
  lines.push('');

  if (hasMeta) {
    if (hasV2) {
      const recorded = feedback.meta.recordedThisRun == null ? '—' : feedback.meta.recordedThisRun;
      const attempted = feedback.meta.incrementalAttempted == null ? 0 : feedback.meta.incrementalAttempted;
      lines.push(`> 本期记录 ${recorded} 条策略进入证伪闭环；增量验证 ${attempted} 条未终态记录；历史累计 ${feedback.meta.totalPlans ?? '—'} 条（已终态 ${feedback.meta.terminalPlans ?? '—'} / 待验证 ${feedback.meta.pendingPlans ?? '—'}）。`);
    } else {
      const recorded = feedback.meta.recorded == null ? '—' : feedback.meta.recorded;
      const verified = feedback.meta.verified == null ? 0 : feedback.meta.verified;
      lines.push(`> 本期冻结 ${recorded} 个可执行计划；本次验证往期计划 ${verified} 个。`);
    }
  }

  if (prev) {
    const detail = (prev.rows || []).map((r) => `${r.symbol}:${r.status}${r.netPnlPct != null ? `(${r.netPnlPct}%)` : ''}`).join('；');
    lines.push(`> 前向验证（上期 ${prevRun}）：计划 ${prev.summary.plans} 条，已完成 ${prev.summary.verified}，待数据 ${prev.summary.pendingData}，未触发 ${prev.summary.triggerMiss}；${detail || '无明细'}`);
  }

  if (hasV2) {
    lines.push('');
    lines.push(renderFeedbackV2(feedback));
    lines.push('');
  } else if (hasLegacy) {
    const done = feedback.results.filter((r) => r.status !== 'pending_data');
    if (done.length > 0) {
      lines.push('');
      lines.push('#### 上一期证伪反馈');
      lines.push('');
      lines.push('| 计划 | 品种 | 方向/置信度 | 策略 | 信号日 | 验证结果 | 归因 |');
      lines.push('|------|------|------------|------|--------|---------|------|');
      for (const r of done) {
        const resultLabel = r.status === 'verified'
          ? `${r.exitType === 'stopped_out' ? '止损离场' : r.exitType === 'target1_hit' ? '目标1兑现' : '时间离场'}${r.directionCorrect ? '（方向正确）' : '（方向错误）'}`
          : r.status === 'invalidated_not_triggered' ? '未触发，计划作废' : r.status;
        const attr = (r.attribution || []).map((a) => `${a.code}: ${a.detail}`).join('；');
        const symbolCell = `${r.name || r.symbol || '—'} (${r.symbol || '—'})`;
        const dirConfCell = `${r.direction ? directionLabel(r.direction) : '—'}/${r.confidence ? confidenceLabel(r.confidence) : '—'}`;
        const strategyCell = `${r.strategyId || '—'} + ${r.playbookId || '—'}`;
        lines.push(`| ${r.recordId} | ${symbolCell} | ${dirConfCell} | ${strategyCell} | ${r.signalDate || '—'} | ${resultLabel} | ${attr} |`);
      }
      lines.push('');
    }
  }

  return `${lines.join('\n')}\n`;
}

// ── 插入点：主报告「机会分析」之后、首个附录之前 ──
function composeReportWithStrategy(baseReport, sectionMarkdown) {
  const idx = baseReport.search(/\n## 四、附录/);
  if (idx === -1) return `${baseReport}\n\n${sectionMarkdown}\n`;
  return `${baseReport.slice(0, idx)}\n${sectionMarkdown}\n${baseReport.slice(idx)}`;
}

module.exports = { renderStrategySection, renderFeedbackAppendix, composeReportWithStrategy };
