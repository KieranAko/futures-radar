# 信号质量回测基线 v3（LLM 定性判断优先）

> 立场：不做参数组合选优。数值参数只是执行机制；回测重点证伪 LLM 的 regime / edge / triggerType / qualityFlags 定性判断，并与纯量化对照臂比较。
> 链路：LLM 锚点（每 5 交易日）→ 确定性信号延续 → T+1 收盘确认 → T+2 开盘执行 → 止损/目标1/时间退出。

## 总览

| 指标 | 值 |
|---|---|
| 品种 | RB0 / M0 / SC0 |
| 行情区间 | 2024-08-06..2026-08-27 |
| LLM 锚点数 | 285（每 5 交易日） |
| 淘汰组合命中锚点（跳过） | 0 |
| 生成信号 | 380 |
| 触发执行 | 73 |
| 成交 / 跳空放弃 | 53 / 20 |
| 方向正确率 | 49.06% |
| 目标1 / 止损 / 时间退出 | 7.55% / 22.64% / 69.81% |
| 平均单笔盈亏 | -0.23% |

## 分品种

| 品种 | 信号 | 执行 | 方向正确率 | 目标1 | 止损 | 平均盈亏 |
|---|---|---|---|---|---|---|
| RB0 | 131 | 25 | 57.14% | 9.52% | 19.05% | -0.01% |
| M0 | 157 | 27 | 38.89% | 11.11% | 33.33% | -0.85% |
| SC0 | 92 | 21 | 50% | 0% | 14.29% | 0.22% |

## LLM 定性判断交叉证伪 · regime

| regime | 样本 | 方向正确率 | 平均盈亏 |
|---|---|---|---|
| trend | 33 | 42.42% | -0.22% |
| transition | 13 | 53.85% | -0.33% |
| shock | 4 | 50% | -1.46% |
| range | 3 | 100% | 1.7% |

## LLM 定性判断交叉证伪 · edge

| edge | 样本 | 方向正确率 | 平均盈亏 |
|---|---|---|---|
| trend_continuation | 25 | 44% | 0.05% |
| breakout | 18 | 55.56% | -0.41% |
| pullback | 6 | 33.33% | -1.72% |
| range_fade | 3 | 100% | 1.7% |
| mean_reversion | 1 | 0% | -0.9% |

## LLM 定性判断交叉证伪 · triggerType

| triggerType | 样本 | 方向正确率 | 平均盈亏 |
|---|---|---|---|
| breakout | 43 | 48.84% | -0.15% |
| pullback | 10 | 50% | -0.61% |

## LLM 质量核查清单交叉证伪

| qualityFlag | 样本 | 方向正确率 | 平均盈亏 |
|---|---|---|---|
| trend_aligned | 35 | 40% | -0.37% |
| structure_clean | 29 | 48.28% | -0.52% |
| volatility_normal | 29 | 48.28% | -0.32% |
| volume_confirmed | 18 | 61.11% | 0.62% |
| event_risk | 4 | 50% | -1.19% |

## 纯量化对照臂（MA20 趋势 + 固定执行参数，无 LLM）

| 指标 | LLM 锚点臂 | 纯量化对照臂 |
|---|---|---|
| 生成信号 | 380 | 876 |
| 触发执行 | 73 | 169 |
| 成交 | 53 | 116 |
| 方向正确率 | 49.06% | 40.52% |
| 平均单笔盈亏 | -0.23% | -0.16% |

## 执行参数分布（观察，不选优）

| 参数 | 样本 | 方向正确率 | 平均盈亏 |
|---|---|---|---|
| trigger0.6×stop1.5×R2×hold6×breakout | 5 | 60% | 0.24% |
| trigger0.6×stop1.8×R2×hold5×breakout | 5 | 20% | -1.07% |
| trigger0.5×stop1.8×R2.5×hold6×breakout | 4 | 0% | -1.56% |
| trigger0.5×stop1.8×R2.5×hold5×breakout | 3 | 100% | 5.63% |
| trigger0.5×stop1.5×R2×hold5×pullback | 3 | 33.33% | -0.4% |
| trigger0.5×stop1.8×R2×hold5×breakout | 3 | 100% | 2.89% |
| trigger0.4×stop1.5×R2×hold5×breakout | 2 | 50% | -0.68% |
| trigger0.5×stop1.7×R2.8×hold5×breakout | 2 | 50% | -1.23% |
| trigger0.5×stop1.7×R2.8×hold6×breakout | 2 | 50% | -1.14% |
| trigger0.6×stop2×R3×hold6×breakout | 2 | 100% | 0.34% |
| trigger0.7×stop1.5×R2×hold6×breakout | 2 | 50% | 0.96% |
| trigger0.4×stop1.5×R2×hold4×breakout | 1 | 0% | -1.83% |
| trigger0.6×stop2×R3×hold7×breakout | 1 | 100% | 0.49% |
| trigger0.4×stop1.7×R2.8×hold5×pullback | 1 | 100% | 2.26% |
| trigger0.5×stop1.8×R2.2×hold4×pullback | 1 | 100% | 1.66% |
| trigger0.6×stop1.6×R2.9×hold5×pullback | 1 | 100% | 0.29% |
| trigger0.6×stop1.5×R3.2×hold6×pullback | 1 | 100% | 3.16% |
| trigger0.4×stop1.8×R2.5×hold5×pullback | 1 | 0% | -1.9% |
| trigger0.6×stop1.4×R2×hold5×breakout | 1 | 0% | -3.75% |
| trigger0.7×stop1.5×R2.2×hold6×breakout | 1 | 0% | -4.07% |
| trigger0.8×stop1.8×R2×hold6×breakout | 1 | 0% | -2.54% |
| trigger0.6×stop1.4×R2×hold6×breakout | 1 | 100% | 0.76% |
| trigger0.5×stop1.6×R2×hold4×pullback | 1 | 0% | -1.38% |
| trigger0.6×stop1.5×R2×hold5×breakout | 1 | 0% | -2.03% |
| trigger0.6×stop1.6×R2.2×hold5×breakout | 1 | 100% | 0.59% |
| trigger0.6×stop1.4×R2.2×hold6×breakout | 1 | 0% | -4.78% |
| trigger0.7×stop1.8×R2×hold5×breakout | 1 | 0% | -3.97% |
| trigger0.8×stop2×R2.5×hold4×breakout | 1 | 0% | -4.51% |
| trigger-×stop2×R2×hold5×pullback | 1 | 0% | -8.99% |
| trigger1×stop2×R2.5×hold4×breakout | 1 | 100% | 7.08% |
| trigger0.8×stop1.8×R2.5×hold5×breakout | 1 | 100% | 0.58% |

## 证伪结论

- LLM 锚点臂方向正确率 49.06% vs 纯量化对照臂 40.52%：LLM 判断跑赢 8.54 个百分点（对照臂=MA20 趋势 + 0.5/1.5/R2/hold5，无 LLM）。
- 最弱 edge 类别：mean_reversion（1 笔，方向正确率 0%），下一轮优先收紧该定性判断的准入条件。
- 最强 edge 类别：range_fade（3 笔，方向正确率 100%），保留并验证其稳定性。
- 最弱 regime 类别：trend（33 笔，方向正确率 42.42%）。
- 跳空放弃 20 笔，跳空仍是主要执行摩擦。
- 结论覆盖 2 年、3 个主力连续品种、录制的 LLM 锚点；成交样本有限，仅作基线，不下“最优参数”结论。

## 锚点决策分布（方向 / regime / edge / triggerType）

| 品种 | direction | regime | edge | triggerType |
|---|---|---|---|---|
| RB0 | neutral=15 bullish=36 bearish=44 | shock=12 transition=26 trend=47 range=10 | null=15 mean_reversion=2 breakout=28 trend_continuation=23 pullback=19 range_fade=8 | null=15 pullback=29 breakout=51 |
| M0 | bullish=51 neutral=25 bearish=19 | transition=29 trend=41 range=19 shock=6 | breakout=25 pullback=11 trend_continuation=29 null=25 mean_reversion=5 | breakout=54 pullback=16 null=25 |
| SC0 | bearish=35 neutral=32 bullish=28 | transition=34 trend=33 range=11 shock=17 | pullback=19 null=32 breakout=22 range_fade=1 trend_continuation=20 mean_reversion=1 | pullback=21 null=32 breakout=42 |
