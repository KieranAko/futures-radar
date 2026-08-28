# 09 策略库 v2 最终验收报告（t12）

> **文件**: `strategies/research/v2/09-acceptance-report.md`
> **验收人**: strategy-architect（首席策略架构师）| **任务**: t12 | **日期**: 2026-08-28
> **验收对象**: `strategies/strategy-library-v2.json`（2247 行，schema futures-strategy-entry-v2/1）+ `strategies/strategy-library-v2.md`（299 行）——t10 修订版（revisionLog 22 项，以设计文档 05 v1.2 为基准）
> **对照基准**: `05-strategy-library-design.md`（v1.2，含 cap-1..cap-6）、`04-data-contracts.json`（含 GA-7）、`08-final-data-audit.md`（t11）、`06-review-{macro,fundamental,trader}.md`（t7/t8/t9）、t1/t2/t3 源文档
> **验收方法**: 逐字段人工通读 + 独立 Python 断言复算（`t12-acceptance-check.py`，18 项检查 A1–A17 + 编造数字扫描，不信任库内 machineChecks 自声明）

---

## 1. 结论：**PASS** ✅

策略库 v2（t10 修订版）满足 t12 全部验收标准：

1. **强绑定成立**：8 条核心策略 theory/marketModel/strategy/pricingModel/dataContract/falsificationTests 六段完整；`pricingSource=self-model` 8/8；止损/目标/仓位均带 modelRef 指向本条目公式。
2. **无跨策略混用**：`crossModelRefs=[]` 8/8；modelRef 引用的公式编号全部存在于本条目 formulas（A3 独立复算）；X1–X11 禁止混用清单与允许交互白名单在库。
3. **FinCoT 只作分析层**：8/8 `analysisFilter.noNumericPricing=true`；GC-1 全局约束与 H1（cap-6 口径）落库；概率锥仅 TR-01/03/06 目标定价使用（provenance=probability.json、与固定 R 倍数构成"先到者"、不单独定价），未进入任何 stop/position（A4b）。
4. **每条策略含证伪测试**：8/8 策略级（minTrades≥100、PF≥1.2、95% CI、三基线、成本口径）+ 理论级证伪 + killRules 非空（A5）。
5. **数据契约合规**：8/8 dataContract.ref 在 04-data-contracts.json 中 status=available（A6）；FS-P1-02 以 `rejected_by_policy / executable=false` 留在候补池，未进入可执行集合（A14）；候补池 22 条未编入核心 manifest；GA-7 政策日历 v0 已在契约与 FS-04/FS-05/EC-01 prerequisites 落位（A17），EC-01 带 activationGate（GA-7 未建成期间仅 paper 验证、禁 live）。
6. **参数有来源**：55 个参数全部含 source 四类枚举 + sourceClass + sourceDoc + freezeCondition（A7）。
7. **无编造数字**：全库扫描无任何"夏普=…/胜率=…/年化收益…"式业绩声明；"夏普 < 0.5"仅以证伪停用阈值形式出现（来源 t2 原文，合法）。
8. **裁定完整性**：D1–D11、H1–H7、cap-1..cap-6、MC-1..MC-10 全部落库（A10/A11）；t10 revisionLog 22 项与文件实际内容一致（A12，逐项抽查）。

**判定**：策略库 v2 修订稿可进入下一阶段（**策略执行引擎适配**）。**不可进入回测**：8 条条目全部为 `designed` 状态，GA-1..GA-7 七项数据前置动作均未执行/构建（t11 §5），G0/G1 门禁在 GA 完成前正确拦截 in_validation——数据未就绪前不得宣称任何条目可用。

---

## 2. 验收证据清单

### 2.1 独立机器断言复算结果（18/18 PASS，可复现）

| # | 检查 | 结果 | 证据 |
|---|------|------|------|
| A1 | 核心策略恰为 8 条且与 manifest 一致 | PASS | TR-01/TR-03/TR-06/FS-02/FS-04/FS-05/M1/EC-01 |
| A2 | 六段强绑定完整 | PASS | 8/8 六段齐全、pricingSource=self-model、stop/target/position 均带 modelRef |
| A3 | 无跨条目模型引用 | PASS | 8/8 crossModelRefs=[]；modelRef 公式编号 ⊆ 本条目 formulas（独立复算） |
| A4 | FinCoT 只作分析层 | PASS | 8/8 noNumericPricing=true；FinCoT 仅出现在 analysisFilter 与 excluded 声明 |
| A4b | 概率锥仅目标定价（cap-6） | PASS | TR-01/03/06 coneUsage=target-only + [cap-6] + provenance 标注；stop/position 无 p95/p68；其余 5 条 coneUsage=none |
| A5 | 证伪测试完整 | PASS | 8/8 minTrades 数值（TR-06 事件类 100）、PF=1.2、三基线、理论级测试、killRules 非空 |
| A6 | 数据契约全部 available | PASS | 8 个 ref（含 EC-01→FS-08 映射）在 04-data-contracts.json 中 status=available |
| A7 | 参数有来源与冻结条件 | PASS | 55 参数 source∈四类枚举 + freezeCondition 非空 |
| A8 | H7 OI 衍生禁入 | PASS | OIΔ 仅出现在 [H7] 禁用注释语境（TR-03/TR-06），stop/target/position 无 OI 衍生信号 |
| A9 | prerequisites/asOfContract 合规 | PASS | 8/8 prerequisites ⊆ GA-id；asOfContract ⊆ F1–F9 |
| A10 | 库内 MC-1..MC-10 全 pass | PASS | 键集 = MC-1..MC-10，全部 status=pass |
| A11 | manifest 裁定完整 | PASS | cap-1..cap-6、H1–H7、D1–D11 全在 |
| A12 | revisionLog 22 项 | PASS | count=22（t9×12 + t8×6 + t7×4，t7-B 并入 t8-F-2） |
| A13 | 无编造业绩数字 | PASS | 正则已排除证伪阈值（"夏普 < 0.5"、"命中率 < 55%"等门禁文本不计入业绩声明），仅匹配"宣称已实现业绩"表述（如 夏普[=≥]数值、年化/累计/实盘/样本外收益+数值）；全库 0 命中，18/18 可复现 |
| A14 | FS-P1-02 排除出可执行集 | PASS | status=rejected_by_policy、executable=false、仅候补池留档 |
| A15 | H1/GC-1 cap-6 口径落库 | PASS | H1 与 GC-1 均含"锥仅 p68/p95、先到者、provenance=probability.json、禁用于止损/仓位" |
| A16 | TR-03 prerequisites 含 GA-2 | PASS | GA-1、GA-2（3d p68 锥管线依赖，cap-6 增量） |
| A17 | GA-7 门禁落位 | PASS | GA-7 在 04-data-contracts.json；FS-04/FS-05/EC-01 prerequisites 含 GA-7；EC-01 activationGate 在库 |

### 2.2 关键裁定落地抽查（cap-1..cap-6，逐项对照库文件）

| 裁定 | 落位抽查 | 结论 |
|------|---------|------|
| cap-1（H7 OI 禁入） | hardConstraints.H7、X11、waitlist.entries[FS-P1-02]、TR-03/TR-06 oiDerivativeStatus（defaultDisabled/replacement/restoreCondition） | ✅ |
| cap-2（复活 4 项不升 P0） | waitlist.revivalAdoptions 4 条，全部 promotionBlocked="仍需数据接入与质量门…不得直接升 P0" | ✅ |
| cap-3（GA 落地门槛） | 8/8 prerequisites 显式；MC-8 规则含"进入 in_validation 前必须全部完成"；G0/G1 门禁文本一致 | ✅ |
| cap-4（口径修正） | governance.G2.note（probability.json 仅 KEEP 品种）；waitlist.note（M13 QVIX 11 年、FS-01 EM 库存 3 个月） | ✅ |
| cap-5（F1–F9 全局契约） | globalAsOfContract 九条全文 + 8/8 asOfContract 声明 + MC-9 | ✅ |
| cap-6（概率锥口径） | H1/GC-1 修订、MC-2 改写、MC-10 新增（含 PIT 重算字样）、X1 改写、TR-01/03/06 目标行标注、TR-03 prerequisites 补 GA-2 | ✅ |

### 2.3 t11 数据校验结论采信

t11（08-final-data-audit.md）独立复算 MC-1..MC-10 + H7 全部可复现通过；8 条核心数据契约源/频率/字段/asOf 均有 t4 实测证据；未来函数 F1–F9 终审无红线；GA-1..GA-7 全部"未执行/未构建"（非不可得）且门禁正确拦截。本验收**采信 t11 结论**并复核了其数据侧要点：G0 门禁在 GA 完成前不允许任何条目进入 in_validation（validationGates.G0/G1 + statusMachine 文本确认）；EC-01 在 GA-7 完成前坚持 paper-only（activationGate 确认）。

---

## 3. 非阻塞一致性项（建议下轮修订，不构成 reject）

| # | 严重度 | 问题 | 建议修复 |
|---|--------|------|---------|
| N1 | low | `strategy-library-v2.md` §9 MC-8 证据行仍写"FS-04:GA-1；FS-05:GA-1；EC-01:GA-1"，与 JSON 条目 prerequisites（GA-1+GA-7）及 MD §4.5/4.6/4.8 不一致（v1.1 同步残留） | 下轮修订时对齐 MD §9 MC-8 证据行 |
| N2 | low | MD §1 分层图数据层标注"GA-1..GA-6"，漏 GA-7 | 改为 GA-1..GA-7 |
| N3 | low | TR-03 `dataContract.requiredGAs=["GA-1"]` 与条目 `prerequisites=["GA-1","GA-2"]` 不一致；G1 门禁若只读 requiredGAs 会漏检 GA-2 | 在 04-data-contracts.json TR-03 契约 requiredGAs 补 GA-2（3d p68 锥管线），与 MC-8 prerequisites 对齐 |
| N4 | low | FS-02 基差历史采集器未进 prerequisites[]（仅 preconditionsNote + batchOrder）——t11 L1 同项 | 契约注册采集器 id（如 COLLECTOR-basis-history），FS-02 prerequisites/requiredGAs 引用，G1 门禁机械拦截 |
| N5 | low | FS-02 asOfContract 未声明 F5（换月拼接），其余 7 条均声明（t11 L2 中 TR-01/03/06 已在 t10 版补齐） | 补 F5 声明（纯声明性） |
| N6 | info | TR-03 契约 dependencies 仍含"OIΔ"字段描述（契约层），库条目已按 H7 禁用 | 契约字段描述加注"（库 v2 按 H7 禁用）"以免验证层误判 |

以上 6 项均为文档/契约一致性，不影响任何策略的 available 判定、不产生 rejected、不构成未来函数风险；建议纳入下一次修订轮（如进入执行引擎适配阶段前的文档同步）一并处理。

---

## 4. 阶段移交声明

- **PASS 后的下一阶段**：策略执行引擎适配（把 strategy-library-v2.json 的条目翻译为执行层规则）可以在 `designed` 状态下进行**适配层开发**（只读库条目、不改库）。
- **禁止事项**：(1) 在 GA-1..GA-7 完成前对任何条目发起 in_validation/回测；(2) 修改 D1–D11 与 cap-1..cap-6 裁定；(3) 修改冻结前参数初值而不改条目 ID（H5）。
- **回测启动条件**（G0/G1 门禁）：GA-1（全历史回填）、GA-2（派生字段批量）、GA-4（宏观锚点回填）、GA-7（政策日历 v0）完成后第一批（TR-01/TR-03/FS-04/FS-05/M1/EC-01）方可进入 in_validation；FS-02 第二批还需基差采集器+GA-6；TR-06 第三批限 RB0/M0/SC0 起步（D7）。

---

## 5. 交付物

- 本报告：`strategies/research/v2/09-acceptance-report.md`
- 验收断言脚本（独立复算，可复跑）：`strategies/research/v2/t12-acceptance-check.py`（18 项 A1–A17 + 编造数字扫描；A13 正则已排除证伪阈值文本；最近一次运行 18/18 PASS，0 FAIL）

> 本验收报告为研究流程结论，不构成投资建议。
