# signal-backtest 信号质量回测契约（v2 · 2 年 / 5 日锚点）

## 目标
只测「信号 → 策略计划 → 证伪」这条链路的信号质量，不测筛选/扫描：
- 品种固定：RB0、M0、SC0
- 历史长度：2 年（500 个交易日，2024-08-06..2026-08-27）
- LLM 锚点：每 **5** 个交易日做一次方向/参数决策（只允许看 `bars[0..anchorIdx]`）
- 确定性延续：锚点有效期内，用确定性规则按锚点参数逐日生成信号
- 验证：信号日后 T+1 收盘确认、T+2 开盘执行、止损/目标1/时间退出
- **淘汰参数组合**：v1（1 年基线）证伪出的最差组合
  `triggerAtrMult=0.5 × stopAtrMult=1.5 × targetR=2 × maxHoldDays=6`（2 笔、方向正确率 0%）在本版永久禁用：锚点决策不得使用，runner 对命中该组合的锚点直接跳过并计数。

## 目录
```
strategies/signal-backtest/
  contract.md                      本契约（v2）
  runner.cjs                       回测运行器（确定性，读取 recordings/2y）
  recordings/
    1y/                            v1 基线（1 年 / 10 日锚点，已冻结，保留可复现）
      features.json / anchors-*.json / history-1y.json
    2y/                            v2 基线（2 年 / 5 日锚点，当前运行）
      features.json / anchors-*.json / history-2y.json
  output/
    signal-quality-baseline.json    v1 基线（冻结）
    signal-quality-baseline-2y.json v2 结果
    signal-quality-baseline-2y.md   v2 结果
```

## LLM 锚点决策 schema（recordings/2y/anchors-<SYM>.json）
```json
{
  "symbol": "RB0",
  "step": 5,
  "generatedAt": "ISO 时间",
  "anchors": [
    {
      "date": "2024-09-03",
      "direction": "bullish | bearish | neutral",
      "confidence": "high | medium | low",
      "driver": "一句话驱动（不得使用锚点日之后的信息）",
      "triggerAtrMult": 0.5,
      "stopAtrMult": 1.5,
      "targetR": 2.0,
      "maxHoldDays": 5,
      "invalidationLevel": 3200.0,
      "rationale": "为什么这样设：趋势/位置/风险三句话"
    }
  ]
}
```

约束：
- `direction=neutral` 时其余参数可写 null，锚点期间不产生信号。
- `triggerAtrMult ∈ [0.2, 2.0]`；`stopAtrMult ∈ [1.0, 3.0]`；`targetR ∈ [1.0, 4.0]`；`maxHoldDays ∈ [2, 10]`。
- **禁用组合**：禁止出现 `triggerAtrMult=0.5 && stopAtrMult=1.5 && targetR=2 && maxHoldDays=6`。
- `invalidationLevel`：多头上行趋势的证伪价（跌破则锚点作废），空头反之；应给出具体价格。
- 只允许使用 `features.json` 中该锚点行（`date, idx, close, ma20, ma60, atr5, chg5, volRatio`）做决策。

## 确定性信号延续引擎（runner.cjs）
对每个锚点（date=d, idx=i）：
- 有效期：`i+1 .. min(i+step-1, bars.length-1)`（下一个锚点日由新决策接管）。
- 每日（信号日 s，在有效期内，且上一持仓已平仓后）按当前截断数据计算：
  - `ma20(s)`、`atr5(s)` 只用 `bars[0..s]`。
  - 多头：`close(s) > invalidationLevel` 且 `close(s) > ma20(s)`；空头：`close(s) < invalidationLevel` 且 `close(s) < ma20(s)`；不满足则当日不发信号。
  - `triggerLevel = close(s) + sign * triggerAtrMult * atr5(s)`。
  - 计划：`triggerTiming = T+1 收盘确认；确认后下一交易日开盘执行`，
    `stopPrice = triggerLevel - sign * stopAtrMult * atr5(s)`（止损随计划冻结，不移动），
    `target1Level = triggerLevel + sign * targetR * |triggerLevel - stopPrice|`（等价 2R 等结构）。
- 触发判定：T+1 close 严格越过 triggerLevel。
- 执行：T+2 open 入场；若 `|open - triggerLevel| > 0.75*stopAtrMult*atr5(s)` 记为 gap_skip（跳空放弃，不计方向）。
- 持有：自 T+2 起逐日检查，先止损后目标1（同 feedback.cjs 语义），最多 `maxHoldDays` 个交易日，否则时间退出（取末日 close）。
- 空头对称。
- 一个锚点期内可多次发信号，但上一笔未平仓（含 T+1 待确认）时不再发新信号。
- 命中禁用参数组合的锚点不产生任何信号，并在结果中计入 `bannedComboSkippedAnchors`。

## 验证指标（output/signal-quality-baseline-2y.json）
- meta：universe、barsRange、anchorStep、anchorCount、bannedComboSkippedAnchors、signalCount、verifiedCount。
- per symbol：信号数、触发率、执行率、gap 跳过、止损率、目标1兑现率、时间退出率、方向正确率、平均盈亏（以 entry 为基准的百分比，多头 `(exit-entry)/entry`，空头取反）。
- 全局与锚点置信度交叉：confidence=high/medium/low 的方向正确率。
- 证伪结论：哪种参数组合方向正确率最低，作为下一轮调参依据。
- v1 vs v2 对照：锚点间隔、信号数、执行数、方向正确率。

## 纪律
- 不联网、不读 `daily/<SYM>.json` 中锚点日之后的行情来生成信号；验证阶段才能读未来。
- 不修改 `data/strategy-feedback` 真实台账；本回测输出只写 `output/`。
- LLM 只出现在锚点决策层；延续层必须确定性可复现。
- 每个版本的 recordings 目录冻结后不再改动；新版本只新增目录与文件。
