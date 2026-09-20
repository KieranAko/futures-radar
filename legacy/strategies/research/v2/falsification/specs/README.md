# falsification spec 与 adapter 契约（t8 使用手册）

> 本文档定义 t8（8 条核心策略 walk-forward 证伪执行）向 `harness.cjs` 添加策略所需的全部接口。
> 框架本体见 `../harness.cjs`、`../harness-lib/*.cjs`；框架设计/口径/自测见 `../16-harness.md`。

## 1. 文件布局

```
falsification/
  harness.cjs                 CLI（selftest / run / list / validate-spec）
  harness-lib/
    util.cjs data.cjs stats.cjs sim.cjs engine.cjs gates.cjs report.cjs selftest.cjs
    strategies/demo.cjs       参考 adapter（demo 动量，非库内策略）
  specs/
    demo-momentum.json        参考 spec
    TR-01.json ...            t8 需按库 falsificationTests 补齐 8 条
```

## 2. spec JSON schema

| 字段 | 必填 | 说明 |
|---|---|---|
| `specId` / `strategyId` | ✅ | 如 `TR-01` |
| `library` | ✅ | `{sourceFile, entryId, note}`；entryId 指向 strategy-library-v2.json 条目（机器可核对的 falsificationTests 溯源） |
| `universe.symbols` | ✅ | 数据契约 inputs 中的品种列表 |
| `data` | ✅ | `daily:true`；`derived:[...]`（ga2-derived 字段：atr5/hv20/hvPct90/ma20/ma60/volumeRatio）；`sector/macro` 按需；`calendar:true` 用于 FS-04/FS-05/EC-01（F9 前提开关）；`rollJumps:true`；`tradableSet:true` 用于 FS-02 |
| `period` | ✅ | `{start,end}` YYYY-MM-DD |
| `warmupBars` | ✅ | 首个信号前的 PIT 估计最少 bar 数 |
| `folds` | ✅ | `mode: purged-expanding \| rolling`；purgeBars 默认 5；rolling 用 windowMonths（M1 用 12） |
| `execution` | ✅ | `pathPriority: stop-first`；`cost:{roundtripBps, legs}`（单腿 7，双腿 14，legs=2） |
| `strategyLevel` | ✅ | `minTrades`（200；TR-06 用 100）、`pfThreshold:1.2`、`ci`、`majorityYearsPositive:true`、`baselines:[always-long,always-short,random]`、`random:{mode,runs,seed}`；M1 加 `windowGate`（见下） |
| `theoryLevel` | ✅ | `{hypothesis, engine:"adapter"}`；机器化测试在 adapter.theory() 实现 |
| `machineKillRules` | ✅ | killRules 的机器形式：`{id, metric, op, value, onTrigger, note}`；metric ∈ `n/pf/sharpeTrade/hitRateNet/hitRateDirection/ciExcludesZero/majorityYearsPositive/theoryFalsified/custom.<name>`；op ∈ `lt/lte/gt/gte/eq/isFalse/isTrue`；onTrigger ∈ `suspended/retired/pair-removed` |
| `signal.adapter` | ✅ | 已注册 adapter id |
| `params` | ✅ | 预注册初值（frozen=false 语义：首轮证伪不得按样本内调参） |

M1 `windowGate` 示例（对齐库 ci 字段口径）：

```json
"windowGate": { "metric": "hitRateNet", "minHit": 0.55, "pThreshold": 0.10, "minShare": 0.60 }
```

## 3. adapter 契约

`harness-lib/strategies/<id>.cjs` 导出：

```js
module.exports = {
  id: 'TR-01',
  createAdapter({ spec, data, engine }) {
    return {
      minWarmup: 250,
      initState() { return {}; },
      // 可选：折内标定（purged，只用 ≤ calibDate 的数据；calibDate = testStart - purgeBars）
      calibrate(ctx, { fold, calibDate, spec }) { return params; },
      // 每根信号 bar 调用；ctx 只暴露 ≤ anchor 的 PIT 视图（超界抛 LookaheadViolation）
      evalBar(ctx, state, params, { fold }) { return intentOrNull; },
      // 可选：理论级证伪；返回结构化 tests + killOn + 自定义 metrics
      theory({ strategyTrades, foldResults, baselines, data, spec, paramsHistory }) {
        return { hypothesis, metrics: {...}, tests: [{ id, label, falsified, evidence }], killOn };
      },
    };
  },
};
```

### intent 契约（evalBar 返回值）

```js
{
  direction: +1 | -1,                      // 交易方向
  legs: [{ symbol, side, stop, target, weight }],  // stop/target 为价格；weight 默认 1/nLegs
  sizeR: 0.5 | 1,                          // 库 pricingModel.position 分档
  timeExitBars: 20 | null,                 // 含入场 bar 的最长持有 bar 数
  gapAbandon: { type:'atr', factor:0.5 } | { type:'pct', pct } | null,
  gapAtrValues: { SYM: atr5T },            // PIT ATR（信号日 T）
  tags: { confirmed:true, ... },           // 理论级子样本切分标签
  manage: fn(tradeCtx) | null,             // 可选：动态退出（z 止损 / F_t 规则 / 事件暂停）
}
```

`manage(tradeCtx)` 返回 `{exit:true, exitPrices:{SYM:price}, reason}` 或 `{adjust:{SYM:{stop?,target?}}}` 或 `null`。

## 4. ctx 可用视图（全部 PIT）

- `ctx.daily[SYM].at(field, i)` / `.series(field)`：OHLCV 等，锚点 = 该 symbol 在 anchorDate 的最后 bar；
- `ctx.derived[SYM].at('atr5'|'hv20'|'ma20'|'ma60'|'volumeRatio'|..., i)`；
- `ctx.macro.ID = { dates, values }`（已切至 ≤ anchorDate）；
- `ctx.eventActive(SYM)`：F9 纪律（event.date ≤ 锚点日 且 锚点日 ≤ event.end）返回生效事件数组；
- `ctx.jumpDates[SYM]`（Set）、`ctx.tradable`（FS-02 可交易集 Set）；
- 禁止：任何越过锚点的读取（抛 LookaheadViolation，引擎硬失败）。

## 5. 执行口径（引擎固化，t8 不得另造）

1. T 日收盘信号 → T+1 开盘成交（§0.2）；T+1 开盘相对 T 收盘跳空 > 阈值 → 弃单（各策略条款）。
2. 停板可执行性：无日内涨跌停价数据，v0 不做停板检查（限制项见 16-harness.md §8）。
3. 路径优先 stop-first（保守）：同 bar 止损与目标都触及 → 按止损离场；跳空穿过止损 → 以开盘价成交。
4. 换月跳变 bar（ga1-roll-jumps，≥9.5%）：禁止入场；持仓于跳变日前收盘强制离场（F5）。
5. 成本：单腿 7bp 往返（per-side 3.5bp）、双腿 14bp 往返（每腿 per-side 3.5bp），按腿价折算 R。
6. R 记账：rawR_leg = side×(exit−entry)/|entry−stop|；netR = sizeR × Σ w_leg×(rawR_leg − costR_leg)。
7. 基线：always-long/short = 每 fold 每品种持有全窗（bps + pseudo-R 双口径）；random 默认 same-entries-flipped-side（同入场 bar、反向、止损/目标绕入场价镜像、同 stop-first 管理——非代数负数，见 16-harness.md §6）。
8. 确定性：固定 seed；同 seed 两次运行 resultsHash 必须一致。

## 6. 添加一条策略的最小步骤（t8）

1. `specs/TR-01.json`（按 §2；falsificationTests 数值逐字对齐库条目）。
2. `harness-lib/strategies/TR-01.cjs`（按 §3 实现 evalBar/理论测试；定价公式逐字对齐库 marketModel/pricingModel）。
3. `node harness.cjs validate-spec TR-01`。
4. `node harness.cjs run --spec TR-01 --seed 20260828 --out data/harness-runs`。
5. 核对产物 JSON/MD；理论级证伪、killRules、建议状态写入 t8 报告。
