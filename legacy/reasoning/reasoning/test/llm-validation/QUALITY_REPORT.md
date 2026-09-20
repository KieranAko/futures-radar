# FinCoT Real LLM Validation Report

**执行日期**: 2026-08-25
**模型**: DeepSeek V4 Pro（远远，生产 Analyze 阶段将使用的模型）
**测试用例**: 5 prompts × 1 model = 5 outputs（SC0, Y0, I0, EC0, AU0）
**验证方式**: 真实完整推理（三分支蓝图 + 5 门禁逐条执行），非模拟输出

## 格式合规率

| Metric | Result |
|--------|--------|
| Parse Success (extractResult) | 5/5 (100%) |
| Grounding Pass (validateGrounding) | 5/5 (100%) |
| 输入一致性校验（symbol/signalDate/strategy） | 5/5 (100%) |

验证脚本：`reasoning/test/llm-validation/validate-outputs.mjs`（packet 从 runs raw.json +
delta term_structure 重建，与单臂对照 After 臂同构）

## 推理质量（人工审查）

### SC0 @ 2026-07-30（典型共振）

**分支分析**:
- Regime: ✓ V 型反弹站上 MA20/MA60，放量 3 倍确认
- Macro: ✓ backwardation -2.71% 现货偏紧
- Position: abstain（member_position 缺失，packet 结构决定）

**门禁检查**:
- 分支数量: 2 available ✓
- 多域独立性: 3 域（价格 + 量仓 + 期限）✓
- 冲突解决: 无冲突 → high 允许 ✓

**最终输出**:
- direction: long / confidence: high ✓
- evidence_ids: 4 条跨 3 域 ✓
- reasoning_summary: 66 字，多域交叉验证 ✓

**评价**: 三域共振处理正确，V 型反弹与 backwardation 的组合解读合理。

### Y0 @ 2026-08-21（典型共振）

**分支分析**:
- Regime: ✓ 台阶式上行 + 持仓 60 日翻倍 + 近 5 日 +30%
- Macro: ✓ 轻微 backwardation -0.52%（诚实标注"幅度有限"）
- Position: abstain

**门禁检查**:
- 分支数量: 2 available ✓
- 多域独立性: 3 域 ✓
- 冲突解决: 无冲突 → high ✓

**最终输出**:
- direction: long / confidence: high ✓
- evidence_ids: 4 条跨 3 域 ✓
- reasoning_summary: 65 字 ✓

**评价**: 正确处理了"轻微 backwardation"的强度分层——期限结构作为确认信号而非主导信号，主导动能正确归因于价格趋势 + 资金流。

### I0 @ 2026-08-04（冲突识别）

**分支分析**:
- Regime: ✓ 价格破位 + 持仓 -36% 持续流出 → 看空
- Macro: ✓ backwardation -1.07% 近端偏紧 → 看多
- Position: abstain

**门禁检查**:
- 分支数量: 2 available ✓
- 方向一致性: Regime 看空 vs Macro 看多 → **门禁 2 触发 → 强制 pass** ✓
- 冲突解决: opposing_ids 非空 + direction=pass → 满足门禁 5 ✓

**最终输出**:
- direction: pass / pass_reason: conflict_unresolved ✓
- evidence_ids: []（pass 无输出方向，正确）✓
- opposing_ids: ["term_structure.spread_pct"] ✓
- reasoning_summary: 66 字，清晰描述冲突双方 ✓

**评价**: 门禁 2 与门禁 5 正确触发。这是 term_structure 字段的核心价值场景：
Before 臂（无期限结构）该案例只会输出单分支看空，After 臂正确识别了
backwardation 与下跌趋势的冲突并拒绝输出。

### EC0 @ 2026-07-30（极端 contango）

**分支分析**:
- Regime: ✓ 崩盘后远低于双均线（-31%/-43%），量能萎缩反弹乏力 → 看空
- Macro: ✓ 深度 contango +18.26% 供需极宽松 → 看空（强）
- Position: abstain

**门禁检查**:
- 分支数量: 2 available ✓
- 方向一致性: 双分支同向看空 → short 可输出 ✓
- 多域独立性: 2 域（价格 + 期限）✓
- 冲突解决: opposing_ids = [volume_oi.avgVolume5d] 非空 → **门禁 5 触发 → medium** ✓

**最终输出**:
- direction: short / confidence: medium ✓
- evidence_ids: 3 条跨 2 域 ✓
- opposing_ids: 量能萎缩作为卖压衰竭信号正确入 opposing ✓
- reasoning_summary: 65 字 ✓

**评价**: 门禁 5 的降级机制按设计工作。数据质量注记（EC2609 与主力 15% 口径差异）
已写入推理文档，方向判断未受影响（shape 判定基于 far-vs-main）。

### AU0 @ 2026-08-21（平坦结构）

**分支分析**:
- Regime: ✓ 圆弧回升 + 持仓翻倍回流 → 看多
- Macro: ✓ +0.19% 近平坦 → 中性（贡献 ≈ 0），未幻觉解读
- Position: abstain

**门禁检查**:
- 分支数量: 2 available ✓
- 方向一致性: 看多 + 中性 → 不冲突 ✓
- 多域独立性: 2 域（价格 + 量仓）形式满足；Macro 中性致实质单分支主导 → 自律降级 medium ✓

**最终输出**:
- direction: long / confidence: medium ✓
- evidence_ids: 2 条跨 2 域 ✓（term_structure 未被强行引用为证据——正确）
- reasoning_summary: 70 字，诚实说明宏观中性 ✓

**评价**: 关键案例——平坦期限结构未被过度解读（无"contango 支持做多"式幻觉），
且识别出门禁 4 形式满足但实质单分支主导的边界情形，通过 confidence 纪律自我约束。

## 总结

### 分支分析完整性
- 5/5 案例三分支分析完整（Regime / Macro / Position）
- 5/5 案例每分支有证据引用 + 方向判断
- Position/Flow 分支 5/5 abstain —— packet 无 member_position 字段所致（结构性，非推理缺陷）

### 门禁约束有效性
- 门禁 1（分支数量）: 5/5 正确执行（均为 2 available）
- 门禁 2（方向一致性）: 1/1 正确触发（I0 → conflict pass）
- 门禁 3（硬冲突）: 0 触发（无案例满足触发条件，正常）
- 门禁 4（多域独立性）: 4/4 方向输出均 ≥2 域引用
- 门禁 5（冲突解决）: 2/2 正确触发（EC0 → medium，I0 → pass）
- **无门禁被绕过**（无违反门禁仍输出 high confidence 的情形）

### reasoning_summary 质量
- 多域交叉验证: 5/5
- 简洁度（≤150 字）: 5/5（65-70 字区间）
- 无幻觉: 5/5（平坦结构未夸大、轻微信号正确分层）

### 结论
- **DeepSeek V4 Pro 推理质量合格** — 门禁约束实际生效（非摆设），推理链清晰，
  冲突识别准确，无幻觉解读
- **可以集成到 Analyze 阶段** — 格式稳定，推理质量符合预期

### 集成建议
1. Analyze 阶段用 DeepSeek V4 Pro 运行 FinCoT（与验证模型一致）
2. 添加 extractResult 错误重试（最多 2 次）
3. 添加 grounding 校验（不通过 → 降级为 pass/model_abstain）
4. 监控 reasoning_summary 长度（超过 150 字截断）
5. 保留门禁 4 的 confidence 自律习惯：Macro 分支中性时即使形式满足 2 域引用，
   也建议降级 medium（AU0 案例的边界情形）

### 遗留观察（供后续参考，不阻塞集成）
- **Position/Flow 分支系统性 abstain**：member_position 缺失使 position_flow 永远
  abstain，FinCoT 实际运行于 2 分支（Regime + Macro）。若未来接入会员持仓数据
  （member_position），三分支全 available 的推理链有进一步增益空间——数据源方向
  见 PHASE2_ROADMAP.md（已被裁定不启动，仅记录）。
- **门禁 2 的冲突粒度**：I0 案例中 Macro 仅"温和看多"（-1.07%）即触发强制 pass。
  当前规则下任何方向相反即 pass，不考虑冲突强度。若实战中 pass 率过高，
  可考虑引入冲突强度阈值（如 |spread_pct| < 1% 视为中性），需宪宪裁定。
