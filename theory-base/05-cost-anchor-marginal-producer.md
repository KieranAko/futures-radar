# 05 成本锚：边际生产者、加工利润、进口平价与生产成本

> 定位：为报告 TOP3 品种提供"当前价格处在成本曲线的什么位置"的**证据上下文**。
> 纪律：成本锚是证据，不是交易信号；成本线不是支撑线。

## 一、边际生产者与开采成本曲线（类型 A）

### 理论来源
- Hotelling, H. (1931). *The Economics of Exhaustible Resources*. Journal of Political Economy.
- 行业方法学：CRU / Wood Mackenzie / S&P Global 成本曲线（cash cost curve）与 incentive price。

### 命题
- 价格由满足需求所需**边际产能**的现金成本决定。
- 常用锚点：**C1 现金成本的 P90 分位（incentive price）**。价格高于 P90 → 新产能有激励；低于 P50 → 高成本产能承压。
- 贵金属采用 World Gold Council (2013) *AISC Guidance Note* 的 AISC 口径。

### 公式
```
pricePosition = rank(price vs costCurve) / curveSize
incentivePrice ≈ P90(costCurve)
```

## 二、加工利润的零利润线（类型 B）

### 理论来源
- Marshall 供给曲线与派生需求：加工品价格减投入成本决定加工供给。
- Working, H. (1949). *The Theory of Price of Storage*. American Economic Review（期限结构/持有成本延伸）。
- 行业会计标准：crack spread、crush margin、TC/RC、加工费。

### 命题
```
margin = P_product − Σ_i(qty_i × P_input_i) − processing_fee
```
- margin ≤ 0 → 开工率下降、检修增加（供给收缩）；
- margin 显著为正 → 开工率上升（供给增加）。
- 成本锚 = **margin 归零时的产成品价格**（或直接记录成本区间）。

## 三、进口平价与空间套利（类型 C）

### 理论来源
- Samuelson, P. A. (1954). *The Transfer Problem and Transport Costs, II*. Economic Journal（iceberg transport cost）。
- Obstfeld, M. & Rogoff, K. (1996). *Foundations of International Macroeconomics*（一价定律/贸易品平价）。

### 命题
```
importProfit = P_domestic − (P_foreign × FX + freight + tariff + premium)
```
- importProfit ≤ 0 → 进口收缩；
- importProfit > 0 → 进口增加，内外价差回归。

## 四、农业完全成本与生产者退出阈值（类型 D）

### 方法学来源
- USDA ERS, *Commodity Costs and Returns*（完全成本：经营成本 + 劳动 + 土地 + 资本机会成本）。
- 中国国家发改委价格司《全国农产品成本收益资料汇编》口径。

### 命题
- 完全成本是生产者**退出阈值**：价格持续低于完全成本 → 种植面积/存栏下降（滞后 1–2 个生产周期）。
- 价格高于完全成本 → 面积/存栏扩张预期。

## 五、统一证据契约

任何成本锚记录必须包含：
`anchorType, indicator, valueLow, valueHigh, unit, asOf, sourceDates, sourceTiers, confidence`

来源层级：S（官方统计/公司公告）> A（产业数据商/协会）> B（券商研报）> C（媒体转述）；社交媒体除非引用 S/A 原文否则禁用。

## 六、禁用命题（fail-closed）

1. "成本线 = 支撑位" —— 价格可以长期低于高成本线。
2. 成本锚单独决定方向 —— 只能作为 Q1/Q3 上下文证据。
3. 无来源、无 asOf 的数字 —— 一律标 `unknown`，不注入。
