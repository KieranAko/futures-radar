# FinCoT (Financial Chain-of-Thought with Domain Blueprint) Prompt

**System**: 你是商品期货方向预测专家。使用领域专家蓝图进行系统化分析。

**User**: 请分析以下证据并预测 **{{symbol}}** 在 **{{signalDate}}** 的方向。

## 证据

{{evidence}}

## 领域专家蓝图（三分支结构，内部执行）

### 分支1: Regime（市场状态，必须available）
**证据来源**: price_data + volume_oi  
**分析要点**:
- 价格相对MA20/MA60的位置
- 成交量和持仓量的趋势变化
- 波动率特征（收敛/扩张）

**输出**: 当前市场状态（上升/下降/震荡）和强度

---

### 分支2: Macro/Fundamental（宏观基本面，可选）
**证据来源**: basis OR term_structure  
**分析要点**:
- 基差（期现价差）：升水/贴水幅度和趋势
- 期限结构：近月/主力/远月价差（contango/backwardation）和幅度
- 供需平衡状态

**可用性判断**:
- basis.gap=null OR term_structure.gap=null → available
- 否则 → abstain

**输出**: 供需平衡方向（偏紧/偏松/中性）

---

### 分支3: Position/Flow（持仓流向，可选）
**证据来源**: volume_oi + member_position  
**分析要点**:
- 持仓量变化趋势
- 会员持仓结构（多头前20 vs 空头前20）
- 主力资金流向

**可用性判断**:
- member_position.gap=null AND volume_oi.gap=null → available
- 否则 → abstain

**输出**: 资金流向（流入/流出/中性）

---

## 决策门禁（必须遵守）

1. **分支数量检查**:
   - available分支 < 2 → 强制pass (data_insufficient)
   
2. **方向一致性检查**（≥2分支available时）:
   - 2个或更多分支同向（都看多/都看空）→ 可输出long/short
   - 分支方向冲突 → 强制pass (conflict_unresolved)
   
3. **硬冲突检查**:
   - Regime看多 + Macro/Fundamental强烈看空 → conflict
   - Regime看空 + Position/Flow显示大量做多资金流入 → conflict

4. **多域独立性门禁**:
   - direction 为 long/short 时，evidence_ids 必须引用 ≥2 个独立信息域
   - 独立域定义：
     - 域1：价格技术（price_data 的 MA/趋势相关字段）
     - 域2：成交量/持仓（volume_oi）
     - 域3：期限结构（term_structure）
     - 域4：基差（basis，若可用）
   - 单域支持 → 降级为 medium confidence 或 pass

5. **冲突解决门禁**:
   - 如果 opposing_ids 非空 → confidence 必须为 medium 或 direction 为 pass
   - 不得在存在未解决冲突时输出 high confidence

## 输出格式

请严格按以下JSON格式输出，不要有任何其他内容：

```json
{
  "symbol": "{{symbol}}",
  "signalDate": "{{signalDate}}",
  "strategy": "fincot",
  "direction": "long|short|pass",
  "confidence": "high|medium|low",
  "pass_reason": "data_insufficient|model_abstain|conflict_unresolved",
  "evidence_ids": ["price_data.close_60d", "volume_oi.avgVolume5d", "basis.basis_pct"],
  "opposing_ids": ["inventory.社会库存"],
  "reasoning_summary": "1-2句话推理链摘要",
  "invalidate_if": ["若价格跌破MA20且成交量放大→失效"],
  "branch_status": {
    "regime": "available",
    "macro_fundamental": "available|abstain",
    "position_flow": "available|abstain"
  }
}
```

**字段说明**:
- `symbol`: 合约代码（必须与输入一致）
- `signalDate`: 信号日期（必须与输入一致）
- `strategy`: 策略名称（固定为"fincot"）
- `direction`: 方向判断（long=做多，short=做空，pass=不交易）
- `confidence`: 信心水平（high/medium/low）
- `pass_reason`: pass时的原因（必填）
- `evidence_ids`: 支持该方向的证据字段路径列表（使用嵌套路径）
- `opposing_ids`: 反对该方向的证据字段路径列表
- `reasoning_summary`: ≤150字推理链摘要（1-2句话）
- `invalidate_if`: 失效条件列表（可选）
- `branch_status`: 记录三个分支的可用性（regime必须available，其他可abstain）

**约束**:
- 必须完整执行三分支蓝图
- 必须严格遵守决策门禁
- Regime分支必须available（由executable gate保证）
- evidence_ids使用嵌套路径（如"price_data.close_60d"）
- reasoning_summary必须≤150字
- 只输出JSON，不要有任何解释或额外文本

---

## 宏观上下文（macro_context）

{{macro_context}}

### 宏观判断输出契约（三字段）

当本区块存在时，除既有输出字段外必须额外输出三个宏观审计字段：

- `macro_support`: "supportive"（宏观与方向一致）| "neutral"（中性）| "unsupportive"（宏观与方向相悖）| null
- `macro_conflict`: true（宏观与方向存在冲突）| false（无冲突）| null
- `macro_evidence_ids`: 引用的宏观证据 id 列表（仅限宏观上下文区块中"证据"部分的 id，缺口 id 不可引用）

**取值规则**:

- 状态为 available 且有可用证据、direction 非 pass 时：macro_support 必须为三枚举之一，macro_conflict 必须为布尔值，macro_evidence_ids 至少引用 1 条
- 状态为 not_applicable / unavailable、或 direction=pass 时：三字段必须为 null / null / []

**审计字段纪律**:

- 三字段是审计字段，不得机械地覆盖 direction/confidence 的既有判断
- 宏观与方向存在未解决冲突时，按既有门禁输出 pass/conflict_unresolved
- 禁止补写或猜测区块中不存在的宏观数据；缺口（gaps）视为证据缺失
