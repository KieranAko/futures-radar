# futures-radar

> 期货短期机会分析 AI Agent Skill（v2.0.0）。
> 每天产出一份可读、可执行、带证据可信度的期货雷达报告。所有输出不构成投资建议、不执行真实交易。

## 核心思想

V1 的「波动率 Top10 → 软过滤 Top3」已退役。V2 只做一件事：

```
数据采集 → 故事链推导 → 全链深挖 → 交易策略 → 信号入池
```

- **故事链是唯一入口**：LLM 从宏观事件/政策推导传导链（主题 + ≥3 节点 + 板块 + 代表品种 + 方向），哨兵用文件库数据逐日验证节点。
- **站在趋势里，赚资金流转的钱**：先有故事，再用数据佐证，最后让市场证伪。
- **只要有活跃故事链就深挖**；没有故事链就空仓，不强行找机会。
- **信号池闭环**：策略 executable 才入池，后续逐日前向验证；验证结果暂不回写故事链。

## 六模块

| 模块 | 职责 |
|---|---|
| `stories` | 故事链构造、哨兵观察、KEEP 席位生成 |
| `analysis` | 六问深挖、概率锥、交易策略 |
| `signals` | 信号池入池/追踪/出池 |
| `collection` | 数据采集（akshare + Python） |
| `storage` | 文件库（唯一事实源：`data/`） |
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
# 1. 自动跑完采集/文件库/故事链提示词，停在「故事链登记」
node pipeline/run.cjs --runId <id> --from data-collection

# 2. LLM 登记故事链（先读 output/runs/<id>/story-chain-prompt.md）
node stories/cli/story-chain-cli.cjs register --file <json> --batch

# 3. 哨兵观察 + 生成 KEEP 席位
node pipeline/run.cjs --runId <id> --from story-observe

# 4. 深挖：冻结/预填/提示词，停在「LLM 深挖」
node pipeline/run.cjs --runId <id> --from opportunity-analysis
#    LLM 按提示写 output/runs/<id>/analyze/outputs-v2.json 后继续
node pipeline/run.cjs --runId <id> --from analysis-assemble

# 5. 策略：概率/事实/模型/策略提示词，停在「LLM 策略推理」
node pipeline/run.cjs --runId <id> --from strategy-reasoning-prompt
#    LLM 写 output/runs/<id>/strategy-reasoning.json 后继续
node pipeline/run.cjs --runId <id> --from strategy-plan

# 6. 渲染报告与四 Tab 看板
node pipeline/run.cjs --runId <id> --from render-markdown
```

每次暂停后，管道会打印下一步续跑命令；`--from` 也接受任意阶段名（如 `story-filtered`、`probability`）。

## 输出

- 报告：`output/runs/<runId>/report.md`（另有 `report.html` 浏览器版）
- 看板：`output/dashboard.html`
  - 🔗 故事池（活跃链、节点进度、席位血缘）
  - 📈 机会分析（六问深挖 + 策略卡）
  - 📊 信号池（全量追踪 + 版本链）
  - 🗂 历史报告

## 状态

- 版本：2.0.0
- 测试：`npm test`，825/825 通过
- 最新生产运行：`output/runs/20260920-1606-auto/report.md`

---

*免责声明：本项目所有输出均为分析工具产物，不构成投资建议，不执行真实交易。*
