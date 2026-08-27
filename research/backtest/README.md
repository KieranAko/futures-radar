# futures-radar/backtest — 回测模块

## 定位

回测模块是 futures-radar skill 的**独立子系统**，用于验证主管道预测准确率，为报告置信度调优提供数据支撑。

**与主管道关系**：
- 主管道（pipeline/）→ 日常分析报告
- 回测模块（research/backtest/）→ 历史验证 + 置信度校准

**两种回测对象**：
- **deterministic 回测**：规则模型（scanner / hard-filter / 机会层）历史批量验证
- **LLM replay 回测**：对冻结 evidence packets 离线回放推理，产出透明评分卡（见下文「LLM Replay」）

**数据流向**：
```
backtest/ 回测结果
    ↓
分析统计（方向准确率、价格区间覆盖率）
    ↓
反馈到主管道参数调优（筛选阈值、置信度评分规则）
```

---

## LLM Replay

对冻结 evidence packets 离线回放 LLM 推理（Analyze 阶段的四臂/FinCoT），产出透明评分卡，评估分析层模型表现。

**与 deterministic 回测的区别**：
- deterministic 回测验证机会层命中率（机械规则批量验证）
- LLM replay 验证分析层方向判断质量（离线回放推理）
- **机会命中率不等于方向优势**：机会层命中（方向中性候选命中）≠ 方向预测正确，两者分别统计，不得混用口径

**入口**：`mini-pipeline.cjs` 的 `runMiniPipeline(asOfDate, windowData, options)`，由 `options.reasoningMode` 控制：

| providerMode | 行为 |
|-------------|------|
| `off`（默认） | 不执行 replay，旧行为零影响 |
| `mock` | 合成 provider，仅测试链路 |
| `recorded` | 回放已录制 LLM 输出（可复现） |
| `live-model` | 显式注入接口；日常运行不调用真实模型 |

**输出**（每个 run 目录）：
- `reasoning-replay.jsonl` — 每行一条推理记录（packetHash、scoringStatus、outcome）
- `llm-scorecard.json` — 评分卡汇总：coverage、方向命中（directional.n/correct/accuracy）、净收益均值（returns）、excluded 分层（non_point_in_time / packet_ineligible / parse_failed / grounding_failed / entry_unavailable / outcome_immature）

**有效性纪律**：
- 仅 `point_in_time.eligible=true` 的冻结包进入有效性统计；`non_point_in_time` 在 provider 调用前即被排除
- **历史 cache 无 point-in-time 元数据时不得进入 LLM 有效性统计**：无冻结包的 replay 全部标记 non_point_in_time，仅作工程诊断（diagnostic 模式）
- 方向收益主口径：T+1 open 入场 → T+11 close 出场（HOLD_DAYS=10）

---

## 架构

### 模块结构

```
backtest/
├── README.md                      # 本文档
├── blueprint.md                   # 回测方法论 + 流程规范
├── full-history-collector.cjs     # 全量历史数据采集器
├── cache-manager.cjs              # 缓存管理（更新/验证/清理）
├── time-sampler.cjs               # 时间轴采样器（uniform/random/monthly）
├── cache-slicer.cjs               # 缓存窗口切片器
├── mini-pipeline.cjs              # 轻量分析管道（Stage 2-4）
├── quick-verifier.py              # 快速验证器（Python）
├── batch-runner.cjs               # 批量回测执行器
├── aggregator.cjs                 # 结果汇总统计
├── data/
│   ├── historical-cache.json      # 全量历史数据缓存（~18MB）
│   ├── cache-meta.json            # 缓存元信息
│   ├── backtest-log.jsonl         # 回测增量日志
│   └── backtest-summary.json      # 汇总统计报告
└── runs/                           # 临时生成目录（不入库，按需重建）
    └── bt-20260701/               # 单次回测运行目录
    │   ├── window-data.json       # 切片的60天窗口数据
    │   ├── candidates.json        # Stage 2输出
    │   ├── filtered.json          # Stage 3输出
    │   ├── analysis.json          # Stage 4输出
    │   └── verification.json      # 验证结果
    └── ...
```

### 执行流程

#### Phase 1: 初始化（一次性）

```bash
# 1. 全量采集历史数据（首次运行，~2分钟）
node research/backtest/full-history-collector.cjs

# 输出：
# - research/backtest/data/historical-cache.json（~18MB，覆盖2019-01至今）
# - research/backtest/data/cache-meta.json（元信息）
```

#### Phase 2: 批量回测

```bash
# 2. 批量回测（随机采样50个时间点）
node research/backtest/batch-runner.cjs \
  --start 2019-01-01 \
  --end 2026-07-31 \
  --sample-count 50 \
  --sample-mode random \
  --verify-days 3

# 输出：
# - research/backtest/data/backtest-log.jsonl（增量日志，每完成1次追加1行）
# - research/backtest/data/backtest-summary.json（汇总统计）
```

#### Phase 3: 结果分析

```bash
# 3. 查看汇总报告
cat research/backtest/data/backtest-summary.json

# 输出示例：
# {
#   "overall": {
#     "directionAccuracy": 0.639,
#     "cone68Coverage": 0.708,
#     "cone95Coverage": 0.958
#   },
#   "byConfidence": {
#     "high": { "accuracy": 0.750, "count": 18 },
#     "medium": { "accuracy": 0.619, "count": 32 }
#   }
# }
```

---

## 验证指标

### 1. 方向准确率（核心）

**定义**：预测方向（bearish/bullish）与T+3实际涨跌是否一致

**分层统计**：
- High confidence 准确率（目标 ≥70%）
- Medium confidence 准确率（目标 ≥60%）
- Low confidence 准确率（目标 ≥50%）

### 2. 价格区间覆盖率

**定义**：T+3实际价格是否落在HV概率锥区间内

**理论校准**：
- 68%区间应覆盖约68%的实际价格
- 95%区间应覆盖约95%的实际价格

**偏差分析**：
- 覆盖率 < 理论值 → HV低估波动性
- 覆盖率 > 理论值 → HV高估波动性

### 3. 置信度校准

**目标**：High/Medium/Low置信度的实际准确率应显著分层

**不合格信号**：
- High准确率 ≤ Medium准确率 → 置信度评分规则失效
- Low准确率 < 50% → 筛选质量过低

---

## 数据纪律

### 数据隔离边界（Critical）

**回测与报告的数据源完全独立**：

```
报告生成路径（实时）：
  collector/akshare-futures.cjs (days=60)
  → 实时API抓取最新60天
  → runs/<runId>/raw.json (source: 'akshare-live')
  → 报告使用当前市场数据

回测验证路径（离线）：
  research/backtest/data/historical-cache.json (7-12年全历史)
  → cache-slicer 切片指定时间点60天窗口
  → runs/bt-<date>/raw.json (source: 'cache-slice', backtest: true)
  → 回测使用历史快照模拟
```

**隔离原则**：
- ✅ 报告**永远不读**回测缓存（保证实时性）
- ✅ 回测**永远不调用**实时API（保证可重现性 + 零网络请求）
- ✅ 两条路径生成的 `raw.json` 通过 `source` 字段标记来源
- ⚠️  **严禁交叉污染**：报告读缓存 = 用过时数据推理（危险）

### 缓存管理（v0.1.4 起由 data-store 接管）

**缓存更新策略**：
- 日常采集已经自动镜像到 `data/daily/`，回测切片直接从文件库读取
- 首次迁移：`npm run store:seed`（从已有 runs 回填）
- 全量历史：`node research/backtest/full-history-collector.cjs`（采集后同时入文件库）

**缓存验证/维护**：
```bash
npm run store:verify     # 校验文件库
npm run store:stats      # 覆盖度/大小
npm run store:export     # 重建回测兼容缓存
npm run store:compact    # 从 ledger 重建 daily
```

### 时间轴采样

**三种模式**：

| 模式 | 用途 | 采样规则 |
|-----|------|---------|
| `uniform` | 均匀覆盖 | 每隔N天固定1个点 |
| `random` | 统计显著性 | 随机分布（避免周期性偏差） |
| `monthly` | 长期趋势 | 每月第1个交易日 |

**推荐策略**：
- 快速验证（20次）→ uniform
- 正式回测（50次）→ random
- 长期评估（90次）→ monthly

---

## 与主管道集成

### 输入依赖

回测模块**复用**主管道的以下组件：
- `config/symbols.json` — 品种白名单
- `scanner/index.cjs` — Stage 2 扫描逻辑
- `filter/filter-llm.cjs` — Stage 3 筛选逻辑
- `analyze/analyze.cjs` — Stage 4 分析逻辑
- `probability/stage-4-5.cjs` — Stage 4.5 概率估算

回测模块**不依赖**：
- `collector/akshare-futures.cjs` — 改用缓存切片
- `report/` — 不生成报告，直接提取判断

### 输出反馈

**调优方向**：

1. **方向准确率 < 60%** → 调整筛选标准
   - 提高 score 门槛（当前Top 10 → Top 8）
   - 增强驱动验证强度（filter/blueprint.md）

2. **HV区间覆盖率偏离** → 调整波动率参数
   - 覆盖率过低 → 增加HV window（20d → 30d）
   - 覆盖率过高 → 减小置信区间（1.96σ → 1.8σ）

3. **置信度不分层** → 重新校准评分规则
   - 检查 filter/filter-llm.cjs 置信度判断逻辑
   - 分析高/中/低置信的驱动差异

---

## Iron Boundaries

| 维度 | 允许 | 禁止 |
|------|------|------|
| 数据范围 | 缓存内2019-01至今的历史数据 | 2019之前数据（数据源不支持）|
| 采样密度 | ≤100个时间点（token限制） | >100次（需拆批） |
| 验证窗口 | 3天或5天（符合报告预测周期） | >5天（超出报告时效性） |
| 结果存储 | JSONL增量日志 + JSON汇总 | 生成完整markdown报告（浪费） |
| 主管道修改 | 根据回测结果调优参数 | 直接修改Stage 1-4核心逻辑（需review）|

---

## 使用场景

### 场景1：首次验证

**目标**：确认当前管道预测准确率基线

```bash
node research/backtest/batch-runner.cjs \
  --start 2024-01-01 \
  --end 2026-07-31 \
  --sample-count 30 \
  --sample-mode uniform \
  --verify-days 3
```

**预期输出**：方向准确率、置信度分层、价格区间覆盖率

### 场景2：参数调优

**目标**：调整筛选阈值后验证改进效果

```bash
# 1. 修改 filter/blueprint.md 筛选标准
# 2. 重新运行回测
node research/backtest/batch-runner.cjs \
  --start 2024-01-01 \
  --end 2026-07-31 \
  --sample-count 50 \
  --sample-mode random \
  --verify-days 3

# 3. 对比前后准确率变化
node research/backtest/compare.cjs \
  --baseline backtest-summary-v1.json \
  --current backtest-summary-v2.json
```

### 场景3：长期趋势

**目标**：评估管道在不同市场环境下的表现

```bash
node research/backtest/batch-runner.cjs \
  --start 2019-01-01 \
  --end 2026-07-31 \
  --sample-mode monthly \
  --verify-days 5
```

**预期输出**：按年份/板块分组的准确率统计

---

## 版本

- **Version**: 0.1.0（与主管道版本同步）
- **Last Updated**: 2026-08-05
