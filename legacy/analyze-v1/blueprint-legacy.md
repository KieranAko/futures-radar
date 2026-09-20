# Analyze Blueprint — 6 问深度分析框架

> Stage: 4 (after filter-llm) | Type: LLM manual | Output: `evidence-packets.json` + `sector-driver.json` + `reasoning-results.json` + `analysis.json`

## Input

- `filtered.json` — ≤3 KEEP candidates with filter decisions
- `raw.json` — full OHLCV data for detailed price analysis
- `sector-snapshot.json` + `sector-driver-packets.json` — 板块观察值，用于板块驱动 LLM
- akshare 具体月份合约报价 — 冻结时实时拉取，构造 `term_structure` 字段（`collector/futures-term-structure.py`）
- WebSearch — industry news, policy events, external market moves (ONLY for Top 3)

## 分层 Analyze 流程（板块驱动 LLM + FinCoT 增强）

分析分三层：先冻结 evidence packet；再做**板块级驱动归因**（只解释板块整体）；然后跑个股 FinCoT 并写六问。板块驱动结论与个股证据链严格隔离。

### 步骤 1（自动）：冻结 packet — `analyze/freeze-packets.mjs`

```bash
node analyze/freeze-packets.mjs --runId <runId>
```

- 对每个 KEEP 候选：raw.json 提取 price_data/volume_oi → **自动调用 `extractTermStructure` 拉取 akshare 近/主/远月报价注入 `term_structure` 字段** → `buildPacket` → 校验 schema + 时间边界
- 品种**串行**处理，品种间间隔 2s（配合 Python 内 0.5s/合约 pacing）；sina 456 限流由双层退避重试处理（Python 单合约 [20s, 60s] 阶梯 / Node 批量指数退避）
- term_structure 拉取失败时字段标记 `gap: missing`，不影响 packet 可执行性（optional 字段）
- 从冻结 `macro-snapshot.json`（Stage 1 产物）读取宏观锚点，注入 packet 顶层 `macro_context`（available/not_applicable/unavailable 三态；evidence 仅观察值，relation 不写入 packet）
- 同时生成 `sector-driver-packets.json` 与 `analyze/prompts/sector-driver/{sector}.md`
- 渲染 FinCoT prompts 到 `{runDir}/analyze/prompts/{symbol}-fincot.md`（仅 FinCoT 渲染宏观区块，SP/UST-CoT/ST-CoT 无泄漏；sector_driver_context 初始为 pending）

### 步骤 1.5（LLM）：板块驱动归因

读 `analyze/prompts/sector-driver/*.md`，按板块四分支蓝图输出 `analyze/outputs/sector-driver/{sector}.md`。

纪律：
- 板块驱动只解释板块整体，不得引用任何个股 Q1 结论。
- 成员不足 3 个 → `abstain_insufficient`。
- 找不到板块级 WebSearch 证据 → `unknown`，禁止编造。
- `relation_to_individual` 固定为 `context_only`。

### 步骤 1.6（自动）：板块驱动组装 — `analyze/assemble-sector-driver.cjs`

```bash
node analyze/assemble-sector-driver.cjs --runId <runId>
```

- 校验方向与观察值一致、analyzed 必须有板块级 evidence + invalidation、门禁状态合法。
- 写 `sector-driver.json`，并用其重渲染个股 FinCoT prompts（`sector_driver_context` 为 LLM 结论，禁止进入 evidence_ids）。

### 步骤 2（LLM）：FinCoT 推理

执行猫读 `analyze/prompts/{symbol}-fincot.md`，按三分支蓝图 + 5 门禁推理；packet 含宏观区块时额外输出宏观三字段（`macro_support`/`macro_conflict`/`macro_evidence_ids`，取值契约见 prompt 内"宏观判断输出契约"），输出推理文档到 `{runDir}/analyze/outputs/{symbol}-fincot.md`（格式：分支分析 + 门禁检查 + ```json 代码块```）。

### 步骤 3（自动）：parser + grounding — `analyze/assemble-results.mjs`

```bash
node analyze/assemble-results.mjs --runId <runId>
```

- 对每份推理文档执行 `extractResult`（11 字段 schema + 新 packet 宏观三字段条件式强制 + symbol/signalDate/strategy 输入一致性）+ `validateGrounding`（evidence_ids/opposing_ids → packet.fields；macro_evidence_ids → packet.macro_context.evidence，双域独立 fail-closed）
- grounding 不通过 → 自动降级 `pass/model_abstain`（status: `grounding_degraded`），原始未接地路径保留在 `originalGrounding` 与降级摘要中
- 产出 `reasoning-results.json`（`mode: "daily"`，仅 fincot 臂）

### 步骤 4（LLM）：六问

parser + grounding 通过后的 FinCoT 结果作为六问输入。规则：

1. **外源证据元数据**：每条外源 evidence 必须有 `source/asOf/fetchedAt/_published_at/hash/url`；缺 `asOf/fetchedAt` 或时间越界的证据不得进入 packet。
2. **日常只运行 FinCoT**：`reasoning-results.json` 的 `mode: "daily"` 只执行 `arm: "fincot"`；SP/UST-CoT/ST-CoT 四臂仅研究对照模式使用，不混入日常分析。
3. **六问引用 packet 路径**：六问内容引用 `evidence_ids/opposing_ids/invalidate_if`，不得绕开 packet 增添证据；若必须引入新证据，先回退更新 packet 并重跑 FinCoT。
4. **pass 映射 neutral**：FinCoT `pass` → 六问 `neutral`，并在 Q1/Q3 明确 pass 原因（data_insufficient / model_abstain / conflict_unresolved）；不得强行给方向。
5. **analysis.json 兼容扩展**：保持现有 Q1-Q6 结构，每个 analysis entry 增加 `reasoningRef`、`direction`、`confidence`、`override` 字段（契约见实施计划 §1.3）。方向与 FinCoT 映射不一致且无 override 时 fail closed。
6. **宏观三字段进入六问**：六问引用宏观证据必须走 packet 的 `macro_context.evidence[].id`（如 `macro.DXY`）；`macro_support`/`macro_conflict` 作为 Q1 驱动与 Q3 多空表的审计输入，但不得机械覆盖方向；`macro_context.status` 为 unavailable/not_applicable 时禁止写"宏观利多/利空"结论（无证据即无宏观驱动）。

## The 6 Questions

For each candidate, answer all 6 questions. Each answer must cite evidence — a data point, a news source, or a verifiable correlation. No hand-waving.

### Q1: 为什么动？— What is the primary driver?

Identify the DOMINANT driver (pick ONE primary, mention secondary):

| Driver | Evidence Sources |
|--------|-----------------|
| **宏观 Macro** | Dollar index direction, CNH moves, bond yields, commodity index (文华商品), FOMC/PBOC policy |
| **产业 Industry** | Supply disruption (weather/accident/policy), seasonal demand, inventory data, maintenance schedule |
| **政策 Policy** | Export controls, environmental restrictions, reserve releases, trade tariffs |
| **外盘 External** | Overnight LME/CBOT/ICE/NYMEX moves, correlation breakdown |
| **资金 Fund flow** | OI change direction + vol multiplier, position concentration |

**Rules:**
- If the driver is "macro" but the contract moved opposite to its sector → driver is NOT macro, look deeper.
- If you can't find ANY driver after searching → output `driver: "unknown"` and set confidence to `"low"`.
- Never say "技术面驱动" — technicals are price description, not causation.

### Q2: 趋势还是脉冲？— Trend or impulse?

Examine 3 dimensions of conviction:

```
量 (Volume):      volMultiplier ≥ 1.5 → volume confirms
                  volMultiplier < 0.8 → move is fading

仓 (Open Interest): OI trend (last 5d vs 20d avg):
                    OI ↑ + price ↑ → long building (bullish conviction)
                    OI ↑ + price ↓ → short building (bearish conviction)
                    OI ↓ + price → → liquidation (no conviction, fading)

价 (Price):        vsMA20 direction matches 5d return → trend aligned
                  vsMA20 opposite to 5d return → mean reversion candidate
                  vsMA60 as structural trend filter
```

Output: `"trend"`, `"impulse"`, or `"mixed"` with the reasoning.

### Q3: 多空哪边更有赔率？— Which side has better odds?

Evidence table — list what supports long vs short. Do NOT just say "涨了所以看多":

| Evidence | Long Case | Short Case |
|----------|-----------|------------|
| Price position vs MA | Above 20/60 MA → trend supports long | Below 20/60 MA → trend supports short |
| Volume structure | Vol expanding on up days → accumulation | Vol expanding on down days → distribution |
| OI structure | OI rising with price → new longs | OI rising against price → new shorts |
| Macro tailwind | Dollar weakening, risk-on | Dollar strengthening, risk-off |
| Industry catalyst | Supply cut, demand surge | Demand drop, inventory build |
| Seasonality | Historical bullish window | Historical bearish window |

Output: `"bias": "bullish|bearish|neutral"` with a SHORT paragraph explaining which side's evidence is stronger and WHY.

### Q4: 关键确认信号？— What confirms the trade?

2-3 specific, measurable triggers. Each must be falsifiable:

```
Example (good):  "SC0 跌破 560 且成交量 ≥ 20万手 → 确认空头方向"
Example (bad):   "如果继续下跌就做空"  (too vague, no level, no volume)
Example (good):  "RB0 持仓量突破 200万手 + 价格站上 3300 → 多头确认"
```

### Q5: 失效条件？— What invalidates the trade?

1-2 specific conditions that would make the opportunity "wrong":

```
Example: "SC0 若3日内回到 580 以上 → 空头逻辑失效，止损"
Example: "若OPEC+宣布额外减产 → 供给端驱动反转，退出"
```

Each failure condition must be: (a) specific and measurable, (b) not just "price goes the other way", (c) tied to the driver identified in Q1.

### Q6: 交易风险？— What are the trade-specific risks?

| Risk Category | Check |
|---------------|-------|
| **涨跌停距离** | `limitDown% = (close - limitDown) / close × 100`. If < 3% → 跌停风险 |
| **夜盘跳空** | Is this contract traded overnight? (SHFE/INE/DCE night session 21:00-02:30) → gap risk |
| **保证金** | ~5-15% of contract value. Higher = more leverage risk |
| **移仓** | Days to next contract roll (approximate from expiry cycle) |
| **事件风险** | Upcoming data releases, policy announcements, OPEC+ meetings |

## Anti-Patterns (砚砚's Gates)

These are HARD FAIL conditions — if you catch yourself doing any of these, stop and redo:

1. **循环解释**: "因为涨了所以看多" / "因为跌了所以看空" — price movement is the subject of analysis, not the cause.
2. **无证伪条件**: Every direction call MUST have at least one falsifiable failure condition (Q5).
3. **过度拟合**: Don't explain a -0.5% move with 3 macro factors. Small moves are noise.
4. **忽略反面证据**: If you can't list at least ONE argument for the opposing side (Q3), you're not thinking hard enough.
5. **编造驱动**: If WebSearch finds nothing, write "无明确驱动" — don't invent a narrative.

## Output Format (`analysis.json`)

```json
{
  "meta": {
    "runId": "<runId>",
    "analyzedAt": "<ISO timestamp>",
    "candidateCount": <N>
  },
  "analyses": [
    {
      "symbol": "SC0",
      "name": "原油",
      "reasoningRef": {
        "artifactId": "reasoning-results-json",
        "packetHash": "sha256:<hash>",
        "arm": "fincot"
      },
      "direction": "bearish",
      "confidence": "medium",
      "override": null,
      "q1_driver": {
        "primary": "宏观-FOMC",
        "secondary": "外盘-美原油库存超预期",
        "evidence": "FOMC维持利率不变但暗示9月加息可能；EIA库存意外增加320万桶",
        "source": "WebSearch: Reuters 2026-07-30"
      },
      "q2_trendOrImpulse": {
        "judgment": "impulse",
        "volumeConviction": "low — volMult 2.04 but OI down 3%, suggesting liquidation not new shorts",
        "oiStructure": "OI declining against price drop → longs exiting, not shorts building",
        "priceAlignment": "mixed — below MA20 but MA60 flat, no structural downtrend"
      },
      "q3_odds": {
        "bias": "bearish",
        "longCase": ["价格已从高点回落12%，技术面超卖可能反弹", "FOMC若超预期鸽派则美元走弱利好原油"],
        "shortCase": ["EIA库存持续积累3周，供需基本面偏空", "全球经济放缓预期压制需求端", "2倍放量下跌说明大资金在出逃"],
        "summary": "短期空头证据更强，但OI下降说明是获利了结而非新空建仓，趋势持续性存疑。"
      },
      "q4_confirmation": {
        "signals": [
          "SC0跌破560且成交量≥20万手确认",
          "OI停止下降并开始积累（说明新空头进场替代获利了结）"
        ]
      },
      "q5_invalidation": {
        "conditions": [
          "SC0 3日内回到580以上 → 空头逻辑失效",
          "OPEC+宣布紧急会议或减产 → 供给侧驱动反转"
        ]
      },
      "q6_risks": {
        "limitDistance": "跌停板距离约8%，风险可控",
        "overnightGap": "INE夜盘(21:00-02:30)，外盘波动可能造成跳空",
        "margin": "合约价值约57万/手，保证金约5.7-8.5万/手",
        "eventRisk": "明日发布的美国PCE数据可能引发美元/原油剧烈波动"
      },
      "enhancedData": {
        "webSearchSources": ["https://...", "https://..."],
        "correlationCheck": "SC0与WTI近5日相关性0.92，外盘联动确认"
      }
    }
  ]
}
```

## Post-Analysis Sanity Check

Before outputting, verify:
- [ ] Each analysis answers all 6 questions
- [ ] Q1 has a cited driver source (not speculation)
- [ ] Q2 checks volume, OI, AND price structure (all 3)
- [ ] Q3 lists at least ONE argument for the opposing side
- [ ] Q4/Q5 are specific and falsifiable
- [ ] No "因为涨所以多" circular reasoning
