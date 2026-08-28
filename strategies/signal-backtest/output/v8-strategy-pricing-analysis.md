# V8.1 交易策略全盘定价分析 —— “定价脱离实际”的量化归因

> 对象：V7 试点 47 个信号 + 30 个计划 + 蓝图模板 + v6.1 执行引擎。
> 本文只做分析与修复设计，不修改代码、不重跑回测。

## 0. 定价链路（谁在定价）

```
T1 FinCoT q4/q5 结构位（LLM 判断）
      ↓
T2 蓝图模板（确定性）→ triggerAtrMult / stopAtrMult / targetR
      ↓
L3 执行引擎 → triggerLevel = close ± k×ATR；stop = trigger ∓ s×ATR；target = trigger ± R×|trigger-stop|，再被目标帽压到 2×ATR
      ↓
gap/invalidation 校验
```

## 1. 发现 P1：全信号一套定价，与蓝图/regime/风险完全脱钩

对 V7 全部 47 个信号的实测：

| 字段 | 实际值 | 说明 |
|---|---|---|
| trigger 距 close | **恒定 0.50 ATR** | 全部 47 个信号一模一样 |
| stop 距 close | **恒定 1.00 ATR** | 全部 47 个信号一模一样 |
| target 距 close | **恒定 2.50 ATR** | 全部 47 个信号一模一样 |

无论蓝图是 BP-TREND / BP-BREAK / BP-SHOCK，无论 regime 是 trend / range / shock，无论 eventRisk 是 low / medium，价格宽度完全相同。**只有 q4 结构位在变，而触发/止损/目标与它无关（breakout 时）。**

## 2. 发现 P2：target 定价系统性超出现实移动能力

用信号日 ATR 度量，未来 5 个交易日的实际最大有利移动（favAtr）：

| 信号状态 | 数量 | 实际 5 日 favAtr 均值 | target 距 close | target 可达笔数 |
|---|---|---|---|---|
| gate_skipped | 28 | 1.52 | 2.50 | 5/28 |
| trigger_miss | 15 | 1.65 | 2.50 | 3/15 |
| verified | 3 | 2.78 | 2.50 | 1/3 |
| gap_skip | 1 | 3.64 | 2.50 | 1/1 |
| 合计 | 47 | 约 1.6 | 2.50 | **10/47（21%）** |

- 未来 5 日实际能走到的有利距离中位数只有约 **1.6 ATR**，而所有目标都定在 **2.5 ATR**（从 close 算）。
- 未来 5 日实际不利移动触及止损的概率：**18/47（38%）**，而止损定在 1.0 ATR（从 close 算）。
- 结论：**目标价几乎系统性不可达；止损价处在 5 日噪声带内**。这不是某个品种的问题，是定价基准错了。

## 3. 发现 P3：R 标注与 R 实际不一致

- 计划声明 `targetR=2.0`。
- 引擎实际：`stopDist = 1.5×ATR`（trigger 到 stop），目标帽把 `targetDist` 压到 `2.0×ATR`。
- **实际 R = 2.0 / 1.5 = 1.33**，不是 2.0。
- 也就是说报告里的“2R 目标”在执行后是 1.33R——定价声明与执行不一致。

## 4. 发现 P4：q4 结构位与触发价是两套坐标（承接 V8 归因）

信号日 q4 确认位距 close 的分布（ATR）：

| 距离桶 | 信号数 |
|---|---|
| <1 ATR | 17 |
| 1-2 ATR | 7 |
| 2-3 ATR | 17 |
| 3-4 ATR | 4 |
| >5 ATR | 2 |

- 分布呈双峰：17 个 q4 离 close 很近（这些基本能过 G2，多变成 trigger_miss/verified），24 个 q4 在 1-5 ATR 外（基本被 G2 拦）。
- 根因同 V8：`q4Confirmation.level`（结构位）与 `triggerLevel`（执行位）不是一套坐标，G2 在错误语义上比较。

## 5. 发现 P5：蓝图模板的 stopAtrMult 没有消费 FinCoT 的风险判断

- FinCoT q6 输出了 `riskExecution.maxAdverseExcursionR`（0.5-1.5），这是 LLM 对“能承受多大反向波动”的判断。
- T2 模板却无视它，统一用 `stopAtrMult=1.5`。
- 结果：shock 蓝图里 FinCoT 说“半仓、不隔周末、MAE 容忍 1.0R”，但执行层止损宽度仍是标准 1.5 ATR——**风险判断与定价再次脱节**。

## 6. 全盘修复设计（V8 定价改造，只改机制，不调参数）

### F1 定价基准统一为“结构位 + ATR 缓冲”
```
breakout：triggerLevel = q4Confirmation.level（结构位）
pullback：triggerLevel = pullbackLevel（q4 结构位）
stopPrice   = triggerLevel ∓ stopWidth，stopWidth = max(0.5×ATR, |triggerLevel - invalidationLevel| × 0.5)
            且 stopPrice 必须位于 (invalidationLevel 与 triggerLevel) 之间
targetPrice = 同侧结构目标（q4/q5 或区间对边），距离上限 2×ATR
```
- 目标价优先用**结构目标**（前高/前低/区间对边），只在没有结构目标时才用 R 基准。
- 每笔计划必须声明 `pricingBasis`：`structure|range_edge|atr_relative`。

### F2 止损宽度消费 FinCoT 风险判断
```
stopAtrMult = q6.riskExecution.maxAdverseExcursionR（0.5-1.5，封顶 2.0）
```
- 让 LLM 的风险判断真正进入定价，而不是模板固定 1.5。

### F3 R 一致性硬约束
```
actualR = targetDist / stopDist
计划声明 targetR 只是名义值；报告必须输出 actualR
硬约束 actualR ≥ 1.0；若目标帽导致 actualR < 名义 targetR，必须在计划里标记 cappedR
```

### F4 目标可达性前置审计（只报告，不做闸门）
- 执行前统计每个锚点窗口的历史 5 日波动分布，报告“目标落在历史可移动范围第几分位”。
- 用于暴露定价脱离实际，不自动调整参数（避免重新进入调参陷阱）。

### F5 结构目标缺失时降级
- breakout 计划若无法给出结构目标（q4/q5 均缺失或不可用）→ executionStatus=watch，不得用“close+2.5ATR”兜底。

## 7. 预期效果

- 目标定价从“所有人 2.5 ATR”变成“结构位/区间对边，封顶 2 ATR”
- 止损从“所有人 1.5 ATR”变成“LLM 风险判断 + 失效价约束”
- R 标注与实际一致；G2 语义错位消除
- 47 信号中“脱离实际的定价”应被 F5 与定价审计在生成阶段拦截，而不是等到 G2/成交率阶段才发现

## 8. 结论

“定价脱离实际”的根源有四个：一套宽度适用所有状态（P1）、目标超出 5 日现实移动能力（P2）、R 声明与执行不一致（P3）、结构位与执行位两套坐标（P4）。V8 的定价改造按 F1-F5 落地后，所有价格都回到“结构位 + 风险判断 + 现实波动带”上。
