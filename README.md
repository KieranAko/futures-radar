# futures-radar

> **期货短期机会分析 + 离线模型回测** 的 AI Agent Skill。
> 每日扫描约 60 个国内期货主力合约 → 波动率排名 → Top 3 深挖 → 4 章短报告；
> backtest/ 提供 deterministic 批量回测与 LLM replay 回测评估模型表现。
> **所有输出不构成投资建议、不执行真实交易。**

## 特性

- **半自动管道**：`pipeline/run.cjs` 编排 采集→宏观→扫描→硬过滤→概率锥→报告渲染，自动阶段确定性运行，LLM 边界自动停止
- **严格数据纪律**：白名单品种、akshare 主源、provenance 溯源、冻结不变量（完整 bar / 夜盘归属 / 防未来函数）
- **FinCoT 推理层**：evidence packet 冻结 → 三分支蓝图 → 门禁 + grounding 校验（fail-closed 降级）
- **离线回测**：strict no-look-ahead 实现 + LLM replay 评分卡；方向层已被大样本证伪并收口（诚实披露）
- **473 个测试全绿**（84 套件），测试夹具内置、无机器路径依赖

## 目录结构

```
futures-radar/
├── SKILL.md                 # Agent 入口（Claude Code 格式：name + description + 完整指令）
├── README.md                # 本文件
├── package.json             # npm 元数据 + 快捷脚本（type: module）
├── requirements.txt         # Python 依赖（akshare）
├── scripts/install.mjs      # 一键安装到 agent 的 skills 目录
├── pipeline/                # 管道编排（run.cjs + 契约 contracts.cjs）
├── collector/               # 采集（akshare 行情 / 宏观锚点 / 源探测）
├── scanner/                 # 波动率扫描与排名
├── filter/                  # 硬过滤（确定性）+ 软过滤（LLM 蓝图）
├── analyze/                 # evidence packet 冻结 + 结果组装
├── reasoning/               # FinCoT 推理框架（lib + prompts + tests）
├── probability/             # HV 概率锥（Yang-Zhang）
├── report/                  # 报告三段式（facts → model → markdown）
├── backtest/                # 离线回测（deterministic + LLM replay）
├── experiments/             # 已收口实验档案（机会层/方向层结论）
└── config/                  # 品种白名单 / 数据源 / 宏观传导路由
```

## 快速开始

### 1. 前置要求

- **Node.js ≥ 21**（`node --test` glob 支持）
- **Python 3.10+** + akshare：

```bash
pip install -r requirements.txt
```

- （可选）mx-data：Top 3 增强源，需设置 `MX_APIKEY`，并让 `mx_data.py` 位于探测路径或通过 `MX_DATA_PATH` 指定

### 2. 数据源探测（每次启动前）

```bash
node collector/probe-sources.cjs
# ok → 全部可用；degraded → akshare 可用但增强源缺失（可继续）；
# fatal → akshare 不可用，终止（不可手写判断绕过）
```

### 3. 跑雷达

```bash
node pipeline/run.cjs                 # 自动阶段跑到 LLM 边界停止（默认 --from collect）
node pipeline/run.cjs --runId <id> --from probability   # 续跑概率锥+报告
```

管道在 3 个 LLM 边界停下，由 Agent 按 SKILL.md 完成：

1. **filter-llm**：读 `filter/blueprint.md` → 写 `filtered.json`（≤3 KEEP，禁止复活硬过滤剔除项）
2. **analyze**：`node analyze/freeze-packets.mjs --runId <id>` → FinCoT 推理文档 → `node analyze/assemble-results.mjs --runId <id>` → 六问 `analysis.json`
3. **publish**：更新 `<runtimeRoot>/current.md`

### 4. 离线回测

见 `backtest/README.md`（deterministic 批量验证 + LLM replay 评分卡）。

## 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `FUTURES_SKILL_ROOT` | 否 | skill 根目录（默认自动探测：向上找 SKILL.md） |
| `FUTURES_RUNTIME_ROOT` | 否 | 运行产物目录。默认：有项目 package.json 时 `<项目根>/data/futures-radar`；独立安装时 `<skill>/data/futures-radar`（已 gitignore） |
| `MX_DATA_PATH` | 否 | `mx_data.py` 完整路径 |
| `MX_APIKEY` | 否 | mx-data API key |
| `FUTURES_TEST_RAW_JSON` | 否 | 测试用 raw.json（默认内置夹具） |
| `FUTURES_VALIDATION_RUNS_DIR` / `FUTURES_VALIDATION_DELTA_DIR` | 否 | llm-validation 一次性校验脚本的输入目录 |

## 接入你的 Agent

### Claude Code / Claude

```bash
# 方式一：一键安装（Windows 用目录联接，Unix 用软链；失败自动回退复制）
node scripts/install.mjs

# 方式二：手动
#   Windows: mklink /J "%USERPROFILE%\.claude\skills\futures-radar" <本仓库路径>
#   Unix:    ln -s <本仓库路径> ~/.claude/skills/futures-radar
```

安装后直接说：**"跑期货雷达"** / **"/futures-radar"** / **"出期货报告"**。

### Codex / 其他 Agent

```bash
node scripts/install.mjs --target ~/.agents/skills
```

或无需安装：把 `SKILL.md` 全文作为系统指令注入，按本文档的 CLI 命令执行（所有路径以本仓库根目录为基准，脚本自动定位）。

### 作为独立 CLI 使用

```bash
npm run probe      # 源探测
npm run run        # 跑管道
npm test           # 全部 473 个测试
```

## 测试

```bash
npm test                 # 全部套件（test / reasoning / experiments / backtest）
npm run test:reasoning   # FinCoT 推理层
npm run test:core        # 指标与统计核心
```

## 常见问题

- **探针 fatal：sina 456 限流**——akshare 健康检查端点（qihuohangqing.js）被 sina 临时限流，几分钟至十几分钟自动恢复；冷却后重试 `node collector/probe-sources.cjs`，不要绕过探针。采集端（日线 jsonp）与探测端不同端点，通常不受影响。
- **mx-data auth_missing**——未设置 `MX_APIKEY`；Top 3 增强降级为 WebSearch-only，不影响主流程。
- **沙箱/CI 中 spawn EPERM**——受限环境禁止管道捕获子进程输出；管道需要完整权限（本仓库脚本依赖 Node 调用 Python 采集行情）。
- **运行数据在哪**——默认 `<skill>/data/futures-radar/runs/<runId>/`，可 `FUTURES_RUNTIME_ROOT` 重定向（如指向既有历史数据目录）。

## 许可证

[MIT](./LICENSE) © 2026 futures-radar contributors

> ⚠️ **免责声明**：本项目为 AI 生成的投机机会分析工具，不构成投资建议，不执行真实交易。历史回测结果不代表未来表现。
