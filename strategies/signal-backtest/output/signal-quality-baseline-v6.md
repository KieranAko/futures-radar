# 信号质量回测基线 v6（v5 计划 + 五道安全闸，不新增 LLM）

> 复用 v5 冻结的 A/B/C 计划，只更换执行引擎。G1 冲突闸 / G2 确认距离闸（仅 C）/ G3 目标帽 2×ATR / G4 三日确认+保本+移动止损 / G5 失效硬退出。

## 三臂总览（v6 安全引擎）

| 臂 | 计划 | 信号 | 闸跳过 | 执行 | 成交 | 方向正确率 | 平均盈亏 | MFE均值 | MAE均值 |
|---|---|---|---|---|---|---|---|---|---|
| A | 60 | 93 | 20 | 10 | 8 | 50% | -1.45% | 2.28% | 3.53% |
| B | 60 | 46 | 8 | 7 | 5 | 100% | 2.2% | 3.15% | 1.14% |
| C | 60 | 51 | 27 | 3 | 2 | 100% | 3.64% | 4.03% | 1.45% |

## v5 原引擎 vs v6 安全引擎（方向正确率 / 平均盈亏）

| 臂 | v5 原 | v6 安全 |
|---|---|---|
| A | 60% / 0.4% | 50% / -1.45% |
| B | 50% / -0.13% | 100% / 2.2% |
| C | 25% / -0.99% | 100% / 3.64% |

## C 臂 · macroBias 交叉证伪

| macroBias | 样本 | 方向正确率 | 平均盈亏 |
|---|---|---|---|
| bearish | 2 | 100% | 3.64% |

## C 臂 · sectorBias 交叉证伪

| sectorBias | 样本 | 方向正确率 | 平均盈亏 |
|---|---|---|---|
| bearish | 2 | 100% | 3.64% |

## C 臂 · finCotAlignment / 复用

| 字段 | 样本 | 方向正确率 | 平均盈亏 |
|---|---|---|---|
| alignment=aligned | 2 | 100% | 3.64% |
| mode=reused | 1 | 100% | 0.2% |
| mode=fresh | 1 | 100% | 7.08% |


## 证伪结论

- A 臂 v5→v6：方向正确率 60%→50%（-10pp），平均盈亏 0.4%→-1.45%（-1.85%），闸跳过 20 个信号。
- B 臂 v5→v6：方向正确率 50%→100%（50pp），平均盈亏 -0.13%→2.2%（2.33%），闸跳过 8 个信号。
- C 臂 v5→v6：方向正确率 25%→100%（75pp），平均盈亏 -0.99%→3.64%（4.63%），闸跳过 27 个信号。
- 目标帽命中 51 个 C 信号；失效退出 0 笔；3 日确认退出 1 笔。
- G2 仅作用于 C 臂（A/B 无 FinCoT Q4 数值）；五道闸均为固定规则，不调参。样本仍很小，仅作机制对照。

## 闸命中统计（跳过原因）

- A: g1_extreme_momentum_breakout_forbidden=12，g1_shock_conflict_breakout_forbidden=8
- B: g1_shock_conflict_breakout_forbidden=8
- C: g2_confirmation_too_far:2.64ATR=1，g2_confirmation_too_far:2.86ATR=1，g2_confirmation_too_far:2.76ATR=1，g2_confirmation_too_far:3.04ATR=1，g2_confirmation_too_far:2.63ATR=1，g2_confirmation_too_far:2.52ATR=1，g2_confirmation_too_far:2.99ATR=1，g2_confirmation_too_far:2.89ATR=1，g2_confirmation_too_far:1.95ATR=1，g2_confirmation_too_far:2ATR=1，g2_confirmation_too_far:2.03ATR=1，g2_confirmation_too_far:2.22ATR=1，g1_shock_conflict_breakout_forbidden=8，g2_confirmation_too_far:2.1ATR=1，g2_confirmation_too_far:2.29ATR=1，g2_confirmation_too_far:2.23ATR=1，g2_confirmation_too_far:1.99ATR=1，g2_confirmation_too_far:3.25ATR=1，g2_confirmation_too_far:3.52ATR=1，g2_confirmation_too_far:3.26ATR=1
