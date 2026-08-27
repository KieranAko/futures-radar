# signal-backtest v3 契约 —— LLM 定性判断优先（不做参数选优）

## 为什么是 v3
v1/v2 把注意力放在 `triggerAtrMult × stopAtrMult × targetR × hold` 参数组合的胜率排序上，这仍然是传统量化的“网格选优”思维。v3 的立场：

- **不优化参数组合**：数值参数只是执行机制（怎么入场、止损多宽），不是回测要找的答案。
- **发挥 LLM 优势**：让 LLM 输出传统量化难以统计/固化的**定性判断**——行情 regime、交易 edge 类型、触发方式、质量核查清单、论题与证伪理由；回测验证这些定性判断是否可证伪、是否有区分度。
- **保留对照臂**：同数据上跑一个纯量化基线（MA20 趋势 + 固定执行参数），用于回答“LLM 判断比不用 LLM 多贡献了什么”，而不是回答“哪组参数最好”。

## 输入（与 v2 相同，严格截断）
`recordings/v3/features.json`：`date, idx, close, ma20, ma60, atr5, chg5, volRatio`，只含锚点日及以前的数据。不联网。

## LLM 锚点决策 schema（recordings/v3/anchors-<SYM>.json）
```json
{
  "symbol": "RB0",
  "step": 5,
  "generatedAt": "ISO",
  "anchors": [
    {
      "date": "2024-09-03",
      "direction": "bullish",
      "confidence": "high",
      "regime": "trend",
      "edge": "trend_continuation",
      "triggerType": "breakout",
      "triggerAtrMult": 0.5,
      "stopAtrMult": 1.5,
      "targetR": 2.0,
      "maxHoldDays": 5,
      "pullbackLevel": null,
      "invalidationLevel": 3100.0,
      "qualityFlags": ["trend_aligned", "volume_confirmed"],
      "thesis": "…",
      "driver": "…",
      "rationale": "…",
      "invalidationReason": "…"
    }
  ]
}
```

### 枚举与约束
- `direction`: `bullish | bearish | neutral`
- `confidence`: `high | medium | low`
- `regime`: `trend | range | transition | shock`（对行情状态的定性判断；neutral 锚点也必须给出）
- `edge`: `trend_continuation | breakout | pullback | mean_reversion | range_fade`（neutral 时为 null）
- `triggerType`: `breakout | pullback`（neutral 时为 null）
  - `breakout`：突破/趋势延续——T+1 收盘越过触发价
  - `pullback`：回调/均值回归/区间边缘——在 `pullbackLevel` 附近挂计划，T+1 收盘回到 `pullbackLevel` 同向侧触发
- 数值执行机制（`direction != neutral` 时必填）：
  - `triggerAtrMult ∈ [0.2, 2.0]`（仅 breakout 使用）
  - `stopAtrMult ∈ [1.0, 3.0]`
  - `targetR ∈ [1.0, 4.0]`
  - `maxHoldDays ∈ [2, 10]`
  - `pullbackLevel`：triggerType=pullback 时必填（多头=回调买点/支撑；空头=反弹卖点/压力），breakout 时为 null
  - `invalidationLevel`：论题证伪价（多头跌破失效；空头升破失效）
  - 禁用组合（v1 证伪淘汰，永久生效）：`triggerAtrMult=0.5 && stopAtrMult=1.5 && targetR=2 && maxHoldDays=6`
- `qualityFlags`：从固定词表选 0–3 个，LLM 基于截断特征做的核查判断：
  - `trend_aligned`（价格/均线结构与方向一致）
  - `volume_confirmed`（量能支持该 edge）
  - `structure_clean`（近期无极端反向动能，结构清晰）
  - `volatility_normal`（ATR 处于可执行区间）
  - `event_risk`（存在事件/冲击风险，降低执行力）
- `thesis`：1–2 句中文，完整的交易论题（状态 → 预期路径 → 证伪条件）。
- `driver`：一句话驱动（不得使用锚点日之后的信息）。
- `rationale`：2–3 句中文（趋势/位置/风险）。
- `invalidationReason`：一句话，为什么 `invalidationLevel` 能证伪该论题。

## 确定性延续引擎（runner-v3.cjs）
- 锚点有效期 `i+1 .. min(i+step-1, bars.length-1)`，命中禁用组合的锚点整段跳过。
- 每信号日 s 用截断数据计算 `ma20(s)`、`atr5(s)`，并检查方向与 `invalidationLevel` 一致。
- `triggerType=breakout`：`triggerLevel = close(s) + sign * triggerAtrMult * atr5(s)`；T+1 收盘严格越过触发。
- `triggerType=pullback`：
  - 多头信号日须进入回调区：`pullbackLevel - 0.5*atr5 ≤ close(s) ≤ pullbackLevel + 0.25*atr5`；
  - 空头对称（`pullbackLevel - 0.25*atr5 ≤ close(s) ≤ pullbackLevel + 0.5*atr5`）；
  - `triggerLevel = pullbackLevel`，`stopPrice = pullbackLevel - sign * stopAtrMult * atr5(s)`，
    `target1Level = pullbackLevel + sign * targetR * stopAtrMult * atr5(s)`；T+1 收盘越过 `pullbackLevel` 触发。
- 执行统一：T+2 开盘入场；`|open - triggerLevel| > 0.5 * |triggerLevel - stopPrice|` 记 gap_skip；先止损后目标1，最多 `maxHoldDays` 天，否则时间退出。
- 每笔信号携带 `regime / edge / triggerType / qualityFlags` 供交叉验证。

## 纯量化对照臂（control）
同 500 bars、同 T+1/T+2 验证语义，但**不含任何 LLM 判断**：
- 每日方向 = `close(s) > ma20(s)` 多头，否则空头；
- 固定执行参数：`triggerAtrMult=0.5, stopAtrMult=1.5, targetR=2, maxHoldDays=5`（v2 禁用组合不含此组）。
对照臂只用于回答“LLM 定性判断是否跑赢不用 LLM 的机械趋势规则”。

## 验证指标（output/signal-quality-baseline-v3.json）
- meta / aggregate / perSymbol：同 v2 口径。
- crossTab：`byRegime`、`byEdge`、`byTriggerType`、`byQualityFlag`（样本数、方向正确率、平均盈亏）——这是 v3 的核心证据，用来证伪/保留 LLM 的定性判断，而不是选数值参数。
- control：纯量化对照臂的 aggregate 与配置。
- executionMechanics：数值执行参数分布（观察性，不排序选优、不下“最优组合”结论）。
- falsification：LLM vs control 差异、最弱定性类别、止损/跳空归因、样本量声明。

## 纪律
- 不联网；信号生成只读 `bars[0..s]`；未来数据只在验证阶段读取。
- 不修改 `data/strategy-feedback` 台账；输出只写 `output/`。
- LLM 只出现在锚点决策层；延续层与对照臂完全确定性。
- v1/v2 的 recordings 与 baseline 冻结不动；v3 只新增文件。
