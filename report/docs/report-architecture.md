# futures-radar Report Architecture

**Version**: 0.1.0  
**Status**: Design Phase  
**Author**: 布偶猫/宪宪  
**Last Updated**: 2026-08-03

## 1. 目标与非目标

### 目标

1. **结构化报告生成**：固化章节、字段和决策链，确保分析流程可验证
2. **数据与判断分离**：数值由代码组装（确定性），语义判断由人工/LLM 提供（可追溯）
3. **渐进式规则化**：先半自动可用，再逐步将人工环节替换为规则
4. **三个终态产物**：每个阶段产出合法终态，不是半成品对象

### 非目标

- ❌ 固定报告行数（150 行是软预算，不是硬门禁）
- ❌ LLM 直接生成完整 Markdown（数字必须由代码组装）
- ❌ 一次性全自动化（允许半自动演进）
- ❌ 过度抽象的文件树（单文件先行，逼近 200 行再拆分）

---

## 2. 三阶段产物定义

### Stage 5A: Report Facts Assembly（确定性）

**输入 Artifacts**（三份 JSON）:
- `candidates.json` — Top 10 扫描结果
- `filtered.json` — 筛选决策（KEEP/DROP/DOWNGRADE）
- `probability.json` — HV 概率锥 + ATR 对比

**输出**: `report-facts.json`

**职责**:
- Symbol 关联与一致性校验（runId 一致性、symbol join 完整性）
- 数值字段提取（close/atr/hv/cone/divergence）
- 筛选阶段判断记录（initialDirection/initialConfidence）
- 筛选阶段文本复制（summary/watchConditions/criteria.*.note，原样保留）
- 数据质量聚合（correctionCount/totalBars/degraded）
- Provenance 记录（artifactId/runId/jsonPath/timestamp）

**禁止**:
- 合成新的自然语言描述（可复制 filtered.json 已有文本，但不得改写或总结）
- 调用 LLM
- 估算或修改数值

### Stage 5B: Analysis Integration（半自动）

**输入**:
- `report-facts.json`（5A 输出）
- `analysis.json` — 6 问深度分析

**输出**: `report-model.json`

**职责**:
- 提取 Q1-Q6 原始字符串（保留实际结构，不虚构子字段）
- 记录最终判断（finalDirection/finalConfidence/oddsBias）
- 判断变化标记（若筛选阶段与分析阶段方向/置信度不同，标记 `assessmentChanged=true`）
- 保留数值事实不变（继承 5A 的 marketFacts/priceRanges）

**当前实现**: 直接使用已有 `analysis.json`（人工填写），原样复制字符串字段  
**未来演进**: LLM 生成结构化 JSON（需先升级 analysis.json 契约）

**禁止**:
- 修改 5A 生成的数值字段
- 篡改 provenance
- 虚构结构化子字段（如从 string 推断 claim[]/sources[]）

### Stage 5C: Markdown Renderer（确定性）

**输入**: `report-model.json`（5B 输出）

**输出**: `report.md`

**职责**:
- 按模板生成 4 章结构（市场雷达/候选筛选/重点机会/今日不做什么 + 附录）
- 表格格式化（Top 10/过滤决策/价格区间）
- 数据质量警告生成（根据 degraded/correctionCount/divergencePct 规则生成警告文本）
- 缺失值统一显示（"—"）
- 判断变化提示（若 `assessmentChanged=true`，注明"筛选时判断为 X，深挖后调整为 Y"）

**篇幅预算**（软约束）:
- 避免重复解释（宏观锚点说明、方法论只出现一次）
- 每个字段限制句子数量（driver ≤3 句、risks ≤2 句）
- 不因超预算截断整个章节

**禁止**:
- 添加或修改数据
- 调用 LLM
- 重新计算数值

---

## 3. report-facts.json 契约

```typescript
interface ReportFacts {
  meta: {
    runId: string;
    generatedAt: string;  // ISO 8601
    totalSymbols: number;
    top10Count: number;
    keepCount: number;
    pipelineVersion: string;
    artifacts: {
      candidates: { runId: string, scannedAt: string },
      filtered: { runId: string, filteredAt: string },
      probability: { runId: string, calculatedAt: string }
    };
  };
  
  screening: {
    top10: Array<{
      rank: number;
      symbol: string;
      name: string;
      exchange: string;
      sector: string;
      score: number;
      indicators: {
        atr5: number;
        atrPct: number;
        hv5: number;
        hv20: number;
        volPercentile: number;
        volMultiplier: number;
        change5d: number;
      };
      trend: {
        close: number;
        vsMA20: number;
        vsMA60: number;
        direction: 'up' | 'down' | 'neutral';
      };
      liquidity: {
        avgVolume5d: number;
        avgTurnover5d: number;
        avgOI5d: number;
      };
      provenance: {
        artifactId: 'candidates-json',
        runId: string,
        index: number
      };
    }>;
    
    decisions: Array<{
      symbol: string;
      name: string;
      rank: number;
      decision: 'KEEP' | 'DOWNGRADE';
      initialConfidence: 'high' | 'medium' | 'low';
      initialDirection: 'bullish' | 'bearish' | 'neutral';
      reason?: string;  // DOWNGRADE 必填
      note?: string;    // DOWNGRADE 可选
      provenance: {
        artifactId: 'filtered-json',
        runId: string,
        path: 'candidates' | 'downgraded'
      };
    }>;
  };
  
  opportunities: Array<OpportunityFacts>;
  
  rejected: Array<{
    symbol: string;
    name: string;
    rank: number;
    reason: string;
    note: string;
    provenance: {
      artifactId: 'filtered-json',
      runId: string,
      path: 'downgraded'
    };
  }>;
}

interface OpportunityFacts {
  symbol: string;
  name: string;
  rank: number;
  
  // 市场事实
  marketFacts: {
    close: number;
    hv: {
      annual: number;
      periodDays: number;
      percentile90d: number | null;
      estimator: 'yang_zhang' | 'garman_klass' | 'close_to_close';
      correctionCount: number;
      totalBars: number;
      degraded: boolean;
    } | null;  // null 表示数据不足（<21 bars）
    provenance: {
      close: { artifactId: 'probability-json', runId: string, path: string },
      hv: { artifactId: 'probability-json', runId: string, path: string } | null
    };
  };
  
  // 价格区间（完整单元，不拆分 ATR）
  priceRanges: Array<{
    period: '3d' | '5d';
    hvCone: {
      p68: [number, number];
      p95: [number, number];
    } | null;  // null when hv=null
    atrBand: {
      atr5: number;
      band: [number, number];
    };
    divergence: {
      pct: number | null;  // null when hvCone=null
      interpretation: string;
    };
    provenance: {
      artifactId: 'probability-json',
      runId: string,
      calculatedAt: string
    };
  }>;
  
  // 筛选阶段判断与文本（原样复制 filtered.json）
  screening: {
    initialConfidence: 'high' | 'medium' | 'low';
    initialDirection: 'bullish' | 'bearish' | 'neutral';
    criteria: {
      volatility: { result: string, note: string };
      liquidity: { result: string, note: string };
      priceStructure: { result: string, note: string };
      driver: { result: string, note: string };
      risk: { result: string, note: string };
    };
    summary: string;
    watchConditions: string;
    provenance: {
      artifactId: 'filtered-json',
      runId: string,
      path: string
    };
  };
}
```

---

## 4. report-model.json 契约

```typescript
interface ReportModel {
  meta: ReportFacts['meta'];
  screening: ReportFacts['screening'];
  rejected: ReportFacts['rejected'];
  
  // 扩展 opportunities，增加 thesis 分析层
  opportunities: Array<{
    symbol: string;
    name: string;
    rank: number;
    marketFacts: OpportunityFacts['marketFacts'];
    priceRanges: OpportunityFacts['priceRanges'];
    screening: OpportunityFacts['screening'];
    
    // 分析论点（5B 新增，保留原始字符串结构）
    thesis: {
      // Q1: 驱动因素（真实字段名: q1_driver）
      driver: {
        primary: string;
        secondary: string;
        evidence: string;  // 原始 string，不拆分为 claim[]
        source: string;
        provenance: {
          artifactId: 'analysis-json',
          runId: string,
          field: 'q1_driver'
        };
      };
      
      // Q2: 趋势/脉冲（真实字段名: q2_trendOrImpulse）
      trendOrImpulse: {
        assessment: string;
        provenance: {
          artifactId: 'analysis-json',
          runId: string,
          field: 'q2_trendOrImpulse'
        };
      };
      
      // Q3: 赔率（真实字段名: q3_odds）
      odds: {
        bias: 'bullish' | 'bearish' | 'neutral';
        reasoning: string;
        provenance: {
          artifactId: 'analysis-json',
          runId: string,
          field: 'q3_odds'
        };
      };
      
      // Q4: 确认信号（真实字段名: q4_confirmation）
      confirmations: {
        signals: string[];  // 原始 string[]，不拆分为 priceLevel/volumeCondition
        provenance: {
          artifactId: 'analysis-json',
          runId: string,
          field: 'q4_confirmation'
        };
      };
      
      // Q5: 失效条件（真实字段名: q5_invalidation）
      invalidations: {
        conditions: string[];  // 原始 string[]，不拆分为 priceLevel/reasoning
        provenance: {
          artifactId: 'analysis-json',
          runId: string,
          field: 'q5_invalidation'
        };
      };
      
      // Q6: 风险（真实字段名: q6_risks）
      risks: {
        items: string[];
        provenance: {
          artifactId: 'analysis-json',
          runId: string,
          field: 'q6_risks'
        };
      };
      
      // 最终判断（来自 analysis.json 顶层字段）
      finalDirection: 'bullish' | 'bearish' | 'neutral';
      finalConfidence: 'high' | 'medium' | 'low';
      
      // 判断变化标记
      assessmentChanged: boolean;  // true 表示 screening.initialDirection/Confidence 与 final* 不一致
    };
  }>;
}
```

---

## 5. 字段来源与优先级矩阵

| 字段路径 | 来源 Artifact | 冲突处理 | 缺失策略 | 验证规则 |
|---------|--------------|---------|---------|---------|
| `meta.runId` | filtered.json | 所有 artifact 必须一致 | FAIL | 正则 `^\d{8}-\d{4}-auto$` |
| `meta.totalSymbols` | candidates.meta.preFilter.total | N/A | FAIL | ≥0 |
| `screening.top10[].close` | candidates.json (trend.close) | N/A | FAIL | >0 |
| `opportunities[].marketFacts.close` | probability.json (close) | 优先 probability | FAIL | 与 candidates 偏差 <1% |
| `opportunities[].marketFacts.hv.*` | probability.json (hv) | N/A | 降级为 null | hv=null 时 annual 不存在 |
| `opportunities[].priceRanges[].hvCone` | probability.json (cone) | N/A | 降级为 null | hv=null 时 hvCone=null |
| `opportunities[].priceRanges[].atrBand` | probability.json (atrComparison) | N/A | FAIL | 完整单元（atr5 + band） |
| `opportunities[].priceRanges[].divergence.pct` | probability.json (atrComparison.divergencePct) | N/A | 降级为 null | hvCone=null 时 divergence.pct=null |
| `opportunities[].screening.*` | filtered.json (candidates[]) | N/A | FAIL | KEEP 必须存在 |
| `opportunities[].thesis.driver` | analysis.json (q1_driver) | N/A | FAIL | primary/secondary/evidence 非空 |
| `opportunities[].thesis.confirmations.signals` | analysis.json (q4_confirmation.signals) | N/A | FAIL | 至少 1 条 |
| `rejected[]` | filtered.json (downgraded) | N/A | 允许为空 | reason 必填 |

### ATR 真相源规则

**唯一来源**: `probability.json.atrComparison`（完整单元，不拆分）

- `atr5`
- `atr2xBand` → `atrBand.band`
- `divergencePct` → `divergence.pct`
- `interpretation` → `divergence.interpretation`

`candidates.json.indicators.atr5` 仅用于：
1. Stage 4.5 的上游输入
2. 5A 的一致性校验（允许 <0.01 浮点误差）

**5A/5C 禁止直接读取** `candidates.json` 的 ATR 字段。

### 判断优先级规则

**筛选阶段判断** (filtered.json):
- `initialConfidence`
- `initialDirection`
- 职责：是否值得深挖

**分析阶段判断** (analysis.json):
- `finalConfidence`
- `finalDirection`
- `oddsBias`
- 职责：深挖后的最终方向

**报告呈现规则**:
- Chapter 3 标题使用 `finalDirection` + `finalConfidence`
- 若 `assessmentChanged=true`，在正文中注明：
  > ⚠️ 判断变化：筛选阶段评估为「看空/高置信」，深度分析后调整为「看空/中置信」

---

## 6. 系统约束与门禁

### 6.1 Run 一致性门禁

5A 必须校验所有 JSON artifact 的 `meta.runId` 一致：
- `candidates.json`
- `filtered.json`
- `probability.json`
- `analysis.json`（若存在）

任何一份 runId 不匹配，立即失败并输出诊断信息。

### 6.2 Symbol Join 门禁

每个 KEEP symbol 必须唯一命中：
- `candidates.json.candidates[]`
- `filtered.json.candidates[]`
- `probability.json.probabilities[]`
- `analysis.json.analyses[]`

**失败情况**:
- Symbol 在某 artifact 中缺失
- Symbol 在某 artifact 中重复
- KEEP 品种数量与 filtered.json 不一致

**降级情况**（允许继续）:
- `probability.json` 中某 symbol 的 `hv=null`（数据不足，合法降级）
- 此时生成降级警告，但不阻断流程

### 6.3 数据质量门禁

**硬失败**:
- `correctionCount / totalBars > 0.5`（数据损坏超过 50%）
- `totalBars < 21`（HV 计算最小要求）

**降级警告**:
- `degraded=true`（修正率 >20%）
- `divergencePct > 20%`（ATR vs HV 严重背离）
- `percentile90d=null`（历史分位数据不足）

### 6.4 分析证据门禁

**WARN 级别**（不阻断）:
- `driver.evidence` 为空
- `driver.confidence < 0.5`
- `confirmations` 数量 <1
- `invalidations` 数量 <1

**INFO 级别**:
- `confirmations` 或 `invalidations` 中包含价格但未标记 source

---

## 7. 失败与降级策略

### 7.1 5A 失败策略

| 错误类型 | 行为 | 输出 |
|---------|------|------|
| runId 不一致 | 立即退出 | 错误信息 + 各 artifact runId 列表 |
| Symbol join 失败 | 立即退出 | 缺失 symbol 列表 + artifact 来源 |
| 数值验证失败 | 立即退出 | 字段路径 + 实际值 + 预期范围 |
| 数据质量硬失败 | 立即退出 | Symbol + correctionCount/totalBars |

### 7.2 5A 降级策略

| 降级类型 | 行为 | 标记 | Renderer 行为 |
|---------|------|------|--------------|
| HV 数据不足 (<21 bars) | 继续，标记降级 | `opportunities[i].marketFacts.hv=null` | 价格区间表显示 "数据不足，无法计算 HV 概率锥" |
| OHLC 修正率 >20% | 继续，标记降级 | `degraded=true` | 在价格区间表下方显示 "⚠️ 数据质量警告：OHLC 数据修正率 >20%，HV 估算可能不准确（X修正/Y根）" |
| ATR/HV 偏差 >20% | 继续，记录偏差 | `divergence.interpretation` 包含 "❌" | 偏差行显示 "❌" 图标 + interpretation 文本 |
| HV 存在但 hvCone 计算失败 | 继续，hvCone=null | `priceRanges[].hvCone=null` | 价格区间表 HV 行显示 "—" |

### 7.3 5B 失败策略

| 错误类型 | 行为 | 输出 |
|---------|------|------|
| analysis.json 缺失 | 立即退出 | "5B 需要 analysis.json，当前为 manual boundary" |
| Symbol 对不上 | 立即退出 | 缺失 symbol 列表 |

### 7.4 5B 降级策略

| 降级类型 | 行为 | 标记 |
|---------|------|------|
| driver.evidence 缺失 | 继续，WARN | `driver.confidence=0` |
| confirmations 为空 | 继续，WARN | `thesis.confirmations=[]` |

### 7.5 5C 失败策略

所有 5C 失败都是编程错误（因为 5B 已保证 model 合法）：
- 模板缺失字段 → 立即退出
- 格式化函数抛异常 → 立即退出

---

## 8. 渐进规则化路线

### Phase 8-A（当前）

**交付目标**:
1. 5A 脚本：五份 artifacts → `report-facts.json`
2. 5B 脚本：`report-facts.json` + `analysis.json` → `report-model.json`
3. 5C 脚本：`report-model.json` → `report.md`

**当前约束**:
- 5B 直接使用已有 `analysis.json`（人工填写）
- 板块异动、成交持仓异常暂时不实现（Chapter 1 部分字段显示 "—"）
- 宏观锚点采集未自动化（Phase 3+）

### Phase 8-B（后续迭代）

**规则化目标**:
1. 板块异动规则化：
   - 按 sector 聚合 KEEP 品种
   - 代表品种选择规则（rank 最高 + volMultiplier 最大）
   - 方向规则（sector 内多数 KEEP 的 finalDirection）
2. 成交持仓异常规则化：
   - 从 `raw.json` OI 序列计算 5 日变化率
   - 异常阈值：volMultiplier ∈ [<0.8, >1.5]、OI 变化 ∈ [<-10%, >10%]
3. 驱动因素提取规则：
   - WebSearch 结果结构化解析
   - 证据强度评分规则
   - 时间相关性校验（事件日期与 runId 的天数差）

### Phase 8-C（愿景完整）

1. LLM 接入 5B：
   - 输入：`report-facts.json` + WebSearch 增强数据
   - 输出：结构化 `thesis` JSON（不直接写 Markdown）
   - 验证：证据链完整性、价格来源标记、置信度校准
2. 宏观锚点自动采集（Phase 3+）
3. 多 run 对比分析（趋势变化检测）
4. 自适应篇幅预算（根据 KEEP 数量动态调整章节压缩度）

---

## 9. Phase 8-A 验收标准

### 必须通过（P0）

1. ✅ 五份 artifacts 能稳定生成 `report-facts.json`
2. ✅ 每个关键字段有唯一来源和完整 provenance
3. ✅ KEEP/DOWNGRADE、价格区间、数据质量全部正确关联
4. ✅ Symbol join 失败时明确诊断（不静默跳过）
5. ✅ Renderer 能从 `report-model.json` 生成结构完整的四章报告
6. ✅ 修改 Markdown 展现不影响分析模型（5C 纯渲染，不回写数据）
7. ✅ 人工只补结构化分析字段，不手工拷贝数字

### 应该通过（P1）

1. 数据质量警告规则正确生成：
   - `degraded=true` → "⚠️ 数据质量警告：OHLC 数据修正率 >20%，HV 估算可能不准确"
   - `divergencePct > 20%` → "⚠️ 偏差警告：ATR 与 HV 偏差 >20%，波动率结构可能变化"
2. 判断变化标记正确显示
3. 缺失值统一显示为 "—"
4. runId 不一致时明确报错并列出所有 artifact runId

### 可以延后（P2）

1. 板块异动规则化
2. 成交持仓异常规则化
3. 多 run 数据对比
4. 自适应篇幅预算

---

## 10. 代码清理计划

### 立即删除

- `.claude/skills/futures-radar/report/generate.cjs`（失败的 CLI 自动生成路径）
- `.claude/skills/futures-radar/report/template.md` 中所有 "≤150 lines" 硬约束

### 立即修改

- `pipeline/contracts.cjs` Stage 5:
  - 保持 `auto: false`
  - manualInstruction 更新为："LLM: read report/docs/report-architecture.md. Generate report-model.json following ReportModel contract, then call 5C renderer."
  - 删除 note 中关于 "Claude CLI Windows 不兼容" 的描述

### 保留但标记为实验

- 金标准 148 行报告（`data/futures-radar/runs/20260730-1701-auto/report.md`）
  - 作用：视觉参考、篇幅预算标杆
  - 约束：不能成为运行时依赖（5A/5B/5C 不得读取历史报告）

---

## 11. 实现顺序

1. **创建 5A 脚本**（`report/build-facts.cjs`）
   - 实现 runId 一致性校验
   - 实现 symbol join 逻辑
   - 实现数值字段提取
   - 实现 provenance 记录
   - 输出 `report-facts.json`

2. **创建 5B 脚本**（`report/build-model.cjs`）
   - 读取 `report-facts.json` + `analysis.json`
   - 提取 Q1-Q6 结构化字段
   - 判断变化检测（initialDirection vs finalDirection）
   - 输出 `report-model.json`

3. **创建 5C 脚本**（`report/render-markdown.cjs`）
   - 读取 `report-model.json`
   - 生成 4 章 Markdown
   - 数据质量警告规则
   - 输出 `report.md`

4. **集成到 pipeline**
   - 更新 `contracts.cjs` Stage 5
   - 更新 `run.cjs` 添加 5A/5B/5C 执行逻辑（manual boundary，不自动运行）

5. **验证与测试**
   - 使用 20260730-1701-auto 真实数据测试
   - 对比输出 report.md 与金标准 148 行报告
   - 验证 P0 验收标准全部通过

---

**设计完成，等待复审**

[宪宪/claude-opus-4-8🐾]
