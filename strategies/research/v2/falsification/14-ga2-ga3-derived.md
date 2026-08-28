# 14 GA-2/GA-3 全品种派生指标与板块序列重建完成报告

> 角色：data-engineer（数据工程师）· 执行日期：2026-08-28
> 任务：GA-2（全品种 ATR5/HV/HV%ile/概率锥批量）+ GA-3（板块广度/leaders/laggards 历史重建）
> 执行方案依据：`10-ga-plan.md` §5/§6
> 结论一句话：**GA-2 与 GA-3 完成。GA-2：59/59 品种全历史滚动派生入库（ATR5、HV20-YangZhang、HVpct90、MA20/MA60、量比、3d/5d 概率锥），机器校验 8/8 通过（覆盖、finite、asOf=T、独立复算相对误差 ≤1.9e-8）；GA-3：7 板块全历史序列重建入库（4234–5283 行/板块），与旧管道 2026-08-27 快照逐字段对拍一致，校验 4/4 通过。**

---

## 1. GA-2 执行摘要

| 项 | 结果 |
|---|---|
| 工具 | `strategies/research/v2/falsification/ga2-derived-batch.cjs`（新建；复用 `probability/hv-estimators.js`、`probability/probability-cone.js`） |
| 输入 | `data/daily/*.json`（GA-1 全历史，59 品种，178,310 bars） |
| 覆盖 | **59/59** 品种，全历史滚动序列 + T 日快照 |
| 耗时 | 37.9s（全品种全历史滚动 HV 计算） |
| 输出 | `data/ga2-derived/<SYM>.json`（14MB）+ `data/ga2-derived-index.json` |
| 派生字段 | ATR5、HV20（Yang-Zhang 年化 242d）、HVpct90（90 日百分位）、MA20、MA60、量比（5 日均量）、3d/5d p68/p95 概率锥（cap-6 provenance=probability.json 口径） |
| 口径来源 | ATR5 = stage-4-5.cjs `computeATRFromBars` 同口径；HV = `autoEstimateHV`（yang_zhang）；HVpct90 = `hvPercentile`；量比 = strategy-matcher.cjs 同口径（vol/近5日均量） |
| PIT/asOf | 每个 bar 的派生值只用 ≤该 bar 数据（F8）；`snapshot.asOfDate` = 品种最后 bar 日期（asOf=T）；provenance 字段逐字段写入 |

### 机器校验结果（ga2-verify.cjs，8/8 通过）

| # | 校验项 | 结果 |
|---|---|---|
| V1 | 覆盖：59/59 品种，series.dates 与 data/daily 逐 bar 一致 | ✅ |
| V2 | finite：全品种 snapshot 六字段 finite + 锥非空；warm-up null 模式与期望精确一致（atr5<5、ma20<20、ma60<60、量比<5、hv20<21、hvPct90<110 及源端零量窗口） | ✅ |
| V3 | asOf=T：asOfDate == 品种最后 bar 日期（59/59） | ✅ |
| V4 | 独立复算对拍（RB0/SC0 全序列，naive ATR5/MA20/MA60/量比 + 独立 YZ 实现）：maxRel = 1.93e-8 / 1.28e-7 | ✅ |
| V5 | HVpct90 数值域 0–100 + 末 bar 与 hvPercentile 同参复算一致（±0.11） | ✅ |
| V6 | rollJumpDates ⊆ ga1-roll-jumps.json（F5 换月附注一致） | ✅ |

### 修复过程（已闭环）

1. **量比舍入误差**：初版 4 位小数舍入在微量比值上引入 4.3%–37% 相对误差（如 SC0 2019-05-13 真值 0.0010527 → 0.0011；RB0 2015-02-25 真值 4.8e-6 → 0）→ 量比改全精度；
2. **ATR5/HV20 舍入误差**：4 位小数在 hv≈0.07–0.16 上引入 ≥3e-4 相对误差 → 改全精度；
3. 复算阈值收紧至 1e-6 后全部通过（最终 maxRel ≈1e-8，浮点精度级）。

### 数据质量注记（源数据如实记录，未伪造/未修补）

- **FU0 零成交量 bar 815 根**（2012 年起，占 15.5%）→ 量比在 5 日窗口均量为 0 处按 null 处理（522 处），不虚构数值；
- PB0 零量 28 根 → 量比 null 6 处；
- RB0 量比=0 精确值 3 处（当日量=0、窗口均量>0，真值 0 保留）；
- 主力连续 vs 主导合约口径：本批量按契约 GA-2 定义在 data/daily（主力连续）上计算；stage-4-5 的 P0「现价/HV/ATR 用主导合约干净序列」策略适用于每日 run 定价，walk-forward 引擎如需可自行重算，本缓存提供滚动序列供 PIT 切片。

## 2. GA-3 执行摘要

| 项 | 结果 |
|---|---|
| 工具 | `strategies/research/v2/falsification/ga3-sector-rebuild.cjs`（新建；口径复刻 `collector/sector-aggregator.cjs`） |
| 输入 | `data/daily/*.json`（GA-1 全历史）+ `config/symbols.json`（板块成员/标签） |
| 输出 | `data/sector/{black,nonferrous,precious,energy_chemical,agriculture,shipping,new_materials}.json`（schema `futures-radar-sector-series/1`，全历史 rows）+ `data/sector/snapshots/ga-3-sector-rebuild.json`（最新一日快照）+ `data/ga3-sector-series-ext.json`（每日期 leaders/laggards 明细，候补 TR-08 用） |
| 指数口径 | 等权成员日收益链式累乘、基点 1000（与 aggregator `buildSectorIndex` 一致）；advanceRatio=上涨成员占比；coherence=与板块方向一致占比（±0.3% 阈值）；leader=方向一致最强成员；leaders/laggards=ret5d 前3/后3 |
| PIT | 每个日期的板块指标只用 ≤该日期 的成员 bars（F8）；成员按当日有 bar 计算（members 列为当日有效成员数） |

### 重建规模

| 板块 | rows | 起止 | 末行 members |
|---|---|---|---|
| black | 4234 | 2009-03-30 .. 2026-08-28 | 2（当日有 bar 成员） |
| nonferrous | 5271 | 2005-01-05 .. 2026-08-28 | 2 |
| precious | 4541 | 2008-01-10 .. 2026-08-28 | 2 |
| energy_chemical | 5274 | 2005-01-05 .. 2026-08-28 | 3 |
| agriculture | 5283 | 2005-01-05 .. 2026-08-28 | 3 |
| shipping | 733 | 2023-08-21 .. 2026-08-28 | 1 |
| new_materials | 892 | 2022-12-23 .. 2026-08-28 | 1 |

（末行 members 少是因为 2026-08-28 仅部分品种有最新 bar——源端结算数据滞后为真实状态，如实保留；2026-08-27 行 members=9/7/… 全量。）

### 机器校验结果（4/4 通过）

| # | 校验项 | 结果 |
|---|---|---|
| G3-V1 | 7 板块 rows 排序/无重复/无未来日期/指数水平>0/leader 非空 | ✅ |
| G3-V2 | ext 文件每日期 leaders/laggards ≤3 且非空 | ✅ |
| G3-V3 | **2026-08-27 重建行与旧管道快照逐字段一致**（ret1d=0.36、ret5d=0.83、ret20d=6.26、advanceRatio1d=55.6、advanceRatio5d=77.8、coherence1d=55.6、volumeRatio20d=1.17、leader=J0/3.04、members=9） | ✅ |
| G3-V4 | 快照文件与序列末行一致（indexLevel=1126.44/ret1d=0.82/dataEnd=2026-08-28） | ✅ |

注：指数绝对水平随链式起点不同而不同（旧快照 997.61 为 61-bar 短链起点、本次 1117.25 为 2009 起全历史链），**收益类字段逐字段一致**——验证了重建口径与管道聚合器完全同源。绝对水平仅作序列展示，回测只用 ret/breadth/leader 字段。

## 3. 失败回退与 no-source 复核

- 无需回退：GA-1 全历史数据完备，GA-2/GA-3 为纯本地派生，无外部数据依赖；
- 无 no-source 项；
- FU0/PB0 零量窗口按 null 处理并留档（源数据缺口如实记录，不修补不虚构）。

## 4. 与下游的接口

- **G2 治理层**：`ga2-derived-index.json` 每品种快照（ATR5/HV/HVpct90/MA20/MA60/量比/锥）直接供 G2 波动率 overlay（volPercentile 门槛）与 G1/M1 等消费；
- **walk-forward 引擎**：`data/ga2-derived/<SYM>.json` 的 `series` 滚动序列可按任意 T 日 PIT 切片（F8 已内置），换月跳变按 `rollJumpDates` + `ga1-roll-jumps.json` 剔除（F5）；
- **候补策略**：`data/ga3-sector-series-ext.json` 的逐日 leaders/laggards 供 TR-08/FS-06/TR-04 候补回测；
- **TR-03 概率锥**：snapshot.cones（3d/5d p68/p95）provenance=probability.json 管线口径，仅用于目标定价（cap-6）。

## 5. 交付物

| 文件 | 说明 |
|---|---|
| `strategies/research/v2/falsification/14-ga2-ga3-derived.md` | 本报告 |
| `strategies/research/v2/falsification/ga2-derived-batch.cjs` | GA-2 批量派生器（新建，可复跑） |
| `strategies/research/v2/falsification/ga2-verify.cjs` | GA-2 机器校验（新建，8 项断言） |
| `strategies/research/v2/falsification/ga3-sector-rebuild.cjs` | GA-3 板块历史重建（新建，可复跑） |
| `strategies/research/v2/falsification/data/ga2-derived/*.json`（59）+ `ga2-derived-index.json` | GA-2 派生缓存（14MB） |
| `strategies/research/v2/falsification/data/ga3-sector-series-ext.json` | GA-3 逐日 leaders/laggards 明细 |
| `data/sector/*.json`（7）+ `data/sector/snapshots/ga-3-sector-rebuild.json` + `_index.json` | GA-3 入库产物（更新） |

> 本报告为数据前置执行记录，不构成投资建议。
