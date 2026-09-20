# 信号质量回测基线 v5（紧凑上下文 + 变化驱动 FinCoT 三臂试点）

> 试点范围：RB0/M0/SC0 × 最近 20 个锚点（2026-03-27 .. 2026-08-14，5 日间隔），验证到 2026-08-27，固定 1 手。
> 严格执行：只执行 executable 计划；T+1 收盘确认 → T+2 开盘执行（跳空放弃）→ 止损/目标1/时间退出，计划不修改不漂移。

## 三臂总览

| 臂 | 计划数 | executable | 信号 | 触发执行 | 成交 | 跳空放弃 | 方向正确率 | 目标1 | 止损 | 平均盈亏 |
|---|---|---|---|---|---|---|---|---|---|---|
| A | 60 | 47 | 76 | 11 | 10 | 1 | 60% | 10% | 10% | 0.4% |
| B | 60 | 23 | 44 | 7 | 6 | 1 | 50% | 16.67% | 16.67% | -0.13% |
| C | 60 | 20 | 48 | 5 | 4 | 1 | 25% | 0% | 25% | -0.99% |

## 分品种 × 分臂方向正确率

| 品种 | A | B | C |
|---|---|---|---|
| RB0 | 66.67% (3) | 66.67% (3) | 0% (1) |
| M0 | 50% (2) | 0% (0) | 0% (0) |
| SC0 | 60% (5) | 33.33% (3) | 33.33% (3) |

## C 臂 · macroBias 交叉证伪

| macroBias | 样本 | 方向正确率 | 平均盈亏 |
|---|---|---|---|
| bearish | 2 | 50% | 3.27% |
| bullish | 1 | 0% | -5.74% |
| neutral | 1 | 0% | -4.73% |

## C 臂 · sectorBias 交叉证伪

| sectorBias | 样本 | 方向正确率 | 平均盈亏 |
|---|---|---|---|
| bearish | 3 | 33.33% | 0.26% |
| bullish | 1 | 0% | -4.73% |

## C 臂 · eventRisk 交叉证伪

| eventRisk | 样本 | 方向正确率 | 平均盈亏 |
|---|---|---|---|
| medium | 3 | 33.33% | 0.26% |
| low | 1 | 0% | -4.73% |

## C 臂 · finCotAlignment 交叉证伪

| finCotAlignment | 样本 | 方向正确率 | 平均盈亏 |
|---|---|---|---|
| aligned | 4 | 25% | -0.99% |

## C 臂 · FinCoT 复用（fresh vs reused）

| finCotMode | 样本 | 方向正确率 | 平均盈亏 |
|---|---|---|---|
| fresh | 3 | 33.33% | -1.13% |
| reused | 1 | 0% | -0.55% |

## 消融结论

| 对比 | 方向正确率差（百分点） | 平均盈亏差（%） |
|---|---|---|
| B - A（宏观/板块/事件上下文的增量） | -10 | -0.53 |
| C - B（完整 FinCoT 的增量） | -25 | -0.86 |
| C - A（总增量） | -35 | -1.39 |


## 证伪结论

- B - A（宏观/板块/事件上下文的增量）：方向正确率 -10 pp，平均盈亏 -0.53%。
- C - B（完整 FinCoT 的增量）：方向正确率 -25 pp，平均盈亏 -0.86%。
- C - A（总增量）：方向正确率 -35 pp，平均盈亏 -1.39%。
- C 臂成交 4 笔，样本过小，结论只能作试点观察。
- C 臂成交中带 contextRefs 的 4/4 笔（100%），上下文可溯源覆盖。
- 执行引擎对三臂完全一致；三臂差异只来自 LLM 决策上下文。60 个锚点、固定 1 手，仅作试点证据。

## C 臂锚点决策分布

| 品种 | direction | regime | edge | triggerType | executionStatus |
|---|---|---|---|---|---|
| RB0 | neutral=4 bearish=12 bullish=4 | range=3 trend=13 transition=4 | null=4 range_fade=2 trend_continuation=11 breakout=2 pullback=1 | null=4 breakout=15 pullback=1 | watch=14 executable=6 |
| M0 | neutral=8 bullish=8 bearish=4 | range=10 trend=8 transition=2 | null=8 breakout=5 pullback=1 range_fade=2 trend_continuation=3 mean_reversion=1 | null=8 breakout=7 pullback=5 | watch=14 executable=4 skip=2 |
| SC0 | bullish=7 neutral=4 bearish=9 | trend=9 transition=7 shock=3 range=1 | pullback=4 null=4 breakout=7 trend_continuation=4 range_fade=1 | pullback=5 null=4 breakout=11 | watch=9 executable=10 skip=1 |
