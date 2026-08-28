# futures-radar signal-backtest V7 方案 —— 框架梳理 / 信息结构 / 推理效率

> 状态：**方案稿 v2（已按 FinCoT 论文对齐），待审阅；不执行回测、不调参数**。
> 理论锚定：FinCoT — Grounding Chain-of-Thought in Expert Financial Reasoning（arXiv:2506.16123v5）。
> V7 的目标不是让分数更好看，而是把 v1-v6 积累出来的四类资产——证据、FinCoT、策略计划、执行闸门——整理成可演进、可审计、可复用的框架。V6.1 继续冻结，不得放行。

## 0. 理论锚定：我们的 LLM 推理根基 = FinCoT（论文对齐）

### 0.1 论文核心（arXiv:2506.16123v5）
- FinCoT = 在 Structured CoT 基础上，把**专家金融工作流（expert blueprint，Mermaid 图）嵌入 prompt**，约束 LLM 按领域专家路径推理，zero-shot、不微调。
- Prompt 结构四要素：
  1. **System**：单一顶层角色框定（如 “You are a CFA candidate…”）
  2. **Guided Step-by-Step Execution**：一轮内固定两个标签块 `<thinking>`（中间推理）与 `<output>`（最终答案），强制结构
  3. **Expert Reasoning Blueprint**：领域专属的专家工作流蓝图（Mermaid 文本），作为 Hint 嵌入 prompt
  4. **Re-Reading & Semi Self-Reflection**：在 `<output>` 内先做一致性自检再给最终答案；不设独立 `<reflection>` 块（避免过度自我评分与偏差）
- 蓝图生成管线（5 步）：范围界定与知识聚合（Deep Research + 权威来源）→ 校验与综合 → 迭代精炼为分步工作流 → 生成 Mermaid 图 → 嵌入 prompt。
- 主要结果：CFA 十领域基准上 **LLaMA3.1-8B 63.2%→80.5%（+17.3pp）、Qwen2.5-7B 69.7%→74.2%（+4.5pp）**，且生成 token 相比 Structured CoT 减少约 8 倍，推理痕迹更短更清晰。

### 0.2 可迁移与不可迁移
- **可迁移的是机制**：领域蓝图嵌入、thinking/output 结构、输出前自检、token 约束。
- **不可直接迁移的是分数**：论文是 CFA 选择题（有唯一 ground truth）；我们做的是期货方向性预测（开放、非平稳）。论文的 +17.3pp 不能作为我们的预期，只能作为“推理结构与效率”的工程目标。

### 0.3 我们的架构能否装下 FinCoT：结论
**四层框架装得下，但当前 L2 判断层不是真 FinCoT，需要三处改造：**
1. 我们现在只有“六问 + JSON 输出”，缺论文的 `<thinking>/<output>` 强制结构与输出前自检；
2. 我们没有**领域蓝图库**——六问是全局一份，不是按 regime/edge 切换的专家工作流；
3. 我们没有把蓝图作为可审计 artifact 版本化，也没有 token 预算约束。

## 0.4 FinCoT 组件 ↔ 我们的落地映射

| FinCoT 论文组件 | 我们已有 | V7 要补/改 |
|---|---|---|
| System 角色框定 | 有（agent prompt 开头） | 统一为 `fincot-system-v1`，记录 hash |
| `<thinking>` 推理块 | 无 | FinCoT prompt 强制；thinking 只允许引用证据 id |
| `<output>` 结构化答案 | 有（JSON） | 增加 `<output>` 内 self-check 字段（单位/证据/反面证据三项） |
| 专家蓝图（Mermaid） | 无 | 新建 `reasoning-blueprints/`，按 5 个交易领域蓝图嵌入 |
| 蓝图 5 步生成管线 | 部分（strategies/ 四路研究笔记 = 第 1 步原料） | 补校验/精炼/Mermaid/集成，人审通过才入库 |
| 蓝图作为 Hint | 无 | 每个 FinCoT prompt 必须带 `blueprintId` + 文本图 |
| Plan-and-Solve 脚手架 | 部分（FinCoT→策略计划两阶段） | 明确为 T1 FinCoT → T2 模板计划，禁止一步生成 |
| Semi self-reflection | 无 | `<output>` 内 3 项自检，不做独立 reflection 块 |
| Token 效率（8× 减少） | 无度量 | 增加 token 预算与实测表（见 §6） |



## 0. 要解决的三个结构性问题

1. **框架混杂**：现在 context 组装、LLM 判断、执行闸门、统计都堆在 runner 里，v4/v5/v6 各一份，规则改一处要动多处。
2. **信息结构不一致**：同一事实有 bundle 短键、context packet 长字段、FinCoT 文本三种表达，数字与叙事混在一起，证据引用无法机械校验。
3. **推理效率靠事后补救**：v5 做了紧凑 bundle 和变化复用，但复用粒度只有“整段 FinCoT”，没有分层缓存，也没有 token 预算，效率不可测量。

## 1. 框架总览：四层 + 两个横切件

```
┌─────────────────────────────────────────────────────────────┐
│ L1 证据层 Evidence Layer                                     │
│   bars/macro/sector/event → 类型化证据包（asOf + provenance） │
├─────────────────────────────────────────────────────────────┤
│ L2 判断层 Judgment Layer                                     │
│   上下文组装 → 分层 FinCoT → 策略计划（LLM 只在这里出现）      │
├─────────────────────────────────────────────────────────────┤
│ L3 执行层 Execution Layer                                    │
│   纯确定性 policy 引擎，只读计划结构化字段，不读 LLM 文本      │
├─────────────────────────────────────────────────────────────┤
│ L4 评估层 Evaluation Layer                                   │
│   三集合口径 + 闸门成本 + 校准/验证隔离 + 放行门槛             │
└─────────────────────────────────────────────────────────────┘
横切件 A：schema 注册表（所有层的 JSON Schema + 版本）
横切件 B：证据引用系统（evidence id + provenance + hash）
```

原则：
- 层间只能通过 **schema 化的 artifact** 通信，禁止跨层读文本猜数字；
- LLM 只存在于 L2；L1/L3/L4 完全确定性；
- 每个 artifact 记录 `schemaVersion`、`asOf`、`provenance`、`derivationHash`。

## 2. L1 证据层：类型化证据包（信息结构优化核心）

### 2.1 证据类型
| 包 | 内容 | asOf 规则 |
|---|---|---|
| `pricePacket` | close/ma20/ma60/atr5/chg5/volRatio + 原始 bars 引用 | asOf = 信号日或锚点日 |
| `macroPacket` | DXY/USDCNH/US10Y/DR007/SC0 的 value/change5d/status | asOf ≤ 使用日，取最后一根 |
| `sectorPacket` | 板块指数 r1/r5/r20、breadth、coherence、lead/lag | 使用日截断重算 |
| `eventPacket` | 事件日历 past/next + verified/schedule | event.date ≤ 使用日 |
| `fincotPacket` | 六问结构化输出 | 锚点日；reused 必须带 reusedFrom |
| `planPacket` | 方向/edge/trigger/止损/目标/风险/执行状态 | 锚点日，信号日可重投影 |

### 2.2 三种表达，同一来源
| 表达 | 用途 | 要求 |
|---|---|---|
| 全量 packet | 审计、测试重建、报告 | 人类可读、完整 |
| 紧凑 bundle | LLM 输入 | 短键，可从全量 packet **机械重建**，hash 一致 |
| 证据 id 引用 | FinCoT/计划溯源 | 只允许引用 id，不允许在文本里复述数值 |

证据 id 规范：
`p.<SYM>.<field>`、`m.<IND>.<field>`、`s.<SECTOR>.<field>`、`e.<type>`、`f.<SYM>.<DATE>.q<N>`。
计划里的 `contextRefs` / `finCotRefs` 必须使用上述 id。

### 2.3 数字与叙事分离
- 数字全部进字段（value/change5d/level）；
- 叙事只进 `thesis/driver/rationale/invalidationReason`；
- 禁止“文本里出现关键价位、执行层去正则提取”的路径（正式废除 v6 的 q4Numbers 文本提取）。

## 3. L2 判断层：FinCoT 蓝图 + 分层推理 + 模板化计划（推理效率核心）

### 3.0 领域蓝图库（FinCoT 论文的核心组件，V7 新建）
`reasoning-blueprints/` 下按 5 个交易领域建蓝图，每个蓝图一个 Markdown 工作流 + 一份可嵌入 prompt 的 Mermaid 文本 + 版本与 hash：

| blueprintId | 领域 | 六问工作流要点 |
|---|---|---|
| `BP-TREND` | 趋势延续 | 均线位势 → 动量确认 → 回撤/突破路径 → 失效位 |
| `BP-BREAK` | 突破 | 关键位 → 量能确认 → 回踩有效性 → 假突破证伪 |
| `BP-PULL` | 回调/均值回归 | 超买超卖 → 支撑压力 → 反转确认 → 回归失败证伪 |
| `BP-RANGE` | 区间 | 区间边界 → 边界质量 → 假突破 → 边界失效 |
| `BP-SHOCK` | 冲击/事件 | 事件→价格偏离 → 情绪极值 → 修复路径 → 二次冲击风险 |

蓝图生成沿用论文 5 步管线：
`strategies/` 四路研究笔记（原料）→ 校验综合 → 分步工作流精炼 → Mermaid 生成 → 嵌入 prompt。
每个蓝图必须经人审通过才入库；蓝图改动视为框架改动，走 review + changelog。

每个 FinCoT prompt 固定结构（论文四要素）：
```
SYSTEM  fincot-system-v1（角色 + 单位/证据/反面证据纪律）
HINT    对应 blueprintId 的 Mermaid 专家工作流
<thinking>  按蓝图步骤推理，只引用证据 id，禁止复述数值
<output>    { selfCheck: {...}, fincot: {结构化 JSON} }
```
`<output>` 内 `selfCheck` 三必填项：`unitCheck`（数值单位）、`evidenceCheck`（每条结论有证据 id）、`opposingCheck`（至少一条反面证据）。

### 3.1 三层推理，按变化粒度缓存
| 层 | 内容 | 更新时机 | 估计 LLM 成本 |
|---|---|---|---|
| T0 政策上下文 | 宏观/板块 regime、事件风险环境 | 变化检测触发才更新（预期每 10-20 锚点一次） | 低 |
| T1 锚点 FinCoT | 蓝图 + 六问（方向/赔率/确认/失效/风险） | T0 变化或价格结构变化时 fresh；否则 reused | 中 |
| T2 策略计划 | 从 FinCoT + 计划模板确定性适配 | 每个锚点都生成，但多数走模板 | 极低 |

关键改进：
- T1 必须选择 `blueprintId`：先按 regime/edge 候选选择蓝图，再跑六问；蓝图选择记入 FinCoT artifact。
- reused 的 FinCoT **只继承判断语义与 blueprintId**，Q4 的确认位由确定性“重投影”按当前 pricePacket 重算（如 m20 相对价、ATR 相对价），不再继承 5 天前的绝对价位。
- T2 计划适配改为“模板优先”：edge→triggerType 映射、riskExecution、exitManagement 都有默认模板；LLM 只处理 `diverged` 或 `override` 情况，其余用模板填充。
- 目标：60 锚点试点中 full FinCoT 调用从 51 次降到 **20-30 次**，T2 全量 LLM 调用从 60 次降到 **≤15 次**。

### 3.2 结构化 FinCoT 输出（V7 schema，对齐论文两标签结构）
```json
{
  "schemaVersion": "fincot/2",
  "symbol": "SC0", "anchorDate": "2026-07-10",
  "blueprintId": "BP-SHOCK",
  "direction": "bearish", "confidence": "medium",
  "regime": "shock", "edge": "breakout",
  "macroSupport": "conflict", "sectorSupport": "bearish", "eventRisk": "medium",
  "thinking": "按蓝图步骤的中间推理（只含证据 id，不含未引用数值）",
  "selfCheck": {"unitCheck": "pass", "evidenceCheck": "pass", "opposingCheck": "pass"},
  "q": {
    "q1_driver": {"text": "...", "evidenceRefs": ["m.DXY", "s.energy_chemical.r5"]},
    "q2_trend": {"text": "...", "structureRefs": ["p.SC0.ma20", "p.SC0.atr5"]},
    "q3_odds": {"text": "...", "opposingRefs": ["m.DXY"]},
    "q4_confirmation": {"type": "breakout|pullback|stall", "levelType": "fixed|ma20_relative|atr_relative", "level": 545, "driftRule": "ma20_relative"},
    "q5_invalidation": {"levelType": "fixed|entry_relative", "level": 545, "reason": "..."},
    "q6_risk": {"text": "...", "riskExecution": {"positionScale": 0.5, "weekendRule": "exit_if_mfe_below_1R", "maxAdverseExcursionR": 1.2}}
  },
  "reusedFrom": null, "provenance": "llm-recorded"
}
```
- `selfCheck` 三项任一非 pass → 该 FinCoT 不得进入 T2，按 grounding 规则降级。
- `thinking` 必须存在但只做审计，执行层永不读取其中数字。

### 3.3 计划 schema（V7）
```json
{
  "schemaVersion": "plan/2",
  "direction": "bearish", "executionStatus": "executable|watch|skip",
  "entry": {"triggerType": "breakout|pullback", "triggerAtrMult": 0.7, "pullbackLevel": null},
  "stop": {"stopAtrMult": 1.5, "stopCapAtr": 2.0},
  "target": {"targetR": 2.0, "targetCapAtr": 2.0},
  "exitManagement": {"timeStopDays": 3, "breakevenAfterR": 1.0, "trailingAfterR": 1.5, "invalidationExit": true},
  "riskExecution": {"positionScale": 1.0, "weekendRule": "hold"},
  "finCotRefs": ["f.SC0.2026-07-10.q4", "f.SC0.2026-07-10.q5"],
  "contextRefs": ["m.DXY", "s.energy_chemical.r5"],
  "thesis": "..." 
}
```
硬约束（继承 v6.1，不新增调参）：
- `stopCapAtr ≤ 2`、`targetCapAtr ≤ 2`、`R = targetDist/stopDist ≥ 1`
- 失效价必须落在 `(stop, entry]` 带内
- `q4_confirmation` 必须结构化，否则计划不得 executable

## 4. L3 执行层：策略与执行分离

- 把 v6.1 的五道闸门固化为 `execution-policy.json`（规则 + 每条的硬约束出处），执行引擎只读它，**不做任何参数搜索**。
- 执行引擎只消费 `planPacket` 结构化字段；遇到缺字段 → 放弃执行（abstain），绝不回退到文本正则。
- 新增“策略可执行性预检”：计划生成后立即做 schema + 硬约束校验，不通过即 `watch`，并记录 `precheckFailures`。

## 5. L4 评估层：口径与放行门槛

- 沿用 v6.1 的三集合口径（eligible / gated / executed/verified）与 `skippedCF` 闸门成本。
- 增加 `evalContract`：
  - 校准集 / 验证集 / 未来 out-of-sample 三档，`inSample` 标记；
  - 放行条件：out-of-sample 且 `gateSavedPnl > gateCostPnl` 且最小成交样本（如验证段 ≥10 笔）；
  - 任何规则修改都要求重新声明校准集，禁止静默调参。

## 6. 推理效率的度量与预算

每个锚点记录：
```
tokenBudget: { contextTokens, fincotTokens, planTokens, totalTokens }
latencyBudget: { perAnchorMs }
```
目标预算（作为工程指标，不是策略指标）：
- 紧凑 bundle 单锚点 ≤ 300 tokens
- FinCoT fresh ≤ 600 tokens、reused ≤ 80 tokens
- 计划模板命中时 ≤ 150 tokens，LLM 覆盖时 ≤ 400 tokens
- 60 锚点 × 3 品种总 token 预算 ≤ 250K（当前 v5 约 400-600K 量级，估算以实测为准）

## 7. 迁移步骤（审阅通过后才执行，不跑回测）

1. **冻结现状**：v1-v6.1 artifact 全部保留，新建 `recordings/v7/`
2. **schema 注册表**：`schemas/v7/*.json` + `evidence-id.md`
3. **领域蓝图库（FinCoT 根基，最先做）**：从 `strategies/` 四路研究笔记提炼 BP-TREND/BP-BREAK/BP-PULL/BP-RANGE/BP-SHOCK 五份工作流 + Mermaid + 版本 hash，人审入库
4. **L1 重构**：evidence assembler v7 输出全量 packets + 可重建 bundle + hash
5. **L2 重构**：FinCoT 两标签结构（`<thinking>/<output>` + selfCheck + blueprintId）+ T0/T1/T2 分层 + 模板计划 + reused 重投影
6. **L3 固化**：execution-policy.json + 确定性执行引擎（复用 v6.1 规则，不新增）
7. **L4 评估**：evalContract + 报告模板；FinCoT 消融保留 B（无 FinCoT）vs C（FinCoT）口径
8. **验收（不涉及回测）**：
   - 所有层 schema 校验通过
   - 每个 FinCoT 记录含 blueprintId / thinking / output / selfCheck
   - bundle 可从 packets 机械重建（hash 一致）
   - 所有数字字段与文本叙事分离，无文本正则依赖
   - token/latency 预算埋点可用
9. 验收通过后，才谈试点回测。

## 8. 风险与对策

| 风险 | 对策 |
|---|---|
| 论文的 CFA 准确率不能迁移到方向预测 | 只迁移机制（蓝图+结构+自检），不迁移分数预期；用 B/C 消融与 out-of-sample 自己验证 |
| 蓝图变成僵化模板，压制 LLM | 蓝图是分步工作流（先检查什么、后检查什么），不是结论预设；叙事字段保留自由文本 |
| 过度结构化压制 LLM 灵活性 | 只有“执行所需数字”强制结构化 |
| reused FinCoT 陈旧 | 只继承语义与 blueprintId，Q4/Q5 一律确定性重投影 |
| 模板计划变成新参数集 | 模板是 edge→trigger 的语义映射，不是可调参数；改动需 review + changelog |
| token 预算变成形式指标 | 预算只做工程观测，不进入策略评价与放行条件 |

## 9. 一句话结论

V7 = 以 FinCoT（arXiv:2506.16123）为 LLM 推理根基：领域蓝图嵌入 prompt、thinking/output 两标签结构、输出前自检；在其上把“数据、判断、执行、评估”四层切开，用类型化证据包和证据 id 统一信息结构，用 T0/T1/T2 分层与模板计划提升效率；V6.1 安全闸门冻结为执行政策，不再调参。**先把 FinCoT 蓝图与框架立住，再谈回测。**
