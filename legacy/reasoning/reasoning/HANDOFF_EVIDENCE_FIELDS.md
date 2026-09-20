# Evidence Fields Extension — 实施方案

**交接对象**: @阿比西尼亚猫 (远远)  
**预计工时**: 1-1.5 工作日  
**优先级**: P1（准确率提升关键路径）

---

## What（做什么）

为 FinCoT Phase 1 推理链添加 3 个新 evidence 字段组，提升方向预测准确率：

1. **term_structure**（期限结构）— 近远月价差和形态
2. **inventory**（库存）— 库存水平和周变化趋势
3. **supply_demand_event**（供需事件）— 维修/停产等事件

同时在 FinCoT prompt 中添加 2 条推理门禁，避免单域过拟合。

---

## Why（为什么）

### 背景
- Direction V2 terminated：50.94% accuracy (n=6013)，与随机持平
- 根因：OHLCV + volume/OI 技术指标信息域单一
- FinCoT Phase 1 已完成（72/72 tests passing），但从未用真实 LLM 验证

### 核心问题
现有两字段（price_data, volume_oi）属于同一信息域（价格技术），容易导致：
- 单域过拟合（如 Direction V2 的 regime 过拟合）
- 缺乏基本面交叉验证
- 无法识别供需结构性变化

### 解决思路
添加三个**正交信息域**：
- 期限结构：跨期套利信号
- 库存：供需平衡状态
- 供需事件：结构性驱动因素

通过推理门禁强制 LLM 引用 ≥2 个独立域，避免单域依赖。

---

## Tradeoff（技术权衡）

### 选择：Optional fields（不影响 executable）
**理由**：
- 这三个字段不是每个合约每天都有（尤其 supply_demand_event）
- 如果标记为 required，会大幅降低可执行 packet 数量
- 作为 optional 时，有数据就用，没数据就标记 abstain

**代价**：
- 需要在 FinCoT prompt 中显式处理 gap: "missing" 情况
- branch_status 必须记录每个分支的可用性

### 选择：只改 Top 3 深挖阶段，不改全市场扫描
**理由**：
- 全市场扫描已经通过 Opportunity 层筛选（~62% accuracy）
- Top 3 是真正需要方向判断的阶段
- 避免增加数据采集复杂度

**代价**：
- 无法在 scanner 阶段使用这三个字段
- 但 scanner 本身已经足够（只需要识别波动机会）

---

## 实施清单

### Step 1: 扩展 raw-adapter.js（3-4h）

**文件**: `reasoning/lib/raw-adapter.js`

#### 1.1 添加 extractTermStructure 函数

```javascript
/**
 * 提取期限结构字段
 * @param {object} rawData - 完整 raw.json 数据
 * @param {string} symbol - 主力合约代码（如 RB0）
 * @param {string} signalDate - 信号日期
 * @param {string} sourceFetchedAt - 源抓取时间
 * @returns {object} term_structure 字段或 { gap: "missing" }
 */
function extractTermStructure(rawData, symbol, signalDate, sourceFetchedAt) {
  // 从 symbol 推断品种（如 RB0 → RB）
  const commodity = symbol.replace(/\d+$/, '');
  
  // 查找近月和远月合约
  // 假设 rawData.contracts 包含多个合约（如 RB2501, RB2505）
  const contracts = Object.keys(rawData.contracts || {})
    .filter(c => c.startsWith(commodity))
    .sort(); // 按合约代码排序
  
  if (contracts.length < 2) {
    return {
      source: 'akshare',
      asOf: `${signalDate}T15:00:00+08:00`,
      fetchedAt: sourceFetchedAt,
      gap: 'missing'
    };
  }
  
  // 取前两个合约作为近月和远月
  const nearContract = contracts[0];
  const farContract = contracts[1];
  
  const nearData = rawData.contracts[nearContract];
  const farData = rawData.contracts[farContract];
  
  // 在 signalDate 的收盘价
  const nearIndex = nearData.ohlcv.dates.indexOf(signalDate);
  const farIndex = farData.ohlcv.dates.indexOf(signalDate);
  
  if (nearIndex === -1 || farIndex === -1) {
    return {
      source: 'akshare',
      asOf: `${signalDate}T15:00:00+08:00`,
      fetchedAt: sourceFetchedAt,
      gap: 'missing'
    };
  }
  
  const nearPrice = nearData.ohlcv.close[nearIndex];
  const farPrice = farData.ohlcv.close[farIndex];
  const spreadPct = ((farPrice - nearPrice) / nearPrice) * 100;
  const shape = spreadPct > 0 ? 'contango' : 'backwardation';
  
  // 计算 5 日价差变化（如果有足够历史数据）
  let change5d = null;
  if (nearIndex >= 5 && farIndex >= 5) {
    const nearPrice5d = nearData.ohlcv.close[nearIndex - 5];
    const farPrice5d = farData.ohlcv.close[farIndex - 5];
    const spreadPct5d = ((farPrice5d - nearPrice5d) / nearPrice5d) * 100;
    change5d = spreadPct - spreadPct5d;
  }
  
  return {
    source: 'akshare',
    asOf: `${signalDate}T15:00:00+08:00`,
    fetchedAt: sourceFetchedAt,
    near_contract: nearContract,
    far_contract: farContract,
    near_price: nearPrice,
    far_price: farPrice,
    spread_pct: parseFloat(spreadPct.toFixed(2)),
    shape,
    change_5d: change5d ? parseFloat(change5d.toFixed(2)) : null,
    freshness: 'same_day',
    gap: null
  };
}
```

#### 1.2 添加 extractInventory 函数

```javascript
/**
 * 提取库存字段
 * @param {object} rawData - 完整 raw.json 数据
 * @param {string} symbol - 合约代码
 * @param {string} signalDate - 信号日期
 * @returns {object} inventory 字段或 { gap: "missing" }
 */
function extractInventory(rawData, symbol, signalDate) {
  // 假设 rawData.inventory[symbol] 包含库存时间序列
  // 结构：{ dates: [], values: [], unit: "万吨" }
  const inventoryData = rawData.inventory?.[symbol];
  
  if (!inventoryData || !inventoryData.dates || !inventoryData.values) {
    return {
      source: 'mx-data',
      asOf: `${signalDate}T18:00:00+08:00`,
      fetchedAt: rawData.meta?.fetchedAt || `${signalDate}T20:00:00+08:00`,
      _published_at: `${signalDate}T08:30:00+08:00`,
      gap: 'missing'
    };
  }
  
  // 找到最接近 signalDate 的库存数据（库存通常周频）
  const signalTs = new Date(signalDate).getTime();
  let closestIndex = -1;
  let minDiff = Infinity;
  
  for (let i = 0; i < inventoryData.dates.length; i++) {
    const ts = new Date(inventoryData.dates[i]).getTime();
    const diff = Math.abs(ts - signalTs);
    if (diff < minDiff) {
      minDiff = diff;
      closestIndex = i;
    }
  }
  
  if (closestIndex === -1 || minDiff > 7 * 24 * 60 * 60 * 1000) {
    // 最近数据超过 7 天，视为缺失
    return {
      source: 'mx-data',
      asOf: `${signalDate}T18:00:00+08:00`,
      fetchedAt: rawData.meta?.fetchedAt || `${signalDate}T20:00:00+08:00`,
      _published_at: `${signalDate}T08:30:00+08:00`,
      gap: 'missing'
    };
  }
  
  const value = inventoryData.values[closestIndex];
  const asOf = inventoryData.dates[closestIndex];
  
  // 计算周变化（如果有上周数据）
  let weeklyChangePct = null;
  if (closestIndex >= 1) {
    const prevValue = inventoryData.values[closestIndex - 1];
    weeklyChangePct = ((value - prevValue) / prevValue) * 100;
  }
  
  // 计算 3 周趋势
  let trend3w = null;
  if (closestIndex >= 2) {
    const values3w = inventoryData.values.slice(closestIndex - 2, closestIndex + 1);
    const isAccumulating = values3w[2] > values3w[1] && values3w[1] > values3w[0];
    const isDepleting = values3w[2] < values3w[1] && values3w[1] < values3w[0];
    trend3w = isAccumulating ? 'accumulating' : isDepleting ? 'depleting' : 'stable';
  }
  
  // 计算 freshness
  const daysDiff = Math.floor(minDiff / (24 * 60 * 60 * 1000));
  const freshness = daysDiff === 0 ? 'same_day' : daysDiff <= 3 ? '3d' : '7d';
  
  return {
    source: 'mx-data',
    asOf: `${asOf}T18:00:00+08:00`,
    fetchedAt: rawData.meta?.fetchedAt || `${signalDate}T20:00:00+08:00`,
    _published_at: `${asOf}T08:30:00+08:00`,
    value,
    unit: inventoryData.unit || '万吨',
    weekly_change_pct: weeklyChangePct ? parseFloat(weeklyChangePct.toFixed(2)) : null,
    trend_3w: trend3w,
    percentile: null, // 暂不计算百分位
    freshness,
    gap: null
  };
}
```

#### 1.3 添加 extractSupplyDemandEvent 函数

```javascript
/**
 * 提取供需事件字段
 * @param {object} rawData - 完整 raw.json 数据
 * @param {string} symbol - 合约代码
 * @param {string} signalDate - 信号日期
 * @returns {object} supply_demand_event 字段或 { gap: "missing" }
 */
function extractSupplyDemandEvent(rawData, symbol, signalDate) {
  // 假设 rawData.events[symbol] 包含事件列表
  // 结构：[{ type, direction, effective_from, expected_until, status, published_at }]
  const events = rawData.events?.[symbol];
  
  if (!events || events.length === 0) {
    return {
      source: 'news-scan',
      asOf: `${signalDate}T12:00:00+08:00`,
      fetchedAt: rawData.meta?.fetchedAt || `${signalDate}T13:00:00+08:00`,
      _published_at: `${signalDate}T10:00:00+08:00`,
      gap: 'missing'
    };
  }
  
  // 筛选在有效期内的事件
  const signalTs = new Date(signalDate).getTime();
  const activeEvents = events.filter(e => {
    const effectiveFrom = new Date(e.effective_from).getTime();
    const expectedUntil = new Date(e.expected_until).getTime();
    return effectiveFrom <= signalTs && signalTs <= expectedUntil;
  });
  
  if (activeEvents.length === 0) {
    return {
      source: 'news-scan',
      asOf: `${signalDate}T12:00:00+08:00`,
      fetchedAt: rawData.meta?.fetchedAt || `${signalDate}T13:00:00+08:00`,
      _published_at: `${signalDate}T10:00:00+08:00`,
      type: 'none',
      direction: 'neutral',
      freshness: 'same_day',
      gap: null
    };
  }
  
  // 取最近的一个事件
  const event = activeEvents.sort((a, b) => 
    new Date(b.published_at) - new Date(a.published_at)
  )[0];
  
  return {
    source: 'news-scan',
    asOf: `${signalDate}T12:00:00+08:00`,
    fetchedAt: rawData.meta?.fetchedAt || `${signalDate}T13:00:00+08:00`,
    _published_at: event.published_at,
    type: event.type,
    direction: event.direction,
    effective_from: event.effective_from,
    expected_until: event.expected_until,
    status: event.status,
    freshness: 'same_day',
    gap: null
  };
}
```

#### 1.4 修改 buildPacketFromRawJson 函数

在 `buildPacketFromRawJson()` 末尾，添加三个新字段的提取：

```javascript
export function buildPacketFromRawJson(rawJsonPath, symbol, signalDate) {
  const rawData = JSON.parse(fs.readFileSync(rawJsonPath, 'utf-8'));

  if (!rawData.contracts || !rawData.contracts[symbol]) {
    throw new Error(`Symbol ${symbol} not found in raw.json`);
  }

  const contractData = rawData.contracts[symbol];
  const marketCutoffAt = `${signalDate}T15:00:00+08:00`;
  const packetFrozenAt = `${signalDate}T16:30:00+08:00`;
  const frozenCommit = rawData.meta?.runId || 'unknown';

  const fields = extractContractFields(contractData, symbol, signalDate, marketCutoffAt, packetFrozenAt);

  // 添加三个新字段
  const sourceFetchedAt = contractData.fetchedAt;
  fields.term_structure = extractTermStructure(rawData, symbol, signalDate, sourceFetchedAt);
  fields.inventory = extractInventory(rawData, symbol, signalDate);
  fields.supply_demand_event = extractSupplyDemandEvent(rawData, symbol, signalDate);

  return {
    symbol,
    signalDate,
    marketCutoffAt,
    packetFrozenAt,
    frozenCommit,
    fields
  };
}
```

**验收标准**:
- 新增 3 个函数通过 eslint
- `buildPacketFromRawJson()` 返回的 fields 包含 5 个字段（原有 2 个 + 新增 3 个）
- 当数据缺失时，正确返回 `{ gap: "missing" }` 结构

---

### Step 2: 修改 packet-builder.js（1h）

**文件**: `reasoning/lib/packet-builder.js`

#### 2.1 更新 quality_check 逻辑

在 `buildPacket()` 函数中，将三个新字段标记为 optional：

```javascript
export function buildPacket(raw) {
  // ... 现有代码 ...

  // 必填字段（不变）
  const requiredFields = ['price_data', 'volume_oi'];
  
  // 可选但高价值字段（新增）
  const optionalFields = ['term_structure', 'inventory', 'supply_demand_event'];
  
  const requiredAvailable = [];
  const optionalAvailable = [];
  const missing = [];
  
  for (const field of requiredFields) {
    if (raw.fields[field] && raw.fields[field].gap === null) {
      requiredAvailable.push(field);
    } else {
      missing.push(field);
    }
  }
  
  for (const field of optionalFields) {
    if (raw.fields[field] && raw.fields[field].gap === null) {
      optionalAvailable.push(field);
    } else {
      missing.push(field);
    }
  }
  
  // executable 只依赖 required fields（不变）
  const executable = requiredAvailable.length === requiredFields.length && 
                     validation.schema.valid && 
                     validation.timeBoundary.valid;
  
  const qualityCheck = {
    executable,
    required_available: requiredAvailable,
    optional_available: optionalAvailable,
    missing,
    max_staleness: '3d'
  };
  
  // ... 构建 packet ...
}
```

**验收标准**:
- `quality_check.optional_available` 正确记录可用的新字段
- `quality_check.missing` 正确记录缺失的新字段
- `executable` 不受新字段影响（只依赖 price_data, volume_oi）

---

### Step 3: 更新 FinCoT prompt（1h）

**文件**: `reasoning/prompts/fincot-prompt.md`

#### 3.1 更新 Macro/Fundamental 分支

将第 24-35 行修改为：

```markdown
### 分支2: Macro/Fundamental（宏观基本面，可选）
**证据来源**: term_structure OR inventory OR supply_demand_event  
**分析要点**:
- **期限结构**: 近远月价差（contango/backwardation）和变化趋势
- **库存水平**: 绝对值、周变化、三周趋势
- **供需事件**: 维修/停产/需求变化等结构性因素

**可用性判断**:
- term_structure.gap=null OR inventory.gap=null OR supply_demand_event.gap=null → available
- 否则 → abstain

**输出**: 供需平衡方向（偏紧/偏松/中性）
```

#### 3.2 添加决策门禁（在第 54 行后插入）

```markdown
## 决策门禁（必须遵守）

1. **多域独立性门禁**:
   - direction 为 long/short 时，evidence_ids 必须引用 ≥2 个独立信息域
   - 独立域定义：
     - 域1：价格技术（price_data 的 MA/趋势相关字段）
     - 域2：成交量/持仓（volume_oi）
     - 域3：期限结构（term_structure）
     - 域4：库存（inventory）
     - 域5：供需事件（supply_demand_event）
   - 单域支持 → 降级为 medium confidence 或 pass

2. **冲突解决门禁**:
   - 如果 opposing_ids 非空 → confidence 必须为 medium 或 direction 为 pass
   - 不得在存在未解决冲突时输出 high confidence

3. **分支数量检查**（原有门禁，保持不变）:
   - available分支 < 2 → 强制pass (data_insufficient)
   
4. **方向一致性检查**（原有门禁，保持不变）:
   - 2个或更多分支同向（都看多/都看空）→ 可输出long/short
   - 分支方向冲突 → 强制pass (conflict_unresolved)
```

**验收标准**:
- FinCoT prompt 包含 4 条门禁规则
- Macro/Fundamental 分支引用三个新字段
- prompt 文件通过 markdown lint

---

### Step 4: 添加测试用例（2h）

**文件**: `reasoning/test/raw-adapter.test.js`

#### 4.1 添加 term_structure 测试

在文件末尾添加：

```javascript
test('提取 term_structure 字段（有数据）', () => {
  const rawJsonPath = 'D:/clowder-ai/packages/api/data/futures-radar/runs/20260805-1027-auto/raw.json';
  const raw = buildPacketFromRawJson(rawJsonPath, 'RB0', '2026-08-04');

  const { term_structure } = raw.fields;
  assert.ok(term_structure);
  assert.strictEqual(term_structure.source, 'akshare');
  assert.ok(term_structure.near_contract);
  assert.ok(term_structure.far_contract);
  assert.strictEqual(typeof term_structure.near_price, 'number');
  assert.strictEqual(typeof term_structure.far_price, 'number');
  assert.strictEqual(typeof term_structure.spread_pct, 'number');
  assert.ok(['contango', 'backwardation'].includes(term_structure.shape));
});

test('提取 term_structure 字段（无数据）', () => {
  // 构造只有单合约的 mock raw.json
  // 期望返回 gap: "missing"
});
```

#### 4.2 添加 inventory 测试

```javascript
test('提取 inventory 字段（有数据）', () => {
  const rawJsonPath = 'D:/clowder-ai/packages/api/data/futures-radar/runs/20260805-1027-auto/raw.json';
  const raw = buildPacketFromRawJson(rawJsonPath, 'RB0', '2026-08-04');

  const { inventory } = raw.fields;
  assert.ok(inventory);
  
  if (inventory.gap === null) {
    assert.strictEqual(inventory.source, 'mx-data');
    assert.strictEqual(typeof inventory.value, 'number');
    assert.ok(inventory.unit);
    assert.ok(['accumulating', 'depleting', 'stable'].includes(inventory.trend_3w) || inventory.trend_3w === null);
  } else {
    assert.strictEqual(inventory.gap, 'missing');
  }
});
```

#### 4.3 添加 supply_demand_event 测试

```javascript
test('提取 supply_demand_event 字段', () => {
  const rawJsonPath = 'D:/clowder-ai/packages/api/data/futures-radar/runs/20260805-1027-auto/raw.json';
  const raw = buildPacketFromRawJson(rawJsonPath, 'RB0', '2026-08-04');

  const { supply_demand_event } = raw.fields;
  assert.ok(supply_demand_event);
  
  if (supply_demand_event.gap === null) {
    assert.strictEqual(supply_demand_event.source, 'news-scan');
    assert.ok(['maintenance', 'restart', 'production_cut', 'demand_change', 'none'].includes(supply_demand_event.type));
  } else {
    assert.strictEqual(supply_demand_event.gap, 'missing');
  }
});
```

**文件**: `reasoning/test/packet-builder.test.js`

#### 4.4 添加 quality_check 测试

```javascript
test('optional_available 正确记录新字段', () => {
  const raw = {
    symbol: 'RB2501',
    signalDate: '2026-08-15',
    marketCutoffAt: '2026-08-15T15:00:00+08:00',
    packetFrozenAt: '2026-08-15T16:30:00+08:00',
    frozenCommit: 'abc123',
    fields: {
      price_data: {
        source: 'akshare',
        asOf: '2026-08-15T15:00:00+08:00',
        fetchedAt: '2026-08-15T15:05:00+08:00',
        close_60d: [4000, 4100],
        ma20: 4050,
        ma60: 3980,
        freshness: 'same_day',
        gap: null
      },
      volume_oi: {
        source: 'akshare',
        asOf: '2026-08-15T15:00:00+08:00',
        fetchedAt: '2026-08-15T15:06:00+08:00',
        volume_60d: [100000, 110000],
        avgVolume5d: 105000,
        freshness: 'same_day',
        gap: null
      },
      term_structure: {
        source: 'akshare',
        asOf: '2026-08-15T15:00:00+08:00',
        fetchedAt: '2026-08-15T15:10:00+08:00',
        near_contract: 'RB2501',
        far_contract: 'RB2505',
        near_price: 1054,
        far_price: 1108,
        spread_pct: -5.13,
        shape: 'contango',
        freshness: 'same_day',
        gap: null
      },
      inventory: {
        source: 'mx-data',
        asOf: '2026-08-12T18:00:00+08:00',
        fetchedAt: '2026-08-15T15:20:00+08:00',
        _published_at: '2026-08-15T08:30:00+08:00',
        gap: 'missing'
      },
      supply_demand_event: {
        source: 'news-scan',
        asOf: '2026-08-15T12:00:00+08:00',
        fetchedAt: '2026-08-15T13:00:00+08:00',
        gap: 'missing'
      }
    }
  };

  const { packet } = buildPacket(raw);
  
  assert.strictEqual(packet.quality_check.executable, true);
  assert.ok(packet.quality_check.optional_available.includes('term_structure'));
  assert.ok(packet.quality_check.missing.includes('inventory'));
  assert.ok(packet.quality_check.missing.includes('supply_demand_event'));
});
```

**验收标准**:
- 所有新增测试通过
- 覆盖有数据和无数据两种情况
- 测试通过 `node --test` 验证

---

### Step 5: 10-15 例单臂对照（2-3h）

#### 5.1 选择测试用例

从历史 Top 3 候选中选择 10-15 个日期，要求：
- 已通过 Opportunity 层筛选（~62% accuracy）
- 有明确方向信号（避免横盘）
- 覆盖不同品种（RB, HC, I, J, 等）

**建议日期**（需要从实际 runs/ 目录中确认）：
```
20260804 RB0
20260805 HC0
20260806 I0
20260807 J0
20260808 RB0
...
（共 10-15 个）
```

#### 5.2 对照方法

对每个日期，执行：

**Before**: 使用现有两字段
```bash
# 临时修改 buildPacketFromRawJson，只返回 price_data, volume_oi
node reasoning/run-fincot.js RB0 2026-08-04 > before.json
```

**After**: 使用完整五字段
```bash
# 使用新代码
node reasoning/run-fincot.js RB0 2026-08-04 > after.json
```

#### 5.3 观察维度

对每个测试用例，记录：
1. **evidence_ids 引用域数**:
   - Before: 引用了几个独立域？
   - After: 引用了几个独立域？

2. **reasoning_summary 质量**:
   - Before: 推理链长度和深度
   - After: 是否增加了基本面论证？

3. **冲突处理**:
   - Before: 是否存在未识别的冲突？
   - After: opposing_ids 是否正确填充？

4. **direction 判断变化**:
   - Before vs After 是否改变方向？
   - 如果改变，原因是什么？

#### 5.4 输出格式

创建文件 `reasoning/test/SINGLE_ARM_COMPARISON.md`：

```markdown
# Single-Arm Before/After Comparison

## 测试用例

| Date | Symbol | Before Direction | After Direction | Evidence Domains (Before) | Evidence Domains (After) |
|------|--------|------------------|-----------------|---------------------------|--------------------------|
| 2026-08-04 | RB0 | long | long | 1 (price) | 3 (price, term_structure, inventory) |
| 2026-08-05 | HC0 | pass | long | 1 (price) | 2 (price, term_structure) |
| ... | ... | ... | ... | ... | ... |

## 定性观察

### 案例 1: 2026-08-04 RB0
**Before**:
- evidence_ids: ["price_data.ma20"]
- reasoning_summary: "价格突破MA20"
- 单域依赖

**After**:
- evidence_ids: ["price_data.ma20", "term_structure.spread_pct", "inventory.trend_3w"]
- reasoning_summary: "价格突破MA20，期限结构 contango 扩大，库存累积"
- 三域交叉验证

**结论**: 推理链更丰富，避免单域过拟合

### 案例 2: 2026-08-05 HC0
...

## 总结

- X/15 案例增加了引用域数
- X/15 案例推理链更丰富
- X/15 案例正确识别冲突
- 0 案例因新字段而误判（质量无退化）
```

**验收标准**:
- 完成 10-15 个案例的 before/after 对比
- 记录详细观察结果
- 定性判断：推理链是否更丰富？是否避免单域依赖？

---

## Open Questions（开放问题）

1. **raw.json 数据结构假设**:
   - 当前代码假设 `rawData.inventory[symbol]` 和 `rawData.events[symbol]` 存在
   - 如果实际 raw.json 结构不同，需要调整提取逻辑
   - **Action**: 在 Step 1.1 开始前，先 Read 一个真实 raw.json，确认数据结构

2. **term_structure 合约选择**:
   - 当前代码简单取前两个合约作为近月和远月
   - 可能需要更精确的月份识别（如 RB2501 vs RB2505）
   - **Action**: 如果发现合约选择不合理，可以在 Step 1.1 中调整逻辑

3. **inventory 百分位计算**:
   - 当前代码 `percentile: null`，未计算历史百分位
   - 如果需要，可以在 Step 1.2 中添加历史数据查询
   - **Decision**: 铲屎官决定是否需要此字段

4. **supply_demand_event 数据来源**:
   - 当前假设 raw.json 已经包含事件数据
   - 如果实际没有，需要设计事件抓取管道
   - **Scope**: 本次 handoff 假设数据已存在；如果不存在，标记为 Phase 2

5. **FinCoT prompt 中文 vs 英文**:
   - 当前 prompt 是中文
   - 如果 LLM 推理用英文更好，需要翻译
   - **Action**: 在 Step 3 中，如果发现 LLM 中文推理质量差，升级给宪宪

---

## Next Action（下一步）

### 远远执行顺序

1. **Read 真实 raw.json**（15min）:
   ```bash
   ls -lh data/futures-radar/runs/*/raw.json | tail -5
   node -e "console.log(JSON.stringify(require('./data/futures-radar/runs/20260805-1027-auto/raw.json'), null, 2))" | head -200
   ```
   确认 `inventory` 和 `events` 字段是否存在，结构如何。

2. **Step 1: raw-adapter.js**（3-4h）:
   - 添加三个提取函数
   - 修改 `buildPacketFromRawJson()`
   - 本地运行一次，确认字段提取成功

3. **Step 2: packet-builder.js**（1h）:
   - 更新 quality_check 逻辑
   - 运行现有测试，确保不 break

4. **Step 3: FinCoT prompt**（1h）:
   - 更新 Macro/Fundamental 分支
   - 添加两条门禁规则

5. **Step 4: 测试用例**（2h）:
   - 添加新测试
   - 运行 `node --test reasoning/test/raw-adapter.test.js`
   - 运行 `node --test reasoning/test/packet-builder.test.js`

6. **Step 5: 单臂对照**（2-3h）:
   - 选择 10-15 个日期
   - 执行 before/after 对比
   - 记录观察结果

### 升级条件

遇到以下情况时，停止执行并升级给宪宪：
- raw.json 数据结构与假设严重不符
- 时间边界验证逻辑复杂（涉及多时区或边界情况）
- FinCoT prompt 门禁规则与现有逻辑冲突
- 测试用例失败且原因不明

### 完成标志

- [ ] 72 个现有测试仍然通过
- [ ] 新增测试通过（至少 6 个新测试）
- [ ] 单臂对照完成（10-15 例）
- [ ] `SINGLE_ARM_COMPARISON.md` 文档完成
- [ ] 代码通过 `pnpm check`

---

## 附录：文件清单

### 需要修改的文件
- `reasoning/lib/raw-adapter.js` — 添加三个提取函数
- `reasoning/lib/packet-builder.js` — 更新 quality_check
- `reasoning/prompts/fincot-prompt.md` — 更新门禁规则

### 需要新增的文件
- `reasoning/test/SINGLE_ARM_COMPARISON.md` — 对照结果文档

### 需要更新的文件（测试）
- `reasoning/test/raw-adapter.test.js` — 添加三字段测试
- `reasoning/test/packet-builder.test.js` — 添加 quality_check 测试

---

**签名**: 布偶猫/宪宪 [claude-opus-4-8 🐾]  
**日期**: 2026-08-25  
**预计完成**: 2026-08-26 EOD
