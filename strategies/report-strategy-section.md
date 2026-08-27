# 报告「交易策略板块」契约（report-strategy-section）

> **产出方**: strategy-architect · **任务**: t7（requirements）· **日期**: 2026-08-27
> **机器可读 schema**: `futures-radar/report/strategy-plan.schema.json`（strategy-plan.json v1.0，draft-07 子集，字段与本契约一致）
> **上游**: t5 `strategy-library.json`、t6 `strategy-matching-rules.json`、既有 `report-model.json` / `analysis.json` / 渲染管线（report/template.md、report/render-markdown.cjs）
> **下游**: t8（matcher 按 §2 产出 strategy-plan.json）、t9（按 §3 渲染）、t10（按 §6 端到端验证）、t12（回归）

---

## 1. 板块定位与边界

### 1.1 定位

- 报告新增独立章节 **「五、交易策略板块（执行参考）」**，作为**新增章节**，位置在第四章「今日不做什么」之后、附录「价格区间方法说明」之前（插入锚点见 §3.2）。
- 板块是**执行参考**：只引用已完成的 `analysis.json` / `report-model.json` / `strategy-library.json` / `strategy-plan.json`，**不改变报告的方向判断与置信度**（`reportBaseline.direction/confidence` 只读，等于报告原值）。
- 每条策略输出可执行参数：**入场 / 止损 / 目标 / 仓位 / 失效**（§2 schema + §3 渲染表格强制列）。
- 策略适配与执行许可分层（队长裁定）：`executionStatus ∈ {executable, watch, skip}`；watch/skip 是合法执行状态，**策略适配内容（matchedStrategies/supportingEvidence/playbook/失效条件）必须完整输出**，不得省略。

### 1.2 边界（不可违反）

1. **免责声明固定**（§3.7 文案）：策略为分析工具输出，不构成投资建议，不执行真实交易；无收益承诺。
2. **禁用收益/胜率承诺**：板块全文不得出现预期收益数字、胜率、保本、稳赚类表述（禁用词表见 §3.6）。
3. **OI 纪律**：只可引用报告 Q4/Q5 既有持仓表述原文；不得引入任何新持仓数据；matcher 输入已禁用 `ohlcv.openInterest`/`derived.avgOI5d`（t6 inputs.forbidden）。
4. **不新增数据源、无前视**：全部数据来自该 run 已冻结 artifacts；T+1/T+2 确认只作为触发条件描述，不作为输入。
5. **不修改原报告**：第一章~第四章与附录的既有内容/编号/渲染逻辑保持不变（§3.2 定义插入方式与字节不变断言）。

---

## 2. strategy-plan.json 数据契约（v1.0）

### 2.1 位置与生成

- 路径：`futures-radar/output/runs/<runId>/strategy-plan.json`，由 t8 `strategy-matcher` 按 t6 规则确定性生成。
- 校验：t8 自检 + t10 端到端，使用 `report/strategy-plan.schema.json` 机械校验（draft-07 子集，可用 ajv 或等价校验器）。
- 确定性：同 runId 同 artifacts 两次运行逐字节一致（`meta.generatedAt` 除外的差异视为违约——渲染与校验对比时忽略该字段）。

### 2.2 顶层结构

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `schemaVersion` | string | ✓ | 固定 `"1.0.0"` |
| `meta` | object | ✓ | runId/signalDate/matcherVersion/rulesVersion/libraryVersion/equityCny/marginRate/generatedAt/inputsSha（schema 见 §2.4） |
| `plans[]` | array(1–3) | ✓ | 每个 TOP3 品种一个 plan（§2.5）；顺序按报告 rank |
| `concentrationDecisions[]` | array | ✓ | 集中度仲裁记录（无冲突为空数组） |
| `provenance` | object | ✓ | 输入清单/生成器/数据纪律声明 |
| `disclaimer` | string | ✓ | 固定免责文案（§3.7 同源） |

### 2.3 与 t5/t6 的引用关系

- `plans[i].matchedStrategies[].strategyId/name` 来自 `strategy-library.json`（MS-*/CS-*）；BASE-01 为 t6 内置基线。
- `plans[i].riskAssessment` 字段集 = library `planSchema.plan.riskAssessment.required`（15 键）。
- `playbook.playbookId` ∈ PB-01~PB-08 且 ≠ PB-02（PB-02 恒禁用，t6 AC-7）。
- 计分/门/状态/仲裁算法一律按 `strategy-matching-rules.json` 执行，本契约不复述算法，只定数据形态。

### 2.4 meta / provenance 细节

```json
{
  "meta": {
    "runId": "20260827-1910-auto",
    "signalDate": "2026-08-27",
    "matcherVersion": "1.0.0",
    "rulesVersion": "1.0.0",
    "libraryVersion": "1.0.0",
    "equityCny": 100000,
    "marginRate": 0.08,
    "generatedAt": "2026-08-27T20:00:00.000Z",
    "inputsSha": "<artifacts 内容哈希>"
  },
  "provenance": {
    "source": "output/runs/20260827-1910-auto/{report-model,probability,sector-snapshot,sector-driver,macro-snapshot,analysis,raw}.json + config/symbols.json",
    "generator": "futures-radar/strategies/strategy-matcher.cjs",
    "discipline": [
      "无新增持仓(OI)数据依赖：Q4/Q5 既有持仓表述仅文本引用",
      "无前视：只使用信号日 T 及之前的已冻结值",
      "无收益承诺：不输出任何收益/胜率数字",
      "不修改报告方向与置信度"
    ]
  }
}
```

### 2.5 plan 条目（每个 TOP3 品种）字段表

| 字段 | 类型 | 必填 | 规则/来源 |
|------|------|------|-----------|
| `symbol` / `name` / `rank` / `sector` | string/int | ✓ | 报告原文；rank 1–3 |
| `reportBaseline` | object | ✓ | direction/confidence（报告原值，只读）、driver（Q1 文本）、confirmSignals[]（Q4 原文）、invalidationConditions[]（Q5 原文） |
| `matchedStrategies[]` | array ≥1（≤3） | ✓ | **队长裁定：每个 TOP3 ≥1 条**；score ≥1.5 取前 3；不足 1 条时以 BASE-01「报告结论跟随」补足（score=0，evidenceType=deterministic） |
| `supportingEvidence[]` | array | ✓ | 低于阈值的定性命中（evidenceType=qualitative），可空 |
| `playbook` | object | ✓ | playbookId/gateStatus(pass|pending|fail-open)/gateNote/executionConvention |
| `entry` | object | ✓ | trigger（含转执行触发=Q4 确认价位）、triggerLevel（Q4 第一个数字，无则 null）、triggerSource（Q4 原文）、**triggerTiming（触发/执行时点语义：收盘确认后下一交易日开盘执行，或 T+1 开盘执行；neutral=无执行时点）**、execution（执行口径+跳空阈值） |
| `stop` | object | ✓ | stopPrice、stopDistancePts、basis（min(stopK×ATR5, 0.8×limitPct×close, \|结构位−close\|) 计算依据） |
| `targets` | object | ✓ | t1/t2（R 口径或区间价位，**禁止收益数字**）、basis |
| `position` | object | ✓ | lots（整数 ≥0；0=watch/skip 仍输出完整适配）、lotsBasis（min 三分项明细） |
| `riskAssessment` | object | ✓ | 15 键：riskPerTradePct/confidenceScale/stopK/stopDistancePts/stopPrice/structuralStop/unitRiskCny/lots/marginPerLotCny/marginUtilizationPct/volContributionPctAnnual/tailGapPct3d/stressRiskCny/eventRiskNote/maxHoldingDays |
| `executionStatus` | enum | ✓ | executable \| watch \| skip |
| `statusReasons[]` | array ≥1 | ✓ | watch/skip 必须给出原因；集中度冲突原因固定含“集中度冲突”字样 |
| `invalidation` | object | ✓ | hard[]（Q5 逐条直译）、timeStop（T+5 无确认无失效则市价退出）、supersededByNextRun=true |
| `notes[]` | array | ✓ | 事件风险/夜盘/换月/连续停板等提示，可空 |
| `disclaimer` | string | ✓ | 品种级免责（可同板块级文案） |

### 2.6 跨字段校验规则（t8 自检 + t10 断言）

1. `matchedStrategies.length ≥ 1`（AC-1）。
2. `executionStatus=="watch"|"skip"` ⇒ `lots==0` 且 `statusReasons.length ≥ 1`；`executable` ⇒ `lots ≥ 1`。
3. 数值域：`0 ≤ confidenceScale ≤ 1`；`stopK ∈ [1,2]`；`riskPerTradePct ≤ 0.01`；`marginUtilizationPct ≤ 0.33`；`stopPrice > 0`；`maxHoldingDays ∈ [1,10]`。
4. 集中度：`concentrationDecisions` 若非空，则 `downgradedSymbols` 中各品种 `executionStatus=="watch"` 且其 `statusReasons` 含“集中度冲突”；同组恰一个 executable。
5. 方向一致性：`reportBaseline.direction` 与 `report-model.json` 对应品种 `finalDirection` 相等（不得修改）。
6. 确定性：忽略 `meta.generatedAt` 后，同输入两次输出逐字节一致。

---

## 3. 渲染规则（t9 实现契约）

### 3.1 渲染器

- 新模块 `futures-radar/report/render-strategy-section.cjs`：纯函数 `renderStrategySection(strategyPlan, strategyLibrary) → markdown 字符串`；不联网、不调 LLM、不重算数值（沿用 render-markdown.cjs 的 FORBIDDEN 纪律）。
- 数值格式沿用既有口径：普通数 2 位小数（`fmt`）、百分比 1 位小数（`fmtPct`）、金额 CNY 整数、价格 1 位小数、缺失值 `—`。

### 3.2 插入点（不改变原四章结构）

- `render-markdown.cjs` 在生成第四章内容后、写入附录标题 `## 价格区间方法说明` 之前，调用渲染器并插入返回片段。
- 硬性断言（t10）：插入前后 diff 仅包含新增章节文本；第一章~第四章与附录的既有行**逐行不变**；第四章标题仍为「四、今日不做什么」，新章节编号为「五」。
- 若 `strategy-plan.json` 不存在或 `plans` 为空：**跳过渲染该章节**，报告结构保持原样，pipeline 日志记录一行“strategy-plan 缺失/为空，策略板块跳过”。

### 3.3 章节骨架

```markdown
## 五、交易策略板块（执行参考）

> 运行 ID: {runId} | 信号日: {signalDate} | 示例权益: {equityCny} CNY | 匹配引擎: strategy-matcher v{matcherVersion}
> 本板块由策略匹配引擎按已冻结 artifacts 确定性生成，仅为方向增强与执行参考，**不改变上方报告的方向判断与置信度**。

### 策略总览

| 品种 | 报告方向 | 置信度 | 主策略 | 执行模板 | 状态 |
|------|---------|--------|--------|---------|------|
| {sym} {name} | {↑↓→} | {高/中/低} | {primary strategyId+名} | {playbookId} | {✅ 可执行 / 👀 观察 / ⛔ 跳过} |

### {sym} {name}

#### 策略匹配
（matchedStrategies 表格：策略 ID/名称/得分/命中证据；supportingEvidence 以「辅证」行列出，标注“定性证据，低权重”）

#### 执行计划
- 入场: {entry.trigger}（触发价 {triggerLevel|—}）
- 触发/执行时点: {entry.triggerTiming}
- 执行口径: {playbook.executionConvention}
- 止损: {stopPrice}（距离 {stopDistancePts} 点；依据: {stop.basis}）
- 目标: T1 {targets.t1}；T2 {targets.t2}
- 仓位: {lots} 手（{position.lotsBasis}）

#### 风险评估
（riskAssessment 表格：每手风险/保证金占用/波动率贡献/尾部边距/事件风险/最长持有）

#### 执行状态与原因
{状态徽标} {executionStatus} — {statusReasons 列表}
{watch 时强制附一行「转执行触发: {entry.trigger}」}

#### 失效与退出
- {invalidation.hard 逐条}
- {invalidation.timeStop}；新一次运行将取代本计划。

（每个 TOP3 品种按 rank 顺序重复；watch/skip 品种结构相同、不得省略任何小节）
```

### 3.4 状态徽标与理由

- `executable` → `✅ 可执行`；`watch` → `👀 观察（附转执行触发）`；`skip` → `⛔ 跳过`。
- 集中度冲突降级的品种在状态行注明：`👀 观察（集中度冲突：同板块同向仓位保留 {keptSymbol}）`。

### 3.5 证据呈现

- 每个 matchedStrategy 的命中证据为 `matchEvidence` 文本；如需附来源链接，最多取 library 中该策略 `evidenceSources` 前 3 条 URL，以脚注式 `[证据 1..3]` 列出；禁止外链超量堆砌。
- `evidenceType=qualitative` 条目一律加注「定性证据，低权重」。

### 3.6 禁用词表（板块作用域，t10 断言）

命中任一模式即验证失败：

```
年化收益|预期收益|目标收益|保证收益|收益承诺|稳赚|保本|无风险|必涨|必跌|躺赢|稳赢
建议买入|建议卖出|强烈推荐|加仓买入|重仓买入|All ?[Ii]n|满仓
```

- “建议”一词单独出现不触发（既有附录“使用建议”不受影响）；词表只作用于「五、交易策略板块」章节文本。
- 另断言：板块文本不含 `%` 收益率表述（如“预期 +12%”）；价格/百分比仅允许用于点位、波动率、保证金率等既有语义。

### 3.7 免责声明固定文案（板块级，原样输出）

> ⚠️ 免责声明：本板块策略为分析工具输出，仅为方向增强与执行参考，**不构成投资建议，不执行真实交易**。所有参数（手数/止损/目标）均为按示例权益（{equityCny} CNY）的确定性风险计算演示，**不含任何收益承诺或预期收益**；历史文献与样本内回测结论不代表未来表现。保证金与涨跌停以交易所当日公告为准。报告结论（方向/置信度）是第一依据，本板块不得反向修改。

### 3.8 篇幅预算（软约束，不截断结构）

- 总览表 1 行/品种；每品种小节 ≤ 60 行；板块总长 ≤ 260 行。超预算优先精简 notes 与证据链接，**不得删除任何必填小节**（与 report/template.md 的“结构完整性优先”一致）。

---

## 4. 与既有渲染管线的兼容性要求

1. `render-markdown.cjs` 修改面最小化：仅新增 §3.2 的插入调用与对 `render-strategy-section.cjs` 的 require；四章渲染函数零改动。
2. `report/template.md` 在「Structure Requirements」追加一行说明新章节为可选（strategy-plan 缺失时跳过），不改动模板正文四章结构。
3. 若某 run 是策略板块首次引入前的历史 run（无 strategy-plan.json），渲染保持现状（向后兼容）。
4. `current.md` 更新规则不变（策略板块不写入 current.md 摘要；如需，仅允许追加一行“策略板块: 见报告第五章”）。

---

## 5. 测试与验证契约（test/** 与 t10）

| 编号 | 断言 | 位置建议 |
|------|------|----------|
| T-1 | `strategy-plan.schema.json` 对 t8 输出的 strategy-plan.json 校验通过（字段级） | `test/strategy-plan-schema.test.js` |
| T-2 | 跨字段规则 §2.6 全部通过（≥1 matched、watch⇒lots=0、方向只读等） | 同上 |
| T-3 | 渲染片段：总览表行数=plans 数；每品种含 策略匹配/执行计划/风险评估/执行状态/失效 五小节；watch 品种含“转执行触发” | `test/strategy-section-render.test.js` |
| T-4 | 禁用词表 §3.6 与 `%` 收益率断言不命中 | 同上 |
| T-5 | 插入后四章+附录字节不变（逐行 diff 仅新增） | 端到端（t10） |
| T-6 | 免责声明固定文案存在；无收益数字 | 同上 |
| T-7 | 确定性：同输入双跑输出一致（忽略 generatedAt） | matcher 单测（t8）+ t10 |

---

## 6. 验收对照（本任务 acceptance → 契约落点）

1. **“strategy-plan.json schema 完整、字段可校验”** → §2 全字段表 + `report/strategy-plan.schema.json`（draft-07 机械校验）+ §2.6 跨字段规则 + T-1/T-2。
2. **“渲染规则不改变原报告四章结构（新增章节）”** → §3.2 插入锚点与字节不变断言 + §3.3 独立「五」章 + T-5。
3. **“所有策略给可执行参数：入场/止损/目标/仓位/失效”** → §2.5 必填字段（entry/stop/targets/position/invalidation）+ §3.3 渲染强制小节 + T-3；watch/skip 同样完整输出（队长裁定）。
4. **“免责声明与不构成投资建议边界明确”** → §1.2 边界 + §3.7 固定文案 + §3.6 禁用词表 + T-4/T-6。

---

## 7. 边界声明

- 本契约不定义匹配算法本身（属 t6），只定义数据形态、校验规则与渲染规则；两者以 `rulesVersion`/`libraryVersion` 绑定版本。
- 本契约不承诺任何收益；示例权益 10 万与手数推演仅演示确定性公式行为（与 risk-framework §10/§13 一致）。
- 保证金率默认 8% 为 Q6 区间中值，实际执行以交易所+期货公司当日公告为准。
