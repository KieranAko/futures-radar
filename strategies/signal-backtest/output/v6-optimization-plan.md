# v6 盲区分类归因与优化方案（硬逻辑版）

> 状态：**v6 当前不得作为“优化完成”放行**。本文先把盲区按类别归因，再给出每个优化点的硬约束（不变量/形式谓词）与量化证据。
> 本文件只做方案，不修改代码、不重跑回测。

## 0. 结论摘要

v6 的方向正确，但存在三类不可放行问题：
1. **评估公平性**：闸门对 A 臂无信息可用却强制执行，且闸门成本未入账；
2. **规则时间有效性**：多个闸门使用锚点日快照/正则抽取的数值，作用在 0-4 天后的信号上；
3. **推断有效性**：规则在已知 4 笔失败上校准，又用同一批数据验证，属于 in-sample 自我确认。

---

## 1. 盲区分类归因

| 编号 | 类别 | 缺陷 | 严重度 | 证据 |
|---|---|---|---|---|
| B1 | 规则适用性 | G1 作用于无 macroBias/sectorBias 字段的 A 臂，谓词恒为真 | 严重 | A 臂 20 个信号被闸，其中 3 个在 v5 会成交且合计 +10.99%（2/3 正确） |
| B2 | 评估公平性 | 只报告过闸后表现，不报告闸门成本 | 严重 | C 臂 27 个信号被闸后只剩 2 笔成交、100% 正确——空集过滤也能“提高”准确率 |
| B3 | 推断有效性 | 规则在 4 笔已知失败上校准，无 holdout | 严重 | 20 锚点全部参与归因与验证，无样本隔离 |
| B4 | 规则触发条件 | G2 用正则从 FinCoT 文本抽数字，无语义标签 | 中高 | reused FinCoT 的 Q4 数值来自 5 天前，与当日触发价拼凑距离 |
| B5 | 风险结构一致性 | G3 目标帽可制造 R<1 计划 | 中高 | C 臂 44 个非 neutral 计划中 2 个 stopAtrMult>2，帽后 R=2/stopAtrMult<1 |
| B6 | 执行语义 | G5 失效价是锚点日绝对价，离入场价过远而永不触发 | 中 | v6 失效退出 0 笔；#1 失效价距入场 2.5%、#3 距 9% |
| B7 | 时间有效性 | G2 三层共振例外使用锚点日 breadth/coherence | 中 | 信号日可晚于锚点 4 天，板块广度可能已翻转；sector-history 数据可支持信号日重算但未使用 |
| B8 | 成本完整性 | 无手续费/滑点/隔周跳空定价 | 中 | pnl 均为毛收益 |
| B9 | 证据 grounding | contextRefs 只做存在性校验，不做方向一致性 linter | 低 | 可能出现“宏观利空文本 + macroBias=bullish”的自相矛盾 |
| B10 | 检测器参数 | 变化检测阈值 0.5/1.0/2.0/2 指标为手选，无敏感性报告 | 低 | 60 锚点仅 9 个 reused，复用率高度依赖阈值 |

---

## 2. 每个优化点的硬逻辑支撑

### P1（B1）：闸门适用域必须与计划信息域一致

**硬约束（形式谓词）**：
```
applicable_G1(arm) = arm ∈ {B, C}          // 这两臂的 schema 保证 macroBias/sectorBias 存在
G1_skip(plan, s) =
  applicable_G1(arm)
  ∧ triggerType = breakout
  ∧ [ (regime = shock ∨ |chg5(anchor)| ≥ 8)
      → ¬(macroBias = direction ∧ sectorBias = direction) ]
  ∧ [ |chg5(s)| ≥ 5 → ¬(trendOk(s) ∧ sectorBias = direction) ]
```
其中 `trendOk(s)` 用 `bars[0..s]` 计算。
- 若字段缺失（A 臂），`applicable_G1=false`，闸门**放弃判定**，而不是执行跳过。
- 逻辑依据：谓词 `macroBias = direction` 在 `macroBias=null` 时恒为假，因此 G1 在 A 臂上不是评估计划质量，而是评估“字段是否存在”。任何闸门只能使用该臂契约保证存在的字段。
- 量化证据：A 臂 20 个 gate_skipped 中，3 个信号在 v5 原引擎下成交、合计 **+10.99%**、方向正确 2/3。

### P2（B2）：闸门成本必须入账，报告三个不相交集合

**硬约束（集合与指标）**：
```
Eligible_t   = { 计划 executable 且当日通过基础方向门 }
Gated_t      = { s ∈ Eligible_t : gate(s) ≠ pass }        // 记录原因
Executed_t   = { s ∈ Eligible_t \ Gated_t : T+1 触发 }
SkippedCF_t  = { s ∈ Gated_t : v5 原引擎在 s 会成交 }      // 用 v5 确定性引擎回放，同一 bars
gateSavedPnl = -Σ pnl_v5(s) for s ∈ SkippedCF_t where pnl_v5(s) < 0
gateCostPnl  = +Σ pnl_v5(s) for s ∈ SkippedCF_t where pnl_v5(s) > 0
```
- 逻辑依据：过滤器的价值 = 拦掉的坏交易损失 − 拦掉的好交易利润。只报告过闸后的准确率，一个“全拦”过滤器也能达到 100%，因此该指标不构成放行证据。
- 量化证据：C 臂 SkippedCF 合计 **-10.47%（拦对了）**；A 臂 SkippedCF 合计 **+10.99%（拦错了）**。
- 放行条件：`gateSavedPnl > gateCostPnl` 且 `|Executed_t|` 达到预设最小样本，二者缺一不可。

### P3（B3）：校准集与验证集必须不相交

**硬约束**：
```
CalibrationAnchors ∩ ValidationAnchors = ∅
gate-config 必须声明 calibratedOn 与 evaluatedOn
inSample = (evaluatedOn ⊆ calibratedOn) ? true : false
生产放行要求 inSample = false
```
- 逻辑依据：规则阈值（1.5 ATR、8%、2 ATR、0.5R）是在观察 4 笔失败后设定的；在同一批数据上评价规则，期望改善是被构造出来的，不是估计出来的。
- 实施方案：20 锚点按时间切前 10 / 后 10；**前 10 只用于校准规则，后 10 只用于验证**；已知 4 笔失败跨两段，必须标注，不参与“放行”统计。最终放行需要未来未见过的锚点批次。

### P4（B4）：G2 必须结构化，禁止正则猜数

**硬约束**：
```
G2_applicable(plan) = plan.q4Confirmation 存在（结构化）
G2_skip(s) = G2_applicable
  ∧ |q4Confirmation.level - triggerLevel(s)| > 1.5 × ATR5(s)
  ∧ ¬resonance(s)
```
- 若 `q4Confirmation` 缺失（当前 v5 计划的过渡状态），G2 必须**放弃判定**，不得从 q4 文本正则抽取数字。
- 逻辑依据：文本→数字映射非单射；`q4` 文本同时含确认位、成交量阈值、整数关口，正则 + “离触发价最近”的启发式无法证明所选数字就是确认位。reused FinCoT 的 Q4 来自 5 天前，更不满足“与当日触发价可比”的前提。
- 后续 schema：`q4Confirmation = { level, levelType, driftRule: fixed|ma20_relative|atr_relative, asOf }`。

### P5（B5）：目标帽必须保证风险结构对称

**硬约束**：
```
targetDist(s) ≤ 2 × ATR5(s)               // G3 目标帽
stopDist(s)   ≤ 2 × ATR5(s)               // 新增：止损帽
R_plan(s) = targetDist(s) / stopDist(s) ≥ 1.0
若 R_plan(s) < 1.0 → 计划自动降级 watch（而不是执行负期望结构）
```
- 逻辑依据：`R = target/stop`；目标帽固定 2×ATR 后，`R = 2/stopAtrMult`。`stopAtrMult > 2 ⇒ R < 1`，数学上是不对称的负期望结构，与“安全闸”目的矛盾。
- 量化证据：C 臂 44 个非 neutral 计划中 **2 个 stopAtrMult>2** 违反该不变量。

### P6（B6）：失效退出必须能在止损带内触发

**硬约束**：
```
多头: stopPrice < invalidationLevel ≤ entryPrice
空头: entryPrice ≤ invalidationLevel < stopPrice
若计划 invalidationLevel 不满足上式 → 该计划不得声明 invalidationExit=true
后续 schema 允许 invalidationOffsetR ∈ (0, 1]，持仓失效价 = entry - direction × offsetR × R
```
- 逻辑依据：失效退出存在的意义是“在硬止损之前离场”。若 `|invalidationLevel - entry| > |stop - entry|`，失效条件在触发前已被止损截断，G5 恒为惰性规则。
- 量化证据：v6 失效退出 **0 笔**；#1 失效价距入场 2.5%、#3 距 9%，均在止损带外。

### P7（B7）：所有价格派生闸门输入必须按信号日重算

**硬约束**：
```
对任何 gate 输入 f：
  f 是价格派生量 → f 必须用 bars[0..s] 重算（close/ma20/atr5/chg5(s)/sect.br(s)/sect.co(s)）
  f 是 LLM 判断量 → 必须带 asOf=anchorDate，且只能在计划层语义中使用
```
- 逻辑依据：闸门在信号日 s 判定，却使用锚点日 i<s 的 breadth/coherence，条件是时间不一致的（不是未来泄漏，而是陈旧条件）。sector-history 冻结了 200 日全量 bars，信号日重算 br/co 是可行的，不引入未来函数。
- 实施：`gate-context.cjs` 提供 `sectorAt(s)`，与 bundle 同源重建。

### P8（B8）：净收益口径与成本敏感性

**硬约束**：
```
netPnl(s) = grossPnl(s) - costPerTrade
costPerTrade 默认 0.25R（含手续费+半跳滑点，可配置 0 / 0.25 / 0.5）
报告同时输出 gross 与 net；放行结论只引用 net
```
- 逻辑依据：5 日持仓的毛收益可能小于交易成本；无成本口径会把“接近 0 的毛收益”当成安全。
- 量化证据（已知样本）：#1 毛收益 +0.20%，扣除 0.25R（约 +0.33% 于其 R=1.33%）后为负——说明 #1 即使被 G4 保护，也未必是净盈利交易。

### P9（B9）：证据方向 linter（先告警，后升级为门禁）

**硬约束**：
```
对每个 contextRef e：
  directionHint(e) = sign(bundle 值) 或事件类型方向表
  if plan 声称 e 支持 direction 而 directionHint(e) 与 direction 相反
     ​且 e ∉ opposingRefs → 记 evidence_conflict 警告
```
- 逻辑依据：上下文可溯源的最低要求不是“条目存在”，而是“条目方向与结论方向一致或明确列为反面证据”。
- 实施：先做告警统计，冲突率>阈值再升级为 fail-closed。

### P10（B10）：变化检测器只影响 FinCoT 成本，不得影响执行判定

**硬约束**：
```
ctxChanged 只决定 FinCoT fresh/reused，不进入 G1-G5 任何执行闸门
报告必须输出 fresh/reused 两组各自的方向正确率（v5 已做）
阈值敏感性：对 0.5/1.0/2.0/2 四个阈值各跑一版 diff 统计，只报告不自动选优
```
- 逻辑依据：reused 是成本优化，不是风险判断；让成本优化器影响交易安全边界会混淆两个目标。

---

## 3. 修复后的 v6.1 执行顺序（全部硬逻辑先行，不新增 LLM）

1. **P1/P2/P5/P7**：改 `runner-v6`——G1 只作用于 B/C；三集合指标 + SkippedCF；止损帽与 R≥1；信号日重算 sector br/co
2. **P6/P8**：失效退出带宽校验 + net 成本口径（v5 计划无 invalidationOffsetR 时 G5 放弃判定）
3. **P3**：报告改为前 10 校准 / 后 10 验证，明确 `inSample` 标注，已知 4 笔失败不参与放行统计
4. **P9/P10**：证据方向 linter 输出警告；diff 阈值敏感性表（只报告）
5. **验收门槛**（全部满足才算 v6.1 通过）：
   - 三臂 `gateSavedPnl > gateCostPnl`
   - 后 10 锚点验证集上方向正确率 ≥ 校准集同臂口径，或差距可解释
   - 不存在 R<1 的 executable 计划
   - 所有价格派生闸门输入的 asOf = 信号日
   - net 口径下结论不变号
6. 只有 v6.1 通过验收，才允许进入 v7 结构化 schema 的 LLM 重生成。

---

## 4. 一句话结论

v6 的问题不是“闸门太多或太少”，而是**闸门作用域、时间一致性和评估口径没有硬约束**。上述 10 个优化点把每个闸门都绑到一个可机械校验的不变量上；在 v6.1 满足验收门槛之前，不得放行，也不得用新 LLM 计划掩盖问题。
