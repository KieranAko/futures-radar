# futures-radar

> 期货短期机会分析 + 实验验证的 AI Agent Skill（v2.0.0）。
> 核心定位：**每天产出一份可读、可执行、带证据可信度的期货雷达报告**；
> 所有输出不构成投资建议、不执行真实交易。

## V2 理念：故事链是唯一入口

V1 的「波动率 Top10 → 软过滤 Top3」筛选已退役。V2 的逻辑矛是：

```
宏观事件/政策 → LLM 推导传导链（故事） → 哨兵逐日监测节点
  → 活跃故事链席位 → 六问深挖 → 交易策略 → 信号池前向验证
```

- **故事链** = 1 主题 + ≥3 节点 + 顺序边 + 1 板块 + 1 代表品种 + 1 方向 + 证明点（2 ≤ p < 节点数）；
- 链首节点必须是**宏观/事件源**，板块成员 <3 时板块指标不可用，SC0 不得以自身价格作故事源；
- 节点**连续 2 个数据日同向才确认**（单日同向/反向均视为扰动；T2 事件快照除外）；
- **只要有活跃故事链就深挖**（resolving/pending/proven 都产生席位）；无故事链则空仓合法；
- filter-llm、Top10 筛选、过滤决策表已从报告与看板删除。

## 单向六段管道（V2）

```
① 抓取数据 → ② 生成故事链 → ③ 机会深挖 → ④ 交易策略 → ⑤ 信号入池 → ⑥ 信号验证
```

| 段 | 谁 | 产物 | 纪律 |
|---|---|---|---|
| ① 抓取 | 采集器 | `data/daily`、`data/macro-history`、板块/宏观快照 | 文件库是唯一事实源，不读 run 产物 |
| ② 故事链 | LLM 构造 + 脚本哨兵 | `data/story-pool/`（ledger/stories/seats） | 一板块一链；注册后不可改；T0/T2 取数路径与可信度正交 |
| ③ 机会深挖 | analyze v2 | `analysis.json` / `report-model.json` | 故事席位全量六问；`storyChainId` 前向盖章 |
| ④ 交易策略 | strategy-reasoning + matcher | `strategy-plan.json` | 定价出自机制模型/结构目标，LLM 不报价 |
| ⑤ 信号入池 | signal-pool | `data/signal-pool/` | executable 入池；watch/skip 只记账 |
| ⑥ 信号验证 | 前向验证 | 信号 verdict/归因 | 验证结果暂不回写故事链（反哺机制留白） |

## 故事链构造器（核心设施）

- `config/story-chain-indicators.json`：T0 指标目录（宏观/板块/品种）
- `strategies/lib/story-chain.cjs`：契约校验、故事池、证明/证伪状态机、席位血缘
- `strategies/lib/story-indicators.cjs`：文件库指标计算（前值/当前值/环比 + asOf）
- `strategies/story-chain-cli.cjs`：`prompt / register / resolve / observe / list / view`
- `strategies/story-pool/build-filtered-from-story-pool.cjs`：**替代 filter-llm**，活跃故事链 + 有血缘追踪信号生成 KEEP 席位
- `strategies/story-pool/apply-story-seats.cjs`：proven 链席位注入（兼容旧流程）
- `strategies/lib/story-chain-prompt.cjs` + `strategies/story-chain-blueprint.md`：状态唤醒提示词与 LLM 操作手册

T2 检索源节点：`resolve --brief` 生成检索任务 → LLM/agent 检索 → `resolve --file` 校验入库；检索失败 `--void` 作废。**取数路径（T0/T1/T2）只是获取优先级，数据可信度（high/medium/low/unknown）独立标注，不改变证明/证伪判决。**

## 数据文件库（唯一事实源）

- 所有指标从 `data/daily` + `data/macro-history` 计算；
- `collector/macro-history-builder.cjs`（`npm run macro:history`）合并冻结宏观历史与生产快照为 `data/macro-history/<ANCHOR>.json`；
- 维护命令：`npm run store:init|seed|verify|stats|export|compact`（见 `data/README.md`）。

## 看板（四 Tab）

`output/dashboard.html` 是日常阅读主界面：

```
🔗 故事池（首位，默认折叠卡片：主题/节点进度/前值→当前值→环比/席位血缘）
📈 机会分析（故事席位六问深挖 + 策略卡；无席位时显示故事池观察清单）
📊 信号池（全量追踪 + 版本链 + 生命周期图）
🗂 历史报告
```

## 运行

```bash
# 1. 前置
npm run probe && npm run macro:history

# 2. 数据采集（自动阶段，停在故事链环节）
node pipeline/run.cjs --runId <id> --from collect

# 3. 故事链构造（LLM 环节）
node strategies/story-chain-cli.cjs prompt --runId <id>
# LLM 按 blueprint 输出 story-chains.json → 注册
node strategies/story-chain-cli.cjs register --file <json> --batch

# 4. 哨兵打卡 + 席位生成（替代 filter-llm）
node strategies/story-chain-cli.cjs observe --runId <id>
node strategies/story-pool/build-filtered-from-story-pool.cjs --runId <id>

# 5. 深挖（LLM 环节，analyze v2）
node analyze/v2/packet-freeze-v2.cjs --runId <id>
node analyze/v2/prefill-v2.cjs --runId <id>
node analyze/v2/prompt-builder-v2.cjs --runId <id>
# LLM 写 outputs-v2.json 后：
node analyze/v2/assemble-v2.cjs --runId <id> --as-production

# 6. 概率/报告
node pipeline/run.cjs --runId <id> --from analyze

# 7. 策略与信号
node strategies/strategy-reasoning-prompt.cjs --runId <id>
# LLM 写 strategy-reasoning.json 后：
node strategies/build-strategy-plan.cjs --runId <id>
node report/render-markdown.cjs --runId <id>
```

## 研究层

- `research/experiments/macro-flow-v1/`：MFLOW-01/02/03 历史验证（单日信号→流状态机→故事代理，全部预注册）；
- `research/backtest/`：离线回测与 LLM replay；
- `research/archive-experiment-line/`：V1 实验线整体归档（镜像/G1/G2/shadow/promote/前向验证历史）。
- `theory-base/`：五份理论吸收报告，遇阻回查。

## 状态与版本

- 版本：**2.0.0**（`VERSION.md` / `package.json` / `SKILL.md` / pipeline banner 一致）
- 测试：**805/805 通过（159 套件）**
- 最新雷达：`output/runs/20260918-1941-auto/report.md`，看板 `output/dashboard.html`

*免责声明：本项目所有输出均为分析工具产物，不构成投资建议，不执行真实交易。*
