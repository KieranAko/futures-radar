# Experimental Registry Status

**Last Updated:** 2026-08-26
**Current Phase:** 日常分析（pipeline/）与离线回测（backtest/，含 LLM replay）运行中；历史实验（机会层/方向层/Direction V2）已收口不再扩展；前向验证工具保留但未启用历史机制
**Owner:** 布偶猫  
**Reviewer:** 缅因猫

---

## 当前定位（2026-08-24 项目重定位）

futures-radar 已重定位为「期货短期机会分析 + 离线模型回测」：
- **日常分析**：pipeline/ 每日扫描 ~60 个期货主力合约 → Top 3 深挖 → 4 章短报告（不构成投资建议、不执行真实交易）
- **离线回测**：backtest/ deterministic 批量验证 + LLM replay（对冻结 evidence packets 回放分析层推理，产出评分卡）
- **前向验证工具：未启用历史机制**——forward-cli/manifest 保留为工具与审计证据，不属于日常流程；当前未登记任何正式未来样本

历史实验（机会层/方向层/Direction V2）数值与裁定保留在下文，作为回测模块校准依据。

---

## Current Status: ✅ 实验正式收口（2026-08-14）

**最终裁定（铲屎官 2026-08-14 21:13）：**
1. **决策1-2（模型能力）：技术猫自决** → 宪宪裁定：atrFloor维持2.0冻结（机械筛选非预测增益），方向层D0-D4正式放弃（大样本证伪）
2. **决策3（实盘时机）：暂不放入实盘**
3. **决策4（版本管理）：项目清理完成** → .gitignore更新，数据归档至experiments-archive/，一次性CLI归档至archive-one-time-scripts/

**离线实验完成状态：**
- valid-2 4579日pre-dev + train-2 660日一次性评分完成
- **机会层**：62.0%长期均值（n=6288，19年），regime主导（2012-2015仅47.5%），冻结参数维持（ER≥0.20, atr≥2.0, hvMin≥1.0）
- **方向层**：✗ 失败实验，大样本证伪（D0 49.1%, n=5205，与随机基准无显著差异；D4 43.4%显著低于50%）
- **方向层 ML 扩展（Direction V2）**：✗ 已终止（2026-08-14 宪宪裁定点1 → TERMINATE）：Logistic purged walk-forward 2007-2023 full_acc 50.94%、covered 50.99%、coverage 13.4%、gap 21.98pp；历史代码/测试已于 2026-08-25 深度清理，结案结论保留在 experiments/DIRECTION_V2_CLOSURE_REPORT.md
- 前向验证工具已就绪（2026-08-14 时点状态）；2026-08-24 重定位后保留为工具与审计证据，不启用历史机制（见上方「当前定位」）

**历史留出验证状态 (2026-08-14):**
- ✅ 已修正最初审计口径：`bt-YYYYMMDD` 是 label end date，不是 signal date；正式留出不再使用错误的目录名 `[T-25,T+11]` 污染窗口推算
- ✅ 已在查看结果前冻结 `data/futures-radar/holdout/manifest.json`：固定模型 commit、7 个实现文件 hash、历史缓存 hash、主/对照参数与 23 个 signalDate
- ✅ 留出日期固定为 2026-06-17～2026-07-20 的全部 23 个交易日：严格晚于最后开发 label end（2026-06-16），59/59 合约均有 T 前至少 25 bars 与 T+11 close
- ✅ 一次性回放已完成：主/对照均 33 候选、21 个强机会，机会命中 63.6%；D0 33 个方向信号，方向命中 48.5%，强机会方向命中 47.6%，平均净收益 -1.603%
- ⚠️ 主/对照结果完全相同，说明这 23 日没有出现 `0.18<=ER<0.20` 的边际候选，无法用该留出区间区分两个阈值
- ⚠️ 这是“历史后开发留出”，不是未触碰的真实前向数据：缓存已在协议冻结前存在，blueprint 也曾以 2026-07 日期举例；结果可证伪当前乐观样本内表现，但可信度低于未来逐日登记
- 🚫 留出结果不得用于继续调 ER/D0 阈值；如改模，必须建立新版本并使用新的验证样本
- ✅ 留出工具已简化（缅因猫 2026-08-14 裁定，阿比西尼亚猫执行）：删除重复的日期/切片实现，复用 backtest 现有模块——time-sampler（交易日历校验）、cache-slicer（sliceWindow 前置窗口门 + getVerifyWindow T+K 窗口门，扩展可选 cache 参数与 t1_open 字段，向后兼容）；historical-holdout 只保留 manifest 校验（固定日期清单）、冻结模型适配（buildReplayRaw）、单日可执行门、主/对照配对评分
- ✅ 简化后重跑 23 日与冻结 result.json 完全一致（仅 generatedAt 不同）；tmp-audit-holdout.cjs 一次性审计脚本已删除
- ✅ 边界修正（缅因猫 2026-08-14 复核发现 P1 off-by-one）：sliceWindow 返回含 T 的窗口，前置门由请求 25 根改为请求 26 根（25 前置+T），signalIdx=24 拒绝/signalIdx=25 接受，两条边界测试覆盖；修正后 23 日结果复现不变
- ✅ 缅因猫 2026-08-14 复核放行：边界测试独立复跑 10/10，7 个冻结模型文件相对冻结提交无变化，git diff --check 干净；本阶段收口，禁止基于 23 日留出结果继续调参
- ✅ 方向层 D0-D4 留出回测（2026-08-14 铲屎官指令，从冻结 result.json 提取完整分层统计，未重新评分、未调参；主=对照因 23 日无边际候选）：

| 层 | 方向信号 | uncertain率 | long/short | 命中 | 强机会命中 | 平均净收益 |
|----|---------|-----------|-----------|------|-----------|-----------|
| d0 | 33 | 0% | 9/24 | 48.5% | 47.6% | -1.603% |
| d1 | 15 | 54.5% | 4/11 | 53.3% | 63.6% | +0.840% |
| d2 | 12 | 63.6% | 3/9 | 58.3% | 66.7% | +1.280% |
| d3 | 7 | 78.8% | 0/7 | 57.1% | 80.0% | +2.144% |
| d4 | 5 | 84.8% | 0/5 | 80.0% | 80.0% | +3.951% |

- ⚠️ 方向层留出解读（经缅因猫 2026-08-14 审计收紧）：D0 本留出样本录得 48.5%（样本内 60.4%），33 笔不足以证明真实准确率低于 50%，但未证明其具备超过随机基准的预测能力——D0 未复现样本内乐观表现；D1-D4 留出命中率虽高于 D0，但样本极小（15/12/7/5 笔，仅覆盖 6/6/4/3 个日期）且高度集中（D3/D4 全 short），暂不可判定，不能据此升级，也不可断言已失效；维持冻结裁定：D0 仅为后续实验比较基线（非生产下注基线）、D1-D4 不进生产候选，禁止据此改层或调参；方向层整体状态：未验证，不具备实盘投资依据
- ✅ 方向层回测审计（缅因猫 2026-08-14）：数值与计算口径核验通过（从冻结 result.json 重算 D0-D4 全一致）；回测语义正确（T 收盘决策 / T+1 open 进场 / T+11 close 出场 / long-short 符号 / 含成本 / uncertain 不交易 / 机会候选固定于方向计算之前）

**扩大样本优化 (2026-08-14 铲屎官指令："扩大样本数，优化机会层/方向层准确率"，阿比西尼亚猫执行):**
- ✅ 协议：train（调参池）= 2024-01-02～2026-06-16 全部 592 个交易日（含开发 runs 44 日、样本内 29 日 ⊂ 此区间）；valid（新验证集）= 2023-10-30～12-29 全部 45 个交易日——唯一"全 59 合约 + ≥25 前置 + T+11 + 早于所有开发 runs（最早 bt-20240102）"的未触碰窗口（2026-07-21 后日期缺 T+11 缓存数据；2023-09 前有合约未上市）；留出 23 日已披露仅作参照
- ✅ 冻结顺序：valid 清单先冻结（manifest-expanded.json），train 网格扫描选参后 optimized 配置在 valid 评分前冻结进同一 manifest（optimizationRecord 记录选参依据）；valid 结果只出现一次
- ✅ train 网格扫描（36 格 = ER[0.16,0.18,0.20,0.22,0.25,0.30] × slope[0.2..0.5]，产物 data/futures-radar/train/scan-2026-08-14.json）：
  - 机会层命中率全网格 66.6%–67.2% 几乎平坦（0.16→67.24%、0.20→67.23%、0.30→66.87%）——冻结 ER 0.20 已是最优点，ER 阈值无法提升机会层准确率
  - D0 方向命中率：slope 0.2–0.35 平坦区 51.0%–52.0%（全网格峰值 51.96% @ ER0.18/slope0.25），slope 0.5 退化至 47.6%–48.5%；冻结 slope 0.3（51.55% @ ER0.20）已在平台区
  - 选参：optimized = ER0.18 + slope0.25——注意与冻结差异仅 +0.4pp（n≈1000，标准误 ~1.5pp，不显著）
- ✅ valid 45 日一次性验证（三配置全部评分前冻结，result-expanded.json）：

| 配置 | 候选 | 机会命中 | D0 信号 | D0 方向命中 | D0 强机会命中 | D0 平均净收益 |
|------|-----|---------|--------|------------|--------------|--------------|
| main 0.20/0.30 | 111 | 65.4% | 91 | 54.9% | 57.9% | +6.88% |
| control 0.18/0.30 | 116 | 66.1% | 93 | 54.8% | 57.6% | +6.76% |
| optimized 0.18/0.25 | 116 | 66.1% | 97 | 55.7% | 59.7% | +6.61% |

- ⚠️ valid d1-d4（main）：信号 18/13/6/0，命中 38.9%/53.8%/100%(n=6)/n/a——样本仍极小不可判定；main/control 的 d1-d4 完全一致（ER 0.18–0.20 边际候选全 uncertain，与 23 日观察一致）
- ✅ **扩大样本裁定**：机会层命中率 65–67% 跨 train/valid 稳定，ER 0.20 冻结维持；方向层 D0 三组独立样本 48.5%（23 日留出）/54.9%（45 日 pre-dev）/51.5%（592 日 train）围绕 50% 波动，全部与随机基准无显著差异——**未发现可优化点，冻结参数维持不变**；optimized 在 valid 上 +0.8pp（n≈91–97，标准误 ~5pp）不显著，不构成升级依据；方向层继续标"未验证、不具备实盘投资依据"
- ✅ 工具改动（向后兼容）：historical-holdout 配置由 manifest 自声明（结构校验 + 未知键拒绝，不再硬编码 0.20/0.18）；新增 pre-dev/post-dev 两种样本分类边界（developmentFirstRunDate 或 lastDevelopmentLabelEndDate 二者必居其一）；任意多配置配对评分；train-scan 网格扫描器（lib/train-scan.js + CLI）；23 日冻结结果复现完全一致；experiments/test/ 106 通过（holdout 15 + train-scan 2 + 既有 89）

**机会命中下降诊断 + 机会层旋钮扫描 (2026-08-14 铲屎官指令："样本扩大后机会命中显著下降了，看下怎么优化"，阿比西尼亚猫执行):**
- ✅ 判定「显著下降」不成立：74.5%（样本内 29 日，n=55，标准误 5.9%）vs train 67.2%（n=1184，z=1.21，p=0.23）vs valid 65.4%（n=107，z=1.22，p=0.22）vs 23 日留出 63.6%（n=33，z=1.07，p=0.29）——全部两两不显著；74.5% 是 55 候选的小样本样本内乐观估计（多轮调参），真实水平 ~66–67%，train/valid 间无真实衰减（z=0.38）
- ✅ regime 诊断（frozen 月级命中率 2024-01..2026-06）：月度摆动 44.0%–100%；2026H1 整体 81.5%（73.7%→100%，高波动 regime），2024 65.3%、2025 62.5%（常态）；23 日留出（2026-06-17..07-20）63.6% 与 2025 常态完全一致——近期回落是 2026H1 高波动 regime 的均值回归，不是模型衰减
- ✅ 16 旋钮单变量扫描（592 日 train，产物 data/futures-radar/train/opportunity-knob-scan-2026-08-14.json；frozen 单元锚点校验 1195/1184/796 与 train-scan ER0.20 单元逐项一致）：
  - frozen 67.2%｜er0 65.7%（ER 门砍 40% 候选，仅 +1.5pp 不显著）｜scanner-raw 63.8%（机会层全部过滤器合计仅 +3.5pp，z=2.3 显著但幅度小）
  - top7/top5/top3：67.2%/68.1%/69.6%（均不显著）｜hvMax1.5/1.2：68.8%/69.9%（不显著）｜hvMin1.2/1.5：65.0%/58.1%（收紧下界有害，1.5 显著恶化 p=0.02）
  - adx20/25/30：66.7%/66.2%/65.4%（无效，单调微降）｜atr2.5/3.0：70.8%（p=0.075）/74.5%（p<0.001）｜combo(hvMax1.2+atr2.5)：72.9%（p=0.03）
- ✅ train 内 walk-forward 稳定性检验（fold1=2024 选参，fold2=2025/fold3=2026H1 检验，产物 data/futures-radar/train/opportunity-walk-forward-2026-08-14.json；不触碰已披露的 45 日 valid）：
  - fold1 胜者 combo 73.5% → fold2 64.6%（n=147，z=0.5 不复现，增益消失）——hvMax 旋钮跨年份不稳定
  - **atr3.0 是唯一三折稳定为正的旋钮**：fold1 +5.4pp（p=0.12）/fold2 +8.7pp（p=0.02）/fold3 +1.5pp——但本质是机械波动率筛选：日 ATR≥3% 时 |10日move|≥3% 的随机游走理论值 ≈75%，与实测 74.5% 一致，属精度/召回权衡（候选 −40%，方向层信号样本同步缩水），不是预测能力提升
- ✅ **裁定**：无真正的可优化点——机会层命中率由波动率 regime 决定（常态 ~63–65%），现有过滤器（HV≥1.0 + ATR≥2.0 + ER≥0.20）已榨取该特征集的可预测部分（裸 scanner 之上仅 +3.5pp）；若铲屎官要"更高命中率数字"，atrFloor 2.5/3.0 是唯一稳定杠杆但属机械筛选，需另行确认是否调整冻结参数（且不能回验 45 日 valid——已披露一次，只能走前向样本验证）；冻结参数维持不变
- ✅ 新工具：experiments/lib/opportunity-knob-scan.js（单日期特征表 + 内存旋钮过滤 + byYear/byMonth 聚合）、opportunity-knob-scan-cli.js（锚点自校验）、opportunity-walk-forward-cli.js；experiments/test/ 116 通过（新增 opportunity-knob-scan 10）

**样本再扩大一倍 (2026-08-14 铲屎官指令："现在把样本集再调大一倍"，阿比西尼亚猫执行):**
- ✅ 关键发现：冻结缓存本身覆盖 2005-01-04..2026-08-05（59 合约），无需重新采集。pre-dev 未触碰窗口 2005-01-04..2023-10-27 全部 4579 个交易日成为 valid-2（≈45 日 valid 的 100 倍、train 的 7.7 倍）；已披露日期（45 日 valid + 23 日留出）并入 train-2 = 660 日（2023-10-30..2026-07-20）。7 个锁定文件 + 缓存 sha256 验证无漂移
- ✅ 冻结顺序：manifest-valid2.json 先冻结（4579 signalDates + 3 冻结配置 main/control/optimized + 4 预注册旋钮 atr2.5/atr3.0/hvMax1.2/combo；developmentFirstRunDate=2024-01-02 pre-dev 边界；executableRule 声明逐合约门槛——严格全合约工具对 2005 年代（仅 8 合约）不适用）再评分；6 条 limitation（regime 混合/夜盘缺失/涨跌停幅度/成分 8→59/拼接/连续日期相关）与 5 条 prohibition 随清单冻结
- ✅ 管道复现双锚点：45 日窗口 111/107/70 ✓（官方口径）；train-2 内 592 日子集 1195/1184/796 ✓
- ✅ valid-2 机会层一次性评分（n=6288，产物 result-valid2-opp.json）：
  - frozen main 62.04%（95% CI 60.8–63.3%）；control 61.96%；T+11 purge 视图（保留日间隔 ≥12 交易日，日期级）65.26%（n=498）
  - **分时代（byYear）**：2005-2011 62.1%（1089/1753）｜**2012-2015 47.5%（421/887）**｜2016-2023 65.5%（2391/3648）
  - train 67.2% vs 2016-2023 65.5%：z=1.07，p=0.28 不显著——train 的乐观与 2016+ 时代一致，不是模型退化
  - 2012-2015 vs 2016-2023：z≈9.9 极显著——命中率由波动率 regime 主导；2012-2015 连续 4 年与抛硬币无显著差异（vs 50%：z=-1.51，p=0.13）
  - 旋钮 19 年尺度复验：atr2.5 66.18%（cov 73.5%）/atr3.0 69.72%（cov 49.7%）唯一稳定杠杆（机械波动率筛选，与随机游走理论一致）；hvMax1.2 62.72%≈frozen；combo 66.96%——与上次裁定一致，无新增可优化点
- ✅ valid-2 方向层一次性评分（产物 result-valid2-dir-{main,control,optimized}.json，main n=5205）：
  - D0 方向命中 49.09%（CI 47.7–50.5%）= 抛硬币；D1 49.36%（n=1098）、D2 47.62%（n=735）、D3 46.88%（n=497）、D4 43.37%（n=332，vs 50% z=-2.42，p=0.016 显著低于随机）
  - strongHit D0 50.14%；各层平均净收益 ≈0（含成本）——方向层大样本证伪：无预测力且越深越差；原标记"未验证"升级为"大样本下无预测力"，维持不进入生产
- ✅ train-2 旋钮扫描（产物 result-train2-scan.json，含 purge 视图 + purge 后 walk-forward folds）：
  - 全窗口 frozen 66.99%（887/1324；其中已披露 45 日 70/107 与 23 日 21/33=63.6% 逐项复现）
  - purge 后 folds 样本过小（n=45/55/17，CI ±10–15pp）：fold1 51.1%/fold2 65.5%/fold3 82.4%——仅指示性，无旋钮在 purge 层稳定增益
- ✅ **裁定**：机会层长期真实水平 ≈62%（全时代），近期 regime ≈65–67%；参数冻结维持。最大风险披露：低波动年份（2012-2015 型）机会层可能连续多年无效。atrFloor 2.5/3.0 仍为唯一待铲屎官拍板的机械杠杆（候选 -27%/-50%，命中 +4.1/+7.7pp）。方向层无升级空间
- ✅ 新工具：valid2-score-cli.js（opp + dir 双模式 + 双锚点 + purge 视图）、train2-scan-cli.js；lib/historical-holdout.js 导出 assertDevelopmentBoundary（新增直接导出回归测试）；experiments/test/ 117 通过（historical-holdout 16）

**Direction V2 结案 (2026-08-14 宪宪裁定点1 → TERMINATE，方案 v1.1 铲屎官批准，阿比西尼亚猫执行):**
- ✅ Step 1 数据准备：冻结机会 cohort（≡ selectOpportunitiesO1(0.20,null)）+ T+1 open 进场 / T+11 close 出场（H10，跳空≥9.5% 弃行）+ 20 特征全 T 截断；45 日锚点 111/107 ✓；7358 行（弃 132 无结果 + 221 特征缺失）；31/31 测试绿（含未来数据泄漏测试：篡改 T+2/T+5/T+11 向量不变）
- ✅ Step 2 训练评估：purged expanding walk-forward 2007-2023（17 折），StandardScaler（仅训练集拟合）+ LogisticRegression(l2, C=1.0, balanced, lbfgs, rs=42)；purge = 训练行标签窗口伸入测试年剔除；Python 纯逻辑 23 检查 + Node 集成 2 全绿；模型 pkl 已按砚砚建议移除不落盘（训练集含 2024-2026 行，不可部署）
- ✅ 裁定点1 机械结果 **TERMINATE**：pooled n=6013 covered acc 50.99%（covered n=806）、**full_acc 50.94%**（不弃权全行取方向仍随机）、long 54.64%(n=280)、short 49.05%(n=526)、coverage 13.4%（<25% 验收线）、net_mean -0.427%、正收益年 8/17、train/test gap 21.98pp（各折 covered 差非加权平均，诊断用途；训练内 covered 66-83%）
- ✅ 三项诊断证据：①full≈covered → 固定 0.65/0.35 弃权带无准确率增益 ②gap 22pp → regime 过拟合（2016 年 152 笔全 short 命中 28.3% 供给侧大牛反向 / 2021 年 31 笔全 long 命中 41.9% 超级周期反向）③覆盖不稳定（2008 58.3% → 2023 0%=全落中央弃权带，2016 单边极端）
- ✅ 与 D0-D4 交叉验证：两套验证结果（样本有重叠，不做独立样本合计）方向一致——D0 49.09%（n=5205）、D4 43.37%（显著低于随机 p=0.016）与 Logistic 50.94%（n=6013）；在已测试的日线 OHLCV/量仓技术特征、规则模型与预注册 Logistic 协议下，未发现可稳定泛化且满足交易门槛的方向预测力（LightGBM 未跑，按预注册停止搜索）
- ✅ 宪宪正式裁定：Direction V2 终止、不进 Phase 2（LightGBM）、当前已测日线 OHLCV/量仓技术方向路线停止（不进入生产）；机会层继续（62.0% 冻结参数维持）但不做方向判断；LLM 方向决策仅为设想路径（未验证、非投资依据，实盘继续关闭）；后续方向 = regime 识别（状态分类）或新数据源（期限结构/主力持仓/订单流）
- ✅ 结案报告：experiments/DIRECTION_V2_CLOSURE_REPORT.md（6 节完整证据链）；Step 1-2 历史代码与测试已于 2026-08-25 深度清理，统计结论与终止理由继续保留；Step 3-6 不实施；砚砚复审后的证据表述修正均已保留在结案报告

**前向验证工具状态 (2026-08-14 实现 / 2026-08-24 生产不变量审计收口):**
- ✅ `experiments/lib/forward-recorder.js` + `experiments/forward-cli.js` 已实现（TDD）：`register <raw> <signalDate>` 登记主/对照候选与 D0 快照（pending 无收益）→ `settle <raw> <signalDate>` 在 T+11 bar 可用后结算 d0 trades/outcomes → `status` 进度查询
- ✅ 业务 manifest：`data/futures-radar/forward/manifest.json`（minimumSignalDate=2026-08-14=冻结提交当日、freezeCommit=7abfaab516652675561cbb96be5d5d6e899a0393、frozenAt=2026-08-14T09:49:06+08:00；<08-14 的日期一律拒绝）
- ✅ 2026-08-24 生产不变量审计（缅因猫审查通过）：新增 `lib/forward-manifest.js` guard——manifest 内容自哈希（规范化键排序 SHA-256，原子写入时封存、register/settle/status 入口校验，fail closed）；version/冻结元数据/记录结构与数值有限性全校验；runId 溯源强制（register/settle 均要求 raw.meta.runId，缺失拒绝）；T+1 open 进场 / T+11 close 出场交易语义锁定测试；CLI 命令面测试补齐。**42/42 前向测试绿，136/136 experiments 全量绿**
- ⏳ **长期监控边界**：当前未登记任何正式未来样本；后续真实新日期逐日登记，用于判断历史留出失败是否持续。**真实新鲜 run（信号日 ≥ minimumSignalDate 2026-08-14）出现前，不得登记任何正式 forward 日期**；现有 runs/ 全部早于边界，仅作测试夹具
- 🚫 工具约束：旧日期拒绝、重复/乱序拒绝、冻结配置/元数据漂移 fail closed、未成熟不结算、settle 时 cohort/D0 漂移与非有限价格 fail closed、manifest 原子写入、零候选日期保留、不恢复 9-gate 账户模拟
- ⚠️ **候选消失口径（缅因猫 2026-08-24 裁定）**：登记候选在结算时不可用（合约退市/数据缺失）→ 该日期**永久保持 pending**，不自动跳过、不自动作废——禁止未批准的样本删除/失效规则；宁可成熟样本数减少也不引入主观口径。未来处理需铲屎官定义冻结的 invalidated/censored 状态（含原因枚举、统计分母、覆盖率口径）
- 🚫 **Phase 2 / 实盘仍关闭**：FinCoT Phase 2 未批准（Phase 1 工程组件通过、raw-adapter 真实性缺陷已由砚砚修复）；实盘交易关闭，前向记录仅为统计监控，不作为投资依据

**Registry Status:** v1.3 → 机会层收口（ER≥0.20 主 / ER≥0.18 对照）+ 方向层 D0-D4 累积矩阵  
**Implementation Progress:** D0-D4 已实现并通过 36 个方向层测试（22 D0-D3 + 14 D4）  
**Git Commit:** 冻结提交已入库（机会层参数分析 + 方向层 D0-D4 + 前向验证记录闭环；minimumSignalDate=2026-08-14，freezeCommit=7abfaab5）  
**Next Milestone:** 日常分析（pipeline/）与离线回测（backtest/，含 LLM replay）持续运行；历史实验已收口不再扩展，前向验证工具保留但未启用历史机制

**方向层收口裁定 (缅因猫 2026-08-13):**
- ✅ **D0 为当前最可用方向基线**（EMA20 slope，60.4% 整体命中 / 60.0% 强机会命中）
- ✅ **D1-D4 未显示增益且覆盖严重下降**（d1 12 信号 / d2 9 / d3 5 / d4 2），不作为生产方向层候选
- 🚫 **禁止在同一 29 日期继续调窗口或阈值**；后续只允许新日期前向验证

**方向层 D0-D4 样本内结果 (2026-08-13, 29 日期, H10 含成本):**

| 配置 | 层 | 方向信号 | uncertain率 | long | short | 整体命中 | 强机会命中 | 平均净收益 |
|------|----|---------|-----------|------|-------|---------|-----------|-----------|
| MAIN ER≥0.20 (55候选) | d0 | 48 | 12.7% | 20/34 | 9/14 | 60.4% | 60.0% (21/35) | +3.112% |
| | d1 | 12 | 78.2% | 5/9 | 2/3 | 58.3% | 58.3% (7/12) | +3.861% |
| | d2 | 9 | 83.6% | 3/7 | 1/2 | 44.4% | 44.4% (4/9) | -0.278% |
| | d3 | 5 | 90.9% | 2/4 | 1/1 | 60.0% | 60.0% (3/5) | +4.416% |
| | d4 | 2 | 96.4% | 0/1 | 1/1 | 50.0% | 50.0% (1/2) | +0.359% |
| CONTROL ER≥0.18 (59候选) | d0 | 49 | 16.9% | 20/34 | 10/15 | 61.2% | 61.1% (22/36) | +3.158% |
| | d1 | 12 | 79.7% | 5/9 | 2/3 | 58.3% | 58.3% (7/12) | +3.861% |
| | d2 | 9 | 84.7% | 3/7 | 1/2 | 44.4% | 44.4% (4/9) | -0.278% |
| | d3 | 5 | 91.5% | 2/4 | 1/1 | 60.0% | 60.0% (3/5) | +4.416% |
| | d4 | 2 | 96.6% | 0/1 | 1/1 | 50.0% | 50.0% (1/2) | +0.359% |

⚠️ **全部为样本内事实**：29 日期已参与多轮开发，不构成"显著提升"或"生产可用"结论，参数未冻结。主/对照 d1-d4 行一致系方向层不含 ER 阈值（额外候选全部 uncertain），是固定 cohort 不变量的直接证据。d4 仅 2 样本不可解释。

**方向层规格 (缅因猫 2026-08-13 裁定):**
- ✅ **固定机会 cohort**：真实 ER 选择器（selectOpportunitiesO1），ER≥0.20→55、ER≥0.18→59，topN=null；方向特征严禁参与候选选择
- ✅ **D0 基线**：EMA20 五点 OLS slope，|slope|≥0.3 %/day 按符号 long/short，否则 uncertain
- ✅ **D1-D4 累积矩阵**：D1=prior-20 Donchian（严格排除 T）；D2=成交量确认（5日均/20日均≥1.0）；D3=持仓量确认（同窗口）；D4=板块同步（同 sector peer ≥2 且同向比例≥60%）
- ✅ **未确认一律 uncertain**，无默认 bearish；uncertain 不进命中率分母、不生成 trade
- ✅ **D4 数据来源**：config/symbols.json（collector akshare-futures.cjs 同源权威映射，82 个白名单条目、8 个板块；本轮 59 个 raw 合约全部可映射，实际覆盖其中 7 个板块，financial 未出现在 raw；历史 raw sector 为 unknown 系快照未富化，不读取）；sector 仅用于 peer 分组

**机会层暂定配置 (2026-08-13):**
- ✅ **主配置：ER≥0.20**（命中率74.5%，样本55个，精度优先）
- ✅ **对照配置：ER≥0.18**（命中率72.9%，样本59个，覆盖率对照）
- ✅ **真实O0基线：97个样本，63.9%命中率**（vs 之前错误的73个65.8%）
- ⚠️ **不冻结为最终生产参数**：需在新日期上前向验证稳定性
- 🚫 **后续实验固定比较这两个配置，不再继续搜索ER阈值**

**关键发现 (2026-08-13 边际分析):**
- **候选平台区间：ER≥0.18–0.20**
- **首次precision恶化点：0.20→0.22**（删除2 hit + 0 miss，命中率从74.5%降至73.6%）
- **Two-Layer V2 事实**：机会层结果由 direction-neutral candidate outcomes 计算，改变方向阈值不会改变机会层指标；真实机会基线为 62/97=63.9%
- **边际分析方法修正**：
  - 移除Top10截断确保严格嵌套集合（Added列全为0）
  - 边际函数提取到共享模块 `experiments/lib/er-marginal-analysis.js`
  - 重复键检测改为抛错（不再静默折叠）

**Historical Test Evidence (2026-08-13; source fixtures/scripts cleaned 2026-08-25):**
- opportunity-features: 9 passing；opportunity-selector: 9 passing；marginal-analysis: 6 passing
- prediction-quality-evaluator: 5 passing；E1-E4a replay: 9 passing
- direction matrix: 22 passing；direction sync: 14 passing
- baseline parity: 29/29 dates verified
- 以上是历史结案证据，不是当前可执行测试清单；依赖已删除 `backtest/runs` 的一次性脚本与测试已清理

**Retained Test Suite:**
- experiments/test/forward-recorder.test.js：前向历史机制的登记/结算/进度不变量
- experiments/test/forward-manifest.test.js：内容哈希、schema、状态与 runId 溯源
- experiments/test/forward-cli.test.js：CLI exit code 与输出契约
- 当前机会层/方向层结论以本文件和结案报告为准，不再通过已清理的历史 run fixtures 重跑

**Resolved Issues (2026-08-13 方向层复审):**
- ✅ P0: D4 误标 BLOCKED → 真相源为 config/symbols.json（collector 同源权威映射，82 个白名单条目、8 个板块；本轮 59 个 raw 合约全部可映射、实际覆盖 7 个板块）；历史 raw sector unknown 系快照未富化，不等于无映射；已按 TDD 补 D4 层（14 个红绿测试）
- ✅ D4 实现口径：同 signalDate 同 sector peer 截断到各自 T 算 D0，仅 long/short 纳入；排除自身；有效 peer≥2 且同向≥60% 保留方向；peer 不读未来数据

**Resolved Issues (2026-08-13):**
- ✅ P0: Top10截断导致候选集非嵌套 → 移除截断，边际分析在完整候选集上执行
- ✅ P1: 错误基线（73个标为O0）→ 恢复真实O0基线（97个样本，63.9%）
- ✅ P1: 伪断言 + 边界测试空通过 + Math.random() → 全部修复
- ✅ P2: compareAdjacentThresholds无单元测试 → 6个单元测试覆盖
- ✅ Round 2: 边际函数未模块化 → 提取到共享模块，测试import真实实现
- ✅ Round 3: 文档口径不统一 → 删除"正/负收益"判定，改用"删除集命中率"客观指标

**Available Parameter Variants (unchanged):**
- **E1 Scanner**: ATR14 (baseline), HV20, ER20, ATR5, VEC
- **E2 Eligibility**: combined (baseline), only-hv, only-atr, none
- **E3 Direction**: ema-slope (baseline), ma-crossover, donchian, random (3 seeds)
- **E4a Hold Period**: H10 (baseline), H7, H15

---

## Completed Work

### Registry v1.3 DRAFT
**File:** `EXPERIMENT_REGISTRY_v1.3.md`  
**Status:** ✅ Submitted for Round 10 review  
**Submission Time:** 2026-08-06

**Round 9 Corrections Applied (14 items):**

**P0 (Statistical & Implementation Errors):**
1. ✅ Exit price: T+11 close (not open), traced to `simulateExit()` L267
2. ✅ 61 signal trades vs 44 account trades: separate statistical objects, -4.02% is account total return
3. ✅ HV20 window: 110 prices → 90 rolling windows, current HV20 is last window
4. ✅ ATR5 window: 95 bars → 90 rolling windows (endpoints 5..94)
5. ✅ Flat prices percentile: when all HV=0, percentile=100 (not 50)
6. ✅ E2 Max-|T|: `max(abs(t_k))` not `abs(max(t_k))`
7. ✅ P-value: exact `count/64`, no mid-p, quantile informational only
8. ✅ Studentized T: sample variance (n-1), zero-variance rules specified

**P1 (Specification Gaps):**
9. ✅ Donchian frozen: prior 20-bar channel excluding T
10. ✅ All TBD/X% filled: +5%, 15%, +2%, +3%, 30 dates, 30 trades, 90 days
11. ✅ Signal provider interface: unified adapter (foldsDetail/testRunDateMetadata/allOOSTrades)
12. ✅ Nine gates listed by name: calendar, settle, cash chain, cost, equity, risk, input, period, final
13. ✅ Calendar: non-trading dates recorded, zero-trade retained (not deleted)
14. ✅ Challenger replay: discovery compatibility gate only, not new OOS validation

### Parity Assertions v1.3
**File:** `PARITY_ASSERTIONS_v1.3.md`  
**Status:** ✅ Updated to match v1.3 registry

**Contents:**
- P1 baseline parameters (20 assertions, all traced to line numbers)
- Feature calculation index ranges (HV20, ER20, ATR5 with corrected windows)
- Statistical testing (64-pattern enumeration, sample variance, Max-T/Max-|T|)
- E2/E3/E4 execution protocols (frozen thresholds)
- RNG reproducibility (RNG only for E3 random control)
- Forward validation (30+30+retain-zero, 7 economic criteria)
- Pre-freeze verification checklist (20 items)

---

## Review History

### Round 1-5
**Status:** ❌ Rejected  
**Issues:** Cost formula errors, file path errors, index range ambiguities, E2 permutation errors

### Round 6
**Status:** ❌ Rejected  
**Critical Issue:** Baseline misidentified as "ATR5 Top3" instead of actual "ATR14% Top10"  
**Additional Issues:** E1 pool design (cannot start from ATR-filtered pool)

### Round 7
**Status:** ❌ Rejected  
**Critical Issues:** Hold=5 (should be 10), cost missing *2, test runs 44 (should be 29), E1 not testing vs baseline

### Round 8
**Status:** ❌ Rejected  
**Critical Issues:** Missing 2 of 4 pipeline stages (eligibility + direction), wrong HV/ATR window counts, 10k resampling instead of 64 enumeration, forward embargo threshold ambiguous, account gate not defined

### Round 9
**Status:** ❌ Rejected  
**Critical Issues:** 14 items requiring correction (P0: 8 statistical/implementation errors, P1: 6 specification gaps)

**Major corrections:**
- Exit price: T+11 close not open
- 61 signal vs 44 account trades confusion
- HV20/ATR5 window construction errors
- Percentile tie-breaking (flat prices → 100 not 50)
- E2 Max-|T| formula wrong
- P-value calculation (no mid-p)
- Studentized T variance (n-1 not n)
- Donchian definition ambiguous
- All TBD/X% thresholds unfrozen
- Signal provider interface undefined
- Nine gates not enumerated
- Calendar handling (non-trading dates)
- Challenger replay scope unclear

### Round 10
**Status:** ✅ APPROVED (with implementation requirement)  
**Submitted:** 2026-08-06  
**Approved:** 2026-08-07  
**Reviewer:** 缅因猫 (@cat-g7k98t5f)  
**Condition:** Implement features using TDD before running experiments

**Key Changes in v1.3:**
- All 14 Round 9 corrections applied and verified
- Exit price: T+11 close explicitly stated, traced to source L267
- 61 signal vs 44 account: separate sections, identity clarified
- HV20: 110 prices → 90 rolling windows with explicit loop
- ATR5: 95 bars → 90 rolling windows (endpoints 5..94)
- Percentile: flat prices test vector added (expect 100)
- E2: Max-|T| formula corrected with explicit abs(t) before max
- P-value: exact count/64, no mid-p or quantile decision
- Studentized T: sample variance (n-1) explicitly specified
- Donchian: frozen to prior 20-bar excluding T, no alternatives
- All thresholds frozen: +5%, 15%, +2%, +3%, 30, 30, 90
- Signal provider: unified adapter schema (3 required fields)
- Nine gates: listed by name with scope annotations
- Calendar: non-trading recorded, zero-trade retained
- Challenger: compatibility gate only, not OOS validation claim

**Final Implementation (2026-08-10):**
- Registry v1.3 fully implemented as parameter backtest scoring engine
- Direction corrected from "experiment framework" to "scoring engine"
- Core metrics simplified to hitRate + netReturnMean only
- Human evaluation replaces automated gate selection

---

### FinCoT Phase 1 工程验证（2026-08-24）
- ✅ adapter、packet builder/validator、四臂 prompt/render/e2e、grounding、outcome parity 与 mock reproducibility 已完成测试。
- ⚠️ 真实历史 fixture `20260805-1027-auto/raw.json` 的源 `fetchedAt=2026-08-05T10:28:05.739623` 晚于回放日期 `2026-08-04` 的冻结点；adapter 已保留真实时间，故该 fixture 仅用于 schema/adapter smoke，不得作为正式 point-in-time 样本。
- ⚠️ 既有 raw artifact 不含 `basis`、`inventory`、`member_position`；Phase 1 未验证增强证据分支的实际采集闭环。
- ❌ Phase 2 正式采样、方向有效性结论、生产/实盘接入均未批准。

### Phase 3 阶段一：宏观锚点采集 → 报告（2026-08-26 缅因猫复验放行）
- ✅ 冻结范围落地：collect→macro→report 闭环，产物 `{runDir}/macro-snapshot.json`；5 个冻结锚点（DXY/USDCNH/US10Y/DR007/SC0）；报告阶段不联网只读快照；单指标失败标 missing（带 reason）不伪造，整阶段 failurePolicy=warn 不阻断管道
- ✅ 真实 run `20260826-1622-auto` 四件产物齐备（macro-snapshot/report-facts/report-model/report），旧 run 未改写；快照 5/5（DXY 98.9774 fresh / USDCNH 6.7167 stale / US10Y 4.64 stale / DR007-FDR007 代理 1.42 fresh / SC0 584.1 stale），全部 source/asOf/fetchedAt 齐、`_timestamp_origin=observed`、asOf≤signalDate、fetchedAt≤snapshotFrozenAt
- ✅ report.md 输出真实五锚点 + 按品种相关锚点，旧版六指标占位表移除；传导路由 config/macro-transmission.json 前缀首个命中、未命中空集合法
- ✅ fail-closed：build-facts.cjs 调用 validateMacroSnapshot，schema 损坏快照拒绝进入报告；校验覆盖恰好五锚点、ISO 日期/时间、observed、允许 source、序列升序/日期与 close 等长/末值有限
- ✅ 测试 507/507（标准命名 502 + 非标准命名文件 5）；宏观专项 70/70（3 文件）与 72/72（4 文件含 akshare-macro.test.js）均绿
- 🚫 边界（缅因猫裁定，阶段二实施后仍有效）：本次报告宏观展示不得描述为宏观方向预测能力证明；实盘仍关闭；阶段二实施与 P1 修复记录见下方「Phase 3 阶段二」段落

### Phase 3 阶段二：宏观上下文进入 FinCoT（2026-08-26 砚砚复审通过，P1 修复后）

- ✅ 实现：`analyze/freeze-packets.mjs` 冻结时按品种注入 packet 顶层 `macro_context` 三态（available/not_applicable/unavailable；evidence 仅观察值逐字透传，relation 不写入 packet），仅 FinCoT 消费；FinCoT 结构化结果新增审计三字段 `macro_support`/`macro_conflict`/`macro_evidence_ids`（取值契约见 fincot-prompt.md）
- ✅ 四臂隔离：仅 FinCoT 渲染宏观区块；SP/UST-CoT/ST-CoT 无宏观泄漏；legacy packet 渲染保持原模板（fincot 前 4274 bytes byte-identical）
- ✅ 双域 grounding：`macro_evidence_ids` → `macro_context.evidence[].id` 独立 fail-closed；失败降级 pass/model_abstain，不静默删除
- ✅ hash 覆盖：packet hash 随宏观 value/status/asOf 变化（测试 + 独立实测）
- ✅ P1 修复（砚砚 17:54 复审）：runner eligibility 门禁新增 `validateMacroContext` 自校验（malformed → packet_ineligible，provider 零调用）；freeze-packets 非法 context 由 warn 升级 FATAL 拒绝封存
- ✅ 测试：新增 43（`reasoning/test/macro-context.test.js` + `reasoning/test/macro-grounding.test.js`）；reasoning 249/249（50 suites）；全量 545/545（97 suites，精确 futures-radar 口径命令见交付记录）
- ✅ 新 run `20260826-1622-auto` 追溯链：evidence-packets（3 packet macro_context=available）→ reasoning-results（3/3 accepted、grounded、ungrounded_macro=[]）→ analysis（reasoningRef.packetHash 重算一致）→ report；B0/M0 路由 [macro.DXY, macro.USDCNH]、J0 路由 [macro.DR007]，宏观 value/asOf/fetchedAt 与冻结快照逐字段一致
- ✅ 复审：砚砚 2026-08-26 独立复验通过（P1 门禁 + provider 零调用、合法三态不误杀、freeze FATAL、249/249、git diff --check 干净、fallback 深度 ≤2、hash 覆盖、run 追溯、legacy 字节、report 无联网）；代码待 author git 提交
- 🚫 边界：宏观为新增可证伪证据，不是方向发生器；三字段只作解释审计，不机械覆盖 direction/confidence；scanner/hard-filter/probability/阶段一快照数值不变

### 阶段二交付闭环与定向分析（2026-08-26 晚）
- ✅ 提交 `c0a8a434a`（14 文件：11 M + 3 A，1253+/22-）：阶段二全部实现 + P1 修复 + 43 测试，零夹带（工作区未复审改动全部排除）；merge-gate 流程经历史核查（master 零 merge commit、47 个 futures-radar 提交全部直接落 master）确认本项目惯例为**直接提交 master**，不强制合 main、不走 PR
- ✅ 定向分析 run `20260826-2207-sa2701`（铲屎官点名纯碱 SA2701）：SA2701 确认主力合约（term_structure main=SA2701 1035，contango 2.8%，SA2609 967 / SA2703 1064）；SA2701 干净序列 120 bar 覆盖 price_data/volume_oi（ma20 1026.2 / ma60 1111.18）；FinCoT 推理 short/medium grounded 通过（evidence 4 域引用 + macro 三字段 neutral/false/[macro.DR007]）；概率锥 HV 22.45%（P97.8）3d 95% [985.5, 1087]；报告 4 章产出
- ⚠️ 数据源事件：2026-08-26 22:04 起 sina 榜单/指数类接口（futures_display_main_sina / stock_zh_index_spot_sina）返回空触发探针 fatal；per-symbol 行情接口（futures_main_sina / futures_zh_daily_sina）正常；定向分析绕过探针接口走行情接口完成；宏观锚点 DXY/USDCNH missing、US10Y/SC0 stale（5 锚点 3 可用），报告如实标注未伪造
- 🚫 推送状态（铲屎官 2026-08-26 23:48 决定）：**暂不推送，工作保持本地**。推送至铲屎官仓库 KieranAko/clowder-ai 被 GitHub GH001 硬阻塞——历史提交 `6e7fd9dfb` 引入超限文件（data/simulator-samples.sqlite 1960MB、data/logs/api/api.2026-05-09.1.log 247MB、api.2026-05-12.1.log 109MB，均 >100MB 限制）。解锁需历史改写（filter-repo 删大文件 + force push，提交 hash 全变）或铲屎官手动处理，待铲屎官指示，勿擅自重写历史

### 完整管道 run 20260826-0001-auto（2026-08-27 00:01，远远执行）
- ✅ 铲屎官指示「用新的数据 做纯碱2701完整分析步骤 别跳步」→ 完整管道零跳步跑通：probe→collect（59/59 品种）→macro（5/5 快照）→scan（Top 10）→filter-hard（10 passed/0 rejected）→filter-LLM（SA0 KEEP，9 只点名外降观望）→freeze-packets→FinCoT→assemble→六问→probability→report 5A/5B/5C→publish
- ✅ P0/P1 裁定自动落地验证：freeze-packets 内置 clean series 覆盖（SA2701 120 bars → ma20 1026.2 / ma60 1111.18，series_contract=SA2701 specific_contract），无需手工干预；term_structure contango 2.8% 单一解析点
- ✅ FinCoT short/medium grounded（evidence 4 域 + macro 三字段 neutral/false/[macro.DR007]），packetHash bdc9f383；概率锥 HV 22.4%（P97.8）3d 95% [985.5, 1087] 偏差 0.9%；报告 4 章产出，夜盘确认信息（破 MA20 1026 收 1012 + OI 增 8.6 万手）已融入 Q1/Q3/Q4
- ⚠️ sina 榜单接口限频（2026-08-27 00:00 前后）：连续调用 futures_display_main_sina 触发 456 限频 → 探针 fatal；间隔 ~90s 后自然恢复（验证为瞬时限频，非 22:04 那次接口故障）；完整管道因 probe fatal 中断 2 次（空 run 已清理），重试通过后一次跑通
- ✅ 测试 545/545 全绿（无代码改动，纯运行管道）

### Immediate (Ready to Execute) — 2026-08-14 时点裁定（已被 2026-08-24「当前定位」取代：前向验证工具保留但未启用历史机制）
1. **前向验证（唯一允许的后续动作）:**
   - 工具已就绪：`node experiments/forward-cli.js register <raw> <signalDate>` / `settle` / `status`
   - 冻结已完成（铲屎官 2026-08-14 确认）：manifest 已设 `minimumSignalDate=2026-08-14`、`freezeCommit=7abfaab5...`、`frozenAt=2026-08-14T09:49:06+08:00`
   - 按预声明配置（机会层 ER≥0.20 主 / ER≥0.18 对照；方向层 D0 基线）收集 ≥30 个新配对日期
   - 禁止在同一 29 日期继续调整阈值、窗口或组合（避免二次搜索）

### Future Work (Not Blocking)
- ⏳ Freeze artifact path with SHA-256 hash
- ⏳ Complete production invariants (runId/cohort/chronology)
- ⏳ Forward validation after ≥30 paired dates
- ⏳ P2（宪宪 2026-08-26 提出，作者认领）：analyze→report 边界方向字段校验 fail loud——analysis.json 的 `direction`/`q3_odds.bias` 与 filtered.json 的 `directionBias` 遇非 canonical 值（long/short/pass 等 FinCoT 词汇）应响亮报错，而非 build-model 透传 + render-markdown 静默渲染 '—'。20260826-0908 与 20260826-1341 两轮均已暴露该静默失效（数据侧手工修正 + 报告重生成），代码侧守卫待实现

### 收口状态 (2026-08-13 缅因猫最终复审通过)
- 机会层与方向层离线实验正式收口；D0 为当前样本内最可用方向基线（约 60% 命中率为样本内证据，须经新日期前向验证后才可讨论生产可用性）
- D1-D4 未显示增益且覆盖严重下降，不进入生产候选
- Round 10 已批准、方向层已复审放行；本文件底部不再保留"待 Round 10 回复"状态

---

## Risk Assessment

### High Risk (Blocks Progress)
- **Registry rejection loop:** 8 rounds already, each requiring fundamental redesign
  - Mitigation: Round 8 provided complete architectural decisions, v1.2 should be final
- **Baseline misidentification:** Took 6 rounds to catch, now triple-verified from source code
  - Mitigation: All baseline parameters traced to exact line numbers in PARITY_ASSERTIONS

### Medium Risk
- **Implementation time underestimated:** 32 hours assumes no bugs
  - Mitigation: Build Phase 1 utilities first, test thoroughly before proceeding
- **Coverage failures in discovery run:** Some experiments may fail eligibility
  - Mitigation: Document failures honestly, do not p-hack or retrofit

### Low Risk
- **Forward validation delayed:** Embargo period flexible
  - Mitigation: None needed, validation not time-critical

---

## Key Learnings (Rounds 1-9)

1. **Always verify claims against code:** Don't trust memory or documentation for baseline definition
2. **Read complete pipeline:** Partial understanding led to missing 2 of 4 stages in Round 8
3. **Index ranges need executable assertions:** "T-19:T" ambiguous, `close[-20:]` executable
4. **Enumerate when possible:** 64 patterns is small enough for exact enumeration, no Monte Carlo
5. **Distinguish discovery vs parity:** Fold-specific configs are for parity only, not mixed with experiments
6. **Fixed cohort prevents cherry-picking:** Neutral dates must be retained as return=0
7. **Account-level gate is absolute:** E4b checks viability, not relative improvement
8. **Forward needs both gates:** Statistical test AND economic co-gate must both pass
9. **Exit price semantics matter:** T+11 close vs open changes simulation results
10. **Statistical objects must match scope:** 61 signal-level trades ≠ 44 account-level trades
11. **Window construction is off-by-one prone:** 110 prices → 90 windows, not 91
12. **Percentile edge cases reveal assumptions:** Flat prices → 100 exposes `<=` vs `<` choice
13. **Family statistic order matters:** abs(max(T)) ≠ max(abs(T)) for two-sided tests
14. **P-value should be primary decision:** Quantile is informational, not alternative criterion
15. **Sample vs population variance:** T-test uses n-1, not n
16. **Frozen thresholds prevent post-hoc tuning:** No TBD/X% can remain before opening forward data
17. **Interface contracts prevent mixed inputs:** Unified adapter ensures fair comparison
18. **Enumerate gates to verify coverage:** Generic "margin/position" hides gaps
19. **Calendar handling affects sample size:** Non-trading dates must be recorded, not deleted
20. **Scope claims matter for credibility:** Compatibility gate ≠ OOS validation

---

## Communication Channels

**Primary:** Cat Cafe thread (thread_ms6uiytqz913h82d)  
**Reviewer:** 缅因猫 (@cat-g7k98t5f)  
**Coordinator:** N/A (直接对话)

**Expected Review Turnaround:** 1-2 hours (based on Round 1-9 history)

---

**Final State (2026-08-14):** 实验正式收口。机会层62.0%长期均值（冻结参数维持），方向层D0-D4正式放弃（大样本证伪），Direction V2（ML方向层）终止（Logistic full_acc 50.94%）。项目清理完成（数据归档至experiments-archive/，CLI归档至archive-one-time-scripts/）。实盘暂不启动，前向验证工具就绪。

**End of Status Summary**


