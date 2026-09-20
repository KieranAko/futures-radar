# strategies/ — 交易策略板块研究区

> 本目录服务于团队目标：为 futures-radar 报告新增「交易策略板块」。
> 研究产出 → 统一策略库 → 基于报告全文为 TOP3 适配可执行策略 → 报告集成与验证。

## 目录结构

```
strategies/
├── README.md                          # 本文件：结构说明与通用约定
├── research/                          # 四路并行调研（t1-t4）
│   ├── execution-playbooks.md         # [trader] 可执行交易 playbook 库（8 个，规则可量化）
│   ├── macro-strategies.md            # [macro-strategist] 宏观/regime 级策略调研（t1，7 条）
│   ├── category-strategies.md         # [category-analyst] 细分品类策略调研（t2，8 条）
│   └── risk-framework.md              # [risk-expert] 交易风险管理框架（t4）
├── strategy-library.json              # [strategy-architect, t5] 统一策略库 schema v1.0（机器可读单一事实来源）
├── strategy-library.md                # [strategy-architect, t5] 策略库可读说明
├── strategy-matching-rules.json       # [strategy-architect, t6] TOP3 确定性匹配规则（计分/playbook 门/风控层/集中度仲裁/验收标准 AC-1~8 + 20260827-1910-auto 实值推演）
├── report-strategy-section.md         # [strategy-architect, t7] 报告「交易策略板块」契约（strategy-plan.json schema/渲染规则/插入点/免责与边界）
# 后续阶段由 strategy-architect 生成（t8-t9/t12）：
#   strategy-matcher.cjs（实现，t8）    # 匹配引擎（消费 library + matching-rules，产出 strategy-plan.json）
#   report/strategy-plan.schema.json    # [t7 已产出] strategy-plan.json v1.0 机器可读 schema
#   report/render-strategy-section.cjs  # [t9] 板块渲染器；futures-radar/test/ 下为回归测试（t12）产物
```

## 现有研究文档

### `research/execution-playbooks.md`（trader，t3）

从资深期货交易员视角的 8 个可执行 playbook，每个均含：入场触发 / 止损 / 目标 / 加减仓 / 时间框架 / 方向适配 / 可证伪失效条件 / 证据来源：

| ID | 名称 | 类型 | 证据级别 |
|----|------|------|---------|
| PB-01 | 趋势动量延续 | 动量/突破 | A−（内部样本内正向 + 外部文献） |
| PB-02 | Donchian 通道突破（海龟式） | 突破 | B−（经典但内部初步证伪，默认停用） |
| PB-03 | 回踩趋势延续 | 回踩/趋势延续 | B |
| PB-04 | 波动率压缩→扩张爆发 | 突破/波动率 | C |
| PB-05 | 均值回归 | 均值回归 | C |
| PB-06 | 区间/箱体边界交易 | 区间 | C |
| PB-07 | 事件后确认 | 事件驱动 | B |
| PB-08 | 概率锥区间管理 | 统计区间 | B− |

### `research/macro-strategies.md`（macro-strategist，t1）

宏观/regime 级成熟策略调研（7 条）：时间序列动量/趋势跟踪、风险偏好 regime、宏观 carry、波动率目标、增长-通胀象限、宏观事件驱动、板块轮动。每条含适用市场状态、入场/退出、风险规则、适用品种类型、失效条件、成熟度与局限、证据来源 URL；§0 提供与 futures-radar 报告 artifacts 的映射约定（供 strategy-matcher 使用）。

### `research/category-strategies.md`（category-analyst，t2）

细分品类适用策略调研（8 条）：期限结构/展期收益、季节性、产业驱动、价差等。每条含适用板块（编码与 `futures-radar/config/symbols.json` 一致：black/nonferrous/precious/energy_chemical/agriculture/new_materials/shipping）、可量化适用条件、失效条件、入场/退出概要、报告字段映射（report-model.json / sector-snapshot.json / sector-driver.json / macro-snapshot.json）、证据来源 URL、成熟度、局限。

### `research/risk-framework.md`（risk-expert，t4）

交易风险管理框架：7 个风控组件（单笔风险上限 / 波动率目标仓位 / ATR 止损 / 最大回撤阶梯 / 相关性与板块集中度 / 事件风险 / 失效退出）+ 中国期货市场结构硬约束（保证金·涨跌停·夜盘·换月·长假提保）+ 确定性仓位公式（§9，供 matcher 实现）+ 真实 run（20260827-1910-auto）推演示例。要点：

- 手数 = `min(风险预算手数, 波动率目标手数, 保证金手数)`；保证金只是安全上限，手数几乎总由风险预算/波动率目标决定；
- 默认参数集：单笔风险 ≤1%（medium 置信 ×0.75）、组合风险 ≤2.5%、单仓波动率目标 10%、止损 K=1.5–2.0×ATR5 且 ≤0.8×涨跌停幅度、保证金占用 ≤33%、持有 ≤5 天、同板块最多 1 个可执行计划；
- 观察/跳过也是合法输出（10 万权益示例下 EG0/PX0 因波动率目标与尾部风险降级为观察），不得为凑策略数放松参数；
- 不承诺收益、不使用持仓分析、不新增数据源，参数以交易所当日公告为准。

## 统一策略库（t5 已产出）

### `strategy-library.json`（机器可读，schema v1.0.0）

四路研究收敛为 **23 条策略 + 风控 overlay + plan 产出契约**：

- **7 宏观**（MS-01~07，id 归一自 research 文档）：时间序列动量 / 风险偏好 regime / carry(标签) / 波动率目标(overlay) / 增长-通胀象限 / 宏观事件驱动 / 板块轮动；
- **8 品类**（CS-01~08）：期限结构 / 季节性 / 产业利润成本 / 跨品种价差 / 库存周期 / 供给冲击确认跟随 / 贵金属实际利率 / 航运脉冲回归；
- **8 执行**（PB-01~08，含参数表）：PB-02 Donchian 因样本内证伪默认 `disabled`；
- **风控 overlay**（RK-01~07 + 市场结构硬约束）+ `riskConfig`（23 键，与 risk-framework §0/§9 数值一致）+ `positionSizing` 确定性公式；
- `fieldCatalog` 登记全部允许读取的 artifacts 字段路径；`matchOpVocabulary` 定义确定性匹配操作符；
- `planSchema` 固化**队长裁定**：每个 TOP3 ≥1 个 matchedStrategy；每个 plan 必含 riskAssessment 与 executionStatus（executable|watch|skip + 原因）；同板块同向集中度冲突保留一个 executable、其余 watch；
- 证据 URL 共 64 条，全部可溯源；无收益承诺。

### `strategy-library.md`（可读说明）

匹配管线（方向匹配 → playbook 选择 → 风控 overlay → 集中度仲裁）、条目 schema 说明、数据纪律与边界声明。

## 全库通用约定（各研究文档与后续整合必须遵守）

1. **可证伪**：每条规则必须可被回测推翻（给出交易级失效条件 + playbook 级停用标准）。
2. **可量化**：所有阈值给出默认数值并声明"待标定参数"；禁止"适当""酌情"类模糊词。
3. **数据口径对齐**：符号与 futures-radar 报告字段一一对应（ATR5、MA20/60、HV%ile、3d/5d 概率锥 p68/p95、量比、OIΔ、Vol%ile、板块广度等，定义见 execution-playbooks.md §0.1）。
4. **成本口径**：往返 ≈0.07%（佣金万三双边 + 滑点万二双边）；保证金 5%-15%。
5. **证据分级**：
   - **A**：本仓库样本内回测正向 + 外部学术/行业文献；
   - **B**：经典文献 + 行业通行实践，本仓库未直接验证；
   - **C**：假设性，未回测，必须在 `futures-radar/research/backtest/` 框架下验证后升级。
6. **内部证据诚实披露**：引用本仓库回测时必须标注"样本内探索性，无样本外预测能力"；已知反面证据必须写入对应策略（如 Donchian 失败、方向预测 50.94% 终止）。
7. **方向标签纪律**：radar「方向」只作过滤，不作入场理由。
8. **免责声明**：所有文档不构成投资建议、不执行真实交易。
