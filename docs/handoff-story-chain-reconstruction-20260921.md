# 交接文档：故事链重构任务（2026-09-21）

> 用途：在新对话中继续处理"螺纹钢/燃料油传导链重构"。本文档自包含，不需要依赖旧对话上下文。
> 生成时间：2026-09-21（runId `20260921-1514-auto`）

## 1. 任务背景

- 项目：futures-radar（期货雷达）。代码根目录即本文件所在仓库。
- 本期信号日：**2026-09-21**，已跑完整条管道：分析 → 交易单（entryZone）→ 计划 → 信号池 → 看板。
- 当前两个品种信号质量均为真实成立（已纠正早前误判）：
  - **RB0 空单**：前收 3096 → 今日盘中反抽（高 3120，进入偏离带）→ 收 3117，落在计划区间 3106–3119 内。按"盘中触达偏离带 + 收盘不破位"判定，**成立**。
  - **FU0 空单**：触发价 4350 + 偏离 100 → 反抽带 [4250, 4350]；今日高 4333 进入带内，收 4213 回到带下方。**成立**。

## 2. 已完成的修复（不要重做）

- `cf712c7`：交易员显式给出入场执行区间 `entryZone`，图表/验证直接消费。
- `2c3c179`：反抽/回踩验证语义修正——**盘中触达偏离带 + 收盘不破位**即成立，不再要求盘中最高点精确 ≤ 触发价。
- `1d47fd3`：故事链蓝图与提示词清除所有具体因果链示例（SC0/FU0/PG0/DR007/黑色/原油等），全部改为占位骨架。
- `06cfc75`：看板图表优先使用本期 main-series，修复图表停在历史 contract-bars 日期。
- 全量测试：**857 通过 / 0 失败**。

## 3. 本次复盘的核心结论

1. **RB 和 FU 的信号质量好是真实行为，不是验证口径假象**（旧对话早期误判过，已纠正）。
2. **FU 的质量来自有效的成本传导**：SC0 5日 −20.14% → 能化板块 5日 −2.39% → FU 5日 −4.08%，链路逐级兑现。
3. **RB 的质量来自有效的结构/资金流行为**：3119 是 09-17 前低，价格反抽到 3120 后收盘回 3117；黑色 OI 5日 −1.91% 也确实流出。但**旧故事链把它归因到"DR007 上行收紧流动性"是错的**：今天 DR007 5日 **−1.41%（转松）**，方向相反。
4. **旧链的因果错误在构建期**：
   - 边 `DR007↑ → 黑色OI↓` 机制不成立（短期资金利率不能直接推出持仓变化）；
   - 蓝图/提示词里预置了具体示例链，LLM 照抄注册（三条旧链与三份示例一一对应）；
   - 注册校验只查形态（DAG、指标目录、±1、时滞、proofIndex），不查边机制真伪。
5. **"太巧"的解释**：不是巧合。RB 卡位是前低结构行为 + 资金流，FU 是成本传导；两者独立成立，只是旧系统把 RB 错挂到一条假流动性链上。

## 4. 关键数据（供新对话直接使用）

### 宏观（macro-snapshot 2026-09-21）
- DR007：1.40，5日 **−1.41%**，fresh
- SC0：722.5，5日 **−20.14%**，fresh
- DXY：100.3163，5日 +0.85%
- USDCNH：6.6944（09-18），5日 −0.19%
- US10Y：5.01（09-18），5日 +1.01%

### 板块（sector-snapshot）
- black：1日 +0.69%，5日 **−0.39%**，20日 −1.70%，广度 77.8%
- energy_chemical：1日 +0.41%，5日 **−2.39%**
- nonferrous：1日 +0.23%，5日 +1.88%

### 品种日线（09-21）
- RB0：open 3096 / high **3120** / low 3094 / close **3117**；OI 5日 −1.03%
- FU0：open 4267 / high **4333** / low 4112 / close **4213**；OI 5日 −14.76%
- CU0：open 109840 / high 110230 / low 109620 / close 110180
- PG0：open 6651 / high 6692 / low 6455 / close 6542

### RB 近端结构来源
- 09-17 low = **3119**（这就是触发价的来源）
- 今日 valueArea ≈ [3119, 3120]
- 计划：空 RB2701，触发 3119，入场区间 [3106, 3119]，止损 3132，目标 3065/3034

### 旧链现状（data/story-pool/stories/）
- `CH-BLACK-20260918-04`：pending；n1 DR007 预期 +1，今日实际 −0.71（oppStreak 1/2）；n2 黑色 OI 预期 −1，今日实际 −1.91（但窗口未开）；n3 RB 预期 −1，今日实际 +0.71。**链条待证伪，但信号池 RB 仍 active/armed。**
- `CH-ENERGY-20260918-03`：n1 SC0 已 confirmed；n2 能化 OI 观察反向；n5 能化指数观察同向。FU 方向兑现。
- `CH-NONFER-20260918-02`：USDCNH 升值逻辑，待观察。

## 5. 待决策与执行任务（新对话从这里开始）

### 决策点：螺纹钢旧链作废后，注册哪条新链？

**候选 A：继续看空（T2 需求证据链）**

```json
{
  "schema": "futures-radar-story-chain/3",
  "chainId": "CH-BLACK-20260921-02",
  "createdAt": "2026-09-21",
  "sourceId": "concept: 螺纹钢表观需求或建材成交走弱",
  "theme": "黑色需求退潮",
  "themeDetail": "钢材需求边际走弱，黑色持仓流出，螺纹等待跌破 MA20",
  "replace": true,
  "nodes": [
    { "id": "n1", "concept": "螺纹钢表观需求或建材成交走弱", "dataPlan": { "paths": ["T2"], "baseline": "周度表需/建材成交同比", "unit": "%", "maxFreshDays": 7 }, "expectation": -1, "label": "终端需求走弱" },
    { "id": "n2", "indicatorId": "sector.black.oi.flow5d", "expectation": -1, "label": "黑色持仓净流出" },
    { "id": "n3", "indicatorId": "symbol.RB0.price.vs_ma20", "expectation": -1, "label": "螺纹跌破 MA20", "terminal": true, "priority": "primary", "impactRationale": "螺纹是黑色需求最敏感品种，需求走弱先反映在失守 MA20", "proofIndex": 2 }
  ],
  "edges": [
    { "id": "e1", "from": "n1", "to": "n2", "latencyDays": 5, "logic": "终端需求走弱带动贸易商降库与投机盘减仓，板块持仓净流出" },
    { "id": "e2", "from": "n2", "to": "n3", "latencyDays": 5, "logic": "持仓流出与现货疲弱压低定价中枢，螺纹收盘跌破 MA20" }
  ],
  "maxLifespanTradingDays": 20
}
```

**候选 B：跟随真实宏观转多观察（T0 全链路）**

```json
{
  "schema": "futures-radar-story-chain/3",
  "chainId": "CH-BLACK-20260921-01",
  "createdAt": "2026-09-21",
  "sourceId": "macro.DR007.change5d",
  "theme": "黑色流动性回补",
  "themeDetail": "DR007 转松降低融资成本，黑色板块止跌回升，螺纹等待站回 MA20",
  "replace": true,
  "nodes": [
    { "id": "n1", "indicatorId": "macro.DR007.change5d", "expectation": -1, "label": "流动性转松" },
    { "id": "n2", "indicatorId": "sector.black.index.ret5d", "expectation": 1, "label": "黑色板块止跌回升" },
    { "id": "n3", "indicatorId": "symbol.RB0.price.vs_ma20", "expectation": 1, "label": "螺纹站回 MA20", "terminal": true, "priority": "primary", "impactRationale": "螺纹对融资成本与终端回款预期最敏感，站回 MA20 确认反转", "proofIndex": 2 }
  ],
  "edges": [
    { "id": "e1", "from": "n1", "to": "n2", "latencyDays": 5, "logic": "短期资金利率下行降低贸易商融资成本并改善终端回款预期，黑色现货成交回暖，板块指数转正" },
    { "id": "e2", "from": "n2", "to": "n3", "latencyDays": 5, "logic": "板块回暖后资金重新定价对资金面最敏感的螺纹，收盘站回 MA20" }
  ],
  "maxLifespanTradingDays": 20
}
```

**燃料油新链（推荐直接注册，replace 旧能化链）**

```json
{
  "schema": "futures-radar-story-chain/3",
  "chainId": "CH-ENERGY-20260921-01",
  "createdAt": "2026-09-21",
  "sourceId": "macro.SC0.change5d",
  "theme": "原油坍塌的能化传导",
  "themeDetail": "SC0 五交易日大跌压低能化成本与定价预期，燃料油补跌尚未走完",
  "replace": true,
  "nodes": [
    { "id": "n1", "indicatorId": "macro.SC0.change5d", "expectation": -1, "label": "原油成本坍塌" },
    { "id": "n2", "indicatorId": "sector.energy_chemical.index.ret5d", "expectation": -1, "label": "能化板块跟跌" },
    { "id": "n3", "indicatorId": "symbol.FU0.price.ret5d", "expectation": -1, "label": "燃料油补跌", "terminal": true, "priority": "primary", "impactRationale": "燃料油与原油成本联动最直接，且前期跌幅滞后于成本端，存在补跌空间", "proofIndex": 2 }
  ],
  "edges": [
    { "id": "e1", "from": "n1", "to": "n2", "latencyDays": 3, "logic": "原油成本坍塌直接压低能化产业链成本与价格预期，板块指数五交易日收益转负" },
    { "id": "e2", "from": "n2", "to": "n3", "latencyDays": 5, "logic": "板块定价中枢下移后，成本联动最直接的燃料油补跌" }
  ],
  "maxLifespanTradingDays": 20
}
```

### 执行步骤建议

1. 确认 RB 选 A 还是 B（推荐：若继续持有空头逻辑则 A；若跟随真实宏观则 B）。
2. 把选定链写入 JSON 文件（例如 `output/runs/20260921-1514-auto/story-chains.json` 或任意临时路径）。
3. 注册：
   - `node stories/cli/story-chain-cli.cjs register --file <chain.json> --supersede`
   - 候选 A 注册后是 resolving，需 `resolve --brief` 生成 T2 检索任务，等研究结果回来再 `resolve --file`。
4. 旧链 `CH-BLACK-20260918-04` 作废/等 observe 自动证伪（连续 2 个反向数据日会 falsified；今天已是第 1 个反向日）。
5. 重新 observe：`node stories/cli/story-chain-cli.cjs observe --runId 20260921-1514-auto`
6. 重跑 filtered / 渲染，检查故事池看板。
7. 全量测试 `npm test`，提交推送。

## 6. 关键文件路径

- 故事链数据：`data/story-pool/stories/CH-*.json`、`data/story-pool/ledger.json`、`data/story-pool/view.json`
- 蓝图：`stories/blueprint.md`（已去示例）
- 提示词构建器：`stories/lib/story-chain-prompt.cjs`（已去示例）
- 指标目录：`stories/config/story-chain-indicators.json`
- 注册/观测 CLI：`stories/cli/story-chain-cli.cjs`
- 宏观路由表（仅注意力提示，禁止当因果引用）：`config/macro-transmission.json`
- 信号池信号文件：`data/signal-pool/signals/SIG-RB0-20260918-01.json`、`SIG-FU0-20260918-01.json`
- 本期报告/看板：`output/runs/20260921-1514-auto/report.md`、`output/dashboard.html`
- 权威错位审计与修复记录：`docs/authority-mismatch-audit.md`

## 7. 给新对话的原则备忘

- 提示词/蓝图只允许：身份切换 + 冻结事实 + 问题与契约形状；**不允许任何具体因果链示例**。
- 每条边注册前必须回答"上一环通过什么路径触发下一环"，机制不成立就拒收。
- 引擎验形态，LLM 验机制；不要让脚本用 if-else 判因果。
- RB 旧链的教训：**把"相关"写成"因果"是故事池最大的风险**。
