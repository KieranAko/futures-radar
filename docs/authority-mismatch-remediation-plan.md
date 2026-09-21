# 权威错位修复计划（四批）

依据：`docs/authority-mismatch-audit.md`（46 项发现，证据行号）。
总则：每条命中只有两个合法出口——
1. **归还 LLM**：删除机器注入；LLM 输出缺失即回问/fail-closed，不给 fallback。
2. **正式归属机器**：字段改名、加 provenance 标记（`deterministic` / `legacy-machine` / `machine-seat`），与 LLM 产物物理分离，不再伪装成 LLM 判断。

执行纪律：
- 每处改动先回读审计文档证据行和源码，凭 `file:line` 动手，不凭记忆。
- 禁止顺手重构无关代码；legacy 路径只加标记，不重写逻辑。
- 每批完成标准：全量 `npm test` 通过、旧回放 golden 测试不漂移、提交推送。
- 每批完成后在审计文档对应条目下追加 `处置: ...` 与提交号。

---

## 批次1 六问层（AUTH-01..08）

目标：机器预填的答案不再冒充 LLM 六问结论；LLM 缺失关键字段时 fail-closed。

| 条目 | 形态 | 处置 |
|---|---|---|
| AUTH-01 Q2/Q6 预填 | C | 拆权：Q6 的数值事实（limitDistance/overnightGap/margin 等）保留引擎产出并标 `deterministic`；Q2 judgment 与 eventRisk 文本归还 LLM 输出，缺失即失败 |
| AUTH-02 prefill 结论注入提示词 | A | prompt-builder 不再贴 q2/q6 结论文本，只给原料数值（MA20/MA60/change5d/volMult 等） |
| AUTH-03 方向必须与 prefill 一致 | B | 删除该约束；LLM 方向与 prefill 结构不一致时由 assemble 回问/fail-closed，不在提示词预绑定 |
| AUTH-04 costAnchorRef 示例硬编码 SA0 路线 | A | 示例改占位符（`<route>`），不出现真实品种路线名 |
| AUTH-05 q4/q5 缺省兜底 | C | 缺 q4/q5 直接失败并要求重跑 LLM，不填 `selected:'long'`/空数组 |
| AUTH-06 neutral→confidence 静默改 low | D | 保留 LLM 原 confidence 到两个产物；neutral+high 由校验器显式报错，不静默改写 |
| AUTH-07 cost-anchor 默认 confidence/status | C | confidence 缺省不预填 low（保留缺失交推导）；status 缺省标 unknown，不默认为 known |
| AUTH-08 pass_reason/mechanismRef 兜底 | C | 加 provenance 标记 `fallback: true` 或 fail-closed（按字段消费方决定） |

验收：
- `npm test` 全绿；v2 测试覆盖"缺 q4/q5 组装失败"。
- 旧 run 回放不漂移（deterministic 测试）。
- `prompts-v2.md` 指令区无成品结论注入。

## 批次2 策略层（strategy-reasoning + ticket/matcher + feedback/signal + rendering）

| 条目 | 处置 |
|---|---|
| SR-B-001/002 表达类型双重俘获 | 删除提示词位置→表达类型映射与校验器 `allowedTypesForPosition`/`typeMatchesAction` 决策表；校验只查 LLM 自述位置与冻结事实的数值一致性，失败回问 |
| SR-B-003 "应为 conditional" | 阈值风险校验保留，错误文案改为回问句式，不再替 LLM 指定表达类型 |
| SR-A-004 输出示例数值 | JSON 结构示例全部占位符 |
| SR-C-005/006 校验器默认值 | confidence/type/direction 缺失 → 失败，不给默认 |
| ST-01 gapThresholdPts 兜底 | validateElements 要求非 neutral 的 abandon 必填且含数字；schema 描述标注 playbook 公式为 legacy fallback |
| ST-02 targets.t2 兜底 | validateElements 要求 t2 非空；elements 路径删除 buildTargets 兜底 |
| ST-03/04/08 执行文案/executionConvention/整计划兜底 | 计划增加 `planMode`（trader-ticket / legacy-reasoning / legacy-deterministic）；elements 路径不再生成机器执行文案；legacy 路径保留但显式标注 |
| ST-05 strategyConfidence 回退 | reasoning 校验强制必填；缺失失败 |
| ST-06 stop.basis 兜底 | elements 路径要求 basis 非空；legacy 保留公式文案并标注 |
| AUTH-C-02 target1 公式回算 | 无法解析目标价 → `unverifiable`，不用 2R 自产目标 |
| AUTH-C-04 gap 阈值回退 | 旧计划缺 gapThresholdPts → 标 `legacy-fallback`，不静默当决策 |
| AUTH-D-03 triggerTiming 覆盖 | 保留"无执行时点/仅观察"语义；缺字段置空并标 unverifiable |
| AUTH-C-05 signal-pool 默认 triggerTiming | 缺省置空/标 unverifiable，不注入 T+1 文案 |
| REND-01 执行口径 | 报告优先渲染 `entry.execution`（LLM）；`playbook.executionConvention` 仅 legacy 且标注"代码模板" |
| REND-02 基差解读句 | 删除代码自产判断句，只渲染事实 |
| REND-03/04/05/06 缺省渲染 | 缺 LLM 字段统一显示 `—`；concreteAtrText 换算保留原式并注明"换算" |

验收：新 run（含 elements）的 plan/report/信号池不再出现机器替 LLM 决策的字段；旧 run 回放字段标注 legacy；`npm test` 全绿。

## 批次3 席位层（stories/signals seats）

| 条目 | 处置 |
|---|---|
| ASM-02/AUTH-D-01 apply-story-seats 写 KEEP | 停用或改造：机器席位写独立 `tracking-seats.json` 或加 `author:'machine-seat'`，禁止混入 LLM 初筛 candidates/downgraded，禁止重算 outputCount |
| ASM-03 build-filtered 整表重写 | filtered.json 声明为确定性产物（`meta.author:'deterministic-seats'`），candidate 加 provenance；下游不再把它当 LLM 初筛展示 |
| ASM-04 席位字段默认值 | 方向缺失跳过/显式失败；confidence 缺失置 null，不用 'medium' 冒充 |
| ASM-05 sourceTier 默认 C | 缺失/非法 → 拒绝解析或 `tierWasDefaulted` 标记，回问研究员 |
| ASM-06 maxFreshDays 默认 7 | 契约要求显式；缺失告警并记录 `maxFreshDaysDefaulted` |
| ASM-01 故事提示词完整示例 | 示例改占位骨架，完整示例移入测试 fixture |

验收：filtered.json 与 LLM 产物可区分；席位注入不改变 LLM 决策字段；`npm test` 全绿。

## 批次4 legacy/research（AM-*）

只加 provenance/告警，不重写历史逻辑：
- AM-01 grounding 降级：加 `originalGrounding` 与 `degraded:true`，不再伪装 grounded=true；改不改行为待回测决定，本批只标记。
- AM-02 FinCoT 门禁：提示词加"门禁为约束，最终判断由 LLM 说明理由"；解析器冲突时保留原文并回问标记。
- AM-03/04/06/07：缺失字段加 `legacy-default:true` / 占位标记。
- AM-05：示例占位符化。

验收：legacy 测试不漂移；新标记出现在输出中。

---

## 批次顺序与依赖

1. 批次1（六问层）无上游依赖，先做。
2. 批次2 依赖批次1 的 provenance 约定（planMode 等），随后做。
3. 批次3 独立，可与批次2 并行，但同一批内先停用 apply-tracking-seats 再改 build-filtered。
4. 批次4 最后，只打标记。
