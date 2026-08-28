# futures-radar

> 期货短期机会分析 + 实验验证的 AI Agent Skill（v1.0.0）。
> 核心定位：**每天产出一份可读、可执行、带证据可信度的期货雷达报告**；
> 所有输出不构成投资建议、不执行真实交易。

## 项目由两条线组成

```
futures-radar
├── 生产线（production）     每日自动/半自动跑，产出当日雷达报告
├── 实验线（experiment-line） 生产线的完整映射（测试版本），做前瞻实验并整段搬回生产
└── 理论库（theory-base）    四条理论吸收报告，项目遇阻时回查
```

## 一、生产线：每日期货雷达

**流程**：`采集 → 扫描 → 硬过滤 → 软过滤 → FinCoT 分析 → 概率锥 → 报告 → 策略板块`

1. **采集**：akshare 主源，约 60 个国内期货主力合约，provenance 溯源 + 完整 bar 纪律；
2. **扫描/过滤**：波动率与流动性排名，硬过滤确定性执行，软过滤按五条标准选出 ≤3 个 KEEP；
3. **分析（FinCoT v2）**：证据 packet 冻结 → 单轮合并推理（2 次逻辑 LLM 调用）→ 六问输出（驱动/结构/赔率/确认/失效/风险）+ 机制族引用 + selfCheck；
4. **概率锥**：Yang-Zhang HV 的 3d/5d 68%/95% 区间 + ATR 通道对照；
5. **报告**：市场雷达（宏观/板块）→ 候选筛选 → Top3 六问深挖 → 今日不做什么 → 交易策略板块。

**策略板块（给人做判断参考的核心）**：
- 每条策略含锚定合约、触发价、止损、目标、仓位、失效条件；
- **可信度评级（A/B/C/D）** = 族级证据 × 状态匹配 × 实现保真，缺一层强制降档并写明原因；
- 前向验证：回显上一期计划的实际验证状态；
- 板块集中度提示与族级证据状态。

**运行**：

```bash
node pipeline/run.cjs                          # 采集 → 软过滤前停止
node pipeline/run.cjs --runId <id> --from filter   # 完成软过滤后继续
# analyze 按 analyze/blueprint.md 的 v2 单轮流程执行
node analyze/v2/assemble-v2.cjs --runId <id> --as-production
```

## 二、实验线：生产线的完整映射

实验线是生产线的**测试版本**：同一管道蓝图、同代码，差异只在启用的配置集合。
前瞻实验在实验线整链做，验证通过后以"环节段"为单位整段搬回生产（promote）。

核心设施（`experiment-line/`）：

| 设施 | 作用 |
|------|------|
| `mirror.cjs` | 管道镜像 + stable 回放基线（生产 run 逐字节复现） |
| `g1.cjs` / `g2.cjs` | 机制命题检验漏斗：最便宜实验先行，G1 不过不进 G2 |
| `evidence/` + `evidence-ledger.md` | 族级证据账本（carry/momentum/value/event…） |
| `trust-model.cjs` | 三层可信度模型（与报告策略板块同源） |
| `shadow.cjs` / `promote.cjs` | 影子快照（不可变）+ promote/revert 账本 |
| `forward-verify.cjs` | 前向验证：用后续行情审判往期计划 |
| `registry-src/` | 机制预注册条目（theoryRef + 可证伪命题 + 判决规则） |

**状态**：镜像回放 14/14 一致；carry 族 3 个预注册形态 G1 关闭；analyze candidate v2 已 promote 回生产。

## 三、理论库

`theory-base/` 四份吸收报告（精读吸收 + 自洽性检验 + 项目相关性检验，不含运行建议）：

1. Chan《Quantitative Trading》——研究业务理论（流程层）；
2. 期限结构理论（Kaldor→Working→Fama-French→GHR）——期货第一性（内容层）；
3. Carver《Systematic Trading》——系统化交易（结构层）；
4. Ilmanen《Expected Returns》——收益来源统一理论（来源层）。

**使用规则**：项目遇到问题、没有解决方案时 → 查理论库找相关理论依据 → 设计解决方案。

## 四、关键纪律

- 数据：白名单品种、PIT/无未来函数、provenance 溯源、冻结不变量；
- 分析：证据 packet 冻结，LLM 只消费 packet 字段，grounding fail-closed；
- 策略：定价出自机制模型，不使用 FinCoT 自报价位；无收益/胜率承诺；
- 可信度：证据不足就降档标注，不虚报；
- 实验：判决规则预注册，便宜证伪优先，pending 限轮退役。

## 五、目录结构（核心）

```
futures-radar/
├── pipeline/            # 生产线编排与阶段契约
├── collector/ scanner/ filter/ analyze/ probability/ report/ strategies/
│                        # 生产线各环节实现（analyze/v2 为当前稳定配置）
├── experiment-line/     # 实验线（镜像/G1/G2/证据/可信度/影子/promote/前向验证）
├── theory-base/         # 理论库四份吸收报告
├── data/                # 日线/板块/宏观/基差等数据资产
├── test/                # 669 个测试（126 套件）
└── SKILL.md             # Agent 入口
```

## 六、状态与版本

- 版本：**1.0.0**（`VERSION.md` / `package.json` / `SKILL.md` / pipeline banner 一致）
- 测试：**669/669 通过（126 套件）**
- 报告样例：`experiment-line/examples/report-experiment-20260828.md`

*免责声明：本项目所有输出均为分析工具产物，不构成投资建议，不执行真实交易。*
