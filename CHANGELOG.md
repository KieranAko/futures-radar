# Changelog

## 0.1.14（2026-08-28）

- **信号质量回测 v6（v5 计划 + 五道安全闸，不新增 LLM）**：新增 `runner-v6.cjs`——复用 v5 冻结的 A/B/C 计划，只更换执行引擎。G1 冲突闸（shock/|chg5|≥8 的 breakout 须宏观+板块同侧）、G2 确认距离闸（C 臂 Q4 位与触发价 ≤1.5×ATR，三层共振可豁免）、G3 目标帽（target1 ≤2×ATR5）、G4 三日确认退出 + 保本/移动止损（MFE<0.5R 第 3 日收盘离场；≥1R 保本；≥1.5R 移动止损）、G5 持仓期失效硬退出
- **v6 三臂结果（样本极小）**：A 8 笔成交方向正确率 50.00%、平均 -1.45%；B 5 笔 100%、+2.20%；C 2 笔 100%、+3.64%。闸跳过 A/B/C = 20/8/27 个信号。C 臂 v5→v6：方向正确率 25%→100%、平均盈亏 -0.99%→+3.64%；归因里的三笔失败被精确处理——SC0 04 冲击追空被 G1 拦、SC0 08 追涨被 G2 拦、RB0 06 由 3 日确认退出从 -0.55% 变 +0.20%
- **版本对齐**：VERSION.md / package.json / SKILL.md / README.md / pipeline banner 统一为 0.1.14；新增 `npm run signal:backtest:v6`
- 新增 signal-backtest-v6 测试 2 条（三臂/旧引擎对照/归因四笔的精确结局）；全量测试 622 → 624（114 → 115 套件）

## 0.1.13（2026-08-28）

- **信号质量回测 v5（紧凑上下文 + 变化驱动 FinCoT，效率版）**：新增 `context-bundle-builder.cjs`（每品种一个 20 行紧凑 bundle，字段短键 + legend，可逐行确定性重建）+ `context-diff.cjs`（宏观多指标翻转/板块/价格均线位势/高影响事件判定，决定 FinCoT fresh 还是 reused）+ `contract-v5.md` + `runner-v5.cjs` + `recordings/v5/`；试点扩到最近 20 锚点×3 品种（2026-03-27..2026-08-14，60 锚点）
- **效率改善**：LLM 输入从 60 个 2.9KB 上下文包 + 30 个 FinCoT 文件，变成 3 个约 21KB 的 bundle + 3 个 diff + 每符号读 1 写 2；FinCoT 60 次 → 51 次 fresh + 9 次 reused（变化驱动复用）
- **C 臂真正消费 FinCoT**：计划必须带 `finCotRefs`（Q 编号 + evidenceRef）；方向与 FinCoT 不一致必须 `diverged`+理由；FinCoT neutral 不得 executable；runner/测试机械校验
- **v5 三臂结果（样本仍小）**：A 纯价格 76 信号→11 执行→10 成交→方向正确率 60.00%、平均 +0.40%；B +上下文 44→7→6→50.00%、-0.13%；C +FinCoT 48→5→4→25.00%、-0.99%。消融：B-A -10pp/-0.53%、C-B -25pp/-0.86%、C-A -35pp/-1.39%。C 臂 4 笔成交全部 aligned；fresh 3 笔 33.33% vs reused 1 笔 0%。样本不足以定论，但 v5 显示 FinCoT 在试点窗口内没有提升方向质量，只降低触发率
- **版本对齐**：VERSION.md / package.json / SKILL.md / README.md / pipeline banner 统一为 0.1.13；新增 `npm run signal:backtest:v5`
- 新增 signal-backtest-v5 测试 8 条（bundle 重建/无泄漏/变化检测/A-B-C 计划与 FinCoT 硬约束/v5 artifact）；全量测试 614 → 622（110 → 114 套件）
- **C 臂逐笔归因（未重跑回测）**：`output/v5-c-arm-attribution.md`——4 笔成交（1 胜 3 负）逐笔核对计划/FinCoT/上下文/实际 bars；结论：Q6 风控文本未结构化、Q4 确认位与触发价脱节、target1 系统性不可达、缺失效/保本/移动退出、冲击后 breakout 追单。给出下一轮改造优先级（riskExecution / exitManagement / target1≤2×ATR5 / shock 禁 breakout / reused FinCoT 需重映射 Q4）

## 0.1.12（2026-08-28）

- **信号质量回测 v4（宏观/板块/事件 + FinCoT 微型试点）**：新增 `context-assembler.cjs`（确定性、asOf 截断）+ `contract-v4.md` + `runner-v4.cjs` + `recordings/v4/`——每品种最近 10 个锚点（2026-06-11..2026-08-14，5 日间隔）共 30 个；每个锚点冻结上下文包（DXY/USDCNH/US10Y/DR007/SC0 宏观序列 + 板块指数/广度/coherence + 事件日历），C 臂逐锚点跑完整六问 FinCoT 并适配报告式操作策略
- **数据扩增**：拉取 47 个板块成员（黑色/农产品/能化）120 日 bars、4 个宏观指标历史序列，冻结于 `recordings/v4/`；事件日历经 web 检索核对（FOMC/CPI/PPI/PMI/LPR/EIA/OPEC/MPOB/WASDE），verified=false 的排期条目只作日程预期
- **三臂消融结果（样本极小，仅试点）**：A 纯价格 42 信号→7 执行→6 成交→方向正确率 66.67%、平均 +1.93%；B +上下文 25→4→3→66.67%、-0.53%；C +完整 FinCoT 25→4→3→66.67%、-0.53%。消融增量：B-A 0pp/-2.46%、C-B 0pp/0%、C-A 0pp/-2.46%。B/C 在 27/30 个锚点的决策字段一致——完整六问 FinCoT 在本试点中没有产生独立增量（但把执行计划数从 A 的 25 收敛到 15，更保守）
- **上下文可溯源**：C 臂每笔信号带 `macroBias/sectorBias/eventRisk/finCotAlignment/contextRefs`；成交 3 笔全部 aligned；输出 `strategies/signal-backtest/output/signal-quality-baseline-v4.md/json`
- **版本对齐**：VERSION.md / package.json / SKILL.md / README.md / pipeline banner 统一为 0.1.12；新增 `npm run signal:backtest:v4`
- 新增 signal-backtest-v4 测试 6 条（asOf 无泄漏、30 上下文包、A/B/C 计划与 FinCoT 校验、v4 artifact 一致性）；全量测试 608 → 614（107 → 110 套件）

## 0.1.11（2026-08-28）

- **信号质量回测 v3（LLM 定性判断优先）**：新增 `strategies/signal-backtest/contract-v3.md` + `runner-v3.cjs` + `recordings/v3/`——立场从“参数组合选优”转为“证伪 LLM 定性判断”；锚点 schema 新增 `regime`（trend/range/transition/shock）、`edge`（trend_continuation/breakout/pullback/mean_reversion/range_fade）、`triggerType`（breakout/pullback）、`qualityFlags`（固定词表 0–3 个）、`thesis` 与 `invalidationReason`；数值参数降级为执行机制，报告不再下“最优组合”结论
- **纯量化对照臂**：同 500 bars、同 T+1/T+2 验证语义，MA20 趋势 + trigger0.5/stop1.5/R2/hold5、不含 LLM——用于回答“LLM 判断多贡献了什么”
- **v3 基线结论**：LLM 锚点臂 380 信号 → 73 触发执行（53 笔成交 + 20 笔跳空放弃）→ 方向正确率 49.06%、平均单笔 -0.23%；纯量化对照臂 876 信号 → 169 执行（116 笔成交）→ 方向正确率 40.52%、平均单笔 -0.16%。**LLM 定性判断方向正确率领先 8.54pp**；qualityFlags 交叉：volume_confirmed 61.11%（18 笔）vs trend_aligned 40.00%（35 笔）；edge 交叉：range_fade 100%（3 笔）、pullback 33.33%（6 笔）、mean_reversion 0%（1 笔）
- **v3 报告**：输出 `strategies/signal-backtest/output/signal-quality-baseline-v3.md/json`（含 regime/edge/triggerType/qualityFlag 交叉证伪表、对照臂对比表、执行参数观察表）
- **版本对齐**：VERSION.md / package.json / SKILL.md / README.md / pipeline banner 统一为 0.1.11；新增 `npm run signal:backtest:v3`
- 新增 signal-backtest-v3 测试 5 条；全量测试 603 → 608（104 → 107 套件）

## 0.1.10（2026-08-28）

- **信号质量回测 v2（2 年 / 5 日锚点）**：`strategies/signal-backtest/` 扩展为 2 年 500 个交易日（2024-08-06..2026-08-27），LLM 锚点间隔 10 → 5 个交易日（285 个锚点，仍只读锚点日及以前截断特征）；recordings 按版本冻结为 `recordings/1y` + `recordings/2y`，v1 基线 artifact 不变
- **淘汰 v1 最差参数组合**：`triggerAtrMult=0.5 × stopAtrMult=1.5 × targetR=2 × maxHoldDays=6`（v1 证伪 2 笔 0%）写入禁用组合契约；LLM 锚点决策禁用，runner 命中即整锚点跳过并计入 `bannedComboSkippedAnchors`（本版 285 个锚点命中 0 个）
- **v2 基线结论**：479 个信号 → 72 个触发执行（50 笔成交 + 22 笔跳空放弃）→ 方向正确率 38.00%、目标1兑现率 12.00%、止损率 34.00%、平均单笔 -0.65%；输出 `strategies/signal-backtest/output/signal-quality-baseline-2y.md/json`（含置信度交叉、参数组合证伪排序、v1 vs v2 对照）
- **数据扩增**：data-store 为 RB0/M0/SC0 摄入 2 年历史（run `signal-history-2y`，500 交易日）；仓库内冻结 `recordings/2y/history-2y.json` 可复现夹具
- **版本对齐**：VERSION.md / package.json / SKILL.md / README.md / pipeline banner 统一为 0.1.10
- 更新 signal-backtest 测试至 12 条（含禁用组合识别、无泄漏审计、v2 artifact 一致性）；全量测试 600 → 603（103 → 104 套件）

## 0.1.9（2026-08-28）

- **信号质量回测路径**：新增 `strategies/signal-backtest/`（`contract.md` 契约 + `runner.cjs` + `recordings/`）——固定 RB0/M0/SC0、1 年 250 个交易日、跳过扫描/筛选；LLM 锚点每 10 个交易日做方向/参数决策（69 个锚点，只读锚点日及以前的截断特征），锚点有效期内确定性规则延续生成信号；T+1 收盘确认 → T+2 开盘执行（跳空放弃）→ 止损/目标1/时间退出证伪
- **基线结论**：185 个信号 → 39 个触发执行（27 笔成交 + 12 笔跳空放弃）→ 方向正确率 44.44%、目标1兑现率 14.81%、止损率 37.04%、平均单笔 -0.82%；输出 `strategies/signal-backtest/output/signal-quality-baseline.md/json`（含置信度交叉与参数组合证伪排序）
- **数据扩增**：data-store 为 RB0/M0/SC0 摄入 250 个交易日历史（2025-08-18..2026-08-27，run `signal-history-1y`），daily 文件库合并保留跨 run 历史
- **版本对齐**：VERSION.md / package.json / SKILL.md / README.md / pipeline banner 统一为 0.1.9
- 新增 signal-backtest 测试 9 条；全量测试 591 → 600（100 → 103 套件）

## 0.1.8（2026-08-27）

- **完整策略链回测试点**：新增 `strategies/backtest/pilot-runner.cjs` + `recordings/manifest.json`——12 品种 × 9 信号日，包含 recorded LLM 软过滤/六问/板块驱动决策 → 截断 raw → sector/概率/报告基线 → strategy-matcher → 冻结 executable 计划 → feedback 验证 → `baseline-report.json/md`
- **feedback 目标解析修复**：目标价推导优先级改为“明确价格 > R 倍数 > 默认 2R”，避免“3d p68 沿”被误解析成价格 3
- **matcher 健壮性**：MS-01 证据串在 MA60/change5d 为 null 时不再抛错，渲染为 “—”
- 试点基线诚实结论：9 期共 2 个 executable 计划，2 个时间离场，方向正确 1/2（样本内、llm-no-web、不具统计意义）

## 0.1.7（2026-08-27）

- **证伪反馈机制**：`strategies/lib/feedback.cjs`——每期 `executionStatus=executable` 的计划冻结到 `data/strategy-feedback/ledger/<runId>.json`；下一次运行用锚定合约 bars（contract-bars，fallback 主力连续代理）验证 T+1 是否触发、止损/目标1/时间离场，并输出归因 codes（trigger_miss/gap_skip/stop_hit/target1_hit/direction_wrong 等）
- **报告回显**：策略板块显示“本期冻结 N 个可执行计划；本次验证往期计划 M 个”，有已验证结果时输出“上一期策略证伪反馈”表（计划/信号日/结果/归因）
- **触发时点语义消歧**：strategy-plan 新增 `entry.triggerTiming`（T+1 收盘确认后下一交易日开盘 / T+1 开盘执行 / 观察无执行时点），PB-07 已按收盘确认语义修复
- **截断交易日回测**：`feedback.buildHistoricalPlan` 严格只读取 signalDate 及之前的 bars 生成计划，测试用真实 SA2701 夹具验证“截断/全量结果一致”并在完整未来 bars 上跑通证伪回测
- 新增 strategy-feedback 测试 5 条；全量测试 585 → 590（100 套件）

## 0.1.6（2026-08-27）

- **交易策略板块（策略库）**：新增 `strategies/` 工作区——四路研究笔记（宏观/细分品类/执行 playbook/风控框架）+ 统一策略库 `strategy-library.json`（23 条策略 MS/CS/PB + riskConfig + positionSizing §9 + planSchema，64 条证据 URL，全部可溯源）+ 可读说明 `strategy-library.md`
- **确定性匹配规则与引擎**：`strategy-matching-rules.json`（计分公式/确定性公式/playbook 状态门/集中度仲裁/workedExample）+ `strategies/lib/strategy-matcher.cjs` + CLI `strategies/build-strategy-plan.cjs --runId`（产出 `output/runs/<runId>/strategy-plan.json`，经 `report/strategy-plan.schema.json` 机械校验；确定性双跑一致）
- **报告「五、交易策略板块（执行参考）」**：`report/render-strategy-section.cjs` 从 `strategy-plan.json` 渲染策略匹配/入场/止损/目标/仓位/风险评估/执行状态/失效退出/免责声明；插入点=第四章后、附录前；`strategy-plan.json` 缺失或为空时自动跳过，四章+附录逐行不变（回归验证 236 行基线全序保留）
- **边界**：每个 TOP3 ≥1 matchedStrategy（BASE-01 报告结论跟随保底）；watch/skip 为合法执行状态且不省略策略适配内容；集中度冲突保留一个 executable 其余 watch；无收益承诺、无新增持仓数据、不构成投资建议
- **审查修复（review round 1 → repair → round 2 pass）**：MS-01 证据串按方向取符号（bullish `>`/bearish `<`）；top-3 截断后的 ≥阈值落选者并入 supportingEvidence（标注「超出展示上限」）；`effectiveRiskConfig()` 使 library.riskConfig 成为风控参数单一事实来源（stopK 分层 high=2.0/medium=1.5，分数→百分数归一，DEFAULTS 仅回退）；执行口径方向化（多头「多头距跌停」/空头「空头距涨停」）
- **观察项处理**：内部证据路径渲染为纯文本并标注「内部」（OBS-1）；strategy-library.md 登记组合级覆盖组件（volTargetBook/drawdownLadder 等）未实现原因（OBS-3，单 run 静态 plan 无组合历史）；既有 artifact 口径差异登记为上游既有问题（OBS-2）
- **可操作性优先 TOP3（v0.1.6 修正）**：`directionBias=neutral` 候选直接降级，不得挤占方向明确、驱动可验证的候选；Top3 先按可操作性筛选再按 score 排序（filter/blueprint.md + quantitative-filter.cjs + SKILL.md）
- **策略板块精简与语义消歧**：每个品种只渲染 9 个关键执行字段；新增 `entry.triggerTiming` 显式区分“T+1 收盘确认后下一交易日开盘”与“T+1 开盘执行”；新增锚定合约展示（Chapter 3 与策略板块均标注主导合约）；修复 PB-07 原“T+1 开盘”歧义
- **版本对齐**：VERSION.md / package.json / SKILL.md / pipeline banner 统一为 0.1.6
- 新增 matcher（21 条）与渲染（12 条）测试；全量测试 552 → 585（98 套件）

## 0.1.5（2026-08-27）

- **板块异动分析**：新增 `collector/sector-aggregator.cjs`——从本 run raw.json 确定性构建板块指数（成员等权日收益链式，基点 1000）、1d/5d/20d 收益、上涨广度、方向 coherence、量比、领涨/领跌代表；不使用持仓数据
- **板块数据入库**：data-store 新增 `data/sector/<SECTOR>.json`（跨 run 板块序列）+ `data/sector/snapshots/<RUN_ID>.json`（冻结快照），`ingestSectorSnapshot` / `getSectorSnapshot` / `getSectorSeries` 维护接口
- **板块驱动 LLM（Sector-Driver）**：板块级证据包 `sector-driver-packets.json` + 板块四分支归因蓝图（聚合状态/宏观背景/板块级基本面事件/成员结构）；门禁强制成员≥3、板块级 WebSearch 证据、方向与观察一致；输出 `sector-driver.json`
- **报告板块异动表**：report 5A/5B/5C 渲染板块方向/涨跌/广度/代表品种 + 驱动线索（来自 sector-driver，不混用个股 Q1）
- **LLM 证据链隔离**：`freeze-packets` 注入 `fields.sector_movement`（观察值）；packet-builder 将 sector_movement 纳入 optional 域；FinCoT 提示词新增板块联动证据域与 `sector_driver_context` 独立上下文（LLM 结论禁止进入 evidence_ids）
- 新增板块聚合/板块驱动/文件库测试；全量测试 542 → 552（89 套件）

## 0.1.4（2026-08-27）

- **轻量数据文件库**：新增 `data-store/` 与 `data/` 文件库（JSON/JSONL，无 SQL）——`daily/<SYMBOL>.json` 当前最优序列 + `ledger/<SYMBOL>/<YYYY-MM>.jsonl` append-only 流水 + `contract-bars/` + `macro/`；采集层写完 raw.json 后自动镜像（失败 warn-only，raw.json 仍是 run 权威）
- **文件库真实接入**：增量缓存优先从文件库读取（旧 raw.json 扫描回退）；回测 `cache-slicer`/`time-sampler`/`batch-runner` 从文件库加载缓存；probability 在 `main-series.json` 缺失时按 runId 回退 `contract-bars`；report 在 `macro-snapshot.json` 缺失时按 runId 回退 `macro`
- **成本口径解耦**：新增 `lib/costs.cjs` 单一真相源，`reasoning/lib/fincot-outcome.js` 不再依赖 backtest
- **保守自动化**：`filter/quantitative-filter.cjs --shadow` 只写 `filtered.quant.json`；新增 `analyze/prefill-analysis.cjs` 只写 `analysis.draft.json`（Q1/Q4/Q5 仍必须 LLM 完成）
- **回测瘦身**：`backtest/` → `research/backtest/`，仅保留核心设计与测试；一次性实验脚本/模型/历史报告移入 `research/archive/`；`experiments/` → `research/experiments/`
- **Golden 基线**：新增 scanner 输出字段级回归测试；全量测试 532 → 542（87 套件）

## 0.1.3（2026-08-27）

- **快照优先增量（snapshot-first）**：日线接口已发布今日 bar 且缓存恰好落后一根时，跳过 ~59 次日线重拉（实测全量 ~13s），用收盘快照一次性补当日 bar（1 次 HTTP 调用）；覆盖率 <90% 或任一品种落后超过一根 → 自动回退日线重拉（fail-open）；CFMMC 交叉验证照常。`collector/futures_collector.py --probe-latest` 新增输出 PREV（上一交易日）；`collector/incremental-cache.cjs` 新增 `probeLatestSinaBarDates` / `planSnapshotFirst`。实测 2026-08-27：59/59 品种补入，raw.json 全序列与官方日线逐字段一致，Top10 扫描排名/分数不变（对照组 20260827-timing-full vs zz-sim-test）；采集阶段 ~13s → ~1s（另加 CFMMC ~3s，DCE 接口故障日受既定退避策略影响约 +7s）。不变量 #8
- **CFMMC 验证并行化**：`collector/cfmmc_daily.py` 5 个市场并发拉取（ThreadPoolExecutor；rows/markets 内容不变，仅完成顺序可变，验证按 variety 过滤不受行序影响）；健康日整层实测 ~11s → ~3s
- **Analyze 冻结单进程化**：`collector/futures-term-structure.py --contracts` 模式附带每合约最近 120 bar（`df_to_bars` 与 `--history` 同口径），`analyze/freeze-packets.mjs` 直接复用主导合约 bars，免二次 spawn 重复下载；payload 缺失回退原 `fetchContractHistory`。实测 packet 数值与旧路径完全一致（ma20/ma60/close_60d/series_contract 逐项相同）
- **管道并行**：`pipeline/run.cjs` Macro ∥ Scan 并发执行（两阶段仅依赖 collect 产物；宏观看门 warn 不阻塞 scan），宏观采集耗时移出关键路径
- 新增 8 个单元测试（planSnapshotFirst 资格判定 / probeLatestSinaBarDates 解析）；全量 532 测试绿；`FUTURES_VERBOSE=1` 可打印快照优先不启用原因

## 0.1.2（2026-08-27）

- 新增收盘快照快速通道 `collector/close-snapshot.cjs`：sina 日线接口收盘后延迟发布时，用收盘快照（date==本地今日 && time>=15:00 完整会话）兜底补入当日 bar（append-only + 来源盖章，冻结不变量 #5）
- 2026-08-27 实测对照：快照 bar 与 CFMMC 官方日线 open/high/low/close/settle/pre_settle/volume/OI 一致
- 环境变量 `FUTURES_FAST_CLOSE=0` 可关闭通道；新增 13 个单元测试（test/close-snapshot.test.js）
- 报告顶部新增**数据时效说明卡片**（report/freshness.cjs：行情末 bar / 当日 bar 来源 / 宏观 asOf 分布 / 采集时刻 / CFMMC 验证状态，确定性推导；新增单元测试）
- **P0 时效闭环**：CFMMC 交叉验证层（collector/cfmmc-verify.cjs + cfmmc_daily.py）——SHFE/INE/GFEX 首轮、DCE 重试 2 次、CZCE 延后比对；三态 verified/diverged/unverified 记 provenance（perSymbol.lastBarVerification）+ 时效卡显示；结算价仅标注 provisional 不修订；`FUTURES_CFMMC_VERIFY=0` 可关；实测 2026-08-27：18 verified / 1 diverged（AP0 成交量 +12.3%）/ 11 unverified（DCE 接口失败，延后）
- **P1 成本速度**：增量缓存（collector/incremental-cache.cjs）——1 次探测 sina 最新 bar 日期 + 复用最近 run raw.json（深拷贝盖章 cacheReused/cacheOriginRunId），只拉缺失品种；缓存超 5 天全量校准；FUTURES_FULL_PULL=1 强制全量。实测：全量 16.5s，全复用采集 0.0s；批量并发维持 4×5（4×15=60 并发实测触发 sina 456，已否决）。顺带修复：独立运行不建 RUN_DIR 导致批次 FileNotFoundError、--probe-latest 被 --symbols required 误拦
- **P2 可靠容错**：统一指数退避 + 冷却（collector/backoff.cjs：批次重试波次冷却 4s、快照分块重试、宏观锚点重试 2 次）；探针 30 分钟窗口复用（--reuse-if-fresh，FUTURES_FORCE_PROBE=1 强制）；宏观外汇备用通道（USDCNH 实时快照兜底，实测 456 时 6.7196 兜底成功；DXY 无备用保持 missing）；三级来源链契约（sina 日线→CFMMC 验证→快照兜底，CFMMC 不进主序列）写入 SKILL.md 不变量 #7；修复 runMacroProbe 异步化

## 0.1.1（2026-08-27）

- 首次独立封装：可从任意位置安装运行（自动探测 skillRoot，运行数据目录可配置）
- 修复测试夹具的机器绝对路径依赖（内置真实 artifact 冻结切片夹具）
- 新增 README / package.json / requirements.txt / .gitignore / 安装脚本
- MIT 许可证
