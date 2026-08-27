# Filter-LLM Blueprint

> Stage: 3b (after filter-hard) | Type: LLM manual | Output: `filtered.json`

## Iron Rule (ABSOLUTE)

**You CANNOT resurrect any contract removed by filter-hard.** The `rejected` array in `filtered-hard.json` is a tombstone — those contracts are dead. You only evaluate contracts in the `passed` array.

## Input

- `filtered-hard.json` — candidates that passed hard filters (≤10)
- `candidates.json` — full indicator data for reference

## 5 Soft Filter Criteria

Evaluate each candidate against these 5 criteria. Each criterion can be: **PASS**, **WEAK**, or **FAIL**.

### 1. 波动足够大 — Volatility above historical median

- Check `indicators.volPercentile`. If ≥ 50 → PASS. If 30-50 → WEAK. If < 30 → FAIL.
- This means: current HV(5) is higher than at least half of the 90-day rolling windows.

### 2. 流动性足够好 — Sufficient liquidity for entry/exit

- Check `liquidity.avgTurnover5d`. If ≥ 5亿 → PASS. If 1-5亿 → WEAK.
- Check `liquidity.avgOI5d`. If ≥ 5万手 → PASS. If 1-5万手 → WEAK.
- A contract can be liquid enough to pass hard filter (1亿) but still thin for large positions.

### 3. 价格行为清楚 — Clear price structure (not sideways chop)

- Check `indicators.volMultiplier`. If ≥ 1.5 → volume expansion confirms the move.
- Check `indicators.atrPct`. If ATR% is ≥ 1.5× the sector average → real move, not noise.
- Check `trend.vsMA20` vs `trend.vsMA60`. If both pointing same direction → trend. If opposing → choppy.
- PASS if: volMult ≥ 1.3 OR clear trend alignment. WEAK if volMult < 1.0 (contracting volume = no conviction).

### 4. 有可解释驱动 — Plausible driver exists (at least one category)

| Driver Category | Check |
|-----------------|-------|
| **宏观 Macro** | Dollar index, CNH, 10Y yield, crude oil, commodity index moves align with direction |
| **产业 Industry** | Supply disruption, policy change, seasonal pattern, inventory cycle |
| **外盘 External** | Overnight foreign futures moved in same direction |
| **资金 Flow** | Vol multiplier ≥ 2.0 + OI change > 10% (big money moving in) |

- **If at least one category plausibly explains the move → PASS**
- **If no clear driver → mark as "无明确驱动 → 观望/不做" (WEAK → downgrade)**

### 5. 风险可控 — Risk is manageable

- FAIL if: `indicators.volPercentile` > 99 (extreme tail event, too unstable)
- FAIL if: `trend.vsMA20` < -20% or > +20% (extended too far from mean, snapback risk)
- FAIL if: the contract is the only mover in its sector (isolated noise, not sector-wide)

## Decision Matrix

| Result | Action |
|--------|--------|
| ≥ 4 PASS, 0 FAIL 且 directionBias ≠ neutral | **KEEP** — strong candidate |
| ≥ 3 PASS, ≤ 1 FAIL 且 directionBias ≠ neutral | **KEEP** — with noted weakness |
| directionBias = neutral（方向未解/结构冲突） | **DOWNGRADE** — 无明确操作机会，即使分数高 |
| ≥ 2 PASS, ≥ 2 WEAK | **观望** — downgrade to watch |
| Any FAIL on criteria 4 or 5 | **DOWNGRADE** — even if other criteria pass |
| 孤立波动 (only mover in sector) | **DOWNGRADE** — sector confirmation lacking |

**Top3 选取顺序（重要）**：
1. 先按“可操作性”筛选：只有 `directionBias ∈ {bullish, bearish}` 且 driver 非 FAIL 且 risk 非 FAIL 的候选进入 KEEP 池。
2. 再按原始 score 排序，取前 3。
3. 若 KEEP 池不足 3 个，才允许在“WEAK 驱动 + 方向明确”中补足，并注明原因。
4. 高分但 `neutral` 的候选不得挤掉低分但方向明确、驱动可验证的候选。

## Output Format (`filtered.json`)

```json
{
  "meta": {
    "runId": "<runId>",
    "filteredAt": "<ISO timestamp>",
    "inputCount": <N>,
    "outputCount": <≤3>,
    "hardFilterRejectsImmutable": true
  },
  "candidates": [
    {
      "symbol": "SC0",
      "name": "原油",
      "rank": 2,
      "score": 62.8,
      "decision": "KEEP",
      "confidence": "high|medium|low",
      "directionBias": "bullish|bearish|neutral",
      "criteria": {
        "volatility": { "result": "PASS", "note": "volPercentile 84.7%, well above median" },
        "liquidity": { "result": "PASS", "note": "avgTurnover 1015亿, deep market" },
        "priceStructure": { "result": "PASS", "note": "volMult 2.04x, volume confirms move" },
        "driver": { "result": "PASS", "note": "宏观：FOMC决议+美元走弱推动原油" },
        "risk": { "result": "PASS", "note": "volPercentile 84.7% not extreme, manageable" }
      },
      "summary": "原油波动率处于84.7%分位，成交量2倍放大，FOMC决议前避险资金流入。方向偏空但市场深度足够。",
      "watchConditions": "若FOMC后原油跌破560则机会更强"
    }
  ],
  "downgraded": [
    {
      "symbol": "...",
      "name": "...",
      "reason": "无明确驱动 → 降为观望",
      "note": "波动率虽高但无对应宏观/产业事件支撑，可能为随机噪声或技术面假突破"
    }
  ]
}
```

## Constraints

- **Maximum 3 KEEP candidates.** 先按可操作性筛选（directionBias 非 neutral、driver 非 FAIL、risk 非 FAIL），再按 score 取前 3；高分 neutral 候选优先降级。
- **Never fabricate drivers.** If you can't find a real driver through WebSearch or the data, say so.
- **Each decision must cite evidence** — a specific indicator value, a specific news event, or a specific correlation.
- **EC0 (集运指数) special handling**: This contract has extreme volatility (HV5 can be 200%+). A volPercentile of 95%+ is its NORMAL state, not an anomaly. Check if the -40% move has a verifiable shipping event behind it (Red Sea / port strike / tariff change).
