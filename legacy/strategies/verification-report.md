# 交易策略板块端到端验证报告（t10）

- 验证对象: `strategies/**`（策略库/匹配引擎/规则/契约）、`report/**`（渲染器/schema）、`test/**`、真实 run `output/runs/20260827-1910-auto/`（strategy-plan.json 与 report.md 第五章）
- 验证人: reviewer（策略审查员）
- 验证日期: 由 run 冻结值推导（信号日 2026-08-27）
- 性质: 端到端验证 —— 逻辑自洽性、可执行性、合规性、输入一致性

## 1. 命令执行证据

| 命令 | 结果 | 证据 |
|------|------|------|
| `npm test` | ✅ exit 0 | 580/580 全绿（98 suites、0 fail、0 skip）。新增策略相关测试全绿：`strategy-matcher` 17 条（库校验/workedExample 关键值逐值复现/确定性/BASE-01 保底/集中度仲裁/PB-02 禁用/schema/无 OI/免责/静态无网络）+ `strategy-section` 11 条（板块存在/TOP3≥1 策略/五小节齐全/禁用词表/%收益率断言/四章+附录不变/插入位置/回退/确定性） |
| `node strategies/build-strategy-plan.cjs --runId 20260827-1910-auto` | ✅ exit 0 | 输出 3 个 plan：RM0（executable 1 手）、EG0（watch 0 手）、PX0（watch 0 手）；concentrationDecisions=0（无同板块同向 executable 冲突） |
| 确定性双跑 | ✅ 逐字节一致 | 连续两次重建 strategy-plan.json，`cmp` 完全一致（generatedAt 由 signalDate 派生，无时间戳/随机依赖） |
| `validatePlan(strategy-plan.json)` | ✅ ok | 按 `report/strategy-plan.schema.json`（t7 draft-07 子集）校验通过 |

## 2. 逐条验收结论

### AC-1 552+ 既有测试全绿，新增策略测试全绿 — PASS

- `npm test` 580/580 通过（>552 基线；新增 17 条 matcher + 11 条渲染测试全部通过）。
- 关键 workedExample 断言与本次独立重算一致：RM0 stopDistance=72.9（=1.5×ATR5 48.6）、stopPrice=2275.1（2348−72.9）、unitRisk=729、margin/手=1878（2348×10×8%）、marginUtilization=1.88%、volContribution=3.5%（1 手×2348×10×14.9%/100000）、stressRisk=1174（1×10×5%×2348，RM0 涨跌停 5% 取自 analysis.q6_risks）。

### AC-2 真实 run 报告策略板块字段/逻辑验证通过 — PASS（附 2 项缺陷登记，见 §5，移交 t11 审查裁定）

逐字段验证（详见 §3、§4）：
- 三个 TOP3 品种（RM0/EG0/PX0）每品种 matchedStrategies ≥1（3/1/2 条），满足 t6 队长裁定「每个 TOP3 ≥1 个 matchedStrategy」。
- 入场/止损/目标/仓位/失效/风险 15 键/执行状态/免责 全部齐全；watch 计划（EG0/PX0）不省略策略适配内容且附「转执行触发」（=Q4 确认信号）。
- 状态徽标正确：RM0 ✅ 可执行（lots=1）；EG0/PX0 👀 观察（lots=0）。watch⇒lots=0、executable⇒lots≥1 跨字段规则成立。
- 数值逻辑全部通过独立重算（§3 明细）。
- 缺陷登记：F-1（medium，展示缺陷）MS-01 空头命中时证据串硬编码 `>`，报告呈现「close 7948>MA20(8090.4)」为假命题（逻辑判定正确：7948<8090.4）；F-2（low，边界处理）MS-07 得分恰为阈值 1.5 且排第 4 时被 top-3 截断后既不入 matchedStrategies 也不入 supportingEvidence，静默丢弃。

### AC-3 strategy-plan.json 与 analysis/report 输入一致性验证通过 — PASS

- `meta.inputsSha` 与 8 个输入文件（report-model/probability/sector-snapshot/sector-driver/macro-snapshot/analysis/raw.json + config/symbols.json）按 matcher 同法重算 SHA-256 完全一致（`7fa97085…db459d`）。
- 方向/置信度只读自报告：reportBaseline 与 analysis.json `direction/confidence` 完全一致（RM0 bullish/medium；EG0 bearish/medium；PX0 bearish/medium），报告第五章总览表方向与第三章一致。
- 入场触发 = analysis Q4 确认信号原文；失效条件 = Q5 失效条件原文；结构止损 = Q5「MA20(约…)」数值；事件风险 = Q6 eventRisk；涨跌停幅度 = Q6 limitDistance（RM0 5%、EG0 4%、PX0 4%）。
- 目标位 = probability.json 概率锥数值：RM0 T1=3d p95 上沿 2425.8；EG0 T1=3d p68 下沿 4776.5、T2=3d p95 下沿 4547.0；PX0 T1=3d p68 下沿 7693.5、T2=3d p95 下沿 7456.8 —— 全部逐值一致。
- 尾部/分位参数与 probability.json 一致：RM0 tail −3.21%<5%（不触发连续停板警示，可执行）；EG0 tail −9.57%≥4%、hvPct 87.8≥85 非 high → watch；PX0 tail −6.18%≥4% → watch。
- riskOff=3 复算一致：DXY +0.34→+1、DR007 1.39(<2.0)且 change5d 0.72(≥0.5)→+1、SC0 −1.18(≤−1)→+1、US10Y/USDCNH stale→0 计 0。
- Q2 趋势对齐与 raw.json ohlcv 复算一致：RM0 close 2348>MA20 2237.4/MA60 2278.7、change5d +2.89% 同向（MS-01 命中）；EG0 close 5028>MA20 5023.9 → 不对齐（MS-01 正确不命中，与 analysis.q2「价格仍高于 MA20」同构）；PX0 close 7948<MA20 8090.4/MA60 8085.1、change5d −3.82% 同向（MS-01 命中）。
- 仓位三路复算一致：RM0 min(风险预算 floor(750/729)=1, 波动率目标 floor(10000/(0.149×2348×10))=2, 保证金 floor(33000/1878.4)=17)=1；EG0 min(0,0,8)=0；PX0 min(floor(750/570)=1, floor(10000/(0.292×7948×5))=0, floor(33000/3179.2)=10)=0（PX0 合约乘数 5）。

### AC-4 无收益承诺、无未来函数、无持仓分析违规 — PASS

- 收益承诺：report.md 第五章正文（剔除免责声明）与 strategy-plan.json 全文扫描 24 类禁用词（收益率/年化收益/胜率/保证/稳赚/必涨/必跌/无风险/包赚/翻倍/目标收益…），仅免责声明中出现否定式表述（「不含任何收益承诺或预期收益」「不输出任何收益/胜率数字」），无 `N%收益/回报` 模式。✅
- 无未来函数：matcher 只读 8 个已冻结 artifacts + config/symbols.json；静态检查无 `fetch/https/Math.random/Date.now/setTimeout/LLM 调用`（`generatedAt` 由 signalDate 派生）；全部输入时间戳 ≤ 信号日 2026-08-27；指标计算只用到 `close/high/low/volume` 截至最后一根 bar。
- 无持仓分析违规：matcher 不读取 `ohlcv.openInterest / derived.avgOI5d` 等任何 OI 字段；报告中「持仓」表述均为 Q4/Q5 既有文本引用（触发/失效条件），符合 provenance.discipline 声明。✅
- 免责声明：plan 级与板块级免责声明均含「不构成投资建议」「不执行真实交易」「不含收益承诺」；板块声明「报告结论是第一依据，本板块不得反向修改」与边界 5 条一致。✅

## 3. 关键数值独立重算明细

| 项目 | RM0（多） | EG0（空） | PX0（空） |
|------|-----------|-----------|-----------|
| close / ATR5 / 涨跌停 | 2348 / 48.6 / 5% | 5028 / 222.6 / 4% | 7948 / 268 / 4%（乘数 5） |
| stopK×ATR5 | 1.5×48.6=72.9 | 1.5×222.6=333.9 | 1.5×268=402 |
| 0.8×limit×close | 0.8×5%×2348=93.9 | 0.8×4%×5028=160.9 ✅取 | 0.8×4%×7948=254.3 |
| \|Q5 结构位−close\| | \|2221−2348\|=127 | \|4858−5028\|=170 | \|8062−7948\|=114 ✅取 |
| stopDistance → stopPrice | 72.9 → 2275.1 ✅ | 160.9 → 5188.9 ✅ | 114 → 8062 ✅ |
| 风险预算手数 | floor(750/729)=1 ✅ | floor(750/1609)=0 ✅ | floor(750/570)=1 ✅ |
| 波动率目标手数 | floor(10000/3498.5)=2 ✅ | floor(10000/23179)=0 ✅ | floor(10000/11604)=0 ✅ |
| 保证金手数 | floor(33000/1878.4)=17 ✅ | floor(33000/4022.4)=8 ✅ | floor(33000/3179.2)=10 ✅ |
| 最终 lots / 状态 | 1 / executable ✅ | 0 / watch ✅ | 0 / watch ✅ |
| RR 门槛 | T2=3R≥1.5 ✅ | —（watch） | —（watch） |

全部数值与 strategy-plan.json、report.md 第五章一致。

## 4. 渲染与结构验证

- 插入位置：`## 五、交易策略板块（执行参考）` 位于第四章（「四、今日不做什么」）之后、附录（「价格区间方法说明」）之前；章节只出现一次（无重复插入）。✅
- 五强制小节（策略匹配/执行计划/风险评估/执行状态与原因/失效与退出）+ 总览表 + 免责声明 齐全；每策略证据 URL ≤3。✅
- 四章+附录不变：`strategy-section` 测试逐行断言插入后原四章与附录全序不变（真实 run 基线 236 行 + 附录全部保留）。✅
- 状态徽标：✅/👀 与实际 executionStatus 一致；EG0/PX0 附「转执行触发」。✅

## 5. 缺陷与观察（移交 t11 审查）

### F-1（medium，报告展示缺陷）
- 位置: `strategies/lib/strategy-matcher.cjs` MS-01 分支（evidence 模板，约 430 行）；呈现于 report.md 第五章 PX0「策略匹配」表。
- 问题: 证据串比较符号硬编码为 `>`。空头对齐时逻辑判定正确（`close < MA20 && close < MA60`），但展示文本为「close 7948>MA20(8090.4)/MA60(8085.1)」，是假命题，与数字本身矛盾，误导读者对趋势对齐判定的理解。多头（RM0）不受影响。
- 建议修复: 按方向选择符号（bullish `>` / bearish `<`），并补充回归断言（bearish 证据串不得出现 `close X>MA20(Y)` 且 X<Y 的组合）。

### F-2（low，边界处理）
- 位置: `matchStrategies` 分层逻辑（`matched = hits.filter(score>=1.5).slice(0,3)`；`supporting = hits.filter(score<1.5)`）。
- 问题: RM0 的 MS-07 得分为恰等于阈值 1.5（2×0.75），排第 4 被 top-3 截断后，既不进入 matchedStrategies 也不进入 supportingEvidence，静默丢失（t6 workedExample 曾列出 MS-07=1.5）。不影响 ≥1 matched 保证与可执行性。
- 建议修复（可选）: top-3 截断后把 `score>=阈值` 的落选者并入 supportingEvidence（保留证据链），或明确声明「取前 3、其余丢弃」。

### 观察（非策略板块引入，登记不阻塞）
- OBS-1: report-model 筛选注记 `volPercentile 83.93` 与 probability.json `hv.percentile90d=77.8`（RM0）不一致，为既有 artifact 内部差异；matcher 以 probability.json 为准（77.8<85 不触发减半），与输入一致。
- OBS-2: analysis Q2/Q5 的 MA20（如 PX0 8062）与 raw.json 重算 MA20（8090.4）有差异（既有分析口径差异）；matcher 规则明确：趋势门用 raw ohlcv 重算、结构止损用 Q5 文本数值，两处均与各自输入一致，未见矛盾传导。

## 6. 结论

策略板块端到端验证通过（4 项验收全部 PASS，两条 verify 命令 exit 0，确定性双跑一致，输入一致性哈希核验通过，数据纪律无违规）。发现 1 项 medium 展示缺陷（F-1）与 1 项 low 边界处理（F-2），已登记供 t11 审查裁定并进入修复闭环；两者均不阻塞下游审查流程。
