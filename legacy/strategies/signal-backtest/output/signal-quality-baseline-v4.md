# 信号质量回测基线 v4（上下文 + FinCoT 三臂试点）

> 试点范围：RB0/M0/SC0 × 最近 10 个锚点（2026-06-11 .. 2026-08-14，5 日间隔），验证到 2026-08-27，固定 1 手。
> 严格执行：只执行 executable 计划；T+1 收盘确认 → T+2 开盘执行（跳空放弃）→ 止损/目标1/时间退出，计划不修改不漂移。

## 三臂总览

| 臂 | 计划数 | executable | 信号 | 触发执行 | 成交 | 跳空放弃 | 方向正确率 | 目标1 | 止损 | 平均盈亏 |
|---|---|---|---|---|---|---|---|---|---|---|
| A | 30 | 25 | 42 | 7 | 6 | 1 | 66.67% | 0% | 16.67% | 1.93% |
| B | 30 | 15 | 25 | 4 | 3 | 1 | 66.67% | 0% | 0% | -0.53% |
| C | 30 | 15 | 25 | 4 | 3 | 1 | 66.67% | 0% | 0% | -0.53% |

## 分品种 × 分臂方向正确率

| 品种 | A | B | C |
|---|---|---|---|
| RB0 | 100% (1) | 100% (2) | 100% (2) |
| M0 | 0% (1) | 0% (0) | 0% (0) |
| SC0 | 75% (4) | 0% (1) | 0% (1) |

## C 臂 · macroBias 交叉证伪

| macroBias | 样本 | 方向正确率 | 平均盈亏 |
|---|---|---|---|
| neutral | 2 | 50% | -1.49% |
| bearish | 1 | 100% | 1.38% |

## C 臂 · sectorBias 交叉证伪

| sectorBias | 样本 | 方向正确率 | 平均盈亏 |
|---|---|---|---|
| bullish | 2 | 50% | -1.49% |
| bearish | 1 | 100% | 1.38% |

## C 臂 · eventRisk 交叉证伪

| eventRisk | 样本 | 方向正确率 | 平均盈亏 |
|---|---|---|---|
| low | 2 | 50% | -1.49% |
| medium | 1 | 100% | 1.38% |

## C 臂 · finCotAlignment 交叉证伪

| finCotAlignment | 样本 | 方向正确率 | 平均盈亏 |
|---|---|---|---|
| aligned | 3 | 66.67% | -0.53% |

## 消融结论

| 对比 | 方向正确率差（百分点） | 平均盈亏差（%） |
|---|---|---|
| B - A（宏观/板块/事件上下文的增量） | 0 | -2.46 |
| C - B（完整 FinCoT 的增量） | 0 | 0 |
| C - A（总增量） | 0 | -2.46 |


## 证伪结论

- B - A（宏观/板块/事件上下文的增量）：方向正确率 0 pp，平均盈亏 -2.46%。
- C - B（完整 FinCoT 的增量）：方向正确率 0 pp，平均盈亏 0%。
- C - A（总增量）：方向正确率 0 pp，平均盈亏 -2.46%。
- C 臂成交 3 笔，样本过小，结论只能作试点观察。
- C 臂成交中带 contextRefs 的 3/3 笔（100%），上下文可溯源覆盖。
- 执行引擎对三臂完全一致；三臂差异只来自 LLM 决策上下文。30 个锚点、固定 1 手，仅作试点证据。

## C 臂锚点决策分布

| 品种 | direction | regime | edge | triggerType | executionStatus |
|---|---|---|---|---|---|
| RB0 | neutral=3 bearish=5 bullish=2 | transition=5 trend=3 shock=1 range=1 | null=3 trend_continuation=2 pullback=1 breakout=3 mean_reversion=1 | null=3 breakout=5 pullback=2 | watch=4 executable=6 |
| M0 | neutral=4 bearish=3 bullish=3 | range=3 trend=4 transition=3 | null=4 trend_continuation=3 breakout=3 | null=4 breakout=6 | watch=6 executable=4 |
| SC0 | bearish=2 neutral=3 bullish=5 | trend=6 transition=3 range=1 | trend_continuation=1 pullback=3 null=3 breakout=2 range_fade=1 | breakout=3 pullback=4 null=3 | watch=4 executable=5 skip=1 |
