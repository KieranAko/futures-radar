# signal-backtest v4 契约 —— 微型试点：宏观/板块/事件 + FinCoT 上下文锚点

## 试点范围
- 品种：RB0（黑色）、M0（农产品）、SC0（能化）
- 锚点：每品种最近 10 个（2026-06-11 .. 2026-08-14，每 5 个交易日），共 30 个
- 验证：bars 延续到 2026-08-27；T+1 收盘确认 → T+2 开盘执行 → 止损/目标1/时间退出
- 仓位：固定 1 手，不做资金曲线与仓位优化

## 三臂消融（同一批锚点日期）
- A 纯价格：复用 v3 冻结锚点（无上下文），已冻结于 `recordings/v4/arm-A.json`
- B +上下文（无 FinCoT）：价格 + 宏观包 + 板块包 + 事件日历 → 策略计划（`arm-B.json`）
- C +完整 FinCoT：价格 + 宏观包 + 板块包 + 事件日历 → 完整六问（`fincot/<SYM>-<DATE>.json`）→ 报告式操作策略计划（`arm-C.json`）

## 上下文包（recordings/v4/context/<SYM>-<DATE>.json）
- `price`：close/ma20/ma60/atr5/chg5/volRatio（锚点日及以前截断）
- `macro.items`：DXY/USDCNH/US10Y/DR007/SC0 的 asOf 值、change5d、fresh/stale/missing 状态
- `sector`：所属板块指数（等权链式）ret1d/5d/20d、上涨广度、方向 coherence、领涨/领跌成员
- `events.past`：事件日历中锚点日及以前的近期事件（date/type/title/verified/schedule）
- `events.nextScheduled`：锚点日后 7 天内日程已知的事件（合法日程信息，非未来数据）
纪律：任何 asOf/event.date 晚于锚点日的信息禁止使用；`verified=false` 或 `schedule` 只是日程预期，不得当作已发生事实；macro item `status=missing` 时禁止写“宏观利多/利空”。

## B 臂策略计划 schema（recordings/v4/arm-B.json）
每个锚点一个对象：
```json
{
  "date": "2026-07-10",
  "direction": "bullish | bearish | neutral",
  "confidence": "high | medium | low",
  "regime": "trend | range | transition | shock",
  "edge": "trend_continuation | breakout | pullback | mean_reversion | range_fade",
  "triggerType": "breakout | pullback",
  "triggerAtrMult": 0.5, "stopAtrMult": 1.5, "targetR": 2, "maxHoldDays": 5,
  "pullbackLevel": null, "invalidationLevel": 3080.0,
  "qualityFlags": ["trend_aligned"],
  "macroBias": "bullish | bearish | neutral | conflict | not_applicable",
  "sectorBias": "bullish | bearish | neutral | not_applicable",
  "eventRisk": "low | medium | high",
  "executionStatus": "executable | watch | skip",
  "thesis": "…", "driver": "…", "rationale": "…", "invalidationReason": "…",
  "contextRefs": ["macro.DXY", "events.china_pmi"]
}
```
约束：
- neutral 时 edge/triggerType/数值全 null，macroBias/sectorBias/eventRisk 仍要给出，executionStatus 只能 watch/skip。
- triggerAtrMult 0.2-2.0（breakout 必填）；stopAtrMult 1.0-3.0；targetR 1.0-4.0；maxHoldDays 2-10；pullbackLevel 仅 pullback 必填。
- 禁用组合：triggerAtrMult=0.5 && stopAtrMult=1.5 && targetR=2 && maxHoldDays=6。
- `contextRefs` 只能引用上下文包中实际存在的条目（macro.<id> / events.<type> / sector 数字），不得虚构。
- 上下文判断必须写进 rationale：宏观/板块/事件各给了什么信号、如何影响方向和触发方式。

## C 臂：完整 FinCoT（recordings/v4/fincot/<SYM>-<DATE>.json）
按 analyze/blueprint.md 的六问结构，基于截断上下文回答：
- Q1 为什么动（驱动 + 证据引用，只准引用上下文包条目）
- Q2 趋势还是脉冲（量价结构 + 波动率位置）
- Q3 多空哪边更有赔率（至少一条反面证据）
- Q4 关键确认信号（具体、可测量）
- Q5 失效条件（具体、可测量、绑定 Q1 驱动）
- Q6 交易风险（品种/事件/执行风险）
输出 JSON：`{direction, confidence, macroSupport, macroConflict, sectorSupport, eventRisk, q1..q6, evidenceRefs, opposingRefs, invalidateIf}`。
`pass/abstain` 时 direction=neutral 并写明原因（data_insufficient/model_abstain/conflict_unresolved）。

## C 臂策略计划（recordings/v4/arm-C.json）
C 臂策略适配必须显式引用同锚点 FinCoT：新增字段
- `finCotAlignment`: `aligned | diverged | not_applicable`（方向与 FinCoT 不一致必须写 diverged 并给理由）
- `finCotRefs`: 引用的 Q 编号与 evidenceRefs
其余字段与 B 臂相同，且 `executionStatus` 必须与风险判断一致（例如 eventRisk=high 且无对冲条件 → watch）。

## 严格执行引擎（runner-v4.cjs）
- 只执行 `executionStatus=executable` 的计划；计划一经生成不得修改/漂移
- triggerType=breakout：信号日 close ± triggerAtrMult×ATR5 → T+1 收盘严格越过
- triggerType=pullback：信号日 close 进入回调区（多头 `[level-0.5ATR, level+0.25ATR]`，空头对称）→ T+1 收盘越过 pullbackLevel
- T+2 开盘入场；跳空 > 0.5×止损距离 → gap_skip
- 止损/目标1按计划冻结值；最多 maxHoldDays；同臂同品种单持仓

## 统计
- 三臂：计划数/executable 数/信号数/触发执行/成交/跳空/方向正确率/目标1/止损/时间退出/平均盈亏
- C 臂交叉：macroBias/sectorBias/eventRisk/finCotAlignment/qualityFlags
- 消融：A vs B（上下文增量）、B vs C（FinCoT 增量）、A vs C（总增量）
- 样本量声明：30 锚点试点，只作方向性证据
