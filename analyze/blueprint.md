# Analyze Blueprint v2 — 单轮合并推理（promote 自实验线 analyze candidate v2）

> Stage: 4 (after filter-llm) | Type: LLM manual | 输出：analysis.json + reasoning-results.json + sector-driver.json
> 旧版（多轮：freeze-packets → sector-driver LLM → FinCoT → 六问）归档于 blueprint-legacy.md。

## 流程（2 次逻辑 LLM 调用）

1. 自动：`node analyze/v2/packet-freeze-v2.cjs --runId <runId>`（确定性冻结：价格/量/OI/期限结构(GA-8)/宏观/板块/机制候选/昨日结论缓存）
2. 自动：`node analyze/v2/prefill-v2.cjs --runId <runId>`（Q2/Q4/Q5/Q6 确定性预填）
3. 自动：`node analyze/v2/prompt-builder-v2.cjs --runId <runId>`（生成 prompts-v2.md）
4. LLM：按 prompts-v2.md 执行 P1 板块批量 + P2 品种批量，一次输出写 `analyze/outputs-v2.json`
5. 自动：`node analyze/v2/assemble-v2.cjs --runId <runId> --as-production`（组装生产兼容六问 + grounding/等价性校验 + sector-driver.json）

## 纪律（继承自 FinCoT v5 与 v6）

- evidenceCheck.evidenceIds 只能引用 packet 字段；grounding fail-closed；
- 方向必须与 prefill 结构一致或显式 override；pass→neutral 且注明原因；
- 机制候选来自实验线 registry；机制目录为空时 matchStatus=unknown；
- 输出不构成投资建议；不新增数据源、不联网。
