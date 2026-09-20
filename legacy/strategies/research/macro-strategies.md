# 宏观 / Regime 级成熟交易策略研究笔记

> 作者：macro-strategist（宏观策略分析师）· 调研日期：2026-08-27
> 范围：仅宏观 / regime 级成熟交易策略（趋势跟踪、风险偏好 regime、宏观 carry、波动率目标、增长-通胀象限、宏观事件驱动、板块轮动）。
> 细分品类策略（期限结构/季节性/价差）见 `category-strategies.md`；执行层 playbook 见 `execution-playbooks.md`；风控框架见 `risk-framework.md`。
>
> **证据纪律**：每条策略均标注公开可查的证据来源 URL；本文只转述已发表文献的定性结论，**不编造任何回测收益数字**，不使用报告 artifacts 之外的数据。所有策略与 futures-radar 现行数据纪律一致：不使用持仓分析（板块级指标只基于价格/成交量）、不构成投资建议。

---

## 0. 与 futures-radar 报告 artifacts 的映射约定（供 strategy-matcher 使用）

本文所有策略的"机器可判定条件"只引用以下已存在字段，不新增数据源、不新增 LLM 判断：

| 来源 artifact | 可用字段 | 策略中的用途 |
|---------------|----------|--------------|
| `report-model.json` → `opportunities[]` | `thesis.driver.primary`（驱动类型）、`thesis.trend`、`thesis.odds`、`thesis.confirm`、`thesis.invalidation`、`thesis.risk` | regime 判定、入场/失效条件 |
| `report-model.json` → `opportunities[].marketFacts.hv` | `annual`（20 日 Yang-Zhang 年化 HV）、`percentile90d`、`estimator`、`degraded` | 波动率目标仓位、regime 波动过滤 |
| `report-model.json` → `opportunities[].priceRanges[]` | `hvCone.p68/p95`、`atrBand.atr5/band`、`divergence.pct/interpretation` | 入场区间、止损距离、模型稳定性门禁 |
| `report-model.json` → `screening` | `initialDirection`、`initialConfidence`、`criteria.*` | 方向/置信先验 |
| `macro-snapshot.json`/`report-model.json` → `macro.indicators` | `DXY/USDCNH/US10Y/DR007/SC0` 的 `value/change5d/status` | 风险偏好 regime 与增长-通胀象限 |
| `sector-driver.json` → `sectors[]` | 板块 `direction`、`breadth`（上涨广度）、驱动置信度 | 板块轮动与广度确认 |
| `probability.json` → `probabilities[]` | `atr5`、`hv`、`volPercentile`、`volMultiplier` | 波动率目标、趋势过滤 |

---

## 1. 时间序列动量 / 趋势跟踪（TS-MOM）

- **id**: `macro-ts-mom`
- **类别**: 趋势跟踪（trend following / time-series momentum）

### 定义
对单一资产，以过去一段窗口（常用 12 个月，跳过最近 1 个月，即 "12-1"）的自身超额收益符号为方向信号，仓位按目标波动率的倒数缩放（波动率越大的资产仓位越小），多头与空头对称。简化变体：价格高于/低于 10 个月（或 200 日）均线做多/做空（Faber 2007 战术资产配置规则）。在期货语境下即 CTA 趋势策略。

### 适用市场状态
- 持续性趋势 regime：宏观供需失衡、政策转向、供给冲击等导致价格连续同向移动时表现最好（文献称之为"危机 alpha"——在股灾/危机期间趋势策略常为正收益且与股票低相关）。
- 不适用：窄幅震荡、均值回归主导的 regime（信号频繁反转，交易成本侵蚀收益）。

### 入场规则
- 宏观锚点版本（Faber 规则）：价格月收盘上穿 10 个月均线 → 做多；下穿 → 做空/离场。
- futures-radar 确定性映射：`screening.initialDirection` 与 `trend`（vsMA20、vsMA60）同号，且 `change5d` 与方向一致 → 视为趋势对齐；入场区建议在 `priceRanges` 的 ATR 带内侧（不追 2×ATR 外）。
- 入场时机细化属于执行层（见 `execution-playbooks.md` 的回踩/突破 playbook），宏观层只定 regime 与方向。

### 退出规则
- 方向信号反转（价格回到均线另一侧）即平仓；futures-radar 映射：`thesis.invalidation`（Q5）中任一条件被收盘触发 → 退出，例如"收盘跌破 MA20 且放量"。
- 或波动率目标机制强制减仓（见第 4 条 VOL-TARGET）。

### 风险规则
- 单标的仓位 = volTarget / HV（年化），volTarget 建议 10%–20%（与第 4 条共用）。
- 单笔止损不超过账户 1%（详见 `risk-framework.md`）；ATR5 停损：以 `atrBand.atr5` 的 1–3 倍设初始止损。
- 分散于 ≥5 个低相关品种，避免单板块集中。

### 适用品种类型
全部 59 个扫描品种均可适用（趋势策略对品种无结构偏好）；历史证据显示金属、能源、农产品、汇率、利率期货上时间序列动量均显著存在。对高波动品种（如 EC0 集运 HV 可达 200%+）必须配合波动率缩放，否则单品种风险过大。

### 失效条件
- regime 切换为震荡（HV 高但无趋势、MA 频繁穿越）；`divergence.pct > 20%`（波动率模型不稳定）时趋势过滤信号可靠性下降，需降级处理。
- 政策干预性市场（如强平仓、临时交易限制）中动量信号失真。

### 成熟度与局限
- 成熟度：**极高**。时间序列动量是学术界与 CTA 行业研究最充分的策略家族，证据横跨 100+ 年、58 个期货/远期市场（Hurst-Ooi-Pedersen 2017），中国商品期货亦有独立证据（见来源）。
- 局限：参数敏感（回看窗口、波动率估计器，见 Baltas 2020）；横盘期连续小亏（典型负偏态"割草机"收益形态）；拥挤交易在极端时刻可能踩踏。文献结论只保证"长期历史样本中的显著性"，不保证任何未来区间收益。

### 证据来源
- Moskowitz, Ooi, Pedersen (2012), "Time Series Momentum", *Journal of Financial Economics* 104(2): 228–250 — https://research.cbs.dk/da/publications/time-series-momentum/
- Hurst, Ooi, Pedersen (2017), "A Century of Evidence on Trend-Following Investing", *Journal of Portfolio Management*（SSRN 版）— https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2993026
- Faber (2007), "A Quantitative Approach to Tactical Asset Allocation"（10 月均线规则）— https://papers.ssrn.com/sol3/papers.cfm?abstract_id=962461
- Baltas (2020), "Demystifying Time-Series Momentum Strategies"（波动率估计器与交易规则敏感性）— https://onlinelibrary.wiley.com/doi/10.1002/9781119599364.ch3
- 中国商品期货证据：Liu & Jiao, "Risk-Weighted Time-Series Momentum: New Evidence from China's Commodity Futures" — https://www.semanticscholar.org/paper/22b4708b17bc5e775d4457bd716bf34c5a51ea04 ；"Revisiting time series momentum in China's commodity futures market", *Economic Modelling* 128 (2023) — https://econpapers.repec.org/article/eeeecmode/v_3a128_3ay_3a2023_3ai_3ac_3as0264999323003346.htm
- 危机 alpha 讨论："The crisis alpha of managed futures: Myth or reality?" — https://www.sciencedirect.com/science/article/abs/pii/S1057521922000242

---

## 2. 风险偏好 regime 轮动（Risk-On / Risk-Off）

- **id**: `macro-risk-regime`
- **类别**: regime 切换（risk appetite switching）

### 定义
把市场状态二分为风险偏好（risk-on）与风险规避（risk-off）两种 regime，用一组宏观风险指标（美元指数、长债收益率、波动率指数 VIX 类、信用利差）定义切换信号；risk-on 做多风险资产（顺周期商品、工业金属），risk-off 降风险资产仓位或做空。理论基础：下行贝塔（downside beta）比传统 beta 对收益差异解释更强（Ang-Chen-Xing 2006），VIX 是公认的"投资者恐惧计"（Whaley 2000），regime 切换模型能显著改善动态策略（Kritzman 等 2012）。

### 适用市场状态
- 适用于 regime 具有持续性的阶段（宏观状态平均持续数月），也适用于危机初期快速降险。
- 不适用：宏观指标本身剧烈震荡、无清晰趋势的"消息市"。

### 入场规则
futures-radar 确定性映射（只使用已有宏观锚点，均为日频值）：
- risk-on 评分 = Σ 以下信号（各 +1）：
  1. `DXY.change5d < 0`（美元走弱，全球风险偏好扩张）
  2. `US10Y.change5d < +0.20` 百分点（无急升式紧缩冲击；数值按 macro-snapshot 值计算）
  3. `USDCNH.change5d < 0`（人民币走强，中国风险资产受益）
  4. `DR007` 低位且 `change5d < +0.5` 百分点（国内流动性宽松）
  5. `SC0.change5d > -1%`（油价未崩塌，无供给端恐慌）
- risk-off 评分 = 相反条件之和。
- 入场门禁：risk-on 评分 ≥ 3 时允许做多顺周期品种（有色/黑色/能化/农产品中的多头候选）；risk-off 评分 ≥ 3 时只允许做空候选或空仓。评分 1–2 为中性，按品种自身 Q1–Q6 逻辑交易但仓位减半。
- 板块共振确认：`sector-driver.json` 中该品种所属板块 direction 与候选方向一致且 breadth ≥ 50% 时，regime 信号才被采信。

### 退出规则
- regime 评分反向达到 ≥3 时，regime 驱动的仓位全部退出。
- 单一锚点极端变化（如 `US10Y.change5d ≥ +0.25` 或 `DXY.change5d ≥ +1%`）触发该 regime 仓位的提前降仓。

### 风险规则
- regime 中性期（评分 1–2）强制半仓；regime 不利期（评分 0 或反向）禁止新开仓。
- 与品种自身 Q5 失效条件叠加：任一触发即退出（regime 条件与品种条件是 AND 关系，见 risk-framework.md）。

### 适用品种类型
- risk-on：工业属性强、顺周期的品种（有色、黑色、能化中的需求侧品种、航运 EC0）。
- risk-off：宏观空头候选（如原油成本塌陷联动下的能化空头）、或贵金属等避险属性品种的防御性表达（贵金属方向受真实利率主导，需结合 US10Y 单独判断，不作为本文规则）。

### 失效条件
- 宏观锚点与商品的相关性在样本外漂移（相关性本身不稳定是已知问题）；DXY/US10Y 出现"无趋势高波动"时 regime 评分反复横跳 → 连续 3 个交易日评分在 2–3 间摆动则停用本策略。

### 成熟度与局限
- 成熟度：**高**（学术基础扎实，但直接可交易的公开规则少，参数化依赖从业者实践）。
- 局限：regime 识别天然滞后（需 change5d 确认）；宏观锚点中 USDCNH/US10Y 在本管道可能 stale（asOf 落后一日，报告已标），规则必须容忍 1 日滞后；regime 信号对商品期货是"背景过滤器"而非独立开仓信号，必须与品种自身驱动（Q1）叠加。

### 证据来源
- Ang, Chen, Xing (2006), "Downside Risk", *Review of Financial Studies* 19(4) — https://www.nber.org/papers/w11824 与 https://academic.oup.com/rfs/article-abstract/19/4/1191/1580531
- Whaley (2000), "The Investor Fear Gauge"（VIX 作为风险偏好指标）— https://www.mendeley.com/catalogue/c6699227-6680-3a5d-9620-59502892bd29/
- Kritzman, Page, Turkington (2012), "Regime Shifts: Implications for Dynamic Strategies", *Financial Analysts Journal* 68(3) — https://www.tandfonline.com/doi/abs/10.2469/faj.v68.n3.3

---

## 3. 宏观利差 / Carry（跨资产与商品期限结构）

- **id**: `macro-carry`
- **类别**: 利差收益（carry）

### 定义
做多"持有收益"高的资产、做空持有收益低的资产。跨资产版：货币/债券/股票/商品的 carry 因子存在统一的可预测性（Koijen 等 2018）。商品版：carry ≈ 展期收益，来自期限结构（backwardation 正 carry，contango 负 carry）；商品期货的风险溢价与期限结构高度相关（Gorton-Rouwenhorst 2006；Szymanowska 等 2014；Erb-Harvey 2006）。

### 适用市场状态
- 适用于宏观平稳、无突发供给冲击的 regime（此时期限结构信号稳定）。
- 不适用：供给冲击期（backwardation 由短缺恐慌而非风险溢价驱动，carry 信号失真——正是本文 RM0/EG0 场景中的已知局限）。

### 入场规则
- 商品版确定性映射：需要每个品种的连续合约期限结构（近月/次月价差）。**当前 futures-radar artifacts 没有全品种期限结构序列**，只有 Top3 深挖的 Q3 中定性引用（如 EG0"多头证据来自期限结构近端偏紧"）。
  - 因此本策略在本版管道中**只能作为 Q3 证据标签**使用：`thesis.odds` 文本中出现期限结构支撑/压制 → 视为 carry 方向证据（正/负），计入策略匹配权重，不独立生成开仓信号。
  - 若要升级为独立信号，需要给 collector 增加期限结构采集（属于后续版本工作，不在本次任务范围）。
- 跨资产版映射：US10Y 相对 DR007 的利差方向、USDCNH 的升贬值方向可作为宏观 carry 背景（美元高息/人民币宽松的组合历史上对应套息方向），但本管道不交易货币对，只作为商品 regime 背景。

### 退出规则
- 以 carry 为辅助证据的仓位：品种 Q5 失效条件触发即退出；carry 证据本身无独立退出规则（因为只是标签）。

### 风险规则
- carry 策略的尾部风险（crash risk）由 regime 过滤器（第 2 条）控制：risk-off 评分 ≥3 时禁止开 carry 方向仓位。

### 适用品种类型
- 期限结构信息量大的板块：能化（油系、化工近端结构）、农产品（季节性近月紧张）、有色（库存周期结构）。航运 EC0 无传统期限结构（运费指数现货/远期），不适用。

### 失效条件
- 供给冲击引发期限结构急变（backwardation 暴涨后常伴随均值回归）；宏观紧缩导致风险溢价整体重定价。

### 成熟度与局限
- 成熟度：**高**（学术证据丰富，商品 carry 是 CTA 两大经典因子之一——另两个是动量和价值）。
- 局限：**本管道数据不完整**，只能做标签；carry 危机期回撤极深，必须与 regime 过滤叠加。

### 证据来源
- Koijen, Moskowitz, Pedersen, Vrugt (2018), "Carry", *Journal of Financial Economics* 127(2): 197–225 — https://econpapers.repec.org/article/eeejfinec/v_3a127_3ay_3a2018_3ai_3a2_3ap_3a197-225.htm
- Gorton & Rouwenhorst (2006), "Facts and Fantasies about Commodity Futures", *Financial Analysts Journal* 62(2) — https://www.tandfonline.com/doi/abs/10.2469/faj.v62.n2.4083
- Szymanowska, de Roon, Nijman, van den Goorbergh (2014), "An Anatomy of Commodity Futures Risk Premia", *Journal of Finance* 69(1) — https://onlinelibrary.wiley.com/doi/10.1111/jofi.12096
- Erb & Harvey (2006), "The Strategic and Tactical Value of Commodity Futures", *Financial Analysts Journal* 62(2) — https://www.tandfonline.com/doi/10.2469/faj.v62.n2.4084

---

## 4. 波动率目标 / 波动率管理（VOL-TARGET）

- **id**: `macro-vol-target`
- **类别**: 仓位管理 overlay（不独立产生方向）

### 定义
把组合总风险锚定在固定年化波动率目标上：仓位比例 = volTarget / 已实现波动率。已实现波动率升高 → 自动减仓；降低 → 自动加仓（设上限）。Moreira-Muir (2017) 证明按已实现方差倒数缩放敞口能显著改善多类因子的风险调整后表现；CTA 行业普遍以波动率目标作为标准仓位机制。

### 适用市场状态
- 所有 regime 通用（这是 overlay）。在 HV 快速抬升期（危机）自动降风险，在低波动期恢复敞口。

### 入场规则（仓位缩放，确定性）
futures-radar 映射（全部字段已存在）：
- `hv = marketFacts.hv.annual`（20 日 Yang-Zhang 年化）。
- 目标波动率 `volTarget` 默认 **15% 年化**（可在 strategy-library.json 的 risk 字段配置为 10%–20%）。
- 仓位比例 `scale = clamp(volTarget / max(hv, 0.05), 0.2, 1.0)`。
- 模型稳定性门禁：`priceRanges[0].divergence.pct`（HV 锥 vs ATR 带）
  - `< 10%`：波动率模型稳定，直接用 scale；
  - `10%–20%`：scale 再乘 0.75 折扣（波动结构可能变化）；
  - `> 20%`：scale 乘 0.5，且止损改按 `atrBand.atr5` 计算（HV 锥失效）。
- `hv.degraded == true`（OHLC 修正率超限）时同上按 ATR 口径。
- 示例（仅演示公式，用 20260827-1910-auto 已冻结值）：RM0 hv=14.9% → scale≈1.0；EG0 hv=46.1% → scale≈0.33；PX0 hv=29.2% → scale≈0.51（volTarget=15%）。这些是确定性计算演示，**不是收益预测**。

### 退出规则
- 无方向性退出；当 scale 因 HV 上升跌破 0.2 下限时，等价于"波动过大禁止新仓"门禁（此时只允许持有既有仓并收紧止损）。

### 风险规则
- scale 上限 1.0（禁止加杠杆放大），下限 0.2；单品种名义仓位上限由 risk-framework.md 的保证金/集中度约束另行控制。
- HV 分位数辅助：`volPercentile ≥ 95` 时强制 scale ≤ 0.5（历史波动极端区）。

### 适用品种类型
所有品种；对 EC0 类超高波动品种（HV 200%+）尤其必要。

### 失效条件
- 波动率跳跃（跳空）使日频缩放滞后——隔夜跳空风险由 Q6 已有提示覆盖，本策略无法消除，只能缩小敞口。

### 成熟度与局限
- 成熟度：**高**（学术 + 全行业实践）。
- 局限：波动率聚集导致缩放滞后于跳变；volTarget 是主观参数；长期低波动环境会持续满仓，风险并非恒定。

### 证据来源
- Moreira & Muir (2017), "Volatility-Managed Portfolios", *Journal of Finance* 72(4) — https://onlinelibrary.wiley.com/doi/10.1111/jofi.12513

---

## 5. 增长-通胀象限 regime 配置（All-Weather / 投资时钟）

- **id**: `macro-quadrant`
- **类别**: 宏观状态配置（business cycle）

### 定义
把宏观状态映射到"增长 ↑/↓ × 通胀 ↑/↓"四个象限，每个象限对应占优资产类别（Bridgewater All-Weather 框架）；Merrill Lynch 投资时钟在此基础上叠加信贷周期，给出不同经济阶段（衰退→复苏→过热→滞胀）的板块轮动顺序。Kritzman 等 (2012) 证明 regime 识别对动态策略有显著价值。

### 适用市场状态
- 适用于增长/通胀出现明确共同趋势的阶段（如再通胀、紧缩、衰退预期）；象限内切换频率低（月度级别）。

### 入场规则
futures-radar 确定性映射（用已有锚点的 5 日变化方向做低频代理，仅为日内执行提供背景，不等于严格象限分类）：
- 增长代理 = `US10Y.change5d` 方向 + `DR007` 水平：收益率上行且资金利率低 → 增长预期 ↑。
- 通胀代理 = `SC0.change5d` 方向（原油为主）+ 农产品板块 direction（食品通胀传导）。
- 组合规则（AND 匹配）：
  - **再通胀象限**（增长↑ 且 通胀↑）：偏好顺周期多头（有色、黑色、能化、农产品多头候选）——RM0 菜粕（农产品 5d 板块上行 + SC0 走弱但粮价逻辑独立）落在此象限边缘。
  - **滞胀象限**（增长↓ 且 通胀↑）：偏好供给受限品种的多头（农产品/能源），回避需求侧化工空头追单之外的新仓。
  - **通缩/衰退象限**（增长↓ 且 通胀↓）：宏观空头占优（如 EG0/PX0 的原油成本塌陷空头），多头候选全部降级。
  - **复苏象限**（增长↑ 且 通胀↓）：中性，按品种自身 Q1 交易。
- 门禁：象限信号仅在对应锚点 `status == "fresh"` 时参与计算；stale 锚点（如 USDCNH/US10Y）按中性 0 处理并在 rationale 中标出。

### 退出规则
- 象限切换即减仓原象限偏好仓位；品种自身 Q5 触发无条件退出。

### 风险规则
- 象限判定为代理指标近似，置信度有限：任何象限仓位都只允许满仓的 50%–75%，剩余留给品种自身逻辑（见 risk-framework.md 情景预算）。

### 适用品种类型
- 全部板块，但权重不同：有色/黑色/能化对增长敏感；农产品对通胀（粮价）敏感；贵金属对真实利率敏感（不在本管道交易逻辑内单独展开）。

### 失效条件
- 锚点信号互相矛盾（增长↑与通胀↑同时但 USDCNH 反向等）→ 象限判定连续 5 日不稳定则停用。
- 结构性脱钩（中国内需与美债收益率脱钩）时增长代理失效。

### 成熟度与局限
- 成熟度：**中高**。框架本身是机构配置主流（All-Weather 运行数十年），但作为短期期货择时工具的公开可验证证据较少；投资时钟的相位划分被批评为事后划分、边界模糊。
- 局限：本管道宏观锚点只有 5 个、5 日变化口径，象限判定是低频近似；不构成严格的增长/通胀量化模型。

### 证据来源
- 达里奥/Bridgewater All-Weather 增长-通胀四象限框架的介绍 — https://www.cnbctv18.com/personal-finance/how-ray-dalio-builds-an-all%e2%80%91weather-portfolio-that-works-in-any-market-ws-l-19873783.htm/amp
- 美林投资时钟框架说明（博时基金投教文章）— https://www.bosera.com.hk/zh-HK/infos/insights/detail/10614
- 美林时钟 30 年回测讨论（香港经济日报）— https://wealth.hket.com/article/3553515/
- Kritzman, Page, Turkington (2012), "Regime Shifts: Implications for Dynamic Strategies", *Financial Analysts Journal* 68(3) — https://www.tandfonline.com/doi/abs/10.2469/faj.v68.n3.3

---

## 6. 宏观事件驱动（货币政策窗口 / 供给冲击事件）

- **id**: `macro-event`
- **类别**: 事件驱动（event-driven macro）

### 定义
围绕可提前知悉日程的宏观事件（央行议息、重要数据发布）或突发供给/地缘事件做"事件前/后"交易。两类成熟证据：① 美国 FOMC 议息前存在稳定的股票超额收益漂移（"pre-FOMC drift"，Lucca-Moench 2015），即政策窗口期市场风险偏好系统性抬升；② 农产品市场对黑海粮道事件的反应有统计显著的短期价格冲击与后续衰减（2024 年两篇谷物市场事件研究），即供给冲击事件的"冲击-修复"路径可被规则化跟踪。

### 适用市场状态
- 事件窗口期（议息前 1–2 日、事件发生后 3–10 日）；供给冲击后价格波动放大的阶段。
- 不适用：事件密集叠加期（多个冲击互相干扰，路径不可辨识）。

### 入场规则
futures-radar 确定性映射：
- **事件续走（event-join）**：`thesis.driver.primary` 命中地缘/供给事件关键词（如"黑海粮道扰动"、"制裁"、"减产"、"极端天气"）且 `screening.criteria.driver.result == "PASS"`、`thesis.trend` 与方向一致 → 按 Q4 确认信号执行入场（如 RM0："收盘站稳 2314 上方且持仓继续增加"）。**事件驱动方向只顺事件方向，不逆向猜顶。**
- **事件修复（event-fade，仅限规则允许）**：事件驱动品种在 3 日 95% 区间（`hvCone.p95`）上/下沿之外且 `divergence.pct < 20%` 时，可以区间回归为目标做反向小仓位；**本文不推荐对地缘事件做 fade**（黑海类事件无明确修复时间表），fade 仅适用于一次性发布类冲击（数据冲击、库存报告）。
- 日程事件背景：US 议息窗口对国内商品只有风险偏好外溢，映射为第 2 条 regime 评分的临时 ±1 调整（不做直接开仓依据）。

### 退出规则
- 事件仓位以 Q5 失效条件为硬退出（如 RM0"黑海粮道恢复通行或替代供应集中到港→驱动反转"）：事件解决即平仓，不恋战。
- 事件发生后第 N 个交易日（N=5 默认）若价格未沿事件方向创新高/新低，视为事件动能衰竭，减半仓。

### 风险规则
- 事件仓只允许 half-size 起步，Q4 确认后补齐；事件修复型 fade 上限 quarter-size。
- 事件类品种隔夜跳空风险大（Q6 已提示夜盘品种），止损必须为条件单（收盘触发），不用市价追损。

### 适用品种类型
- 供给冲击：农产品（粮道、天气）、能化（制裁、OPEC、炼厂事故）。
- 政策事件：黑色（限产政策）、有色（收抛储）。
- 航运 EC0：地缘与运费事件高度敏感，但波动极值（HV 200%+），只允许事件续走 + 强波动率缩放。

### 失效条件
- 事件被证伪（源头信息反转）；事件路径与宏观 regime 冲突（如供给冲击叠加衰退需求坍塌，方向不明确时放弃交易）。

### 成熟度与局限
- 成熟度：**中**。FOMC 漂移证据集中在美股且近年有衰减争论；谷物事件研究给出方向与幅度但样本有限。事件驱动更多依赖执行纪律而非统计优势。
- 局限：事件定义需要关键词规则（易过拟合）；对同一事件的研究结论不能直接外推到其他事件；**禁止**用本文事件规则对未发生的事件做收益预测。

### 证据来源
- Lucca & Moench (2015), "The Pre-FOMC Announcement Drift", *Journal of Finance* 70(1) — https://onlinelibrary.wiley.com/doi/abs/10.1111/jofi.12196
- "Agricultural commodity market response to Russia's withdrawal from the grain deal", *Journal of Agricultural Economics* 75(3) (2024) — https://onlinelibrary.wiley.com/doi/abs/10.1111/1477-9552.12611
- "Short-term market impact of Black Sea Grain Initiative on four grain markets", *Journal of Futures Markets* 44(4) (2024): 619–630 — https://econpapers.repec.org/article/wlyjfutmk/v_3a44_3ay_3a2024_3ai_3a4_3ap_3a619-630.htm

---

## 7. 板块动量轮动 / 广度确认（SECT-ROT）

- **id**: `macro-sector-rot`
- **类别**: 板块轮动（sector rotation）

### 定义
行业/板块层面的动量与轮动：强势板块在中期（1–12 个月）持续跑赢（Grinblatt-Moskowitz 1999 行业动量）；商品期货的横截面动量同样显著（Miffre-Rallis 2007：做多过去赢家、做空输家的组合）。futures-radar 已有"板块指数 + 上涨广度"基础设施，本策略把板块动量与广度作为品种信号的共振过滤器。

### 适用市场状态
- 板块轮动清晰的 regime（宏观主线驱动资金在不同板块间迁移，如"黑色强/有色弱"的本期形态）。
- 不适用：所有板块同涨同跌的系统性行情（广度接近 100% 或 0%，轮动无信息量）。

### 入场规则
futures-radar 确定性映射（全部字段已存在）：
- 板块动量：`sector-driver.json` 中板块 `direction`（1 日/5 日收益方向）作为板块动量符号。
- 广度确认：`breadth ≥ 50%` 且与板块方向一致 → 板块内候选品种的板块因子 = +1；`breadth < 50%` → 板块因子 = -1（少数品种拉动，不可持续）。
- 共振规则：候选品种方向 与 板块方向 一致 且 板块因子 = +1 → 正常仓位；方向相反 → 该品种策略降级（half-size 或不执行，除非 Q1 驱动为独立产业逻辑，如 RM0 的粮道事件独立于农产品板块整体）。
- 领涨/领跌一致性：候选品种是该板块 `representative` 之一 → 额外确认。

### 退出规则
- 板块方向反转（连续 3 日反向前行）或广度跌破 50% → 该板块共振仓位退出。
- 品种自身 Q5 无条件优先。

### 风险规则
- 板块共振加成最多 +25% 仓位（relative），板块对抗时至少 -50% 仓位；单板块总敞口上限见 risk-framework.md 的板块集中度约束。

### 适用品种类型
- 成员数 ≥3 的板块：黑色、有色、能化、农产品、新材料；贵金属与航运因"成员不足，不判定"（本期报告状态）不适用板块共振规则，直接跳过该因子。

### 失效条件
- 板块指数成员等权链式构建（基点 1000），单品种权重失真时（如 EC0 高波动主导航运）板块信号降级；本期报告已用"成员不足，不判定"处理——该逻辑继续沿用。

### 成熟度与局限
- 成熟度：**高**（行业动量是 Fama-French 之后最稳健的异象之一；商品横截面动量在 27 年样本中显著）。
- 局限：板块动量在日频上噪声大，适合周/月频，本管道日频执行需以广度过滤降噪；横截面动量需要做空腿，本管道报告只输出 Top3 方向，不做多空组合。

### 证据来源
- Grinblatt & Moskowitz (1999), "Industry Momentum"（期刊目录页）— https://web.lib.aalto.fi/en/oa/db/SCIMA/?cmd=listget&id=192340
- Miffre & Rallis (2007), "Momentum strategies in commodity futures markets", *Journal of Banking & Finance* 31(6): 1863–1886 — https://econpapers.repec.org/article/eeejbfina/v_3a31_3ay_3a2007_3ai_3a6_3ap_3a1863-1886.htm
- Erb & Harvey (2006), "The Strategic and Tactical Value of Commodity Futures"（商品期货的策略价值与因子视角）— https://www.tandfonline.com/doi/10.2469/faj.v62.n2.4084

---

## 8. 汇总表（供 strategy-library.json 合并参考）

| id | 类别 | regimeFit | 适用板块（雷达口径） | 方向 | 数据依赖（现有 artifacts） | 成熟度 | confidence（建议初值） |
|----|------|-----------|----------------------|------|--------------------------|--------|----------------------|
| macro-ts-mom | 趋势跟踪 | 趋势市（vsMA20/60 同向 + change5d 同向） | 全部 | 多/空（随信号） | trend/change5d/HV/ATR | 极高 | 高（需 Q1 驱动 PASS） |
| macro-risk-regime | regime 切换 | risk-on/off 评分 ≥3 | 顺周期（risk-on）、宏观空头（risk-off） | 多/空 | DXY/US10Y/USDCNH/DR007/SC0 change5d + 板块 breadth | 高 | 中（stale 锚点降权） |
| macro-carry | 利差收益 | 宏观平稳期 | 能化/农产品/有色 | 多/空（仅作 Q3 标签） | Q3 期限结构文本（无全品种序列） | 高 | 低（本版仅标签） |
| macro-vol-target | 仓位 overlay | 全部（随 HV 自适应） | 全部 | 中性 | HV(annual)/volPercentile/divergence/ATR5 | 高 | 高（确定性公式） |
| macro-quadrant | 宏观状态 | 增长×通胀四象限 | 有色/黑色/能化/农产品（按象限） | 多/空 | US10Y/DR007/SC0 change5d + 农产品板块 | 中高 | 低-中（代理近似） |
| macro-event | 事件驱动 | 事件窗口期 | 农产品/能化/黑色/航运 | 顺事件方向为主 | Q1 driver 关键词 + Q4/Q5 | 中 | 中（需 Q4 确认） |
| macro-sector-rot | 板块轮动 | 轮动清晰期（breadth 50%–85%） | 成员 ≥3 的板块 | 多/空（与板块共振） | sector-driver direction/breadth/representative | 高 | 中（板块因子 ±1） |

---

## 附：本笔记的边界声明

1. **不编造回测收益**：本笔记未写入任何未经引用的收益数字；文献引用只作定性结论。第 4 条中的 scale 计算为确定性仓位公式演示，使用 20260827-1910-auto 已冻结值，非收益预测。
2. **不使用持仓分析**：全文未引入会员持仓/净持仓类信号；报告 Q4/Q5 中已有的持仓表述（如"持仓继续增加"）仅作为报告既有条件的引用，不新增持仓数据依赖。
3. **不构成投资建议**：本文策略为研究素材，最终板块渲染必须附免责声明（与报告既有免责一致）。
4. **数据边界**：所有确定性规则只读 `report-model.json` / `macro-snapshot.json` / `sector-driver.json` / `probability.json` 的已冻结字段；不联网、不新增数据源。
