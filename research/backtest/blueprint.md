# Backtest Blueprint — 回测方法论

> Stage: Backtest Module | Type: Methodology | Version: 0.1.0

## 核心问题

**回测的本质**：用历史数据模拟"如果我在时间点T做出预测，T+K时刻验证是否准确"

**关键挑战**：
1. 避免**未来函数**（look-ahead bias）— 时间点T的预测不能使用T之后的数据
2. 确保**数据一致性** — 回测用的数据格式/逻辑与实盘完全一致
3. 提供**可操作反馈** — 回测结果能指导参数调优，而非仅展示准确率

---

## 回测流程（5步）

### Step 1: 全量历史采集（一次性）

**目标**：构建离线历史数据缓存，支持任意时间点回溯

**执行**：
```bash
node research/backtest/full-history-collector.cjs
```

**输出**：
- `research/backtest/data/historical-cache.json` — 全量OHLCV数据（2019-01至今）
- `research/backtest/data/cache-meta.json` — 元信息（采集时间、覆盖范围、品种数）

**技术细节**：
- 复用主管道 `collector/parallel-collector.cjs` 多线程采集架构
- Python修改：`futures_collector.py` 支持 `days=-1` 表示全量
- 数据结构与主管道 `raw.json` 完全一致（保证逻辑兼容）

**时间成本**：
- 首次采集：~2分钟（59品种 × 平均2000条/品种）
- 后续更新：~30秒（仅补齐最新数据）

---

### Step 2: 时间轴采样

**目标**：在历史时间轴上选择N个验证点，覆盖不同市场环境

**三种模式**：

#### 2.1 Uniform（均匀采样）

**用途**：均匀覆盖整个时间区间，快速验证

**算法**：
```javascript
const allDays = getTradingDays(startDate, endDate); // 1800个交易日
const step = Math.floor(allDays.length / sampleCount); // 1800/30 = 60
const samples = allDays.filter((d, i) => i % step === 0).slice(0, sampleCount);
// 结果: [2019-01-02, 2019-03-15, 2019-05-28, ..., 2026-07-15]
```

**优点**：覆盖均衡，适合首次验证  
**缺点**：固定间隔可能错过关键事件

#### 2.2 Random（随机采样）

**用途**：避免周期性偏差，提高统计显著性

**算法**：
```javascript
const allDays = getTradingDays(startDate, endDate);
const shuffled = shuffleArray(allDays); // Fisher-Yates洗牌
const samples = shuffled.slice(0, sampleCount);
// 结果: [2020-05-12, 2019-08-03, 2021-11-25, ..., 2024-02-07] (随机分布)
```

**优点**：无周期性偏差，统计robust  
**缺点**：不可复现（需固定随机种子）

#### 2.3 Monthly（月度采样）

**用途**：长期趋势验证，评估不同年份/市场环境表现

**算法**：
```javascript
const allDays = getTradingDays(startDate, endDate);
const samples = allDays.filter((d, i, arr) => {
  if (i === 0) return true;
  const prevMonth = new Date(arr[i-1]).getMonth();
  const currMonth = new Date(d).getMonth();
  return currMonth !== prevMonth; // 每月首个交易日
});
// 结果: [2019-01-02, 2019-02-01, ..., 2026-07-01] (~90个点)
```

**优点**：覆盖所有月份，便于按时间分析  
**缺点**：样本量固定（约7年×12月=84个点）

---

### Step 3: 窗口切片 + 轻量分析

**目标**：对每个时间点T，切片60天窗口数据，运行Stage 2-4，提取核心判断

**3.1 窗口切片**（cache-slicer.cjs）

```javascript
function sliceWindow(symbol, asOfDate, windowDays = 60) {
  const cache = loadCache(); // 读取historical-cache.json
  const contract = cache.contracts[symbol];
  const dates = contract.ohlcv.dates;
  
  // 找到T点索引
  const asOfIdx = dates.findIndex(d => d === asOfDate);
  if (asOfIdx === -1) throw new Error(`Date ${asOfDate} not found`);
  
  // 向前切60天（包含T点）
  const startIdx = Math.max(0, asOfIdx - windowDays + 1);
  
  return {
    symbol,
    ohlcv: {
      dates: dates.slice(startIdx, asOfIdx + 1),
      open: contract.ohlcv.open.slice(startIdx, asOfIdx + 1),
      high: contract.ohlcv.high.slice(startIdx, asOfIdx + 1),
      low: contract.ohlcv.low.slice(startIdx, asOfIdx + 1),
      close: contract.ohlcv.close.slice(startIdx, asOfIdx + 1),
      volume: contract.ohlcv.volume.slice(startIdx, asOfIdx + 1),
      openInterest: contract.ohlcv.openInterest.slice(startIdx, asOfIdx + 1)
    }
  };
}
```

**防止未来函数**：
- ✅ 只切片 `[T-60, T]` 窗口，严格不包含T之后数据
- ✅ 缓存中T+1到T+K的数据存在，但切片时不读取

**3.2 轻量分析管道**（mini-pipeline.cjs）

```
输入: 60天窗口数据（从缓存切片）
  ↓
Stage 2: scanner/index.cjs → candidates.json (Top 10)
  ↓
Stage 3: filter/filter-llm.cjs → filtered.json (≤3 KEEP)
  ↓
Stage 4: analyze/analyze.cjs → analysis.json (6问框架)
  ↓
[跳过 Stage 5 报告生成]
  ↓
提取核心判断 → backtest-prediction.json
```

**提取字段**（backtest-prediction.json）：
```json
{
  "runId": "bt-20260701",
  "asOfDate": "2026-07-01",
  "predictions": [
    {
      "symbol": "SC0",
      "name": "原油",
      "direction": "bearish",       // 从 analysis.direction
      "confidence": "high",          // 从 analysis.confidence
      "close": 568.2,                // T点收盘价
      "hvCone3d": {
        "p68": [547.2, 590.0],
        "p95": [527.8, 611.7]
      },
      "hvCone5d": {
        "p68": [541.3, 596.5],
        "p95": [516.6, 625.0]
      },
      "confirmSignal": "SC0跌破560且成交量≥20万手",  // 从 Q4
      "invalidation": "SC0 3日内回到580以上"        // 从 Q5
    }
  ]
}
```

**时间成本**：
- Stage 2-4 轻量执行：~15秒/次（vs 完整管道30秒）
- 跳过Stage 1采集（从缓存读取，0网络请求）
- 跳过Stage 5报告生成（省90% token）

---

### Step 4: 快速验证

**目标**：读取T+K的真实数据，验证预测是否准确

**方向收益主口径：T+1 open 入场，T+11 close 出场**（与 shared-backtest-lib HOLD_DAYS=10 一致）：
- 入场价 = T+1 开盘价（T 日收盘决策，次日开盘执行）
- 出场价 = T+11 收盘价
- 方向命中 = 实际涨跌方向与预测方向一致
- 价格区间覆盖率 = T+11 收盘价是否落在 HV 概率锥内

**4.1 从缓存读取验证窗口**（quick-verifier.py）

```python
def verify_prediction(symbol, as_of_date, cache):
    """
    从缓存读取T之后真实价格：T+1 open 入场，T+11 close 出场
    """
    contract = cache['contracts'][symbol]
    dates = contract['ohlcv']['dates']
    opens = contract['ohlcv']['open']
    closes = contract['ohlcv']['close']
    
    # 找到T点
    t_idx = dates.index(as_of_date)
    t_close = closes[t_idx]
    
    # T+1 open 入场 / T+11 close 出场
    entry_idx = t_idx + 1
    exit_idx = t_idx + 11
    if exit_idx >= len(dates):
        return None  # 验证窗口超出缓存范围
    
    entry_date = dates[entry_idx]
    entry_price = opens[entry_idx]
    exit_date = dates[exit_idx]
    exit_price = closes[exit_idx]
    
    return {
        "symbol": symbol,
        "t_date": as_of_date,
        "t_close": t_close,
        "entry_date": entry_date,
        "entry_price": entry_price,
        "exit_date": exit_date,
        "exit_price": exit_price,
        "change_pct": (exit_price - entry_price) / entry_price * 100,
        "price_path": closes[t_idx:exit_idx+1]  # T到T+11的价格轨迹
    }
```

**4.2 计算验证指标**

**指标1: 方向准确性**（方向收益主口径）
```javascript
function checkDirection(prediction, verification) {
  // T+1 open 入场 → T+11 close 出场
  const actualUp = verification.exit_price > verification.entry_price;
  const predictUp = prediction.direction === 'bullish';
  return actualUp === predictUp;
}
```

**指标2: 价格区间覆盖**
```javascript
function checkCoverage(prediction, verification, days) {
  const cone = prediction[`hvCone${days}d`];
  const actualPrice = verification.exit_price;
  
  const in68 = actualPrice >= cone.p68[0] && actualPrice <= cone.p68[1];
  const in95 = actualPrice >= cone.p95[0] && actualPrice <= cone.p95[1];
  
  return { in68, in95 };
}
```

**输出**（verification.json）：
```json
{
  "asOfDate": "2026-07-01",
  "entryDate": "2026-07-02",
  "exitDate": "2026-07-16",
  "results": [
    {
      "symbol": "SC0",
      "prediction": { "direction": "bearish", "confidence": "high", "close": 568.2 },
      "actual": { "entry": 566.5, "exit": 548.7, "change": -3.15 },
      "correct": {
        "direction": true,
        "cone68": false,
        "cone95": true
      }
    }
  ]
}
```

---

### Step 5: 汇总统计

**目标**：批量回测完成后，聚合所有验证结果，计算整体指标

**5.1 增量日志写入**（边跑边写）

每完成1次回测，立即追加到 `backtest-log.jsonl`：
```jsonl
{"asOfDate":"2026-07-01","predictions":[...],"verifications":[...]}
{"asOfDate":"2026-06-15","predictions":[...],"verifications":[...]}
{"asOfDate":"2026-05-20","predictions":[...],"verifications":[...]}
```

**好处**：
- 中断不丢失（已完成的回测已写入）
- 可流式分析（不需要等全部完成）

**5.2 汇总计算**（aggregator.cjs）

读取 `backtest-log.jsonl`，计算统计指标：

```javascript
function calculateSummary(logLines) {
  let totalPredictions = 0;
  let directionCorrect = 0;
  let cone68Hit = 0;
  let cone95Hit = 0;
  
  const byConfidence = {
    high: { total: 0, correct: 0 },
    medium: { total: 0, correct: 0 },
    low: { total: 0, correct: 0 }
  };
  
  for (const line of logLines) {
    for (let i = 0; i < line.predictions.length; i++) {
      const pred = line.predictions[i];
      const verify = line.verifications[i];
      
      if (!verify) continue;  // 验证窗口不足
      
      totalPredictions++;
      
      // 方向准确率
      if (verify.correct.direction) {
        directionCorrect++;
        byConfidence[pred.confidence].correct++;
      }
      byConfidence[pred.confidence].total++;
      
      // 价格区间覆盖率
      if (verify.correct.cone68) cone68Hit++;
      if (verify.correct.cone95) cone95Hit++;
    }
  }
  
  return {
    meta: {
      totalRuns: logLines.length,
      totalPredictions,
      startDate: logLines[0].asOfDate,
      endDate: logLines[logLines.length - 1].asOfDate
    },
    overall: {
      directionAccuracy: directionCorrect / totalPredictions,
      cone68Coverage: cone68Hit / totalPredictions,
      cone95Coverage: cone95Hit / totalPredictions
    },
    byConfidence: {
      high: {
        accuracy: byConfidence.high.correct / byConfidence.high.total,
        count: byConfidence.high.total
      },
      medium: {
        accuracy: byConfidence.medium.correct / byConfidence.medium.total,
        count: byConfidence.medium.total
      },
      low: {
        accuracy: byConfidence.low.correct / byConfidence.low.total,
        count: byConfidence.low.total
      }
    }
  };
}
```

**输出**（backtest-summary.json）：
```json
{
  "meta": {
    "totalRuns": 50,
    "totalPredictions": 147,
    "startDate": "2019-01-15",
    "endDate": "2026-07-25"
  },
  "overall": {
    "directionAccuracy": 0.639,
    "cone68Coverage": 0.708,
    "cone95Coverage": 0.958
  },
  "byConfidence": {
    "high": { "accuracy": 0.750, "count": 35 },
    "medium": { "accuracy": 0.619, "count": 72 },
    "low": { "accuracy": 0.517, "count": 40 }
  }
}
```

---

## 调优反馈循环

### 场景1: 方向准确率过低（<60%）

**诊断**：
1. 查看 `byConfidence` 分层 → 哪个置信度拖后腿？
2. 回溯失败案例 → 读取对应 `bt-YYYYMMDD/analysis.json`
3. 分析共性 → 驱动判断失误？趋势识别失误？

**调优方向**：
- 提高筛选门槛：`scanner/index.cjs` score阈值从0.6 → 0.7
- 增强驱动验证：`filter/blueprint.md` 要求更强证据链
- 调整置信度规则：`filter/filter-llm.cjs` 重新校准high/medium边界

### 场景2: 价格区间覆盖率偏离理论值

**诊断**：
- `cone95Coverage < 0.90` → HV低估了波动性（区间太窄）
- `cone95Coverage > 0.98` → HV高估了波动性（区间太宽）

**调优方向**：
- 调整HV窗口：`probability/stage-4-5.cjs` window从20d → 30d
- 调整置信区间：z-score从1.96σ（95%）→ 1.8σ（93%）
- 检查数据质量：`degraded=true` 的品种是否拖累整体

### 场景3: 置信度不分层（high≈medium≈low）

**诊断**：
- 查看 `byConfidence` → high/medium准确率差异 < 5%
- 说明置信度评分规则失效，无法区分高低质量预测

**调优方向**：
- 重新定义置信度标准：`filter/blueprint.md`
  - High: 驱动明确 + 板块共振 + 历史规律
  - Medium: 驱动明确，但缺乏板块确认
  - Low: 驱动模糊 或 板块分化严重
- 检查LLM判断一致性：同一案例多次跑是否给出不同置信度

---

## Anti-Patterns（禁止）

### 1. 未来函数（Look-Ahead Bias）

❌ **错误示例**：
```javascript
// 在T点预测时，使用了T+1的数据计算ATR
const atr = calculateATR(prices.slice(0, t_idx + 2)); // BUG: 包含T+1
```

✅ **正确做法**：
```javascript
// 严格只用T及之前的数据
const atr = calculateATR(prices.slice(0, t_idx + 1)); // OK: 仅到T点
```

### 2. 数据不一致

❌ **错误示例**：
```javascript
// 回测时用不同的扫描逻辑（与实盘不一致）
const candidates = scanWithDifferentLogic(windowData);
```

✅ **正确做法**：
```javascript
// 完全复用主管道的scanner
const candidates = require('../scanner/index.cjs').scan(windowData);
```

### 3. 过度拟合历史

❌ **错误示例**：
```javascript
// 根据回测结果反复调参，直到准确率>80%
for (let threshold = 0.5; threshold < 1.0; threshold += 0.01) {
  const accuracy = backtest(threshold);
  if (accuracy > 0.8) break;  // BUG: 过拟合
}
```

✅ **正确做法**：
```javascript
// 基于逻辑调整参数，回测仅作验证
// 调参 → 回测验证 → 如果改进则保留，否则回滚
```

### 4. 忽略样本量

❌ **错误示例**：
```javascript
// 仅10次回测就下结论
const summary = backtest(10); // 样本量不足
console.log(`准确率${summary.accuracy}，可以上线了`);
```

✅ **正确做法**：
```javascript
// 至少30次回测，且检查置信区间
const summary = backtest(50);
const ci95 = calculateCI(summary.accuracy, 50); // [0.58, 0.72]
console.log(`准确率${summary.accuracy} (95% CI: ${ci95})`);
```

---

## 版本演进计划

### v0.1.0（当前）
- ✅ 全量历史缓存
- ✅ 时间轴采样（uniform/random/monthly）
- ✅ 方向准确率 + 价格区间覆盖率验证
- ✅ 置信度分层统计

### v0.2.0（计划）
- ⚠️ 确认信号/失效条件触发率统计
- ⚠️ 按板块分组统计（黑色系 vs 能化 vs 农产品）
- ⚠️ 按年份分组统计（2019 vs 2020 vs ... vs 2026）
- ⚠️ 可视化dashboard（Vega-Lite图表）

### v0.3.0（探索）
- ➖ 滚动窗口回测（每日滑动，样本量×30）
- ➖ 蒙特卡洛置信区间（bootstrap重采样）
- ➖ 对比基准策略（随机猜测 / 趋势跟随）

---

## 参考资料

- **Walk-Forward Analysis**: Pardo, R. (2008). *The Evaluation and Optimization of Trading Strategies*
- **Bias Prevention**: Bailey, D. et al. (2014). *The Probability of Backtest Overfitting*
- **Statistical Validation**: White, H. (2000). *A Reality Check for Data Snooping*
