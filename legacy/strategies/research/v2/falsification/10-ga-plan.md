# 10 GA-1..GA-7 现状审计与执行方案（falsification 数据前置）

> 角色：data-engineer（数据工程师）· 审计日期：2026-08-28
> 审计对象：`strategies/research/v2/04-data-contracts.json` 的 `globalActions`（GA-1..GA-7）对照仓库数据层实况
> 对照基准：`08-final-data-audit.md`（t11 校验）、`strategy-library-v2.json` 的 `validationGates.G0`/`batchOrder`、data-store 实况
> 产出：本方案（`strategies/research/v2/falsification/10-ga-plan.md`）
>
> 一句话结论：**GA-1..GA-7 全部处于"工具/数据源已验证可行但未执行/未构建"状态（8/8 未完成）；仓库能力 100% 在位，无不可得数据源；本方案给出逐项落地命令、耗时、验收与回退。唯一长杆是 GA-1（sina 限流 ~80 req/h）。**

---

## 1. 现状审计结论（2026-08-28 实测）

| GA | 名称 | 当前状态 | 阻塞对象 | 关键证据（本轮实测） |
|---|---|---|---|---|
| GA-1 | 主力连续全历史回填 | **未运行** | TR-01/03/06、FS-02/04/05、M1、EC-01（全部 8 条核心） | `research/backtest/data/` 不存在；data/daily 59 品种：56×61 bars（2026-06-03 起）+ RB0/M0/SC0 500 bars（2024-08-06 起）；工具 `research/backtest/full-history-collector.cjs` 在位；akshare 1.18.81 在位 |
| GA-2 | 全品种 ATR5/HV/HV%ile/概率锥批量 | **runner 未建** | TR-01/03/06、M1、G2 | 能力组件在位（`probability/hv-estimators.js`、`stage-4-5.cjs`）；最新 run `20260827-1529-auto` 的 probability.json 仅覆盖 3 品种（EC0/RM0/B0，estimator=yang_zhang） |
| GA-3 | 板块广度/leaders/laggards 历史重建 | **未运行** | 仅候补（TR-04/TR-08/FS-06），不阻塞核心 8 条 | `data/sector/*.json` 8 个板块文件均仅 1 行（2026-08-27）；`collector/sector-aggregator.cjs` 在位（--runId 模式）；recordings/v5/sector-history.json 为 2025-11 起 |
| GA-4 | 宏观锚点历史回填 | **未运行** | M1、G1 | recordings/v5/macro-history.json 实测：DXY 10552 行（1985-11+）、USDCNH 3078 行（2014-11+）、**US10Y 仅 144 行（2026-02-02+）、DR007 仅 132 行（2026-02-02+）**；回填程序 `collector/akshare-macro.cjs`+`macro_collector.py`（kinds: `akshare_bond_zh_us_rate` / `akshare_repo_rate`）在位且带测试 |
| GA-5 | USDCNH change5d 缺失修复 | **未修复** | G1（M5）、M2 候补 | 最新快照 `data/macro/20260827-2159-auto.json` 实测：USDCNH.value=6.7186、**change5d=null** 复现；修复可完全离线（宏历史序列在库，见 §8） |
| GA-6 | 生意社现货粘性质量门逐品种审计 | **未运行** | FS-02（第二批） | t4 实测 `futures_spot_price_daily` 2011+ 13 列含 dom_basis_rate 可用；本仓无采集器/审计产物；**PIT 纪律（F7）：历史回填必须当日快照，禁今日数据回填** |
| GA-7 | 政策日历 v0（事件前提最小集） | **未构建** | FS-04/FS-05/EC-01（冻结前置；EC-01 未建成期间仅 paper） | 模板在位：`strategies/signal-backtest/recordings/v5/event-calendar.json`（schema v2，含 F9 discipline 文本）；GA-7 最小集 YAML 不存在 |

**环境实测**（与 04-data-contracts.json `environment` 一致）：Python 3.14.4、akshare 1.18.81、pandas 3.0.3、requests 2.34.2、Node 在位。`config/symbols.json` 82 品种中 active=59，与 data/daily 59 文件一致。

**G0 官方顺序**（strategy-library-v2.json `validationGates.G0`）：
`GA-1 → GA-2 → GA-3 → GA-4 → GA-5 → GA-6 → GA-7`；
`batchOrder` 第一批（TR-01/TR-03/FS-04/FS-05/M1/EC-01）前置 = **GA-1/GA-2/GA-4/GA-7**；第二批 FS-02 另需基差采集器+GA-6；第三批 TR-06 另需 FinCoT 历史向前积累（限 RB0/M0/SC0）。

---

## 2. 执行顺序与依赖图（两波并行）

```
Wave A（不依赖 GA-1，先发）          Wave B（依赖 GA-1）
P0 环境预检 (10min)                  GA-1 全历史回填 (1.5–3.5h)
GA-4 宏观锚点回填 (0.5–1h)      ──→  GA-2 全品种派生批量 (1.5–2.5h)
GA-5 USDCNH change5d (≤0.5h)        GA-3 板块序列重建 (≤0.5h)
GA-6 现货粘性审计 (0.5–1h)     ──→  GA-9 集成验证: G0 门禁核查 + 数据验证报告 (1h)
GA-7 政策日历 v0 (1–2h)
```

- 关键路径：**GA-1 → GA-2 → 集成验证**，纯墙钟约 4.5–6.5h；全量总工时约 6–10h。
- GA-4/5/6/7 与 GA-1 无数据依赖，可与 GA-1 并行执行（GA-1 是长杆，建议其先启动、退避等待期间做 Wave A）。
- 数据源纪律：只使用仓库允许源（akshare/sina 同源族 + 官方公开源：chinamoney/FRED/交易所官网）；**不伪造、不可得即标 no-source 并回退**；全部历史回填写 `fetchedAt`/`asOf` PIT 元数据。

---

## 3. P0 环境预检（每个执行日先跑，10 min）

t4 网络验证结论（2026-08-28 生效）在 GA 执行日必须复验，防止源接口漂移：

```bash
cd futures-radar
node -v && python -V
python -c "import akshare, pandas, requests; print('akshare', akshare.__version__, '| pandas', pandas.__version__, '| requests', requests.__version__)"
# sina 主力连续 1 次低成本探活（含限流观察）
python -c "import akshare as ak; df=ak.futures_main_sina(symbol='RB0'); print(len(df), df.iloc[0]['日期'], df.iloc[-1]['日期'])"
# 宏观源探活
python -c "import akshare as ak; print(len(ak.bond_zh_us_rate()))"
python -c "import akshare as ak; print(len(ak.repo_rate_hist(start_date='20250801', end_date='20250831')))"
```

**验收**：全部返回行数 >0 且末行日期 ≥ 执行日前 2 个交易日。**失败回退**：单项失败不阻塞其余 GA；按各 GA 的失败回退处理，并在 GA 报告中标注 no-source/降级。

---

## 4. GA-1 主力连续全历史回填

- **现状**：未运行；56 品种 61 bars、3 品种 500 bars；工具在位（见 §1）。
- **数据源**：`akshare futures_main_sina`（sina 主力连续，SR-01；限流 ~80 req/h，OHLCV+OI+settle；RB0 2009+/I0 2013+/TA0 2006+/M0 2005+）。
- **工具/命令**（futures-radar 根目录）：
  ```bash
  node research/backtest/full-history-collector.cjs
  # 内部：config/symbols.json active=59 → ParallelCollector(days=-1, 4 workers/5 per batch, maxRetries=3, 退避)
  # 输出：research/backtest/data/historical-cache.json + cache-meta.json
  #       + data-store ingest 镜像 data/daily（runId=bt-full-*）+ data/export/historical-cache.json
  ```
  建议后台运行并落日志：`node research/backtest/full-history-collector.cjs 2>&1 | tee research/backtest/data/ga1-run.log`。
- **附加工作（F5 换月纪律，collector 原生不产出，需补 1 个小脚本）**：对每品种计算逐 bar 日收益率，`|r_t| ≥ 9.5%` 的 bar 标记为疑似换月跳变，输出 `strategies/research/v2/falsification/data/ga1-roll-jumps.json`；per-bar sources 由 data/daily 现有 schema 的 `contract.ohlcv.sources` 承载（full-history 批次经 data-store ingest 后同样保留，需在验收时核查）。
- **预计耗时**：1.5–3.5h 墙钟（59 品种 × sina 限流；重试另计）。可后台运行，等待期做 Wave A。
- **验收标准**（全部机检）：
  1. `research/backtest/data/historical-cache.json` + `cache-meta.json` 存在，`meta.succeeded = 59`；
  2. 每品种 bar 数 ≥ 采集日源深度（对照 GA-1 实测锚：RB0 2009+、M0 2005+、TA0 2006+、I0 2013+），无品种停留在 61 bars（除非源确实无更多历史 → 单列说明）；
  3. 日期无未来值（跑 `collector/future-date-guard.cjs` 语义校验：所有 bar.date ≤ 执行日）；
  4. `ga1-roll-jumps.json` 产出，≥9.5% 跳变 bar 清单非空（主力连续必有换月），换月剔除逻辑供 walk-forward 引擎消费（F5）；
  5. data/daily 镜像更新成功（data-store `ingestRunBars` 返回 barsChanged>0），`data/export/historical-cache.json` 的 meta.dateRange.earliest 覆盖到 2005 年附近；
  6. 每品种含 PIT 元数据（fetchedAt/dataStart/dataEnd；per-bar sources 字段存在）。
- **失败回退**（逐级）：
  1. 限流/超时 → 依赖 collector 内置退避+maxRetries=3；仍失败 → 分品种重跑 `python collector/futures_collector.py --symbols X --days -1`；
  2. sina 主力连续接口整体不可用 → 回退 `futures_zh_daily_sina`（SR-02）逐合约拉取 + 自建主力换月拼接（换月规则按 F5 的 ≥9.5% 剔除/持仓量最大规则），工作量 +2–4h，PIT 元数据按合约写；
  3. sina 族全部不可用 → 标 **no-source**，GA-1 blocked：全部日线依赖策略停留 designed，G0 不可过；写 `ga1-no-source.md` 上报，不得用第三方付费/爬虫替代。

---

## 5. GA-2 全品种 ATR5/HV/HV%ile/概率锥批量

- **现状**：能力在位、批量 runner 未建（§1）。
- **数据源**：无新外部源；输入 = GA-1 回填后的 `data/daily`（59 品种全量日线，PIT：只用 T 日及以前）。
- **工具/命令**：
  1. 新建 `strategies/research/v2/falsification/ga2-derived-batch.cjs`（或 research/falsification/ 下），复用 `probability/hv-estimators.js`（`autoEstimateHV`、`hvPercentile`）与 `probability/probability-cone.js`（`probabilityCone`），对 59 品种全量日线滚动计算；
  2. 运行：`node strategies/research/v2/falsification/ga2-derived-batch.cjs`；
  3. 输出：`strategies/research/v2/falsification/data/ga2-derived.json`（每品种：atr5、hv20d（annual，estimator）、volPercentile（90d）、3d/5d p68/p95 锥——锥对 TR-03 目标定价使用，cap-6 provenance=probability.json）。
- **预计耗时**：脚本 1–2h + 运行 ≤0.5h。
- **验收标准**：
  1. 覆盖 59/59 品种，每品种字段非空（ATR5、HV、HV%ile、锥）；
  2. 数值口径与 stage-4-5.cjs 同源函数一致（抽 3 品种与最新 run probability.json 对拍，HV 相对误差 <1%）；
  3. PIT 校验：对任选品种任选日期 t，用截至 t 的数据重算 HV 与批量结果一致（滚动估计只用 T 日及以前，F8）；
  4. provenance 字段写入（estimator、window、computedAt、sourceSeries）。
- **失败回退**：GA-1 失败 → 只能对 RB0/M0/SC0 500 bars 运行（降级覆盖，报告中标注 degraded，不视为 validated）；计算 bug → 用 stage-4-5.cjs 逐 run 输出合并兜底（仅 KEEP 品种）。

---

## 6. GA-3 板块广度/leaders/laggards 历史重建

- **现状**：data/sector 8 板块各 1 行；工具 `collector/sector-aggregator.cjs`（--runId 模式，消费 run 数据）。
- **数据源**：无新外部源；输入 = GA-1 回填后的 data/daily（成员品种日线聚合）。
- **工具/命令**：
  1. GA-1 的 data-store ingest 会生成 runId（`bt-full-*`）；若 aggregator 无法直读该 run，补一个 `--history` 模式（读 data/daily 全量聚合）——预计小改（≤30 行）；
  2. 运行：`node collector/sector-aggregator.cjs --runId bt-full-<id>`（或 --history 模式）；
  3. 输出：重建 `data/sector/{black,agriculture,energy_chemical,nonferrous,precious,new_materials,shipping}.json` 序列 + `_index.json`。
- **预计耗时**：≤0.5h（+可选小改 0.5h）。
- **验收标准**：
  1. 各板块序列 bar 数与 GA-1 窗口一致（最早日期 ≈ 2005+，最晚 = 执行日）；
  2. 每 bar 含 breadth/leaders/laggards 字段（与 sector-aggregator 既有 schema 一致）；
  3. 抽 1 日与 1 行旧快照（2026-08-27）同口径对拍一致。
- **失败回退**：GA-1 失败 → GA-3 只能保留 1 行快照，候补池（TR-04/TR-08/FS-06）继续 blocked，核心 8 条不受影响（如实标注，不伪造序列）。

---

## 7. GA-4 宏观锚点历史回填

- **现状**：US10Y/DR007 仅 2026-02+（§1）；DXY/USDCNH 已深不需动。
- **数据源**：`akshare bond_zh_us_rate`（同表 CN10Y/US10Y，2002+，全量 9330 行实测）；`akshare repo_rate_hist`（chinamoney 官方：FDR007 2017-05-31+、FR007 2015+ 代理；单窗 ≤1 年，超窗 KeyError → 按年分批）。
- **工具/命令**（复用 `collector/akshare-macro.cjs` + `macro_collector.py`，或等价的 python 分批脚本）：
  ```bash
  # US10Y：一次全量（kind=akshare_bond_zh_us_rate, field=美国国债收益率10年, signalDate 给到最早）
  # DR007：2015→2017→…→2026 逐年 12 次分批（每次 start=YYYY0101,end=YYYY1231）
  # FDR007 取 2017-05-31+；FR007 取 2015-01→2017-05-30 代理段
  ```
  写回 `strategies/signal-backtest/recordings/v5/macro-history.json`（新 fetchedAt、series 扩展 US10Y/DR007 至 2002+/2015+），并同步 data/macro 索引（如需）。
- **拼接纪律（契约内定）**：FDR007/FR007 拼接点 ±20 交易日剔除并留档（写入 `strategies/research/v2/falsification/data/ga4-splice-notes.json`）；walk-forward 只用 FDR007 段，FR007 段仅用于 2015–2017 粗标定。
- **预计耗时**：0.5–1h（13 次 akshare 调用 + 写回 + 校验）。
- **验收标准**：
  1. macro-history.json 中 US10Y series ≥ 6000 行且最早 ≤2002-06；DR007 series 最早 ≤2015-01 且 2017-05-31 起为 FDR007 口径；
  2. 无未来日期；拼接点留档文件存在；
  3. 与现 144/132 行尾部对拍一致（2026-02 起数值与旧 recordings 重合段一致）。
- **失败回退**：
  1. `bond_zh_us_rate` 失败 → FRED `DGS10`（官方公开源，1962+）替代 US10Y，报告中标注来源替换；
  2. `repo_rate_hist` 失败 → chinamoney 官网公开 CSV 直采（官方源）；再失败 → 标 **no-source**，M1/G1 的 GA-4 前置 blocked，策略停留 designed。

---

## 8. GA-5 USDCNH change5d 缺失修复

- **现状**：最新快照 `USDCNH.change5d=null` 复现（§1）；根因在 macro-probe 对 USDCNH 抓取窗口过浅（bar.index=0 时 change5d 不可计算）。
- **数据源**：无需新抓取——`strategies/signal-backtest/recordings/v5/macro-history.json` 已有 USDCNH 3078 行（2014-11+）。
- **工具/命令**：
  1. 修 `collector/macro-probe.cjs`：USDCNH 的 change5d 计算回退到宏历史序列（computeChange5d 以 asOf 前第 5 个交易日为基准），抓取窗口不足时不得输出 null 而应降级 stale 标注（F2 规则已有）；
  2. 跑一次 `node collector/macro-probe.cjs --runId <最新runId>` 验证，或等价修复后重放快照。
- **预计耗时**：≤0.5h（含单测）。
- **验收标准**：
  1. 新快照 USDCNH.change5d 为有限数值（或按 stale 规则显式标注降权，不再是裸 null）；
  2. `collector/macro-probe.test.js` 或新增单测通过（含"窗口不足"分支）；
  3. M5/G1 五锚点评估不再因 USDCNH null 计 0（F2 行为正确）。
- **失败回退**：若修复无法稳定 → 保持 null 但确保 F2 stale/missing 降权路径正确（missing 计 0 并标注），G1 验证延后；不伪造数值。

---

## 9. GA-6 生意社现货粘性质量门逐品种审计

- **现状**：未运行；无现货数据文件在本仓。
- **数据源**：`akshare futures_spot_price_daily`（生意社，2011+，13 列含 dom_basis_rate）+ `futures_spot_price_previous`（54 品种 180 日分布锚）；PIT 纪律（F7）：**逐日快照留档，禁今日数据回填历史**。
- **工具/命令**：
  1. 新建 `strategies/research/v2/falsification/ga6-spot-stickiness.py`：调 `futures_spot_price_daily(start, end)`（覆盖 FS-02 相关品种）；逐品种计算 30 日零变动占比；
  2. 运行并输出：`strategies/research/v2/falsification/data/ga6-spot-stickiness.json`（逐品种：零变动占比、剔除判定）+ `ga6-tradable-set.json`（FS-02 可交易集名单，>40% 剔除）；
  3. 同文件记录每次拉取的 fetchedAt 快照（PIT 审计链）。
- **预计耗时**：0.5–1h（调用次数少、本地计算）。
- **验收标准**：
  1. 覆盖 futures_spot_price_daily 全部 FS-02 相关品种（≥30 个），每品种有 30 日零变动占比数值；
  2. 剔除规则 30 日零变动 >40% 逐品种机械执行，可交易集名单产出；
  3. PIT 证据：文件中含 fetchedAt，且与采集日一致（禁回填）；
  4. FS-02 回测输入口径就绪：dom_basis_rate 序列 + 180 日分布锚可用。
- **失败回退**：接口不可用 → 标 **no-source**，FS-02 停留 designed（第二批不受影响以外的部分照常）；已有部分品种数据 → 只对可得品种出报告，其余标 no-source。

---

## 10. GA-7 政策日历 v0（事件前提最小集）

- **现状**：未构建；schema 模板在 `strategies/signal-backtest/recordings/v5/event-calendar.json`（v2，含 F9 discipline）。
- **数据源**：人工维护 YAML（官方公开信息留档：发改委/工信部/商务部/交易所公告等公开源；年份级窗口标注即可，完整事件集走 FS-09/M11 路线）。
- **工具/命令**：
  1. 编写 `strategies/research/v2/falsification/ga7-policy-calendar-v0.yaml`，至少覆盖三类：
     - 黑色：2016–2017 供给侧改革、2021 粗钢压减、2025 粗钢产量调控；
     - 农产品：2019 菜籽进口政策、2023 反倾销、收抛储窗口；
     - 能化：2020 负油价（2020-04）、2022 俄乌供给冲击（2022-02+）；
     每条含 `date/type/title/scope/source/verified`；
  2. F9 校验脚本：`strategies/research/v2/falsification/ga7-f9-check.cjs`（event.date ≤ 锚点日断言；禁价格反推事件——事件条目须带 source）。
- **预计耗时**：1–2h（人工核对公开源 + 校验）。
- **验收标准**：
  1. YAML 含 ≥9 个事件窗口（三类各 ≥2），每条带 source 与 verified 标记；
  2. `ga7-f9-check.cjs` 全部断言通过；
  3. FS-04/FS-05/EC-01 的证伪测试 (d)/(c) 所需窗口（2016–17/2021/2025 黑色、2019/2023 农产品、2020/2022 能化）全部可标注。
- **失败回退**：某窗口来源不可核 → 降级为 schedule/unverified 标注，不阻塞年份级留档；完全无法构建 → FS-04/FS-05/EC-01 不得进入 in_validation，EC-01 维持 paper-only（门禁已编码，如实报告）。

---

## 11. GA-9 集成验证与数据验证报告（G0 门禁核查）

各 GA 完成后统一跑：

```bash
cd futures-radar
node data-store/index.cjs --verify   # data/daily 完整性
node data-store/index.cjs --stats    # 覆盖/日期范围
python strategies/research/v2/t12-acceptance-check.py   # 库 schema 断言（若涉库改动）
# 未来日期守卫 + 换月跳变清单复核 + 各 GA 验收项复核（§4–§10）
```

产出 `strategies/research/v2/falsification/11-ga-completion-report.md`（各 GA 验收矩阵 + no-source 清单 + G0 门禁判定）。**纪律：任何 GA 验收未过，对应策略不得进入 in_validation；如实记录，不伪造、不回填。**

---

## 12. 产出目录布局（strategies/research/v2/falsification/）

```
falsification/
├── 10-ga-plan.md                 # 本方案
├── 11-ga-completion-report.md    # 集成验证/G0 判定（GA 全部完成后）
├── ga1-roll-jumps.json / ga1-no-source.md      # GA-1 附件（必要时）
├── ga4-splice-notes.json                        # GA-4 附件
├── ga6-spot-stickiness.json / ga6-tradable-set.json
├── ga7-policy-calendar-v0.yaml / ga7-f9-check.cjs
├── ga2-derived-batch.cjs / ga6-spot-stickiness.py
└── data/                          # 派生数据落位
```

原始数据仍按仓库既有位置落位（data/daily、research/backtest/data/、data/sector、recordings/v5），不复制搬迁。

---

## 13. 风险登记与升级路径

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| sina 限流比 t4 更严（80 req/h 失效或收紧） | 中 | GA-1 墙钟拉长到 5h+ | 分批+退避；失败回退 §4；后台运行与 Wave A 并行 |
| akshare 接口漂移（repo_rate_hist/bond_zh_us_rate 列名或窗口变化） | 低-中 | GA-4 失败 | P0 预检先行；官方源回退（FRED/chinamoney） |
| 生意社接口中断 | 低 | GA-6 no-source | FS-02 停留 designed，其余不受影响 |
| GA-1 数据量（59 品种 × 全历史）导致 ingest 慢/内存 | 低 | 集成验证延迟 | collector 已按批次写；data-store 分品种镜像 |
| 政策日历来源核验耗时超预期 | 低 | GA-7 +1h | 年份级留档即可；unverified 降级标注 |

**升级路径**：no-source/blocked 结论直接写入 GA 报告并同步队长（不等待）；GA 执行任务按本方案拆分（GA-1、GA-2、GA-3、GA-4+GA-5、GA-6、GA-7、集成验证）。

> 本方案为数据前置执行计划，不构成投资建议。
