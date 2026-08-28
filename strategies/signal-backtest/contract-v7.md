# futures-radar signal-backtest V7 方案 —— 框架梳理 / 信息结构 / 推理效率

> 状态：**方案稿，待审阅；不执行回测、不调参数**。
> V7 的目标不是让分数更好看，而是把 v1-v6 积累出来的四类资产——证据、FinCoT、策略计划、执行闸门——整理成可演进、可审计、可复用的框架。V6.1 继续冻结，不得放行。

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

## 3. L2 判断层：分层 FinCoT + 模板化计划（推理效率核心）

### 3.1 三层推理，按变化粒度缓存
| 层 | 内容 | 更新时机 | 估计 LLM 成本 |
|---|---|---|---|
| T0 政策上下文 | 宏观/板块 regime、事件风险环境 | 变化检测触发才更新（预期每 10-20 锚点一次） | 低 |
| T1 锚点 FinCoT | 六问（方向/赔率/确认/失效/风险） | T0 变化或价格结构变化时 fresh；否则 reused | 中 |
| T2 策略计划 | 从 FinCoT + 计划模板确定性适配 | 每个锚点都生成，但多数走模板 | 极低 |

关键改进：
- reused 的 FinCoT **只继承判断语义**，Q4 的确认位由确定性“重投影”按当前 pricePacket 重算（如 m20 相对价、ATR 相对价），不再继承 5 天前的绝对价位。
- T2 计划适配改为“模板优先”：edge→triggerType 映射、riskExecution、exitManagement 都有默认模板；LLM 只处理 `diverged` 或 `override` 情况，其余用模板填充。
- 目标：60 锚点试点中 full FinCoT 调用从 51 次降到 **20-30 次**，T2 全量 LLM 调用从 60 次降到 **≤15 次**。

### 3.2 结构化 FinCoT 输出（V7 schema）
```json
{
  "schemaVersion": "fincot/2",
  "symbol": "SC0", "anchorDate": "2026-07-10",
  "direction": "bearish", "confidence": "medium",
  "regime": "shock", "edge": "breakout",
  "macroSupport": "conflict", "sectorSupport": "bearish", "eventRisk": "medium",
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
3. **L1 重构**：evidence assembler v7 输出全量 packets + 可重建 bundle + hash
4. **L2 重构**：T0/T1/T2 分层 FinCoT + 模板计划 + reused 重投影
5. **L3 固化**：execution-policy.json + 确定性执行引擎（复用 v6.1 规则，不新增）
6. **L4 评估**：evalContract + 报告模板
7. **验收（不涉及回测）**：
   - 所有层 schema 校验通过
   - bundle 可从 packets 机械重建（hash 一致）
   - 所有数字字段与文本叙事分离，无文本正则依赖
   - token/latency 预算埋点可用
8. 验收通过后，才谈试点回测。

## 8. 风险与对策

| 风险 | 对策 |
|---|---|
| 过度结构化压制 LLM 灵活性 | 叙事字段保留自由文本；只有“执行所需数字”强制结构化 |
| reused FinCoT 陈旧 | 只继承语义，Q4/Q5 一律确定性重投影 |
| 模板计划变成新参数集 | 模板是 edge→trigger 的语义映射，不是可调参数；改动需 review + changelog |
| token 预算变成形式指标 | 预算只做工程观测，不进入策略评价与放行条件 |

## 9. 一句话结论

V7 = 把“数据、判断、执行、评估”四层切开，用类型化证据包和证据 id 统一信息结构，用 T0/T1/T2 分层 FinCoT 和模板计划提升推理效率；V6.1 的安全闸门冻结为执行政策，不再调参。**框架先立住，再谈回测。**
