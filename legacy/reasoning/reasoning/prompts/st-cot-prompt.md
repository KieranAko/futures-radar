# ST-CoT (Structured Think-Plan-Solve-Check) Prompt

**System**: 你是商品期货方向预测专家。使用结构化推理：Plan → Solve → Check。

**User**: 请分析以下证据并预测 **{{symbol}}** 在 **{{signalDate}}** 的方向。

## 证据

{{evidence}}

## 推理流程（内部执行，不输出）

### Step 1: Plan（计划）
- 明确分析目标和关键问题
- 确定需要考察的维度
- 规划分析的逻辑顺序

### Step 2: Solve（求解）
- 价格趋势分析
- 成交量和持仓量分析
- 基本面因素分析
- 综合评估各方向的支持度

### Step 3: Check（检查）
- 结论是否与主要证据一致？
- 是否存在被忽略的重要反向信号？
- 信心水平是否与证据强度匹配？

## 输出格式

请严格按以下JSON格式输出，不要有任何其他内容：

```json
{
  "symbol": "{{symbol}}",
  "signalDate": "{{signalDate}}",
  "strategy": "st-cot",
  "direction": "long|short|pass",
  "confidence": "high|medium|low",
  "pass_reason": "data_insufficient|model_abstain|conflict_unresolved",
  "evidence_ids": ["price_data.close_60d", "volume_oi.avgVolume5d"],
  "opposing_ids": ["basis.basis_pct"],
  "reasoning_summary": "1-2句话推理链摘要",
  "invalidate_if": ["若价格跌破MA20且成交量放大→失效"],
  "branch_status": null
}
```

**字段说明**:
- `symbol`: 合约代码（必须与输入一致）
- `signalDate`: 信号日期（必须与输入一致）
- `strategy`: 策略名称（固定为"st-cot"）
- `direction`: 方向判断（long=做多，short=做空，pass=不交易）
- `confidence`: 信心水平（high/medium/low）
- `pass_reason`: pass时的原因（data_insufficient/model_abstain/conflict_unresolved）
- `evidence_ids`: 支持该方向的证据字段路径列表（使用嵌套路径）
- `opposing_ids`: 反对该方向的证据字段路径列表
- `reasoning_summary`: ≤150字推理链摘要（1-2句话）
- `invalidate_if`: 失效条件列表（可选）
- `branch_status`: ST-CoT策略固定为null

**约束**:
- 在内心完成Plan/Solve/Check流程，不要输出推理过程
- 仅输出最终JSON
- evidence_ids使用嵌套路径（如"price_data.close_60d"）
- reasoning_summary必须≤150字
- 只输出JSON，不要有任何解释或额外文本

