# 13 GA-6/GA-7 现货粘性质量门与政策日历 v0 报告

> 角色：data-engineer-2（宏观/质量门/验证）· 执行日期：2026-08-28
> 任务范围：GA-7 政策日历 v0 最小集构建 + GA-6 生意社现货粘性质量门 v0 样例审计
> 依据：`10-ga-plan.md` §9/§10、`04-data-contracts.json` GA-6/GA-7 契约、`strategy-library-v2.json` FS-02/FS-04/FS-05/EC-01 的 falsificationTests、recordings/v5/event-calendar.json v2 模板
> 一句话结论：**GA-7 日历 v0（9 事件窗口 + 9 月度发布排期，F9 校验全过）与 GA-6 质量门 v0（54 品种审计，12 剔除/42 可交易，修订风险样例审计发现 2 项真实口径风险）全部验收通过；FS-04/FS-05/EC-01 冻结前置解除，FS-02 第二批采集器拿到可交易集 + 口径纪律。**

---

## 1. GA-7 政策日历 v0（事件前提最小集）

### 1.1 产物与结构

| 文件 | 说明 |
|---|---|
| `strategies/research/v2/falsification/ga7-policy-calendar-v0.yaml` | 人工维护源（9 事件 + 9 月度/周度发布排期，每条带 source/verified） |
| `strategies/research/v2/falsification/data/ga7-policy-calendar-v0.json` | 机器形态（含 yamlSha256 同源锁定） |
| `strategies/research/v2/falsification/ga7-calendar-sync.py` | YAML 结构校验 + JSON 同步（11 类断言） |
| `strategies/research/v2/falsification/ga7-f9-check.cjs` | F9 discipline 校验（**全部断言通过，exit 0**） |

### 1.2 事件窗口（年份级，9 条；每类 3 条）

| id | 窗口 | 板块 | 事件 | verified | 来源 |
|---|---|---|---|---|---|
| ga7-bk-2016 | 2016-02-04..2017-12-31 | black | 钢铁供给侧改革（国发〔2016〕6 号去产能） | ✅ | gov.cn 文件页 |
| ga7-bk-2021 | 2021-04-01..2021-12-31 | black | 2021 粗钢产量压减（确保同比下降） | ✅ | miit.gov.cn 部署 |
| ga7-bk-2025 | 2025-03-05..2025-12-31 | black | 2025 政府工作报告：持续实施粗钢产量调控 | ✅ | 报告全文（xhby.net 转载） |
| ga7-ag-2019 | 2019-03-01..2019-12-31 | agriculture | 海关总署加强进口加拿大油菜籽检疫（加企注册资格暂停） | ✅ | 驻加使馆转发海关公告 |
| ga7-ag-2024ad | 2024-09-09..2025-12-31 | agriculture | 商务部对加拿大油菜籽反倾销立案（2024 年第 37 号公告） | ✅ | cnr.cn 公告全文 |
| ga7-ag-reserve | 2016-01-01..2026-12-31 | agriculture | 国储/中储粮大豆等收抛储常态化窗口 | ⚠ schedule | grain.gov.cn（轮次以竞价公告为准） |
| ga7-en-2020opec | 2020-04-12..2020-04-30 | energy_chemical | OPEC+ 历史性减产协议（首轮 970 万桶/日） | ✅ | thepaper.cn |
| ga7-en-2020oil | 2020-04-20..2020-04-21 | energy_chemical | WTI 2005 结算 −37.63 美元/桶（负油价，EC-01 结构性失效段） | ✅ | Reuters/CME 声明 |
| ga7-en-2022ru | 2022-02-24..2022-03-31 | energy_chemical | 俄乌冲突爆发（能源供给冲击起点，EC-01 结构性失效段） | ✅ | news.un.org |

月度/周度发布排期（schedules，9 条，verified=false 仅作日程预期）：china_pmi、china_cpi_ppi、china_lpr、china_finance_data、fomc、wasde、mpob、eia_weekly、opec_meeting，均带官方源 URL。

### 1.3 F9 校验（ga7-f9-check.cjs）

- **YAML↔JSON 同源**：sha256 锁定 ✓；schema ✓；9 事件/9 排期 ✓；无未来日期 ✓；每类 ≥2 ✓。
- **反价格推演**：每条事件/排期必须带 http(s) source，verified=true 强制 URL ✓。
- **使用门禁正反用例**（event.date ≤ 锚点日才可用）5 组锚点全部通过：如 @2019-06-30 可用 ga7-ag-2019 但不可用 ga7-en-2020oil；@2026-08-14 可用 ga7-bk-2025/ga7-ag-2024ad ✓。
- **证伪开窗覆盖**：FS-04(d) 2016/2017/2021/2025、FS-05(c) 2019/反倾销、EC-01(c) 2020/2022 全部可标注 ✓。

### 1.4 ⚠ 与策略库的 1 处口径冲突（已对齐：2026-08-28 修订）

FS-05(c) 原文写"**2023 反倾销**"，但实证立案为 **2024-09-09 商务部公告 2024 年第 37 号（对加拿大油菜籽反倾销立案调查）**。日历以实证日期 2024-09-09 标注并留档；walk-forward 开窗建议按实证日期。库文案已对齐（2026-08-28 修订）：原库文案曾记 2023，已按实证 2024-09-09 更正。

---

## 2. GA-6 生意社现货粘性质量门 v0（样例审计）

### 2.1 产物

| 文件 | 说明 |
|---|---|
| `strategies/research/v2/falsification/ga6-spot-stickiness.py` | 采集/审计/复拉三模式（可复跑） |
| `data/ga6-fetch-spot-daily.json` | PIT 抓取证据：2026-07-10..08-28 窗口 1944 行（fetchedAt 2026-08-28T08:31:20Z） |
| `data/ga6-fetch-spot-previous.json` | PIT 抓取证据：54 品种 180 日基差锚（fetchedAt 08:31:46Z） |
| `data/ga6-fetch-recheck-20260827.json` | 同日复拉对拍（修订探针）：0 差异 |
| `data/ga6-spot-stickiness.json` | 逐品种审计 + F7 检查清单 + 修订风险样例 |
| `data/ga6-tradable-set.json` | FS-02 可交易集名单 |

### 2.2 审计结果（规则：30 日零变动占比 > 40% 剔除，机械执行）

- **审计 54 品种**（futures_spot_price_daily 全部可得品种，窗口 30 行/品种，无缺数据品种）。
- **剔除 12**（零变动占比）：A 0.966、PX 0.966、SH 0.931、PS 0.897、CY 0.862、SA 0.828、J 0.759、JM 0.759、FG 0.724、SI 0.724、C 0.552、SS 0.552。
- **可交易 42**：AG/AL/AU/BR/BU/BZ/CF/CU/EB/EG/FU/HC/I/JD/L/LC/LH/M/MA/NI/OI/P/PB/PF/PG/PL/PP/PR/RB/RM/RU/SF/SM/SN/SP/SR/TA/UR/V/WR/Y/ZN。FS-02 相关主流动品种（RB 0.034、M 0.069、RM 0.172、CU 0、I 0）全部通过。
- 独立复算对拍（RB/FG 手工重算）与脚本输出一致。

### 2.3 修订/口径风险样例审计（发现 2 项真实风险 + 1 项异常）

1. **基差符号口径相反（49/54 品种）**：`futures_spot_price_daily` 的 dom_basis 与 `futures_spot_price_previous` 的主力合约基差**符号相反**（同一合约、数值 ≈ ±2×基差，如 CU 2610：daily −1136.67 vs previous +1137.0）。→ **FS-02 第二批基差采集器必须统一符号**：库公式 br=(S−F)/S，而 dom_basis_rate=(F−S)/S（2021 实测样本验证），采集器入仓时须统一为库公式口径并留 provenance。
2. **现货价同日修订漂移（0.03–0.33）**：跨接口同日现货价存在微小差异（CU 0.33、AG/AL/CF 0.03）；同接口 6 分钟内复拉差异为 0。→ 生意社现货价存在同日修订，**F7 PIT 逐日快照纪律必须严格执行，禁止事后回填/重拉历史**。
3. **FG（玻璃）现货口径异常**：两接口同日现货价差 944（口径/基准地差异），FG 本身已因粘性 0.724 被剔除，不影响可交易集。

### 2.4 F7 检查清单（已写入 ga6-spot-stickiness.json pitChecklist）

F7-1 每次拉取记录 fetchedAt；F7-2 历史回填逐日 PIT（start=end=T 日），禁今日数据回填历史；F7-3 本审计为采集日样例快照（v0），全量历史审计按逐日 PIT 重跑后冻结名单；F7-4 回测引用以当日快照文件为准，不追后修；F7-5 dominant_contract 换月导致的基差跳变与现货粘性无关（审计只统计 spot_price 序列）。

---

## 3. 验收矩阵

| GA | 验收项 | 结果 | 证据 |
|---|---|---|---|
| GA-7 | YAML ≥9 窗口（三类各 ≥2），每条带 source+verified | **pass** | 9 事件（3/3/3）+ 9 排期，8 条 verified=true 带官方 URL |
| GA-7 | ga7-f9-check.cjs 全部断言通过 | **pass** | `F9 CHECK PASSED`（exit 0，70+ 断言含 5 组 F9 正反用例） |
| GA-7 | FS-04(d)/FS-05(c)/EC-01(c) 窗口全部可标注 | **pass** | 覆盖检查：2016/17/21/25 black、2019+2024 ag、2020/22 energy |
| GA-6 | ≥30 品种 × 30 日零变动占比 | **pass** | 54 品种全审计，每品种 30 行窗口 |
| GA-6 | >40% 剔除机械执行 + 名单产出 | **pass** | 12 剔除/42 可交易，ga6-tradable-set.json |
| GA-6 | PIT 证据（fetchedAt 与采集日一致） | **pass** | 3 个 fetch 文件均含 fetchedAt（2026-08-28），复拉 0 差异 |
| GA-6 | FS-02 输入口径就绪（dom_basis_rate + 180 日锚） | **pass** | daily 每行含 dom_basis_rate；previous 含 180 日 hi/lo/mean；符号口径风险已留档 |

## 4. 下游影响与边界

- **FS-04/FS-05/EC-01 的 GA-7 冻结前置解除**；EC-01 在完整事件集（FS-09）建成前仍按门禁 paper-only。
- **FS-02（第二批）**：可交易集 42 品种名单就绪；采集器开工前必须落实 §2.3 的基差符号统一与 PIT 快照纪律（两条纪律已写入 ga6-tradable-set.json revisionRiskNotes 与报告）。
- 边界：GA-6 为采集日样例审计（v0），非历史回填；名单在 GA-6 全量历史审计完成后冻结。GA-7 为年份级最小集，完整事件集走 FS-09/M11 路线。
- 未使用任何非允许源；全部为 akshare（生意社）+ 官方公开公告，无 no-source，无伪造。

> 本报告为数据前置执行记录，不构成投资建议。
