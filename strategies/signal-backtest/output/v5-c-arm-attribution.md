# v5 C 臂逐笔归因（4 笔成交：1 胜 3 负）

> 归因对象：`strategies/signal-backtest/output/signal-quality-baseline-v5.json` 中 C 臂 4 笔 `verified` 成交。
> 本文件只做归因，不重跑回测、不修改任何 recordings 与 baseline。

## 总表

| # | 品种 | 锚点 | 信号→入场 | 方向 | 离场 | 盈亏 | 主要归因 |
|---|---|---|---|---|---|---|---|
| 1 | RB0 | 2026-06-26（FinCoT reused←06-18） | 06-30→07-02 | bearish | 07-09 时间退出 3091 | -0.55% | 目标过远 + 无失效退出，小幅方向错误 |
| 2 | SC0 | 2026-04-13（fresh） | 04-17→04-21 | bearish | 04-24 止损 655.6 | -5.74% | 冲击后追空 + 弱美元对冲兑现 + Q6 风控未编码 |
| 3 | SC0 | 2026-08-14（fresh） | 08-17→08-19 | bullish | 08-26 时间退出 556.4 | -4.73% | 追涨入场 + 目标1不可达 + 利润回吐 |
| 4 | SC0 | 2026-06-18（fresh） | 06-24→06-26 | bearish | 07-02 时间退出 434.3 | +7.08% | 三杀共振方向正确（对照样本） |

成交样本只有 4 笔，归因用于找机制缺陷，不用于评价 FinCoT 优劣。

---

## 逐笔归因

### 1. RB0 2026-06-26 bearish（-0.55%，time_exit）
**计划**：trend_continuation / breakout；trigger 3070.1，stop 3114.9，target1 2980.5，hold5。FinCoT reused←2026-06-18。

**事实**
- 锚点日：c 3093 < m20 3150.8 < m60 3166.2，sect.r5 -1.96%，DXY 101.36 偏强 → 空头论题在锚点日成立。
- 入场后价格先到 3062（07-03，最优约 -0.4%），随后逐步修复到 3091（07-09）。
- 止损 3114.9 未触发；target1 2980.5 从未接近；最终时间退出。

**归因**
- `target_unreachable`：目标距离 entry 约 -3.0%（89.6 点），而 5 日 ATR 只有 24 点级别；该目标隐含 3.7 个 ATR 的移动，5 天内不可达。
- `exit_mechanical_time`：持仓期内没有“失效/移动止损/保本”机制，价格从浮盈转小亏后仍按满持有期时间退出。
- `reused_fincot_scope_mismatch`（轻）：06-26 复用 06-18 的六问是 diff 判定允许的（无实质变化），但继承的 Q4 有两个确认路径——“反弹至 m20 滞涨”或“跌破 3100”；执行引擎只实现了 breakout 一个路径，实际触发的是后者，而该触发并未满足 Q1 的“反弹滞涨”语义。
- 方向错误是次要矛盾：锚点日方向合理，错误主要出在目标与退出结构。

### 2. SC0 2026-04-13 bearish（-5.74%，stopped_out）
**计划**：shock / breakout；trigger 619.2，stop 655.6，target1 546.6，hold4。FinCoT fresh，macroSupport=bullish（弱美元），sectorSupport=bearish。

**事实**
- 锚点日：c 658，chg5 **-8.86%**，板块 r5 -6.04%，co=1.0；但 DXY -1.58%、US10Y -0.92%（宏观反向）。
- FinCoT Q4 确认条件：“T+1 收盘不收复 708”。实际触发价 619.2——**确认位与触发价相差 89 点（约 1.9 个锚点 ATR5=48）**，确认条件形同虚设。
- 入场 620 后 3 个交易日反弹至 660.8，止损 655.6 被击穿。
- FinCoT Q6 明确写了“仓位减半、不隔周末”，但计划 schema 没有对应字段，执行引擎固定 1 手、持有 4 天。

**归因**
- `entry_chase`：在 -8.86% 冲击日后追空，Q3 明确列出的反面证据（弱美元 → 空头回补）在 3 日内兑现。
- `confirmation_too_loose`：Q4 的 708 确认位与 619 触发价脱节，确认机制没有起到过滤作用。
- `risk_mitigation_not_encoded`：FinCoT Q6 的“减半仓、不隔周末”只存在于文本，无法被严格执行——**这是 C 臂“消费 FinCoT”仍然不彻底的最典型证据**。
- `macro_conflict_realized`：计划选择用 sector 压过 macro 的冲突，结果 macro 一侧兑现。

### 3. SC0 2026-08-14 bullish（-4.73%，time_exit）
**计划**：trend_continuation / breakout；trigger 576.6，stop 544.4，target1 657.2，hold5。FinCoT fresh，趋势/板块全部转正，macro neutral。

**事实**
- 锚点日：c 556.2 站上 m20 545.8 / m60 533.9，chg5 +4.67%，板块 r1/r5/r20 全正 → 多头论题成立。
- 入场 584（08-19）；价格最高到 603.6（08-24，浮盈约 +3.4%），随后 08-26 回落至 551.7，未触及止损 544.4，时间退出在 556.4。
- target1 657.2 = entry +12.5%，约 3.5 个 ATR5（20.7 点）外。

**归因**
- `entry_chase`：chg5 已 +4.67%、价格连续 3 日上涨后追 breakout，Q3 自己提示了“获利回吐压力”。
- `target_unreachable`：+12.5% 的目标在 5 日持有期内几乎不可达；价格曾浮盈 +3.4%，没有任何止盈/保本路径。
- `exit_mechanical_time`：从 +3.4% 浮盈拿到 -4.7% 亏损离场；缺 trailing stop 或 +1R 保本规则。
- 方向判断本身在入场后 3 天是对的——**这笔的失败不是 FinCoT 方向错，而是执行结构没有保护浮盈**。

### 4. SC0 2026-06-18 bearish（+7.08%，time_exit，对照样本）
**计划**：shock / breakout；trigger 467.8，stop 498.3，target1 406.9，hold4。FinCoT fresh。

**事实**
- 锚点日：c 508.5，chg5 -12.64%；DXY +1.10、US10Y +0.22、sect.r5 -7.02、r20 -10.04、breadth=0——宏观/板块/价格三杀共振，且宏观与方向同侧。
- 入场 467.4 后继续下行至 434.3，时间退出 +7.08%；target1 406.9（-12.9%）未到。

**归因（为什么这笔赢）**
- `direction_correct`：方向证据在宏观/板块/价格三层同侧，无冲突项（对比 #2 的弱美元冲突）。
- 入场路径是 Q4 的“T+1 未收复 545”确认后执行，确认位 545 与触发价 467.8 相距 77 点——同样偏松，但方向强，掩盖了确认缺陷。
- 仍暴露同一问题：target1 不可达，靠时间退出兑现，少拿了后续 06-26→07-02 那段延续行情。

---

## 跨笔结论（机制缺陷，不是“FinCoT 错”）

1. **Q6 的风控文本没有进入计划字段**（#2 最典型）：仓位减半、不隔周末、反抽风险等只写在 rationale 里，执行引擎无法消费。C 臂的“真正消费 FinCoT”目前只消费了 Q4/Q5 的方向与价位，没消费 Q6。
2. **Q4 确认位与触发价脱节**（#2、#4）：shock 日确认位 708/545 vs 触发 619/467，确认基本失效。
3. **target1 系统性不可达**（4 笔全未命中）：目标距离 entry 3%~12.9%，超出 5 日波动能力；应改为“≤2×ATR5 或 ≤持有期已实现波动分位”。
4. **只有硬止损+时间退出，没有失效/保本/移动退出**（#1、#3）：两笔浮盈单全部回吐为亏损。报告计划的 `invalidation.hard` 与 Q5 在持仓期没有被执行。
5. **冲击后追单**（#2、#3 的入场问题）：|chg5|≥4.67% 后沿用 breakout 触发，等于在情绪极值点入场；pullback 触发在 #2/#3 都更合适。
6. **reused FinCoT 的 Q4 路径不完整**（#1）：复用六问后，执行引擎只能走 breakout，继承的“反弹滞涨”确认路径丢失。
7. 4 笔全部 `finCotAlignment=aligned`，没有一笔 diverged——说明 FinCoT 与计划之间缺少真正的分歧压力测试，计划几乎是在复述 FinCoT。

## 下一轮改造优先级（待批准后再动）
1. 计划 schema 增加 `riskExecution`：positionScale / weekendRule / adverseExcursionLimit，直接从 Q6 结构化提取。
2. 增加 `exitManagement`：`+1R 保本`、`trailing 0.75R`、`invalidation 硬退出`，至少覆盖 4 笔里的 2 笔时间退出亏损。
3. 限制 `target1`：距离 ≤ 2×ATR5，且与 `maxHoldDays` 匹配。
4. shock 或 |chg5|>5% 时，triggerType=breakout 降级为 watch；只允许 pullback。
5. reused FinCoT 必须把 Q4 重新映射为当前价格可执行的两个触发路径，否则不得 executable。
