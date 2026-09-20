# 12 GA-4/GA-5 宏观历史回填与 USDCNH change5d 修复报告

> 角色：data-engineer-2（宏观/质量门/验证）· 执行日期：2026-08-28
> 任务范围：GA-4 宏观锚点历史回填（US10Y/DR007 序列完整化）+ GA-5 USDCNH change5d 计算口径修复
> 依据：`10-ga-plan.md` §7/§8、`08-final-data-audit.md` F2、`config/macro-indicators.json` 契约
> 一句话结论：**GA-4/GA-5 全部验收通过（机检 11/11 + 单测 74/74）；US10Y 回填至 1990-12-19（8928 行）、DR007 回填至 2015-01-04（2906 行，FDR007/FR007 拼接留档）；USDCNH change5d 从裸 null 修复为有限值（主通道与快照回退双路径）。无 no-source，无伪造。M1/G1 的 GA-4/GA-5 前置解除。**

---

## 1. P0 环境预检（2026-08-28 实测）

| 项 | 结果 |
|---|---|
| Node / Python | v24.15.0 / 3.14.4 ✓ |
| akshare / pandas / requests | 1.18.81 / 3.0.3 / 2.34.2 ✓（与契约一致） |
| `akshare.bond_zh_us_rate()` | 9330 行（1990-12-19..2026-08-27），「美国国债收益率10年」非空 8928 行 ✓ |
| `akshare.repo_rate_hist` 按年分批 | 2015..2026 共 12 批全部成功；FR007 2015-01-04 起、FDR007 2017-05-31 起（与契约锚一致）✓ |
| 单窗 ≤1 年纪律 | 按年窗口（≤366 天）无 KeyError ✓ |

---

## 2. GA-4 宏观锚点历史回填

### 2.1 执行内容

- **工具**：新建 `strategies/research/v2/falsification/ga4-macro-backfill.py`（fetch/verify/write 三模式，可复跑）。
- **US10Y**：`akshare bond_zh_us_rate` 一次全量，取「美国国债收益率10年」列，**8928 行（1990-12-19..2026-08-27）**（原 144 行 2026-02+）。
- **DR007**：`akshare repo_rate_hist` 按年分批 12 次（2015..2026），FR007/FDR007 双列抓取后拼接：**FR007 2015-01-04..2017-05-27（代理段）+ FDR007 2017-05-31..2026-08-27（主口径段），共 2906 行**（原 132 行 2026-02+）。
- **PIT 纪律**：全部拉取携带 `fetchedAt`；同日盘中 fixing 行剔除（2026 batch 的 08-28 行未入 recording）；原始抓取证据落 `falsification/data/ga4-fetch-us10y.json` + `ga4-fetch-dr007.json`。
- **写回**：`strategies/signal-backtest/recordings/v4/macro-history.json` 与 `v5/macro-history.json` 同步扩展（v4 为 context-assembler 消费方，一并更新保持一致性）；`fetchedAt` 更新为回填时刻、原值保留于 `originalFetchedAt`；新增顶层 `backfill` 块 + 每指标 `asOf`/`source`/`status` 标注；DR007 另含 `segments` 分段标注。
- **DXY/USDCNH 序列完整化核查**：DXY 10552 行（1985-11-08+）、USDCNH 3078 行（2014-11-07+），日期严格升序、尾 bar 至 2026-08-27/08-26，无缺口，未改动，仅补 asOf/source/status 标注。

### 2.2 拼接纪律（契约内定）

- 拼接点 `2017-05-31`（FDR007 首个交易日，2017 实测确认）。
- **±20 交易日剔除窗口**：2017-05-02..2017-06-27（40 个交易日）留档于 `strategies/research/v2/falsification/data/ga4-splice-notes.json`；walk-forward 只用 FDR007 段，FR007 段仅用于 2015–2017 粗标定。
- 边界说明：源数据在 2017-05-29/05-30 缺行（chinamoney 历史缺口，2 个交易日），位于剔除窗口内，不影响 FDR007 段可用性。

### 2.3 验收矩阵（全部机检，`python ga4-macro-backfill.py verify`）

| # | 验收项 | 结果 | 证据 |
|---|---|---|---|
| 1 | US10Y ≥6000 行且最早 ≤2002-06 | **pass** | 8928 行，1990-12-19 |
| 2 | DR007 最早 ≤2015-01 且 2017-05-31 起 FDR007 口径 | **pass** | 2015-01-04；segment start=2017-05-31 |
| 3 | 无未来日期 | **pass** | 两序列尾 bar 2026-08-27 ≤ 执行日 |
| 4 | 拼接点留档文件存在 | **pass** | `data/ga4-splice-notes.json`（40 个剔除日期） |
| 5 | 与旧 144/132 行尾部对拍一致 | **pass** | max_abs_diff=0，mismatched=0/0 |
| 6 | 各序列 asOf/source/status 标注 | **pass** | 四指标 + `backfill` 块 |
| 7 | 序列严格升序 | **pass** | 8928/2906 行逐一校验 |
| 8 | v5 bundle 确定性重建不破坏 | **pass** | `node --test test/signal-backtest-v5.test.js` 14/14 |

---

## 3. GA-5 USDCNH change5d 缺失修复

### 3.1 根因（实测确认）

最新快照 `data/macro/20260827-2159-auto.json`：USDCNH 走 sina 实时快照兜底通道（日线通道失败后启用），该通道只返回 1 根当日 bar → `computeChange5d` 因窗口不足 6 根返回 **裸 null**（同时 status=fresh）。M5/G1 的 USDCNH 条件（`change5d < 0`）因此失真（`strategy-matcher.cjs` riskScores 中 null 被错误计入 riskOff）。

### 3.2 修复（`collector/macro-probe.cjs`）

- 新增 `computeChange5dFromHistory(historySeries, asOfDate, vt)`：主序列窗口不足 6 根时回退到宏历史序列（recordings/v5 同指标 series）计算 `change5d = (v_asOf / v_{asOf 前第 5 个交易日} - 1) × 100`。
  - 锚定规则：asOf 恰为历史末日 → 基准 = 末日 idx−5；asOf 晚于历史末日（当日快照 bar）→ asOf 视为末日 +1 个交易日，基准 = 末日 idx−4。
- `buildIndicatorFromSeries` 增加 `opts.historySeriesFor`：回退成功 → 有限 change5d + `change5dSource='macro-history'` + `change5dNote`；回退亦不可得 → **显式降级**：`change5dStatus='unavailable'` + `degradedReason` + status 降 stale（F2 降权路径），**不再输出裸 null**。
- `runMacroProbe` 接入真实历史加载器 `loadMacroHistoryIndicators()`（读 recordings/v5，读失败不阻断），支持测试注入。
- 配套更新：`config/macro-indicators.json` `change5dRule` 写入回退/降级口径；`collector/akshare-macro.cjs` 快照通道 note 同步更新（change5d 不再声明"不可用"）。

### 3.3 验收矩阵

| # | 验收项 | 结果 | 证据 |
|---|---|---|---|
| 1 | 新快照 USDCNH.change5d 为有限数值 | **pass** | 实时重放 `ga5-replay-20260828`：6.7185 asOf 2026-08-27，**5d −0.08%**（5 锚点 available=5/missing=0）；离线等价重放（1 根 bar 快照通道 + 真实历史回退）：**−0.08%，change5dSource=macro-history** |
| 2 | 单测含"窗口不足"分支 | **pass** | `node --test collector/macro-probe.test.js collector/akshare-macro.test.js collector/macro-snapshot.test.js` 74/74（新增 computeChange5dFromHistory 5 例 + buildIndicatorFromSeries GA-5 3 例 + runMacroProbe 端到端 1 例） |
| 3 | M5/G1 五锚点评估不再因 null 计 0 | **pass** | USDCNH change5d 有限 → `riskScores` 的 `v < 0` 判定恢复正常语义（−0.08 < 0 → riskOn） |

- 重放方式：新建 `output/runs/ga5-replay-20260828`（复制 20260827-2159-auto 的 raw.json，不覆写历史快照）跑 `node collector/macro-probe.cjs --runId ga5-replay-20260828`；data/macro 索引同步新增条目。
- 全量回归：`npm test` 中 3 个失败项位于 `research/experiments/test/forward-recorder.test.js`（register/commit-date 边界，依赖实验夹具日期），与本次改动零依赖（改动文件不含 research/experiments），为**既有日期敏感失败**，非本任务引入。

---

## 4. 变更文件清单

| 文件 | 变更 |
|---|---|
| `strategies/signal-backtest/recordings/v5/macro-history.json` | US10Y→8928 行、DR007→2906 行（FDR007/FR007 拼接）、asOf/source/status/backfill 标注 |
| `strategies/signal-backtest/recordings/v4/macro-history.json` | 同上（与 v5 对齐） |
| `collector/macro-probe.cjs` | computeChange5dFromHistory + 回退/显式降级 + 历史加载器 |
| `collector/macro-probe.test.js` | 新增 9 个 GA-5 测试 |
| `collector/akshare-macro.cjs` | 快照通道 note 更新 |
| `config/macro-indicators.json` | change5dRule 写入回退/降级口径 |
| `strategies/research/v2/falsification/ga4-macro-backfill.py` | 新增（fetch/verify/write） |
| `strategies/research/v2/falsification/data/ga4-fetch-us10y.json` | 新增（PIT 抓取证据） |
| `strategies/research/v2/falsification/data/ga4-fetch-dr007.json` | 新增（PIT 抓取证据，12 批） |
| `strategies/research/v2/falsification/data/ga4-splice-notes.json` | 新增（拼接留档，±20 日剔除窗口） |
| `strategies/research/v2/falsification/data/ga4-backfill-summary.json` | 新增（回填摘要） |
| `output/runs/ga5-replay-20260828/macro-snapshot.json` | 新增（GA-5 验证重放快照） |

## 5. 下游影响与边界

- **M1/G1 前置解除**：US10Y/DR007 历史至 2002-/2015-，USDCNH change5d 有限 → GA-4/GA-5 验收通过，M1/G1 可进入 in_validation 流程（G0 门禁由 GA-9 集成验证统一复核）。
- **walk-forward 消费纪律**（供 t6/量化研究员使用）：DR007 只用 FDR007 段（2017-05-31+）；FR007 代理段仅 2015–2017 粗标定；2017-05-02..2017-06-27 为剔除窗口；US10Y 1990-12-19 起全深可用。
- **边界**：DR007 源在 2017-05-29/05-30 有 2 日缺口（在剔除窗口内）；US10Y 同日行按 bond_zh_us_rate 源惯例不含当日盘中值；DXY/USDCNH 序列未改（已深，仅标注）。
- 未使用任何回退源（FRED/chinamoney 官网），主源全部可用，无 no-source。

> 本报告为数据前置执行记录，不构成投资建议。
