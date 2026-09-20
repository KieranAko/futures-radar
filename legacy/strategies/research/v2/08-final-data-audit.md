# 08 最终数据可落地校验报告 —— 策略库 v2（t11）

> 角色：data-auditor（数据与可落地性审计）· 校验日期：2026-08-28
> 校验对象：`strategies/strategy-library-v2.json` + `.md`（t10 修订版，revision=t10，22 项修订）
> 对照基准：`04-data-contracts.json`（t4 产出 + t10 修订）、`01/02/03 调研文档`（t1/t2/t3）、仓库数据层实况
> 产出：本报告（`strategies/research/v2/08-final-data-audit.md`）
>
> 校验结论一句话：**8 条核心策略数据契约全部真实可得（available，受 GA 前置约束），无未来函数设计红线，无 rejected 策略进入可执行集合；落地唯一阻塞是 7 项 GA 前置动作尚未执行/构建（门禁已正确编码在 G0/G1）。**

---

## 1. 校验范围与口径

| 项 | 内容 |
|---|---|
| 核心策略 | 8 条：TR-01、TR-03、TR-06、FS-02、FS-04、FS-05、M1、EC-01 |
| 治理层 | G1（五锚点 regime 过滤器，ref M5）、G2（波动率 overlay，ref M6） |
| 候补池 | 22 条（不入核心 manifest）+ 8 项 t4 复活证据（cap-2 不自动入库） |
| 判定三态 | available / needs-extension / rejected（沿用 t4 契约 taxonomy） |
| 未来函数 | 全局 asOf 契约 F1–F9（cap-5 写入 schema）+ 逐条 asOfContract 声明 |
| 前置门 | GA-1..GA-7 完成度逐一实测盘点 |

校验方法：① 独立机器断言复算 MC-1..MC-10（非信任 t6/t10 声明）；② 每条 dataContract.ref 与 04-data-contracts.json 逐字段比对；③ 对修订增量（t7/t8/t9 findings + cap-1..cap-6）逐项核对落地情况；④ 仓库实况复核（data/daily、data/macro、event-calendar、collector 族）。

---

## 2. 机器校验独立复核（复算结果）

对 `strategy-library-v2.json` 独立运行断言（Python），与库内 machineChecks 声明对照：

| 检查 | 库内声明 | 独立复算 | 说明 |
|---|---|---|---|
| MC-1 pricingSource=self-model | pass | ✅ pass | 8/8 self-model，stop/target/position 均标 modelRef |
| MC-2 FinCoT 数值禁入定价 | pass | ✅ pass | analysisFilter.noNumericPricing=true；定价字段无 FinCoT 文本价位/概率 |
| MC-3 参数 source+freezeCondition | pass | ✅ pass | 51 参数四字段齐全 |
| MC-4 dataContract.ref 存在且 available | pass | ✅ pass | 8 个 ref（TR-01/TR-03/TR-06/FS-02/FS-04/FS-05/M1/FS-08）在 04-data-contracts.json 中全部 status=available；EC-01→FS-08 映射正确 |
| MC-5 阈值数值化+killRules 非空 | pass | ✅ pass | — |
| MC-6 crossModelRefs 空+白名单 | pass | ✅ pass | crossDataInputs ⊆ {data/daily, data/macro, event-calendar} |
| MC-7 五段完整 | pass | ✅ pass | — |
| MC-8 prerequisites ⊆ GA-id | pass | ✅ pass | 8/8 仅引用 GA-id（见 §5 附注 L1） |
| MC-9 asOfContract ⊆ F1–F9 | pass | ✅ pass | 8/8 子集合规 |
| MC-10 锥 provenance=probability.json | pass | ✅ pass | TR-01/03/06 目标行均带 [cap-6] provenance 标注；锥仅 p68/p95、与固定 R 构成"先到者"、不单独定价 |
| H7 OI 衍生禁入（cap-1） | pass | ✅ pass | TR-03/TR-06 的 OIΔ 条件默认禁用并以量价条件替代（"待用户解禁后恢复 t3 原设计"）；FS-P1-02 候补池标 rejected_by_policy；定价字段无 OI 衍生（EC-01 扫描命中的"持仓位…止损"为执行纪律文本，非 OI 定价输入，误报） |

**结论：MC-1..MC-10 与 H7 全部可复现通过，未发现库内声明与实况不符的机器校验项。**

---

## 3. 8 条核心策略逐条数据校验结论

### 3.1 判定汇总表

| ID | 名称 | 契约 ref | 契约状态 | 本校验判定 | 前置（prerequisites） | asOf 声明 | 未来函数终审 |
|---|---|---|---|---|---|---|---|
| TR-01 | 趋势延续 | TR-01 | available | **available** | GA-1、GA-2 | F1/F2/F3/F5 | 无违规 |
| TR-03 | 趋势回踩续势 | TR-03 | available | **available** | GA-1、GA-2 | F1/F2/F3/F5 | 无违规 |
| TR-06 | 事件冲击确认 | TR-06 | available | **available** | GA-1、GA-2 | F1/F2/F3/F5/F6 | 无违规（F6 已声明：禁未来重跑 FinCoT 文本） |
| FS-02 | 基差分位回归 | FS-02 | available | **available** | GA-1、GA-6 | F1/F2/F3/F7 | 无违规（F7 现货粘性质量门） |
| FS-04 | 黑色利润分位 | FS-04 | available | **available** | GA-1、GA-7 | F1/F2/F3/F8/F9 | 无违规（F9 事件日历 discipline） |
| FS-05 | 农产品协整 | FS-05 | available | **available** | GA-1、GA-7 | F1/F2/F3/F8/F9 | 无违规 |
| M1 | DR007 流动性冲击 | M1 | available | **available** | GA-1、GA-2、GA-4 | F1/F2/F3/F8 | 无违规 |
| EC-01 | 能化 ECM（M4⊕FS-08） | FS-08 | available | **available** | GA-1、GA-7 | F1/F2/F3/F8/F9 | 无违规 |

**治理层**：G1（ref M5 available，GA-4/GA-5 前置）；G2（ref M6 available，GA-2 前置；cap-4 口径修正已写入 note：GA-2 批量 runner 未运行前 G2 只对已有品种生效）——两者均**非定价组件**（X10 校验通过：G2 不得改变止损数值，t9 F-05 修订已落地）。

**候补池 22 条**：全部不入核心 manifest（D8/D9）；FS-P1-02 因 cap-1/H7 标 rejected_by_policy；t4 复活 4 项（DFII10/VIXCLS/LME 外盘/人民币金溢价）按 cap-2 仅作 P1 扩展数据基础，不自动升 P0。**可执行集合（8 条核心）内无 rejected 条目。**

### 3.2 逐条关键字段真实验证（仓库实况 + 接口实测回溯）

| 契约字段 | 支撑证据（t4 实测 + 本轮复核） | 判定 |
|---|---|---|
| data/daily 59 品种（61-500 bars，OHLCV+OI+settle） | t4 §2.1 实测：RB0/M0/SC0 500 bars，其余 56 品种 61 bars（2026-06-03 起）；futures_main_sina 回填能力实测（RB0 2009+/I0 2013+/TA0 2006+/M0 2005+，OI 全历史非空） | 真实可得；GA-1 未运行 |
| DR007（FDR007 2017-05-31+，按年分批回填） | t4 实测：repo_rate_hist 单窗 ≤1 年、超窗 KeyError；按年分批程序可行；FDR007/FR007 拼接纪律已写入 M1.dataContract.asOfRules（t7-D） | 真实可得；GA-4 未运行 |
| US10Y/CN10Y（bond_zh_us_rate 2002+ 同表） | t4 实测 9330 行全量 | 真实可得（M1/M5/G1 与候补 M12 共用） |
| 生意社基差（futures_spot_price_daily 2011+ 13 列含 dom_basis_rate；_previous 54 品种含 180 日带） | t4 实测；FS-02 比率域口径修正（t8 F-1）已同步到 t2 源文档、契约与库条目（μ̂=b̂_mean/S_t、σ̂=(b̂_hi−b̂_lo)/(4×S_t) 启动锚，≥180 日后用 dom_basis_rate 序列估计） | 真实可得；基差历史采集器未建、GA-6 未跑 |
| event-calendar（政策/贸易事件前提开关） | recordings/v5/event-calendar.json 存在（2026-03~08，verified/schedule 双态）；GA-7 政策日历 v0（年份级事件窗口最小集）为 t10 新增前置，FS-04/FS-05/EC-01 冻结前置，EC-01 未建成时仅 paper 验证禁 live | 前提开关机制真实；GA-7 未构建 |
| ATR5/HV/HV%ile/概率锥（probability 派生） | 计算能力在库（hv-estimators.js/stage-4-5.cjs）；每 run 覆盖 KEEP 品种 1-3 个（cap-4 修正已写入 G2 note 与契约 GA-2） | 能力真实；GA-2 批量 runner 未建 |
| 板块序列（TR-04 候补、FS-06 候补依赖） | data/sector 当前 1 行；GA-3 重建方案已定 | 候补池范围，不阻塞核心 8 条 |
| 合约级日线（候补 FS-03/TR-07） | futures_zh_daily_sina 实测 213 行含 hold；term-structure collector 在库 | 候补池范围，不阻塞核心 8 条 |

---

## 4. 未来函数设计终审（asOf 契约 F1–F9 对照）

| # | 纪律 | 终审结论 |
|---|---|---|
| F1 | T 日收盘评估 → T+1 开盘执行；跳空放弃条款 | ✅ 8/8 声明；t9 F-04 补丁已落地（FS-02/FS-04/M1 跳空 >1×ATR5 放弃、FS-05 任一腿 >0.5×ATR5 放弃） |
| F2 | 宏观锚点 stale/missing（US10Y T-1 降权 0.75、missing 计 0；USDCNH change5d=null 须 GA-5） | ✅ 已声明；GA-5 未修——**M1/G1 在 GA-4/GA-5 完成前不得进入 in_validation**（门禁已覆盖） |
| F3 | 月度数据发布日 PIT 对齐 | ✅ 已声明（核心 8 条无月度依赖，属候补 M8-M10 适用，声明为无害超集） |
| F4 | 库存发布时点留档 | ✅ 已声明（FS-01 候补适用） |
| F5 | 换月拼接 PIT + ≥9.5% 剔除 + per-bar sources | ✅ 已声明；G2 回测口径含"换月日剔除" |
| F6 | FinCoT 文本回溯禁未来重跑 | ✅ TR-06 声明；batchOrder 第三批限 RB0/M0/SC0 起步（D7）与契约"全品种 FinCoT 历史需按需重跑"一致 |
| F7 | 现货粘性质量门（30 日零变动 >40% 剔除） | ✅ FS-02 声明；GA-6 未跑——FS-02 在 GA-6 完成前不得 in_validation（第二批门禁已覆盖） |
| F8 | 滚动估计只用 T 日及以前 | ✅ FS-04/FS-05/M1/EC-01 声明 |
| F9 | 事件日历 discipline（event.date ≤ 锚点日、禁价格反推事件） | ✅ FS-04/FS-05/EC-01 声明；GA-7 未建——三条目冻结前置（门禁已覆盖） |

**终审：无未来函数设计红线。所有"未完成"项均已被状态机（designed）+ G0/G1 门禁正确拦截，不存在"数据未就绪但可执行"的路径。**

---

## 5. GA 前置动作完成度盘点（落地真实阻塞清单）

| 前置 | 内容 | 当前状态（2026-08-28 实测） | 阻塞对象 |
|---|---|---|---|
| GA-1 | 全历史回填（full-history-collector.cjs 运行） | **未运行**（research/backtest/data/ 不存在）；工具与数据源实测可行 | TR-01/03/06、FS-02/04/05、M1、EC-01（全部） |
| GA-2 | 全品种 ATR5/HV/HV%ile 批量 runner | **未建**（能力组件在库） | TR-01/03/06、M1、G2 |
| GA-3 | 板块序列重建 | **未跑** | 仅候补（TR-04/TR-08/FS-06），不阻塞核心 8 条 |
| GA-4 | 宏观锚点回填（DR007 按年分批 + US10Y 2002+） | **未跑**（程序实测可行） | M1、G1 |
| GA-5 | USDCNH change5d 修复 | **未修**（2026-08-27 快照 change5d=null 复现） | G1（及 M2 候补） |
| GA-6 | 现货粘性质量门逐品种审计 | **未跑** | FS-02 |
| GA-7 | 政策日历 v0（年份级事件窗口最小集） | **未建**（人工 YAML） | FS-04/FS-05/EC-01（冻结前置）；EC-01 未建成期间仅 paper |

**结论**：8 条核心策略全部停留在 `designed` 状态是正确的（allEntriesStatus="designed" 与实况一致）。按 batchOrder：第一批（TR-01/TR-03/FS-04/FS-05/M1/EC-01）需 GA-1/GA-2/GA-4/GA-7 完成后方可 G0 通过；FS-02 第二批还需基差采集器+GA-6；TR-06 第三批还需 FinCoT 历史向前积累（限 RB0/M0/SC0）。

---

## 6. 发现的问题清单（均为低严重度一致性项，不构成 reject）

| # | 严重度 | 问题 | 建议修复（t12 前或下次修订轮） |
|---|---|---|---|
| L1 | low | FS-02 的**基差历史批量采集器**（新采集器）只登记在 dataContract.preconditionsNote 与 batchOrder，未进入 prerequisites[]（仅 GA-1/GA-6），MC-8 无法在 in_validation 时机械拦截"采集器未建" | 在 04-data-contracts.json 增加采集器 id（如 COLLECTOR-basis-history），FS-02.requiredGAs/prerequisites 引用之；G1 门禁同步校验 |
| L2 | low | TR-01/TR-03/TR-06/FS-02 的 asOfContract 未声明 F5（换月拼接 PIT），虽 G2 回测口径已含换月剔除，但逐条声明不完整 | 补齐 F5 声明（纯声明性，不影响判定） |
| L3 | low | FS-02.requiredGAs 未列 GA-2（其定价不依赖 HV/ATR5 批量——ATR5 可由日线即时派生；契约内期货腿 gap=GA-1 已覆盖） | 可维持现状，但建议在 FS-02 契约注明"ATR5 由 GA-1 后日线即时派生，不依赖 GA-2"以避免验证层误判 |
| L4 | info | G2 note 的 cap-4 口径修正（probability.json 仅 KEEP 品种）已写入，但 GA-2 未运行时 G2 只能对"已有品种"生效——与库内 batchOrder"治理层与第一批并行验证"存在时间差 | 维持现状可接受；验证层需在 GA-2 完成后重跑 G2 全品种覆盖检查 |
| L5 | info | EC-01 的 GA-7 降级条款：契约（FS-08 event-calendar gap）与库条目（EC-01.dataContract.activationGate="GA-7 未建成期间只允许 paper 验证、禁止 live 开仓"）均已写明且互链一致——**无问题，记录为通过项** | 无需动作（初稿复核时误记，本轮已确认一致） |

**以上 5 项均不改变任何策略的 available 判定，不产生 rejected，不构成未来函数风险。**

---

## 7. 最终判定

1. **可执行集合（8 条核心）数据契约全部真实可得**：源/频率/字段/asOf 均有 t4 实测证据支撑，本轮复核对 t10 修订增量（GA-7、event-calendar 依赖、FS-02 比率域、M1 篮子、H7 OI 替代、cap-6 锥条款）逐项确认落地无误。
2. **无未来函数设计**：F1–F9 全局契约 + 逐条 asOfContract + G2 回测口径 + 状态机 designed→in_validation→validated→frozen 门禁链完整；所有未就绪项（GA-1/2/4/5/6/7）都被 G0/G1 正确拦截。
3. **无 rejected 策略进入可执行集合**：8/8 核心 available；FS-P1-02（rejected_by_policy，cap-1/H7）仅在候补池留档；t4 复活 4 项按 cap-2 仅作 P1 数据基础，不升 P0。**本报告明确维持该排除**。
4. **落地真实阻塞 = 7 项 GA 前置（见 §5）**，全部为"未执行/未构建"而非"不可得"：GA-1/GA-2/GA-4/GA-6 为仓库内能力即可完成，GA-5 为一行修复，GA-7 为人工 YAML（年份级最小集，工作量小）。
5. **给 t12 验收的数据侧要点**：复核 L1（FS-02 采集器进 prerequisites）；确认 G0 门禁在 GA-1/GA-2/GA-4/GA-6/GA-7 实际完成前不允许任何条目进入 in_validation；EC-01 在 GA-7 完成前坚持 paper-only。

**校验结论：pass（数据可落地性层面）——策略库 v2 修订稿在数据契约、来源真实性、asOf 纪律与未来函数层面全部合格；唯一前置是执行 GA-1..GA-7。**

---

## 8. 交付物

- 本报告：`strategies/research/v2/08-final-data-audit.md`
- 关联产物（本轮只读校验，未改动）：`strategies/strategy-library-v2.json/.md`（t10 修订版）、`strategies/research/v2/04-data-contracts.json`（t4+t10 版）

> 本报告为数据可落地性校验结论，不构成投资建议。
