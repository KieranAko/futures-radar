// pipeline/contracts.cjs — futures-radar v0.1.16
// Single source of truth for artifact and stage declarations.
// Shared by pipeline/run.cjs (orchestrator).
//
// Pipeline: source-probe → collect → macro → scan → filter-hard → filter-llm → analyze → probability → report
// auto stages: source-probe, collect, macro, scan, filter-hard, probability
// manual (LLM) stages: filter-llm, analyze, report

const artifacts = [
  {
    id: 'source-probe',
    path: '{runDir}/source-probe.json',
    stage: 'source-probe',
    required: true,
    producedBy: 'collector/probe-sources.cjs',
    consumedBy: ['consistency']
  },
  {
    id: 'raw-json',
    path: '{runDir}/raw.json',
    stage: 'collect',
    required: true,
    producedBy: 'collector/akshare-futures.cjs',
    consumedBy: ['scan', 'macro', 'report']
  },
  {
    id: 'raw-snapshot',
    path: '{runDir}/raw-snapshot.md',
    stage: 'collect',
    required: true,
    producedBy: 'collector/akshare-futures.cjs',
    consumedBy: ['report']
  },
  {
    id: 'provenance-json',
    path: '{runDir}/provenance.json',
    stage: 'collect',
    required: true,
    producedBy: 'collector/akshare-futures.cjs',
    consumedBy: ['consistency']
  },
  {
    id: 'macro-snapshot-json',
    path: '{runDir}/macro-snapshot.json',
    stage: 'macro',
    required: false,
    producedBy: 'collector/macro-probe.cjs',
    consumedBy: ['report-5a'],
    note: 'Phase 3 阶段一：5 个冻结宏观锚点快照（DXY/USDCNH/US10Y/DR007/SC0）。单指标失败标 missing；整阶段失败不阻断管道（failurePolicy=warn）。旧 run 缺失时报告显示宏观数据不可用'
  },
  {
    id: 'sector-snapshot-json',
    path: '{runDir}/sector-snapshot.json',
    stage: 'sector',
    required: false,
    producedBy: 'collector/sector-aggregator.cjs',
    consumedBy: ['analyze', 'report-5a'],
    note: 'v0.1.5：由 raw.json 确定性构建的板块指数/广度/领涨领跌快照（不使用持仓数据）。失败不阻断管道；analyze 可回退现场重算。'
  },
  {
    id: 'candidates-json',
    path: '{runDir}/candidates.json',
    stage: 'scan',
    required: true,
    producedBy: 'scanner/index.cjs',
    consumedBy: ['filter-hard', 'filter-llm', 'report']
  },
  {
    id: 'filtered-hard-json',
    path: '{runDir}/filtered-hard.json',
    stage: 'filter-hard',
    required: true,
    producedBy: 'filter/hard-filter.cjs',
    consumedBy: ['filter-llm'],
    note: 'Hard-filtered candidates — LLM must NOT resurrect items filtered out here'
  },
  {
    id: 'filtered-json',
    path: '{runDir}/filtered.json',
    stage: 'filter-llm',
    required: true,
    producedBy: 'manual (LLM follows filter/blueprint.md)',
    consumedBy: ['analyze', 'report'],
    note: '≤3 candidates after soft filter. LLM cannot resurrect items removed by filter-hard.'
  },
  {
    id: 'evidence-packets-json',
    path: '{runDir}/evidence-packets.json',
    stage: 'analyze',
    required: true,
    producedBy: 'manual Analyze evidence freeze',
    consumedBy: ['analyze']
  },
  {
    id: 'main-series-json',
    path: '{runDir}/analyze/main-series.json',
    stage: 'analyze',
    required: false,
    producedBy: 'analyze/freeze-packets.mjs',
    consumedBy: ['probability'],
    note: 'P0: 当日主导合约自身 OHLCV 序列（HV/ATR/现价干净口径）；旧 run 缺失时 probability 回退 raw.json'
  },
  {
    id: 'reasoning-results-json',
    path: '{runDir}/reasoning-results.json',
    stage: 'analyze',
    required: true,
    producedBy: 'manual Analyze via reasoning runner',
    consumedBy: ['analyze', 'report-5b']
  },
  {
    id: 'analysis-json',
    path: '{runDir}/analysis.json',
    stage: 'analyze',
    required: true,
    producedBy: 'manual (LLM follows analyze/blueprint.md)',
    consumedBy: ['probability', 'report-5b']
  },
  {
    id: 'probability-json',
    path: '{runDir}/probability.json',
    stage: 'probability',
    required: true,
    producedBy: 'probability/stage-4-5.cjs',
    consumedBy: ['report-5a'],
    note: 'HV probability cones + ATR comparison for KEEP candidates'
  },
  {
    id: 'report-facts-json',
    path: '{runDir}/report-facts.json',
    stage: 'report-5a',
    required: true,
    producedBy: 'report/build-facts.cjs',
    consumedBy: ['report-5b'],
    note: 'Stage 5A: Deterministic facts assembly from 3 JSON artifacts (candidates, filtered, probability)'
  },
  {
    id: 'report-model-json',
    path: '{runDir}/report-model.json',
    stage: 'report-5b',
    required: true,
    producedBy: 'report/build-model.cjs',
    consumedBy: ['report-5c'],
    note: 'Stage 5B: Analysis integration with thesis layer'
  },
  {
    id: 'report',
    path: '{runDir}/report.md',
    stage: 'report-5c',
    required: true,
    producedBy: 'report/render-markdown.cjs',
    consumedBy: ['consistency', 'current'],
    note: 'Stage 5C: Markdown rendering from report-model.json'
  },
  {
    id: 'current',
    path: '{runtimeRoot}/current.md',
    stage: 'publish-current',
    required: false,
    producedBy: 'manual (LLM updates after report)',
    consumedBy: []
  }
];

// Pipeline stages in topological order.
// auto=true: deterministic script; auto=false: LLM/manual work.
const stages = [
  // ── Stage 0: Source Probe ──
  {
    id: 'source-probe',
    label: '数据源探测',
    auto: true,
    dependsOn: [],
    inputs: [],
    outputs: ['source-probe'],
    validators: [],
    failurePolicy: 'hard_fail',
    rebuildCommand: 'node collector/probe-sources.cjs --runId {runId}',
    script: 'collector/probe-sources.cjs',
    args: (runId) => ['--runId', runId, '--reuse-if-fresh'] // P2：窗口内复用探针，避免背靠背 456
  },

  // ── Stage 1: Collect ──
  {
    id: 'collect',
    label: '采集 (akshare 期货行情)',
    auto: true,
    dependsOn: ['source-probe'],
    inputs: ['source-probe'],
    outputs: ['raw-json', 'raw-snapshot', 'provenance-json'],
    validators: [],
    failurePolicy: 'hard_fail',
    rebuildCommand: 'node collector/akshare-futures.cjs --runId {runId}',
    script: 'collector/akshare-futures.cjs',
    args: (runId) => ['--runId', runId],
    note: 'Implemented: parallel collect + incremental cache + snapshot-first + CFMMC verification. Also mirrors bars into data-store.'
  },

  // ── Stage 1.4: Sector (v0.1.5) ──
  {
    id: 'sector',
    label: '板块聚合指标',
    auto: true,
    dependsOn: ['collect'],
    inputs: ['raw-json'],
    outputs: ['sector-snapshot-json'],
    validators: [],
    failurePolicy: 'warn',
    rebuildCommand: 'node collector/sector-aggregator.cjs --runId {runId}',
    script: 'collector/sector-aggregator.cjs',
    args: (runId) => ['--runId', runId],
    note: '由 raw.json 确定性构建板块指数/广度/领涨领跌；不使用持仓数据；失败不阻断管道。'
  },

  // ── Stage 1.5: Macro (Phase 3 阶段一) ──
  {
    id: 'macro',
    label: '宏观锚点采集 (Phase 3 阶段一)',
    auto: true,
    dependsOn: ['collect'],
    inputs: ['raw-json'],
    outputs: ['macro-snapshot-json'],
    validators: [],
    failurePolicy: 'warn',
    rebuildCommand: 'node collector/macro-probe.cjs --runId {runId}',
    script: 'collector/macro-probe.cjs',
    args: (runId) => ['--runId', runId],
    note: '5 个冻结宏观锚点（DXY/USDCNH/US10Y/DR007/SC0）快照写入 macro-snapshot.json。单指标失败标 missing；整阶段失败不阻断期货雷达。报告阶段不联网。'
  },

  // ── Stage 2: Scan ──
  {
    id: 'scan',
    label: '波动率扫描与排名',
    auto: true,
    dependsOn: ['collect'],
    inputs: ['raw-json'],
    outputs: ['candidates-json'],
    validators: [],
    failurePolicy: 'hard_fail',
    rebuildCommand: 'node scanner/index.cjs --runId {runId}',
    script: 'scanner/index.cjs',
    args: (runId) => ['--runId', runId],
    note: 'Implemented: ATR/HV percentile weighted ranking, Top 10 output.'
  },

  // ── Stage 3a: Filter-Hard ──
  {
    id: 'filter-hard',
    label: '确定性硬过滤',
    auto: true,
    dependsOn: ['scan'],
    inputs: ['candidates-json'],
    outputs: ['filtered-hard-json'],
    validators: [],
    failurePolicy: 'hard_fail',
    rebuildCommand: 'node filter/hard-filter.cjs --runId {runId}',
    script: 'filter/hard-filter.cjs',
    args: (runId) => ['--runId', runId],
    note: 'Phase 5 implementation (auto/deterministic stage, not LLM). Applies filter/rules.json.'
  },

  // ── Stage 3b: Filter-LLM (Manual) ──
  {
    id: 'filter-llm',
    label: '软过滤 (LLM)',
    auto: false,
    dependsOn: ['filter-hard'],
    inputs: ['filtered-hard-json', 'candidates-json'],
    outputs: ['filtered-json'],
    validators: [],
    failurePolicy: 'hard_fail',
    manualInstruction: 'LLM: read filter/blueprint.md. From filtered-hard.json, evaluate each candidate against 5 soft criteria. Downgrade/keep/mark观望. ≤3 candidates. ABSOLUTELY FORBIDDEN: resurrecting items removed by filter-hard. Output: filtered.json.',
    note: 'LLM: read filter/blueprint.md. Evaluate each candidate from filtered-hard.json. Downgrade/keep/mark观望. ≤3. Do NOT resurrect hard-filtered items.'
  },

  // ── Stage 4: Analyze (Manual) ──
  {
    id: 'analyze',
    label: '6问深度分析 (LLM)',
    auto: false,
    dependsOn: ['filter-llm'],
    inputs: ['filtered-json', 'raw-json'],
    outputs: ['evidence-packets-json', 'reasoning-results-json', 'analysis-json'],
    validators: [],
    failurePolicy: 'hard_fail',
    manualInstruction: 'LLM: read analyze/blueprint.md. Freeze evidence packets → complete sector-driver LLM (板块级归因，不混用个股Q1) → assemble-sector-driver → run FinCoT via reasoning runner → parser+grounding → then write 6-question framework referencing evidence_ids/opposing_ids/invalidate_if. Use WebSearch for industry news/policy events. Do NOT fabricate drivers. Output: evidence-packets.json, sector-driver.json, reasoning-results.json, analysis.json.',
    note: 'LLM: read analyze/blueprint.md. Freeze packets → sector-driver → FinCoT → 6Q framework. No driver fabrication, no sector/individual evidence mixing.'
  },

  // ── Stage 4.5: Probability (Auto) ──
  {
    id: 'probability',
    label: 'HV 概率锥估算',
    auto: true,
    dependsOn: ['analyze'],
    inputs: ['filtered-json', 'candidates-json', 'raw-json'],
    outputs: ['probability-json'],
    validators: [],
    failurePolicy: 'hard_fail',
    rebuildCommand: 'node probability/stage-4-5.cjs --runId {runId}',
    script: 'probability/stage-4-5.cjs',
    args: (runId) => ['--runId', runId],
    note: 'Auto stage: Calculate HV-based probability cones and ATR comparison for KEEP candidates'
  },

  // ── Stage 5A: Report Facts Assembly (Auto) ──
  {
    id: 'report-5a',
    label: '报告事实组装 (确定性)',
    auto: true,
    dependsOn: ['probability'],
    inputs: ['candidates-json', 'filtered-json', 'probability-json', 'macro-snapshot-json', 'raw-json'],
    outputs: ['report-facts-json'],
    validators: [],
    failurePolicy: 'hard_fail',
    rebuildCommand: 'node report/build-facts.cjs --runId {runId}',
    script: 'report/build-facts.cjs',
    args: (runId) => ['--runId', runId],
    note: 'Phase 8-A: Deterministic facts assembly from 3 JSON artifacts + macro-snapshot 透传 + raw.json 时效推导（v0.1.2 freshness card）. Symbol join + provenance tracking + data quality aggregation.'
  },

  // ── Stage 5B: Analysis Integration (Auto) ──
  {
    id: 'report-5b',
    label: '分析集成 (确定性)',
    auto: true,
    dependsOn: ['report-5a'],
    inputs: ['report-facts-json', 'analysis-json'],
    outputs: ['report-model-json'],
    validators: [],
    failurePolicy: 'hard_fail',
    rebuildCommand: 'node report/build-model.cjs --runId {runId}',
    script: 'report/build-model.cjs',
    args: (runId) => ['--runId', runId],
    note: 'Phase 8-A: Deterministic analysis integration. Extract Q1-Q6 raw strings from analysis.json, preserve actual field names, mark assessmentChanged.'
  },

  // ── Stage 5C: Markdown Renderer (Auto) ──
  {
    id: 'report-5c',
    label: 'Markdown 渲染 (确定性)',
    auto: true,
    dependsOn: ['report-5b'],
    inputs: ['report-model-json'],
    outputs: ['report'],
    validators: [],
    failurePolicy: 'hard_fail',
    rebuildCommand: 'node report/render-markdown.cjs --runId {runId}',
    script: 'report/render-markdown.cjs',
    args: (runId) => ['--runId', runId],
    note: 'Phase 8-A: Template-driven markdown generation. 4 chapters + appendix. Data quality warnings by rules. Structure completeness over line count.'
  },

  // ── Publish ──
  {
    id: 'publish-current',
    label: '发布 current.md (LLM)',
    auto: false,
    dependsOn: ['report-5c'],
    inputs: ['report'],
    outputs: ['current'],
    validators: [],
    failurePolicy: 'warn',
    manualInstruction: 'LLM: update current.md with runId, report summary, and key candidates from report.md.',
    note: 'LLM: update current.md with runId, report summary, and key candidates.'
  }
];

module.exports = { artifacts, stages };
