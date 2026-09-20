# 15 GA-1..GA-7 数据验证报告（G0 门禁核查）

> 角色：data-engineer-2（宏观/质量门/验证）· 验证日期：2026-08-28
> 验证对象：GA-1..GA-7 全部执行产物（独立机器复算，非引用执行方自报）
> 对照基准：`04-data-contracts.json`、`strategy-library-v2.json` prerequisites/asOfContract、`10-ga-plan.md` 验收矩阵、t4 裁决（GA-6 两项硬要求 + GA-7 实证日期）
> 结论：**GA-1..GA-7 全部 pass（0 needs-rework）；无未来函数；数据前置（G0）全部满足。GA-6 数据验证落地：FS-02 契约已按 t4 裁决更新（revision=GA-6 数据验证落地）。**

---

## 1. 逐 GA 验证矩阵（独立机检）

| GA | 验证项（独立复算） | 判定 | 关键证据 |
|---|---|---|---|
| GA-1 | data-store --verify；59 文件/178,310 bars；日期升序+无未来值；per-bar sources 非空；PIT 元数据（fetchedAt/lastBarAsOf）；深度锚；roll-jumps | **pass** | verify: 59 files/178310 bars/0 errors/0 warnings；机器扫查 0 问题；RB0 4232（2009-03-27+）、M0 5270（2005-01-04+）、TA0 4785（2006-12-19+）、I0 3128（2013-10-18+）；452 根 ≥9.5% 跳变（bySymbol 59/59）；historical-cache.json/cache-meta.json 在位（meta.succeeded=59） |
| GA-2 | 59/59 覆盖；series.dates 与 data/daily 逐日一致；ATR5/MA20/MA60/量比独立重算对拍（3 品种 × 3-4 日期，PIT 截至 T）；HV20 与 hv-estimators 库对拍；hvPct90 与 hvPercentile 库对拍；rollJumpDates | **pass** | 覆盖 59/59；ATR5 全对（26.6/24.4/33.8/30.8/28.4/29.2/142.4/132.8/92.8 全等）；HV20 relErr≈1e-9（yang_zhang）；volumeRatio 精确相等（1.2645754978443173）；hvPct90 精确相等（67.8/58.9/15.6）；MA20 全等；MA60 差 3.3e-5（4 位小数舍入，相对 1.6e-8，无实质影响——见 §5 观察） |
| GA-3 | 7 板块序列完整性+字段齐备；与旧管道 2026-08-27 快照逐字段对拍 | **pass** | black 4234 行（2009-03-30..2026-08-28）、nonferrous 5271、precious 4541、energy_chemical 5274、agriculture 5283、shipping 733、new_materials 892；08-27 行 ret1d/ret5d/ret20d/advanceRatio/coherence/volRatio/leader 与旧快照全等（indexLevel 997.61 vs 1117.25 为链式起点差异，t5 已留档） |
| GA-4 | 机检 11/11 重跑；US10Y/DR007 深度+拼接+无未来+升序+与旧尾部对拍 | **pass** | US10Y 8928（1990-12-19..2026-08-27）；DR007 2906（2015-01-04..2026-08-27，FR007 代理段+FDR007 主段，拼接 ±20 日剔除留档）；对拍 max_abs_diff=0；asOf/source/status 标注齐备 |
| GA-5 | 最新快照 USDCNH.change5d 有限；macro-probe 单测；F2 降级路径 | **pass** | ga5-replay-20260828：USDCNH 6.7185 asOf 2026-08-27 change5d=−0.08（fresh，5 锚点 available=5/missing=0）；collector 测试 78/78（含窗口不足/回退/显式降级分支） |
| GA-6 | 54 品种审计+42/12 名单+PIT 证据+复拉探针+**t4 裁决两项硬要求** | **pass** | 42 可交易/12 剔除（ga6-tradable-set.json）；fetchedAt 2026-08-28 三文件齐备；同日复拉 diffCount=0；符号口径实证：RB@2026-08-27 dom_basis_rate=−0.007871=(F−S)/S → 库公式 br=(S−F)/S 须取反（49/54 signFlip 已留档）；无未来日期 |
| GA-7 | F9 校验全过；日历↔库一致性（2024-09-09）；证伪开窗覆盖 | **pass** | `ga7-f9-check.cjs` PASSED（含 yamlSha256 同源锁、5 组 F9 正反用例）；日历 ga7-ag-2024ad=2024-09-09 与 strategy-library-v2.json FS-05(c)（falsificationTests (c) line 1607、knownCounterEvidence line 1618）一致；FS-04(d)/FS-05(c)/EC-01(c) 窗口全部可标注 |

**判定：0 needs-rework。** 执行中发现的偏差（MA60 舍入、sector 08-28 部分成员、F9 同步滞后）均为非阻塞观察项，见 §5。

## 2. 无未来函数全局扫查（机器执行）

| 层 | 结果 |
|---|---|
| GA-1 data/daily（59 文件 × 178,310 bars） | 0 未来日期（末 bar ≤ 2026-08-28） |
| GA-2 derived（59 文件，dates 与 daily 同源对齐） | 0 未来日期；PIT：任选 T 日独立重算（仅用 ≤T 数据）与批量结果一致 |
| GA-3 sector（7 板块） | 0 未来日期 |
| GA-4 macro-history（v4+v5，4 指标） | 0 未来日期 |
| GA-5 macro-snapshot | 0 asOf > marketCutoffAt（validator fail-closed 已内置） |
| GA-6 spot 证据 | 0 未来日期（≤20260828） |
| GA-7 政策日历 | 0 未来事件（F9 检查断言） |

## 3. prerequisites / asOfContract 对照矩阵（8 条策略）

| 策略 | 所需 GA | 验证结果 | asOfContract |
|---|---|---|---|
| TR-01 | GA-1, GA-2 | ✅ 全部 pass | F1/F2/F3/F5（换月剔除 452 根就绪、per-bar sources 在） |
| TR-03 | GA-1（prereq 另列 GA-2） | ✅ pass | F1/F2/F3/F5 |
| TR-06 | GA-1, GA-2 | ✅ pass（FinCoT 历史向前积累另按第三批） | F1/F2/F3/F5/F6 |
| FS-02 | GA-1, GA-6 | ✅ pass + 契约已更新（§4） | F1/F2/F3/F7（PIT 逐日快照已写入契约） |
| FS-04 | GA-1, GA-7 | ✅ pass | F1/F2/F3/F8/F9（F9 校验脚本在） |
| FS-05 | GA-1, GA-7 | ✅ pass（2024-09-09 一致性已核） | F1/F2/F3/F8/F9 |
| M1 | GA-1, GA-2, GA-4 | ✅ pass | F1/F2/F3/F8 |
| EC-01 | GA-1, GA-7 | ✅ pass | F1/F2/F3/F8/F9 |

G0 判定：**GA-1..GA-7 全部满足 → 数据前置通过；第一批（TR-01/TR-03/FS-04/FS-05/M1/EC-01）与第二批（FS-02，另需基差采集器）的数据层前置解除。**

## 4. 契约更新记录（revision=GA-6 数据验证落地，船长授权，仅数据契约）

1. `04-data-contracts.json` FS-02.br/z_t/μ̂_180：path 增加可交易集引用（ga6-tradable-set.json，42 可交易/12 剔除）；asOf 写入 PIT 逐日快照硬要求（同日修订风险实测 0.03–0.33）；gap 写入两项硬要求（①基差统一 br=(S−F)/S，dom_basis_rate=(F−S)/S 须取反，2026-08-27 RB0 实测；②PIT 逐日快照 F7）。
2. `strategy-library-v2.json` FS-02.dataContract.inputs/preconditionsNote 同步引用可交易集与两项纪律；**prerequisites 保持 GA-1,GA-6 不变**；theory/pricingModel/parameters 等零改动。
3. 两文件 JSON 有效性复核通过；`npm run test:core` 270/270（含读库测试）通过。

## 5. 观察项（非阻塞，如实记录）

1. **GA-2 MA60 存 4 位小数**（绝对误差 ≤5e-5，相对 1.6e-8）：对 vsMA60 百分比计算无实质影响；若下游要求全精度可后续升级（不阻断）。
2. **GA-3 最新行（2026-08-28）members 仅 2**：多数品种当日 bar 尚未入库（采集日 08-28 部分品种已收，部分 08-27 截止），属数据实况非错误；walk-forward 用 T 日及以前切片不受影响。
3. **TR-03 prerequisites=['GA-1','GA-2'] 而 requiredGAs=['GA-1']**：库内两字段不一致（纯声明层），GA-2 已 pass 故无阻塞；建议库修订时对齐（非本任务范围，未擅改）。
4. **GA-7 校验期间发现 yamlSha256 失配 1 次**：quant-researcher 更新 YAML note（库文案已对齐 2024-09-09）后未重跑 sync；已重跑 ga7-calendar-sync.py 恢复同源锁，F9 check 复绿。建议后续 YAML 修改后同步跑 sync+f9-check。
5. 已知既有失败：research/experiments/test/forward-recorder.test.js 3 例（夹具日期敏感），与本验证无关（执行日 2026-08-28 相对夹具 08-14 漂移），在 GA-1..GA-7 全部产物验证范围内无关联失败。

## 6. 验证命令清单（可复现）

```bash
node data-store/index.cjs --verify && node data-store/index.cjs --stats
python strategies/research/v2/falsification/ga4-macro-backfill.py verify   # 11/11
node --test collector/macro-probe.test.js collector/akshare-macro.test.js collector/macro-snapshot.test.js
node strategies/research/v2/falsification/ga7-f9-check.cjs                 # PASSED
python strategies/research/v2/falsification/ga7-calendar-sync.py
npm run test:core                                                          # 270/270
node --test collector/future-date-guard.test.js test/signal-backtest-v4.test.js test/signal-backtest-v5.test.js  # 78/78
# + 本报告 §1-§2 的独立 Python/Node 复算（daily 扫查、GA-2 抽样重算、GA-3 对拍、GA-6 名单/符号/PIT 复查、无未来函数扫查）
```

> 本报告为数据验证记录，不构成投资建议。
