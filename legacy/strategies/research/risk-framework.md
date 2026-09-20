# 交易风险管理框架（Risk Framework）

> **作者**: risk-expert（风险管理专家）
> **任务**: t4 — 调研交易风险管理框架
> **状态**: 供 t5（策略库整合）/ t6（匹配规则）/ t7（报告板块契约）/ t8（matcher 实现）消费
> **范围**: 仓位、止损、波动率目标、回撤控制、情景风险、失效退出；只给可执行参数与约束，不承诺任何收益
> **数据纪律**: 全部输入来自 futures-radar 现有 run artifacts（`probability.json` / `analysis.json` / `report-facts.json` / `config/symbols.json`），不新增数据源、不联网、不使用持仓分析；保证金/涨跌停以交易所当日公告为准（与报告 Q6 口径一致）

---

## 0. 框架总览与参数速查表

本框架由 **7 个风控组件 + 1 组中国期货市场结构硬约束 + 1 套确定性仓位公式** 组成。所有参数分为三级：

- **硬约束（Hard）**: 违反即不可执行（跳过该策略或降级为观察）；
- **默认参数（Default）**: 可执行的推荐值，允许在文档声明的范围内调整；
- **警示规则（Warning）**: 触发时打标记、降级仓位或提示风险，不直接否决。

| 组件 | 关键参数 | 默认值 | 允许范围 | 类型 |
|------|----------|--------|----------|------|
| 单笔风险上限 | `riskPerTradePct`（按止损距离计的单笔风险占权益比） | 1.0% | 0.5% – 1.0% | Hard 上限 |
| 置信度缩放 | `confidenceScale` | high=1.0, medium=0.75, low=0 | 固定映射 | 规则 |
| 组合风险预算 | 全部持仓风险合计占权益比 | ≤ 2.5% | ≤ 2.5% | Hard |
| 波动率目标 | `volTargetPerPosition`（单仓年化波动率贡献） | 10% | 5% – 15% | Default |
| 组合波动率目标 | `volTargetBook` | 20% | 10% – 20% | Hard 上限 |
| ATR 止损 | `stopK`（止损距离 = K × ATR5） | 1.5 | 1.0 – 2.0 | Default |
| 止损可执行性 | `stopDistancePct ≤ 0.8 × limitPct`（距涨跌停幅度留 20% 余量） | 0.8 | 0.6 – 1.0 | Hard |
| 最大回撤阶梯 | `drawdownLadder` | 见 §4 | — | Hard |
| 板块集中度 | `maxPositionsPerSector` | 1 | 1 | Hard |
| 并发持仓上限 | `maxConcurrentPositions` | 3 | ≤3（与雷达 TOP3 一致） | Hard |
| 保证金占用 | `marginUtilizationCap`（全部持仓保证金/权益） | 33% | ≤ 33% | Hard |
| 单品种保证金门槛 | 1 手保证金 > 20% 权益 → 观察不执行 | 20% | 10% – 30% | Hard |
| 持有期限 | `maxHoldingDays`（信号失效时间止损） | 5 | 3 – 5（对齐 5d 概率锥） | Hard |
| 盈亏比门槛 | 目标距离 ≥ 1.5 × 止损距离 | 1.5 | ≥ 1.0 | Hard（跨组件） |
| 波动率分位警示 | `volPercentile ≥ 85%` → 减半且仅高置信可做；`≥ 95%` → 跳过 | 85/95 | — | Warning/Hard |
| 区间模型失稳 | `divergencePct ≥ 20%`（probability.json 判 ❌）→ 波动率目标上限 ×0.5 | ×0.5 | — | Warning |
| 尾部情景校验 | 3d p95 反向边距 ≥ limitPct → 标记连续停板风险并减半 | — | — | Warning |
| 反摊平 | 禁止亏损加仓摊低成本 | — | — | Hard |

> ⚠️ 所有参数均为**风险控制输入**，不是收益承诺；历史文献支持这些机制能控制波动与回撤，但任何框架都不能消除亏损可能。

---

## 1. 单笔风险上限（Per-trade Risk Budget）

**定义**: 每笔交易计划在入场前固定的最大亏损金额（1R），以“止损距离 × 合约乘数 × 手数”计算，与名义价值无关。核心思想来自 Van Tharp 的 1R 仓位模型：先定风险金额，再由风险金额反推手数。

**可执行参数**:
- `riskPerTradePct ∈ [0.5%, 1.0%]`（按账户权益计）；默认 **1.0%**，对应 3 笔并发时组合风险 ≤ 3% 的行业常见上限；
- CME 教育课程明确 2% 为单笔风险硬上限；本框架取更保守的 1.0% 作为 Hard 上限，因为雷达信号为日频、持有期短、回撤容忍低；
- `confidenceScale`: high=1.0 / medium=0.75 / low=0（观望，只观察不持仓）。映射必须由 `analysis.json` 的 `direction/confidence` 字段确定，禁止另设主观判断。

**适用条件**: 适用于所有 TOP3 品种；对 `q2=impulse`（脉冲型）信号，建议额外 ×0.5（脉冲衰竭快、噪声大）。

**与保证金/杠杆兼容性**: 期货名义杠杆通常 8–12 倍（8%–12% 保证金），但**风险金额只与止损距离挂钩**，杠杆只影响保证金占用（§8），两者独立计算后取最小值。禁止因为杠杆可用就放大风险预算。

**证据**:
- Van Tharp Institute, "Understanding All the Risks in a Trade" — https://vantharpinstitute.com/understanding-all-the-risks-in-a-trade-by-van-k-tharp-ph-d/
- CME Group, "The 2% Rule"（交易与风险管理课程） — https://www.cmegroup.com/education/courses/trade-and-risk-management/the-2-percent-rule

---

## 2. 波动率目标仓位（Volatility Targeting）

**定义**: 按“仓位年化波动率贡献 = 权益 × 目标波动率”反推名义敞口，使高波动品种自动减仓、低波动品种适度加仓。学术上称为 volatility-managed portfolios / volatility scaling。

**可执行参数**:
- 单仓目标 `volTargetPerPosition = 10%`（5%–15%）；
- 组合目标 `volTargetBook ≤ 20%`（Hard 上限；10%–20% 为管理期货行业常见目标区间）；
- 名义敞口公式: `notional = volTargetPerPosition × equity / hv.annual`（`hv.annual` 取自 `probability.json`）；
- 手数 = `floor(notional / (close × multiplier))`。

**适用条件**:
- 仅当 `hv.degraded == false` 且 `atrComparison.divergencePct < 20%` 时全额适用；`divergencePct ≥ 20%`（区间模型失稳 ❌，如 1910 run 的 RM0 = 27%）→ 波动率目标上限 ×0.5，主要依靠 ATR 止损与保证金约束定仓；
- `volPercentile ≥ 85%` → 波动扩张 regime，sizeScale ×0.5 且仅 high 置信可执行；`≥ 95%` → 跳过（波动率尾部不可控）。

**与保证金/杠杆兼容性**: 最终手数 = `min(风险预算手数, 波动率目标手数, 保证金手数)`，波动率目标负责“风险平价式”缩放，保证金负责“杠杆上限”，两者不矛盾。

**证据**:
- Moreira & Muir (2017), "Volatility-Managed Portfolios", Journal of Finance 72(4) — https://onlinelibrary.wiley.com/doi/10.1111/jofi.12513
- Moskowitz, Ooi & Pedersen (2012), "Time Series Momentum" 及其波动率缩放（40% 年化目标）的实践解读 — https://alphaarchitect.com/time-series-momentum-volatility-scaling-and-crisis-alpha/ ；原文 — https://www.sciencedirect.com/science/article/abs/pii/S1386418116301379
- 波动率目标机制说明 — https://convextrade.com/glossary/vol-targeting ； https://algotradinglib.com/en/pedia/v/volatility_targeting.html

> 说明：上述文献报告波动率缩放改善风险调整后特征，本框架**仅将其用于控制风险暴露**，不引用、不承诺任何收益数据。

---

## 3. ATR 止损（ATR-based Stops）

**定义**: 以 ATR5（`probability.json` 中已计算）为基准设定初始止损距离，并与结构性失效位（来自 `analysis.json` Q5/Q4，如 MA20、前高/前低）取更紧者。

**可执行参数**:
- `stopK ∈ [1.0, 2.0]`，默认 **1.5**；建议映射：high 置信 → 2.0，medium → 1.5，low → 不持仓；
- 多头: `stopPrice = max(close − K×ATR5, structuralStop)`（取更贴近现价者，损失更小）；
- 空头: `stopPrice = min(close + K×ATR5, structuralStop)`；
- **可执行性 Hard 约束**: `stopDistancePct = |close − stopPrice| / close ≤ 0.8 × limitPct`。理由：止损距离超过当日涨跌停幅度的 80% 时，单日可能无法以计划价位成交，止损不再是可执行指令；
- 结构止损优先原则：若 Q5 失效位（如 MA20）比 ATR 止损更近，以结构位为准（如 1910 run PX0：MA20=8062 距现价 1.4%，比 2×ATR 的 6.7% 更近 → 用 8062）。

**移动止损（可选，确定性规则）**: 价格朝有利方向收盘推进 ≥ 1×ATR5 后，止损移至 `入场价`（保本）；之后每再推进 1×ATR5，上移（多头）/下移（空头）1×ATR5（Chandelier exit 的简化日频版本，原版为 3×ATR(22) 从极值回撤）。

**与保证金/杠杆兼容性**: 止损距离决定单笔风险金额 → 决定手数上限；与保证金占用相互独立，取最小手数。

**证据**:
- StockCharts ChartSchool, "Chandelier Exit"（3×ATR(22) 极值回撤止损） — https://chartschool.stockcharts.com/table-of-contents/technical-indicators-and-overlays/technical-overlays/chandelier-exit
- Wilder 原始 ATR 定义（经由 futures-radar `probability.json` 的 ATR5 实现）

---

## 4. 最大回撤控制（Drawdown Control）

**定义**: 组合层面按权益从峰值回撤比例逐级降险，直至停止新开仓。管理期货行业常见风险关闭线在 10%–15% 回撤区间。

**可执行参数（drawdownLadder，默认值）**:

| 回撤区间（权益/峰值 − 1） | 动作 |
|------|------|
| 0 – 5% | 正常执行，风险预算 ×1.0 |
| 5% – 8% | 风险预算 ×0.5，波动率目标 ×0.5 |
| 8% – 12% | 风险预算 ×0.25，仅 high 置信策略 |
| ≥ 12% | 停止新开仓，现有持仓按失效条件退出，复盘后再恢复 |

附加规则（确定性）:
- **连续亏损熔断**: 连续 3 笔交易亏损 → 暂停新开仓 1 个交易日；连续 5 笔 → 暂停 5 个交易日；
- **周度损失上限**: 单周权益损失 ≥ 3% → 当周停止新开仓。

**适用条件**: 阶梯按“账户权益”计量（以收盘结算价逐日盯市），不是按名义敞口；必须配合 §8 的保证金缓冲（保证金占用 ≤33%）执行，否则回撤中途会被强平打断而非主动降险。

**与保证金/杠杆兼容性**: 保证金占用上限（33%）本身即回撤缓冲：即便单日极端反向波动 2×涨跌停（约 8%–10%），持仓名义损失仍显著小于可用权益。

**证据**:
- 管理期货/CTA 风控实践与回撤管理 — "High-Performance Managed Futures"（Melissinos）；CTA 配置与风险讨论 — https://rpc.cfainstitute.org/blogs/enterprising-investor/2026/decoding-cta-allocations-by-trend-horizon
- 组合分散与风险预算 — Efficient Capital Management (Molyboga) 访谈 — https://openurl.ebsco.com/EPDB%3Agcd%3A6%3A35420454/detailv2

---

## 5. 相关性与板块集中度（Correlation / Sector Concentration）

**定义**: 限制同板块与高相关品种的并行敞口，防止一次产业冲击击穿组合。

**可执行参数（Hard）**:
- `maxPositionsPerSector = 1`：同一 `sector`（`config/symbols.json` 分类）最多 1 个可执行持仓；
- `maxConcurrentPositions = 3`（与雷达 TOP3 上限一致）；
- 高相关认定规则（确定性）：
  - 同 sector → 相关；
  - 不同 sector 但共享同一主驱动（如 EG0/PX0 均以 SC0 原油为成本锚，见 `config/macro-transmission.json` 油链能化路由）→ 相关；
  - 相关品种同时出现可执行计划时：合并风险预算 ×1.5 上限，且各自仓位减半；更简单的默认：**置信度更高/赔率更优者保持 executable，其余输出完整 plan 但 executionStatus="watch"（集中度冲突），不省略计划**（队长裁定：策略适配与执行许可分层）。

**适用条件**: 1910 run 的 TOP3 即典型案例：RM0（agriculture）+ EG0/PX0（energy_chemical ×2，且同为原油成本驱动、同为空头方向）→ 按本规则 EG0 与 PX0 只能保留其一，另一只给观察计划。

**与保证金/杠杆兼容性**: 保证金占用按持仓合并计算（§8），集中度规则先行于保证金计算。

**证据**: 组合分散与相关风险 — 见 §4 Molyboga 访谈；CME 交易与风险管理课程（风险分散模块） — https://www.cmegroup.com/education/courses/trade-and-risk-management/the-2-percent-rule

---

## 6. 事件风险（Event Risk / Gap Risk）

**定义**: 隔夜跳空、涨跌停锁定、宏观事件（USDA/FOMC/OPEC/地缘）与长假提保造成的价格不连续风险。

**可执行参数（确定性）**:
- **隔夜跳空情景**: 用 `probability.json` 的 3d/5d p95 反向边距做尾部校验：
  `tailGapPct = |p95_adverse − close| / close`；若 `tailGapPct ≥ limitPct` → 标记“极端情景下可能连续停板、止损可能无法成交”，仓位减半或跳过（1910 run：EG0 tail = −9.6% ≥ 4% 涨停板幅度 → 触发）；
- **事件前降险**: 来自 `analysis.json` Q6 `eventRisk` 字段的事件（如黑海局势、USDA 报告、原油供给消息）在已知日程前：持仓 ≤ 50% 或退出，**禁止加仓**；
- **长假规则（中国期货特有）**: 交易所节前普遍提高保证金、扩大涨跌停 → 长假前最后交易日收盘前将保证金占用降至 20% 以下，或直接平仓（避免假期外盘单边导致节后停板无法出场）；
- **停板流动性**: 若止损价落在涨跌停板之外 → 不提供市价止损，只给条件单 + 明确“可能滑点至停板价成交”提示。

**与保证金/杠杆兼容性**: 事件情景仓位核算使用“最坏 1 个停板”代替 ATR 止损距离做压力测试：`stressRisk = lots × multiplier × limitPct × close`，要求 `stressRisk ≤ 1.5 × riskPerTradePct × equity`，否则降手数。

**证据**:
- OpenAlgo, "Gap Risk and Event Risk – Futures Trading" — https://openalgo.in/futures/gap-and-event-risk
- 经济日历/事件前仓位管理实践 — https://supertrader.me/blog/economic-calendar-trading-guide/
- 交易所保证金与涨跌停联动调整实例（大商所） — https://www.egsea.com/news/detail/2331930.html

---

## 7. 失效退出（Invalidation Exits）

**定义**: 除价格止损外的逻辑退出：原分析逻辑被证伪、时间失效、或新运行报告取代旧计划。

**可执行参数（确定性）**:
- **硬失效（Q5 直译）**: `analysis.json` 的 `q5_invalidation.conditions` 逐条映射为退出触发，如 RM0：“收盘跌破 MA20(≈2221) 且成交量放大 → 平多”；
- **时间止损**: `maxHoldingDays = 5`（对齐 5d 概率锥）。T+5 内既不触发确认（Q4）也不触发失效（Q5）→ 市价退出（信号失去时效）；
- **脉冲加速失效**: `q2=impulse` 品种若 T+2 内未沿方向扩展 ≥ 0.5×ATR5 → 退出（脉冲型信号时间价值衰减快）；
- **计划取代（supersession）**: 每次新 run 产出新 strategy-plan 即自动作废旧计划（单一事实来源，防信号叠加）；
- **禁止摊平**: 任何失效条件触发后必须按计划退出，禁止亏损加仓摊低成本（Hard）。

**适用条件**: 适用于所有可执行与观察计划；观察计划（0 手）也需给出“转执行触发条件”（即 Q4 确认信号），由下一运行判定。

**与保证金/杠杆兼容性**: 无直接冲突；时间止损同时降低保证金跨假期占用风险。

**证据**: 失效/退出纪律为交易员通用实践，参照 CME 交易与风险管理课程（退出规则部分）与 Van Tharp 1R 框架（https://vantharpinstitute.com/understanding-all-the-risks-in-a-trade-by-van-k-tharp-ph-d/）。

---

## 8. 中国期货市场结构硬约束（保证金 / 杠杆 / 涨跌停 / 夜盘 / 换月）

与框架各组件交叉的**不可违反**约束，全部以交易所当日公告为准（报告 Q6 已同口径声明）：

| 约束 | 规则 | 数据来源 |
|------|------|----------|
| 合约乘数 | 手数、保证金、风险金额计算必须用 `config/symbols.json` 的 `multiplier` | config |
| 保证金率 | 取 Q6 `margin` 估算区间（5%–15%）中值 8% 为默认计算值；实际执行以交易所+期货公司公告为准 | analysis.json Q6 |
| 保证金占用上限 | 全部持仓保证金/权益 ≤ 33%（Default 20% 更优） | 本框架 |
| 单品种门槛 | 1 手保证金 > 20% 权益 → 该品种降级为观察 | 本框架 |
| 涨跌停 | 止损距离 ≤ 0.8 × 当日涨跌停幅度；极端品种（EC0 ±16%）在停板期间市价止损可能不成交 | analysis.json Q6 `limitDistance` |
| 夜盘 | 存在夜盘的品种隔夜跳空计入尾部校验（§6）；无夜盘品种事件跳空更大 | Q6 `overnightGap` |
| 换月 | 计划必须绑定 `probability.json` 的 `seriesSource`（specific_contract）并提示 Q6 中的换月距离；临近交割月主力减仓、限仓趋严 | Q6 / probability.json |
| 连续停板强平 | 连续单边市可能出现三板强减、无法平仓 → 归入“极端情景风险提示” | 交易所规则 |

**杠杆核算示例（确定性公式）**: `marginPerLot = close × multiplier × marginRate`；`lotsMargin = floor(equity × marginUtilizationCap / marginPerLot)`。对 10 万权益、8% 保证金：RM0 ≈ 17 手、EG0 ≈ 8 手、PX0 ≈ 10 手 —— 保证金约束远松于风险/波动率约束，因此**手数几乎总是由风险预算与波动率目标决定，杠杆只是安全上限**。

---

## 9. 确定性仓位公式（供 strategy-matcher 实现）

以下伪代码为纯函数，输入全部来自现有 artifacts，实现时请与本节保持数值一致：

```text
Inputs:  symbol, equity, direction, confidence, close, atr5, hv.annual,
         hv.degraded, hv.percentile90d, divergencePct, limitPct,
         multiplier, marginRate, structuralStop(from Q5/Q4), tailGapPct
Constants (riskConfig, 默认值见 §0):
  RISK_PCT_BASE=0.01, CONF={high:1.0, medium:0.75, low:0},
  VOL_TARGET=0.10, MARGIN_UTIL_CAP=0.33, STOP_K={high:2.0, medium:1.5},
  LIMIT_STOP_CAP=0.8, BOOK_RISK_CAP=0.025, MIN_RR=1.5

1. direction == "neutral" || confidence == "low"  → plan.status = "watch",
   lots = 0（转执行触发 = Q4 确认信号），仍输出止损/失效参数。

2. stopDistance = min(STOP_K[conf] × atr5, LIMIT_STOP_CAP × limitPct/100 × close)
   stopDistance = min(stopDistance, |structuralStop − close|)   // 结构位更近则用结构位
   stopPrice    = direction=="bullish" ? close − stopDistance : close + stopDistance
   unitRisk     = stopDistance × multiplier

3. lotsRisk  = floor(equity × RISK_PCT_BASE × CONF[conf] / unitRisk)
   lotsVol   = floor(equity × VOL_TARGET / (hv.annual × close × multiplier))
   lotsMargin= floor(equity × MARGIN_UTIL_CAP / (close × multiplier × marginRate))
   lots      = min(lotsRisk, lotsVol, lotsMargin)

4. 警示调整（确定性）:
   - hv.degraded || divergencePct ≥ 20      → lotsVol 已隐含，lots = min(lots, floor(lotsVol×0.5 重算))
   - hv.percentile90d ≥ 85                  → lots = floor(lots/2)；仅 CONF==high 可执行，否则 lots=0
   - hv.percentile90d ≥ 95                  → lots = 0, executionStatus="skip"
   - tailGapPct ≥ limitPct                  → 标记连续停板风险，lots = floor(lots/2)
   - stressRisk = lots × multiplier × limitPct/100 × close > 1.5 × RISK_PCT_BASE × CONF[conf] × equity
                                            → lots = floor(lots × (1.5 × budget / stressRisk))

5. Hard 校验:
   - lots ≤ 0                                  → executionStatus="watch"（含最小可执行权益说明）
   - lots × unitRisk / equity > RISK_PCT_BASE  → 减手数重算（正常构造下不会发生，双保险）
   - 1 手保证金 > 0.20 × equity                 → executionStatus="watch"（资金不足）
   - 组合校验: Σ(各计划 lots×unitRisk)/equity ≤ BOOK_RISK_CAP；同 sector 可执行计划 ≤ 1；
     相关品种（同 sector 或同成本锚）同向冲突时：置信度更高者保持 executable，其余**仍输出完整 plan** 但 executionStatus="watch"（statusReason=集中度冲突），不得省略计划（队长裁定：策略适配与执行许可分层）。

6. 盈亏比校验（跨组件，与 trader playbook 的目标位配合）:
   |target − close| ≥ MIN_RR × stopDistance，否则 executionStatus="skip"（风险回报不足）。
```

**风险对象输出 schema（建议，供 t7 契约引用）**:

```json
{
  "risk": {
    "riskPerTradePct": 0.0075,
    "confidenceScale": 0.75,
    "stopK": 1.5,
    "stopDistancePts": 72.9,
    "stopPrice": 2275.1,
    "structuralStop": 2221,
    "unitRiskCny": 729,
    "lots": 1,
    "marginPerLotCny": 1878,
    "marginUtilizationPct": 1.88,
    "volContributionPctAnnual": 3.5,
    "tailGapPct3d": -3.2,
    "stressRiskCny": 1174,
    "eventRiskNote": "黑海局势反复、替代供应政策变化",
    "maxHoldingDays": 5
  },
  "invalidation": {
    "hard": ["收盘跌破MA20(≈2221)且成交量放大 → 平多"],
    "timeStop": "T+5 无确认无失效则市价退出",
    "supersededByNextRun": true
  },
  "executionStatus": "executable | watch | skip",
  "statusReason": "资金不足/波动率分位过高/风险回报不足/集中度冲突…"
}
```

---

## 10. 真实 run 数据推演示例（20260827-1910-auto，示例计算，非建议）

输入取自 `probability.json` / `analysis.json`；默认参数 equity=10 万 CNY（可配置示例，非承诺）；marginRate=8%（Q6 区间中值）；limitPct 取 Q6 口径（RM0≈5%、EG0/PX0≈4%）。

| 项 | RM0 菜粕 | EG0 乙二醇 | PX0 对二甲苯 |
|----|----------|-----------|-------------|
| 方向/置信/q2 | 多/medium/trend | 空/medium/impulse | 空/medium/trend |
| close / ATR5 | 2348 / 48.6 (2.1%) | 5028 / 222.6 (4.4%) | 7948 / 268 (3.4%) |
| HV 年化 / 分位 | 14.9% / P77.8 | 46.1% / P87.8 | 29.2% / P64.4 |
| 区间模型失稳 | 27% ❌ → vol cap ×0.5 | 12.1% ⚠️ | 12.1% ⚠️ |
| 2×ATR 止损距离 | 97.2 点 (4.1%) | 445 点 (8.9%) ❌超限 | 536 点 (6.7%) ❌超限 |
| 0.8×涨停帽 | 94 点 → 生效 | 161 点 → 生效 | 254 点 |
| 结构位（Q5） | MA20≈2221（127 点，不更紧） | MA20≈4858（170 点，不更紧） | MA20≈8062（114 点，**更紧，采用**） |
| 最终止损距离 | 72.9 点（K=1.5） | 160.9 点 | 114 点 |
| 每手风险 | 729 元 | 1609 元 | 570 元 |
| 风险预算手数(10万) | 0.75%×10万/729 = 1.0 → **1 手** | 0.75%×10万/1609 = 0.47 → **0 手** | 750/570 = 1.3 → **1 手** |
| 波动率目标手数 | 2 手（×0.5 失稳后 1 手） | 0.43 → **0 手** | 0.86 → **0 手** |
| 保证金手数(33%帽) | 17 手（不约束） | 8 手（不约束） | 10 手（不约束） |
| 尾部 3d p95 | −3.2%（< 涨停幅度，OK） | −9.6% ≥ 4% → **连续停板警示** | −6.2% ≥ 4% → **警示** |
| 波动分位规则 | P77.8 不触发 | P87.8 ≥ 85 → 减半+仅高置信 | P64.4 不触发 |
| **结论** | **可执行 1 手**（风险 0.73%，vol 贡献 3.5%，保证金占用 1.9%） | **观察**（波动分位+尾部+风险预算三重否决；medium 下约需 21 万权益才到 1 手门槛，且需高置信） | **观察**（波动率目标否决；约 12 万权益起 1 手可行，且需通过盈亏比校验） |
| 板块集中度 | agriculture ✓ | energy_chemical（与 PX0 同 sector 且同成本锚、同向）→ 两者最多保留其一 | energy_chemical |

**推演要点**（供 t6/t8 参考）:
1. 手数几乎总被**风险预算或波动率目标**约束，保证金只是安全上限；
2. EG0/PX0 在 10 万权益下天然降级为观察——这是框架的诚实输出，不是缺陷；报告策略板块应如实显示“观察 + 转执行触发条件”，不得为了“每个 TOP3 都有可执行策略”而放松参数；
3. RM0 的 27% 区间失稳触发 vol cap ×0.5，但最终手数由风险预算决定，结论不变——规则应保留输出**触发了哪些规则**（statusReason），供 reviewer 与读者核对。

---

## 11. 与策略库/报告的接口约定

- 策略库（t5）的每条策略 `risk` 字段引用本框架参数名（如 `stopK`、`riskPerTradePct`、`drawdownLadder`），不重复定义；
- **执行许可分层（队长裁定，t6/t7/t8 必须遵守）**：每个 TOP3 仍必须匹配至少 1 个策略并给出完整 plan；`executionStatus ∈ {executable, watch, skip}` 为合法三态，watch/skip 必须携带 `statusReason` 风控原因；集中度/相关性冲突、资金不足、波动率分位过高、风险回报不足等一律输出 **watch/skip + 完整计划参数**，不得省略策略计划；
- 匹配规则（t6）调用 §9 公式时只读现有 artifacts，任何“未来数据”都禁止进入公式（如用当日 close 前的数据计算手数）；
- 报告板块（t7/t9）渲染风险时至少包含：入场、止损价、手数、每手风险金额、保证金占用、失效条件、事件风险提示与免责；**不得出现任何收益数字或预期**；
- 免责口径与报告一致：“策略为分析工具输出，不构成投资建议，不执行真实交易”。

## 12. 证据来源清单

1. Van Tharp Institute — 1R 风险与仓位模型: https://vantharpinstitute.com/understanding-all-the-risks-in-a-trade-by-van-k-tharp-ph-d/
2. CME Group — The 2% Rule（交易与风险管理教育）: https://www.cmegroup.com/education/courses/trade-and-risk-management/the-2-percent-rule
3. Moreira & Muir (2017), Volatility-Managed Portfolios, Journal of Finance 72(4): https://onlinelibrary.wiley.com/doi/10.1111/jofi.12513
4. Moskowitz/Ooi/Pedersen 时间序列动量与波动率缩放（实践解读）: https://alphaarchitect.com/time-series-momentum-volatility-scaling-and-crisis-alpha/ ；原文: https://www.sciencedirect.com/science/article/abs/pii/S1386418116301379
5. 波动率目标机制: https://convextrade.com/glossary/vol-targeting ； https://algotradinglib.com/en/pedia/v/volatility_targeting.html
6. Chandelier Exit（ATR 移动止损）: https://chartschool.stockcharts.com/table-of-contents/technical-indicators-and-overlays/technical-overlays/chandelier-exit
7. 期货隔夜跳空与事件风险: https://openalgo.in/futures/gap-and-event-risk
8. 事件日程与仓位管理: https://supertrader.me/blog/economic-calendar-trading-guide/
9. 交易所涨跌停/保证金联动调整实例: https://www.egsea.com/news/detail/2331930.html
10. CTA 趋势与风险配置讨论: https://rpc.cfainstitute.org/blogs/enterprising-investor/2026/decoding-cta-allocations-by-trend-horizon
11. 组合分散与风险预算访谈（Molyboga, JPM）: https://openurl.ebsco.com/EPDB%3Agcd%3A6%3A35420454/detailv2
12. 分数 Kelly 与仓位上限（补充参考）: https://www.avatrade.com/education/technical-analysis-indicators-strategies/the-kelly-criterion

## 13. 边界与不承诺事项

1. **不承诺收益**：所有参数用于控制风险暴露与回撤，任何文献结论不得转述为收益承诺；
2. **不使用持仓分析、不新增数据源**：与 futures-radar 既有数据纪律一致；
3. **保证金/涨跌停/规则以交易所当日公告为准**：文中数值（8% 保证金、4%/5% 涨跌停）为示例口径；
4. **示例计算非建议**：§10 的 equity=10 万与手数推演仅演示公式行为，不构成对任何资金规模的交易建议；
5. 本框架为策略库的“风险层”，方向判断仍以报告原文为准，风险规则不得反向修改方向或置信度。
