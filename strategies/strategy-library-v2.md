# 策略库 v2 —— 理论→模型→策略强绑定（初稿）

> **文件**: `strategies/strategy-library-v2.json`（机器可读）+ 本说明（可读文档）
> **角色**: strategy-librarian（策略库编纂）| **团队**: futures-strategy-library | **任务**: t6
> **日期**: 2026-08-28 | **状态**: 8 条核心策略全部 `designed`（参数待标定初值）
> **输入**: `research/v2/01-macro-theories.md`（t1）、`02-fundamental-theories.md`（t2）、`03-trading-theories.md`（t3）、`04-data-audit.md` + `04-data-contracts.json`（t4）、`05-strategy-library-design.md`（t5 架构设计，**v1.1**）
> **队长批复**: t6 编纂前队长对 t5 架构裁定的最终批复（D1–D11 全部批准，含 D2/D4/D6/D9/D11 细化）已原样写入本文件 §2.3 与 JSON `manifest.captainApproval` / `globalConstraints.GC-1` / `waitlist.entries[FS-P1-02]`
> **设计 v1.1/v1.2 同步**: 05 设计文档并入队长裁定 cap-1..cap-5（§0.4，v1.1）与 t9 F-01 裁定 cap-6（v1.2）后，本库已按最新版编纂：H7（OI 衍生禁入）、X11、MC-8/MC-9/MC-10、全局执行契约 F1–F9、各条目 prerequisites（GA-id 落地门槛）+ asOfContract、TR-03/TR-06 的 OIΔ 条件默认禁用（量价替代）、TR-01/03/06 目标定价概率锥口径（cap-6：Yang-Zhang 锥仅目标）、FS-P1-02 候补池 rejected（cap-1）、复活 4 项 P1 扩展数据基础（cap-2）
> **下游**: t7 宏观视角审查、t8 基本面视角审查、t9 交易员视角审查（三份 findings 已并入本文件，见 §11 t10 修订记录）、t10 修订、t11 数据落地校验、t12 最终验收

⚠️ **免责声明**: 本库为研究初稿，不构成投资建议。全部参数均为待标定初值（非冻结值）；无任何回测收益数字被编造；GA-1..GA-6 数据前置动作完成前，任何条目不得宣称可用。

---

## 1. 定位与来源

本文件是策略库 v2 的**可读说明**，与 `strategy-library-v2.json` 一一对应。JSON 为机器可读条目集（schema `futures-strategy-entry-v2/1`），本文为人工可读解释。二者均严格按 t5 设计文档（`05-strategy-library-design.md`）编纂，未新增任何源文档之外的参数、阈值或收益数字；每条参数/公式均注明源文档编号，供 t7–t9 审查逐项对照。

**分层结构**（t5 §1.1）：

```
分析层（FinCoT / 日报驱动文本）
  作用：方向候选触发器 / 否决过滤器 / 事件识别（TR-06 的 D 判定）
  禁令：不产生任何数值定价（H1）
        │
核心策略层（8 条强绑定单元）
  TR-01 趋势延续 · TR-03 回踩续势 · TR-06 事件确认
  FS-02 基差分位 · FS-04 黑色利润 · FS-05 农产品协整
  M1 流动性冲击 · EC-01 能化成本传导（M4⊕FS-08）
  每条：理论→模型→策略→数据契约→证伪测试，定价封闭在单元内
        │
治理层（非定价）
  G1 risk-regime 过滤器（M5）· G2 波动率 overlay（M6）
  组合纪律（risk-framework Hard 项 + 策略库级敞口规则）
        │
数据层（t4 契约）
  04-data-contracts.json（38 条目、27 源、GA-1..GA-6）
  data/daily · data/macro · data/sector · probability 派生
        │
验证层
  GA 门禁 → purged walk-forward + 三基线 + PF/CI 门槛
  → 逐条证伪测试（策略级 + 理论级）→ 冻结 → 入库 → 持续监控
```

## 2. 七条硬约束（H1–H7）与合成决策（D1–D11）

### 2.0 全局约束字段（GC-1，机读）与全局执行契约（F1–F9）

- **GC-1（FinCoT 只做分析层、不参与定价）**：FinCoT 文本/分析层输出的价位与概率（thesis.odds/confirm/invalidation、Q4 确认文本、报告价位）禁止进入任何止损/目标/仓位计算；confidenceScale 由策略自身 edge 强度档驱动，FinCoT confidence 不进入定价与仓位（D11）。**cap-6 例外**：`probability.json` 的 Yang-Zhang 定量概率锥（3d/5d，由原始 OHLC 经定量管线计算，非 FinCoT 产出）**允许作为目标定价的波动投影边界（仅 p68/p95，且与固定 R 倍数共同构成『先到者』，锥不单独定价），禁止用于止损与仓位**；锥值必须 provenance=probability.json，禁止来自 reasoning-results/FinCoT 文本价位，回测按 T 日及以前数据 PIT 重算（F8 延伸）。作用域：全部核心策略条目 + 治理层 + 组合层；机读校验：MC-2/MC-10。JSON 字段：`globalConstraints.GC-1`。
- **全局执行契约 F1–F9（cap-5，JSON `globalAsOfContract`）**：t4 §5 的 9 项未来函数/时点纪律写进库 schema——F1 信号日 vs 执行日（T 日收盘→T+1 开盘，跳空放弃逐条执行）；F2 宏观锚点 stale/missing（US10Y T-1 降权 0.75、USDCNH change5d=null 须 GA-5、missing 计 0）；F3 月度数据发布日 PIT（M8–M10 候补适用）；F4 库存发布时点（FS-01 候补适用）；F5 换月拼接 PIT（≥9.5% 跳变剔除、per-bar sources）；F6 FinCoT 文本回溯（禁未来重跑）；F7 现货粘性（GA-6 质量门 + PIT 快照）；F8 滚动估计窗口（只用 T 日及以前）；F9 事件日历 discipline（event.date ≤ 锚点日，禁从价格反推事件）。每条策略条目在 `asOfContract[]` 中声明符合性（MC-9）。

### 2.1 硬约束

| # | 约束 | 落位 |
|---|------|------|
| H1 | **FinCoT 只做分析层**：FinCoT 文本/分析层输出的价位与概率（thesis.odds/confirm/invalidation、Q4 确认文本、报告价位）禁止进入任何止损/目标/仓位计算。**cap-6 例外**：probability.json 的 Yang-Zhang 定量概率锥（3d/5d，定量管线计算，非 FinCoT 产出）允许作为目标定价的波动投影边界（仅 p68/p95，与固定 R 倍数共同构成『先到者』，锥不单独定价），禁止用于止损与仓位；provenance 必须为 probability.json，禁止来自 reasoning-results/FinCoT 文本价位 | JSON 每条 `analysisFilter`（probabilityConeUsage）+ MC-2/MC-10 |
| H2 | **定价自模型导出**：止损=理论失效点；目标=edge 衰减点；仓位=edge 强度；定价字段必须引用本条目市场模型方程 | JSON 每条 `pricingModel`（modelRef 指向本条目 formulas）+ MC-1 |
| H3 | **理论/模型/定价不可跨条目混用**：需要联合信息时必须以显式联合模型成为新条目；公共数据层可作状态输入 | JSON `crossModelRefs` + MC-6 |
| H4 | **数据契约绑定**：`dataContract.ref` 必须指向 04-data-contracts.json 条目键；needs-extension 不得入库 | JSON 每条 `dataContract` + MC-4 |
| H5 | **参数纪律**：来源四类（literature / industry-practice / repo-convention / calibration）；初值待标定；证伪通过后冻结；改冻结参数 = 新策略新 ID | JSON 每条 `parameters[]`（source/sourceClass/sourceDoc/freezeCondition）+ MC-3 |
| H6 | **风险框架外层不变**：risk-framework Hard 项（单笔 1% 风险、组合风险 ≤2.5%、组合波动 ≤20%、停板可执行性、回撤阶梯、保证金 ≤33% 等）为全库外层硬约束；唯一修订见 D11 | JSON `portfolioDiscipline` |
| H7 | **OI 衍生禁入（cap-1）**：会员持仓排名/OI 衍生类策略不得进入可执行策略集；FS-P1-02 保留 P1/rejected 留档，待用户明确解禁后重新评估；已入库条目的 OIΔ 条件默认禁用并以量价条件替代（TR-03/TR-06） | JSON `hardConstraints.H7` + X11 + MC-9 + 各条目 `oiDerivativeStatus` |

### 2.2 合成决策（执行 t5 裁定，不得回退）

| 决策 | 内容 | 落位 |
|------|------|------|
| D1 | 核心 8 条：TR-01、TR-03、TR-06；FS-02、FS-04、FS-05；M1、EC-01（全部 available，t4） | manifest.coreStrategyIds |
| D2 | **M4 ⊕ FS-08 合并为 EC-01**：绑定模型取 FS-08 ECM；保留 M4 池资格过滤（β̂≥0.2 且 R²≥0.3）与仓位折价 0.75；合并后 M4/FS-08 不再独立存在 | EC-01 条目（sourceIds 双源 + mergeDecision=D2） |
| D3 | M5/M6 定位为治理层 G1/G2，不计入核心 8 条 | governance.G1/G2 |
| D4 | TR-02、TR-05 不入选核心；TR-05"移交他策略定价"机制在 v2 禁止（X5）——**批复：候补路径只保留自模型定价的 B 模式** | X5 + waitlist |
| D5 | M2、M3、M7 入候补池，保留升级路径 | waitlist |
| D6 | FS-07 入库前提：bootstrap 显著月 ≥3 品种 + 删除跨条目仓位联动条款——**批复：确认删除后才可入库** | waitlist |
| D7 | TR-06 的 FinCoT Q1 历史仅 RB0/M0/SC0：历史 walk-forward 限此 3 品种，全品种靠向前积累 | TR-06 dataContract.validationScopeNote |
| D8 | t4 的 8 项"数据侧复活"证据不自动入库 | waitlist.note |
| D9 | FS-P1-02 会员持仓/OI 衍生策略不进入 v2 可执行集合（**终裁**：rejected_by_policy） | waitlist.entries[FS-P1-02] |
| D10 | X-04 CFTC/EIA 维持不入库（与内盘无直接定价契约） | waitlist.note |
| D11 | **confidenceScale 修订**：仓位缩放一律由策略自身 edge 强度档 + G1/G2 执行；FinCoT confidence 只可作方向否决/降级观察 | H1/D11 + 各条目 position |

### 2.3 队长最终批复（t6 编纂前，已原样写入库文件）

队长对 t5 架构裁定批复：**D1–D11 全部批准**，其中：

1. **D2**：EC-01 = M4 ⊕ FS-08 合并成立（已执行：绑定 FS-08 ECM，保留 M4 池资格过滤与 0.75 折价）；
2. **D4**：v2 禁止 TR-05 的"移交他策略定价"；TR-05 候补路径只保留自模型定价的 B 模式；
3. **D6**：FS-07 必须先删除"与 FS-01 同向才全仓"的跨条目条款，**确认删除后才可入库**；
4. **D9 终裁**：FS-P1-02 会员持仓/OI 衍生策略**不进入 v2 可执行集合**——库内 `status=rejected_by_policy`（reason=OI 纪律），保留完整条目作为 P1 候补池，数据契约照录但 `executable=false`；OI 纪律继续维持，直到用户明确解禁；
5. **D11**：confidenceScale 由策略自身 edge 强度档驱动，FinCoT confidence 不进入定价与仓位。

另按批复：8 条核心策略全部按 available 进入 v2，每条 `prerequisites` 必须引用 GA-1/GA-2 等全局前置动作；MC-1..9 与 X1–X11 在 `strategy-library-v2.json` 中机读（`machineChecks` / `crossStrategyProhibitions`）；"FinCoT 只做分析层、不参与定价"为库内全局约束字段（`globalConstraints.GC-1`）。JSON 落位：`manifest.captainApproval`、`manifest.capRulings`、`globalAsOfContract`、`waitlist.entries[FS-P1-02]`、各条目 `prerequisites`/`asOfContract`。

### 2.4 队长五项裁定 cap-1..cap-5（设计 v1.1 §0.4，全库必须执行，JSON `manifest.capRulings`）

| # | 裁定 | 库内落位 |
|---|------|---------|
| cap-1 | **OI 纪律维持原状，不放开**：FS-P1-02 会员持仓排名/OI 衍生类策略继续不得进入可执行策略集；"OI 衍生禁入"写为库级硬约束 H7；该策略保留 P1/rejected 留档，待用户明确解禁后重新评估 | H7、X11、D9、TR-03/TR-06（OIΔ 条件默认禁用并以量价条件替代）、waitlist.entries[FS-P1-02] |
| cap-2 | **t4 探索复活项采纳**：DFII10、VIXCLS、LME 外盘、人民币金溢价按 found-efficient-source 记录，作为 P1 扩展策略的数据基础（M3 扩展 / G1 交叉验证锚 / M2 沪伦比扩展 / 观察项）；仍需数据接入与质量门，不得直接升 P0 | waitlist.revivalAdoptions |
| cap-3 | **GA-1..GA-6 是"落地门槛"**：available 策略进入可执行集合前必须满足 GA 前置；每条 P0 策略显式标注 `prerequisites=GA-id`，不允许隐式假设数据已就绪 | 各条目 prerequisites、MC-8 |
| cap-4 | **上游声明修正直接采信**：probability.json 仅 KEEP 品种、futures_inventory_em 仅 3 个月、QVIX 2015-02-09 起 11 年可用——修正相关条目口径后再进入库 | governance.G2、waitlist（M13/FS-01） |
| cap-5 | **未来函数审计 9 项纪律（t4 §5 F1–F9）写进库 schema**：作为全局契约字段 | globalAsOfContract、各条目 asOfContract、MC-9 |
| cap-6 | **概率锥口径（t9 F-01 裁定，architect 确认）**：H1 禁止对象修正为 FinCoT 文本/分析层输出的价位与概率；probability.json 的 Yang-Zhang 定量概率锥（3d/5d，定量管线计算，非 FinCoT 产出）属策略自身市场模型的波动率投影，**仅允许用于目标定价（edge 衰减边界，如 3d p95/p68 上/下沿），禁止用于止损与仓位**；锥值必须 provenance=probability.json，回测按 T 日及以前数据 PIT 重算（F8 延伸） | H1、MC-2/MC-10、X1、TR-01/03/06 目标行、TR-03 prerequisites GA-2 |

## 3. 条目状态机与冻结纪律

**状态机**：`designed → in_validation → validated → frozen → (live)`；旁路：`suspended`（停用规则触发：停止新开仓，存量按失效退出）→ `re_evaluation`（结构事件重评估）→ validated/frozen；`retired`（永久退出，留档防复活）。当前 8 条全部 `designed`。

**冻结纪律**（t5 §5.2）：
1. 全部阈值/倍数/窗口为待标定初值，入库前必须先跑完验证流程；
2. 标定只用历史：滚动估计窗口只用信号日 T 及以前数据（F8），禁止按样本内结果调参；
3. 策略级证伪通过 + 理论级证伪未触发 → 参数冻结，写入冻结版本号；
4. 修改冻结参数 = 新条目新 ID，全流程重验；
5. 结构事件（交割规则/政策/工艺/定价机制切换）→ `re_evaluation`；
6. suspended 复活 = 重新标定 + 全部门禁重跑，不接受小幅修参直接恢复。

### 3.1 prerequisites 与 asOfContract 字段说明（cap-3/cap-5）

- **`prerequisites[]`（落地门槛，MC-8）**：每条策略显式列出进入 `in_validation` 前必须完成的 GA 全局前置动作（仅 GA-id）。当前 8 条：TR-01/TR-03/TR-06 → GA-1、GA-2（TR-03 的 GA-2 = 3d p68 锥依赖 probability 派生管线）；FS-02 → GA-1、GA-6（基差历史采集器 PIT 拉取与现货粘性质量门在数据契约条款内）；FS-04/FS-05 → GA-1、GA-7；M1 → GA-4、GA-1、GA-2；EC-01 → GA-1、GA-7（GA-7 = 政策日历 v0，未完成前 G4 冻结不可达；EC-01 附加只允许 paper 验证）。未完成不得宣称数据已就绪，禁止隐式假设（cap-3）。
- **`asOfContract[]`（全局执行契约符合性声明，MC-9）**：每条策略声明对 t5 §2.4 F1–F9 中适用条款的符合性（F1=T+1 执行、F2=宏观锚点 stale/missing、F3=月度发布日 PIT、F4=库存时点、F5=换月拼接 PIT、F6=FinCoT 文本回溯、F7=现货粘性、F8=滚动估计窗口、F9=事件日历 discipline），数组形式、仅 F 编号。当前取值：TR-01/TR-03 → F1、F2、F3、F5；TR-06 → F1、F2、F3、F5、F6；FS-02 → F1、F2、F3、F7；FS-04/FS-05/EC-01 → F1、F2、F3、F8、F9；M1 → F1、F2、F3、F8。
- **schema 字段说明**：以上两个字段为 schema v2 全局必填字段（与五段并列）：`prerequisites[]` = 数据落地门槛（GA-id），未完成不得进入 `in_validation`（cap-3/MC-8）；`asOfContract[]` = 对全局执行契约 F1–F9 的符合性声明（cap-5/MC-9）。JSON 中每条策略均含二者，MD 八策略矩阵亦有 asOfContract 列。

## 4. 核心策略 8 条

> 每条均为不可拆分的强绑定单元：**① 核心理论（可证伪命题）→ ② 市场模型（状态变量/公式/条件分布）→ ③ 策略（入场=模型确认区、止损=理论失效点、目标=edge 衰减点、仓位=edge 强度）→ ④ 数据契约（引用 t4）→ ⑤ 证伪测试**。定价封闭在单元内（pricingSource=self-model），FinCoT 仅出现在 analysisFilter（H1）。

### 4.1 TR-01 趋势延续（状态过滤版）【交易系统】· 证据 A− · 契约 TR-01 · GA-1/2

- **理论（t3 §1.1）**：H0：突破+量能确认子样本与"无确认突破"子样本收益无差异；H1：U 态中 `E[r_{t+h} | sign(r_{t−L,t})=+, s_t=U] > 0` 且随 h 衰减（动量半衰期）。机制：信息扩散缓慢 + 正反馈资本再配置 + 风险转移。
- **模型（t3 §1.2）**：`s_t∈{U,D,C}`（close>MA20>MA60 ∧ 斜率 g_t≥+0.3%/日）；`r_{t+h}|s_t=U ~ N(μ_U·f(h), σ_t·√h)`，f(h) 半衰期 5–10 日；失效事件 `F_t` = 收盘回破突破位 0.5×ATR5 ∨（量比≥1.5 ∧ 收盘<MA20−0.5×ATR5）。
- **策略（t3 §1.3）**：入场 = U 态 ∧ 收盘突破 20 日高/低 ∧ 量比≥1.2 → T+1 开盘（跳空>0.5×ATR5 放弃）；止损 = `min(入场∓1.5×ATR5, 突破前 3 日极值∓0.25×ATR5)` 取近（=F_t 前置版）；目标 = T1 2R 平 50% / T2 3R 或 3d p95 [cap-6：锥=Yang-Zhang 波动投影，provenance=probability.json，与固定 R 倍数构成『先到者』] / 余仓 2×ATR5 移动止损 / 10 日未触 T1 全平；仓位 = |g_t|∈[0.3%,0.6%)→0.5R，≥0.6%→1R（edge 强度档）；加仓最多 2 次，**加仓后单品种总风险 ≤2R、组合风险 ≤2.5% 权益不变、加仓单止损同步上移（t9 F-11）**。
- **数据**：`04-data-contracts.json → TR-01`（available）；data/daily（OHLCV+volume+turnover，库内派生 MA/ATR/量比；**OI 字段不使用，H7**）；**prerequisites（cap-3）**：GA-1、GA-2；**asOfContract**：F1、F2、F3、F5。
- **证伪（t3 §1.6）**：策略级 ≥200 笔、purged expanding walk-forward（预注册）、PF≥1.2、95% CI 不含 0、三基线、扣成本 0.07%；理论级："突破+量比≥1.2"子样本扣成本收益 ≤ "无确认突破"子样本 → retired。
- **参数**（全部待标定，冻结条件=策略级证伪通过）：MA20/60 对齐+EMA20 斜率（repo-convention，库内 v1 口径）；g_t 档位 0.3%/0.6%（industry-practice，t3 §1.2）；量比 1.2/1.5/0.8（industry-practice）；止损/跳空 1.5/0.25/0.5×ATR5（repo-convention，risk-framework stopK=1.5）；R 档 0.5/1R、T1=2R、T2=3R、10 日（industry-practice，t3 §1.3）。

### 4.2 TR-03 趋势回踩续势（趋势+OU 噪声分解）【交易系统】· 证据 B · 契约 TR-03 · GA-1/2

- **理论（t3 §3.1）**：H0："回踩+反转确认"与"回踩无确认"收益无差异；H1：U 态回踩至 MA20 带后反转确认 K 时 `E[r_{t+h}] > 0`，优势来自噪声回归项 θ·|x_t|，随 x_t→0 耗尽。机制：趋势慢变量 c_t + 流动性冲击快变量 x_t（OU 回归）；止损距离必须 ≤1.5R，否则噪声 edge 覆盖不了成本。
- **模型（t3 §3.2）**：`p_t = c_t + x_t`；`dx_t = −θ·x_t dt + σ·dW_t`，`E[x_{t+h}|x_t]=x_t·e^{−θh}`；回踩条件 low_t ≤ MA20+0.25×ATR5，反转确认 close_t > high_{t−1}，量比 0.8–1.5；失效 F_t（本条独立计算）：放量（≥1.5）跌破 MA20−0.5×ATR5；`E[r_{t+1}|回踩∧确认] = μ_c + θ·|x_t|·e^{−θ} − 成本`。
- **策略（t3 §3.3）**：入场 = U 态 ∧ 触带 ∧ 确认 K → T+1 开盘（跳空>0.75×ATR5 放弃）；止损 = 回踩极值∓0.25×ATR5，**距离>1.5R 放弃该笔**；目标 = T1 前波段高/低或 3d p68 [cap-6：锥=Yang-Zhang 波动投影，provenance=probability.json] 平 50% / T2 2R–3R / 余仓 1×ATR5 移动 / 8 日时间止损；仓位 = |x_t|/ATR5∈[0.5,1)→0.5R，≥1→1R。**[H7]** 原 OIΔ ±2% 条件默认禁用——逼仓保护改由"空头距涨停 < 1×ATR5 禁开"承担（risk-framework Hard），待用户明确解禁后按 t3 原设计恢复。
- **数据**：`04-data-contracts.json → TR-03`（available）；data/daily（MA/ATR/量比库内派生；**OIΔ 字段禁用，H7**）+ probability.json 3d 锥（cap-6，仅目标定价）；**prerequisites（cap-3）**：GA-1、GA-2（GA-2：3d p68 锥依赖 probability 派生管线）；**asOfContract**：F1、F2、F3、F5。
- **证伪（t3 §3.6）**：策略级 ≥200 笔、walk-forward、PF≥1.2、三基线；理论级：①"回踩+确认"≤"回踩无确认"→ retired；② 止损距离>1.5R 子样本 PF<1 → 收紧门槛后重验，仍不达标 retired；连续 2 滚动窗口命中<50% → suspended。
- **参数**（industry-practice，t3 §3.3，待标定）：MA20 带 0.25×ATR5、量比 0.8–1.5/1.5、止损 0.25×ATR5、1.5R 距离门、跳空 0.75×ATR5、8 日、R 档 0.5/1。[H7] OIΔ ±2% 条件禁用，解禁前不列入参数集。

### 4.3 TR-06 事件冲击确认（持久信息 vs 瞬时情绪分解）【交易系统】· 证据 B · 契约 TR-06 · GA-1/2

- **理论（t3 §6.1）**：H0：事件日当日追入与延迟入场样本外收益差 < 0.5R；H1：事件 D（|r_D|≥max(2×ATR5,3%) ∧ 量比≥2 ∧ 可识别驱动）后冲击分解为 `A·e^{−λk}+S·e^{−γk}`（γ≫λ），确认式/回踩式入场对持久分量捕获优于当日追入（优势≥0.5R）。机制：Hong & Stein 1999（反应不足→漂移/过度反应→回吐）；Kilian 2009（供给冲击持续、需求冲击易反转）。
- **模型（t3 §6.2 + v1.1 H7）**：事件判定 D 三条件（Q1 驱动文本 = FinCoT 分析层，仅作事件识别过滤，不进入定价）；持久分量确认 = close_{D+1..D+2} > high_D ∧ **量比持续 ≥1.2**（资金进场代理；[H7] 原 OIΔ≥+2% 条件默认禁用，待解禁恢复 t3 原设计）；回踩变体 = 回撤≤事件区间 50% ∧ 2 日站稳中点上方；失效 = 收盘回到事件前 5 日区间（A=0）；[H7] "多头 OIΔ 转负"失效条件默认禁用。
- **策略（t3 §6.3 + v1.1 H7）**：确认式 (a) 次日开盘 / 回踩式 (b) 第 3 日开盘；跳空>0.75×ATR5 放弃；止损 = low_D−0.25×ATR5（a）/ 中点−0.25×ATR5（b）；目标 = T1 3d p95 [cap-6：锥=Yang-Zhang 波动投影，provenance=probability.json] 平 50% / T2 2×事件区间投影或 3R；8 日时间止损；仓位 = 0.5–1R（|r_D|/ATR5 分档）；加仓 = 浮盈≥1R 且量比维持≥1.2 [H7 替代] → +0.5 单位；持有 2–8 日。多空对称，空头距涨停 <1×ATR5 禁开；[H7] OIΔ 确认/失效条件默认禁用。
- **数据**：`04-data-contracts.json → TR-06`（available）；data/daily（事件判定+量比库内派生；**OIΔ 字段禁用，H7**）+ FinCoT Q1（分析层过滤）；**prerequisites（cap-3）**：GA-1、GA-2；**asOfContract**：F1、F2、F3、F5、F6；**验证范围（D7）**：历史 walk-forward 限 RB0/M0/SC0（F6 禁未来重跑回填）。
- **证伪（t3 §6.6）**：策略级 ≥100 笔（事件稀疏）、walk-forward、PF≥1.2、三基线；理论级：当日追入 vs 延迟入场收益差 <0.5R → λ/γ 区分被证伪 → retired；滚动 24 个月事件样本<30 → 自动停用。
- **参数**（industry-practice，t3 §6.3，待标定）：事件判定 max(2×ATR5,3%)、量比 2（确认/加仓持续 ≥1.2 [H7 替代]）、回撤 50%、8 日、R 档 0.5–1、跳空 0.75×ATR5。[H7] OIΔ +2% 条件禁用，解禁前不列入参数集。

### 4.4 FS-02 基差分位回归（现货–期货收敛）【基本面】· 证据 B · 契约 FS-02 · 采集器+GA-6+GA-1

- **理论（t2 §FS-02）**：F1：基差率 br=(S−F)/S 平稳回归，|z|≥1.5 后 20 日内向 180 日中枢回归概率显著 >0.5（Kaldor 1939 / Working 1949；Fama & French 1987）；F2：深贴水端收敛以期货向现货靠拢为主（做多期货），深升水端反向，**不对称性本身纳入证伪**。
- **模型（t2 §FS-02，t8 F-1 比率域修正）**：`br_t=(S−F)/S`（dom_basis_rate，无量纲比率域）；启动锚 `μ̂=b̂_mean/S_t`、`σ̂=(b̂_hi−b̂_lo)/(4×S_t)`（180 日绝对带转比率域）；正式口径 = 基差历史库积累 ≥180 日后改用 dom_basis_rate 序列直接估计 μ̂/σ̂；`z_t=(br_t−μ̂)/σ̂`；signal ±1 at |z|≥1.5；目标价 `F_target = S_t×(1−μ̂)`（比率域 μ̂，模型导出）。
- **策略（t2 §FS-02）**：只做期货腿；入场 = 触发 + 现货质量门 + |z| 未加速走扩（连续 3 日递增→等待企稳）→ T+1 开盘（跳空>1×ATR5 放弃）；止损 = br 反向走扩 0.5σ̂ 或 1.5×ATR5（基于期货腿入场价；br 止损现货取 T 日盘后快照）先到先平；目标 = F_target 或 20 日退出；仓位 = |z|∈[1.5,2.5)→0.5R、≥2.5→1R（edge 档，待标定）+ G2 overlay + 1R 预算；距交割<20 交易日不交易。FinCoT 方向冲突 → 观察。
- **数据**：`04-data-contracts.json → FS-02`（available）；futures_spot_price_daily（2011+，**PIT 拉取 F7**，采集器须存 dom_basis_rate 比率序列）+ futures_spot_price_previous（180 日分布锚，绝对带转比率域）；**prerequisites（cap-3）**：GA-1、GA-6（基差历史批量采集器 PIT 拉取 + 现货粘性质量门 30 日零变动>40% 剔除）；**asOfContract**：F1、F2、F3、F7。
- **证伪（t2 §FS-02）**：(a) 20 日收敛命中率<55% → 证伪 F1；(b) 期货端收益（扣 0.07%）组合夏普<0.5 → 停用；(c) 深贴水/深升水不对称性不显著 → 双侧改对称。**已知反面证据**：2022 伦镍、2024 氧化铝逼仓（基差极端继续走扩，止损硬执行）。
- **参数**：z ±1.5（industry-practice，待验证）、σ̂ 启动锚 (b̂_hi−b̂_lo)/(4×S_t)、≥180 日后 dom_basis_rate 序列估计（calibration，t8 F-1）、止损 0.5σ̂、20 日、质量门 40%、交割 20 日、edge 档 |z| 1.5/2.5（t9 F-06 待标定）。

### 4.5 FS-04 黑色产业链利润分位（利润→开工→供需再平衡）【基本面】· 证据 B · 契约 FS-04 · GA-1/7

- **理论（t2 §FS-04）**：F1：钢厂利润代理 z≤−2 后 40 日向中枢回归，且由产品端（RB）弹性驱动（减产→供给收缩→成材修复）；F2：z≥+2 复产→利润与成材回落。前提：利润→开工传导链未被政策打断（政策日历作前提开关，数据输入非定价输入）。
- **模型（t2 §FS-04 + t8 F-3）**：`π_t = P_RB − (β̂1·P_I + β̂2·P_J)`（OLS 标定 2016–2026 日频，π=残差；先验权重 (1.6,0.5) 仅初始值）；`z_t=(π_t−μ̂_250)/σ̂_250`；signal ±1 at z≤−2/z≥+2；目标价 `P_RB,target = P_RB − z_t×σ̂_250`；焦化 πJ = P_J − 1.33×P_JM（同构）；**F5 平稳性门（t8 F-3）**：滚动 250d 残差 ADF p>0.05 → 该品种组停用（重估窗口）。
- **策略（t2 §FS-04）**：z≤−2 → 多 RB（容量允许时 RB 多/(β̂1·I+β̂2·J) 空组合，启用时按组合风险预算另行核算）；z≥+2 → 空 RB；焦化对称；入场 = 触发 + RB close≥MA20 → T+1 开盘（跳空>1×ATR5 放弃）；止损 = z 反向扩 0.5 或 RB 1.5×ATR5；目标 = P_RB,target / 40 日退出；仓位 = |z|∈[2,3)→0.5R、≥3→1R（edge 档，待标定）+ G2 + 1R 预算；政策日历"粗钢产量调控/能耗双控"生效期暂停新开仓（前提开关，执行层）。
- **数据**：`04-data-contracts.json → FS-04`（available）；data/daily/{RB0,I0,J0,JM0,HC0}；**prerequisites（cap-3）**：GA-1（I/J/JM/HC 补至 ≥3 年）、GA-7（政策日历 v0，未完成前 G4 冻结不可达）；**asOfContract**：F1、F2、F3、F8、F9；政策日历（人工 YAML，前提开关）为冻结前必装组件（其证伪测试 (d) 裁定）。口径声明：真实钢厂利润依赖 Mysteel → 剔除，只用价格代理。
- **证伪（t2 §FS-04）**：(a) 40 日回归概率≤55% → 证伪 F1/F2；(b) 多 RB 单边扣成本夏普<0.5 → 停用；(c) 原料腿驱动样本>40% → 单边改双腿；(d) 政策窗口（2016–2017 供给侧、2021 粗钢压减、2025 调控）显著劣于全样本 → 政策过滤必装。**已知反面证据**：2021H2 焦煤暴涨（深亏 6+ 月不修复）；2014–2015 需求坍塌（成本支撑失效）。
- **参数**：先验权重 (1.6,0.5)/焦化 1.33（industry-practice，待 OLS 标定替换冻结）、窗口 250d、z ±2、止损 0.5z/1.5×ATR5、40 日、平稳性门 ADF p>0.05（calibration，t8 F-3）、edge 档 |z| 2/3（t9 F-06 待标定）。

### 4.6 FS-05 农产品压榨/替代价差回归（协整 OU）【基本面】· 证据 B · 契约 FS-05 · GA-1/7

- **理论（t2 §FS-05）**：F1：替代需求与压榨经济性使价差存在长期均衡（协整），偏离后 20 日内回归，双驱动；F2：政策/贸易结构变化造成价差中枢**永久性迁移**——结构断裂必须先于交易被识别（断裂门是模型组成部分，不是事后解释）。
- **模型（t2 §FS-05）**：Engle-Granger 两步 `P_1 = α̂ + β̂·P_2 + e_t`（滚动 250d，冻结后使用）；`z_t=(e_t−μ̂_e)/σ̂_e`；signal ±1 at |z|≥2；**结构断裂门（模型自带）**：60d 残差 ADF p>0.10 或 β̂ 变化>2σ̂_β → 该对停用。
- **策略（t2 §FS-05）**：双腿回归按 e 符号定多空；入场 = |z|≥2 + 断裂门通过 + 两腿距交割>20 日 → T+1 两腿同步开盘（任一腿跳空>0.5×ATR5 放弃，保价差结构）；止损 = |z| 反向扩 0.5 或触 3σ̂ / 单腿逼仓全平；目标 = z→0 双边平或 **20 日时间退出**（与 F1 时窗一致，先到先平）；仓位 = |z|∈[2,2.5)→0.5R、≥2.5→1R（edge 档，待标定）+ G2 + 1R（按双腿价差计），双腿成本 0.14%；贸易/储备事件生效期暂停（前提开关，执行层）。
- **数据**：`04-data-contracts.json → FS-05`（available）；data/daily/{M0,RM0,Y0,P0,OI0,C0,CS0}；**prerequisites（cap-3）**：GA-1（≥5 年为正式标定门槛；初期 2 年数据仅作降级观察运行，不得视为 validated）、GA-7（政策日历 v0）；**asOfContract**：F1、F2、F3、F8、F9。品种对：M−RM、Y−M、Y−P（低置信）、OI−Y、C−CS。
- **证伪（t2 §FS-05）**：(a) 滚动协整通过率<70% → 剔除该对；(b) 组合扣成本（0.14%）夏普<0.5 或命中<55% → 停用；(c) M−RM 专项：2019/2023 断裂未被捕捉（>2 次 3σ 止损）→ 修订断裂门，仍不达标 → 该对永久停用。**已知反面证据**：2019 M−RM 中枢永久上移；Y−P 仅断裂门连续 90 日 100% 才允许交易。
- **参数**：滚动 250d、z ±2/±3、断裂门 ADF p>0.10、β̂ 变化 2σ̂_β、60d 残差窗、时间止损 20 日（t2 §FS-05 修正版 / t9 F-07）、edge 档 |z| 2/2.5（t9 F-06 待标定）。

### 4.7 M1 DR007 流动性冲击（信用渠道 → 国内需求型板块）【宏观】· 证据 中-高 · 契约 M1 · GA-1/2/4

- **理论（t1 §M1）**：H0：DR007 5 日突变与黑色板块未来 1–2 周收益无关；H1：收紧冲击（Δ5d ≥ +0.5pp）后 10 日收益系统性为负，宽松冲击（≤ −0.5pp）后为正。机制：信用渠道/流动性溢价——DR007 是央行政策姿态最高频观测，经融资成本传导至地产-基建链需求预期。
- **模型（t1 §M1）**：`s_t = Δ5d DR007_t`（FDR007 定盘；扩展态 g_t=DR007−r* 为 needs-extension，P0 不用）；`E[r_{i,t+1:t+10}|s_t] = α_i + β_i·s_t`，预期 β_i<0（黑色 + SA/FG）；方向门禁（模型自带确认区）：价格 close≤MA20 且 ≤MA60 才空，多头对称。
- **策略（t1 §M1，t9 F-03 修订）**：s≥+0.5pp 且破 MA20/MA60 → 空 {黑色（RB0/HC0/J0 取 |β̂| 最强 1 个）+ 建材（SA0/FG0 取 |β̂| 最强 1 个）}；s≤−0.5pp 且站上 → 多；|s|<0.5pp 中性；T+1 开盘（跳空>1×ATR5 放弃）；止损 1.5×ATR5；目标 2.0×ATR5 或 |s_t|<0.3pp（冲击消化）先到（风险收益比 1:1.33）；仓位 `scale = clamp(σ_target/max(hv,0.05),0.2,1.0) × min(1,|s_t|/1.0)`，σ_target 默认 0.15（已内置波动缩放，G2 不重复套用）。**篮子豁免**：篮子总风险合计 ≤1R、并发计数按 1 个仓位计；同板块 ≤1 由池内最强品种规则保证。无任何 FinCoT odds 参与。
- **数据**：`04-data-contracts.json → M1`（available）；DR007（repo_rate_hist FDR007；GA-4 按年分批回填：FDR007 2017-05-31+/FR007 2015+ 代理；**拼接纪律**：walk-forward 只用 FDR007 段，FR007 段仅用于 2015–2017 粗标定且拼接点 ±20 交易日剔除）；黑色/SA/FG 日线；ATR5/HV；**prerequisites（cap-3）**：GA-4、GA-1、GA-2；**asOfContract**：F1、F2、F3、F8（T 日收盘冻结，无未来函数）。
- **证伪（t1 §M1，t7 E 修订）**：walk-forward 2019-01–2026-08 滚动 12 个月窗口"冲击后 10 日方向命中率"；命中率≥55% 且单尾 p<0.10，**达标窗口占比 ≥60%**（预注册口径，对齐 G3）；连续 2 窗口<50% → 冻结该品种方向映射；全池<50% → 整体停用回炉 β 标定；**2023 前后分段报告**（利率与地产链脱钩风险）。
- **参数**：阈值 0.5pp/0.3pp、1.5×ATR5 止损、2.0×ATR5 目标、σ_target 0.15、clamp 0.2–1.0（来源 t1 §M1，待标定）。

### 4.8 EC-01 能化成本传导误差修正（M4 ⊕ FS-08，D2 合并）【宏观/成本】· 证据 C · 契约 FS-08 · GA-1/7

- **理论（t1 §M4 ⊕ t2 §FS-08）**：F1：原油是油化工成本锚，产品价与 SC 价协整，短期偏离通过产品端以 ECM 回归（γ 显著 <0）；F2：|z|≥2 后 20 日内产品价向成本锚回归，**回归由产品端承担**（SC 端受外盘主导，不构成可交易回归腿——t4 确认 SC 无库存/基差数据，产品腿单边结构是正确取舍）。
- **模型（t2 §FS-08 绑定；t1 §M4 资格过滤并入，t7 A 修订）**：协整 `P_prod = α̂ + β̂·P_SC + e_t`（滚动 250d，水平口径）；ECM `ΔP_prod,t = γ·e_{t−1} + Σβ_j·ΔP_SC,t−j + ε_t`，**γ<0 且 p<0.05 为启用前提**（模型级可证伪门）；池资格测试：**M4 对数口径独立运行**（log P_prod ~ log P_SC 滚动 250d OLS，β̂≥0.2 且 R²≥0.3，阈值来源 t1 §M4），绑定 ECM 为水平口径，两口径不混用（H3/X3）；signal −1 if z≥+2 / +1 if z≤−2；目标价 `P_target = α̂ + β̂·P_SC,t + μ̂_e`（模型导出）。
- **策略（t2 §FS-08，t7 C 修订）**：只做产品腿（不裸做 SC）；入场 = |z|≥2 + γ 门 + 产品 close≥MA20 → T+1 开盘；止损 = e 反向扩 0.5σ̂_e 或 1.5×ATR5（**M4 的 |z|≥3σ_z 止损随对数口径一并废弃，绑定模型切换 D2**，防双口径止损混用）；目标 = P_target / 20 日退出；仓位 = 通用预算 ×0.75（回归策略折价，来源 M4）；隔夜保护：产品次日开盘跳空>1×ATR5 不新开仓，已持仓跳空反向按止损硬执行；**MA 不入集**（煤化工成本锚是煤，保持模型内一致性）。
- **数据**：`04-data-contracts.json → FS-08`（available；M4 池资格过滤并入本条）；data/daily/{SC0,TA0,EG0,PP0,L0,EB0,BU0,FU0,PG0,PX0}；**prerequisites（cap-3）**：GA-1（标定需 ≥750 日）、GA-7（政策日历 v0）；**asOfContract**：F1、F2、F3、F8、F9；滚动 OLS/ECM 只用 T 日及以前（F8）。**激活前置（t7 B）**：GA-7 未建成期间 EC-01 只允许 paper 验证、禁止 live 开仓。
- **证伪（t2 §FS-08）**：(a) 残差 ADF p>0.05 或 γ≥0 → 该对证伪；(b) 扣成本夏普<0.5 → 停用；(c) 隔夜跳空亏损>30% → 加隔夜过滤，仍>30% → 停用；2020 负油价（条款溯源：t5 设计文档 §EC-01）/2022 俄乌段单列报告不参与参数估计 + FS-09 事件日历联动暂停。**已知反面证据**：2022 俄乌段 SC 暴涨而化工品跟涨滞后（ECM 长时偏离）。
- **参数**：滚动 250d、z ±2、γ 显著性 p<0.05、止损 0.5σ̂_e/1.5×ATR5、20 日、池资格 β̂≥0.2 且 R²≥0.3、标定 ≥750 日、仓位折价 0.75（来源 t1 M4 / t2 FS-08，待标定）。

### 4.9 核心策略汇总矩阵

| ID | 族 | 核心理论 | 市场模型 | 入场=确认区 | 止损=理论失效点 | 目标=edge 衰减点 | 仓位=edge 强度 | 证据 | 契约 | GA | asOf |
|----|----|---------|---------|------------|----------------|-----------------|---------------|------|------|-----|
| TR-01 | 交易 | 反应不足+正反馈→动量衰减 | r\|U ~ N(μ_U·f(h),σ√h) | U态+突破+量比≥1.2 | F_t 回破/放量破 MA20−0.5ATR | 2R→3R/p95[cap-6] | \|g_t\| 档 0.5–1R | A− | TR-01 | 1/2 | F1/F2/F3/F5 |
| TR-03 | 交易 | 趋势漂移+OU 噪声回归 | p=c+x，x·e^{−θh} | U态+触带+确认K | 放量破 MA20−0.5ATR | 前高/p68[cap-6]→2–3R | \|x\|/ATR5 档 | B | TR-03 | 1/2 | F1/F2/F3/F5 |
| TR-06 | 交易 | 事件冲击=持久+瞬时分解 | A·e^{−λk}+S·e^{−γk} | >high_D+量比≥1.2[H7] | 回到事件前区间(A=0) | 3d p95[cap-6]→2×区间/3R | \|r_D\|/ATR5 档 | B | TR-06 | 1/2 | F1/F2/F3/F5/F6 |
| FS-02 | 基本面 | 基差=便利收益−持有成本 | z=(br−μ̂_180)/σ̂ | z≥1.5+质量门+无走扩 | br 反向扩 0.5σ̂ | S×(1−μ̂_180) | 通用预算 | B | FS-02 | 采集器+6 | F1/F2/F3/F7 |
| FS-04 | 基本面 | 利润→开工→供需再平衡 | π 残差 z_250 | z≤−2+MA20 | z 反向扩 0.5 | P−z×σ̂_250 | \|z\| 档 0.5–1R | B | FS-04 | 1/7 | F1/F2/F3/F8/F9 |
| FS-05 | 基本面 | 替代/压榨→协整均衡 | EG 协整 z，断裂门 | \|z\|≥2+断裂门通过 | 3σ̂/β̂断裂 | z→0/20日 | \|z\| 档 0.5–1R | B | FS-05 | 1/7 | F1/F2/F3/F8/F9 |
| M1 | 宏观 | 信用渠道流动性冲击 | β·Δ5dDR007+均线确认 | s≥0.5pp+破MA20/60 | 冲击消化 s<0.3pp/1.5ATR | 2×ATR5/消化 | σ缩放×\|s\|档 | 中-高 | M1 | 4/1/2 | F1/F2/F3/F8 |
| EC-01 | 成本 | 成本锚+误差修正 | ECM γ<0，z=(e−μ̂)/σ̂ | \|z\|≥2+γ门+MA20 | e 反向 0.5σ̂_e | α̂+β̂P_SC+μ̂_e | 预算×0.75 | C | FS-08 | 1/7 | F1/F2/F3/F8/F9 |

## 5. 治理层（非定价，X10）

> G1/G2 只做过滤/缩放/否决，不产生方向、不产生止损/目标/仓位数值。失效即退化回"无过滤原样执行"，不影响任何核心策略自身的定价链。

**G1 风险偏好 regime 过滤器（t1 §M5）**：五锚点 `R_t = Σ 1(条件)`：① DXY.change5d<0；② US10Y.change5d<+0.20pp；③ USDCNH.change5d<0；④ DR007<2.0% 且 change5d<+0.5pp；⑤ SC0.change5d>−1%。R≥3 → 顺周期多头满仓/空头半仓；R≤1 → 禁多头新仓；1.5<R<3 → 全半仓；极端预警（US10Y.change5d≥+0.25pp 或 DXY.change5d≥+1%）→ 全部 regime 依赖仓位提前降半。契约 M5（available；GA-4/GA-5；stale 锚计 0.75、missing 计 0）。证伪：6 个月窗口 R≥3 期多头命中率 vs 无过滤基线提升 ≥5pp；连续 2 窗口无提升 → 停用过滤；锚点相关性 24 月滚动符号翻转 → 剔除重标定。

**G2 波动率目标 overlay（t1 §M6，与 risk-framework §2 同源）**：`scale_i = clamp(σ_target/max(σ_i,t,0.05), 0.2, 1.0)`，σ_target 默认 0.15；divergence<10% 全 scale、10–20% ×0.75、>20% 或 hv.degraded ×0.5（**『止损改 ATR5 口径』仅适用于以 ATR5 计价的条目（TR-01/TR-03/TR-06/M1）；以 σ̂/σ̂_e 计价的条目（FS-02/FS-05/EC-01）当日禁开新仓，不改变其止损口径——t9 F-05，X10**）；volPercentile≥85 减半且仅高 edge 档、≥95 scale≤0.5；单仓波动贡献目标 10%（5–15%）、组合波动 ≤20% Hard。契约 M6（available；GA-2）。**口径修正（cap-4）**：probability.json 每 run 仅覆盖 KEEP 品种 1–3 个，全品种 hv/volPercentile 依赖 GA-2 批量 runner，未运行前 G2 只对已有品种生效。证伪：固定仓位 vs scale 缩放两臂 24 个月，缩放臂夏普不优于固定臂 → 退回固定仓位（保留 volPercentile≥95 硬减仓）。

**组合层纪律**（v1 risk-framework Hard 项 + 策略库级）：单笔 1R≤权益 1.0%；组合风险 ≤2.5%；组合波动 ≤20%；并发 ≤3（同板块 ≤1）；保证金 ≤33%；停板可执行性（止损距离 ≤0.8×涨跌停幅度等）；**长假/隔周（t9 F-02 提升为 Hard 项）**：长假（≥3 日休市）前最后交易日收盘前保证金占用降至 20% 以下或平仓；周一开盘跳空 >0.5×ATR5 按条目失效/重估条款处理，不追价；回撤阶梯 5%/8%/12%；**趋势族同向敞口合并**（TR-01 与 TR-03 同品种同向合计只占 1 份单笔风险预算——风险聚合，不是模型混用）；事件样本门禁（TR-06 滚动 24 月<30 → 自动停用）；事件日历联动暂停（FS-04/FS-05/EC-01 各自条款）；**M1 篮子豁免（t9 F-03）**：黑色/建材各取 |β̂| 最强 1 个，篮子总风险合计 ≤1R、并发按 1 个仓位计；持有期优先级（条目冻结口径优先于 maxHoldingDays=5 通用缺省，但不得突破 Hard 项）。

## 6. 禁止混用清单（X1–X11）与允许交互

**禁止**：X1 FinCoT 文本/分析层输出的价位与概率（thesis.odds/confirm/invalidation、Q4 确认文本、报告价位）进入止损/目标/仓位计算；概率锥进入止损或仓位、或进入目标但其 provenance 非 probability.json（cap-6）（MC-2 + MC-10）；X2 跨条目借参数（MC-6）；X3 EC-01 的 α̂/β̂/γ 不得外借，M4/FS-08 合并后不再独立存在；X4 TR-03 的 θ 不得用于 TR-01 的 f(h)；X5 "移交他策略定价"机制禁止（MC-1）；X6 FS-07 跨条目仓位联动条款删除（D6）；X7 M10 象限模型与 M5/G1 五锚点不得互相替代标定；X8 价差类策略不得引入契约之外数据作定价输入；X9 公共数据层白名单外数据不得作状态输入（白名单 = data/daily、data/macro 锚点、data/sector、event-calendar、probability 派生字段、数据契约声明采集源）；X10 G1/G2 只可缩放/否决（MC-1）；**X11 OI 衍生禁入（cap-1/H7，MC-9）**：任何以 OI 衍生量（会员持仓排名、OIΔ 等）为核心前提、定价输入或信号条件的策略不得入库或进入可执行集；FS-P1-02 保留 P1/rejected，待用户明确解禁；已入库条目的 OIΔ 条件默认禁用并以量价条件替代（TR-03/TR-06）。

**允许**：公共数据层读取；治理层过滤/缩放；组合层风险聚合；事件日历作模型前提开关（FS-04/FS-05/EC-01）；FinCoT 方向候选触发/否决/事件识别（H1）；probability.json Yang-Zhang 定量概率锥作为目标定价的波动率投影（仅 edge 衰减边界，cap-6）。

## 7. 数据契约与验证入库流程

- **契约绑定**：8 条 dataContract.ref 依次为 TR-01、TR-03、TR-06、FS-02、FS-04、FS-05、M1、FS-08，全部 status=available（MC-4 通过）。
- **全局前置 = 落地门槛（cap-3）**：GA-1 全历史回填 → GA-2 全品种 ATR5/HV/HV%ile 批量 → GA-3 板块序列重建 → GA-4 宏观锚点回填 → GA-5 USDCNH change5d 修复 → GA-6 现货粘性质量门（仅 FS-02）→ **GA-7 政策日历 v0（年份级事件窗口标注；FS-04/FS-05/EC-01 冻结前置，t8 F-2/t7 B 新增）**。available ≠ 数据已就绪，禁止隐式假设；每条目 prerequisites（GA-id）未完成不得进入 in_validation（MC-8）。
- **全局执行契约（cap-5）**：F1–F9 未来函数/时点纪律（见 §2.0）——每条条目 asOfContract[] 声明符合性（MC-9），验证层按契约逐项执行。
- **门禁链（G1→G6）**：契约满足（MC-4 + MC-8）→ purged expanding walk-forward（预注册；T 日收盘信号/T+1 开盘；跳空放弃逐条执行；三基线；成本 0.07%/双腿 0.14%；换月 ≥9.5% 剔除）→ 策略级（≥200 笔，事件类 ≥100；PF≥1.2；95% CI 不含 0；多数年份为正）→ 理论级证伪（任一成立 → retired）→ 冻结 → 入库 → 持续监控。
- **入库顺序**：第一批 TR-01/TR-03/FS-04/FS-05/M1/EC-01（GA-1/2/4/GA-7 后）；第二批 FS-02（+基差采集器+GA-6）；第三批 TR-06（FinCoT 历史向前积累，限 RB0/M0/SC0 起步）；G1/G2 与第一批并行验证。

## 8. 候补池指引（不编入核心 manifest）

候补池 22 条（M2/M3/M7/M8/M9/M10/M11/M12/M13、FS-01/03/06/07/09/FS-P1-01..05、TR-02/04/05/07/08）逐条缺口与升级路径见 `05-strategy-library-design.md` §8。升级 = 数据契约转 available + 完整五段 + 全流程证伪通过方可申请入库。**t4 复活证据 8 项不自动入库（D8）**；维持剔除项防复活留档见 t5 §8。

**队长批复落位（JSON `waitlist`，v1.1 口径）**：
- **TR-05（D4）**：v2 禁止"移交他策略定价"；候补路径只保留**自模型定价的 B 模式**（A 模式停用）。
- **FS-07（D6）**：必须先删除"与 FS-01 同向才全仓"跨条目条款，**确认删除后才可入库**。
- **FS-P1-02 会员持仓蜘蛛网（cap-1/H7，候补池改标 rejected）**：不进入 v2 可执行集合，**不得编入任何可执行条目**。库内完整条目：`status=rejected_by_policy`（poolMark=rejected（cap-1，v1.1 §8 候补池口径））、`executable=false`、数据契约照录（get_rank_sum_daily SR-20，2000+ 实测可用，阻塞=OI 纪律）、保留为 P1/rejected 留档。OI 纪律维持原状、不放开，直到用户明确解禁；解禁后需数据契约转 available + 完整五段 + §7 全流程证伪通过方可申请入库（executable 由 false 转 true 必须经队长裁定）。
- **复活 4 项采纳（cap-2，JSON `waitlist.revivalAdoptions`）**：FRED DFII10（M3 实际利率扩展）、FRED VIXCLS/CBOE CSV（G1 交叉验证锚）、LME 外盘 futures_foreign_hist（M2 沪伦比扩展）、人民币金溢价（XAU×USDCNH 隐含观察项，需 oz→g 换算与期现口径声明）——只作 **P1 扩展数据基础标注**，仍需数据接入与质量门完成后才可用于标定/验证，**不得直接升 P0**。
- **口径修正（cap-4）**：M13 QVIX 实测 2015-02-09 起 2800 行（11 年+，t1"历史不足 3 年"顾虑不成立）；FS-01 futures_inventory_em 仅 72 行≈3 个月（API 层确认）——按修正口径再进入库。

## 9. 机器硬校验（MC-1..MC-10）结果

| 编号 | 校验 | 结果 |
|------|------|------|
| MC-1 | pricingSource=self-model 且定价引用本条目 formulas | ✅ 8/8 |
| MC-2 | 数值字段无 FinCoT 文本/分析层输出的价位与概率引用；FinCoT 仅在 analysisFilter | ✅ 8/8 |
| MC-3 | 每个参数 source 四类枚举 + 非空 freezeCondition | ✅ 8/8（51 个参数） |
| MC-4 | dataContract.ref 存在且 status=available | ✅ 8/8 |
| MC-5 | falsificationTests.strategyLevel 阈值数值化；killRules 非空 | ✅ 8/8 |
| MC-6 | crossModelRefs 为空；crossDataInputs 仅白名单 | ✅ 8/8 |
| MC-7 | 五段字段全部存在且非空 | ✅ 8/8 |
| MC-8 | 每条 prerequisites[] 显式非空且仅引用 GA-id（或经 t5 批准的采集器/日历开关）；进入 in_validation 前必须全部完成（cap-3） | ✅ 8/8（TR-01:GA-1/2；TR-03:GA-1/2 [v1.2 补 GA-2：3d p68 锥管线]；TR-06:GA-1/2；FS-02:GA-1/6；FS-04:GA-1；FS-05:GA-1；M1:GA-4/1/2；EC-01:GA-1） |
| MC-9 | 每条 asOfContract 非空且仅含 F1–F9 编号（cap-5）；定价/信号链不得出现 OI 衍生字段（cap-1/H7） | ✅ 8/8（TR-01/TR-03:F1/F2/F3/F5；TR-06:F1/F2/F3/F5/F6；FS-02:F1/F2/F3/F7；FS-04/FS-05/EC-01:F1/F2/F3/F8/F9；M1:F1/F2/F3/F8；TR-03/TR-06 OIΔ 条件已默认禁用并以量价替代，oiDerivativeStatus 字段声明） |
| MC-10 | 概率锥定价字段须 provenance=probability.json（Yang-Zhang 定量管线）且仅出现在目标定价（仅 p68/p95，与固定 R 倍数构成『先到者』，不单独定价）；禁止来自 reasoning-results/FinCoT 文本价位；锥值不得进入止损/仓位；回测锥须按 T 日及以前数据 PIT 重算（cap-6，F8 延伸） | ✅ 8/8（TR-01/03/06 目标行 [cap-6] 标注；锥未进入任何 stop/position；FS-02/04/05/M1/EC-01 probabilityConeUsage=none） |

（t12 验收复查。）

## 10. 交付边界声明

- 本初稿按 t5 §9 编纂接口规范（设计文档 v1.2）产出，并已按 t10 修订（§11 修订记录：合并 t7/t8/t9 全部 findings 与 cap-5/cap-6）：单文件 JSON（含 manifest/capRulings/globalAsOfContract/revisionLog/治理层/组合纪律/禁混清单/机器校验 MC-1..10）+ 可读 MD；未把候补池条目编入核心 manifest；未修改 D1–D11 裁定与队长裁定 cap-1..cap-6；未新增源文档之外的参数/阈值/收益数字（t9 F-06 建议档位已标注"待标定初值"并溯源审查建议）；未写任何执行引擎代码。
- 8 条核心策略全部 `designed`；GA 前置未完成前不得宣称任何条目可用（t4 结论）。
- 合并裁定 D2（M4⊕FS-08→EC-01）与修订裁定 D11（confidenceScale 不再由 FinCoT confidence 驱动）为架构级变更，t5 已声明"若队长有异议请在 t6 编纂前裁定"，本初稿按 t5 设计执行。
- 不构成投资建议。

## 11. t10 修订记录（合并 t7/t8/t9 findings + cap-5/cap-6）

> JSON `revisionLog` 与本节一一对应（22 项），供 t11 数据校验与 t12 最终验收逐项复核。

| 来源 | 编号 | 修订 | 落位 |
|------|------|------|------|
| t9 | F-01/cap-6 | H1/GC-1 修订：锥仅 p68/p95、与固定 R 倍数构成『先到者』、不单独定价；MC-10 增『禁止 reasoning-results/FinCoT 文本价位』 | H1、GC-1、MC-10、TR 族目标行 |
| t9 | F-02 | 长假/隔周提升为组合层 Hard 项，8 条 executionRules 全部引用 | portfolioDiscipline + 各条目 |
| t9 | F-03 | M1 篮子：同板块取 \|β̂\| 最强 1 个 + 篮子豁免（总风险 ≤1R、按 1 仓位计） | M1.direction、portfolioDiscipline |
| t9 | F-04 | FS-02/FS-04/M1 补跳空 >1×ATR5 放弃；FS-05 任一腿跳空 >0.5×ATR5 放弃 | 各条目 executionRules |
| t9 | F-05 | G2『止损改 ATR5 口径』限定 ATR5 计价条目；σ̂ 计价条目当日禁开新仓 | G2.rules |
| t9 | F-06 | FS-02/FS-04/FS-05 补 \|z\| edge 强度档（0.5R/1R，待标定） | 各条目 position + parameters |
| t9 | F-07 | FS-05 时间止损 20 日（与 F1 时窗一致） | FS-05.holding |
| t9 | F-08 | FS-02 止损序列：1.5×ATR5 基于期货腿入场价；br 止损现货取 T 日盘后快照 | FS-02.stop |
| t9 | F-09 | M1 声明已内置波动缩放、G2 不重复套用 | M1.position |
| t9 | F-10 | TR-03 F3 删除『同 TR-01 定义』措辞 | TR-03.formulas F3 |
| t9 | F-11 | TR-01 加仓后总风险 ≤2R、组合风险 ≤2.5% 不变、加仓单止损同步上移 | TR-01.position |
| t9 | F-12 | TR-06 仓位分档边界参数化（[2,3)/≥3）；事件日封停板条款 | TR-06.position/parameters/executionRules |
| t8 | F-1 | FS-02 比率域改写：μ̂=b̂_mean/S_t、σ̂=(b̂_hi−b̂_lo)/(4×S_t) 启动锚；≥180 日后 dom_basis_rate 序列估计；采集器存比率序列 | FS-02.formulas/parameters/inputs |
| t8 | F-2 | 新增 GA-7 政策日历 v0；FS-04/FS-05/FS-08 契约补 event-calendar 依赖；三条目 prerequisites 加 GA-7；batchOrder 第一批前置补 GA-7 | 04-data-contracts.json、validationGates、三条目 |
| t8 | F-3 | FS-04 新增 F5 平稳性门（250d 残差 ADF p>0.05 → 停用） | FS-04.formulas/invalidation/killRules/parameters |
| t8 | F-4 | FS-04 policyGate / FS-05 eventGate 移出 pricingModel 至 executionRules | FS-04/FS-05 |
| t8 | F-5 | FS-05 holding 改 20 日时间退出 | FS-05.holding |
| t8 | F-6 | EC-01『2020 负油价』条款补 sourceDoc 标注（t5 设计文档 §EC-01） | EC-01.theoryLevel.test |
| t7 | A | EC-01 池资格测试声明 M4 对数口径独立运行（log OLS β̂≥0.2 且 R²≥0.3），绑定 ECM 水平口径，两口径不混用 | EC-01.formulas F3 |
| t7 | B | EC-01 激活前置：GA-7 未建成期间只允许 paper 验证、禁止 live 开仓 | EC-01.dataContract.activationGate |
| t7 | C | M4 的 3σ 止损废弃说明（绑定模型切换 D2），防双口径止损混用 | EC-01.stop |
| t7 | D | M1 FDR007/FR007 拼接纪律（walk-forward 只用 FDR007 段；FR007 段仅 2015–2017 粗标定且拼接点 ±20 交易日剔除） | M1.dataContract.asOfRules |
| t7 | E | M1 通过门槛对齐 G3：达标窗口占比 ≥60%（预注册口径） | M1.strategyLevel.ci |

未改变部分：8 条策略理论/模型/定价链本体、D1–D11 与 cap-1..cap-6 裁定、状态机与冻结纪律（t9 §5 指引）。

## 12. 实验完整性状态（2026-08-28 重分类，以 JSON 为准）

> 本节只陈述当前证据层状态；核心 manifest 未变（旧策略线关闭），后续扩充走"机制假设生成 + 绑定式廉价探针"。

- **证据层**：falsified 2（TR-03、EC-01，保持 retired）；untested 1（FS-02）；insufficient_sample 1（M1）；not_evaluable 4（TR-01、TR-06、FS-04、FS-05，fidelityAudit=closed_no_rerun 或 needs_rework）。
- **适配保真度**：23-fidelity-review.md F-A..F-H 是任何新 retired/suspended 结论的前置；预注册统计按 24-preregistration-protocol.md（FWER=0.05，3 假设/轮 α_adj=0.0167，seed=20260828）。
- **机制假设轮次 1**（`strategies/research/v2/falsification/25-mechanism-bound-probes.md`）：
  - H-MECH-01 宏观：US10Y×DXY 双锚共振 → 沪金/沪银（10 日）——screen_pending；
  - H-MECH-02 基本面：焦炭/铁矿比价 z 回归（10 日两腿）——screen_pending；
  - H-MECH-03 交易员：极端隔夜跳空 fade（5 日）——screen_pending。
  - 本轮不 promote/discard 任何候选；命中率检验全部 low_power_no_conclusion；探针不改变本文件 §1–§11 的任何条目。
- **FS-02 数据前置（GA-8）**：`ga8-basis-history-collector.py` 按周切片拉取 `futures_spot_price_daily`，统一口径 `br=(S−F)/S=−dom_basis_rate`，PIT 留档 + revisions.jsonl；产出 `falsification/data/basis-history/`（JSONL + manifest + summary）。
