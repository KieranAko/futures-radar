# Report Template — 4 章短报告

> Stage: 5C (render-markdown.cjs) | Type: Auto deterministic | Output: `report.md`

## Input

- `report-model.json` — Complete report model with facts + thesis (from Stage 5B)

## Structure Requirements

**Four chapters + appendix.** This is a short actionable report with fixed structure:

1. **Chapter 1 (市场雷达)**: 宏观锚点表 + 板块异动 + 成交持仓异常
2. **Chapter 2 (候选品种筛选)**: Top 10 表格 + 过滤决策表
3. **Chapter 3 (重点机会分析)**: 每个 KEEP 品种完整 6 问框架 + 价格区间对比表
4. **Chapter 4 (今日不做什么)**: ≥2 个反面案例
5. **Appendix (价格区间方法说明)**: HV 概率锥 + ATR 通道 + 偏差分析 + 使用建议

**篇幅预算**（软约束，不截断）：
- 避免重复解释（宏观锚点说明、方法论只出现一次）
- 每个字段限制句子数量（Q1 driver ≤3 句、Q6 risks ≤2 句）
- 不因超预算截断整个章节（结构完整性优先）

**验收标准**: 4 章齐全 + 必填字段存在 + 数据质量警告按规则生成，不是行数门禁。

## Template

```markdown
# 期货投机机会雷达 — {YYYY-MM-DD}

> 运行 ID: {runId} | 扫描品种: {totalSymbols} | 候选: {top10count} | 深挖: {keepCount}

## 一、市场雷达

### 宏观锚点
| 指标 | 当前值 | 5日变化 | 方向 |
|------|--------|---------|------|
| 美元指数 (DXY) | — | — | — |
| 离岸人民币 (CNH) | — | — | — |
| WTI 原油 | — | — | — |
| 伦敦金 | — | — | — |
| 10Y 美债 | — | — | — |
| 文华商品指数 | — | — | — |

> ⚠️ 宏观锚点采集暂未自动化（Phase 3+）。以下分析基于品种自身量价数据 + WebSearch 事件驱动。

### 板块异动
| 板块 | 方向 | 代表品种 | 驱动线索 |
|------|------|----------|----------|
| {sector1} | ↑/↓ | {top1}, {top2} | STORY 10字以内 |
| {sector2} | → | — | 横盘无方向 |

### 成交/持仓异常
- {symbol}：成交量 {X}倍放大，持仓 {变化}
- {symbol}：持仓连续{N}日{增加/减少}

## 二、候选品种筛选

### Top 10 异动排名

| # | 品种 | 代码 | 得分 | ATR% | Vol%ile | Vol× | 5dΔ | 方向 | 趋势(vs20/60) |
|---|------|------|------|------|---------|------|-----|------|---------------|
| 1 | {name} | {sym} | {score} | {atrPct}% | {volPct}% | {volMult}× | {ch5d}% | {↑↓→} | {vsMA20}%/{vsMA60}% |
| ... | ... | ... | ... | ... | ... | ... | ... | ... | ... |

### 过滤决策

| 品种 | 决定 | 理由 |
|------|------|------|
| {sym1} | ✅ KEEP | {1 sentence why} |
| {sym2} | ✅ KEEP | {1 sentence why} |
| {sym3} | ⚠️ 观望 | {why downgraded} |
| {sym4} | ❌ DROP | 无明确驱动，纯技术面波动 |

## 三、重点机会分析

### {品种 A}：{名称}

**方向**: {多/空/观望} | **置信度**: {高/中/低}

**价格区间对比**（统计 vs 经验）:

| 方法 | 3日 68% 区间 | 3日 95% 区间 | 说明 |
|------|-------------|-------------|------|
| HV概率锥 | [{p68_lower}, {p68_upper}] | [{p95_lower}, {p95_upper}] | HV {hv_annual}% (P{percentile}) {estimator} {如果 correctionCount>0: ⚠️修正{correctionCount}根} |
| ATR通道 | — | [{atr_lower}, {atr_upper}] | ATR5={atr5} (2×ATR) |
| 偏差分析 | — | {divergence}% | {interpretation: ✅稳定/⚠️差异/❌背离} |

> **HV 概率锥说明**: 基于 Yang-Zhang 20日历史波动率的几何布朗运动模型，68%/95% 为统计置信区间。与 ATR 通道（经验波动带）互为补充，偏差 <10% 表示波动结构稳定。
> 
> {如果 degraded=true 或 correctionCount>0，**强制展示**数据质量警告}: ⚠️ **数据质量**: OHLC 修正 {correctionCount} 根 ({correctionCount/totalBars}%)，{如果 degraded=true: 修正率 >20%，HV 估算降级，概率锥可信度降低}

**Data source**: All price ranges from `report-model.json.opportunities[].priceRanges[]` (assembled from `probability.json.atrComparison` atomic unit). HV cone from `probability.json.cone`, ATR band from `probability.json.atrComparison.atr2xBand`, divergence from `probability.json.atrComparison.divergencePct`.

**驱动 (Q1)**: {一句话主驱动 + 证据来源}

**趋势/脉冲 (Q2)**: {量+仓+价 3维度判断，1-2句}

**赔率 (Q3)**: {多头证据简述} vs {空头证据简述} → {偏向哪边}

**确认信号 (Q4)**:
- {信号1，结合价格区间参考，例如: "跌破 MA20 支撑 {价位} 且成交量≥X万手 → 空头突破确认；若同时跌破 HV 95% 下沿 {p95_lower} 则为统计学极端突破"}
- {其他确认信号}

**失效条件 (Q5)**:
- {失效条件1，结合价格区间参考，例如: "重回 MA20 上方 → 空头逻辑失效；若突破 HV 95% 上沿 {p95_upper} 则彻底反转"}

**风险 (Q6)**: {主要风险1-2项}

---

### {品种 B}：{名称}

（同格式，包含"价格区间对比"表格 + HV 概率锥说明）

---

### {品种 C}：{名称}

（同格式，包含"价格区间对比"表格 + HV 概率锥说明。如果没有第3个，写"今日无第三个满足全部条件的品种"）

## 四、今日不做什么

| 品种 | 为什么不碰 |
|------|-----------|
| {sym} | 波动大({volPct}%ile)但无流动性（成交额仅{amount}） |
| {sym} | 有故事（{story摘要}）但价格结构未确认（量价背离） |
| {sym} | 方向清楚但风险过高（{具体风险}） |

---

## 价格区间方法说明

### HV 概率锥（统计置信区间）

**计算方法**: 基于 Yang-Zhang 20日历史波动率（HV）的几何布朗运动（GBM）闭式解。68% 对应 1σ，95% 对应 1.96σ。

**数学基础**: 
- 上沿 = close × exp(z × σ_daily × √days)
- 下沿 = close × exp(-z × σ_daily × √days)
- σ_daily = HV_annual / √242（242为中国期货年交易日）

**性质**: 统计学置信区间，表示"假设价格服从对数正态分布，有 68%/95% 概率落在区间内"。

**数据来源**: `close` = 最新收盘价，`HV` = 20日 Yang-Zhang 波动率（含隔夜跳空），`percentile` = HV 在 90日历史中的分位数。

**估算器**: Yang-Zhang（优先）> Garman-Klass（缺 Open）> Close-to-Close（仅 Close）。若 OHLC 数据修正率 >20%，标记 `degraded=true`。

### ATR 通道（经验波动带）

**计算公式**: `上轨 = close + 2×ATR5`, `下轨 = close - 2×ATR5`

**性质**: 基于历史波动幅度的经验波动带，不是统计学置信区间。2×ATR 表示价格在该通道外波动属于"显著偏离历史常态"，但不等同于"95% 概率覆盖"。

**数据来源**: `close` = 当前收盘价，`ATR5` = 5日平均真实波动幅度（来自 probability.json.atrComparison）

### 偏差分析

**计算**: |ATR通道宽度 - HV 95%区间宽度| / HV 95%区间宽度 × 100%

**解释**:
- <10%: 两种方法区间基本一致，波动率模型稳定 ✅
- 10-20%: 两种方法区间存在差异，波动率结构可能变化 ⚠️
- >20%: 两种方法区间严重背离，波动率模型不稳定 ❌

### 使用建议

1. ✅ **HV 概率锥作为主参考**: 统计学基础更严谨，提供 68%/95% 置信区间
2. ✅ **ATR 通道作为辅助**: 经验波动带，结合日内波动特征
3. ⚠️ **偏差 <10% 时可信度更高**: 两种方法一致时，价格区间参考价值更大
4. ⚠️ **偏差 >20% 时谨慎使用**: 波动结构剧变期，历史波动率失效
5. ⚠️ **突发事件失效**: 地缘政治、政策变化等黑天鹅事件会使两种方法同时失效
6. ⚠️ **品种差异**: EC0（集运）等超高波动品种需特殊解读（HV 可达 200-400%）

---

*免责声明：本报告由 AI 生成，仅为投机机会发现工具，不构成投资建议。所有交易决策需自行判断。*  
*数据来源：akshare (行情) + WebSearch (事件) | 波动率方法：Yang-Zhang HV + 2×ATR5 | 管道版本：0.1.0*
```

## Writing Rules

1. **Numbers are specific**: Write "ATR% 5.8%, 排名 2/59" not "波动较大". Write "成交量2.04倍放大" not "成交放量".
2. **Directions are explicit**: Every candidate gets ↑↓→. No "偏多" or "略空" — pick a side or say neutral.
3. **Chapter 4 is mandatory**: You MUST list at least 2 things you're NOT doing today, with specific reasons. This is the discipline mechanism.
4. **EC0 (集运指数) explicit caveat**: If EC0 appears in Top 3, note that HV(5) can be 200-400% (its normal range) and "volPercentile 97%" doesn't mean the same thing it means for copper. Shipping futures are structurally hyper-volatile.
5. **No forward-looking predictions**: Write "确认信号: 跌破560 + 量≥20万 → 空头确认" not "预计会跌到540".
6. **Macro anchors**: If macro data is unavailable (current state), write "—" in the table and add the ⚠️ note. Do NOT fill with stale/estimated values.
7. **Structure completeness**: All 4 chapters must be present. Quality warnings must be generated by rules (degraded/divergence/correctionCount). Soft length budget guides brevity but never truncates chapters.
8. **价格区间对比强制展示**: Every candidate in Chapter 3 MUST include "价格区间对比" table with HV 概率锥 + ATR 通道 + 偏差分析. All data from `report-model.json.opportunities[].priceRanges[]` which contains `probability.json` atrComparison atomic unit. If hv=null, show "HV 数据不可用，仅展示 ATR 通道".

## Post-Report: Update current.md

After writing `report.md`, update `{runtimeRoot}/current.md`:

```markdown
# Futures Radar — Current

**最后运行**: {runId} at {ISO timestamp}
**摘要**: {1 sentence summary of top finding}
**Top 3**:
1. {sym} {name} — {direction} | {1-line rationale}
2. {sym} {name} — {direction} | {1-line rationale}
3. {sym} {name} — {direction} | {1-line rationale}

**完整报告**: `runs/{runId}/report.md`
```
