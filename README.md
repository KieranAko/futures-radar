# futures-radar

> 期货短期机会分析 AI Agent Skill（v2.0.0，故事链 V2.1）。
> 每天产出一份可读、可执行、带证据可信度的期货雷达报告。所有输出不构成投资建议、不执行真实交易。

## 核心思想

V1 的「波动率 Top10 → 软过滤 Top3」已退役。V2 只做一件事：

```
新闻快照 → 故事链推导 → 六问深挖（独立推理 + 链审计） → 交易策略 → 信号入池
```

- **先有信息，再推传导链**：每期先写少而精的新闻/政策快照（agent 现搜现写），LLM 从里面找驱动，构造「资金先动哪里、再流进哪个板块、最后落到哪个品种」的传导链。
- **链首四类合法源**：宏观指标、T2 事件、T2 供需数据、行为-资金流（板块持仓流）；每条链带推理卡，写明主张、逐边机制、证据引用、前提、不确定性和证伪条件。
- **六问两遍，链只作证据**：六问先独立推理（不看链）；审计 LLM 只找语义冲突，把少量追问交给六问；六问第二遍只对冲突品种出修订增量，`auditImpact` 全程留痕。
- **站在趋势里，赚资金流转的钱**：先有故事，再用数据佐证，最后让市场证伪。
- **只要有活跃故事链就深挖**；没有故事链就空仓，不强行找机会。
- **信号池 v6**：信号 = symbol+contract+故事链/主题 的生效观察交易单，T0 永远锚定信号出生日；每轮 run 的新交易单作为同一信号的新报价，只做结构化 diff 与对账 LLM 解释，dashboard 并排展示差异，由人类决定采用/维持/暂停/关闭。

## 六模块

| 模块 | 职责 |
|---|---|
| `stories` | 新闻快照、故事链构造/观察、KEEP 席位生成 |
| `analysis` | 六问两遍、链审计、概率锥、交易策略 |
| `signals` | 信号池：信号身份/T0 锚点、报价 diff、对账 LLM、人类决策回填、质量追踪 |
| `collection` | 数据采集（akshare + Python） |
| `storage` | 文件库（唯一事实源：`data/`，含 `data/news`） |
| `output` | 报告、dashboard 渲染 |

旧代码在 `legacy/`，只读不改。

## 启动

环境要求：Node ≥ 21，Python 可用且已装 akshare。

```bash
npm install
npm run probe            # 探测数据源是否可用
npm run macro:history    # 构建宏观历史序列（故事链指标依赖）
```

## 每日运行

```bash
# 0. 新闻快照：agent 用 WebSearch 现搜现写（少而精），然后安装进文件库
#    写 output/runs/<id>/news-snapshot.json 后执行：
node stories/cli/news-snapshot-cli.cjs install --runId <id>

# 1. 采集/文件库/故事链提示词，停在「故事链登记」
node pipeline/run.cjs --runId <id> --from data-collection
#    LLM 按 story-chain-prompt.md 写 story-chains.json（结构 + reasoningCard）
node stories/cli/story-chain-cli.cjs register --file <json> --batch

# 2. 哨兵观察 + 生成 KEEP 席位
node pipeline/run.cjs --runId <id> --from story-observe

# 3. 六问第一遍：冻结/预填/提示词，停在「LLM 深挖」
node pipeline/run.cjs --runId <id> --from opportunity-analysis
#    LLM 写 output/runs/<id>/analyze/outputs-v2.json

# 4. 链审计：生成对质提示词，LLM 写 audit-findings.json
node pipeline/run.cjs --runId <id> --from analysis-audit-prompt

# 5. 六问第二遍：有冲突品种写修订增量，无冲突写空 revisions
node pipeline/run.cjs --runId <id> --from analysis-reconciliation-prompt

# 6. 组装 + 概率 + 事实 + 模型 + 策略提示词，停在「LLM 策略推理」
node pipeline/run.cjs --runId <id> --from analysis-assemble
#    LLM 写 output/runs/<id>/strategy-reasoning.json 后继续
node pipeline/run.cjs --runId <id> --from strategy-plan

# 7. 渲染报告与四 Tab 看板
node pipeline/run.cjs --runId <id> --from render-markdown
```

每次暂停后，管道会打印下一步续跑命令；`--from` 也接受任意阶段名（如 `story-filtered`、`probability`）。

## 输出

- 报告：`output/runs/<runId>/report.md`（另有 `report.html` 浏览器版）
- 看板：`output/dashboard.html`
  - 🔗 故事池（活跃链、节点进度、席位血缘）
  - 📈 机会分析（六问深挖 + 策略卡 + 可展开的链审计详情）
  - 📊 信号池（全量追踪 + 版本链）
  - 🗂 历史报告

## 状态

- 版本：2.0.0（故事链 V2.1）
- 测试：`npm test`，927/927 通过
- 最新生产运行：`output/runs/20260921-1514-auto/report.md`

## 许可

- **源码**：PolyForm Shield 1.0.0（源码可见、可学习与非商业使用；禁止商业性使用与竞争性使用，详见 `LICENSE`）
- **文档**：CC BY-NC-ND 4.0（署名、非商业、禁止演绎，详见 `LICENSE-DOCS.md`）
- 本仓库是 **source-available**，不是 OSI 定义的开源软件。

---

*免责声明：本项目所有输出均为分析工具产物，不构成投资建议，不执行真实交易。*
