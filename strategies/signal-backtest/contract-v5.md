# signal-backtest v5 契约 —— 紧凑上下文 + 变化驱动 FinCoT + 三臂消融

## 试点
- 品种 RB0/M0/SC0；每品种最近 20 锚点（2026-03-27..2026-08-14，5 日间隔），共 60 锚点
- 固定 1 手；T+1 收盘确认 → T+2 开盘执行 → 跳空放弃 → 止损/目标1/时间退出
- 三臂：A 纯价格（v3 冻结锚点）｜B +宏观/板块/事件（无 FinCoT）｜C +完整六问 FinCoT

## 输入 bundle（recordings/v5/bundle-<SYM>.json）
每行紧凑字段，legend 在文件头部。所有字段 asOf/事件日期 <= 锚点日；nxt 是 7 日内日程预期。
纪律：missing/未核实事件不得当作事实；宏观数值直接引用，不得篡改。

## 计划 schema（B/C 相同，C 多 FinCoT 字段）
```json
{
  "date":"2026-07-10","direction":"bullish|bearish|neutral","confidence":"high|medium|low",
  "regime":"trend|range|transition|shock",
  "edge":"trend_continuation|breakout|pullback|mean_reversion|range_fade",
  "triggerType":"breakout|pullback",
  "triggerAtrMult":0.5,"stopAtrMult":1.5,"targetR":2,"maxHoldDays":5,
  "pullbackLevel":null,"invalidationLevel":3080,
  "qualityFlags":["trend_aligned"],
  "macroBias":"bullish|bearish|neutral|conflict|not_applicable",
  "sectorBias":"bullish|bearish|neutral|not_applicable",
  "eventRisk":"low|medium|high",
  "executionStatus":"executable|watch|skip",
  "thesis":"…","driver":"…","rationale":"…","invalidationReason":"…",
  "contextRefs":["macro.DXY","sect.r5","evt.cpi_ppi"],
  "finCotAlignment":"aligned|diverged|not_applicable",
  "finCotRefs":["q4","macro.DXY"],"divergenceReason":"","counterEvidence":""
}
```
约束：
- neutral → edge/triggerType/数值/pullbackLevel/invalidationLevel=null；executionStatus 只能 watch/skip
- 数值范围与禁用组合同 v3/v4（禁止 0.5×1.5×R2×hold6）
- triggerType=pullback → pullbackLevel 必填；breakout → triggerAtrMult 必填
- contextRefs 只允许引用 bundle 中存在的条目（macro.<id> / sect.<key> / evt 类型 / nxt 类型）
- B 臂：宏观/板块/事件如何改变决策必须写进 rationale
- C 臂硬约束（见下）

## C 臂：FinCoT 真正被消费
1. 先读 `recordings/v5/diff-<SYM>.json`：
   - changed=true → 写完整六问（q1..q6 + direction/confidence/macroSupport/sectorSupport/eventRisk/evidenceRefs/opposingRefs/invalidateIf）
   - changed=false → `reusedFrom:<上一锚点日期>`，复制上一锚点六问结论（可小幅补充本锚点价格位置的说明，但不得改变方向）
2. 再基于 FinCoT 写 arm-C 计划，硬约束：
   - `finCotRefs` 至少 1 个 Q 编号 + 1 个 evidenceRef
   - 入场触发对应 Q4；失效/止损对应 Q5；executionStatus/风险对应 Q6；方向必须等于 FinCoT direction
   - 方向与 FinCoT 不一致 → `finCotAlignment=diverged` + `divergenceReason` + `counterEvidence`（否则 runner 校验失败）
   - FinCoT direction=neutral → executionStatus 只能 watch/skip
3. 输出单文件 `recordings/v5/fincot-<SYM>.json`（20 条）+ `recordings/v5/arm-C-<SYM>.json`（20 计划）

## 执行与统计
- runner-v5.cjs：三臂同一引擎，只执行 executable；信号携带 macroBias/sectorBias/eventRisk/finCotAlignment/contextRefs/finCotRefs
- 消融：B-A、C-B、C-A；C 臂交叉：finCotAlignment、finCotReused vs fresh、macroBias/sectorBias/eventRisk
