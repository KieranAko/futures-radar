# 完整 Analyze 恢复 + 效率优化方案（candidate v2）

> 目标：恢复生产级完整 analyze（freeze-packets / 当日 WebSearch / 完整 FinCoT），
> 但**效率高于生产**：在信息处理（调用拓扑、token、时延）与信息结构（输出契约、报告分层）
> 上做优化，不照搬生产实现。
> 参考：arXiv:2506.16123v5（FinCoT：蓝图嵌入 + `<thinking>/<output>` + selfCheck 三检 + grounding）。
> 状态：方案阶段，未实现。按 v6 纪律，实现为 analyze 环节 candidate v2，影子验证通过后才 promote。

---

## 0. 效率 KPI（预注册式验收线）

| 指标 | 生产现状（3 品种） | 目标 |
|------|-------------------|------|
| LLM 调用次数 | ≈ 7-9 次（板块驱动 N 次 + FinCoT×3 + 六问×3） | ≤ 3 次 |
| 生成 token | 基线 100% | ≤ 60% |
| 端到端时延 | 基线 100% | ≤ 50%（并行） |
| grounding 通过率 | 100%（fail-closed） | 100%，不得降低 |
| 与生产结论一致率（影子期） | — | 方向 ≥90%；不可解释分歧=失败 |
| 信息完整度 | 六问字段全 | 六问字段全（可从压缩结构无损恢复） |

## 1. 生产 analyze 的瓶颈（先诊断，再优化）

信息流：`packet 冻结 → 板块驱动（每板块一次 LLM）→ FinCoT（每品种一次 LLM）→ parser/grounding → 六问（每品种一次 LLM）→ analysis.json`。

四个真实瓶颈：
1. **串行多轮**：板块与品种、品种与品种之间无并行；每步等上一步。
2. **信息重复**：FinCoT 的 reasoning 与六问回答同一组问题，两套结构各生成一遍，parser 在中间搬运。
3. **上下文重复**：每品种重读完整 packet；跨日不变的板块/宏观/元数据每天全量重进上下文。
4. **搜索低效**：WebSearch 每品种单独触发，重复且无批量归并。

信息结构问题：FinCoT 的 selfCheck 是自由文本（机器不可直接校验）；报告只展示六问，reasoning 的价值被丢弃。

## 2. 优化设计（六项）

### O1 单轮合并推理（FinCoT × 六问 → 一次结构化输出）

- 一次 LLM 输出**直接等于 analysis.json 的六问字段 + mechanismRef + selfCheck 机器字段**；
- 保留 FinCoT v5 的 `<thinking>`（内部推理）与 `<output>`（即契约），但删除 reasoning-results 与六问之间的中间层；
- selfCheck 三检（unitCheck / evidenceCheck / opposingCheck）输出布尔+证据 id，不再是叙述文本，parser 直接校验。

### O2 板块驱动批量化 + 跨日缓存

- 一次 prompt 覆盖全部板块（≤7），分块输出 `{sector, direction, driver, invalidation}`；
- 与昨日观测值 hash 相同的板块自动复用昨日结论（只标 `cached`），LLM 只推理**发生变化**的板块；
- 信息处理优化：把"重复读"变成"只读 diff"。

### O3 机制候选前置（接 v6 机制目录）

- packet 冻结后，机制目录先做 family 候选筛选（如 "carry 候选：TH-CARRY-01/02/03；momentum 候选：H-MECH-01"），随 prompt 注入；
- FinCoT 只在候选族内判断"适用/不适用"，输出 `mechanismRef`；
- 信息结构收益：推理搜索空间缩小；可信度三层合成的"状态匹配"从 unknown 变为可判定。

### O4 确定性预填最大化

- 扩展 prefill：Q2 全部、Q6 全部可计算项、Q4/Q5 的**结构位条款**（MA20/前高前低/ATR 自动解析）全部由确定性脚本生成；
- LLM 只写：Q1 驱动与证据、Q3 最终判断与赔率摘要、Q4/Q5 的**驱动类条款**（事件/政策类失效）；
- 目标：LLM 生成量降 50%，且把 LLM 从"计算"中解放出来。

### O5 增量上下文（复活 V5 context-diff）

- 复用 V5 的 context-diff 资产：FinCoT 输入 = 昨日结论卡（hash 引用）+ 今日增量（新 bar、宏观 5d 变化、事件日历新条目）；
- WebSearch 只在驱动缺失/变化时触发，且**一次批量搜索**覆盖三品种的关联词（如"黑海 粮道 菜粕 豆粕"）。

### O6 并行执行图

```
packet 冻结 ∥ 板块快照
   → 板块驱动（批量）∥ 宏观增量
      → FinCoT×3（并行，同输入快照，无依赖）
         → 六问合并输出（O1 已并入）→ 组装 → 报告
```

## 3. 信息结构优化（报告侧）

报告正文从"六问全量叙述"压缩为**四卡**：

| 卡 | 承载 | 来源字段 |
|----|------|---------|
| 驱动卡 | 一句话驱动 + 证据来源/时效 | Q1 |
| 结构卡 | 量价结构 + 期限结构 | Q2 + term_structure |
| 判断卡 | 方向/置信度 + 机制族 + 可信度 | Q3 + mechanismRef + trust |
| 执行卡 | 触发/止损/目标/仓位/失效 | 策略板块已有 |

约束：六问字段必须能从四卡**无损恢复**（影子期用信息等价性检查保证，不降低生产报告对比性）。

## 4. 落地路径（v6 纪律）

1. 实验线实现为 `analyze candidate v2`（register：判决规则 = KPI 表 + 影子一致率阈值 + grounding 100%）；
2. 回放历史 run（生产输入快照）验证六问等价性；
3. 影子并行 N 期（与生产同数据，对比方向/置信度/可信度一致性）；
4. 达标 → **整段 promote analyze 环节**（配置+prompt+工具+测试一起搬回生产）；
5. 未达标 → 保留生产 analyze，candidate 退回继续迭代。

## 5. 与 FinCoT v5 的对齐声明

- **保留不动**（论文核心）：领域蓝图嵌入、`<thinking>/<output>` 结构化、selfCheck 三检、grounding 双域 fail-closed。
- **优化的是调用拓扑与信息结构**：单轮合并、批量化、增量上下文、机制候选前置。论文没有规定这些工程拓扑，本方案在不改推理内核的前提下重排信息流。
- **不照搬**：生产的三轮串行（FinCoT→parser→六问）是本方案要消解的对象，而不是复刻对象。
