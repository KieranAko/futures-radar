# 细分品类适用交易策略 — 研究笔记

> 角色: category-analyst（细分品类分析师） | 团队: futures-radar-strategy | 日期: 2026-08-27
> 任务: t2 — 调研按商品板块/品种属性适用的成熟策略（期限结构、季节性、产业驱动、价差等）

## 0. 文档约定

- 每条策略包含: `id`、名称、策略类别、**适用板块**、策略逻辑、**适用条件**（可量化）、**失效条件**、入场/退出规则概要、**报告字段映射**（报告 artifacts 中可直接读取的字段）、**证据来源**（URL）、成熟度、局限。
- 板块编码与 `futures-radar/config/symbols.json` 一致: `black`（黑色系）、`nonferrous`（有色金属）、`precious`（贵金属）、`energy_chemical`（能化）、`agriculture`（农产品）、`new_materials`（新材料）、`shipping`（航运）。
- 报告 artifacts 约定（以 `output/runs/20260827-1910-auto/` 为例，字段名可复用）:
  - `report-model.json`: `opportunities[].{symbol,sector,thesis.driver/trendOrImpulse/odds/confirmations/invalidations/risks,finalDirection,finalConfidence}`
  - `sector-snapshot.json`: `sectors[].{direction,ret1d,ret5d,ret20d,advanceRatio1d,advanceRatio5d,volumeRatio20d,leaders,laggards}`
  - `sector-driver.json`: 板块驱动文本（LLM 产出，仅板块上下文）
  - `macro-snapshot.json`: 宏观锚点 DXY/USDCNH/US10Y/DR007/SC0
- **数据纪律**: 不使用持仓（OI）数据（报告管线明示不采集 OI）；不使用报告未提供的数据（库存、利润、开工率、完整期限结构曲线等只能从驱动文本间接引用，不能作为量化输入）；不承诺收益；不做持仓分析。
- 策略均为“方向增强/执行参考”用途，服务于后续 strategy-matching-rules（t6）确定性匹配；报告结论仍是第一依据。

---

## 1. CS-01 期限结构/展期收益策略（Term Structure / Carry）

- **策略类别**: 期限结构
- **适用板块**: `energy_chemical`（原油系 contango/back 切换最活跃）、`nonferrous`（铜期限结构对宏观敏感）、`agriculture`（新旧作物切换）、`black`（螺纹近远月）；`precious`/`shipping` 展期信号弱，慎用。
- **策略逻辑**:
  - 期货展期收益（roll yield）来源于期限结构斜率: 近月升水（backwardation）时多头展期收益为正、空头为负；近月贴水（contango）时相反。
  - 期限结构信号对商品期货风险溢价有预测力: 按期限结构排序构建多空组合可捕获风险溢价（Szymanowska et al. 2014）；库存水平是期限结构背后的基本面来源（Gorton, Hayashi & Rouwenhorst 2007）。
- **适用条件**（可量化）:
  1. 期限结构处于历史极端分位（如近远月价差 ÷ 近月价格位于 90 日历史前 10%/后 10%），方向与报告 `finalDirection` 一致时作为增强；
  2. 报告驱动文本中出现“期限结构近端偏紧/近月升水”等字眼（如 2026-08-27 EG0/PX0 的 Q3 文本），可作为定性佐证；
  3. 主力合约展期日 > 20 个交易日（避免临近交割的展期拥挤）。
- **失效条件**:
  1. 期限结构斜率快速平坦化/翻转（价差回到历史中位区）；
  2. 库存拐点出现（驱动文本出现“累库开始/去库结束”）；
  3. 展期收益被短期波动覆盖（|价差| < 1×ATR5）。
- **入场/退出概要**: 入场——价差极端分位 + 报告方向一致 + 收盘价站上/跌破 MA20；退出——价差回归中位 50% 或报告 Q5 失效条件触发。
- **报告字段映射**: `thesis.odds.reasoning`（含期限结构描述文本）、`thesis.driver.primary/secondary`、`finalDirection`、`marketFacts.hv`、`priceRanges[].atrBand`。
- **证据来源**:
  - Szymanowska, De Roon, Nijman & Van Den Goorbergh (2014), “An Anatomy of Commodity Futures Risk Premia”, *Journal of Finance* — https://onlinelibrary.wiley.com/doi/abs/10.1111/jofi.12096
  - Gorton, Hayashi & Rouwenhorst (2007), “The Fundamentals of Commodity Futures Returns”, NBER WP 13249 — https://www.nber.org/papers/w13249
- **成熟度**: 高（学术研究 20 年+，指数化产品广泛使用）
- **局限**: 报告只提供主力连续价格，无完整远期曲线，期限结构只能从 Q3 文本定性提取；单腿展期收益幅度小，需长期持有；contango 下做空展期有逼仓风险。

---

## 2. CS-02 季节性策略（Seasonality）

- **策略类别**: 季节性
- **适用板块**: `agriculture`（种植/收获/消费旺季，如粕类水产旺季备货、油脂节日备货）、`energy_chemical`（成品油冬夏切换、下游纺织旺季）、`black`（“金三银四”“金九银十”开工季）、`nonferrous`（春节后补库季）；`shipping`（Q3 传统旺季运价脉冲）可作事件过滤器。
- **策略逻辑**:
  - 商品供需存在可重复的日历规律（天气、假期、开工、消费），历史同期价格行为存在统计上的季节性；原油系/农产品/牲畜类期货的季节性效应有实证研究记录。
- **适用条件**（可量化）:
  1. 当前日期落入该品种历史高胜率季节窗口（需 ≥5 年历史统计，胜率 >60% 才可引用）；
  2. 季节方向与报告 `finalDirection` 及板块 `direction` 一致（如 2026-08-27 农产品 ↑ 与菜粕水产旺季逻辑共振）；
  3. 板块 `advanceRatio1d ≥ 50%` 且与方向一致（共振确认）。
- **失效条件**:
  1. 当年供需结构被政策/天气改变（驱动文本出现“今年与往年不同”类表述）；
  2. 价格已提前透支季节预期（进入窗口前 20 日累计涨跌幅已超历史同期均值 +1σ）；
  3. 季节方向与报告方向相反 → 不引用季节因子。
- **入场/退出概要**: 入场——进入窗口 + 方向共振 + 收盘价位于 MA20 上方（多头）；退出——窗口结束或报告 Q5 失效触发。
- **报告字段映射**: `sector-snapshot.json sectors[].{direction,advanceRatio1d,ret5d}`、`thesis.driver.primary`（旺季/备货类文本）、`meta.signalDate`（判断日历窗口）。
- **证据来源**:
  - “Analysis of selected seasonality effects in markets of futures contracts…(crude oil, brent, heating oil, gas oil, natural gas, feeder/live cattle, lean hogs, lumber)” — http://yadda.icm.edu.pl/yadda/element/bwmeta1.element.ekon-element-000171476545
  - “How to time the commodities markets”, *Journal of Derivatives & Hedge Funds* (2010) — https://link.springer.com/article/10.1057/jdhf.2010.4
- **成熟度**: 中高（行业惯例，但单独使用胜率不足）
- **局限**: 样本年份有限、扰动多，只能作方向过滤/时点增强，不能单独构成交易依据；季节窗口边界需要按品种日历定义，报告当前无内置日历。

---

## 3. CS-03 产业利润/成本曲线驱动策略（Industry Margin & Cost-Curve）

- **策略类别**: 产业驱动（基本面）
- **适用板块**: `black`（钢厂利润→螺矿比、焦化利润→焦炭/焦煤比）、`energy_chemical`（油化工加工费、MTO/PDH 利润）、`new_materials`（碳酸锂/工业硅现金成本支撑）、`agriculture`（压榨利润、养殖利润）。
- **策略逻辑**:
  - 产业链利润压缩→开工率响应→库存与供需再平衡：利润极端处存在成本支撑/利润顶，价格围绕成本曲线与利润中枢运行；
  - 黑色系“螺矿比”走扩/收窄是钢厂利润的代理，机构常用作套利方向（国投期货螺矿比套利案例）；
  - 锂/硅等新品类在价格跌至现金成本区后减产（成本支撑），涨至高利润区后扩产（供应释放）。
- **适用条件**（可量化）:
  1. 驱动文本出现利润/成本类关键信号（“利润压缩至亏损”“贴水成本”“减产”“成本支撑”），且为 `thesis.driver.primary` 级别；
  2. 价格位于成本锚附近（报告可间接引用驱动文本中的成本数字）或产业利润位于极端区间；
  3. 报告 `finalDirection` 与产业逻辑同向（利润极低→易反弹；利润极高→供应回归→易回落）。
- **失效条件**:
  1. 成本锚本身移动（原料价格同步变动，如矿价跟随钢价下跌）；
  2. 政策限产/环保打断利润-开工传导链条；
  3. 利润极端状态长期持续（产能过剩期可长期亏损，成本支撑不即时生效）。
- **入场/退出概要**: 入场——成本/利润信号 + 量价确认（收盘突破 MA20）；退出——利润修复至中位或报告 Q5 触发。
- **报告字段映射**: `thesis.driver.{primary,secondary,evidence,source}`（产业文本）、`sector-driver.json`（板块级利润/成本线索）、`finalDirection`。
- **证据来源**:
  - 国投期货: 螺矿比预计走扩，建议套利操作 — https://www.hgwm.com/hyzx/show/id/1858.html （我的钢铁转载: https://m.mysteel.com/a/24111208/54BB613DC9D72D8B_abc.html ）
  - 证券时报: “一船货浮亏数千万元曾是常态！锂电企业如何破局？”（锂电成本/利润周期）— https://www.stcn.com/article/detail/4090000.html
- **成熟度**: 中高（黑色/能化产业研究体系成熟；新品类成本锚研究尚在演进）
- **局限**: 报告不含利润/开工/库存量化数据，只能从文本定性提取，无法精确计算利润分位；成本锚估算主观性强；利润极端≠立即反转（时机不确定）。

---

## 4. CS-04 跨品种价差/相对价值策略（Inter-Commodity Spread）

- **策略类别**: 价差（相对价值）
- **适用板块**: `black`（螺矿比、卷螺差、焦炭/焦煤比）、`agriculture`（油粕比、豆菜粕价差、玉米-淀粉）、`energy_chemical`（裂解价差 crack spread、PX/PTA/EG 与原油的相对强弱）、`nonferrous`+`precious`（铜锌比、金银比）。
- **策略逻辑**:
  - 两腿价差围绕产业均衡（替代关系、加工成本、宏观属性差异）均值回归，统计协整 + 产业逻辑双腿交易；Gatev et al. (2006) 对配对交易相对价值规则有系统实证；裂解价差是能化最经典价差，具有长记忆与结构突变特征。
- **适用条件**（可量化）:
  1. 价差偏离历史均值 >2σ（至少 120 日窗口），且产业逻辑支持回归（替代/成本关系未变）；
  2. 两腿均为报告品种池内活跃品种（`config/symbols.json active=true`）；
  3. 报告对两腿的相对强弱描述一致（如“原油重挫带动化工跟跌”支持做空化工/做多原油的相对价值）。
- **失效条件**:
  1. 价差中枢迁移（政策、工艺、供给格局改变，如澳矿供给变化改变螺矿比中枢）；
  2. 单腿逼仓/流动性缺失；
  3. 价差继续走扩且超过历史极值（结构破裂，不接飞刀）。
- **入场/退出概要**: 入场——价差 >2σ + 逻辑支持；退出——价差回归均值 ±0.5σ 或任一腿报告 Q5 触发。
- **报告字段映射**: `thesis.driver.primary`（板块共振/替代逻辑文本）、`sector-snapshot.json sectors[].{leaders,laggards}`（强弱对比）、`top10`（两腿相对动量）。
- **证据来源**:
  - Gatev, Goetzmann & Rouwenhorst (2006), “Pairs Trading: Performance of a Relative-Value Arbitrage Rule”, *Review of Financial Studies* 19(3) — https://academic.oup.com/rfs/article-abstract/19/3/797/1646694
  - Crack Spread Backtest: Heating Oil vs Crude Oil (Fractiz) — https://www.fractiz.com/strategies/cl-ho-crack-spread/
  - “What can we learn from the history of gasoline crack spreads? Long memory, structural breaks and modeling implications”, *Economic Modelling* — https://www.sciencedirect.com/science/article/abs/pii/S0264999311002586
  - 国投期货螺矿比套利（同上 CS-03 链接）
- **成熟度**: 高（配对交易与裂解价差均为成熟范式）
- **局限**: 需双倍保证金与双腿同步执行；报告只输出单品种分析，价差需自行构建且无内置历史价差数据；中枢迁移是最主要风险。

---

## 5. CS-05 库存周期/基差回归策略（Inventory Cycle & Basis Mean Reversion）

- **策略类别**: 产业驱动（库存周期）
- **适用板块**: `nonferrous`（交易所库存透明）、`black`（社会库存）、`energy_chemical`（港口/厂库）、`agriculture`（结转库存）。
- **策略逻辑**:
  - 库存水平是期限结构与价格行为的根本驱动（convenience yield 理论）：低库存 + 近月升水 → 价格易涨难跌、反弹弹性大；高库存 + contango → 上方受限；
  - 现货-期货基差（现货升水）极端后存在均值回归。
- **适用条件**（可量化）:
  1. 驱动文本出现库存极端表述（“库存低位”“去库至历史低位”“累库”）；
  2. 库存方向与报告 `finalDirection` 一致（低库存→看多增强，高库存→看空增强）；
  3. 板块 `volumeRatio20d > 1` 佐证产业活跃度。
- **失效条件**:
  1. 库存拐点确认（驱动文本出现“开始累库/去库结束”）；
  2. 需求崩塌（低库存也可能随需求崩盘，挤仓后大跌）；
  3. 库存数据源滞后（周度数据晚于价格变化，信号已失效）。
- **入场/退出概要**: 入场——库存极端 + 方向一致 + 价格结构确认（MA20 同侧）；退出——库存拐点或报告 Q5 触发。
- **报告字段映射**: `thesis.driver.{primary,evidence}`（库存类文本）、`thesis.odds.reasoning`（含“近端偏紧”类表述）、`sector-driver.json`。
- **证据来源**:
  - Gorton, Hayashi & Rouwenhorst (2007), “The Fundamentals of Commodity Futures Returns”, NBER WP 13249 — https://www.nber.org/papers/w13249
  - Szymanowska et al. (2014), *Journal of Finance*（期限结构信号，库存的映射）— https://onlinelibrary.wiley.com/doi/abs/10.1111/jofi.12096
- **成熟度**: 中高（库存周期是有色/黑色研究标配）
- **局限**: 报告不含库存数据，只能从驱动文本间接提取，无法量化分位；库存低位“易涨难跌”是概率性表述，不是必然；库存数据发布滞后带来信号延迟。

---

## 6. CS-06 供给冲击事件后确认跟随（Supply-Shock Event Follow-Through）

- **策略类别**: 事件驱动（产业/地缘）
- **适用板块**: `agriculture`（天气、物流、政策——如黑海粮道扰动）、`energy_chemical`（装置检修、OPEC、管道）、`nonferrous`（矿端扰动）、`shipping`（运河/拥堵/航线谈判）、`black`（安检、限产）、`new_materials`（减产、环保）。
- **策略逻辑**:
  - 供给冲击改变短期供需平衡，价格对持续性供给扰动反应具有延续性；不同性质的价格冲击对市场影响路径不同（Kilian 2009），只有“持续供给约束”类冲击值得跟随；
  - 本策略与报告 Q1（驱动）+ Q4（确认信号）+ Q5（失效条件）框架完全同构：事件 → 量价确认 → 跟随，驱动反转 → 退出。
- **适用条件**（可量化）:
  1. `thesis.driver.primary` 为供给冲击类事件，且证据文本明确“供应受限/不可一日逆转”；
  2. 价格完成确认：收盘突破报告 Q4 确认水平（如 RM0 站稳 2314、EG0 跌破 5000）且量能达标；
  3. 板块方向一致（`sectors[].direction` 同向且 `advanceRatio1d ≥ 50%`）。
- **失效条件**:
  1. 供给恢复消息（报告 Q5 类条件：“粮道恢复通行”“装置重启”）；
  2. 价格收回关键位（收盘收回 MA20）；
  3. 事件被证伪（信息源纠错）。
- **入场/退出概要**: 入场——事件 + Q4 确认触发；退出——Q5 任一条件触发，不预测事件本身。
- **报告字段映射**: `thesis.driver.{primary,evidence,source}`、`thesis.confirmations.signals[]`、`thesis.invalidations.conditions[]`、`screening.{driver,priceStructure}`。
- **证据来源**:
  - Kilian (2009), “Not All Oil Price Shocks Are Alike: Disentangling Demand and Supply Shocks in the Crude Oil Market”, *American Economic Review* 99(3) — https://www.aeaweb.org/articles?id=10.1257/aer.99.3.1053
  - 报告运行 20260827-1910-auto 中 RM0（黑海粮道扰动）为该方法的应用样例 — `futures-radar/output/runs/20260827-1910-auto/report.md`
- **成熟度**: 中高（报告管线本身即按此框架运行，成熟可靠）
- **局限**: 事件反复（地缘谈判）导致假突破频发；确认入场意味着放弃部分初始涨幅；事件信息更新快，报告为日频，存在隔夜风险。

---

## 7. CS-07 贵金属实际利率/趋势跟随策略（Precious Real-Rate Trend）

- **策略类别**: 宏观映射 + 趋势（贵金属专项）
- **适用板块**: `precious`（AU0/AG0），辅助 `nonferrous`（铜的增长属性类比）。
- **策略逻辑**:
  - 金价长期与实际利率、美元负相关：实际利率下行/美元走弱 → 持有成本下降 → 金价趋势上行；金银比极端偏离后均值回归；
  - 贵金属趋势性强，适合趋势跟随（MA 结构 + 宏观锚点双重确认）。
- **适用条件**（可量化）:
  1. 报告宏观锚点方向一致：`macro-snapshot.json` 中 US10Y 下行 或 DXY 下行（金价多头增强），反之减弱；
  2. 收盘价位于 MA20/MA60 上方且 5 日收益为正（趋势结构）；
  3. 金银比位于 90 日历史极端分位（>90% 或 <10%）→ 可作相对价值脚注。
- **失效条件**:
  1. 实际利率方向反转（US10Y 持续上行 + DXY 走强）；
  2. 金价收盘跌破 MA20 且连续 2 日不收回；
  3. 避险溢价消退（地缘缓和，金价与利率关系恢复）。
- **入场/退出概要**: 入场——宏观锚点 + MA 结构共振；退出——宏观锚点反转或跌破 MA20。
- **报告字段映射**: `macro-snapshot.json indicators.{DXY,US10Y}`、`marketFacts.close` 与 MA20/MA60（`screening.priceStructure`、`thesis.trendOrImpulse.assessment`）。
- **证据来源**:
  - Erb & Harvey, “Is There Still a Golden Dilemma?” — https://nftrh.com/wp-content/uploads/2024/05/harvey-erb.pdf
  - “Gold's Role Reconsidered: What Drives Its Value And Returns?” (FA Magazine 综述) — https://www.fa-mag.com/news/gold-s-role-reconsidered--what-drives-its-value-and-returns-84410.html
- **成熟度**: 高（实际利率-金价框架为行业共识）
- **局限**: 贵金属板块成员少（报告常出现“成员不足，不判定”），板块共振信号弱；避险情绪短期扰动可主导价格、脱离利率框架；趋势跟随止损带宽（贵金属波动大）。

---

## 8. CS-08 航运运价脉冲/均值回归策略（Freight Impulse & Mean Reversion）

- **策略类别**: 事件驱动 + 波动率（航运专项）
- **适用板块**: `shipping`（EC0 集运指数欧线）
- **策略逻辑**:
  - 运价呈脉冲式上涨（运河/拥堵/旺季/航线谈判）后长期均值回归，波动率极高（报告明示 HV 可达 200–400%）；
  - 事件驱动上行段用确认跟随（同 CS-06），极端高位回落确认后做均值回归；仓位必须按极高波动率收缩（见 risk-framework 波动率目标）。
- **适用条件**（可量化）:
  1. 事件驱动 + 放量突破（报告 Q4 确认）→ 跟随多头；
  2. 或运价位于 90 日历史极高分位（从 `priceRanges[].hvCone`/ATR 通道外沿可识别）且收盘连续 2 日回落 → 均值回归空头候选；
  3. 仅当日频、单品种、单方向操作，禁止隔夜重仓（波动率约束）。
- **失效条件**:
  1. 事件升级持续推涨（运河/航线谈判恶化）→ 空头逻辑失效；
  2. 现货升水大幅扩大（期货折价加深，做空贴水风险）；
  3. 波动率收缩后重新放大（HV 分位回到 <50% 后再度抬升）。
- **入场/退出概要**: 入场——Q4 确认或极端分位回落确认；退出——事件反转或 HV 分位回归中位。
- **报告字段映射**: `marketFacts.hv.{annual,percentile90d}`、`thesis.driver.primary`、`thesis.confirmations.signals[]`、`screening.volatility`。
- **证据来源**:
  - 南华期货: 集装箱产业风险管理日报 — https://mall.nanhua.net/mall/nh/api/report/getReportFile?reportId=60353
  - “临时航线谈判进展顺利 集运指数期货显著回调”（EC 事件-回落案例）— https://www.sohu.com/a/1067801698_122014422
- **成熟度**: 中（品种上市时间短，事件-回归范式成熟但历史样本有限）
- **局限**: 波动极大、跳空频繁、止损执行难；单品种板块无共振可依；保证金高；样本历史短，统计分位可信度低。

---

## 9. 汇总矩阵

| ID | 策略 | 类别 | 适用板块 | 报告可用输入 | 主要失效条件 | 成熟度 |
|----|------|------|----------|--------------|--------------|--------|
| CS-01 | 期限结构/展期收益 | 期限结构 | 能化/有色/农产品/黑色 | Q3 文本（期限结构描述）、HV/ATR | 曲线平坦化、库存拐点 | 高 |
| CS-02 | 季节性 | 季节性 | 农产品/能化/黑色/有色 | signalDate、板块方向/广度、驱动文本 | 当年结构改变、预期透支 | 中高 |
| CS-03 | 产业利润/成本曲线 | 产业驱动 | 黑色/能化/新材料/农产品 | Q1 驱动文本、sector-driver | 成本锚移动、政策打断传导 | 中高 |
| CS-04 | 跨品种价差 | 价差 | 黑色/农产品/能化/有色-贵金属 | 板块 leaders/laggards、驱动文本 | 价差中枢迁移、单腿逼仓 | 高 |
| CS-05 | 库存周期/基差回归 | 产业驱动 | 有色/黑色/能化/农产品 | Q1/Q3 库存文本 | 库存拐点、需求崩塌 | 中高 |
| CS-06 | 供给冲击确认跟随 | 事件驱动 | 农产品/能化/有色/航运/黑色/新材料 | Q1+Q4+Q5 全框架 | 供给恢复、收回关键位 | 中高 |
| CS-07 | 贵金属实际利率趋势 | 宏观映射 | 贵金属(辅助有色) | 宏观锚点 DXY/US10Y、MA 结构 | 利率反转、避险消退 | 高 |
| CS-08 | 航运脉冲/均值回归 | 事件+波动率 | 航运 | HV 分位、Q4 确认、ATR | 事件升级、现货升水扩大 | 中 |

## 10. 对下游匹配（t6）的关键提示

1. **CS-06 与报告框架同构**，是最易确定性匹配的策略：`thesis.driver.primary` 含供给冲击关键词 + `confirmations.signals[]` 非空 → 直接命中；失效条件即 `invalidations.conditions[]`。
2. **CS-02 需要日历表**：若匹配规则要启用季节性，需要内置品种-月份映射表（如 粕类 5–9 月水产旺季、黑色 3–4/9–10 月开工季）；没有日历表时应禁用。
3. **CS-01/CS-03/CS-05 只能定性匹配**：报告没有期限结构曲线、库存、利润的量化数据，只能对 Q1/Q3 文本做关键词规则，规则需显式声明“定性证据、低权重”。
4. **CS-08 仅适用于 shipping 板块**，且必须与波动率收缩规则（risk-framework）绑定，否则不建议启用。
5. 所有策略的失效条件都必须并入 report `invalidations.conditions[]`，不得新增报告之外的失效依据。

## 11. 来源清单（全部可溯源）

- Szymanowska et al. (2014), An Anatomy of Commodity Futures Risk Premia, J. Finance — https://onlinelibrary.wiley.com/doi/abs/10.1111/jofi.12096
- Gorton, Hayashi & Rouwenhorst (2007), The Fundamentals of Commodity Futures Returns, NBER WP 13249 — https://www.nber.org/papers/w13249
- Gatev, Goetzmann & Rouwenhorst (2006), Pairs Trading, RFS 19(3) — https://academic.oup.com/rfs/article-abstract/19/3/797/1646694
- Kilian (2009), Not All Oil Price Shocks Are Alike, AER 99(3) — https://www.aeaweb.org/articles?id=10.1257/aer.99.3.1053
- Erb & Harvey, Is There Still a Golden Dilemma? — https://nftrh.com/wp-content/uploads/2024/05/harvey-erb.pdf
- FA Magazine, Gold's Role Reconsidered — https://www.fa-mag.com/news/gold-s-role-reconsidered--what-drives-its-value-and-returns-84410.html
- Seasonality effects in futures contracts (crude/brent/heating oil/gas oil/nat gas/livestock/lumber) — http://yadda.icm.edu.pl/yadda/element/bwmeta1.element.ekon-element-000171476545
- How to time the commodities markets, J. Derivatives & Hedge Funds (2010) — https://link.springer.com/article/10.1057/jdhf.2010.4
- Gasoline crack spreads: long memory, structural breaks (Economic Modelling) — https://www.sciencedirect.com/science/article/abs/pii/S0264999311002586
- Crack Spread Backtest: HO vs CL (Fractiz) — https://www.fractiz.com/strategies/cl-ho-crack-spread/
- 国投期货: 螺矿比预计走扩 — https://www.hgwm.com/hyzx/show/id/1858.html / https://m.mysteel.com/a/24111208/54BB613DC9D72D8B_abc.html
- 证券时报: 锂电企业成本与浮亏 — https://www.stcn.com/article/detail/4090000.html
- 南华期货: 集装箱产业风险管理日报 — https://mall.nanhua.net/mall/nh/api/report/getReportFile?reportId=60353
- 搜狐财经: 临时航线谈判进展顺利 集运指数期货显著回调 — https://www.sohu.com/a/1067801698_122014422
