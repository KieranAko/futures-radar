# 16 — 证伪测试框架（walk-forward falsification harness）实现与自测报告

> **任务**: t7 · 执行人: quant-researcher · 日期: 2026-08-28
> **产出**: `falsification/harness.cjs` + `falsification/harness-lib/*.cjs` + `falsification/specs/`（spec schema、demo spec、t8 契约）
> **范围**: 实现并自测框架（合成数据全量自测 + RB0 真实数据冒烟 1 例）；**不跑 8 条核心策略**（t8 职责）。
> **原则**: 不调参、不改定价模型；框架只做"按库口径执行证伪判定"。

---

## 1. 目标与范围

按 `strategy-library-v2.json` 各条目 `falsificationTests` 与 `validationGates` G2/G3/G4 的定义，交付一套确定性的 walk-forward 证伪测试框架：

- T 日收盘信号 → T+1 开盘执行（§0.2 通用口径）；
- purged expanding walk-forward（预注册口径，t3 §0.5 / DIRECTION_V2_CLOSURE_REPORT 语义）+ rolling 窗口模式（M1）；
- PIT 滚动估计（F8）与无未来函数硬守卫；
- 三基线：always-long / always-short / random（种子化、确定性）；
- 95% CI（bootstrap percentile）、PF、Sharpe（trade-level）、命中率、t/二项检验；
- 理论级证伪 hook（每策略 falsificationTests.theoryLevel 机器化）与 killRules 判定；
- 状态建议（retired/suspended/designed/validated-eligible），最终裁定留 t9/t10。

**明确不做**：8 条策略的信号/定价实现（t8）、停板可执行性（无日内涨跌停价数据）、实盘口径复核（t9）。

## 2. 文件清单

```
strategies/research/v2/falsification/
  harness.cjs                     CLI：selftest / run / list / validate-spec
  harness-lib/
    util.cjs                      seed RNG（mulberry32）、稳定序列化/哈希、日期工具
    stats.cjs                     PF/Sharpe/命中/t 检验/二项/OLS/bootstrap CI/ADF/EG/ECM（纯函数）
    data.cjs                      GA-1..GA-7 产物加载器 + PitView 硬锚点视图
    sim.cjs                       TradeSim：T+1 成交、跳空弃单、stop-first、时间退出、换月跳变、成本/R 记账
    engine.cjs                    folds 构建、逐 bar 信号循环、标定（purged）、三基线、回放
    gates.cjs                     G3 门禁、theory 评估、killRules 机器判定、状态建议
    report.cjs                    JSON bundle + Markdown 报告渲染
    selftest.cjs                  22 项合成数据自测
    strategies/demo.cjs           参考 adapter（demo 动量，非库内策略）
  specs/
    demo-momentum.json            参考 spec（RB0，供自测/冒烟）
    README.md                     spec schema + adapter 契约（t8 手册）
  data/
    harness-selftest.json         自测结果（22/22，可复现）
    harness-runs/DEMO-MOMENTUM-seed20260828.{json,md}  真实数据冒烟产物
```

## 3. 执行口径（与库/源文档逐条对齐）

| 项 | 口径 | 溯源 |
|---|---|---|
| 信号日 | T 日收盘冻结值评估；夜盘归下一交易日 | t3 §0.2 |
| 执行 | T+1 开盘成交；跳空 > 各策略阈值 → 弃单（意图不追价） | t3 §0.2/§0.3、各条目 executionRules |
| folds | purged expanding：测试窗=日历年；标定数据止于 testStart−purgeBars(5)；滚动模式=12 月窗（M1） | t3 §0.5、DIRECTION_V2_CLOSURE_REPORT |
| purge 语义 | 事件驱动模拟中，T 日信号只用 ≤T 数据，天然无标签泄漏；折内标定（若 adapter 提供 calibrate）只读 ≤ calibDate 的 PIT 视图，purge 条数从测试窗前剔除 | 同上 |
| 路径优先 | stop-first（保守）：同 bar 止损/目标同触 → 按止损离场；开盘跳空穿过止损 → 以开盘价离场 | 本框架口径（16 §8 限制项） |
| 换月跳变 | ga1-roll-jumps（≥9.5%）：禁止入场；持仓于跳变日前收盘强制离场，跳变收益不入 P&L | t3 §0.3/F5 |
| 成本 | 单腿 7bp 往返、双腿 14bp 往返；per-leg per-side 折算：costR = (roundtripBps/legs/1e4)×entry/|entry−stop| | t3 §0.2、各条目 strategyLevel.cost |
| R 记账 | 1R = 单笔风险 = |entry−stop|×乘数×手数；rawR_leg = side×(exit−entry)/|entry−stop|；netR = sizeR×Σ w_leg×(rawR_leg−costR_leg)；双腿 w=1/nLegs（FS-05 价差 R 由 adapter 定价腿距保证） | t3 §0.2、各条目 pricingModel |
| 事件门 | event.date ≤ 锚点日 且 锚点日 ≤ event.end 才可见/生效（F9）；FS-04/05/EC-01 前提开关由 adapter 经 ctx.eventActive 实现 | F9、t8 F-2 |
| 样本充分 | minTrades 200（TR-06 100）；不足 → 停留 designed（非失效） | G3、各条目 strategyLevel |
| 确定性 | 全链路种子化（run seed、bootstrap seed、基线 seed）；同 seed 两次运行 resultsHash 一致（自测项 19） | 本框架约定 |

## 4. 三基线定义

- **always-long / always-short**：每 fold 每品种，从窗口首个非换月 bar 开盘持有至窗口末 bar 收盘（扣往返成本），报 bps；另折算 pseudo-R（按该策略样本中位相对初始风险距 |entry−stop|/entry）以与 trade-level R 可对照。定义回答"策略超额是否来自市场单边漂移"。
- **random（默认 same-entries-flipped-side）**：与策略相同的入场 bar 与时间退出，方向取反，止损/目标绕实际入场价镜像，沿用相同 stop-first 管理。它回答"给定同一批入场时机与同一风险档位，方向选择是否优于反向"。
  - **注意**：由于 stop-first 优先级在镜像下不对称（同 bar 双触时反向下也会先按自身止损离场），flipped 基线**不是策略 P&L 的代数负数**——这是刻意保守的对照设计，已在产物 convention 字段与自测项 20 中验证（策略 meanR=+0.99 vs flipped=−0.31，diff CI=[0.31,2.75] 不含 0）。
  - `random-entries` 模式（随机 bar+随机方向、止损/目标距从策略样本自举）已实现，供 t8 需要时启用。

## 5. 统计方法

| 方法 | 实现 | 备注 |
|---|---|---|
| PF | 总盈利/|总亏损|（trade-level netR） | G3 阈值 1.2 |
| Sharpe | mean/std（trade-level，非年化——交易为事件序列） | 库"组合夏普"的 trade-level 近似，16 §8 |
| 95% CI | bootstrap percentile（B=10000，种子化）；CI 不含 0 = 上下界同号 | G3 |
| t 检验 | 单样本 t（学生 t 分布，Lentz 连分式不完全 beta） | |
| 二项检验 | 精确二项 p（双侧/单侧） | M1 窗口命中、理论级命中检验 |
| ADF | Δy=α+ρy₋₁+ε 的 t 统计；p 近似=临界值表线性内插（常数项表 −3.4336/−2.8621/−2.5671；EG2 残差表 −4.07/−3.37/−3.03） | 渐近表、250d 小样本为近似（16 §8） |
| EG/ECM | Engle-Granger 两步 + 残差 ADF；ECM γ（Δy=α+γe₋₁+βΔx） | FS-05(a)/EC-01(a) 用 |
| 配对差 CI | 双序列联合重抽样 percentile CI（strategy−baseline） | beatsBaseline=CI 全正 |
| 多数年份为正 | 各 fold（年）meanR>0 的年份占比 >50% | G3 |

## 6. 门禁与状态机

- **G3 策略级**：minTrades、PF≥1.2、95% CI 不含 0、多数年份为正；M1 用 `windowGate`（每窗命中率≥55% 且单尾二项 p<0.10，达标窗口占比≥60%，对齐库 M1.ci 字段）。
- **G4 理论级**：adapter.theory() 返回结构化 `{tests:[{id,label,falsified,evidence}], killOn, metrics}`；任一条 `falsified=true` → retired。
- **killRules**：spec.machineKillRules 逐条求值（metric/op/value/onTrigger），机器可核。
- **建议状态**：理论级证伪 → `retired`；kill 触发 retired/suspended/pair-removed 按优先级；策略级门禁失败且非"仅样本不足" → `suspended`；仅 minTrades 不足 → `designed`（样本不足≠失效）；全部通过 → `validated-eligible`。最终状态由 t8 结论+t9 复核+队长裁定（引擎 note 已声明）。

## 7. 无未来函数守卫（机器硬检查）

1. **PitView 硬锚点**：adapter 对任何视图的读取超锚点即抛 `LookaheadViolation`，引擎硬失败（自测项 18）。
2. 派生字段（GA-2）自带 PIT 口径（per-bar 只用 ≤该 bar 数据），引擎不再重算。
3. 滚动估计（rollingOls/ADF/EG）只在 ≤锚点的切片上计算（F8）。
4. T+1 成交由模拟器时序固化：T 日意图最早在下一全局日、且所有腿当日有 bar 时成交（自测项 8）。
5. 换月跳变 bar 禁入场+持仓跳变前强平（F5，自测项 16）。
6. 事件日历 F9：event.date>锚点日的事件对 adapter 不可见（ctx.eventActive 过滤）。
7. 标定（calibrate）只读 ≤ testStart−purgeBars 的视图；无 calibrate 的 spec 一律用预注册初值（provenance 记录）。
8. 确定性哈希：产物含 resultsHash，同 seed 复跑字节一致（自测项 19）。

## 8. 已知限制（如实声明）

1. **停板可执行性**：仓库无日内涨跌停价序列，v0 不做"距停板<1×ATR5 禁开/止损≤0.8×停板幅度"检查（risk-framework §1/§6 条款在 t9 复核时评估影响）。
2. **ADF 临界值**：用渐近表+线性内插近似 p；250d 小样本窗存在抗保守偏差，结论仅作 0.05/0.10 二元门判定。**口径裁定（R4，t9 复核，2026-08-28）**：三类残差平稳性门统一使用 EG2 表（Engle-Yoo 残差 ADF 近似临界值 1% −4.07 / 5% −3.37 / 10% −3.03）——FS-05 断裂门（60d）、FS-04 F5 门（250d π 残差）、EC-01 (a)（250d 协整残差）全部一致；普通价格序列 ADF 仍用 df-const 表。
3. **flipped 基线非代数负数**（见 §4），managed-exit（z 止损等动态规则）在 flipped 基线中按固定档位镜像（意图日志 `hasManage` 标记）。
4. **Sharpe trade-level**：库"组合夏普"未定义时间聚合方式；v0 采用 trade-level mean/std，与"多数年份为正"互补判定。
5. **always-long pseudo-R**：bps→R 折算使用策略中位相对风险距，属对照参考口径。
6. **跨品种日历对齐**：不同品种停牌日不同，双腿"同步开盘"以"所有腿当日均有 bar"为同步条件（保守：缺腿即顺延）。

## 9. 自测结果（合成数据 + 真实冒烟）

`node harness.cjs selftest` → **22/22 通过**（产物 `data/harness-selftest.json`，2026-08-28）：

| # | 自测项 | 结果 |
|---|---|---|
| 1-3 | PF/命中/均值精确值；t 检验与二项检验已知值（p=0.0569 双 / 0.0284 单） | PASS |
| 4-5 | bootstrap CI 正向排除 0；配对差 CI（x=y+0.3 → 全正） | PASS |
| 6-9 | OLS 精确；ADF：AR(1) φ=0.5 拒绝单位根 / RW 不拒绝（p≥0.10）；EG 检出协整+独立对不检出；ECM γ<0 | PASS |
| 10-12 | T+1 开盘成交；跳空弃单；stop-first 同 bar 双触按止损 | PASS |
| 13-15 | 仅触目标→目标离场；跳空穿止损→开盘离场；时间退出=第 timeExitBars 个持有 bar 收盘 | PASS |
| 16-17 | 换月跳变禁入场+持仓前收强平；成本精确（7bp→costR=0.014）；多腿任一止损→腿收盘同步离场+加权 R | PASS |
| 18-19 | 超锚点读取抛 LookaheadViolation；同 seed 两次运行 resultsHash 一致 | PASS |
| 20-22 | 真实 RB0 冒烟（2015-2026，83 笔，0 违规）；flipped 基线显著低于策略；样本不足→designed / 理论证伪→retired | PASS |

**RB0 真实数据冒烟（demo 动量，非库内策略）**：83 笔、meanR=0.988、PF=2.96、95% CI=[0.18,2.37] 不含 0、8/12 年为正、flipped 基线 −0.31R（diff CI 全正）；**demo 理论级证伪成立**（命中率 50.6%，二项 p≈0.5 ≥0.05）→ 建议 retired——框架按定义正确产出"高均值但无显著方向命中优势 → 理论证伪"的判定，机制闭环。

## 10. t8 使用指引

1. 按 `specs/README.md` 为 8 条策略各建 `specs/<ID>.json` + `harness-lib/strategies/<ID>.cjs`；定价/止损/目标/分档逐字对齐库条目（H2/H3/H5 纪律）。
2. `node harness.cjs validate-spec <ID>` → `node harness.cjs run --spec <ID> --seed 20260828 --out data/harness-runs`。
3. 每策略的 theory() 实现其 falsificationTests.theoryLevel 全部 (a)(b)(c) 项；machineKillRules 与库 killRules 逐条对应。
4. 理论级证伪/kill 触发/门禁结果 → t8 报告与状态建议；t9 复核执行口径与结论。

## 11. 契约对齐索引

- F1（T+1/跳空）、F5（换月）、F8（滚动估计 PIT）、F9（事件日历）→ 引擎固化+守卫；
- G2（回测执行口径）→ §3；G3（策略级门禁）→ §6；G4（理论级证伪）→ §6；
- 各条目 strategyLevel（minTrades/pfThreshold/ci/baselines/cost）→ spec 字段一一对应；
- M1 windowGate（ci 字段修订 t7-E 口径）→ 已实现；
- GA-1..GA-7 数据接口 → data.cjs 只读消费，无网络、无采集器依赖。
