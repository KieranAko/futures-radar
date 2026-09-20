# 26 GA-8 FS-02 PIT 基差历史采集器 —— 使用与状态

> 目的：解除 FS-02 的数据前置阻塞（specs/FS-02.json blocked：缺 2011+ PIT 基差历史）。
> 原则：按周切片拉取（全量年份调用实测 >120s 超时）；PIT 留档（fetchedAt）；口径 `br=(S−F)/S=−dom_basis_rate`（源端 dom_basis_rate=(F−S)/S，2026-08-27 RB0 实测验证）。

## 1. 命令

```bash
cd futures-radar
# 初始化（universe = ga6-tradable-set 42 品种）
python strategies/research/v2/falsification/ga8-basis-history-collector.py init

# 单周拉取+合并
python strategies/research/v2/falsification/ga8-basis-history-collector.py fetch-week --start 20210201 --end 20210207 --merge

# 可断点续跑的回填（chunk 按 universe 记录，子集回填不会锁死全集回填）
python strategies/research/v2/falsification/ga8-basis-history-collector.py backfill \
  --from 2014-01-01 --to 2026-08-27 \
  --symbols RB,M,RM,CU,AL,ZN,NI,SN,PB,AG,AU

# 校验（排序/重复/br=-dom_basis_rate 一致性）
python strategies/research/v2/falsification/ga8-basis-history-collector.py verify --strict

# 查看
python strategies/research/v2/falsification/ga8-basis-history-collector.py inspect --symbol RB
```

## 2. 产出格式（`falsification/data/basis-history/`）

| 文件 | 说明 |
|------|------|
| `manifest.json` | universe、口径声明、PIT 纪律、completedChunks（含 universe 指纹）、revisionCount |
| `<SRC_SYMBOL>.jsonl` | 每行一个交易日：`symbol`（源，如 RB）、`libSymbol`（库口径，如 RB0）、spot/dom/near 价格与基差、`br`、`nearBr`、`asOf` |
| `fetches/<start>_<end>.json` | 原始周切片证据（含 fetchedAt、varsList、全部行） |
| `revisions.jsonl` | 同 (symbol,date) 重取不一致的修订事件 |
| `summary.json` | verify 后覆盖与质量汇总 |

- 库内读取：`harness-lib/basis.cjs`（`loadBasisHistory('RB0')`，带 br 取反与升序校验）。
- 历史接口返回的是"查询日可见"序列（现货修订风险 0.03–0.33）：正式口径启用前必须叠加 GA-6 现货粘性质量门（ga6-tradable-set.json，42/12）。

## 3. 冒烟测试证据（2026-08-28）

- 周切片 `20210201..20210207`：185 行 / 37 品种；`verify --strict` 通过。
- RB0 样例：2021-02-01 `dom_basis_rate=-0.0103165` → `br=+0.0103165`（现货升水期货 1.03%，口径正确）。
- 发现并修复两类实现问题后才固化：`symbol/合约` 字符串列误走数值转换（导致 symbol=null）；早于 dual 门控的单锚对照逻辑错误。

## 4. 回填运行状态

- 范围：FS-02 spec 11 品种（RB,M,RM,CU,AL,ZN,NI,SN,PB,AG,AU）× 2014-01-01..2026-08-27（满足 spec 2015-01-01 起点 + 200 bars 预热）。
- 速率实测 ~4.3s/周切片；预计 ~660 切片。
- 完成后动作：`verify --strict` → 提交 manifest/summary → 实现 FS-02 基差序列适配器（180 日滚动 μ̂/σ̂、z 分位、加速走扩门）→ 按 23/24 协议执行 FS-02 证伪（仅当 F-A..F-H 通过）。

## 5. 边界声明

- 本采集器只建数据，不产生任何策略结论；FS-02 仍为 `designed/untested` 直到保真复跑完成。
- 不构成投资建议。
