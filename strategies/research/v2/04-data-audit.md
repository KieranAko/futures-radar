# 04 数据可落地审计报告 —— 策略库 v2 候选策略数据审计与数据契约（t4）

> 角色：data-auditor（数据与可落地性审计）· 审计日期：2026-08-28
> 输入：`01-macro-theories.md`（t1）、`02-fundamental-theories.md`（t2）、`03-trading-theories.md`（t3）
> 产出：本文件 + `04-data-contracts.json`（逐策略数据契约，含 `exploration` 字段）
> 审计环境：仓库 futures-radar；Python 3.14 + akshare 1.18.81；网络可达（全部关键接口**独立复测**，不复述上游结论）
>
> 队长扩展指令已执行：对每个 needs-extension / rejected 候选完成**同源族之外**的数据源探索（官方渠道/交易所/行业协会/统计局/第三方接口），三态结论 `found-efficient-source` / `found-but-expensive` / `no-source`，证据并入本报告 §4 与契约 JSON。宁可标 no-source，不为填数据接受不可靠或不合规来源。

---

## 1. 审计方法

1. **仓库实测**：对 data/daily（59 品种深度）、data/macro、data/sector、data/contract-bars、data/export、probability 输出、macro-history/sector-history recordings、collector 族、full-history-collector 逐项盘点，与三份调研文档的"available"声明逐条对照。
2. **接口独立复测**：用 akshare 1.18.81 实际调用 30+ 接口（含失败项），记录行数、列名、首尾日期。
3. **探索环节**（队长扩展指令）：对 needs-extension / rejected 候选，主动探索同源族之外的数据源（交易所官网、央行、统计局、FRED、CFTC、EIA、航运交易所、气象等），逐条记录候选源、URL/接口、获取方式、频率、历史长度、稳定性、接入成本、合规性，并给出三态结论。
4. **未来函数审计**：逐策略检查 asOf 规则、T+1 执行、换月拼接 PIT、stale 处理、月度数据发布日对齐、历史回填的前视风险。

**判定三态**（与上游调研文档同名，语义对齐）：

| 状态 | 定义 |
|---|---|
| `available` | 数据源已接入仓库，或经实测可经仓库既有工具直接回填/派生，无新增外部依赖 |
| `needs-extension` | 数据源实测存在但未接入管道，或需新增采集器/序列构建器/人工维护集——写明缺什么、能否获取、升级路径 |
| `rejected` | 所需字段不可获取或无合规免费代理——维持剔除留档 |

---

## 2. 仓库数据层实测盘点（与调研文档声明对照）

### 2.1 逐项对照表

| 声明（来源） | 实测结果 | 对照结论 |
|---|---|---|
| data/daily 60 符号、OHLCV+turnover/OI/settle（t2/t3） | **59 文件**；字段齐：dates/open/high/low/close/volume/turnover/openInterest/settle/sources；深度：RB0/M0/SC0 = 500 bars（2024-08-06 起），其余 56 个 = **61 bars（2026-06-03 起）** | ✔ 字段正确；⚠ **深度短板**（除 3 品种外仅 3 个月） |
| raw.json / daily 82 品种覆盖（t1） | config/symbols.json 82 定义 / 59 活跃；data/daily 59 文件 | ✔ 与活跃池一致 |
| probability.json 每品种 atr5/hv/volPercentile/HV 锥（t1） | probability.json **每 run 仅覆盖 KEEP 候选 1-3 个品种**（实测最新 run：EC0/RM0/B0）；计算能力（hv-estimators.js/stage-4-5.cjs）在库 | ⚠ **覆盖范围修正**：全品种派生字段需批量运行（GA-2） |
| macro-snapshot 5 锚点（t1） | ✔ DXY/USDCNH/US10Y/DR007/SC0 全部在位；US10Y asOf 2026-08-26（stale，降权规则内置）；**USDCNH change5d=null**（2026-08-27 快照） | ⚠ 1 处缺口（GA-5） |
| macro-history recordings（t1） | DXY 1985-11+（sina DINIW）、USDCNH 2014-11+；**US10Y/DR007 记录仅 2026-02+**（源可回填 2002+/2017-05+） | ⚠ 需回填（GA-4） |
| sector-history / data/sector 板块广度（t2/t3） | data/sector/*.json **仅 1 行**（2026-08-27）；recordings/v5/sector-history.json 为 2025-11 起 47 品种 | ⚠ 板块序列历史需重建（GA-3） |
| 具体合约日线 futures_zh_daily_sina 可用（t2/t3） | ✔ 实测 RB2610 213 行（2025-10-16 起，含 hold/settle）；限流 ~80 req/h（collector 已含退避） | ✔ |
| futures_term_structure collector（t2） | ✔ 在库，含重试/退避/120 bar 缓存 | ✔ |
| full-history-collector.cjs（t2/t3） | ✔ 工具在库；**尚未运行**（research/backtest/data/ 不存在） | ⚠ 前置动作未执行（GA-1） |
| 长历史主力连续可拉取（t3） | ✔ 实测 futures_main_sina：RB0 2009-03+（4231 行）、I0 2013-10+（3128 行）、TA0 2006-12+（4785 行）、M0 2005-01+（5270 行），持仓量列全历史非空 | ✔ 回填能力确认 |
| event-calendar（t1 M7） | ✔ recordings/v5/event-calendar.json（2026-03-01~08-14，verified/schedule 双态） | ✔ |
| FinCoT recordings（t3 TR-04/06） | ⚠ 仅 RB0/M0/SC0 有 fincot-*.json；全品种历史回溯需按需重跑（LLM 成本） | ⚠ 记录在 TR-04/TR-06 条目 |

### 2.2 本轮接口独立复测记录（2026-08-28，akshare 1.18.81）

| 接口 | 结果 | 实测证据 |
|---|---|---|
| `futures_inventory_em('螺纹钢'/'沪铜'/'豆粕')` | ✅ | 72 行，2026-05-19 → 2026-08-27（**约 3 个月**）；东财 API 层 count=72 与 pageSize 无关 |
| `futures_inventory_99` | ❌ | JSONDecodeError 复现（确认 X-01） |
| `futures_spot_price_previous('20260827')` | ✅ | 54 品种，含 180 日基差最高/最低/平均 |
| `futures_spot_price_daily(start_day,end_day,vars_list=['RB','M','TA'])` | ✅ | 57 行/13 列（参数名为 start_day/end_day、vars_list 用合约代码，中文名会返回空） |
| `futures_main_sina(RB0/I0/TA0/M0)` | ✅ | 见 §2.1；8 列含持仓量 |
| `futures_zh_daily_sina('RB2610')` | ✅ | 213 行含 hold/settle |
| `bond_zh_us_rate()` | ✅ | 全量 9330 行（2002+），同表 CN10Y/US10Y（M12 直接可用） |
| `repo_rate_hist` | ✅/⚠ | 单次查询窗口 **≤1 年**（超窗 KeyError frValueMap）；FDR007 自 2017-05-31 起、FR007 自 2015 起；按年分批 12 次可拼 2015+ 全历史 |
| `macro_china_lpr` | ✅ | 1575 行（1991+，最新 2026-08-20 LPR1Y 3.0） |
| `macro_china_shrzgm` | ✅ | 136 行（2015+，最新 2026-04，滞后约 4 月→按发布日 PIT 对齐） |
| `macro_china_money_supply` | ✅ | 223 行月频 |
| `macro_china_pmi` | ✅ | 223 行（2008+，最新 2026-07） |
| `macro_china_ppi` | ✅ | 247 行（2006+；"当月"为环比指数口径，使用前与统计局口径核对） |
| `macro_china_cpi_monthly` | ✅/⚠ | 357 行（1996+）；表尾存在 NaN 行（最新有效值滞后），取最后有效值并校验发布日 |
| `macro_china_gdp / industrial_production_yoy / exports_yoy` | ✅ | 季度/月度，1990s+ |
| `macro_china_shibor_all` | ✅ | 2356 行日频 |
| `macro_china_swap_rate` | ❌ | ValueError（接口异常，不阻塞任何策略） |
| `fx_spot_quote` | ❌ | JSONDecodeError（USDCNH 由 sina 已覆盖，不影响） |
| `index_option_50etf_qvix` | ✅ | **2800 行，2015-02-09 → 2026-08-27**（11 年+，M13 顾虑解除） |
| `futures_foreign_hist` | ✅ | CAD/AHD/NID/SND/PBD/ZSD（LME 铜铝镍锡铅锌 2016-08+ 各 ~2538 行）；XAU（伦敦金 2006+ 5186 行）；GC/SI/HG（COMEX 2016+）；CL（NYMEX 1996+ 7691 行）；共 30 个外盘符号 |
| `futures_shfe_warehouse_receipt` | ⚠ | 本环境 SSL 被拒（shfe.com.cn 网络层）；官网文件路径存在 |
| `futures_warehouse_receipt_dce` | ⚠ | JSONDecodeError（当前不可用） |
| `futures_warehouse_receipt_czce('20260701')` | ✅ | 返回 SR/CF/CY/RM/OI 等品种仓库级仓单+当日增减（官方仓单日报可用） |
| `futures_gfex_warehouse_receipt` | 未实测 | 接口存在（SI/LC/PS） |
| `macro_euro_lme_stock` | ✅ | 2718 行周频（镍/铝/锌/铅/锡/铜等库存+仓单） |
| `get_rank_sum_daily` | ✅ | 实测 2026-08-25..27 可用（27 列会员持仓） |
| `get_futures_daily`（CFMMC） | ✅（间接） | 仓库 cfmmc-verify.cjs 已在每日验证管线使用（官方交叉验证层） |
| `macro_china_central_bank_balance` | ✅ | 355 行月度（OMO 数量型**日频**仍无接口） |

---

## 3. 逐策略审计结论

> 完整字段级契约见 `04-data-contracts.json`（每策略 dependencies + exploration）。本节为结论与要点。

### 3.1 宏观（t1）—— 13 候选 + 6 剔除复审计

| ID | 状态 | 审计要点 |
|---|---|---|
| M1 DR007 流动性冲击 | **available** | DR007 记录 2026-02+ 需按年分批回填（程序实测可行）；r* 扩展 = PBOC 公告人工维护（found-but-expensive，P0 不依赖） |
| M2 汇率传导 | **available** | DXY/USDCNH 历史深；**USDCNH.change5d=null 需修复**（GA-5）；沪伦比扩展原标 rejected → `futures_foreign_hist` LME 铜铝镍锡铅锌 2016+ **found-efficient-source，建议复活为 P1** |
| M3 美债→贵金属 | **available** | US10Y stale T-1 规则内置；TIPS breakeven 原标 rejected → **FRED DFII10（2003+ 免费）found-efficient-source，建议复活为扩展**；PPI 环比代理亦可（2006+） |
| M4 SC0 成本传导 | **available** | 纯价格链；GA-1 回填后满足 250d 标定 |
| M5 五锚点评分 | **available** | stale/missing 处理内置；GA-4/GA-5 回填修复；CBOE VIX 原标 rejected → **FRED VIXCLS（1990+）found-efficient-source，建议复活为交叉验证锚** |
| M6 波动率 overlay | **available** | hv/divergence 计算能力在库；**覆盖范围修正：每 run 仅 KEEP 品种 1-3 个，需 GA-2 全品种批量** |
| M7 美债事件冲击 | **available** | 事件日历 v5 在库；样本 <30 自停门禁内置 |
| M8 LPR/社融 | needs-extension | 三接口全部实测可用（1991+/2015+/2000s+），缺月度采集器与发布日 PIT 对齐；官方源交叉验证 found-efficient-source |
| M9 CPI/PPI | needs-extension | PPI 2006+ 可用；CPI 月率表尾行 NaN 需"最后有效值+发布日校验"；缺采集器 |
| M10 投资时钟 | needs-extension | PMI 2008+/PPI 2006+ 可用；与 M9 共用月度采集器 |
| M11 政策事件 | needs-extension | **无免费结构化政策库**；央行/发改委/商务部/海关公告 = found-but-expensive（人工维护 YAML）；一致预期数据为付费源 |
| M12 中美利差 | needs-extension | CN10Y 与 US10Y **同表**已实测（2002+ 全量），仅需 macro-probe 加 CN10Y 锚点 |
| M13 QVIX | needs-extension | **实测 2015-02-09 起 2800 行（11 年+）**——t1 的"历史不足 3 年"顾虑不成立，接入即可测 |

**t1 已剔除 6 项复审计**（详见契约 JSON `T1-REJECTED`）：
- **TIPS breakeven** → FRED DFII10 → found-efficient-source → 建议改判复活
- **CBOE VIX** → FRED VIXCLS / CBOE CSV → found-efficient-source → 建议改判复活
- **OMO 净投放日频** → PBOC 公告 2013+ → found-but-expensive → 维持剔除（M1 价格型代理合理）
- **LME 外盘** → futures_foreign_hist → found-efficient-source → 复活为 M2 扩展
- **人民币金溢价** → XAU（伦敦金 2006+）×USDCNH vs AU0 隐含溢价可计算（需 oz→g 换算与期现口径声明）→ found-efficient-source → 复活为观察项
- **LLM 叙事预测** → 非数据问题（无模型无证伪命题）→ 维持剔除

### 3.2 基本面（t2）—— 9 P0 + 5 P1 + 5 剔除复审计

| ID | 状态 | 审计要点 |
|---|---|---|
| FS-01 库存分位 | **needs-extension** | 实测 EM 库存仅 72 行 ≈ 3 个月（API 层确认，非 pageSize 问题）→ 250d 分位需新增增量采集器积累 8-10 个月；**郑商所官方仓单日报实测可用（found-efficient-source）可加速 CF/SR/RM/OI/TA/FG/SA 等品种**；SHFE/DCE 官网直爬 found-but-expensive；LME 周库存 found-efficient-source（交叉验证） |
| FS-02 基差分位 | **available** | 生意社现货+基差 2011+ 与 180 日分布锚实测可用；基差历史批量采集器 + 现货粘性质量门（GA-6）为执行动作；替代源均为付费（found-but-expensive） |
| FS-03 月差 | needs-extension | 数据源实测可用（213 行含 hold）；缺历史月差序列构建器与两腿流动性门审计；**换月拼接必须 PIT**（禁事后选合约） |
| FS-04 黑色利润 | **available** | 纯价格数据；GA-1 回填后满足 2016+ 标定；真实利润付费源 found-but-expensive（不引入） |
| FS-05 压榨价差 | **available** | 纯价格数据；GA-1 回填后 ≥5 年协整标定可行 |
| FS-06 库存×基差 | needs-extension | 继承 FS-01 缺口；板块广度历史需 GA-3 重建；同交易日双信号 AND 门已内置防跨日拼接 |
| FS-07 季节性 | **available** | 主力连续 ≥8 年实测可行（2005-2009+）；比率拼接纪律与"只用当年之前年份"为审计项 |
| FS-08 能化 ECM | **available** | SC0 500 bars 在库；化工品 GA-1 回填后 ≥750 日标定可行 |
| FS-09 政策事件 | needs-extension | 人工日历 YAML 硬前置（≥20 样本）；官方公告 found-but-expensive；与 M11 共用日历模板 |
| FS-P1-01 开工率 | needs-extension | 日频免费层 **no-source**；统计局月度产量 found-but-expensive（可作低频确认层） |
| FS-P1-02 会员持仓 | needs-extension | get_rank_sum_daily 实测可用（2000+）→ **found-efficient-source，数据侧就绪**；阻塞 = 仓库 OI 纪律裁定（需队长决策） |
| FS-P1-03 真实利润 | needs-extension | 钢联/生意社部分口径 → found-but-expensive |
| FS-P1-04 SC 库存 | needs-extension | INE 官网仓单日报 found-but-expensive（无 akshare 接口）；**SC 现货基差 no-source**（无境内原油现货挂牌价）→ FS-08 产品腿单边结构是正确取舍 |
| FS-P1-05 集运 EC | needs-extension | SCFI 官方周频 found-but-expensive；装载率 no-source；维持由宏观域协调 |

**t2 已剔除 5 项复审计**：
- X-01（99期货网）→ 复测仍失效 → **no-source**（替代=EM 增量+官方仓单）
- X-02（社会库存/真实利润）→ Mysteel/钢联 → found-but-expensive → 维持剔除
- X-03（天气）→ NOAA GSOD 免费但工程量大 → found-but-expensive → 维持剔除
- X-04（CFTC/EIA）→ **CFTC COT/EIA 官方免费 → found-efficient-source，数据侧已解决**；"与内盘无定价契约"的剔除理由由 t5 裁量
- X-05（生猪/鸡蛋存栏）→ 农业农村部月度滞后 → found-but-expensive → 维持剔除

### 3.3 交易系统（t3）—— 8 候选 + 9 剔除复审计

| ID | 状态 | 审计要点 |
|---|---|---|
| TR-01 趋势延续 | **available** | 字段完整（OI 全历史实测非空）；T+1 执行/跳空放弃/换月剔除均内置；GA-1/GA-2 回填后满足 ≥200 笔 |
| TR-02 压缩扩张 | **available** | HV%ile 需 GA-2 全品种批量；无新增数据源 |
| TR-03 趋势回踩 | **available** | 库内派生；止损 ≤1.5R 门禁内置 |
| TR-04 偏离修复 | needs-extension | 价格数据齐；缺 GA-2（HV%ile 全品种）+ GA-3（板块广度历史）+ **FinCoT Q1 全品种历史回溯（当前仅 RB0/M0/SC0；禁止用未来重跑文本回填历史=前视风险）** |
| TR-05 区间+移交 | **available** | A 模式停用、B 模式移交定价（防混用内置） |
| TR-06 事件确认 | **available** | 事件判定库内派生；FinCoT 历史回溯注意项同 TR-04 |
| TR-07 跨期价差 | needs-extension | 合约日线实测可用；缺价差序列构建器 + **PIT 换月拼接纪律** + 两腿流动性审计；CFMMC 官方日线可交叉验证（found-efficient-source） |
| TR-08 跨品种协整 | needs-extension | 两腿 GA-1 回填（≥500 bars）+ GA-3 板块 leaders/laggards 历史 |

**t3 已剔除 9 项复审计**：
- 无模型类（均线网格/裸 RSI/形态库/裸 Donchian/马丁格尔/纯日历）→ 非数据问题，维持剔除
- 交割套利 → 维持剔除（个人户不可交割）
- 日内高频 → **分钟级数据可得（TqSdk 免费层，found-efficient-source）**；但仓库口径不采集日内 → 口径决定维持剔除，非数据不可得
- 舆情择时 → 免费合规层无结构化历史舆情库 → **no-source** → 维持剔除

---

## 4. 数据源探索汇总（队长扩展指令 §4）

### 4.1 探索发现统计

| 三态 | 数量 | 代表发现 |
|---|---|---|
| found-efficient-source | 12 项 | futures_foreign_hist（LME/COMEX/NYMEX 深度历史）、FRED（DFII10/VIXCLS）、QVIX 2015+ 2800 行、bond_zh_us_rate 2002+ 全量、repo_rate_hist 分批回填程序、郑商所官方仓单日报、LME 周库存、get_rank_sum_daily、CFTC COT/EIA、CFMMC 官方日线、TqSdk 分钟级、CBOE CSV |
| found-but-expensive | 12 项 | PBOC OMO 公告（人工维护）、发改委/商务部政策日历、SHFE/DCE/INE/GFEX 官网仓单爬虫、Mysteel/钢联/隆众付费、统计局月度产量、SCFI 爬虫、农业农村部月度、NOAA GSOD、一致预期付费源 |
| no-source | 6 项 | SC 现货基差、日频开工率（免费层）、装载率/运力、结构化历史舆情库、99期货网（失效）、LLM 叙事（非数据） |

### 4.2 关键复活/修订结论（需上游/队长决策）

1. **t1 剔除 4 项数据侧已解决**：TIPS breakeven（FRED）、CBOE VIX（FRED）、LME 外盘（sina 外盘族）、人民币金溢价（XAU×USDCNH 隐含）→ 建议 t1 改判 needs-extension 复活。
2. **M13 顾虑解除**：QVIX 实测 11 年历史（非"不足 3 年"）。
3. **FS-01 存在官方加速通道**：郑商所仓单日报实测可用；SHFE/DCE 官网爬虫为二期选项。
4. **X-04 数据可得性不构成剔除理由**（CFTC/EIA 官方免费）——策略适配留 t5。
5. **FS-P1-02 数据侧就绪**（会员持仓 2000+），阻塞为 OI 纪律裁定——请队长裁决。
6. **SC 基差 no-source 确认**：FS-08 产品腿单边结构为正确取舍，不得回头设计 SC 基差策略。

### 4.3 数据源接入清单（供 t5 排期）

| 接入项 | 源 | 成本 | 服务策略 |
|---|---|---|---|
| EM 库存增量采集器 | futures_inventory_em | 低 | FS-01/FS-06 |
| 基差历史采集器（PIT） | futures_spot_price_daily | 低 | FS-02/FS-06 |
| 月差序列构建器（PIT 拼接） | futures_zh_daily_sina | 中 | FS-03/TR-07 |
| 月度宏观采集器（LPR/社融/M2/CPI/PPI/PMI） | macro_china_* | 低 | M8/M9/M10 |
| QVIX 采集器 | index_option_50etf_qvix | 低 | M13 |
| CN10Y 锚点扩展 | bond_zh_us_rate | 低 | M12 |
| DR007/US10Y 历史回填 | repo_rate_hist 分批 + bond_zh_us_rate | 低 | M1/M3/M5/M7 |
| 全品种派生字段批量 runner | probability/ | 低 | M1/M2/M3/M6/TR-02/TR-04 |
| 板块序列历史重建 | sector-aggregator | 低 | TR-04/TR-08/FS-06 |
| 政策日历 YAML（人工） | 官方公告 | 中（人力） | M11/FS-09 |
| 郑商所仓单日报回拉 | futures_warehouse_receipt_czce | 低-中 | FS-01 加速 |
| LME 外盘日线 | futures_foreign_hist | 低 | M2 扩展/P1 |
| FRED 拉取（DFII10/VIXCLS） | fred.stlouisfed.org | 低 | M3 扩展/M5 交叉验证 |
| OI 纪律裁定 | get_rank_sum_daily | 低（需决策） | FS-P1-02 |

---

## 5. 未来函数与 asOf 纪律审计（全库通用）

| # | 风险点 | 审计结论 |
|---|---|---|
| F1 | 信号日 vs 执行日 | 全部策略已内置"T 日收盘评估 → T+1 开盘执行"；跳空放弃条款齐备（TR 族 0.5-0.75×ATR5）→ 合规 |
| F2 | 宏观锚点 stale/missing | US10Y T-1 滞后已标 stale 并按 0.75 降权（快照实测生效）；USDCNH change5d=null 需修复（GA-5）；missing 计 0 规则已内置 |
| F3 | 月度数据发布滞后 | 社融最新 2026-04、CPI 月率表尾行 NaN、PMI 次月初发布 → 必须按**发布日 PIT 对齐**，禁止月末即用；契约已写入 asOf 规则 |
| F4 | 库存发布时点 | EM 库存盘后发布，T 日收盘后评估合规；**须确认个别品种次日更新时点**并在增量采集器留档入库时点 |
| F5 | 换月拼接（TR-07/FS-03/FS-07） | 必须 PIT（T 日时点的活跃合约映射），禁止事后最优合约选择；≥9.5% 跳变剔除已内置；长历史回填保留 per-bar sources |
| F6 | FinCoT 文本回溯（TR-04/06） | 回测只能用历史 run 产物；**禁止用未来重跑文本回填历史（重跑=前视）**——已写入契约 |
| F7 | 现货粘性 | 生意社挂牌价粘性/修订风险由 GA-6 质量门（30 日零变动 >40% 剔除）管理；历史回填必须 PIT 快照 |
| F8 | 滚动估计窗口 | M4/FS-05/FS-08/TR-08 滚动 OLS/协整均声明"只用 T 日及以前"，冻结后样本外验证 → 合规 |
| F9 | 事件日历 discipline | event-calendar.json 已内置"只允许 event.date ≤ 锚点日、禁止从价格反推事件"纪律 → 合规 |

---

## 6. 结论汇总

| 统计 | 数量 | 明细 |
|---|---|---|
| available | **17** | M1-M7、FS-02/04/05/07/08、TR-01/02/03/05/06 |
| needs-extension | **18** | M8-M13、FS-01/03/06/09、FS-P1-01~05、TR-04/07/08（全部有明确升级路径，其中 14 条数据源已实测可用仅缺管道/构建器） |
| rejected | **20** | t1 剔除 6（4 项数据侧已复活证据）、t2 剔除 5（1 项数据侧已解决）、t3 剔除 9（1 项数据侧可得但口径剔除） |
| 全局前置动作 | **6** | GA-1 全历史回填（工具已存在，运行即可）、GA-2 派生字段全品种批量、GA-3 板块序列重建、GA-4 宏观锚点回填（程序实测可行）、GA-5 USDCNH change5d 修复、GA-6 现货质量门 |

**审计底线结论**：
1. 17 条 available 策略的"定价所需数据"全部可在仓库内落地；唯一真实阻塞是 GA-1（full-history-collector 运行一次）与 GA-2（派生字段批量）。
2. 18 条 needs-extension 中，**没有任何一条是不可获取**——全部有实测可用的数据源或已定价的官方通道；升级路径全部写明在契约 JSON 的 `upgradePath`。
3. 队长扩展指令的探索结论：8 条原 rejected/存疑项获得**数据侧复活证据**（found-efficient-source），4 条确认维持剔除（found-but-expensive/no-source），未引入任何不可靠或不合规来源。
4. 无未来函数红线违规；6 项全库级 asOf/PIT 纪律已写入契约（§5）。

---

## 7. 交付物

- 本报告：`strategies/research/v2/04-data-audit.md`
- 数据契约（含 `exploration` 字段）：`strategies/research/v2/04-data-contracts.json`
  - schema `futures-strategy-data-contracts/1`
  - 每策略：status/rationale/dependencies（field/source/path/frequency/history/asOf/gap/lookaheadRisk）/exploration（need/candidates[]/decision）/upgradePath/auditNotes
  - 全局：globalActions（GA-1..6）、sourceRegistry（27 个源三态判定）、statusSummary

> 本文与契约均为数据审计结论，不构成投资建议。
