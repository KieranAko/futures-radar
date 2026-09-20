# 11 GA-1 全历史日线回填完成报告

> 角色：data-engineer（数据工程师）· 执行日期：2026-08-28
> 任务：GA-1 主力连续全历史回填（04-data-contracts.json `globalActions.GA-1`）
> 执行方案依据：`10-ga-plan.md` §4
> 结论一句话：**GA-1 完成：59/59 品种全历史回填入库（runId=ga-1-full-history），178,310 根 bar，2005-01-04..2026-08-28；0 失败、0 未来日期、per-bar source/asOf 盖章、幂等验证通过、452 根换月跳变 bar 留档（F5）。**

---

## 1. 执行摘要

| 项 | 结果 |
|---|---|
| 驱动 | `strategies/research/v2/falsification/ga1-driver.cjs`（本轮新建；复用 `collector/parallel-collector.cjs` + `collector/futures_collector.py --days -1`） |
| 数据源 | akshare `futures_main_sina`（sina 主力连续，SR-01；契约唯一主路径） |
| 品种覆盖 | **59/59**（config/symbols.json active 全量） |
| 批次结果 | 12/12 批次成功，0 重试，0 失败 |
| 总耗时 | **144.4s**（采集 ~50s + 入库/导出 ~90s；远低于预估 1.5–3.5h——sina 限流未触发，59 请求 < 80 req/h 预算） |
| 入库 bar 数 | **178,310**（barsChanged），data-store `--verify`: ok=true, 0 errors, 0 warnings |
| 日期范围 | **2005-01-04 .. 2026-08-28** |
| 深度 | 最浅 SH0 713 bars（2023-09-15 上市）；最深 M0 5270 bars（2005-01-04）；**与 t4 实测锚一致**：RB0 2009-03-27/4232（t4: 4231+新交易日）、I0 2013-10-18/3128、TA0 2006-12-19/4785、M0 2005-01-04/5270 |
| 未来日期 | 守卫丢弃 **0** 根（全部 bar ≤ 执行日 2026-08-28） |
| 失败品种 | **无** |
| 幂等性 | `--resume` 复跑：0 品种待取，0 文件改写（no-op）；入库合并按日期去重（data-store `mergeContractBars`），重复运行不产生重复 bar |
| 换月跳变（F5） | **452 根** `|r_t|≥9.5%` 疑似换月/异常跳变 bar 留档 `data/ga1-roll-jumps.json`（最多：EC0 70、JD0 34、A0 33、FU0 31；阈值 0.095） |

## 2. 与验收标准逐项对照（10-ga-plan.md §4）

| # | 验收标准 | 结果 | 证据 |
|---|---|---|---|
| 1 | historical-cache.json + cache-meta.json 存在，succeeded=59 | ✅ | `research/backtest/data/historical-cache.json`（meta.succeeded=59）+ `cache-meta.json` |
| 2 | 每品种深度达源深度，无品种停留 61 bars | ✅ | 59/59 全历史（713–5270 bars）；61-bar 存量全部被全量替换/扩充 |
| 3 | 无未来日期 | ✅ | 守卫丢弃 0 根；data/daily 末 bar 全部 ≤ 2026-08-28 |
| 4 | ga1-roll-jumps.json 产出且非空 | ✅ | 452 根（总 bar 占比 0.25%，量级合理：主力连续换月日占比约 1–2 次/年/品种 + 极端行情） |
| 5 | data/daily 镜像更新 + export 日期覆盖 2005+ | ✅ | data/daily 59 文件 lastRunId=ga-1-full-history；`data/export/historical-cache.json` 重建（data-store export） |
| 6 | PIT 元数据 + per-bar sources | ✅ | 每品种 `fetchedAt`=执行时刻；`contract.ohlcv.sources[]` 长度=bar 数、全为 `akshare_sina_dayline`；`lastBarSource/lastBarAsOf` 盖章（抽验 RB0: 4232 bars / 4232 sources / lastBarAsOf=2026-08-28）；OI/settle 全历史非空（抽验 6 品种 100%） |

**验收结论：6/6 通过，GA-1 完成。**

## 3. 执行过程记录

1. **P0 预检**：akshare futures_main_sina 探活 OK（RB0 4232 行，2009-03-27..2026-08-28，0.6s）。
2. **驱动实现**：`ga1-driver.cjs` —— 59 active 品种 → ParallelCollector(workers=2, batchSize=5, days=-1, maxRetries=3) → 逐 bar 未来日期守卫 → per-bar source 盖章 → `dataStore.ingestRunBars(runId='ga-1-full-history')` → export → roll-jumps 计算 → 状态文件（支持 `--resume` / `--rebuild-from-store`）。
3. **主运行**：12 批次全部成功（每批 ~4–5s），0 重试；入库 barsChanged=178,310；ledger 按品种/月追加（如 RB0 210 个月度 jsonl，全量 59 品种留痕）。
4. **问题与修复（已闭环）**：
   - 驱动脚本 SKILL_ROOT 相对路径层级错误（3 层→4 层）→ 修复后重跑成功；
   - `--resume` 空跑曾覆盖历史缓存文件 → 修复为：空跑 no-op 不写文件、部分补采与既有 cache 合并、新增 `--rebuild-from-store`（不联网从 data/daily 权威库重建全部输出）；重建后 roll-jumps 恢复 452 根。
5. **幂等复验**：`--resume` 复跑 → "skipping 59 already-succeeded symbols… No files rewritten"；`--rebuild-from-store` → symbols=59 bars=178310（与 --verify 一致）。

## 4. 数据质量检查（data-store --verify / --stats）

- `node data-store/index.cjs --verify` → `{ok: true, errors: [], warnings: [], files: 59, bars: 178310}`。
- 每品种 bar 数与日期区间按上市时间分布合理（2005 起的老品种 5264–5270 bars，2022-2023 上市新品种 713–892 bars）。
- 无 NaN/缺失抽查：open/high/low/close/volume/OI/settle 序列长度一致；OI 全历史非空（t4 关注点已满足）。

## 5. 与下游的接口

- **walk-forward 回测数据源**：`research/backtest/data/historical-cache.json`（59 品种全量）与 `data/daily/*.json`（data-store 权威）；`data/export/historical-cache.json` 为回测兼容导出。
- **F5 换月剔除**：`strategies/research/v2/falsification/data/ga1-roll-jumps.json`（bySymbol → [{date, ret, close, prevClose}]），回测引擎按 `|r|≥9.5%` 剔除换月日 bar。
- **ledger 审计**：`data/ledger/<SYM>/<YYYY-MM>.jsonl` 记录每根新增/替换 bar（runId=ga-1-full-history、source、reason、fetchedAt）——满足 asOf/PIT 审计要求。
- **GA-2/GA-3 前置已就绪**：全品种全历史日线在位，可执行 GA-2 派生批量与 GA-3 板块重建。

## 6. 失败回退与风险复核

- sina 限流未触发（59 请求一次通过）；若后续增量更新触发限流，驱动内置批次重试（maxRetries=3 + 4s 冷却）与 `--resume` 断点续跑。
- 无品种失败，无需执行计划中的逐合约回退路径。
- 未来日期守卫 0 丢弃，符合预期（源端最新 bar = 执行日 2026-08-28）。

## 7. 交付物

| 文件 | 说明 |
|---|---|
| `strategies/research/v2/falsification/11-ga1-full-history.md` | 本报告 |
| `strategies/research/v2/falsification/ga1-driver.cjs` | GA-1 驱动（新建，可复用/续跑） |
| `strategies/research/v2/falsification/data/ga1-roll-jumps.json` | F5 换月跳变留档（452 根） |
| `strategies/research/v2/falsification/data/ga1-run.log` | 运行日志 |
| `research/backtest/data/historical-cache.json` + `cache-meta.json` + `ga1-state.json` | 回测数据缓存与状态（新建） |
| `data/daily/*.json`（59）+ `data/ledger/**` + `data/export/historical-cache.json` | data-store 入库产物（更新） |

> 本报告为数据前置执行记录，不构成投资建议。
