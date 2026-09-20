# 27 TR-01 保真复跑 —— 判决与证据

> 复跑依据：队长路线 A 决定（把最强代理证据的 TR-01 保真跑到底，做一次判决）。
> 方法：不修改库、不修改 spec；重写 adapter 至 23-fidelity-review F-A..F-H，按 specs/TR-01.json 原样执行。
> 引擎扩展（向后兼容）：TradeSim 增加 `intent.onFill`（按实际 T+1 开盘价重算 bracket/R）与 `decision.add`（加仓腿，T+1 开盘执行）。

## 1. 判决

| 层级 | 结果 |
|------|------|
| 理论级（信息确认机制） | **未证伪**：确认突破 meanR=−0.0084（n=2036） vs 无确认突破 meanR=−0.0231（n=3069），确认机制仍存活但幅度仅 +0.015R |
| 策略级门禁 | **未通过**：n=2036 ≥200 ✓；PF=0.972 <1.2 ✗；95% CI=[−0.0419, +0.0254] 含 0 ✗；多数年份为正 6/12 ✗ |
| 随机镜像基线 | 基线 meanR=+0.0311；策略 − 基线 = −0.0396，diff 95% CI=[−0.0953, +0.0164]，**不优于基线** |
| 结论 | **suspended（strategy_gate_failed）**：保真实现下完整策略无正期望，不可入库；理论未被证伪，因此**不 retired** |

按 killRules：`tr01-pf`（PF<1.2）触发 → suspended。本次结论有效的前提是 F-A..F-H 通过（见 §2）；未实现条款见 §2 F-E。

**这就是路线 A 要的判决：TR-01 在中国商品期货上，确认机制存在但太弱——扣成本、扣执行摩擦后无法成为可用策略。** 它不是"实验没做对"（not_evaluable），是保真后"策略不达标"。

## 2. F-A..F-H 检查表（本次实现）

| # | 检查项 | 结果 | 证据 |
|---|--------|------|------|
| F-A | 市场模型公式逐字 | ✅ pass | F1 U 态/空头镜像、F2 半衰期（10 日 T1 未触及全平）、F3 F_t 全部按库实现 |
| F-B | 信号/入场 | ✅ pass | g_t=(EMA20_t−EMA20_{t−5})/(5·EMA20_{t−5}) 精确；确认区=20 日突破∧量比≥1.2；**删除旧版自加 spacing guard** |
| F-C | 止损/目标结构位 | ✅ pass | onFill 按实际入场价重算 min(入场∓1.5×ATR5_T, 突破前3日极值∓0.25×ATR5_T)；F_t→次日开盘；量衰竭 2 日→次日开盘；T1 触及后余仓 2×ATR5 移动止损 |
| F-D | 仓位/加仓 | ✅ pass | T1 2R 平 50%（leg A）；T2=min(3R, 3d p95 上下沿)（leg B，cap-6 provenance=probability.json）；\|g\| 档 0.5R/1R；浮盈≥1R 且收盘创 5 日新高/低→+0.5 单位 T+1 开盘、最多 2 次、止损同步；单品种总风险 ≤2R（487 条加仓腿，418 笔交易） |
| F-E | 执行条款 | ⚠️ partial | T+1 开盘 ✓；跳空>0.5×ATR5 放弃 ✓（95 次 abandon）；换月日不入场/不加仓 ✓（7 笔 roll-jump 强平）；长假前不开新仓、持仓长假前收盘平（118 笔）✓；**“空头距涨停<1×ATR5 禁开”not_implemented**（GA 数据契约无涨跌停幅度字段，库依赖交易所当日公告，见 §3） |
| F-F | 数据口径/PIT | ✅ pass | 只用 GA-1/GA-2 字段；lookahead violations=0 |
| F-G | 证伪测试原样 | ✅ pass | specs/TR-01.json 未改；三基线（always-long/short/random）+ 理论级嵌套 no-confirm 对比，seed=20260828 |
| F-H | 失败可归因 | ✅ pass | 唯一未实现条款已标注；判定使用新 taxonomy `strategy_gate_failed`（保真实现 + 策略级门禁未过 + 理论级未证伪），不冒充 falsified |

## 3. 未实现条款的影响评估与裁定请求

- **空头距涨停 <1×ATR5 禁开**：这是逼仓尾部保护，不影响信号/定价链。GA 数据契约无涨跌停幅度，静态比例表会引入新的口径风险，故本版不实现、不编造参数。
- 该条款只会在“空头信号且收盘距涨停 <1×ATR5”时过滤入场，属于小概率尾部事件；策略级结论（PF 0.97、CI 含 0）由 2036 笔交易主导，单条款过滤不会反转判决方向。
- **请求队长裁定**：接受本复跑为 TR-01 的有效保真版本（该条款以 not_implemented 记录），或以“补交易所静态涨跌停表”为前置另行重跑。

## 4. 复现

```bash
node strategies/research/v2/falsification/harness.cjs run --spec TR-01 \
  --out strategies/research/v2/falsification/data/harness-runs/tr01-fidelity-v2 --seed 20260828
```

- resultsHash 由 harness 生成（确定性，seed=20260828）。
- 引擎改动：`harness-lib/sim.cjs`（onFill / decision.add，向后兼容）；`harness-lib/strategies/TR-01.cjs`（fidelity v2）。
- selftest 22/22 通过；全量测试随本提交更新。

## 5. 对后续方向的含义

1. TR-01 关闭复跑通道（理论弱存活、策略不达标），不再投入；其"确认机制"作为机制知识保留，可进入下轮假设生成的对照证据。
2. FS-02 基差管线继续（后台回填中）；它是库内唯一未判决项。
3. 机制探针 round 2 不急于发：先用 TR-01 的经验校准"多强才算强"——保真版 0.015R 的理论优势不足以覆盖成本与执行摩擦，未来 promote 候选的代理证据需要显著高于此量级。
