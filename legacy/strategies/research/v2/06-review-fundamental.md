# 基本面视角审查 — 策略库 v2 初稿（t8）

> 角色: fundamental-analyst（基本面分析师） | 团队: futures-strategy-library | 日期: 2026-08-28
> 任务: t8 — 从产业链基本面视角审查 strategy-library-v2 初稿：供需/库存/基差策略的理论与模型是否对应、定价是否来自模型、数据契约是否可用；找出理论与模型混用或不可落地项。
> 审查对象: `futures-radar/strategies/strategy-library-v2.json`（机器版）与 `strategy-library-v2.md`（可读版）
> 参照基线: `strategies/research/v2/02-fundamental-theories.md`（t2 原文，本分析师产出）、`04-data-contracts.json`（t4）、`05-strategy-library-design.md`（t5）
> 审查范围（基本面侧）: 核心条目 FS-02 / FS-04 / FS-05 / EC-01（M4⊕FS-08，D2 合并）+ 绑定层（H1–H6、X1–X10、allowedCrossInteractions、G1/G2、portfolioDiscipline、machineChecks、validationGates）+ 基本面候补池条目（waitlist）。

---

## 0. 结论总览

| 条目 | 审查结论 | 驱动发现 |
|------|---------|---------|
| FS-02 基差分位回归 | **needs_revision** | F-1（medium，单位域不一致，阻塞验证） |
| FS-04 黑色利润分位 | **needs_revision** | F-2（medium，事件日历前置缺口）、F-3（low）、F-4（low） |
| FS-05 农产品价差回归 | **needs_revision** | F-2（medium）、F-5（low） |
| EC-01 能化成本传导 | **needs_revision** | F-2（medium）、F-6（info） |
| 绑定层/治理层 | **pass** | 无理论混用、无定价越权、无未来函数；机器校验 MC-1..7 全过 |

**总体判断**: 无红线问题。四条基本面条目与 t2 原文逐公式核对基本忠实；D2 合并执行正确；事件日历作前提开关而非定价输入（队长审查要点）落实到位；已知反面证据全部入库。存在 **2 个 medium、3 个 low、1 个 informational** 修订项，其中 F-1/F-5 的根源在 t2 源文档缺陷，本分析师已于本轮审查同步修正 t2 原文（见 §8），t10 修订库条目时以修订后 t2 为准。

---

## 1. 跨条目与治理层检查（逐项 pass / 注记）

| 检查项 | 结果 | 证据 |
|--------|------|------|
| H1 FinCoT 只做分析 | **pass** | 4 条 analysisFilter.noNumericPricing=true；FinCoT 仅出现在 analysisFilter（FS-02 观察 only / 其余排除 only）；定价字段无 FinCoT 引用 |
| H2 定价自模型导出 | **pass** | 4 条 pricingSource=self-model；stop/target/position 均带 modelRef 指向本条目公式（MC-1 pass） |
| H3 不跨条目混用 | **pass** | 4 条 crossModelRefs=[]；crossDataInputs 仅 data/daily、event-calendar（X9 白名单内，MC-6 pass） |
| H4 数据契约绑定 | **pass（附 F-2 注记）** | ref 均为 available 且存在于 04-data-contracts.json（MC-4 pass）；但事件日历依赖未写入 FS-04/FS-05/FS-08 契约 dependencies（见 F-2） |
| H5 参数纪律 | **pass** | 4 条参数均含 source/sourceClass/sourceDoc/freezeCondition（MC-3 pass） |
| H6 风险框架外层不变 | **pass** | portfolioDiscipline 11 项 Hard 项与 v1 risk-framework 一致；G1/G2 仅缩放/否决（X10） |
| X1–X10 禁止混用 | **pass** | 基本面条目相关项（X1/X2/X3/X6/X8/X9/X10）均落实；D6（FS-07 跨条目条款删除）已写入 X6；D9（FS-P1-02 OI 纪律）已写入 manifest |
| 事件日历前提开关未误用为定价 | **pass** | FS-04 policyGate / FS-05 eventGate / EC-01 事件联动条款 theoryRole 均为「前提开关（数据层输入，非定价）」；未进入 stop/target/position 数值；portfolioDiscipline「事件日历联动暂停」与 allowedCrossInteractions 白名单一致 |
| G1/G2 治理层 | **pass** | 只做组合级过滤/缩放；不产生方向/止损/目标数值；各带自身证伪与 killRule |
| 机器校验 | **pass** | MC-1..7 全部 pass（t6 已跑 Python 断言，本审查抽查一致） |
| 基本面候补池（waitlist + design §8） | **pass（附注记）** | FS-01（EM 库存 72 行口径已修正，增量采集 8–10 月 + 郑商所仓单加速）、FS-03（月差构建器 + PIT 换月）、FS-06（显式联合 AND 门合规）、FS-07（D6 改写后申请）、FS-09（日历 ≥20 样本）升级路径完整且与 t2 原设计一致 |

---

## 2. FS-02 基差分位回归 — 逐段核对

**理论（t2 §FS-02 一致性）: pass**
- F1 以 H0/H1 形式改写（回归概率 ≤0.5 vs >0.5）——比 t2 原文更严格，合规且更好。
- F2 收敛方向不对称性"本身纳入证伪检验"保留 ✓；Kaldor/Working/Fama-French/Boons-Prado 文献引用 ✓。

**市场模型: F-1（medium）**
- 公式 F1–F4 与 t2 原文逐字一致，但 t2 原文存在**单位域不一致**并原样传播进库：`z_t = (br_t − μ̂)/σ̂` 中 `br_t` 是基差**率**（dom_basis_rate，无量纲），而 `μ̂, b̂_hi, b̂_lo` 取 `futures_spot_price_previous` 的「180 日主力基差 平均/最高/最低」是**绝对基差（元/吨）**。两者直接混算，z 值错误。
- 量级验证（2026-08-27 螺纹钢实测数据）: 现货 3112.5，dom_basis_rate = −0.0079，180 日带 平均 27.49 / 区间 [−26.16, 81.16]。朴素混算: z ≈ (−0.0079−27.49)/(107.32/4) ≈ −1.02 → 不触发；正确比率域: μ̂=27.49/3112.5=0.0088，σ̂=107.32/(4×3112.5)=0.0086，z ≈ (−0.0079−0.0088)/0.0086 ≈ −1.94 → 触发。**信号是否产生被单位错误直接改变**。
- **requiredFix（t10）**: ① 库内 F2 改为比率域: `μ̂ = b̂_mean/S_t；σ̂ = (b̂_hi − b̂_lo)/(4×S_t)`（绝对带转比率域，作启动锚）；正式口径 = 基差历史库积累 ≥180 日后改用 dom_basis_rate 序列直接估计 μ̂/σ̂（`futures_spot_price_daily` 每行含 dom_basis_rate，采集器须存比率序列，与 t4 FS-02 契约「待建基差历史库」一致）。② 参数表「σ̂ 估计式」initial 同步更新。③ strategy-library-v2.md 第 135/184 行同改。④ t2 源文档已由本分析师同步修正（§8.1），库内 sourceDoc 锚点无需改号。

**策略/定价/数据/证伪: pass**
- 期货腿单边、质量门（30 日零变动 >40% 剔除，GA-6）、距交割 ≥20 日、加速走扩等待、T+1 执行、止损 0.5σ̂/1.5×ATR5、目标 F4、20 日时间退出、PIT 拉取（F7）——均与 t2 一致。
- 数据契约 FS-02 available（GA-1 + GA-6）✓；knownCounterEvidence 两条（2022 镍/2024 氧化铝逼仓、现货粘性降权）✓。
- 证伪 (a)(b)(c) 与 t2 逐字一致 ✓。

---

## 3. FS-04 黑色产业链利润分位 — 逐段核对

**理论: pass**（F1/F2 + 「传导链未被政策打断」前提；Pindyck/国投套利案例引用 ✓）
**模型: pass + F-3（low）**
- F1 OLS 残差利润代理（先验权重 1.6/0.5 仅初始值）、F2 z_250、F3 目标价、F4 焦化 1.33 同构——与 t2 逐字一致 ✓。
- **F-3（low）**: t2 未给 π 残差的平稳性门。π 是价格水平上的 OLS 残差，若 RB/I/J 体系不协整（政策/工艺变迁后），残差非平稳 → z 分位失真。FS-05/EC-01 均有协整/ADF 门，FS-04 应同构。**requiredFix**: 增加模型门 F5「滚动 250d 残差 ADF p > 0.05 → 该品种组停用（重估窗口）」，并入 invalidationEvent 与 killRules；参数表新增一条（calibration，freezeCondition 同 F-2 门）。
**定价: pass + F-4（low）**
- stop/target 引用 F2/F3 ✓；×0.75 折扣不适用于本条（仅 EC-01）✓。
- **F-4（low）**: `policyGate` 位于 pricingModel 块内。其 theoryRole 已声明「前提开关（数据层输入，非定价）」且未进入数值字段——实质合规，但定价块应保持纯定价。**requiredFix**: 将 policyGate 移至 strategy.executionRules（该处已有同文案），pricingModel 内删除，避免后续机器校验误伤。
**数据: F-2（medium，与 FS-05/EC-01 共享）**
- 契约 FS-04 available（纯价格 + GA-1）✓；口径声明（真实利润 Mysteel 剔除、只用价格代理）✓。
- **F-2（medium）**: 本条前提「政策日历『粗钢产量调控/能耗双控』事件未生效」+ 证伪 (d)「政策过滤层为必装组件」，但 04-data-contracts.json 的 FS-04 dependencies 只登记了 π_t（data/daily），**未登记 event-calendar 依赖**；G0 全局前置 GA-1..GA-6 亦无日历项；而 event-calendar 现状 = FS-09 契约 needs-extension、「路径: 待建」。设计文档 §4.4 写明「政策日历为**冻结前必装**组件（其证伪测试 (d) 裁定）」，库 JSON 未承接此约束，且 batchOrder 第一批（FS-04/FS-05/EC-01）未含日历前置——**自相矛盾**：无日历则证伪 (d) 无法执行 → 无法通过 G4 冻结。
- **requiredFix**: ① 04-data-contracts.json 的 FS-04/FS-05/FS-08 dependencies 各增加一条 `event-calendar` 字段（source=人工维护 YAML/FS-09 模板，status=needs-extension，gap=待建，用途=前提开关）；② validationGates G0 增加 **GA-7「政策日历 v0」**：至少覆盖黑色 2016–2017 供给侧/2021 粗钢压减/2025 产量调控、农产品 2019 菜籽/2023 反倾销/收抛储、能化 2020 负油价/2022 俄乌 三类已知事件窗口的**年份级留档**（证伪测试所需的窗口标注即可，完整事件集仍走 FS-09 路线）；③ 库条目 FS-04/FS-05/EC-01 的 requiredGAs 增加 GA-7（或 dataContract 注明「GA-7 未完成前 G4 冻结不可达」）；④ batchOrder 第一批前置补「GA-7」。
**证伪/反面证据: pass**（(a)–(d) 与 t2 一致；2021H2 焦煤、2014–2015 需求坍塌两条反面证据 ✓）

---

## 4. FS-05 农产品压榨/替代价差回归 — 逐段核对

**理论: pass**（F1 协整回归、F2 结构断裂「必须先于交易被识别」✓；Gatev/Engle-Granger ✓）
**模型: pass**（EG 两步滚动 250d、断裂门 60d ADF p>0.10 / β̂ 漂移 2σ̂_β、z ±2/3σ̂、F4 双腿目标——与 t2 逐字一致 ✓）
**策略: F-5（low）**
- **F-5（low）**: holding 写作「价差回归时退出（无固定日上限）」，与理论 F1「偏离均衡后 **20 日内**回归」时窗不一致，且使证伪 (b)「回归命中率」的时窗无锚。**requiredFix**: holding 改为「z→0 双边平或 **20 日时间退出**（与 F1 时窗一致），先到先平」；t2 源文档已同步补充（§8.2）。
- 其余（双腿 T+1 同步、0.14% 成本、Y−P 低置信 90 日断裂门条件、事件暂停）✓。
**数据: F-2（medium，共享）** —— 同上 §3 F-2：契约 FS-05 dependencies 未登记 event-calendar；贸易/储备事件暂停条款无日历支撑。requiredFix 同上。
**证伪/反面证据: pass**（(a)(b)(c) 含 M−RM 专项与 2019/2023 断裂案例 ✓）

---

## 5. EC-01 能化成本传导（M4 ⊕ FS-08，D2 合并）— 逐段核对

**D2 合并执行: pass**
- 绑定模型 = FS-08 ECM（γ<0 显著性门）；M4 保留项 = 池资格过滤（β̂≥0.2 且 R²≥0.3，作 F3 模型资格测试）+ 仓位折价 0.75；M4/FS-08 不再独立存在（X3）——与 D2 裁定、队长批复逐字一致 ✓。
**理论/模型: pass**
- F1 协整、F2 产品腿单边（t4 确认 SC 无库存/基差数据，产品腿结构是正确取舍——把 t2 的「取舍」升级为「t4 数据侧确认」，合规且更扎实）；MA 不入集（煤化工成本锚一致性）✓；precondition γ<0 且 p<0.05 ✓。
**定价: pass + F-6（info）**
- stop/target 引用 F1/F4/F5 ✓；×0.75 折价 modelRef 指向 ECM 估计误差（合理，参数 sourceDoc=t1 §M4）✓；overnightGuard 为执行纪律非定价 ✓。
- **F-6（info）**: 证伪条款「2020 负油价、2022 俄乌供给冲击期样本单列报告」中「2020 负油价」非 t1/t2 原文（t2 §FS-08 只写 2022 俄乌），源自 t5 设计文档（§EC-01 第 552 行）。内容合理、非定价数字，**建议**在库内补 sourceDoc 标注「t5 设计文档 §EC-01」以保持逐字溯源纪律。
**数据: F-2（medium，共享）** —— 契约 FS-08 dependencies 未登记 event-calendar；「2020/2022 期与事件日历联动暂停」无日历支撑。requiredFix 同 §3。
**证伪/反面证据: pass**（(a) ADF/γ 门、(b) 夏普、(c) 隔夜跳空 30% 与 t2 一致；俄乌段反面证据 ✓）

---

## 6. 与 t2 源文档一致性核对表（公式级）

| 库条目 | t2 公式 | 库内呈现 | 一致 |
|--------|---------|---------|------|
| FS-02 | br=(S−F)/S；σ̂=(hi−lo)/4；z；signal ±1.5；F_target=S(1−μ̂) | 逐字一致（含 F-1 缺陷） | **F-1 后需改** |
| FS-04 | π=P_RB−(β̂1I+β̂2J)；z_250；target=P−zσ̂；焦化 1.33 | 逐字一致 | ✓ |
| FS-05 | EG 协整；z ±2/3σ̂；断裂门；z→0 平 | 逐字一致 | ✓（补 20 日退出后） |
| EC-01 | 协整+ECM γ<0；z ±2；target=α̂+β̂P_SC+μ̂_e | 逐字一致 | ✓ |

库内未发现任何 t2 未写的参数/阈值/收益数字被编造（除 F-6 的 2020 负油价条款，溯源 t5）。

---

## 7. 发现清单（供 t10 修订）

| ID | 严重度 | 位置 | 问题 | requiredFix |
|----|--------|------|------|------------|
| F-1 | **medium** | strategy-library-v2.json FS-02.marketModel.formulas F2、F4；parameters「σ̂ 估计式」；strategy-library-v2.md §4.4/汇总表 | z 与 F_target 混用绝对基差（元/吨）与基差率（无量纲），信号触发被单位错误改变（实测 RB 2026-08-27: 错误 z≈−1.02 不触发 vs 正确 z≈−1.94 触发） | 比率域改写: μ̂=b̂_mean/S_t，σ̂=(b̂_hi−b̂_lo)/(4×S_t) 作启动锚；正式口径 = 基差历史库 dom_basis_rate 序列估计 μ̂/σ̂（≥180 日后）；F4 用比率域 μ̂；参数表与 .md 同步；采集器须存 dom_basis_rate 序列（t2 已同步修正，见 §8.1） |
| F-2 | **medium** | 04-data-contracts.json FS-04/FS-05/FS-08 dependencies；strategy-library-v2.json validationGates.G0、batchOrder、三条目 dataContract.requiredGAs | 事件日历前提（政策/贸易/储备/供给冲击暂停条款）未登记为数据依赖；G0 无日历前置；而设计文档与 t2 证伪 (d) 均要求日历为冻结前必装 → 第一批入库路径自相矛盾 | ① 三契约各加 event-calendar 依赖字段（needs-extension，待建，用途=前提开关）；② G0 新增 GA-7「政策日历 v0」（三类已知事件窗口的年份级标注）；③ 三条目 requiredGAs 加 GA-7（或注明 G4 冻结不可达）；④ batchOrder 第一批前置补 GA-7 |
| F-3 | low | strategy-library-v2.json FS-04.marketModel / falsificationTests | π 残差无平稳性门；RB/I/J 体系不协整时 z 失真（FS-05/EC-01 均有同构门，FS-04 缺失不对称） | 加 F5 门「滚动 250d 残差 ADF p>0.05 → 该品种组停用」，并入 invalidationEvent/killRules/参数表 |
| F-4 | low | FS-04.pricingModel.policyGate、FS-05.pricingModel.eventGate | 非定价的前提开关置于 pricingModel 块内（已声明非定价、实质合规，但定价块应保持纯定价） | 移至 strategy.executionRules（该处已有同文案），pricingModel 删除该块 |
| F-5 | low | FS-05.strategy.holding | 「无固定日上限」与理论 F1「20 日内回归」时窗不一致，证伪 (b) 命中率时窗无锚 | holding 改「z→0 双边平或 20 日时间退出，先到先平」（t2 已同步补充，见 §8.2） |
| F-6 | info | EC-01.falsificationTests.theoryLevel.test | 「2020 负油价」条款非 t1/t2 原文，源自 t5 设计文档 §EC-01 | 补 sourceDoc 标注「t5 设计文档 §EC-01」（内容保留，不构成修订阻断） |

---

## 8. t2 源文档已同步修正（本分析师修正自身产出）

1. **§8.1（对应 F-1）**: `02-fundamental-theories.md` §FS-02 市场模型块已改为比率域口径——绝对 180 日带须除以触发日现货价转比率域作启动锚；基差历史库积累 ≥180 日后改用 dom_basis_rate 序列估计 μ̂/σ̂（与 t4 FS-02 契约「待建基差历史库」衔接）。
2. **§8.2（对应 F-5）**: `02-fundamental-theories.md` §FS-05 策略补「时间退出 20 个交易日（与 F1『20 日内回归』时窗一致）」。
3. 两处修正均以「（t8 审查 F-x）」注释留痕，t10 修订库条目时以修订后 t2 为准，sourceDoc 锚点编号不变。

---

## 9. 给 t10 的修订输入与给队长的提示

- **修订输入**: §7 六条 requiredFix；其中 F-1 的替换公式已在 §8.1 的 t2 修订中给出可直接粘贴的最终文本。
- **无需新裁定**: F-2 的 GA-7 属于执行顺序编排（G0 前置动作），不改变 D1–D11 任何裁定；F-1/F-5 为源文档缺陷修正，不改变策略设计。
- **给队长**: 四条基本面条目本轮全部 needs_revision，但无一条涉及理论/模型混用、定价越权或未来函数——修订均为「口径/编排/门禁」类，预计 t10 单轮修订即可闭环；t11 数据审计可并行核对 GA-7 日历 v0 的事件窗口清单。
- **免责**: 本审查不构成投资建议；全部参数仍为待标定初值。
