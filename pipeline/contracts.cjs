// pipeline/contracts.cjs — futures-radar v2.0.0
// Six-module pipeline contract (V2). Single source of truth for artifacts,
// phases, and stages. pipeline/run.cjs consumes this file only.
//
// 六大模块（按用户架构编号）：
//   1 stories   故事链
//   2 analysis  机会分析（含交易策略子模块）
//   3 signals   信号池
//   4 collection 数据采集（公用）
//   5 storage   文件库（公用）
//   6 output    结果输出（公用）
//
// 执行顺序（数据流）：4 数据采集 → 5 文件库 → 1 故事链 → 2 机会分析 → 3 信号池 → 6 结果输出

'use strict';

const artifacts = [
  // ── Phase 4: 数据采集 ──
  { id: 'source-probe', path: '{runDir}/source-probe.json', stage: 'source-probe', phase: 'data-collection', required: true, producedBy: 'collection/probe-sources.cjs' },
  { id: 'raw-json', path: '{runDir}/raw.json', stage: 'collect', phase: 'data-collection', required: true, producedBy: 'collection/akshare-futures.cjs' },
  { id: 'raw-snapshot', path: '{runDir}/raw-snapshot.md', stage: 'collect', phase: 'data-collection', required: true, producedBy: 'collection/akshare-futures.cjs' },
  { id: 'provenance-json', path: '{runDir}/provenance.json', stage: 'collect', phase: 'data-collection', required: true, producedBy: 'collection/akshare-futures.cjs' },
  { id: 'sector-snapshot-json', path: '{runDir}/sector-snapshot.json', stage: 'sector', phase: 'data-collection', required: false, producedBy: 'collection/sector-aggregator.cjs' },
  { id: 'macro-snapshot-json', path: '{runDir}/macro-snapshot.json', stage: 'macro', phase: 'data-collection', required: false, producedBy: 'collection/macro-probe.cjs' },

  // ── Phase 5: 文件库 ──
  { id: 'macro-history-index', path: '{skillRoot}/data/macro-history/_index.json', stage: 'macro-history-build', phase: 'file-library', required: false, producedBy: 'storage/macro-history-builder.cjs' },
  { id: 'macro-file-library-json', path: '{skillRoot}/data/macro/{runId}.json', stage: 'collect', phase: 'data-collection', required: false, producedBy: 'collection/macro-probe.cjs (mirror to data/macro)' },
  { id: 'sector-file-library-json', path: '{skillRoot}/data/sector/snapshots/{runId}.json', stage: 'sector', phase: 'data-collection', required: false, producedBy: 'collection/sector-aggregator.cjs (mirror to data/sector/snapshots)' },

  // ── Phase 1: 故事链 ──
  { id: 'news-snapshot-json', path: '{skillRoot}/data/news/{runId}.json', stage: 'story-news', phase: 'story-chain', required: false, producedBy: 'agent WebSearch 现搜现写 + stories/cli/news-snapshot-cli.cjs install' },
  { id: 'story-prompt-md', path: '{runDir}/story-chain-prompt.md', stage: 'story-prompt', phase: 'story-chain', required: false, producedBy: 'stories/cli/story-chain-cli.cjs prompt' },
  { id: 'story-pool-ledger', path: '{skillRoot}/data/story-pool/ledger.json', stage: 'story-register', phase: 'story-chain', required: false, producedBy: 'stories/cli/story-chain-cli.cjs register' },
  { id: 'story-pool-view', path: '{skillRoot}/data/story-pool/view.json', stage: 'story-observe', phase: 'story-chain', required: false, producedBy: 'stories/cli/story-chain-cli.cjs observe' },
  { id: 'filtered-json', path: '{runDir}/filtered.json', stage: 'story-filtered', phase: 'story-chain', required: true, producedBy: 'stories/seats/build-filtered-from-story-pool.cjs' },
  { id: 'candidates-json', path: '{runDir}/candidates.json', stage: 'story-filtered', phase: 'story-chain', required: true, producedBy: 'stories/seats/build-filtered-from-story-pool.cjs (creates/patches story seats)' },

  // ── Phase 2: 机会分析（含交易策略子模块）──
  { id: 'packets-v2-json', path: '{runDir}/analyze/packets-v2.json', stage: 'analysis-freeze', phase: 'opportunity-analysis', required: true, producedBy: 'analysis/v2/packet-freeze-v2.cjs' },
  { id: 'prefill-v2-json', path: '{runDir}/analyze/prefill-v2.json', stage: 'analysis-prefill', phase: 'opportunity-analysis', required: true, producedBy: 'analysis/v2/prefill-v2.cjs' },
  { id: 'prompts-v2-md', path: '{runDir}/analyze/prompts-v2.md', stage: 'analysis-prompt', phase: 'opportunity-analysis', required: true, producedBy: 'analysis/v2/prompt-builder-v2.cjs' },
  { id: 'outputs-v2-json', path: '{runDir}/analyze/outputs-v2.json', stage: 'analysis-llm', phase: 'opportunity-analysis', required: true, producedBy: 'manual (LLM follows prompts-v2.md)' },
  { id: 'audit-prompt-md', path: '{runDir}/analyze/audit-prompt.md', stage: 'analysis-audit-prompt', phase: 'opportunity-analysis', required: true, producedBy: 'analysis/v2/audit-prompt-builder.cjs' },
  { id: 'audit-findings-json', path: '{runDir}/analyze/audit-findings.json', stage: 'analysis-audit-llm', phase: 'opportunity-analysis', required: true, producedBy: 'manual (LLM follows audit-prompt.md)' },
  { id: 'reconciliation-prompt-md', path: '{runDir}/analyze/reconciliation-prompt.md', stage: 'analysis-reconciliation-prompt', phase: 'opportunity-analysis', required: false, producedBy: 'analysis/v2/reconciliation-prompt-builder.cjs' },
  { id: 'outputs-v2-reconciliation-json', path: '{runDir}/analyze/outputs-v2-reconciliation.json', stage: 'analysis-reconciliation-llm', phase: 'opportunity-analysis', required: false, producedBy: 'manual (LLM follows reconciliation-prompt.md，aligned 时可不产出)' },
  { id: 'analysis-json', path: '{runDir}/analysis.json', stage: 'analysis-assemble', phase: 'opportunity-analysis', required: true, producedBy: 'analysis/v2/assemble-v2.cjs --as-production' },
  { id: 'reasoning-results-json', path: '{runDir}/reasoning-results.json', stage: 'analysis-assemble', phase: 'opportunity-analysis', required: true, producedBy: 'analysis/v2/assemble-v2.cjs --as-production' },
  { id: 'probability-json', path: '{runDir}/probability.json', stage: 'probability', phase: 'opportunity-analysis', required: true, producedBy: 'analysis/probability/stage-4-5.cjs' },
  { id: 'report-facts-json', path: '{runDir}/report-facts.json', stage: 'report-facts', phase: 'opportunity-analysis', required: true, producedBy: 'analysis/assembly/build-facts.cjs' },
  { id: 'report-model-json', path: '{runDir}/report-model.json', stage: 'report-model', phase: 'opportunity-analysis', required: true, producedBy: 'analysis/assembly/build-model.cjs' },
  { id: 'strategy-reasoning-prompt-md', path: '{runDir}/strategies/prompts/strategy-reasoning.md', stage: 'strategy-reasoning-prompt', phase: 'opportunity-analysis', required: false, producedBy: 'analysis/strategy/strategy-reasoning-prompt.cjs' },
  { id: 'strategy-reasoning-json', path: '{runDir}/strategy-reasoning.json', stage: 'strategy-reasoning-llm', phase: 'opportunity-analysis', required: false, producedBy: 'manual (LLM follows strategy-reasoning.md)' },

  // ── Phase 3: 信号池 ──
  { id: 'strategy-plan-json', path: '{runDir}/strategy-plan.json', stage: 'strategy-plan', phase: 'signal-pool', required: false, producedBy: 'analysis/strategy/build-strategy-plan.cjs' },
  { id: 'signal-pool-json', path: '{runDir}/signal-pool.json', stage: 'strategy-plan', phase: 'signal-pool', required: false, producedBy: 'analysis/strategy/build-strategy-plan.cjs (updates signals/lib/signal-pool.cjs)' },
  { id: 'signal-pool-ledger', path: '{skillRoot}/data/signal-pool/ledger.json', stage: 'strategy-plan', phase: 'signal-pool', required: false, producedBy: 'signals/lib/signal-pool.cjs (ledger)' },
  { id: 'strategy-feedback-json', path: '{runDir}/strategy-feedback.json', stage: 'strategy-plan', phase: 'signal-pool', required: false, producedBy: 'analysis/strategy/build-strategy-plan.cjs' },

  // ── Phase 6: 结果输出 ──
  { id: 'report', path: '{runDir}/report.md', stage: 'render-markdown', phase: 'result-output', required: true, producedBy: 'output/render-markdown.cjs' },
  { id: 'report-html', path: '{runDir}/report.html', stage: 'render-markdown', phase: 'result-output', required: false, producedBy: 'output/render-markdown.cjs → render-report-html.cjs' },
  { id: 'dashboard-html', path: '{runtimeRoot}/dashboard.html', stage: 'render-markdown', phase: 'result-output', required: false, producedBy: 'output/render-markdown.cjs → render-dashboard-html.cjs' },
  { id: 'current', path: '{runtimeRoot}/current.md', stage: 'publish-current', phase: 'result-output', required: false, producedBy: 'manual (LLM updates current.md)' }
];

const phases = [
  {
    id: 'data-collection',
    seq: 4,
    runOrder: 1,
    module: 'collection',
    name: '数据采集（公用）',
    description: '探测数据源、采集期货行情、构建板块与宏观快照；宏观/板块失败 warn，其余 hard_fail。',
    stages: [
      { id: 'source-probe', name: '数据源探测', auto: true, script: 'collection/probe-sources.cjs', args: (runId) => ['--runId', runId, '--reuse-if-fresh'], inputs: [], outputs: ['source-probe'], failurePolicy: 'hard_fail', note: '窗口内复用探针，避免背靠背 456。' },
      { id: 'collect', name: '采集 (akshare 期货行情)', auto: true, script: 'collection/akshare-futures.cjs', args: (runId) => ['--runId', runId], inputs: ['source-probe'], outputs: ['raw-json', 'raw-snapshot', 'provenance-json'], failurePolicy: 'hard_fail', note: '并行采集 + 增量缓存 + snapshot-first + CFMMC 验证；同时镜像文件库。' },
      { id: 'sector', name: '板块聚合指标', auto: true, script: 'collection/sector-aggregator.cjs', args: (runId) => ['--runId', runId], inputs: ['raw-json'], outputs: ['sector-snapshot-json'], failurePolicy: 'warn', note: '由 raw.json 确定性构建板块指数/广度/领涨领跌；不使用持仓数据。' },
      { id: 'macro', name: '宏观锚点采集', auto: true, script: 'collection/macro-probe.cjs', args: (runId) => ['--runId', runId], inputs: ['raw-json'], outputs: ['macro-snapshot-json'], failurePolicy: 'warn', note: '5 个冻结宏观锚点（DXY/USDCNH/US10Y/DR007/SC0）；失败不阻断管道。' }
    ]
  },
  {
    id: 'file-library',
    seq: 5,
    runOrder: 2,
    module: 'storage',
    name: '文件库（公用）',
    description: '校验文件库并重建宏观历史序列；数据唯一事实源=data/。',
    stages: [
      { id: 'storage-verify', name: '文件库校验', auto: true, script: 'storage/index.cjs', args: () => ['--verify'], inputs: [], outputs: [], failurePolicy: 'warn', note: '轻量文件库完整性校验（不修复、不联网）。' },
      { id: 'macro-history-build', name: '宏观历史序列重建', auto: true, script: 'storage/macro-history-builder.cjs', args: () => ['--build'], inputs: [], outputs: ['macro-history-index'], failurePolicy: 'warn', note: '从冻结 v4 宏观历史 + data/macro/<RUN_ID>.json 重建 data/macro-history/*。' }
    ]
  },
  {
    id: 'story-chain',
    seq: 1,
    runOrder: 3,
    module: 'stories',
    name: '故事链',
    description: '新闻快照（少而精）→ 状态唤醒提示词 → 构造传导链（含推理卡）→ 逐日观察推进状态 → 由故事池重写 filtered.json（filter-llm 已退役）。',
    stages: [
      { id: 'story-news', name: '新闻/政策快照 (agent WebSearch)', auto: false, script: null, args: null, inputs: [], outputs: ['news-snapshot-json'], failurePolicy: 'hard_fail', note: 'agent 现搜现写 output/runs/<runId>/news-snapshot.json（少而精：宏观3-5+每板块1-3，总量≤20，多来源优先），再 node stories/cli/news-snapshot-cli.cjs install --runId <runId>。' },
      { id: 'story-prompt', name: '故事链状态唤醒提示词', auto: true, script: 'stories/cli/story-chain-cli.cjs', args: (runId) => ['prompt', '--runId', runId], inputs: [], outputs: ['story-prompt-md'], failurePolicy: 'hard_fail', note: '读文件库（data/news/<runId>.json + data/macro/<runId>.json + data/sector/snapshots/<runId>.json，缺失时提示词降级）生成状态唤醒提示词。' },
      { id: 'story-register', name: '故事链登记 (LLM)', auto: false, script: null, args: null, inputs: ['story-prompt-md'], outputs: ['story-pool-ledger'], failurePolicy: 'hard_fail', note: 'LLM 按 stories/blueprint.md 构造传导链（结构 JSON + reasoningCard），运行 stories/cli/story-chain-cli.cjs register --file <json> --batch 入池。' },
      { id: 'story-observe', name: '故事链逐日观察', auto: true, script: 'stories/cli/story-chain-cli.cjs', args: (runId) => ['observe', '--runId', runId], inputs: ['story-pool-ledger', 'macro-file-library-json', 'sector-file-library-json'], outputs: ['story-pool-view'], failurePolicy: 'hard_fail', note: '按文件库 signalDate 推进链状态；日频节点连续 3 数据日同向证明 / 连续 2 反向证伪。' },
      { id: 'story-filtered', name: '故事池重写 filtered.json', auto: true, script: 'stories/seats/build-filtered-from-story-pool.cjs', args: (runId) => ['--runId', runId], inputs: ['raw-json'], outputs: ['filtered-json', 'candidates-json'], failurePolicy: 'hard_fail', note: 'KEEP 唯一来源 = 活跃故事链代表品种 + 有 storyChainId 的信号池追踪席位；无链无信号则空仓合法。同步创建/修补 candidates.json。' }
    ]
  },
  {
    id: 'opportunity-analysis',
    seq: 2,
    runOrder: 4,
    module: 'analysis',
    name: '机会分析（含交易策略子模块）',
    description: '冻结 packet → prefill → 六问第一遍（独立推理，不展示链）→ 审计 LLM 找冲突 → 六问第二遍（仅冲突品种修订增量）→ assemble 合并与 auditImpact 留痕 → 概率锥 → 事实/模型组装 → 交易策略推理输入。',
    stages: [
      { id: 'analysis-freeze', name: '冻结证据 packet v2', auto: true, script: 'analysis/v2/packet-freeze-v2.cjs', args: (runId) => ['--runId', runId], inputs: ['raw-json', 'filtered-json', 'macro-snapshot-json', 'sector-snapshot-json'], outputs: ['packets-v2-json'], failurePolicy: 'hard_fail', note: 'O4/O5 前置：期限结构来自 GA-8 本地基差库，宏观/板块引用冻结快照。' },
      { id: 'analysis-prefill', name: '六问确定性预填 v2', auto: true, script: 'analysis/v2/prefill-v2.cjs', args: (runId) => ['--runId', runId], inputs: ['packets-v2-json'], outputs: ['prefill-v2-json'], failurePolicy: 'hard_fail', note: 'Q2/Q6 确定性预填；Q1/Q4/Q5 标记 pending 交给 LLM。' },
      { id: 'analysis-prompt', name: '六问第一遍提示词 v2', auto: true, script: 'analysis/v2/prompt-builder-v2.cjs', args: (runId) => ['--runId', runId], inputs: ['prefill-v2-json'], outputs: ['prompts-v2-md'], failurePolicy: 'hard_fail', note: '为所有故事席位生成第一遍提示词；注入新闻快照事实，明确声明本阶段不展示传导链内容。' },
      { id: 'analysis-llm', name: '机会深挖 LLM 推理（第一遍）', auto: false, script: null, args: null, inputs: ['prompts-v2-md'], outputs: ['outputs-v2-json'], failurePolicy: 'hard_fail', note: 'LLM 按 prompts-v2.md 完成独立推理，写 analyze/outputs-v2.json。' },
      { id: 'analysis-audit-prompt', name: '审计 LLM 推理输入', auto: true, script: 'analysis/v2/audit-prompt-builder.cjs', args: (runId) => ['--runId', runId], inputs: ['outputs-v2-json', 'packets-v2-json'], outputs: ['audit-prompt-md'], failurePolicy: 'hard_fail', note: '读链推理卡 × 六问第一遍 × 新闻快照，生成对质提示词；每品种冲突点上限 3。' },
      { id: 'analysis-audit-llm', name: '审计 LLM 找冲突', auto: false, script: null, args: null, inputs: ['audit-prompt-md'], outputs: ['audit-findings-json'], failurePolicy: 'hard_fail', note: '审计 LLM 只找语义冲突并给六问具体追问，不判对错、不回问传导链；写 analyze/audit-findings.json。' },
      { id: 'analysis-reconciliation-prompt', name: '六问第二遍推理输入', auto: true, script: 'analysis/v2/reconciliation-prompt-builder.cjs', args: (runId) => ['--runId', runId], inputs: ['audit-findings-json', 'outputs-v2-json', 'packets-v2-json'], outputs: ['reconciliation-prompt-md'], failurePolicy: 'hard_fail', note: '仅 conflict 品种；输入=冲突点+必要事实 id，不重传整条链。aligned 时生成占位提示词。' },
      { id: 'analysis-reconciliation-llm', name: '六问 LLM 最终综合（第二遍）', auto: false, script: null, args: null, inputs: ['reconciliation-prompt-md'], outputs: ['outputs-v2-reconciliation-json'], failurePolicy: 'hard_fail', note: 'conflict 品种写修订增量（auditImpact/auditResponse/revisions），写 analyze/outputs-v2-reconciliation.json；无 conflict 可写空 revisions。' },
      { id: 'analysis-assemble', name: '组装生产六问', auto: true, script: 'analysis/v2/assemble-v2.cjs', args: (runId) => ['--runId', runId, '--as-production'], inputs: ['outputs-v2-json', 'prefill-v2-json', 'packets-v2-json', 'audit-findings-json'], outputs: ['analysis-json', 'reasoning-results-json'], failurePolicy: 'hard_fail', note: 'Q4 语义事实校验 + 置信度护栏；合并第二遍修订并 auditImpact 留痕；promote 生产 analysis.json / reasoning-results.json。' },
      { id: 'probability', name: 'HV 概率锥估算', auto: true, script: 'analysis/probability/stage-4-5.cjs', args: (runId) => ['--runId', runId], inputs: ['analysis-json', 'filtered-json', 'candidates-json', 'raw-json'], outputs: ['probability-json'], failurePolicy: 'hard_fail', note: 'HV 概率锥 + ATR 对比；干净序列口径。' },
      { id: 'report-facts', name: '报告事实组装', auto: true, script: 'analysis/assembly/build-facts.cjs', args: (runId) => ['--runId', runId], inputs: ['candidates-json', 'filtered-json', 'probability-json', 'raw-json'], outputs: ['report-facts-json'], failurePolicy: 'hard_fail', note: '符号 join + 宏观透传 + 数据时效推导。' },
      { id: 'report-model', name: '分析集成', auto: true, script: 'analysis/assembly/build-model.cjs', args: (runId) => ['--runId', runId], inputs: ['report-facts-json', 'analysis-json'], outputs: ['report-model-json'], failurePolicy: 'hard_fail', note: 'Q1-Q6 原文提取 + 方向/置信度 canonical 校验。' },
      { id: 'strategy-reasoning-prompt', name: '交易策略推理输入', auto: true, script: 'analysis/strategy/strategy-reasoning-prompt.cjs', args: (runId) => ['--runId', runId], inputs: ['report-model-json', 'analysis-json', 'probability-json', 'raw-json'], outputs: ['strategy-reasoning-prompt-md'], failurePolicy: 'hard_fail', note: '冻结报告上下文与理论参照，供 Strategy-LLM 做交易表达决策。' },
      { id: 'strategy-reasoning-llm', name: '交易策略 LLM 推理', auto: false, script: null, args: null, inputs: ['strategy-reasoning-prompt-md'], outputs: ['strategy-reasoning-json'], failurePolicy: 'hard_fail', note: 'LLM 按 strategy-reasoning.md 写 strategy-reasoning.json（无理论合适时 theoryFit=none）。' }
    ]
  },
  {
    id: 'signal-pool',
    seq: 3,
    runOrder: 5,
    module: 'signals',
    name: '信号池',
    description: '交易策略计划生成后自动更新信号池：入池/版本追加/出池判定；信号台账供报告与故事链血缘追踪。',
    stages: [
      { id: 'strategy-plan', name: '生成交易策略计划并更新信号池', auto: true, script: 'analysis/strategy/build-strategy-plan.cjs', args: (runId) => ['--runId', runId], inputs: ['report-model-json', 'probability-json', 'raw-json', 'strategy-reasoning-json'], outputs: ['strategy-plan-json', 'strategy-feedback-json', 'signal-pool-json', 'signal-pool-ledger'], failurePolicy: 'hard_fail', note: 'executable 策略诞生信号（入池）、同向后续 plan 追加版本、反向/Q5 证伪/机会衰竭/窗口到期出池。' }
    ]
  },
  {
    id: 'result-output',
    seq: 6,
    runOrder: 6,
    module: 'output',
    name: '结果输出（公用）',
    description: '渲染 report.md / report.html / 四 Tab 看板；可选 LLM 发布 current.md。',
    stages: [
      { id: 'render-markdown', name: '渲染报告与看板', auto: true, script: 'output/render-markdown.cjs', args: (runId) => ['--runId', runId], inputs: ['report-model-json', 'signal-pool-json', 'strategy-plan-json'], outputs: ['report', 'report-html', 'dashboard-html'], failurePolicy: 'hard_fail', note: '报告四章 + 交易策略板块 + 信号池明细；同时生成 report.html 与 output/dashboard.html。' },
      { id: 'publish-current', name: '发布 current.md (LLM)', auto: false, script: null, args: null, inputs: ['report'], outputs: ['current'], failurePolicy: 'warn', note: 'LLM 用本期 runId、报告摘要与关键候选更新 current.md。' }
    ]
  }
];

const stages = phases
  .slice()
  .sort((a, b) => a.runOrder - b.runOrder)
  .flatMap((p) => p.stages.map((s) => ({ ...s, phase: p.id, phaseName: p.name, phaseSeq: p.seq })));

function findArtifact(id) {
  return artifacts.find((a) => a.id === id);
}

function findStage(id) {
  return stages.find((s) => s.id === id);
}

module.exports = { artifacts, phases, stages, findArtifact, findStage };
