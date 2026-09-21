---
name: futures-radar
description: 期货短期机会分析 + 离线模型回测——每日扫描~60个国内期货主力合约，波动率排名→Top 3深挖→4章短报告；research/backtest/ 支持 deterministic 与 LLM replay 回测
version: 2.0.0
---

# futures-radar

## 定位

**短期机会分析 + 离线模型回测**。日常分析产出 4 章短报告；离线回测（deterministic 批量验证 + LLM replay）用于评估模型表现。所有输出**不构成投资建议、不执行真实交易**。

## 两个入口

- **日常雷达**：`pipeline/run.cjs` 编排六模块管道（数据采集→文件库→故事链→机会分析→信号池→结果输出）
- **离线回测**：`research/backtest/`（deterministic 批量回测；`runMiniPipeline` 可选 LLM replay，见 `research/backtest/README.md`）
- **数据文件库**：`data/` 文件库 + `storage/index.cjs` 维护命令（每日行情/ledger/合约bars/宏观快照/板块序列，维护命令见 `data/README.md`）
- **交易策略板块**：Strategy-LLM 先按 `analysis/strategy/strategy-reasoning-prompt.cjs` 生成推理输入，产出 `strategy-reasoning.json`（理论软参照、策略表达置信度、入场/止损/目标/仓位意图）；再 `node analysis/strategy/build-strategy-plan.cjs --runId <runId>` 生成 `strategy-plan.json`；报告渲染自动附「五、交易策略板块（执行参考）」章节（缺失时跳过，四章不变）。策略为方向增强/执行参考：不构成投资建议、无收益承诺、不使用新增持仓数据（见 `legacy/strategies/README.md`）
- **看板为主**：`output/dashboard.html` 是日常阅读主界面（四 Tab：故事池置首 / 机会分析 / 信号池 / 历史报告；故事池以主题为卡片标题、卡片可折叠，逐节点展示前值/当前值/环比+单位+日期、观察窗口起止、确认日期、取数路径、可信度、事件与 linkedSignalId）；完整报告 `runs/<runId>/report.md/html` 为档案与审计，次要阅读。生产顺序固定为：assemble-v2 → strategy-reasoning → build-strategy-plan → render（保证看板生成时策略/信号池/故事池数据齐全）；反哺机制未定，link-signal-pool 暂不启用
- **信号池（Signal Pool）**：`build-strategy-plan.cjs` 自动执行信号池更新（`signals/lib/signal-pool.cjs`）——executable 策略诞生信号（入池）、同向后续 plan 追加策略版本（追踪）、反向翻转/Q5 证伪/机会衰竭/窗口到期四种原因出池；信号池台账存 `data/signal-pool/`（`ledger.json` + `signals/<signalId>.json`），报告 4.3 展示「池内信号全量明细 + 最近出池 5 个明细 + 历史统计 + 版本链」。旧证伪反馈（`strategy-feedback.json`）仍生成但仅作兼容，不再渲染。信号池看板：`render-markdown.cjs` 生成 `output/dashboard.html`（四 Tab：机会分析 / 信号池 / 故事池 / 历史报告索引），每期覆盖；同时生成 `runs/<runId>/report.html`（report.md 的浏览器可读 HTML 版，历史缺失可用 `node output/backfill-report-html.cjs` 回填）
- **信号池追踪席位**：每期初筛写完 `filtered.json` 后，运行 `node signals/seats/apply-tracking-seats.cjs --runId <runId>`，把池内品种强制加入 KEEP（`tracking=true`），与 TOP3 同规格完整再分析
- **故事传导链池（Story Chain Pool，V2.1）**：LLM 构造传导链（1 主题 + ≥3 节点 + DAG 边 + 1 源 + 1 代表品种 + 1 方向 + 证明点 2≤p<节点数；链首为四类合法源之一：`macro.*` 宏观源 / T2 event 事件源 / T2 flow 供需源 / `sector.*.oi.flow5d` 行为-资金流源，源类由引擎按首节点自动判定；板块收益/相对强度与品种价格仍禁止作链首；板块成员<3 禁板块指标；**所有节点从注册日起并行观察、独立计数**：日频连续 3 数据日同向即证明、连续 2 反向即证伪，节点三态=观察中/已证明/已证伪，无"当前节点"概念；每条链必须带 `reasoningCard` 与六问信息量对齐：claim 源/方向/路径、mechanisms 逐边机制、evidenceRefs 新闻与指标引用、assumptions/uncertainties/falsifiers）。可以从市场现象/信号质量假设出发构造（假设目标合法），但必须逐节点核对前提成立性，禁止为了证明目标而放宽节点。节点数据三态：T0 引用 `config/story-chain-indicators.json` 目录；T2 带 `concept + dataPlan`（`concept` 必须中性无方向结论词，只写被测量的量+窗口+基准；显式 `kind=event|flow` + `baseline` + `unit` + 显式 `maxFreshDays` + 中性 `searchHints`；`flow` 还必须显式 `metric` 与 `basis` level|dod|wow|mom|yoy、`minSources` 2..5，resolve 时 observation 的 metric/basis 与 dataPlan 不一致即拒收、至少两个独立域名来源且方向一致，`sourceTier` 缺失即拒收）走 WebSearch 检索；T1 采集器暂缺。检索是中性采集：brief 不把 concept 当检索词，只拼 searchHints+metric+basis，禁止把结论写进检索词；源必须独立于品种方向成立（删掉品种信号后源仍成立才允许作链首）。**取数路径 ≠ 数据可信度**：可信度 high/medium/low/unknown 由脚本按来源层级×新鲜度×独立源推导，只标注不改变证明/证伪判决。指标目录声明 `sourceClass`/`allowAsRoot`（四类链首权限）、`valueScale`（level/rate/sign）与 `changeKind`（absolute/percentage_points/relative/none），节点变化量由引擎按尺度计算，渲染器只渲染、不现场做减法。状态机：resolving（T2 未解析）→pending→proven（已证明上游数≥proofIndex）→completed|falsified|expired|void；`provisional` 链仅观察、不参与证明/席位；同源仅 1 条活跃链（`supersede` 换代）。台账存 `data/story-pool/`。CLI：`prompt --runId <id>`（状态唤醒提示词，读 `stories/blueprint.md`）、`register --file ... --batch`、`resolve --chainId <id> --brief/--file/--void`、`provisional --chainId <id>`、`audit [--chainId <id>]`（存量链×当前契约合规审计）、`observe --runId <id>` / `--date <YYYY-MM-DD>`、`list`、`view`。**数据唯一事实源=文件库**：节点指标只从 `data/daily` + `data/macro-history`（`npm run macro:history` 构建/刷新）计算，不读 output/runs。**生产桥（单向顺序）**：`story-news` 新闻快照 → 故事链构造（结构+推理卡）→ `observe` → `node stories/seats/build-filtered-from-story-pool.cjs --runId <id>` 由故事池重写 KEEP（tracking=true/storyChainId）；storyChainId 随 filtered → analysis → report-model → strategy-plan → signal 逐层前向盖章（血缘只读可查）。六问第一遍独立推理 → 审计 LLM 找冲突 → 六问第二遍修订增量 → assemble 合并并 `auditImpact` 留痕。`apply-story-seats.cjs` 为 legacy 脚本不再使用；`link-signal-pool.cjs` 代码保留但暂不启用（信号验证反哺故事链机制未定）。示例：`research/experiments/macro-flow-v1/example-chain.json`
- **信号质量回测**：固定 RB0/M0/SC0、2 年历史（500 交易日）+ 每 5 交易日 LLM 锚点，确定性规则延续生成信号，T+1 收盘确认/T+2 开盘执行/止损/目标/时间退出验证。v1/v2 基线（`runner.cjs` → `signal-quality-baseline.md/json`、`signal-quality-baseline-2y.md/json`）冻结保留；v3（`runner-v3.cjs` → `signal-quality-baseline-v3.md/json`）不做参数选优，改为证伪 LLM 定性判断（regime/edge/triggerType/qualityFlags/thesis），并与纯量化 MA20 对照臂比较；v4（`runner-v4.cjs` → `signal-quality-baseline-v4.md/json`）为最近 10 锚点×3 品种试点：宏观/板块/事件日历上下文 + 完整六问 FinCoT → 报告式操作策略 → 严格执行；v5（`runner-v5.cjs` → `signal-quality-baseline-v5.md/json`）为 20 锚点×3 品种高效版：紧凑 bundle + 变化检测按需重跑 FinCoT + C 臂强制消费 FinCoT；v6（`runner-v6.cjs` → `signal-quality-baseline-v6.md/json`）为五道安全闸初版；v6.1（`runner-v6-1.cjs` → `signal-quality-baseline-v6-1.md/json`）为硬约束修正版；v7（`runner-v7.cjs` → `signal-quality-baseline-v7.md/json`）以 FinCoT 论文（arXiv:2506.16123）为推理根基：5 个领域蓝图 + thinking/output/selfCheck + 安全执行，10 锚点试点；v7 适配器（`adapters/strategy-plan-adapter.cjs`）把 FinCoT 分析包装成生产 run 形状，原样调用 `strategy-matcher` 产出 30 份 `strategy-plan.json`；v8 执行引擎（`runner-v8.cjs`）只读 strategy-plan 字段执行；v8.1 增加定价层（`pricing-layer-v8.cjs`：F1 触发价 2×ATR 带、F2 q4 类型一致、F3 range/transition 禁 breakout、F5 breakout 必须有结构目标、F4 目标距离审计）+ `runner-v8-1.cjs` 只执行定价层放行计划——FinCoT 只做分析，策略库适配策略，执行层按策略执行

## 触发条件

- **跑雷达**: "跑期货雷达" / "/futures-radar" / "出期货报告" → 启动监测管道
- **源探测**: "跑探测" / "probe sources" / "探测数据源" → 仅运行源探测
- **不包括**: "看下螺纹钢" "今天期货怎么样" 等模糊表述 → 仅口头回答

## 前置

启动前必须:
1. 版本校验：当前加载的 SKILL.md version 必须等于 VERSION.md version
2. 环境自检：Node.js ≥ 21；Python 3 + akshare（`pip install -r requirements.txt`）；mx-data 可选（Top 3 增强，需 `MX_APIKEY`）
3. 运行前置探针脚本：
   ```bash
   node collection/probe-sources.cjs
   ```
   - 自动探测 akshare / mx-data / WebSearch 可用性
   - 判定: `ok` (全部可用) / `degraded` (akshare 可用但增强源缺失) / `fatal` (akshare 不可用 → 终止)
   - 不可跳过脚本手写判断

所有命令以 skill 根目录为基准的相对路径执行（如 `node pipeline/run.cjs`）；脚本通过 `lib/workspace.cjs` 自动定位 skillRoot，cwd 不影响路径解析。

### 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `FUTURES_SKILL_ROOT` | 否 | skill 根目录；默认自动探测（向上找 SKILL.md） |
| `FUTURES_RUNTIME_ROOT` | 否 | 运行产物目录；默认 `<skill>/output`（runs 落在 `<skill>/output/runs/<runId>/`，已 gitignore） |
| `MX_DATA_PATH` | 否 | `mx_data.py` 完整路径；默认探测 skill 兄弟目录 / `~/.agents/skills` / `~/.claude/skills` |
| `MX_APIKEY` | 否 | mx-data API key（缺失时 Top 3 增强降级为 WebSearch-only） |
| `FUTURES_TEST_RAW_JSON` | 否 | 测试用 raw.json 路径；默认使用内置夹具（真实 artifact 冻结切片） |
| `FUTURES_FAST_CLOSE` | 否 | 收盘快照快速通道开关；`0` 关闭（默认开；`0` 同时禁用快照优先增量） |
| `FUTURES_VERBOSE` | 否 | `1` 时打印快照优先增量不启用原因等诊断日志（默认关） |

## 管道

**统一入口**: `pipeline/run.cjs` 编排全部自动化阶段，遇 LLM 边界自动停并提示下一步。

```bash
node pipeline/run.cjs
node pipeline/run.cjs --runId 20260918-1941-auto --from data-collection
node pipeline/run.cjs --runId 20260918-1941-auto --from story-observe
node pipeline/run.cjs --runId 20260918-1941-auto --from opportunity-analysis
node pipeline/run.cjs --runId 20260918-1941-auto --from analysis-assemble
node pipeline/run.cjs --runId 20260918-1941-auto --from strategy-plan
node pipeline/run.cjs --runId 20260918-1941-auto --from render-markdown
```

### 阶段0: Source Probe (auto)
运行 `collection/probe-sources.cjs` → 探测 akshare + mx-data + WebSearch → 产出 `source-probe.json`
- akshare 不可用 → fatal，终止管道

### 阶段1: Collect (auto)
运行 `collection/akshare-futures.cjs` → 逐一拉取 `config/symbols.json` 白名单品种日线 OHLCV → 产出 `raw.json` + `raw-snapshot.md` + `provenance.json`
- 首次全量 ~60s，后续增量 ~5s（仅最新一根日线）
- 采集失败标 gap，不阻塞管道
- **收盘快照快速通道（v0.1.2）**：日线接口收盘后经常延迟数小时发布当日 bar；采集时若日线序列缺少本地今日，自动用 sina 收盘快照（`hq.sinajs.cn nf_` 主力连续，date==本地今日 && time>=15:00 完整会话）兜底补入当日 bar（append-only，来源盖章 `lastBarSource=sina_close_snapshot`，provenance/raw-snapshot.md 透传）。实测 2026-08-27 快照与监控中心官方日线（CFMMC）逐字段一致。`FUTURES_FAST_CLOSE=0` 可关闭
- **CFMMC 交叉验证层（P0，v0.1.2）**：快照补入的当日 bar 与 CFMMC 官方日线逐品种比对（`collection/cfmmc-verify.cjs` + `collection/cfmmc_daily.py`）——主导合约=当日成交量最大行，价格字段阈值 0.1%、量/仓阈值 5%；三态 verified/diverged/unverified 写入 provenance（perSymbol.lastBarVerification）与 raw.json meta.cfmmcVerify；结算价不一致仅标 `settleProvisional=true`（只标注不修订）；DCE 接口失败 → unverified 延后比对（warn-only 不阻塞）；`FUTURES_CFMMC_VERIFY=0` 可关闭
- **增量缓存（P1，v0.1.2）**：复用最近 run 的 raw.json（`collection/incremental-cache.cjs`）——1 次探测 sina 最新 bar 日期，缓存末 bar 同日则直接复用（深拷贝 + `cacheReused`/`cacheOriginRunId` 盖章），只拉缺失/落后品种；缓存超 5 天或序列非法 → 全量校准；`FUTURES_FULL_PULL=1` 强制全量。实测：全量 16.5s，全复用采集 0.0s。批量并发维持 4 进程 × 5 品种（P1 实测 4×15=60 并发触发 sina 456，不采用）
- **快照优先增量（v0.1.3）**：日常场景（日线接口已发布今日 bar，缓存恰好落后一根=上一交易日）不再全量重拉 ~59 品种，改用收盘快照一次性补当日 bar（1 次 HTTP 调用，date==今日 && time>=15:00 校验 + CFMMC 交叉验证照常）。契约见不变量 #8；覆盖率 <90% 或任一品种落后超过一根 → 自动回退日线重拉（fail-open）。实测 2026-08-27：59/59 品种补入，raw.json 全序列与官方日线逐字段一致，Top10 扫描排名/分数不变；采集阶段 ~13s 全量 → ~1s 快照（另加 CFMMC 验证 ~3s，DCE 接口故障日受既定退避策略影响约 +7s）

### 阶段1.4: Sector (auto, v0.1.5)
运行 `collection/sector-aggregator.cjs` → 从本 run `raw.json` 确定性构建板块快照 → 产出 `sector-snapshot.json` 并镜像入文件库
- 板块指数 = 成员等权日收益链式累乘（基点 1000）；不使用持仓数据
- 指标：ret1d/5d/20d、上涨广度、方向 coherence、量比、领涨/领跌代表
- 失败不阻断管道（failurePolicy=warn）；Analyze 阶段缺失时可用 raw.json 现场重算

### 阶段1.5: Macro (auto, Phase 3 阶段一)
运行 `collection/macro-probe.cjs` → 5 个冻结宏观锚点（DXY/USDCNH/US10Y/DR007/SC0）快照 → 产出 `macro-snapshot.json`
- 锚点取值取 `<= signalDate` 最后一根已完成日线，禁止使用盘中未完成 bar
- 单指标失败标 missing（带 reason），不伪造、不用近似源顶替
- **P2 容错（v0.1.2）**：sina_fx 主通道指数退避重试 2 次（`collection/backoff.cjs`）；USDCNH 主通道失败 → sina 实时快照兜底（`fx_susdcnh`，同族真实数据，仅当日观测值可用，change5d 标 —）；DXY 无实时码 → 保持 missing（不近似顶替）。实测 2026-08-27：sina 外汇 456 时 USDCNH 6.7196 兜底成功、DXY missing
- 整阶段失败不阻断期货雷达（failurePolicy=warn）；报告阶段不联网，只读快照
- 数据源纪律：仅 akshare/sina 同源族 + 本 run raw.json（SC0 复用），不用 ttfund/Wind/iFinD
- 传导路由：`config/macro-transmission.json` 按品种前缀首个命中；未命中 → 空集（合法，不强行编造驱动）
- **管道并行（v0.1.3）**：`pipeline/run.cjs` 中 Macro 与 Scan 阶段只依赖 collect 产物、互不依赖，并发执行（宏观采集耗时移出关键路径；宏观看门 warn 不阻塞 scan）

### Phase 5: 文件库 (auto)
- `storage/index.cjs --verify` 文件库完整性校验（warn-only）
- `storage/macro-history-builder.cjs --build` 从冻结 v4 宏观历史 + `data/macro/<RUN_ID>.json` 重建 `data/macro-history/*`
- 数据唯一事实源 = `data/`；节点指标只从 `data/daily` + `data/macro-history` 计算

### Phase 1: 故事链（V2，替代 filter-llm）
**filter-llm 已退役；故事池 active 链是 KEEP 名单的唯一来源。**
1. agent 现搜现写新闻快照 `output/runs/<runId>/news-snapshot.json`（少而精：宏观3-5+每板块1-3，总量≤20，多来源优先），`node stories/cli/news-snapshot-cli.cjs install --runId <runId>` 装入 `data/news/`；
2. `node stories/cli/story-chain-cli.cjs prompt --runId <runId>` 生成状态唤醒提示词（注入新闻快照 + 宏观/板块冻结数据）；
3. LLM 按 `stories/blueprint.md` 为各板块构造传导链（结构 JSON + reasoningCard 推理卡），写 `story-chains.json` 后 `register --file ... --batch` 入池；
4. `node stories/cli/story-chain-cli.cjs observe --runId <runId>` 逐日打卡推进链状态（连续 3 数据日同向证明/连续 2 反向证伪）；
5. `node stories/seats/build-filtered-from-story-pool.cjs --runId <runId>` **重写** `filtered.json`：active 故事席位（tracking=true/storyChainId）+ 有故事血缘的信号池追踪席位（孤儿/legacy 信号不入深挖）；无链且无追踪信号 → 空仓合法。candidates.json 缺失时由故事席位创建（不再来自波动率扫描）。
旧 `legacy/filter/filter/blueprint.md` 与 quantitative-filter 归档保留，不再执行。

### Phase 2: 机会分析（analysis v2，六问两遍 + 审计）
- 步骤 1-3（自动）：`analysis/v2/packet-freeze-v2.cjs` → `prefill-v2.cjs` → `prompt-builder-v2.cjs`（第一遍提示词，注入新闻快照，明确不展示传导链），产出 `analyze/packets-v2.json` / `prefill-v2.json` / `prompts-v2.md`；
- 步骤 4（LLM 第一遍）：六问独立推理写 `analyze/outputs-v2.json`；
- 步骤 5-6（审计）：`analysis/v2/audit-prompt-builder.cjs` 生成对质提示词，审计 LLM 写 `analyze/audit-findings.json`（只找冲突、给六问追问、不判输赢）；
- 步骤 7-8（六问第二遍）：`analysis/v2/reconciliation-prompt-builder.cjs` 生成修订提示词，六问 LLM 对 conflict 品种写 `analyze/outputs-v2-reconciliation.json`（修订增量 + auditImpact）；
- 步骤 9：`analysis/v2/assemble-v2.cjs --as-production` 合并两遍结果并 auditImpact 留痕；
- 步骤 10（自动）：`analysis/probability/stage-4-5.cjs` → `probability.json`（HV 概率锥 + ATR 对比）
- 步骤 11（自动）：`analysis/assembly/build-facts.cjs` → `report-facts.json`（Symbol join + 宏观透传 + 数据时效）
- 步骤 12（自动）：`analysis/assembly/build-model.cjs` → `report-model.json`（Q1-Q6 原文提取 + 方向/置信度 canonical 校验）
- 步骤 13（自动）：`analysis/strategy/strategy-reasoning-prompt.cjs` → `strategies/prompts/strategy-reasoning.md`
- 步骤 14（LLM）：按 `strategy-reasoning.md` 做交易表达决策，写 `strategy-reasoning.json`
- FinCoT 是 Analyze 增强组件（推理先行，不替代六问；四臂仅回测研究对照，日常只走 fincot 臂）

### Phase 3: 信号池 (auto)
`analysis/strategy/build-strategy-plan.cjs --runId <runId>` 生成 `strategy-plan.json` 并自动更新信号池：
- executable 策略诞生信号（入池）；同向后续 plan 追加策略版本（追踪）
- 反向翻转 / Q5 证伪 / 机会衰竭 / 窗口到期 → 出池
- 同时写 `signal-pool.json` 与 `strategy-feedback.json`

### Phase 6: 结果输出 (auto)
`output/render-markdown.cjs --runId <runId>` → `report.md` + `report.html` + `output/dashboard.html`（四 Tab：故事池 / 机会分析 / 信号池 / 历史报告）
- LLM 可选更新 `current.md`（warn-only）

## 数据文件库（v0.1.5）

- 采集层写完 `raw.json` 后自动镜像到 `data/daily/<SYMBOL>.json` + `data/ledger/`；raw.json 仍是每个 run 的冻结权威
- 板块聚合阶段写入 `data/sector/<SECTOR>.json` + `data/sector/snapshots/<RUN_ID>.json`
- 增量采集优先从文件库读取；`research/backtest/` 的切片/采样也从文件库读取（旧 `historical-cache.json` 仅作回退）
- 维护命令：`npm run store:init|seed|verify|stats|export|compact`（规则见 `data/README.md`；实现位于 `storage/index.cjs`）
- `npm run macro:history` 重建 `data/macro-history/*`（故事链指标的历史模式数据源）
- `npm run filter:quant` / `npm run prefill` 已随 filter-llm 退役，对应脚本归档于 `legacy/`，不再参与 V2 管道

## 数据纪律

- 扫描范围严格限定 `config/symbols.json` 白名单，运行时不可自动扩展
- akshare 为主力行情源（全市场扫描）；mx-data/WebSearch 仅用于 Top 3 增强
- 基差/库存/会员持仓不出现在全市场扫描中（只出现在 Top 3 深挖里）
- 每条数据标 source + fetchedAt（provenance 机制）
- 报告阶段不得调用数据源；所有值取自已完成的快照
- **三级来源链（P2）**：sina 日线（主序列）→ CFMMC 官方日线（只验证/回填口径，不进主序列，避免连续口径漂移）→ 收盘快照（兜底当日 bar）；单级失败不阻塞，逐级标原因（gap/diverged/unverified/missing）

### 冻结不变量（2026-08-27 冻结）

1. **日线接口只返回完整 bar**（源行为）：主 OHLCV = complete bars only。末 bar 日期 > 本地今日、或非严格 YYYY-MM-DD 真实日历日期（含带时间戳/junk）视为源行为异常（应永不触发），`collection/future-date-guard.cjs` 在数据进入缓存/raw.json 前剔除并记录诊断（symbol / rawDate / lastBarDate / fetchedAt / reason），剔除后该合约降级为 gap（reason `future_date_rejected`），不得被后续增量采集复用；todayStr 非法即抛错（fail-closed）
2. **夜盘归属下一交易日**（源盖章）：Sina 完整日线 = 前夜夜盘 + 当日日盘，按日盘所在交易日归属，open 取夜盘开盘。管道零日期推断、无交易日历依赖；夜盘结束后跑雷达无需调整日期取值区间，主链路锚定最后一根完整日线
3. **分钟接口仅限定性**：分钟数据仅用于确认方向/量级（如夜盘破位确认），禁止聚合重建日线、禁止计算正式 MA/HV/ATR、禁止进概率锥回测
4. **provisional 夜盘快照独立通道**（挂起，未实现）：独立接口 + 自然时段 + dataAsOf 标注，只消费于报告 banner 与 LLM 定性上下文；待铲屎官触发后实现
5. **收盘快照快速通道**（v0.1.2，铲屎官 2026-08-27 触发）：sina 日线接口滞后时兜底补当日 bar。契约：仅当日线序列缺少本地今日时启用；快照 date 必须===本地今日且 time>=15:00:00（盘中/午休一律拒绝）；append-only 不覆盖历史；bar 盖章 `lastBarSource=sina_close_snapshot`+`lastBarAsOf`；快照失败 warn 不阻塞（日线仍为权威主序列）。对照组：2026-08-27 RB2701/CU2610 快照与 CFMMC 官方日线 open/high/low/close/settle/pre_settle/volume/OI 一致
6. **CFMMC 交叉验证契约**（P0，v0.1.2）：仅验证快照补入的当日 bar（日线接口 bar 标 not_applicable 不比对）；品种映射=主力连续去尾 0 → CFMMC 当日行按 volume 最大选主导合约；阈值：价格（open/high/low/close/settle）相对差 ≤0.1%、volume/open_interest 相对差 ≤5%；三态 verified/diverged（记录 diffs 字段级）/unverified（市场失败或该品种无当日行，延后比对）；结算价不一致仅标 settleProvisional=true（只标注不修订，官方结算发布后以 CFMMC 为准）；验证层失败 warn-only，不阻塞采集（快照 date/time 校验仍是底线）
7. **容错契约**（P2，v0.1.2）：统一指数退避（`collection/backoff.cjs`：批次重试波次冷却 4s、快照分块重试 1 次 3s、宏观锚点重试 2 次 5s 基座）；探针结果 30 分钟窗口内跨阶段复用（`--reuse-if-fresh`，fatal 除外，`FUTURES_FORCE_PROBE=1` 强制）；宏观外汇备用通道仅用于 USDCNH 且须当日观测值（change5d 不可用标 —），DXY 无备用源 → missing 不伪造
8. **快照优先增量契约**（v0.1.3）：仅当日线接口已发布今日 bar（探测 latest===本地今日）且缓存恰好落后一根（全部品种缓存末 bar===探测 prev）时启用；快照补入沿用不变量 #5 的 date/time/OHLC 校验与来源盖章；覆盖率 <90%（或快照 fetch 异常）→ 回退日线重拉（fail-open，官方日线仍为权威主序列）；CFMMC 交叉验证（不变量 #6）照常执行；`FUTURES_FAST_CLOSE=0` 同时禁用本通道。对照组（2026-08-27）：快照优先 raw.json 与官方日线全序列 59/59 逐字段一致，Top10 扫描排名/分数不变

**对照证据（2026-08-26 SA2701）**：8-26 日线 open=1045 = 8-25 夜盘开盘（日盘首分钟 open 1042）；close/low/末持仓与夜盘收盘吻合；分钟聚合 high 差 1 tick、volume 差 ~6.4%（佐证不变量 #1/#2，禁止重建日线）

## Iron Boundaries

| 维度 | 允许 | 禁止 |
|------|------|------|
| 品种范围 | 白名单驱动，仅扫描 symbols.json | 外盘/冷门/临近交割/成交断层；禁止运行时动态发现 |
| 数据源 | akshare 主力行情源 + mx-data/WebSearch 仅 Top 3 增强 | Wind/iFinD/ttfund |
| 频率 | 日频（收盘后跑一次） | 盘中实时/分钟线 |
| 候选上限 | Top 10 → 过滤后 ≤ 3 深挖 | 超 3 个丢入"今日不做什么" |
| 报告 | 4 章固定结构，篇幅软预算 | 9 章全品类研究报告 |

## 文件索引

| 阶段 | 读哪些 |
|------|--------|
| 前置 | `VERSION.md` → 运行 `collection/probe-sources.cjs` |
| 0-Probe | `collection/probe-sources.cjs` → `config/sources.json` |
| 1-Collect | `collection/akshare-futures.cjs` + `collection/close-snapshot.cjs`（收盘快照通道/快照优先增量）+ `collection/incremental-cache.cjs`（增量缓存）→ `config/symbols.json` |
| 1.5-Macro | `collection/macro-probe.cjs` → `collection/akshare-macro.cjs` → `collection/macro_collector.py` → `config/macro-indicators.json` + `config/macro-transmission.json` |
| 2-Scan | `legacy/scanner/scanner/index.cjs` → `config/symbols.json` |
| 3a-FilterHard | `legacy/filter/filter/hard-filter.cjs` → `legacy/filter/filter/rules.json` |
| 3b-FilterLLM | `legacy/filter/filter/blueprint.md` |
| 4-Analyze | `analysis/blueprint.md` → `analysis/v2/*` → `analysis/assembly/*` → `analysis/strategy/*` |
| 4.5-Probability | `analysis/probability/stage-4-5.cjs` → 使用 `analysis/probability/hv-estimators.js` + `analysis/probability/probability-cone.js` |
| 5A-ReportFacts | `analysis/assembly/build-facts.cjs` → 读取 `candidates.json` + `filtered.json` + `probability.json` + `macro-snapshot.json`（可选） |
| 5B-ReportModel | `analysis/assembly/build-model.cjs` → 读取 `report-facts.json` + `analysis.json` |
| 5C-ReportRender | `output/render-markdown.cjs` → 读取 `report-model.json`，参考 `output/template.md` 结构 |
| 6-Publish | LLM 更新 `current.md` |
