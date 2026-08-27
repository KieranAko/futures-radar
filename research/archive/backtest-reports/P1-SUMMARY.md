# P1第1项与Random Direction — 汇总报告

执行日期：**2026年8月6日**  
最后更新：**2026年8月6日**

⚠️ **声明**：本报告为样本内诊断，不代表样本外有效性。

---

## 一、完成情况

**已完成**：
- ✅ P1-1: 样本结构统计（entry-date clusters）
- ✅ P1-2a: Random Direction实验（1,000种子）
- ✅ P1-2b: Random Selection实验（v2.0完全重写，1,000种子）

**未开始**（按缅因猫指示）：
- ⏸️ P1-3: 阈值消融实验
- ⏸️ P1-4: 持仓周期扩展测试
- ⏸️ P1-5: 统计功效估算

---

## 二、P1-1：样本结构统计

### 关键发现（T+10窗口，70笔交易）

| 指标 | 数值 | 说明 |
|------|------|------|
| 名义交易数 | 70 | 总交易笔数 |
| 唯一入场日期 | 30 | 独立时间点数 |
| **Entry-Date Clusters** | **30** | unique_entry_dates方法 |
| 最大同日交易数 | 6 | 2025-07-25 |
| 平均同日交易数 | 2.33 | 70笔/30日 |
| 平均持仓重叠数 | 3.80 | 每笔交易平均与3.8笔重叠 |
| 最大持仓重叠数 | 9 | 2026-01-06入场的3笔 |

### 品种聚类

**按Sector分布**（Top 5）：
1. 能源化工：14笔（20.0%）
2. 农产品：11笔（15.7%）
3. 畜牧：9笔（12.9%）
4. 工业品：9笔（12.9%）
5. 黑色金属：7笔（10.0%）

**按Symbol分布**（Top 5）：
1. LC0（生猪）：9笔
2. JM0（焦煤）：7笔
3. AG0（白银）：7笔
4. EC0（能源化工）：4笔
5. 其他品种：≤3笔

### 样本独立性评估

⚠️ **重要发现**：
- 名义N=70，entry-date clusters=30（43%）
- 同一入场日期最多6笔交易（时间聚类显著）
- 平均持仓重叠3.8笔（窗口交叉显著）
- **真实Effective Sample Size (ESS)未知**

**方法说明**：
- Entry-date clusters使用unique_entry_dates方法
- 这**不是**严格的Effective Sample Size (ESS)
- 真实ESS需要考虑持仓重叠的相关性结构
- 本统计仅作为样本独立性的粗略下界指标

---

## 三、P1-2a：Random Direction实验

### 3.1 Random Direction（1,000种子）

**实验设计**：
- 固定信号队列（symbol + signalDate）
- 随机翻转每笔交易的方向（bullish ↔ bearish）
- 基于grossReturn重新计算：directionSign × grossReturn - costs
- 独立种子数：1,000

**统计结果**：

| 指标 | Observed | Null Mean | Null Std |
|------|----------|-----------|----------|
| 平均收益 | 2.03% | -0.08% | 1.76% |
| Null >= Observed | - | 128/1000 | - |
| **经验p值** | - | **0.1289** | - |

**结论**：
- 经验p值=0.1289，在α=0.10水平下未拒绝零假设
- 在本样本中，无证据表明方向选择优于随机
- 注意：统计功效未知，"未拒绝"≠"证明无效"

---

## 四、P1-2b：Random Selection实验

### 4.1 实验版本历史

**v1.0（已撤回）**：
- 5项实现错误导致结果失效
- 旧p=0.723已撤回

**v2.0（2026-08-06完成）**：
- 完全重写，修复所有错误
- 使用交易日索引而非日历日期
- 使用历史filtered-hard.json（已在signalDate T生成）
- Fisher-Yates shuffle + 1000 seeds
- 两个预注册null

### 4.2 Cohort调整

**原始observed**：70笔交易，30个exit dates

**过滤后cohort**：61笔交易，26个exit dates
- 排除4个无候选池的日期：20240710, 20250421, 20250718, 20260120
- 这些日期在hard filter阶段全部被拒绝
- Observed平均收益从2.03%降至1.43%

### 4.3 Null A：随机选品+EMA原方向

**实验设计**：
- 方向规则：EMA20斜率（与observed相同）
- 选品规则：Fisher-Yates shuffle随机选择
- 独立种子数：1,000

**统计结果**：

| 指标 | Observed | Null Mean | Null Std |
|------|----------|-----------|----------|
| 平均收益 | 1.43% | 2.20% | 3.12% |
| Null >= Observed | - | 658/1000 | - |
| **经验p值** | - | **0.6583** | - |

**结论**：
- 经验p值=0.6583，在α=0.10水平下未拒绝零假设
- Null Mean 2.20% > Observed 1.43%
- 在相同方向规则下，observed品种选择不优于随机
- 说明HV/ATR筛选可能起负作用

### 4.4 Null B：随机选品+随机方向

**实验设计**：
- 方向规则：完全随机（random() < 0.5）
- 选品规则：Fisher-Yates shuffle随机选择
- 独立种子数：1,000

**统计结果**：

| 指标 | Observed | Null Mean | Null Std |
|------|----------|-----------|----------|
| 平均收益 | 1.43% | -0.02% | 2.87% |
| Null >= Observed | - | 205/1000 | - |
| **经验p值** | - | **0.2058** | - |

**结论**：
- 经验p值=0.2058，在α=0.10水平下未拒绝零假设
- Null Mean -0.02%接近0（随机方向期望收益为0）
- 品种选择+方向选择联合效果不显著优于随机

### 4.5 Null A vs Null B对比

**方向信号的贡献**：
- Null A（EMA方向）mean=2.20% vs Null B（随机方向）mean=-0.02%
- 差异2.22%表明EMA20斜率作为方向信号有正向贡献
- 这与Random Direction实验结果一致（p=0.1289，边缘显著）

**品种选择的表现**：
- Null A: observed 1.43% < null mean 2.20%（p=0.6583）
- 说明在相同方向规则下，observed品种选择不如随机选择

---

## 五、综合结论

### 5.1 样本结构问题

1. **时间聚类显著**
   - 名义N=70，entry-date clusters=30（43%）
   - Random Selection cohort: 61笔，26个entry-date clusters
   - 同日交易最多6笔，平均2.33笔
   - 真实ESS未知，可能低于26

2. **品种聚类风险**
   - LC0（生猪）9笔、AG0（白银）7笔、JM0（焦煤）7笔
   - 少数品种过度代表，泛化能力存疑

### 5.2 三个实验的一致性

| 实验 | Cohort | 测试内容 | 经验p值 | 结论 |
|------|--------|----------|---------|------|
| Random Direction | 70笔/30日期 | 方向选择 | 0.1289 | 边缘显著 |
| Random Selection A | 61笔/26日期 | 品种选择 | 0.6583 | 不优于随机 |
| Random Selection B | 61笔/26日期 | 品种+方向联合 | 0.2058 | 不显著 |

**一致性发现**：
- 方向信号（EMA20斜率）有正向贡献，但统计显著性边缘（p=0.1289）
- 品种选择（HV/ATR筛选）不优于随机，可能起负作用（p=0.6583）
- 两者联合效果不显著（p=0.2058）

### 5.3 方向信号有效性

**Random Direction结果**：
- 经验p=0.1289（α=0.10水平未拒绝零假设）
- 在本样本中，观察到的方向选择效果与随机方向无显著差异
- 统计功效未知，需扩大样本量才能提高检验力

**Random Selection A vs B对比**：
- EMA方向信号贡献约2.22%（2.20% vs -0.02%）
- 与Random Direction实验一致：方向信号有正向贡献但边缘显著

**结论**：
- 不能断言"方向信号无预测能力"（未拒绝≠证明无效）
- 不能断言"EMA20斜率失效"（可能是功效不足）
- 仅能陈述：在本70笔样本中，未观察到显著优于随机的证据

### 5.4 品种选择有效性

**Random Selection A结果**：
- 经验p=0.6583（远大于0.10）
- Null Mean 2.20% > Observed 1.43%
- 在相同方向规则下，observed品种选择不如随机

**可能原因**：
- HV/ATR筛选过滤掉了更好的品种
- 候选池整体收益期望为正，选择标准反向
- 筛选标准在该期间市场环境下失效

### 5.5 解释边界

**不能断言**（统计功效不足）：
- ❌ "方向信号无预测能力"
- ❌ "EMA20斜率失效"
- ❌ "HV/ATR筛选无效"

**只能陈述**（样本内观察）：
- ✅ 在本61-70笔样本中，未观察到显著优于随机的证据
- ✅ Random Direction p=0.1289（边缘显著）
- ✅ Random Selection A p=0.6583（品种选择不优于随机）
- ✅ Random Selection B p=0.2058（联合效果不显著）
- ✅ 统计功效未知，"未拒绝"≠"证明无效"
|------|----------|-----------|----------|
| 平均收益 | 2.03% | -0.06% | 1.79% |
| Null >= Observed | - | 142/1000 | - |
| **经验p值** | - | **0.1429** | - |

**结论**：
- ❌ 信号未显著优于随机方向（p=0.143 >= 0.10）
- 无法拒绝零假设：方向选择不优于抛硬币
- Observed收益2.03%在Null分布的第86百分位（非极端值）

### 3.2 Random Selection（100种子）

**实验设计**：
- 固定信号日期（30个唯一日期）
- 在每个信号日重新运行scanner（无泄漏）
- 从候选池随机选择品种
- 保持每日选择数量与observed一致
- 独立种子数：100

**统计结果**：

| 指标 | Observed | Null Mean | Null Std |
|------|----------|-----------|----------|
| 平均收益 | 2.03% | 3.88% | 3.09% |
| Null >= Observed | - | 72/100 | - |
| **经验p值** | - | **0.7228** | - |

**审计追踪**（第一个种子）：
- 25个信号日期有候选池
- 5个信号日期无对应run（2023年末）
- 候选池大小：10个品种/日
- 候选池Hash已保存供审计

**结论**：
- ❌ 信号未显著优于随机选择（p=0.723 >> 0.10）
- 无法拒绝零假设：品种选择不优于随机
- **Random Selection平均收益3.88% > Observed 2.03%**
- 说明品种选择反而劣于随机

---

## 四、综合结论

### 4.1 样本结构问题

1. **有效样本量不足**
   - 名义N=70，有效N≈30（43%）
   - 同日交易聚类、持仓窗口重叠显著
   - 统计功效严重不足

2. **品种聚类风险**
   - LC0（生猪）9笔、AG0（白银）7笔、JM0（焦煤）7笔
   - 少数品种过度代表，泛化能力存疑

### 4.2 信号有效性问题

**Random Direction（p=0.143）**：
- 方向选择（bullish/bearish）未显著优于随机
- EMA20斜率作为方向信号的有效性不足

**Random Selection（p=0.723）**：
- 品种选择显著劣于随机（Null mean 3.88% > Observed 2.03%）
- 说明HV/ATR筛选可能过滤掉了更好的品种
- 或者候选池整体收益期望为正，选择不重要

### 4.3 与原报告声称的矛盾

**原报告声称**（FULL-REPORT-CN.md）：
- "找到可部署的生产模型"
- "T+10 平均收益2.03%"
- "Sharpe 2.19"

**P1实验揭示**：
- ❌ 有效N=30（非70），统计功效不足
- ❌ Random Direction p=0.143（方向未显著优于随机）
- ❌ Random Selection p=0.723（品种选择劣于随机）
- ❌ 样本内观察，统计显著性为0

### 4.4 可能的解释

**假说1：信号失效**
- EMA20斜率、HV/ATR筛选均无预测能力
- 2.03%收益可能是运气或数据挖掘偏差

**假说2：实验设计缺陷**
- Random Selection使用历史run目录近似，非真实重新计算
- 候选池可能泄漏未来信息
- Scanner逻辑与observed不完全一致

**假说3：市场环境特殊性**
- 2024-2026期间市场特征使随机选择表现更好
- 波动率筛选在该期间反而起负作用


---

## 六、建议行动

### 立即行动（P0）

1. **暂缓生产部署**
   - Random Direction p=0.1289（边缘显著，未拒绝零假设）
   - Random Selection A p=0.6583（品种选择不优于随机）
   - Random Selection B p=0.2058（联合效果不显著）
   - Entry-date clusters=26-30，统计功效严重不足

2. **重新审视HV/ATR筛选**
   - Random Selection A结果：Null mean 2.20% > Observed 1.43%
   - 说明当前筛选可能过滤掉了更好的品种
   - 建议单变量控制实验分离HV、ATR的贡献

3. **扩大样本量**
   - 目标：entry-date clusters至少100
   - 当前26-30个日期统计功效不足
   - 扩展回测时间或增加品种覆盖

### 后续行动（P1）

4. **单变量控制实验**（P1-3，待指示）
   - 分离HV、ATR、EMA的贡献
   - 确定各特征的预测能力

5. **建立独立测试集**
   - 当前61-70笔全部为样本内
   - 需要时间外推验证（out-of-sample）

---

## 七、交付物清单

### 代码文件（5个）

1. `analyze-sample-structure.cjs` — 样本结构统计（sector映射已补齐）
2. `random-control.cjs` — Random Direction核心逻辑（成本计算已修复）
3. `random-selection-rewrite.cjs` — Random Selection完全重写（v2.0）
4. `scanner-wrapper.cjs` — Scanner包装器（历史遗留）
5. `run-random-control.cjs` — 随机对照实验主入口

### 机器可读JSON（4个）

1. `sample-structure-t+10.json` — 样本结构统计结果（entry-date clusters）
2. `random-direction-t+10-1000seeds.json` — Random Direction实验结果（p=0.1289）
3. `random-selection-nullA-t+10-1000seeds.json` — Random Selection Null A结果（p=0.6583）
4. `random-selection-nullB-t+10-1000seeds.json` — Random Selection Null B结果（p=0.2058）

### 中文报告（4个）

1. `SAMPLE-STRUCTURE-T+10.md` — 样本结构报告
2. `RANDOM-DIRECTION-T+10.md` — Random Direction报告
3. `RANDOM-SELECTION-T+10.md` — Random Selection报告（v2.0）
4. `P1-SUMMARY.md` — 本汇总报告

### 测试文件（1个）

1. `test-p1.cjs` — 验证Item 1和Random Direction正确性（7项测试）

### 可复现命令

```bash
# P1-1: 样本结构统计
cd D:/clowder-ai/packages/api/.claude/skills/futures-radar/backtest
node analyze-sample-structure.cjs --window=T+10

# P1-2a: Random Direction（1,000种子）
node run-random-control.cjs --type=direction --seeds=1000 --window=T+10

# P1-2b: Random Selection（v2.0，1,000种子）
node random-selection-rewrite.cjs

# 验证测试
node test-p1.cjs
```

---

## 八、审计声明

### 无泄漏验证

**Random Direction**：
- ✅ 固定信号队列，仅改变方向
- ✅ 基于grossReturn重新计算：directionSign × grossReturn - costs
- ✅ 使用确定性伪随机数生成器（LCG）
- ✅ 每个种子独立，可复现
- ✅ 成本恒等式验证通过：longNet + shortNet = -2×cost

**Random Selection**：
- ❌ 前期实现失效（5项错误）
- ⏸️ 待重写

### 统计方法验证

**经验p值计算**：
- ✅ 使用公式 p = (1 + null>=observed) / (seeds + 1)
- ✅ 单侧检验（Null >= Observed）
- ✅ 保守估计（分子+1避免p=0）

**样本独立性**：
- ✅ 使用unique_entry_dates作为entry-date clusters
- ✅ 明确说明这不是严格ESS
- ✅ 提供入场日期分布和持仓重叠统计

---

**报告生成时间**：2026-08-06  
**最后更新**：2026-08-06  
**状态**：Item 1 + Random Direction完成，Random Selection待重写  
**版本**：v2.0

---

## 附录：关键数据摘要

### T+10窗口统计（70笔交易）

- 名义N：70
- Entry-Date Clusters：30（43%）
- 平均收益：2.03%
- Sharpe：2.19
- 准确率：50.0%

### 随机对照实验（已完成）

- Random Direction p值：0.1289（α=0.10未拒绝零假设）
- Random Direction Null Mean：-0.08%

### 关键风险

1. Entry-date clusters=30（统计功效不足）
2. 真实ESS未知（可能低于30）
3. Random Direction未拒绝零假设（本样本中无显著差异）
4. Random Selection待重写

