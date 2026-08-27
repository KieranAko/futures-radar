# 交易策略板块审查报告（t11 + t14 复审）

- 审查对象: 策略库 `strategies/strategy-library.json`、匹配规则 `strategies/strategy-matching-rules.json`、契约 `strategies/report-strategy-section.md`、实现 `strategies/lib/strategy-matcher.cjs` + `report/render-strategy-section.cjs` + `report/render-markdown.cjs`、产物 `output/runs/20260827-1910-auto/strategy-plan.json` 与 report.md 第五章
- 审查人: reviewer（策略审查员）
- 依据: t10 验证报告（`strategies/verification-report.md`，F-1/F-2 移交）与本次独立复核 + 扩展审查
- 审查维度: 成熟可靠 / 与 TOP3 原分析逻辑自洽 / 风险提示完整 / 无可执行性矛盾 / 契约与实现一致 / 单一事实来源一致

## 1. 总体结论

**verdict = needs_revision**

实现主体质量高：确定性匹配管线、风控六步、集中度仲裁、渲染契约、测试覆盖（580/580 含新增 28 条）均通过独立复核，四维度主项（成熟可靠/自洽/风险完整/可执行）无 blocker。但存在 2 项 medium 缺陷（F-1 报告展示假命题、F-3 单一事实来源漂移）与 2 项 low 缺陷（F-2 边界丢弃、F-4 方向不适配条款），其中 F-1 直接呈现在最终报告文本中，必须修复后方可交付。按质量门契约：needs_revision → 任务以 failed 结束并附 findings，进入修复闭环。

## 2. 通过项（复核确认，非阻塞）

1. **成熟可靠**: 23 条策略全部具备 evidenceSources（64 条可溯源，外文文献 55 条 + 内部回测/报告 9 条且诚实标注「内部」）、limitations、失效条件；PB-02 Donchian 因样本内证伪标记 defaultStatus=disabled 且恒被排除（测试 AC-7 断言）。PB-* 家族以 evidenceLevel（A-/B/C）替代 maturity 字段，属 schema 家族化设计，validateLibrary 通过（OBS-1）。
2. **与 TOP3 自洽**: 方向/置信度只读自 analysis.json；入场触发=Q4 确认信号原文、失效=Q5 原文、结构止损=Q5 MA20 数值、事件风险=Q6 eventRisk、涨跌停=Q6 limitDistance（RM0 5%/EG0 4%/PX0 4%）；目标位=probability.json 概率锥逐值一致；Q2 趋势门用 raw ohlcv 重算（EG0「价格仍高于 MA20」→ MS-01 正确不命中）；riskOff=3 与 macro-snapshot 复算一致（US10Y/USDCNH stale 计 0）。
3. **风险提示完整**: riskAssessment 15 键齐全；尾部 3d p95 反向 ≥ 涨跌停 → 连续停板警示（EG0 −9.6%、PX0 −6.2% → watch）；divergence≥20 → vol cap ×0.5（RM0）；事件风险/最长持有 T+5/新 run 取代旧计划齐备；plan 级与板块级免责声明含「不构成投资建议」「不执行真实交易」「不含收益承诺」「报告结论是第一依据，不得反向修改」。
4. **可执行性**: watch⇒lots=0、executable⇒lots≥1；止损可成交性核验（EG0 空头止损 5188.9 < 涨停 5229.1、PX0 8062 < 涨停 8265.9、RM0 多头止损 2275.1 > 跌停 2230.6）；仓位三路公式独立重算一致（含 PX0 乘数 5）；RR≥1.5 门槛（RM0 T2=3R）；确定性双跑逐字节一致、无网络/随机/LLM、无 OI 读取。
5. **契约与渲染**: 插入点=第四章后、附录前（锚点「## 价格区间方法说明」，无锚点回退末尾追加）；四章+附录逐行不变；五强制小节/状态徽标/转执行触发/证据 ≤3 URL/禁用词表全部有测试断言；render-markdown.cjs 对 strategy-plan.json 缺失/为空/损坏均 try-catch 降级跳过（向后兼容）。

## 3. Findings

### F-1（medium）MS-01 空头命中证据串符号硬编码，报告呈现假命题
- 文件: `strategies/lib/strategy-matcher.cjs` 第 430 行（evidence 模板）；呈现于 `output/runs/20260827-1910-auto/report.md` 第五章 PX0「策略匹配」表。
- 问题: 证据模板比较符硬编码 `>`。PX0（bearish）命中 MS-01 时报告渲染「趋势对齐（close 7948>MA20(8090.4)/MA60(8085.1) 且 change5d −3.82% 同向）」——7948>8090.4 为假命题，与判定逻辑（`trendAligned` bearish: close<MA20 且 close<MA60）和数字本身自相矛盾，误导读者对趋势对齐判定的理解。多头（RM0）不受影响。
- 复现: `node strategies/build-strategy-plan.cjs --runId 20260827-1910-auto` → report.md 第五章 PX0 行。
- requiredFix: 证据串按方向取符号（bullish `>` / bearish `<`）；在 `test/strategy-matcher.test.js` 增加回归断言：bearish 且 close<MA20 的 MS-01 命中证据串不得包含 `close X>MA20` 形态；重新生成 strategy-plan.json 并复跑 npm test。

### F-2（low）阈值边界得分被 top-3 截断后静默丢弃
- 文件: `strategies/lib/strategy-matcher.cjs` 第 516-517 行。
- 问题: `matched = hits.filter(score>=1.5).slice(0,3)` 与 `supporting = hits.filter(score<1.5)` 之间，score 恰等于阈值 1.5 且排第 4 的命中（RM0 的 MS-07=2×0.75=1.5）既不入 matchedStrategies 也不入 supportingEvidence，静默丢失；t6 workedExample 曾记录 MS-07=1.5。不影响「每个 TOP3 ≥1 matched」保证与可执行性。
- requiredFix: 将 top-3 截断后 score≥阈值的落选者并入 supportingEvidence（保留证据链，标注「达到阈值但超出前 3 展示上限」），或在 t6 规则文档明确「取前 3，其余丢弃」并同步 workedExample；任选其一并加测试。

### F-3（medium）风控参数单一事实来源漂移：matcher 硬编码默认值，不消费 library.riskConfig
- 文件: `strategies/lib/strategy-matcher.cjs` 第 29-44 行（RISK_CFG_DEFAULTS）、第 639/917/1039 行（`const rc = RISK_CFG_DEFAULTS`）、第 102-106 行（validateLibrary 仅查键存在）。
- 问题: t5 声明 `strategy-library.json` 的 riskConfig 为「机器可读单一事实来源」，t6 规则要求「数值以 riskConfig 为准」；但 matcher 风控层（止损/三路手数/警示调整/应力校验）全部使用硬编码 RISK_CFG_DEFAULTS，且 validateLibrary 只校验键存在、不校验数值相等。已确认实际分歧:library riskConfig.stopK=1.5（标量）vs matcher stopK={high:2.0, medium:1.5}——未来 high 置信度品种将按 2.0×ATR 止损执行，而库声明 1.5×ATR。本期 TOP3 均为 medium，无现行输出错误，但属未强制约束的隐性漂移。
- requiredFix: 二选一并落地:（a）matcher 从 library.riskConfig 读取参数（含 confidenceScale/stopK 分层归一），RISK_CFG_DEFAULTS 仅作缺失回退;（b）build 时逐键数值比对 library.riskConfig 与 matcher 常量，漂移即 fail loud。同步统一 stopK 的库/实现取值（按 t4 K=1.5–2.0 语义明确 medium=1.5/high=2.0 或全员 1.5），并加测试锁定。

### F-4（low）PB-07 执行口径条款不分方向，多头计划展示空头专用约束
- 文件: `strategies/lib/strategy-matcher.cjs` 第 885 行（executionConvention 模板）。
- 问题: PB-07 执行口径硬编码「T+1 开盘；跳空 >0.75×ATR5 放弃；空头距涨停 <1×ATR5 禁开」，不分方向。RM0（bullish、executable）计划与报告第五章「执行口径」展示该空头专用条款，对多头入场无意义且易误导读者。
- requiredFix: 按方向选择条款（bullish 时省略空头专用约束，或替换为多头侧对等约束），并在渲染测试中断言多头计划不含「空头距涨停」字样。

## 4. 观察（登记不阻塞，随修复可顺手处理）

- OBS-1: PB-* 家族用 evidenceLevel（A-/B/C）替代 maturity，属家族化 schema 设计；evidenceSources 含 9 条内部仓库路径引用（backtest 报告/run 报告/blueprint），渲染时以非 http 的 markdown 链接呈现，建议改为相对路径纯文本或 `file:` 明确标注。
- OBS-2（承接 t10）: 既有 artifact 内部口径差异（report-model 筛选注记 volPercentile 83.93 vs probability.json 77.8；analysis Q5「MA20 约 8062」vs raw 重算 8090.4），非策略板块引入，不影响策略输出正确性。
- OBS-3: library riskConfig 中组合级覆盖组件（volTargetBook/drawdownLadder/consecutiveLossCircuit/weeklyLossCap/antiMartingale）未在 matcher 实现——单 run 静态 plan 无组合历史，属合理范围裁定（t8 按 §9 六步实现）；建议在 strategy-library.md 明确标注「未实现组件与原因」以防误读。

## 5. 审查依据与复现命令

- `npm test`（580/580 全绿）
- `node strategies/build-strategy-plan.cjs --runId 20260827-1910-auto`（exit 0；确定性双跑一致）
- 独立重算脚本（close/MA20/MA60/change5d、ATR5、概率锥、riskOff、三路手数、保证金、尾部边距）与 t10 验证报告 §3 一致

## 6. 复审（t14，review round 2，对 t13 修复）

**复审结论: verdict = pass（全部 findings 已修复并被测试锁定，无新 blocker）**

逐项复核证据：

1. **F-1 已修复**: `strategy-matcher.cjs` MS-01 证据串改用方向符号（`sign = dir==='bullish' ? '>' : '<'`，约 474-476 行）。再生成的 strategy-plan.json 中 PX0 证据串为「趋势对齐（close 7948<MA20(8090.4)/MA60(8085.1) 且 change5d -3.82% 同向）」，report.md 第五章第 312 行同步呈现正确符号。新增回归断言 t13-1（bearish 证据串不得出现 close X>MA20 形态）✅。
2. **F-2 已修复**: matchStrategies 分层改为 `thresholdHits.slice(0,3)` + overflow 并入 supportingEvidence（前缀「（超出展示上限，保留证据链）」）。RM0 supportingEvidence 现含 MS-07(1.5)，report.md 辅证行第 213 行呈现 MS-07（1.50）；t6 rules JSON 的 matching.tiers 已同步该口径；新增 t13-2 断言 ✅。
3. **F-3 已修复**: 新增 `effectiveRiskConfig(library.riskConfig)` 归一函数（约 50 行起）并贯穿 riskLayer/riskLayerStubStop/lotsBasis/meta.marginRate（688/906/1076 行），RISK_CFG_DEFAULTS 仅作缺失回退；library riskConfig.stopK 更新为分层结构 `{default:1.5, byConfidence:{high:2, medium:1.5}}`，与实现一致；volPercentileWarn/Skip、divergenceDegrade 完成分数→百分数归一。新增 t13-3 逐键锁定断言（stopK.high=2.0/medium=1.5、confidenceScale、85/95/20、riskPerTradePct、minRR、maxHoldingDays）✅。workedExample 关键值回归不变（RM0 stop 2275.1/72.9、lots 1；EG0/PX0 watch lots 0）✅。
4. **F-4 已修复**: 执行口径按方向选择——bullish →「多头距跌停 <1×ATR5 禁开（Q6 口径）」、bearish →「空头距涨停 <1×ATR5 禁开（Q6 口径）」；PB-03 亦方向化（多头回踩持仓不塌/空头反抽持仓不增）。RM0 计划与 report.md 第 222 行呈现多头对等约束；新增 t13-4 双文件断言（多头块不含「空头距涨停」，空头块反之）✅。

回归复核（round 2 全面性）：
- `npm test` 585/585 全绿（新增 t13-1~4 共 5 条：matcher 4 条 + 渲染 1 条）✅
- `node strategies/build-strategy-plan.cjs --runId 20260827-1910-auto` exit 0；确定性双跑逐字节一致；validatePlan（t7 schema）ok ✅
- report.md 已重新渲染：PX0 证据符号正确、RM0 辅证含 MS-07、执行口径方向化、四章+附录不变（strategy-section 测试全绿）✅
- 无新引入违规：无 OI 读取、无收益承诺、免责声明完整、无网络/随机/LLM（静态检查测试全绿）✅
- 审查四维度（策略库来源可靠性 / 匹配规则合理性 / 报告可执行性 / 风控完整性）在 round 1 全部覆盖且本轮复验无新问题；无残留 blocker。

遗留观察（非阻塞，随 t12 或后续版本可顺手处理）：OBS-1 内部证据路径渲染样式、OBS-3 组合级覆盖组件未实现的文档标注建议、t10 承接的两项既有 artifact 口径差异——均不影响交付质量，无需再次 repair。
