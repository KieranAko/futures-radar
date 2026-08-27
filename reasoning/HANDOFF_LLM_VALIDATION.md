# FinCoT Real LLM Validation — 实施方案（修正版）

**交接对象**: @阿比西尼亚猫 (远远)  
**预计工时**: 1.5-2 小时  
**优先级**: P1（term_structure 集成前的质量验证）

---

## What（做什么）

**修正**: 远远（DeepSeek V4 Pro）直接作为 FinCoT 推理模型，跑完整的 5 个 After prompts，输出详细的推理过程。

**验证目标**:
1. reasoning_summary 是否真的多域交叉验证（不是单纯复述证据）
2. evidence_ids 是否正确引用 ≥2 个独立域
3. opposing_ids 是否在冲突场景正确填充
4. 推理过程是否展示了门禁约束的实际作用

---

## Why（为什么）

单臂对照（Step 5）用的是远远自跑，但那次是"快速模拟"（我代远远写的输出）。

这次是**真实推理验证**：
- 远远按照 FinCoT prompt 完整推理（包括三分支分析 + 门禁检查）
- 输出详细推理过程（不只是最终 JSON）
- 验证门禁约束是否真的约束了推理（不是被绕过）

---

## 实施清单

### Step 1: 准备测试用例（15min）

从单臂对照的 10 例中选择 **5 例 After prompts**，覆盖不同场景：

**选择标准**:
1. **典型共振**（2 例）: SC0 @ 2026-07-30, Y0 @ 2026-08-21
   - 期限结构与趋势同向，预期 long/high，三域共振
2. **冲突识别**（1 例）: I0 @ 2026-08-04
   - backwardation 与价格下跌冲突，预期 pass (conflict_unresolved)
3. **极端 contango**（1 例）: EC0 @ 2026-07-30
   - contango +18%，预期 short/medium，opposing_ids 非空
4. **平坦结构**（1 例）: AU0 @ 2026-08-21
   - contango +0.19%，期限结构贡献中性，预期 long/medium（双域支撑）

**输出**: 5 个 prompt 文件已存在于 delta 目录：
- `reasoning/test/llm-validation-deltas/SC0-20260730-after.prompt.md`
- `reasoning/test/llm-validation-deltas/Y0-20260821-after.prompt.md`
- `reasoning/test/llm-validation-deltas/I0-20260804-after.prompt.md`
- `reasoning/test/llm-validation-deltas/EC0-20260730-after.prompt.md`
- `reasoning/test/llm-validation-deltas/AU0-20260821-after.prompt.md`

---

### Step 2: 远远自己推理（1h）

**不调用外部 API**，远远直接作为 FinCoT 模型，对每个 prompt 执行完整推理。

**推理要求**:
1. 按照 FinCoT prompt 的三分支结构分析（Regime / Macro / Position）
2. 执行所有 5 条门禁检查（分支数量 / 方向一致性 / 硬冲突 / 多域独立性 / 冲突解决）
3. 输出格式：
   ```markdown
   ## Case: SC0 @ 2026-07-30
   
   ### 分支分析
   
   **Regime（必须 available）**:
   - 证据：price_data.ma20 = 570.8, ma60 = 561.3
   - 分析：价格站上 MA20/MA60，V 型反弹
   - 方向：看多
   
   **Macro/Fundamental**:
   - 证据：term_structure.spread_pct = -2.71% (backwardation)
   - 分析：现货偏紧，近月溢价
   - 方向：看多
   
   **Position/Flow**:
   - 证据：volume_oi.avgVolume5d = 100253
   - 分析：持仓持续增加
   - 方向：看多
   
   ### 门禁检查
   
   1. 分支数量：3 available ✓
   2. 方向一致性：三分支同向看多 ✓
   3. 硬冲突：无 ✓
   4. 多域独立性：引用 3 域（价格技术 + 期限结构 + 量仓）✓
   5. 冲突解决：opposing_ids 为空 ✓
   
   ### 最终输出
   
   ```json
   {
     "symbol": "SC0",
     "signalDate": "2026-07-30",
     "strategy": "fincot",
     "direction": "long",
     "confidence": "high",
     "pass_reason": null,
     "evidence_ids": ["price_data.ma20", "term_structure.spread_pct", "volume_oi.avgVolume5d"],
     "opposing_ids": [],
     "reasoning_summary": "价格 V 型反弹站上 MA20/MA60，backwardation -2.71% 显示现货偏紧，持仓持续增加，三域共振看多",
     "invalidate_if": ["价格跌破 MA20 且 backwardation 收窄"],
     "branch_status": {
       "regime": "available",
       "macro_fundamental": "available",
       "position_flow": "available"
     }
   }
   ```
   ```
   
**输出**: 5 个推理文档
- `reasoning/test/llm-validation/outputs/SC0-20260730.md`
- `reasoning/test/llm-validation/outputs/Y0-20260821.md`
- `reasoning/test/llm-validation/outputs/I0-20260804.md`
- `reasoning/test/llm-validation/outputs/EC0-20260730.md`
- `reasoning/test/llm-validation/outputs/AU0-20260821.md`

---

### Step 3: 格式验证（15min）

对每个输出的 JSON，运行 extractResult + validateGrounding：

```bash
cd reasoning/test/llm-validation
node validate-outputs.mjs
```

**验收标准**:
- 5/5 解析成功（extractResult 不抛错）
- 5/5 grounding 通过（validateGrounding.grounded === true）

---

### Step 4: 质量审查与报告（30min）

#### 4.1 审查推理过程

对每个案例，检查：

**1. 分支分析完整性**:
- ✓ 三分支都有明确分析（Regime / Macro / Position）
- ✓ 每个分支有证据引用 + 方向判断
- ✗ 跳过某个分支或只给结论不给证据

**2. 门禁约束有效性**:
- ✓ 门禁 1（分支数量）正确触发（Before 案例应该 pass）
- ✓ 门禁 4（多域独立性）正确约束（单域不输出或降级 medium）
- ✓ 门禁 5（冲突解决）正确触发（I0/EC0 opposing_ids 非空 → medium 或 pass）
- ✗ 门禁被绕过（明明违反但仍输出 high confidence）

**3. reasoning_summary 质量**:
- ✓ 多域交叉验证（如"价格突破 + backwardation + 持仓增加"）
- ✓ 简洁（≤150 字）
- ✗ 单域复述（如"价格突破 MA20"）
- ✗ 幻觉解读（如"contango +0.2% 显示强烈做多信号"）

#### 4.2 生成报告

**输出**: `reasoning/test/llm-validation/QUALITY_REPORT.md`

```markdown
# FinCoT Real LLM Validation Report

**执行日期**: 2026-08-25  
**模型**: DeepSeek V4 Pro（远远）  
**测试用例**: 5 prompts（SC0, Y0, I0, EC0, AU0）

## 格式合规率

| Metric | Result |
|--------|--------|
| Parse Success | 5/5 (100%) |
| Grounding Pass | 5/5 (100%) |

## 推理质量（人工审查）

### SC0 @ 2026-07-30（典型共振）

**分支分析**:
- Regime: ✓ 价格 V 型反弹站上 MA20/MA60
- Macro: ✓ backwardation -2.71% 现货偏紧
- Position: ✓ 持仓增加

**门禁检查**:
- 分支数量: 3 available ✓
- 多域独立性: 3 域（价格 + 期限 + 量仓）✓
- 冲突解决: 无冲突 ✓

**最终输出**:
- direction: long / confidence: high ✓
- evidence_ids: ["price_data.ma20", "term_structure.spread_pct", "volume_oi.avgVolume5d"] ✓
- reasoning_summary: "价格 V 型反弹站上 MA20/MA60，backwardation -2.71% 显示现货偏紧，持仓持续增加，三域共振看多" ✓

**评价**: 三域交叉验证完整，推理链清晰，门禁约束正确执行。

### I0 @ 2026-08-04（冲突识别）

**分支分析**:
- Regime: ✓ 价格跌破 MA20/MA60，看空
- Macro: ✓ backwardation -1.07% 近端偏紧，看多
- Position: ✓ 持仓流出，看空

**门禁检查**:
- 分支数量: 3 available ✓
- 方向一致性: Macro 与 Regime/Position 冲突 → 触发门禁 2 ✓
- 冲突解决: opposing_ids 非空 → pass ✓

**最终输出**:
- direction: pass / pass_reason: conflict_unresolved ✓
- opposing_ids: ["term_structure.spread_pct"] ✓
- reasoning_summary: "价格跌破 MA20/MA60 + 持仓流出显示看空，但 backwardation -1.07% 显示近端偏紧，分支冲突" ✓

**评价**: 冲突识别正确，门禁 2 和门禁 5 正确触发，opposing_ids 正确填充。

...（其他 3 个案例）

## 总结

### 分支分析完整性
- 5/5 案例三分支分析完整
- 5/5 案例每个分支有证据 + 方向判断

### 门禁约束有效性
- 门禁 1（分支数量）: 5/5 正确执行
- 门禁 4（多域独立性）: 5/5 正确约束（≥2 域）
- 门禁 5（冲突解决）: 2/2 正确触发（I0/EC0）

### reasoning_summary 质量
- 多域交叉验证: 5/5
- 简洁度（≤150 字）: 5/5
- 无幻觉: 5/5

### 结论
- **DeepSeek V4 Pro 推理质量优秀** — 门禁约束正确执行，推理链清晰，冲突识别准确
- **可以集成到 Analyze 阶段** — 格式稳定，推理质量符合预期

### 集成建议
1. Analyze 阶段用 DeepSeek V4 Pro 运行 FinCoT
2. 添加 extractResult 错误重试（最多 2 次）
3. 添加 grounding 校验（不通过 → 降级为 pass/model_abstain）
4. 监控 reasoning_summary 长度（超过 150 字截断）
```

---

## Tradeoff（技术权衡）

### 修正：远远自己推理 vs 调用外部 API

**原方案**: 调用 Claude Opus 4.8 + Gemini 2.0 Flash
- 优点：可以对比不同模型的推理质量
- 缺点：需要外部 API key，成本高，环境复杂

**修正方案**: 远远（DeepSeek V4 Pro）自己推理
- 优点：无需外部依赖，远远本身就是执行猫，推理质量可控
- 缺点：只验证单模型（但这正是生产环境会用的模型）

---

## Open Questions（开放问题）

**无** — 修正后方案不依赖外部 API，环境问题已解决。

---

## Next Action（下一步）

### 远远执行顺序

1. **读取 5 个 prompt 文件**（5min）:
   ```bash
   ls reasoning/test/llm-validation-deltas/*-after.prompt.md
   ```

2. **对每个 prompt 执行推理**（1h）:
   - 按三分支结构分析（Regime / Macro / Position）
   - 执行 5 条门禁检查
   - 输出详细推理文档（分支分析 + 门禁检查 + 最终 JSON）

3. **格式验证**（15min）:
   ```bash
   node reasoning/test/llm-validation/validate-outputs.mjs
   ```

4. **质量审查**（30min）:
   - 检查分支分析完整性
   - 检查门禁约束有效性
   - 检查 reasoning_summary 质量

5. **生成报告**（15min）:
   写 `QUALITY_REPORT.md`，包含格式合规率、推理质量、集成建议。

### 升级条件

遇到以下情况时，停止执行并升级给宪宪：
- 格式合规率 <80%（4/5 解析失败）
- 门禁约束失效（明显违反但仍输出）
- 推理质量全面退化（5/5 单域依赖或幻觉）

### 完成标志

- [ ] 5 个推理文档完成（详细推理过程 + 最终 JSON）
- [ ] 格式验证通过（5/5 解析 + grounding）
- [ ] 质量审查完成
- [ ] `QUALITY_REPORT.md` 报告完成
- [ ] 报告包含明确的集成建议

---

**签名**: 布偶猫/宪宪 [claude-opus-4-8 🐾]  
**日期**: 2026-08-25（修正版）  
**预计完成**: 2026-08-25 EOD
