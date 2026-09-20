# 信号质量回测基线 v6.1（硬约束修正版，复用 v5 计划）

> v6.1 修正：G1 只作用于 B/C；三集合口径 + 闸门成本；止损帽 R≥1；信号日 sector 重算；失效价带宽校验；net 成本 0.25R；证据 linter；前10/后10 拆分。

## 三臂总览（v6.1 安全引擎）

| 臂 | 计划 | 信号 | 闸跳过 | 执行 | 成交 | 方向正确率 | 毛盈亏 | 净盈亏(0.25R) | MFE | MAE |
|---|---|---|---|---|---|---|---|---|---|---|
| A | 60 | 84 | 0 | 13 | 11 | 63.64% | 0.1% | -1.7% | 3.13% | 2.96% |
| B | 60 | 46 | 8 | 7 | 5 | 100% | 2.2% | 1.29% | 3.15% | 1.14% |
| C | 60 | 52 | 31 | 2 | 1 | 100% | 0.2% | -0.13% | 0.55% | 0.42% |

## v5 原引擎 vs v6.1 安全引擎（方向正确率 / 平均盈亏）

| 臂 | v5 原 | v6.1 安全 |
|---|---|---|
| A | 60% / 0.4% | 63.64% / 0.1% |
| B | 50% / -0.13% | 100% / 2.2% |
| C | 25% / -0.99% | 100% / 0.2% |

## 闸门成本（gated 信号在 v5 原引擎的反事实）

| 臂 | 闸跳过 | v5 反事实成交 | 方向正确 | savedPnl | costPnl | 净收益 |
|---|---|---|---|---|---|---|
| A | 0 | 0 | 0/0 | 0% | 0% | 0% |
| B | 8 | 1 | 0/1 | 5.74% | 0% | 5.74% |
| C | 31 | 3 | 1/3 | 10.47% | 7.08% | 3.39% |

## 前10（校准）/ 后10（验证）拆分

| 臂 | 段 | 信号 | 成交 | 方向正确率 | 毛盈亏 | 净盈亏 |
|---|---|---|---|---|---|---|
| A | 校准段 | 39 | 4 | 75% | -2.8% | -4.22% |
| A | 验证段 | 45 | 7 | 57.14% | 1.76% | -0.25% |
| A | 验证段（剔4笔归因） | 43 | 5 | 40% | 1.65% | -0.34% |
| B | 校准段 | 23 | 2 | 100% | 0.94% | 0.5% |
| B | 验证段 | 23 | 3 | 100% | 3.04% | 1.82% |
| B | 验证段（剔4笔归因） | 21 | 1 | 100% | 1.38% | 1.07% |
| C | 校准段 | 22 | 0 | 0% | 0% | 0% |
| C | 验证段 | 30 | 1 | 100% | 0.2% | -0.13% |
| C | 验证段（剔4笔归因） | 27 | 0 | 0% | 0% | 0% |

## C 臂 · macroBias 交叉证伪

| macroBias | 样本 | 方向正确率 | 平均盈亏 |
|---|---|---|---|
| bearish | 1 | 100% | 0.2% |

## C 臂 · sectorBias 交叉证伪

| sectorBias | 样本 | 方向正确率 | 平均盈亏 |
|---|---|---|---|
| bearish | 1 | 100% | 0.2% |

## C 臂 · finCotAlignment / 复用

| 字段 | 样本 | 方向正确率 | 平均盈亏 |
|---|---|---|---|
| alignment=aligned | 1 | 100% | 0.2% |
| mode=reused | 1 | 100% | 0.2% |


## 证伪结论

- A 臂 v5→v6.1：方向正确率 60%→63.64%（3.64pp），毛盈亏 0.4%→0.1%、净盈亏 -1.7%；闸跳过 0，其中 v5 反事实成交 0 笔，saved 0% / cost 0%。
- B 臂 v5→v6.1：方向正确率 50%→100%（50pp），毛盈亏 -0.13%→2.2%、净盈亏 1.29%；闸跳过 8，其中 v5 反事实成交 1 笔，saved 5.74% / cost 0%。
- C 臂 v5→v6.1：方向正确率 25%→100%（75pp），毛盈亏 -0.99%→0.2%、净盈亏 -0.13%；闸跳过 31，其中 v5 反事实成交 3 笔，saved 10.47% / cost 7.08%。
- C 臂拆分：校准段 0 笔 0%；验证段 1 笔 100%；剔除 4 笔归因交易后 0 笔 0%。inSample=true（本批 20 锚点参与了规则校准），不得据此放行。
- 失效价带宽校验：A/B/C 不可用失效退出 69/35/21 个信号；止损帽命中 A/B/C 6/2/2 个信号；证据 linter 警告 A/B/C 0/18/17 个信号。
- v6.1 只修评估与规则硬约束，仍不得作为策略有效性证据；下一轮必须在未见锚点上做 out-of-sample。

## 闸命中统计（跳过原因）

- A: 无
- B: g1_shock_conflict_breakout_forbidden=8
- C: g2_confirmation_too_far:2.64ATR=1，g2_confirmation_too_far:2.86ATR=1，g2_confirmation_too_far:2.76ATR=1，g2_confirmation_too_far:3.04ATR=1，g2_confirmation_too_far:2.63ATR=1，g2_confirmation_too_far:2.52ATR=1，g2_confirmation_too_far:2.99ATR=1，g2_confirmation_too_far:2.89ATR=1，g2_confirmation_too_far:1.95ATR=1，g2_confirmation_too_far:2ATR=1，g2_confirmation_too_far:2.03ATR=1，g2_confirmation_too_far:2.22ATR=1，g1_shock_conflict_breakout_forbidden=8，g2_confirmation_too_far:2.44ATR=1，g2_confirmation_too_far:3.6ATR=1，g2_confirmation_too_far:3.8ATR=1，g2_confirmation_too_far:4.85ATR=1，g2_confirmation_too_far:2.1ATR=1，g2_confirmation_too_far:2.29ATR=1，g2_confirmation_too_far:2.23ATR=1，g2_confirmation_too_far:1.99ATR=1，g2_confirmation_too_far:3.25ATR=1，g2_confirmation_too_far:3.52ATR=1，g2_confirmation_too_far:3.26ATR=1

## diff 阈值敏感性（只报告，不选优）

| 品种 | baseline fresh/reused | relaxed fresh/reused | strict fresh/reused |
|---|---|---|---|
| RB0 | 17/3 | 13/7 | 18/2 |
| M0 | 18/2 | 11/9 | 20/0 |
| SC0 | 16/4 | 13/7 | 17/3 |
