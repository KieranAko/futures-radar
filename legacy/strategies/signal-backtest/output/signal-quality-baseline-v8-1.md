# 信号质量回测基线 V8.1（生产 strategy-plan + F1-F5 定价层）

> 链路：V7 FinCoT（分析）→ 生产 strategy-matcher（策略适配）→ 本执行引擎（只读 plan 字段）。

- 30 个计划：原始 executable 12、定价层放行 6（watch 6）、成交 2、方向正确率 50%、毛 -0.01%/净 -0.35%

| 品种 | 计划 | 原始 exec | 定价放行 | watch | 成交 | 方向正确率 | 毛盈亏 | 净盈亏 |
|---|---|---|---|---|---|---|---|---|
| RB0 | 10 | 7 | 3 | 4 | 1 | 100% | 1.39% | 1.05% |
| M0 | 10 | 5 | 3 | 2 | 1 | 0% | -1.41% | -1.76% |
| SC0 | 10 | 0 | 0 | 0 | 0 | 0% | 0% | 0% |

## 逐计划结果

| 品种 | 锚点 | 状态 | 方向 | 策略 | 入场 | 离场 | 盈亏 |
|---|---|---|---|---|---|---|---|
| M0 | 2026-06-11 | gap_skip | bearish | MS-02 | 2939 | - | -% |
| M0 | 2026-06-18 | verified | bearish | MS-02,MS-07 | 2939 | 2980.4（stopped_out） | -1.41% |
| M0 | 2026-06-26 | not_executable | bullish | BASE-01 | - | - | -% |
| M0 | 2026-07-03 | not_executable | neutral | BASE-01 | - | - | -% |
| M0 | 2026-07-10 | pricing_watch | bullish | MS-02,MS-07 | - | - | -% |
| M0 | 2026-07-17 | not_executable | bullish | BASE-01 | - | - | -% |
| M0 | 2026-07-24 | not_executable | bullish | MS-02,MS-07 | - | - | -% |
| M0 | 2026-07-31 | pricing_watch | bearish | MS-02 | - | - | -% |
| M0 | 2026-08-07 | trigger_miss | bullish | MS-02,MS-07 | - | - | -% |
| M0 | 2026-08-14 | not_executable | bullish | MS-07 | - | - | -% |
| RB0 | 2026-06-11 | not_executable | bearish | BASE-01 | - | - | -% |
| RB0 | 2026-06-18 | gap_skip | bearish | BASE-01 | 3131 | - | -% |
| RB0 | 2026-06-26 | pricing_watch | bearish | BASE-01 | - | - | -% |
| RB0 | 2026-07-03 | pricing_watch | bearish | BASE-01 | - | - | -% |
| RB0 | 2026-07-10 | gap_skip | bearish | BASE-01 | 3087 | - | -% |
| RB0 | 2026-07-17 | not_executable | neutral | BASE-01 | - | - | -% |
| RB0 | 2026-07-24 | verified | bearish | BASE-01 | 3076 | 3033.1（target1_hit） | 1.39% |
| RB0 | 2026-07-31 | pricing_watch | bearish | BASE-01 | - | - | -% |
| RB0 | 2026-08-07 | not_executable | bullish | MS-02,MS-07 | - | - | -% |
| RB0 | 2026-08-14 | pricing_watch | bullish | MS-07 | - | - | -% |
| SC0 | 2026-06-11 | not_executable | bearish | MS-02 | - | - | -% |
| SC0 | 2026-06-18 | not_executable | bearish | MS-02 | - | - | -% |
| SC0 | 2026-06-26 | not_executable | bearish | BASE-01 | - | - | -% |
| SC0 | 2026-07-03 | not_executable | bearish | BASE-01 | - | - | -% |
| SC0 | 2026-07-10 | not_executable | bearish | BASE-01 | - | - | -% |
| SC0 | 2026-07-17 | not_executable | bullish | MS-02,MS-07 | - | - | -% |
| SC0 | 2026-07-24 | not_executable | bullish | MS-02,MS-07 | - | - | -% |
| SC0 | 2026-07-31 | not_executable | bullish | BASE-01 | - | - | -% |
| SC0 | 2026-08-07 | not_executable | neutral | BASE-01 | - | - | -% |
| SC0 | 2026-08-14 | not_executable | bullish | MS-07 | - | - | -% |
