# data/ — futures-radar 数据文件库

本目录是 SKILL 内的轻量文件库。**不是数据库**，不使用 SQL；所有数据以 JSON / JSONL
文件按固定规则存放，由 `data-store/index.cjs` 读写和维护。

> 权威口径不变：每次运行的 `runs/<runId>/raw.json`、`macro-snapshot.json`、
> `evidence-packets.json` 仍是该次运行的冻结产物。本目录是跨 run 的可维护数据层。

## 目录规则

| 路径 | 内容 | 写入方 | 主要读取方 |
|---|---|---|---|
| `daily/<SYMBOL>.json` | 每个品种当前最优日线序列 | collect 后 `dataStore.ingestRunBars` | 增量采集、回测切片 |
| `daily/_index.json` | 品种/末 bar/更新时间索引 | data-store 自动维护 | 增量采集、维护 |
| `ledger/<SYMBOL>/<YYYY-MM>.jsonl` | append-only 入账流水 | `ingestRunBars` | 校验、重建、审计 |
| `ledger/_manifest.json` | ledger 文件清单 | data-store 自动维护 | 维护 |
| `contract-bars/<CONTRACT>.json` | 主导合约 bars（按 run 保留） | freeze-packets 后 `ingestContractBars` | probability 回退、回测 |
| `macro/<RUN_ID>.json` | 宏观快照（与 run 快照同构） | macro-probe 后 `ingestMacro` | report 回退、后续回测 |
| `runs/` | 每次运行的冻结产物 | pipeline | 报告、分析 |
| `export/historical-cache.json` | 回测兼容导出（可重建） | `exportHistoricalCache` | 回测验证器 |

## 日常读写规则

1. 采集阶段写完 `runs/<runId>/raw.json` 后调用 `dataStore.ingestRunBars`。
2. 同品种同日期按来源优先级合并：`akshare_sina_dayline` > `sina_close_snapshot`；
   同来源时 `fetchedAt` 更新者覆盖。
3. 所有变更追加到 `ledger/<SYMBOL>/<YYYY-MM>.jsonl`；ledger 只追加、不修改。
4. 文件写入先写 `.tmp` 再 rename，避免读到半截文件。
5. data-store 写入失败不阻断管道（raw.json 仍是权威）。

## 维护命令

```bash
npm run store:init      # 初始化目录与索引
npm run store:seed      # 从已有 runs 和旧历史缓存回填
npm run store:verify    # 日期/长度/数值/ledger 合法性校验
npm run store:stats     # 覆盖度、行数、文件大小统计
npm run store:export    # 重新生成 export/historical-cache.json
npm run store:compact   # 从 ledger 重建 daily，并压缩 12 个月前的 ledger
```

## 数据字典

`daily/<SYMBOL>.json` 外层：

```json
{
  "schema": "futures-radar-daily/1",
  "symbol": "RB0",
  "updatedAt": "ISO",
  "lastRunId": "runId",
  "contract": { /* 与 raw.json contracts[SYMBOL] 同构，但不含 derived */ }
}
```

`contract.ohlcv.sources` 与 `dates` 等长，逐 bar 记录来源：

- `akshare_sina_dayline`：sina 日线接口
- `sina_close_snapshot`：收盘快照补入的当日 bar
