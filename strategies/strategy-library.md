# 统一策略库说明（strategy-library）

> **产出方**: strategy-architect（策略集成架构师）· **任务**: t5 · **日期**: 2026-08-27
> **机器可读版**: `futures-radar/strategies/strategy-library.json`（schema v1.0.0，单一事实来源；本文件为其可读说明）
> **上游**: t1 `macro-strategies.md`、t2 `category-strategies.md`、t3 `execution-playbooks.md`、t4 `risk-framework.md`
> **下游**: t6（匹配规则）、t7（报告板块契约）、t8（strategy-matcher）、t9（报告渲染）、t12（修复回归）

---

## 1. 库的构成

四路研究收敛为 **23 条策略 + 1 套风控 overlay + 1 套 plan 产出契约**：

| 家族 | 数量 | 前缀 | 来源 | 在 plan 中的作用 |
|------|------|------|------|------------------|
| 宏观/regime | 7 | MS-01~07 | t1 | 方向依据（direction）或背景过滤器（regime-filter）或证据标签/仓位 overlay |
| 细分品类 | 8 | CS-01~08 | t2 | 按板块/品种属性的适用性证据（evidence-tag）或方向策略（direction） |
| 执行 playbook | 8 | PB-01~08 | t3 | 入场/止损/目标模板（execution-template），可证伪参数全量化 |
| 风控 overlay | 7+结构约束 | RK-01~07 | t4 | 不参与匹配计分，无条件作用于所有 plan（hard/warning 分级） |

**策略清单速览**（`role` 决定其在匹配管线中的位置）：

- **MS**: MS-01 时间序列动量(direction) · MS-02 风险偏好 regime(regime-filter) · MS-03 carry(evidence-tag, 低权) · MS-04 波动率目标(risk-overlay, 无条件) · MS-05 增长-通胀象限(regime-filter, 低权) · MS-06 宏观事件驱动(direction) · MS-07 板块动量/广度(regime-filter)
- **CS**: CS-01 期限结构 · CS-02 季节性 · CS-03 产业利润/成本 · CS-04 跨品种价差 · CS-05 库存周期（以上均为 evidence-tag 定性证据）· CS-06 供给冲击确认跟随(direction, 权重最高 5) · CS-07 贵金属实际利率(direction) · CS-08 航运脉冲/回归(direction)
- **PB**: PB-01 趋势动量延续(A−, active) · PB-02 Donchian 海龟(B−, **disabled**：样本内证伪) · PB-03 回踩趋势延续(B) · PB-04 波动率压缩扩张(C) · PB-05 均值回归(C, 限低波动) · PB-06 区间/箱体双模式(C) · PB-07 事件后确认(B, 与 CS-06/MS-06 配对) · PB-08 概率锥区间管理(B−)
- **RK**: RK-01 单笔风险上限 · RK-02 波动率目标 · RK-03 ATR/结构止损 · RK-04 回撤阶梯 · RK-05 板块集中度 · RK-06 事件/跳空风险 · RK-07 失效退出；另有中国期货市场结构硬约束（乘数/保证金/涨跌停/夜盘/换月）

---

## 2. 数据纪律（继承并固化）

1. **只读已冻结 artifacts**：`report-model.json` / `probability.json` / `sector-snapshot.json` / `sector-driver.json` / `macro-snapshot.json` / `config/symbols.json`；字段路径统一登记在 `fieldCatalog`，t6/t8 只能引用这些路径。
2. **禁止新增数据**：不引入持仓（OI）数据源——报告 Q4/Q5 既有持仓表述仅作文本引用；库存/利润/开工率/期限结构曲线只能从驱动文本定性提取并标记 `evidenceType: qualitative`。
3. **禁止前视**：所有公式只使用信号日（T）及之前的已冻结值。
4. **不承诺收益**：库内无任何收益/胜率数字；文献证据只转述定性结论；`execution-playbooks` 的样本内回测数字仅在其原文档中以“样本内探索性结果”名义存在，库内只保留引用链接。
5. **不构成投资建议**：库与所有下游产出一律附免责声明。

---

## 3. 策略条目 schema（strategy-library.json 中每条策略的字段）

```json
{
  "id": "CS-06",
  "sourceId": "CS-06",
  "family": "macro | category | execution",
  "name": "策略名",
  "category": "策略类别",
  "role": "direction | regime-filter | evidence-tag | risk-overlay | execution-template",
  "summary": "一句话逻辑",
  "regimeFit": "适用市场状态",
  "sectors": ["agriculture", ...] | ["*"],
  "direction": "long-short | follow-report | neutral",
  "maturity": "very-high | high | medium-high | medium",
  "confidenceHint": "high | medium | low（匹配权重初始值参考）",
  "defaultStatus": "active | disabled（如 PB-02）",
  "match": { "required": [...], "forbidden": [...], "formula": "...", "weight": 3, "note": "..." },
  "conditions": ["可量化适用条件"],
  "invalidation": ["失效条件"],
  "entryExit": { "entry": "...", "exit": "...", "stop": "..." },
  "fieldRefs": ["rm.driverPrimary", ...],
  "evidenceSources": [{ "title": "...", "url": "..." }],
  "limitations": "...",
  "riskHooks": ["stopK", ...],
  "pairsWith": ["CS-06", "PB-07"]
}
```

**要点**：
- `match.required/forbidden` 使用 `matchOpVocabulary` 中的确定性操作符（eq/ne/gt/gte/lt/lte/matchesAny/matchesAll/containsNone/exists/in），字段路径取自 `fieldCatalog`；`matchesAny` 用于 Q1/Q3 文本定性匹配，命中后必须按 `evidenceType: qualitative` 降权。
- `pairsWith` 声明策略与 playbook 的天然配对（如 CS-06/MS-06 ↔ PB-07），t6 选择执行模板时优先取 pairsWith 对齐者。
- `riskHooks` 指向 `riskConfig` 的键，声明该策略触及哪些风控参数。

---

## 4. 匹配管线（供 t6/t8 消费的顶层设计）

```
TOP3 品种（report-model.opportunities[i]）
   │
   ├─ 1) 方向/适用性匹配：对 23 条 active 策略求值 match.required/forbidden/formula
   │      └─ 命中集合 + 每条权重（deterministic > qualitative；CS-06/MS-01 等权重高，evidence-tag 低权）
   │
   ├─ 2) 执行模板选择：从命中的 direction 策略的 pairsWith 中选 playbook（PB-02 禁用不可选）
   │
   ├─ 3) 风控 overlay（无条件）：§9 确定性仓位公式 + RK-01~07 + 市场结构硬约束
   │      └─ 产出 riskAssessment 与 executionStatus ∈ {executable, watch, skip} + statusReasons
   │
   └─ 4) 集中度仲裁（队长裁定）：同板块同方向冲突 → 保留置信度更高/赔率更优者 executable，
          其余 watch（statusReason=“集中度冲突”）；策略适配内容一律完整输出
```

**队长裁定固化（planSchema.guarantees）**：
1. 每个 TOP3 必须有 **≥1 个 matchedStrategy**——watch/skip 是合法执行状态，但不得省略该品种的策略适配内容；
2. 每个 plan 必须含 **riskAssessment** 与 **executionStatus**；
3. 同板块同向集中度冲突：保留一个 executable，其余 watch 并说明原因。

---

## 5. riskConfig 与仓位公式

`riskConfig`（23 个键）与 `positionSizing.steps`（6 步）数值与 `risk-framework.md` §0/§9 完全一致，t8 实现必须照此执行，包括：

- 单笔风险 ≤1%（medium ×0.75，low 不持仓）；组合风险 ≤2.5%；
- 波动率目标 10%/仓、组合 ≤20%；`scale = clamp(volTarget/max(hv,0.05), 0.2, 1.0)`，divergence≥20% 或 hv.degraded → ×0.5 且改 ATR 口径；
- 止损 K=1.5（high=2.0），与 Q5 结构位取更紧者，且 ≤0.8×涨跌停幅度；
- 手数 = min(风险预算手数, 波动率目标手数, 保证金手数)；保证金占用 ≤33%；
- 回撤阶梯 5%/8%/12% 三级降险；连续亏损/周亏熔断；反摊平；
- 盈亏比 ≥1.5，否则 status=skip。

**风控诚实性**：EG0/PX0 在 10 万权益下天然降级为观察是框架的正确输出（见 risk-framework §10 推演）；报告板块应如实显示“观察 + 转执行触发条件”，不得为凑“每个 TOP3 都可执行”而放松参数。

**实现边界（OBS-3 登记，t12）**：matcher（t8/t13）按 `positionSizing` §9 六步实现**单品种静态 plan** 风控；`riskConfig` 中以下**组合级覆盖组件未在 matcher 实现**——`volTargetBook`（组合波动率目标）、`drawdownLadder`（回撤阶梯）、`consecutiveLossCircuit`（连续亏损熔断）、`weeklyLossCap`（周亏上限）、`antiMartingale`（反摊平）、`bookRiskCap`（组合风险上限校验）。原因：单次 run 只产出当日 TOP3 静态计划，没有跨日组合历史与权益序列，组合级组件无从计算；这些参数保留在库中供未来多日组合管理消费，**不属于本版缺陷**。

---

## 6. 边界声明

1. 本库是 **研究方向增强/执行参考** 的研究素材；报告结论（方向/置信度）是第一依据，任何规则不得反向修改。
2. 所有确定性规则只读 `fieldCatalog` 列出的已冻结字段；不联网、不新增数据源。
3. 证据 URL 共 **64 条**，全部来自四路研究笔记，可逐一溯源；库内不出现未经引用的收益数字。
4. 本库与下游产出必须附免责声明：“策略为分析工具输出，不构成投资建议，不执行真实交易。”
