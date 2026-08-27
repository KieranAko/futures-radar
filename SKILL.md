---
name: futures-radar
description: 期货短期机会分析 + 离线模型回测——每日扫描~60个国内期货主力合约，波动率排名→Top 3深挖→4章短报告；backtest/ 支持 deterministic 与 LLM replay 回测
version: 0.1.1
---

# futures-radar

## 定位

**短期机会分析 + 离线模型回测**。日常分析产出 4 章短报告；离线回测（deterministic 批量验证 + LLM replay）用于评估模型表现。所有输出**不构成投资建议、不执行真实交易**。

## 两个入口

- **日常雷达**：`pipeline/run.cjs` 编排监测管道（采集→扫描→筛选→分析→报告）
- **离线回测**：`backtest/`（deterministic 批量回测；`runMiniPipeline` 可选 LLM replay，见 `backtest/README.md`）

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
   node collector/probe-sources.cjs
   ```
   - 自动探测 akshare / mx-data / WebSearch 可用性
   - 判定: `ok` (全部可用) / `degraded` (akshare 可用但增强源缺失) / `fatal` (akshare 不可用 → 终止)
   - 不可跳过脚本手写判断

所有命令以 skill 根目录为基准的相对路径执行（如 `node pipeline/run.cjs`）；脚本通过 `lib/workspace.cjs` 自动定位 skillRoot，cwd 不影响路径解析。

### 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `FUTURES_SKILL_ROOT` | 否 | skill 根目录；默认自动探测（向上找 SKILL.md） |
| `FUTURES_RUNTIME_ROOT` | 否 | 运行产物目录；默认 `<项目根>/data/futures-radar`（无项目根时 `<skill>/data/futures-radar`） |
| `MX_DATA_PATH` | 否 | `mx_data.py` 完整路径；默认探测 skill 兄弟目录 / `~/.agents/skills` / `~/.claude/skills` |
| `MX_APIKEY` | 否 | mx-data API key（缺失时 Top 3 增强降级为 WebSearch-only） |
| `FUTURES_TEST_RAW_JSON` | 否 | 测试用 raw.json 路径；默认使用内置夹具（真实 artifact 冻结切片） |

## 管道

**统一入口**: `pipeline/run.cjs` 编排全部自动化阶段，遇 LLM 边界自动停并提示下一步。

```bash
node pipeline/run.cjs
node pipeline/run.cjs --runId 20260730-1637-auto --from scan
```

### 阶段0: Source Probe (auto)
运行 `collector/probe-sources.cjs` → 探测 akshare + mx-data + WebSearch → 产出 `source-probe.json`
- akshare 不可用 → fatal，终止管道

### 阶段1: Collect (auto)
运行 `collector/akshare-futures.cjs` → 逐一拉取 `config/symbols.json` 白名单品种日线 OHLCV → 产出 `raw.json` + `raw-snapshot.md` + `provenance.json`
- 首次全量 ~60s，后续增量 ~5s（仅最新一根日线）
- 采集失败标 gap，不阻塞管道

### 阶段1.5: Macro (auto, Phase 3 阶段一)
运行 `collector/macro-probe.cjs` → 5 个冻结宏观锚点（DXY/USDCNH/US10Y/DR007/SC0）快照 → 产出 `macro-snapshot.json`
- 锚点取值取 `<= signalDate` 最后一根已完成日线，禁止使用盘中未完成 bar
- 单指标失败标 missing（带 reason），不伪造、不用近似源顶替
- 整阶段失败不阻断期货雷达（failurePolicy=warn）；报告阶段不联网，只读快照
- 数据源纪律：仅 akshare/sina 同源族 + 本 run raw.json（SC0 复用），不用 ttfund/Wind/iFinD
- 传导路由：`config/macro-transmission.json` 按品种前缀首个命中；未命中 → 空集（合法，不强行编造驱动）

### 阶段2: Scan (auto)
运行 `scanner/index.cjs` → ATR/HV/分位数计算 + 加权排名 → 产出 `candidates.json`（Top 10）
- 自动排除：日均成交额 < 1亿 / 日均持仓 < 1万手 / 距交割 < 15天 / 涨跌停封板中

### 阶段3a: Filter-Hard (auto)
运行 `filter/hard-filter.cjs` → 确定性硬过滤 → 产出 `filtered-hard.json`
- 应用 `filter/rules.json` 规则
- 被剔除品种标记原因，**LLM 后续不得复活**

### 阶段3b: Filter-LLM (manual)
LLM 读 `filter/blueprint.md` → 从 filtered-hard.json 中降权/保留/标记观望 → 产出 `filtered.json`（≤3 个）
- **绝对禁止复活**已被 3a 剔除的品种
- 无明确驱动 → 降为"观望/不做"

### 阶段4: Analyze (manual)
LLM 读 `analyze/blueprint.md` → 冻结 evidence packets → FinCoT 结构化结果 → 6 问框架 → 产出 `analysis.json`
- 步骤 1（自动）：`analyze/freeze-packets.mjs` 冻结 `evidence-packets.json`——注入 term_structure（akshare 近/主/远月报价，品种串行 + 退避重试规避 sina 456），并从冻结 `macro-snapshot.json` 注入 packet 顶层 `macro_context`（三态 available/not_applicable/unavailable；evidence 仅观察值，relation 不写入 packet），渲染 FinCoT prompts（仅 FinCoT 含宏观区块，SP/UST-CoT/ST-CoT 无泄漏）
- 步骤 2（LLM）：读 prompts 输出推理文档到 `analyze/outputs/{symbol}-fincot.md`（macro_context 存在时按契约输出宏观三字段 `macro_support`/`macro_conflict`/`macro_evidence_ids`）
- 步骤 3（自动）：`analyze/assemble-results.mjs` 执行 parser + grounding（evidence_ids/opposing_ids → fields；macro_evidence_ids → macro_context.evidence 独立域 fail-closed；不通过降级 pass/model_abstain）→ `reasoning-results.json`
- 步骤 4（LLM）：六问 → `analysis.json`
- **FinCoT 是 Analyze 增强组件**（推理先行，不替代六问）
- 四臂（sp/ust-cot/st-cot/fincot）仅用于离线回测研究对照；日常 Analyze 只走 fincot 臂
- 基差/库存/会员持仓仅此阶段通过 mx-data/WebSearch 获取
- 每个方向判断必须有可证伪的失效条件

### 阶段4.5: Probability (auto)
运行 `probability/stage-4-5.cjs` → 计算 HV 概率锥 + ATR 对比 → 产出 `probability.json`
- Yang-Zhang 20日历史波动率估算
- 3日/5日概率区间 (68%/95%)
- ATR vs HV 偏差分析

### 阶段5: Report (auto, 3-stage pipeline)
**5A**: 运行 `report/build-facts.cjs` → 确定性事实组装 → 产出 `report-facts.json`
- Symbol join 验证 + runId 一致性门禁
- 数值字段溯源追踪（provenance）
- 宏观段：`macro-snapshot.json` 原样透传（不重算）+ 传导路由 relevance + 展示层 display map
- 快照缺失/runId 不一致 → `macro.available=false`，不阻断报告

**5B**: 运行 `report/build-model.cjs` → 分析集成 + 论点层 → 产出 `report-model.json`
- 提取 Q1-Q6 原始字符串，保留实际字段名
- 标记判断变化（assessmentChanged）

**5C**: 运行 `report/render-markdown.cjs` → Markdown 渲染 → 产出 `report.md`
- 4 章固定结构 + 附录
- 价格区间对比表（HV 概率锥 + ATR 通道 + 偏差）
- 篇幅软预算（结构完整性优先，不强制截断）

### 阶段6: Publish (manual)
LLM 更新 `current.md` → 提取 runId + Top 3 摘要

## 数据纪律

- 扫描范围严格限定 `config/symbols.json` 白名单，运行时不可自动扩展
- akshare 为主力行情源（全市场扫描）；mx-data/WebSearch 仅用于 Top 3 增强
- 基差/库存/会员持仓不出现在全市场扫描中（只出现在 Top 3 深挖里）
- 每条数据标 source + fetchedAt（provenance 机制）
- 报告阶段不得调用数据源；所有值取自已完成的快照

### 冻结不变量（2026-08-27 冻结）

1. **日线接口只返回完整 bar**（源行为）：主 OHLCV = complete bars only。末 bar 日期 > 本地今日、或非严格 YYYY-MM-DD 真实日历日期（含带时间戳/junk）视为源行为异常（应永不触发），`collector/future-date-guard.cjs` 在数据进入缓存/raw.json 前剔除并记录诊断（symbol / rawDate / lastBarDate / fetchedAt / reason），剔除后该合约降级为 gap（reason `future_date_rejected`），不得被后续增量采集复用；todayStr 非法即抛错（fail-closed）
2. **夜盘归属下一交易日**（源盖章）：Sina 完整日线 = 前夜夜盘 + 当日日盘，按日盘所在交易日归属，open 取夜盘开盘。管道零日期推断、无交易日历依赖；夜盘结束后跑雷达无需调整日期取值区间，主链路锚定最后一根完整日线
3. **分钟接口仅限定性**：分钟数据仅用于确认方向/量级（如夜盘破位确认），禁止聚合重建日线、禁止计算正式 MA/HV/ATR、禁止进概率锥回测
4. **provisional 夜盘快照独立通道**（挂起，未实现）：独立接口 + 自然时段 + dataAsOf 标注，只消费于报告 banner 与 LLM 定性上下文；待铲屎官触发后实现

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
| 前置 | `VERSION.md` → 运行 `collector/probe-sources.cjs` |
| 0-Probe | `collector/probe-sources.cjs` → `config/sources.json` |
| 1-Collect | `collector/akshare-futures.cjs` → `config/symbols.json` |
| 1.5-Macro | `collector/macro-probe.cjs` → `collector/akshare-macro.cjs` → `collector/macro_collector.py` → `config/macro-indicators.json` + `config/macro-transmission.json` |
| 2-Scan | `scanner/index.cjs` → `config/symbols.json` |
| 3a-FilterHard | `filter/hard-filter.cjs` → `filter/rules.json` |
| 3b-FilterLLM | `filter/blueprint.md` |
| 4-Analyze | `analyze/blueprint.md` → `analyze/freeze-packets.mjs` → `analyze/assemble-results.mjs` |
| 4.5-Probability | `probability/stage-4-5.cjs` → 使用 `probability/hv-estimators.js` + `probability/probability-cone.js` |
| 5A-ReportFacts | `report/build-facts.cjs` → 读取 `candidates.json` + `filtered.json` + `probability.json` + `macro-snapshot.json`（可选） |
| 5B-ReportModel | `report/build-model.cjs` → 读取 `report-facts.json` + `analysis.json` |
| 5C-ReportRender | `report/render-markdown.cjs` → 读取 `report-model.json`，参考 `report/template.md` 结构 |
| 6-Publish | LLM 更新 `current.md` |
