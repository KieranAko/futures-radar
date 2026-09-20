# Filter-LLM Blueprint（三问分诊）

> Stage: 3b (after filter-hard) | Type: LLM manual | Output: `filtered.json`

## 定位

初筛不是分析，是分诊（triage）。目标只有一个：从 Top10 异动中选出**最具分析价值**的 ≤3 个品种（多空均可），交给 analyze 阶段做完整证据链分析。

## 输入

- `filtered-hard.json`（passed 列表 + rejected 墓碑）
- `filter-context.json`（行情/量仓/OI变化/板块/宏观/成本锚冻结上下文）
- `filter-prompt.md`（已生成的三问 prompt）

## LLM 只回答三问

1. **有没有行情？** —— 1日/5日、量能、波动分位是否构成值得看的异动；
2. **有没有可验证的驱动线索？** —— 存在可继续查证的假设即可，不要求证实；
3. **值不值得花一次深度分析？** —— 与榜单其他品种比较，决定是否给 TOP3 名额。

## 禁止事项

- 禁止输出赔率、longCase/shortCase、入场/止损/目标；
- 禁止把 directionHint 当成最终方向结论；
- 禁止复活 `filtered-hard.json` 的 rejected 墓碑；
- 无来源线索必须标"待验证"，不得写成已证实。

## 方向中性原则

- 多头 / 空头完全对等，**有行情机会的更优先**；
- 判断行情强度用绝对口径：|1日|、|5日|、ATR%、volMult、量能；
- 板块共振只看“与板块方向一致度”：多头看上涨共振，空头看下跌共振；
- 逆势候选必须依赖更强的独立品种驱动才能 KEEP；
- 禁止使用“上涨广度”否决空头候选。

## 输出格式 (`filtered.json`)

```json
{
  "meta": { "runId": "...", "filteredAt": "...", "inputCount": 10, "outputCount": 3, "hardFilterRejectsImmutable": true },
  "candidates": [
    {
      "symbol": "SF0",
      "rank": 2,
      "directionHint": "bullish",
      "directionBias": "bullish",
      "decision": "KEEP",
      "confidence": "medium",
      "reason": "今日逆板块 +1.43%，兰炭提涨为待验证成本线索；行情与线索都有，值得深挖",
      "informationGap": "兰炭提涨持续性；黑色板块转弱是否拖累"
    }
  ],
  "downgraded": [
    { "symbol": "RB0", "reason": "量能收缩且今日回落，分析价值下降", "informationGap": "无", "note": "..." }
  ]
}
```

## 硬约束（仅四条）

1. hard-filter 墓碑不可复活；
2. KEEP ≤3 且 ≥1；
3. `directionHint` ∈ bullish|bearish|unclear；confidence ∈ high|medium|low；
4. 每个候选 reason 与 informationGap 非空；不得输出 odds/longCase/shortCase。

校验：`node filter/filter-validate.cjs --runId <runId>`
