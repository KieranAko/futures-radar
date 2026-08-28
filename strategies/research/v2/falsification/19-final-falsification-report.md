# 19 — 策略库 v2 证伪验证最终报告

> **任务**: t10 · quant-researcher · 2026-08-28
> **上游**: GA-1..GA-7 数据前置与验证（t1–t6，全 pass）→ 证伪框架（t7，22/22 自测）→ 8 条核心策略 walk-forward 证伪执行（t8，seed=20260828）→ 交易员复核（t9，18-review.md：框架/公式忠实度 pass，报告层 R1/R5/R6 与裁定级 R2/R3/R7/R8 需修订）→ 本报告（t10：修订落定 + 最终状态 + 库状态更新）。
> **状态更新范围**: `strategies/strategy-library-v2.json` 仅更新每条策略的 `status` / 新增 `falsificationStatus` / `statusNote` 状态字段；**未改动任何理论/模型/定价/参数（唯一例外：M1 的 β̂<0 入池门，队长终裁 R8 明确授权并注明裁定来源，属修正库内矛盾非调参）**。
>
> **队长终裁（2026-08-28，9 项）已全部落实**：R1 数字对齐+勘误记录；R2 TR-03 ② 两步执行（vacuous+收紧重验 PF 0.374<1→retired）；R3 EC-01 retired=队长裁定表述；R4 EG2 统一复跑；R5/R6 FS-05 措辞；R7 M1 symbol-freeze 语义；R8 M1 β̂<0 入池门（库 direction/F2 已写入+重跑 25→7 笔）；最终状态落库；本报告记录全部裁定与 N1–N11 台账（§5/§6）。

---

## 1. 执行摘要

策略库 v2 的 8 条核心策略已完成预注册口径的 walk-forward 证伪验证（T+1 执行、purged expanding 年折、PIT 无未来函数硬守卫、三基线、95% CI、理论级证伪、killRules，全链路 seed=20260828 确定性可复现，t9 独立复算确认）。

**最终状态（队长终裁确认）：retired ×2（TR-03、EC-01）、suspended ×5（TR-01、TR-06、FS-04、FS-05、M1）、designed ×1（FS-02）**。队长 9 项终裁已全部落实（§5）；FS-05 收抛储事件粒度保留为待裁定 needs-clarify（不改变当前 suspended 状态）。

## 2. 数据前置完成度（G0 门禁）

| GA | 状态 | 关键证据（t6 独立验证） |
|---|---|---|
| GA-1 全历史日线回填 | ✅ pass | 59/59 品种、178,310 根 bar（2005-01-04..2026-08-28）、0 失败/0 未来日期、per-bar source/asOf、452 根换月跳变留档（F5） |
| GA-2 派生指标批量 | ✅ pass | 59/59 ATR5/HV20/HVpct90/MA20/MA60/量比/3d5d 锥，PIT per-bar，独立重算对拍 ≤1.9e-8 |
| GA-3 板块序列重建 | ✅ pass | 7 板块全历史序列，与旧快照逐字段全等 |
| GA-4 宏观历史回填 | ✅ pass | US10Y 8928 行（1990+）、DR007 2906 行（2015+，FDR007/FR007 拼接纪律+剔除窗口） |
| GA-5 USDCNH change5d 修复 | ✅ pass | 宏历史回退，change5d=−0.08 有限，无裸 null |
| GA-6 现货粘性质量门 | ✅ pass | 42 可交易/12 剔除；**两项采集器风险纳入验证**：①基差符号统一 br=(S−F)/S（daily 接口 dom_basis_rate=(F−S)/S 须取反，RB0 实证）；②现货同日修订风险 → F7 PIT 逐日快照硬执行 |
| GA-7 政策日历 v0 | ✅ pass | 9 事件窗口+9 排期，F9 discipline 断言全过；FS-05(c) 反倾销立案日期实证修正为 **2024-09-09（商务部 2024 年第 37 号）**，库/源文档/日历 ⚠ 提示全部对齐（2026-08-28 修订链完整） |

**未覆盖缺口（G0 之外，如实声明）：**
1. **FS-02 基差历史缺失**：2011+ PIT dom_basis_rate 采集器未运行（仅 GA-6 单次快照）→ FS-02 未执行证伪，停留 designed（非证伪失败）。
2. **TR-06 Q1 驱动文本**：无多年度 FinCoT Q1 历史归档（F6 禁未来重跑）→ 事件判定按价格+量能两条件，Q1 项历史不可评估。
3. **停板可执行性**：仓库无日内涨跌停价序列，v0 未做停板检查（risk-framework §1/§6 条款留待实盘口径复核）。
4. **加仓条款**：TR-01/TR-03/TR-06 的加仓（+0.5 单位）未实现（v0 单笔）。
5. **交割距离条款**（距交割月 ≥20 日）：主力连续序列无交割日历字段，未实现（记录）。

## 3. 最终状态与依据（数字=机器产物，t9 复核一致）

| 策略 | 状态 | 核心证据 |
|---|---|---|
| TR-01 趋势延续 | **suspended** | n=1756、meanR +0.0095、PF 1.034<1.2、95% CI [−0.025,0.044] 含 0；理论级确认机制**未证伪**（确认 +0.0095R vs 无确认 −0.0158R）→ edge 强度不足覆盖成本，保留 re_evaluation 路径 |
| TR-03 趋势回踩续势 | **retired** | n=1119、meanR −0.0998、PF 0.429、CI [−0.117,−0.082] 全负、0/12 年、12 折连续命中<50%；理论级②按库原文两步执行（R2 终裁）：>1.5R 子样本 vacuous + 收紧 1.0×ATR5 重验 n=37、PF 0.374<1 → retired |
| TR-06 事件冲击确认 | **suspended** | 2015–2026 事件 0 起（|r|≥max(2ATR,3%)∧量比≥2）→ 滚动 24 月<30 样本门禁触发（库 killRules）；chase/delayed 理论测试 0 样本未执行；事件定义 needs-clarify |
| FS-02 基差分位回归 | **designed**（保持） | 数据前置不满足（基差历史缺失），blocked 未执行，非证伪失败 |
| FS-04 黑色利润分位 | **suspended** | n=43、理论级 (b) 夏普 0.077<0.5 证伪；(a) 3 样本 inconclusive；(d) 比较检验无样本未执行；F5 门（eg2 统一后）暂停占比 56.7%>50% 触发 kill |
| FS-05 农产品价差回归 | **suspended** | 理论级 (b) 回归命中 38.7%<55% 证伪；4/4 已评估对协整通过率<70% 全剔除（C0-CS0 未评估）；2016 起被 GA-7 收抛储事件前提开关整窗暂停（事件粒度待裁定） |
| M1 DR007 流动性冲击 | **suspended** | β̂<0 入池门（R8 终裁）重跑后 n=7<200、PF 0.345<1.2、CI [−0.183,0.040] 含 0、windowGate 达标占比 0%（窗内 1–5 笔）；全池方向命中 57.1% 未证伪；symbol-freeze 语义（R7）已生效（本次未触发） |
| EC-01 能化成本传导 | **retired** | 理论级 (b) 夏普 −0.615<0.5 证伪 + 9/9 品种对模型级门排除率 84–91%（eg2 口径，R4 统一）→ 池空；n=10、PF 0.119、CI 严格为负；paper-only；retired=**队长终裁（R3）**：G4 兜底+池空+paper-only，非库 killOn 直接映射 |

**状态机语义**：suspended = 停用规则/门禁触发（停止新开仓，按失效退出，可 re_evaluation）；retired = 理论级证伪成立（新 ID 才可回归）；designed = 数据前置未满足（FS-02）或样本不足且未证伪。

## 4. 库状态更新（strategy-library-v2.json，仅状态字段）

对 8 条核心策略条目执行：
- `status`: designed → 最终建议状态（TR-03/EC-01=retired；TR-01/TR-06/FS-04/FS-05/M1=suspended；FS-02 保持 designed）。
- 新增 `falsificationStatus`（同值）与 `statusNote`（判定依据：核心数字 + 报告溯源 + 裁定标注）。
- **未改动**：theory / marketModel / pricingModel / strategy / parameters / falsificationTests / killRules / dataContract 任何字段；revisionLog 追加一条 t10 状态更新记录（含 8 条条目与 17/18/19 号报告溯源）。

## 5. 提交队长裁定的 5 项

| # | 队长终裁（2026-08-28） | 落实情况（全部完成） |
|---|---|---|
| R1 | 17 号报告与机器产物逐数字一致，保留勘误记录 | ✅ §1/§2/§3.x 逐格对齐；勘误记录表 15 行（17 号报告 §7） |
| R2 | TR-03 ② 按库原文执行『收紧后重验』；代理说明与机器执行完全一致，不得虚报 | ✅ 两步执行：>1.5R 子样本按规则恒为空（vacuous，如实记录）+ 收紧 1.0×ATR5 门槛嵌套重跑 n=37、PF 0.374<1 → 仍不达标 → retired；evidence 机器一致 |
| R3 | EC-01 allPairsExcluded→retired 记录为队长裁定（G4 兜底+池空+paper-only），不伪装库 killOn | ✅ 库 statusNote 与 spec 注记均已改写为队长裁定表述 |
| R4 | EC-01 残差 ADF 与 FS-05 eg2 一致，否则重跑 | ✅ 统一 EG2 表（EC-01/FS-04 一并统一并复跑：EC-01 10 笔、FS-04 43 笔）；16-harness §8 口径裁决已记录 |
| R5/R6 | FS-05 报告措辞修正，明确实际执行与库测试差异 | ✅ (a)=4/4 已评估对全剔除 + C0-CS0 从未评估；(c)=窗口内 0 交易检验 vacuous |
| R7 | M1 killRule 语义改 symbol-freeze（冻结触发品种，不改策略状态） | ✅ gates.cjs 实现 symbol-freeze 分支（记录冻结清单，不改状态）；spec onTrigger=symbol-freeze；本次 maxConsec=1 未触发 |
| R8 | M1 增加入池门 β̂<0（修正库内矛盾，非调参），写入库 direction/公式并注明来源 | ✅ 库 M1.strategy.direction 与 marketModel.formulas F2 已写入（注明 R8 队长终裁 2026-08-28）；adapter 实现并重跑 25→7 笔 |
| — | 最终状态落库（仅状态字段，M1 门除外） | ✅ 8 条条目 status/falsificationStatus/statusNote + revisionLog wf-t10-captain-final-rulings |
| — | 本报告记录全部裁定与 N1–N11 台账 | ✅ §5（本表）+ §6（19 项台账） |
| — | FS-05 收抛储事件粒度 | 保留 needs-clarify（未改日历），待裁定；不影响当前 suspended 状态 |

## 6. needs-clarify 台账（19 项，不阻断落库）

t8 原有 11 项（17 号报告 §4 下段）+ t9 新增 N1–N11（17 号报告 §4 上段，N6/N10 已修复），关键项：TR-01 同品种并发 260/1756（N1）、TR-01 时间止损语义（N2）、TR-03 U 态无 g_t 定义（N3）、TR-06 量比持续单日（N4）、FS-04 (b) 标签 RB+J（N5）、M1 成本/HV 口径（N7）、manage 钩子守卫限定（N9）。

## 7. 产物清单

| 产物 | 路径 |
|---|---|
| 最终报告（本文件） | `strategies/research/v2/falsification/19-final-falsification-report.md` |
| 证伪结果（t10 修订版） | `strategies/research/v2/falsification/17-falsification-results.md` |
| 汇总 JSON（schema v2） | `strategies/research/v2/falsification/data/harness-runs/17-falsification-results.json` |
| 每策略明细 ×7 | `data/harness-runs/<SPEC>-seed20260828.{json,md}` |
| 交易员复核 | `strategies/research/v2/falsification/18-review.md` |
| 框架报告/自测 | `16-harness.md`、`data/harness-selftest.json`（22/22） |
| 数据前置报告 | `10-ga-plan.md`、`11-ga1-full-history.md`、`12-ga4-ga5-macro.md`、`13-ga6-ga7-calendar.md`、`14-ga2-ga3-derived.md`、`15-ga-validation.md` |
| 库状态更新 | `strategies/strategy-library-v2.json`（status/falsificationStatus/statusNote + revisionLog） |
| 框架与 adapter/spec | `harness.cjs`、`harness-lib/**`、`specs/*.json` |

复现：`node harness.cjs run --spec <ID> --seed 20260828 --out data/harness-runs`；`node harness.cjs selftest`（22/22 PASS）。
