# 权威错位（Authority Mismatch）全项目审计报告

- 生成方式：由 workflow `authority-mismatch-audit` 返回结果程序化转写，证据为子代理引用原文，未做改写。
- 核验状态：high 级证据由主代理抽查原文确认（表中标 ✅）；medium/low 为子代理报告，实施前须回读文件复核。
- 审计定义：名义上由 LLM 完成的推理/决策字段，实际取值被固化代码通过 A 预答泄漏 / B 模板规定 / C 兜底侵占 / D 事后篡改 决定，且下游仍当作 LLM 判断使用。
- 合法边界：冻结事实、标注为计算值的算术、解空间约束、只校验并回问、按契约数值回放、逐字渲染。

## 统计

- 违规发现：46 条
- 按形态：A 预答泄漏 6；D 事后篡改 8；混合 1；C 兜底侵占 26；B 模板规定 5
- 按严重度：high 15；medium 16；low 15
- 合法对照：14 条

## 处置路线（四批）

1. **批次1 六问层**：AUTH-01..08（prefill-v2 / assemble-v2 / prompt-builder-v2 / cost-anchor-extract）。
2. **批次2 策略层**：strategy-reasoning 提示词与校验器、strategy-matcher 兜底、feedback/signal-pool 兜底、render-strategy-section 执行口径。
3. **批次3 席位层**：apply-story-seats / apply-tracking-seats / build-filtered-from-story-pool 的机器席位与 LLM 初筛产物物理分离。
4. **批次4 legacy/research**：AM-* 仅加 provenance/legacy 标签与告警，不重写历史逻辑。

处置规则：每条命中只有两个合法出口——**归还 LLM**（删除注入，缺失即回问）或**正式归属机器**（字段改名、加 provenance、与 LLM 产物分离）。

---

## stories

> 已逐文件审计 stories/lib/story-chain-prompt.cjs、stories/lib/story-chain.cjs、stories/lib/story-indicators.cjs、stories/cli/story-chain-cli.cjs、stories/seats/apply-story-seats.cjs、stories/seats/build-filtered-from-story-pool.cjs、stories/seats/link-signal-pool.cjs 共 7 个文件（2643 行）。发现 6 条权威错位问题（2 high、2 medium、1 low 中 ASM-03 为 high）：(1) 提示词内嵌完整决策示例，LLM 可直接复述；(2) apply-story-seats 在 LLM 写完 filtered.json 后追加机器自产的 KEEP 候选并静默改写 downgraded/outputCount；(3) build-filtered-from-story-pool 完全用代码重写 filtered.json，decision/confidence/reason 全部机器预置；(4) 同一文件对信号池席位 confidence 缺失时兜底 'medium'、方向非 bearish 一律 bullish；(5) resolveChain 对 LLM/研究员漏给 sourceTier 静默兜底 'C'；(6) dataPlan.maxFreshDays 缺失时引擎默认 7 天。story-indicators.cjs、story-chain-cli.cjs、link-signal-pool.cjs 与 LLM 无直接交界或为确定性计算/回链，未发现错位；其中 story-indicators 的 direction=sign(value) 与 story-chain 的 deriveCredibility 属明确标注的计算值，列为合法对照。

### ASM-01 ✅ — high · A 预答泄漏

- **字段/提示词**：提示词输出契约示例中的 theme/themeDetail/sourceId/nodes/edges/impactRationale/priority/proofIndex/latencyDays
- **位置**：`stories/lib/story-chain-prompt.cjs:116-129`
- **证据**：
  ```
  stories/lib/story-chain-prompt.cjs:116 `"sourceId": "macro.SC0.change5d"`；117 `"theme": "原油坍塌的能化传导"`；118 `"themeDetail": "SC0 成本坍塌向能化与航运成本传导，燃料油补跌尚未走完"`；123 `{ "id": "n3", "indicatorId": "symbol.FU0.price.ret5d", "expectation": -1, "label": "燃料油补跌", "terminal": true, "priority": "primary", "impactRationale": "燃料油对 SC0 成本弹性最大，且前期跌幅滞后，补跌空间最大", "proofIndex": 2 }`；127 `{ "id": "e1", "from": "n1", "to": "n2", "latencyDays": 5, "logic": "原油下跌→能化资金流出" }`
  ```
- **处置建议**：示例只应展示 JSON 骨架（占位符 theme/themeDetail、空泛 indicatorId），删除具体决策内容；或把该完整示例移到校验测试 fixture，不进提示词。删除测试：删掉 LLM，示例本身就是一份可注册的链；换脑测试：不同模型大概率复述同一示例。

### ASM-02 ✅ — high · D 事后篡改

- **字段/提示词**：filtered.json 的 candidates[].decision/confidence/reason/directionHint/directionBias 及 meta.outputCount/downgraded
- **位置**：`stories/seats/apply-story-seats.cjs:74-79,88-97`
- **证据**：
  ```
  stories/seats/apply-story-seats.cjs:74-79 `directionHint: hint, directionBias: hint, decision: 'KEEP', confidence: chainConfidence(chain), reason: chainReason(chain), informationGap: '故事传导链追踪席位：需与 TOP3 同规格完整再分析'`；88-97 `const nextDowngraded = downgraded.filter((d) => { if (added.includes(d.symbol) || candidateSymbols.has(d.symbol)) return false; return true; }); filtered.candidates = candidates; filtered.downgraded = nextDowngraded; ... filtered.meta.outputCount = candidates.filter((c) => c.decision === 'KEEP').length;`
  ```
- **处置建议**：这些席位如确属确定性注入，应使用独立字段（如 source:'story-seat'）并保留 LLM 原稿，不得混入 candidates[] 的 LLM 决策字段；或把品种交给再分析链路让 LLM 重写 decision/confidence/reason。冲突处理测试：代码与 LLM 初筛冲突时静默删除 downgraded 条目、重算 outputCount，属典型事后篡改。

### ASM-03 ✅ — high · mixed（多形态）

- **字段/提示词**：filtered.json 的 candidates[].decision/confidence/reason/informationGap（故事席位整表重写）
- **位置**：`stories/seats/build-filtered-from-story-pool.cjs:121-126`
- **证据**：
  ```
  stories/seats/build-filtered-from-story-pool.cjs:121-126 `directionHint: primary.direction === -1 ? 'bearish' : 'bullish', directionBias: primary.direction === -1 ? 'bearish' : 'bullish', decision: 'KEEP', confidence: 'medium', reason: `故事传导链席位：${refs.map((r) => `${r.chainId}${r.branchId ? '/' + r.branchId : ''}(${r.status})`).join('、')}`, informationGap: '故事传导链席位：只要有故事链即完整六问深挖'`
  ```
- **处置建议**：该文件虽声明 filter-llm 已退役，但 filtered.json 的 decision/confidence/reason 仍以 LLM 初筛产物形态被下游消费。应把机器席位与 LLM 决策字段物理分离（独立文件或 source/author 标记），或让 LLM 对席位品种执行真正的 KEEP/降级判断后再写回。

### ASM-04 ✅ — medium · C 兜底侵占

- **字段/提示词**：filtered.json 追踪席位的 candidates[].directionHint/directionBias/confidence/decision
- **位置**：`stories/seats/build-filtered-from-story-pool.cjs:45-50`
- **证据**：
  ```
  stories/seats/build-filtered-from-story-pool.cjs:45-50 `directionHint: sig.direction === 'bearish' ? 'bearish' : 'bullish', directionBias: sig.direction === 'bearish' ? 'bearish' : 'bullish', decision: 'KEEP', confidence: cur && ['high', 'medium', 'low'].includes(cur.confidence) ? cur.confidence : 'medium', reason: `信号池追踪席位 ${sig.signalId}：入池 ${sig.createdDate}，${sig.thesis || '品种机会持续追踪'}`
  ```
- **处置建议**：sig.direction 非 'bearish' 时被静默当作 'bullish'，cur.confidence 缺失时兜底 'medium'，均属机器默认值进入决策字段。应改为方向缺失即跳过或显式失败，confidence 缺失置 null 并在下游另行处理，而非用 'medium' 冒充判断结果。

### ASM-05 — medium · C 兜底侵占

- **字段/提示词**：T2 检索结果的 sourceTier（研究员/LLM 应提供的 S/A/B/C 来源层级）
- **位置**：`stories/lib/story-chain.cjs:824`
- **证据**：
  ```
  stories/lib/story-chain.cjs:824 `const tier = VALID_TIERS.includes(e.sourceTier) ? e.sourceTier : 'C';`（上游 generateResolveBrief 在 brief.note 中要求“来源必须带 URL 与层级 S/A/B/C”；此处缺失/非法时静默降为 'C' 入库）
  ```
- **处置建议**：sourceTier 缺失或非法时应拒绝该条解析结果并回问研究员，或至少在 resolution 中记录 tierWasDefaulted=true；'C' 会继续流入 deriveCredibility 影响 high/medium/low 判定，不能让默认值伪装成研究员评级。

### ASM-06 — low · C 兜底侵占

- **字段/提示词**：LLM 构造链时 dataPlan.maxFreshDays（T2 数据新鲜度窗口）
- **位置**：`stories/lib/story-chain.cjs:29,167-168,772,937,1188`
- **证据**：
  ```
  stories/lib/story-chain.cjs:29 `const DEFAULT_T2_MAX_FRESH_DAYS = 7;`；167-168 `const mf = dp.maxFreshDays ?? DEFAULT_T2_MAX_FRESH_DAYS; if (!Number.isInteger(mf) || mf < 1 || mf > 30) errors.push(...)`；772/937/1188 `const maxFresh = (node.dataPlan && node.dataPlan.maxFreshDays) || DEFAULT_T2_MAX_FRESH_DAYS;`
  ```
- **处置建议**：dataPlan 是 LLM 对概念化节点的数据计划，maxFreshDays 缺席时引擎直接套用 7 天并继续走状态机。建议在契约中要求 T2 节点显式给 maxFreshDays，或对缺席值发出告警并记录 default 来源，避免把引擎默认值算作 LLM 计划的一部分。

### ALLOWED-01 — info · 合法对照

- **字段/提示词**：指标 direction 字段（sign(value) 计算值）
- **位置**：`stories/lib/story-indicators.cjs:11,30,207,252`
- **证据**：
  ```
  stories/lib/story-indicators.cjs:11 `//   direction = sign(value)`；30 `function sign(v) { if (!Number.isFinite(v) || v === 0) return 0; return v > 0 ? 1 : -1; }`；207/252 `direction: sign(cur.value)` / `direction: sign(oi.value)`
  ```
- **处置建议**：合法对照：direction 是标注为计算值的算术字段，所有权明确在计算器，不是 LLM 决策字段。

### ALLOWED-02 — info · 合法对照

- **字段/提示词**：节点可信度 credibility（脚本标注的计算字段）
- **位置**：`stories/lib/story-chain.cjs:5,771-782`
- **证据**：
  ```
  stories/lib/story-chain.cjs:5 `//   脚本：合法性校验、数据源解析（T0/T1/T2）、可信度标注、逐日观测、`；771-782 `if (r.path === 'T0') return 'high'; ... if (tier === 'S' || tier === 'A') { if (fresh && independent >= 2) return 'high'; if (fresh) return 'medium'; return 'medium'; } if (tier === 'B') return fresh ? 'low' : 'unknown'; return 'unknown';`
  ```
- **处置建议**：合法对照：credibility 在文件头被明确标注为脚本职责，由来源层级/新鲜度/独立性机械导出，属标注为计算值的字段，不构成权威错位。

## analysis-v2-and-assembly

> 审计覆盖 analysis/v2 与 analysis/assembly 全部指定文件。核心结论：v2 链路存在系统性权威错位——Q2/Q6 被 prefill-v2 确定性预填并在 assemble-v2 中直接作为六问结果输出（删除 LLM 不变）；prompt-builder-v2 把预填答案注入提示词并要求方向与 prefill 结构一致；assemble-v2 对缺失 q4/q5 提供机器兜底（selected:'long'）、对 pass/neutral 静默把 confidence 改写为 low；cost-anchor/extract.cjs 对 confidence 默认填 low。consistency.cjs 无 LLM 交界；packet-freeze-v2.cjs 为确定性冻结（含 labeled 的历史结论上下文，未强制一致，未列问题）；build-facts.cjs 为确定性事实装配与逐字透传；build-model.cjs 只做 canonical 校验与结构搬运；sector-driver-lib.cjs 为 prompt 渲染与 fail-loud 校验；stage-4-5.cjs 为纯计算（volatilityRegime/cone 等标注为计算值），均未发现需上报的权威错位。另附 2 条 allowed 对照（Q4 语义校验 fail-closed、波动率 regime 计算）。

### AUTH-01 ✅ — high · C 兜底侵占

- **字段/提示词**：q2_trendOrImpulse.judgment 与 q6_risks 全部字段
- **位置**：`analysis/v2/prefill-v2.cjs:40-72; analysis/v2/assemble-v2.cjs:235-249`
- **证据**：
  ```
  prefill-v2.cjs:40-41 `const judgment = alignedUp ? 'trend' : alignedDown ? 'trend' : Math.abs(chg5) >= 2 ? 'impulse' : 'chop';`；prefill-v2.cjs:65-72 用 contractValue/marginRange/overnightGap/limitDistance 填满 q6；assemble-v2.cjs:235-240 `q2_trendOrImpulse: { judgment: pf.q2.judgment, volumeConviction: pf.q2.volumeConviction, oiStructure: pf.q2.oiStructure, priceAlignment: pf.q2.priceAlignment, }`、:244-249 `q6_risks: { limitDistance: pf.q6.limitDistance, overnightGap: pf.q6.overnightGap, margin: ..., eventRisk: o.q1_driver?.primary || '—', tailGap3d: pf.q6.tail3dP95ReversePct, }`
  ```
- **处置建议**：删除 LLM 环节后 Q2/Q6 当前值完全不变，已命中删除测试。应把 Q2/Q6 从“LLM 六问”契约中拆出并在 provenance 标注 deterministic，或让 LLM 基于原料数据自行产出/复核 Q2/Q6，而不是直接引用 prefill。

### AUTH-03 ✅ — high · B 模板规定

- **字段/提示词**：direction 字段被约束为必须与机器 prefill 结构一致
- **位置**：`analysis/v2/prompt-builder-v2.cjs:98`
- **证据**：
  ```
  `L.push('约束：evidenceCheck.evidenceIds 只能引用 packet 字段；方向必须与 prefill 结构一致或显式说明 override；...');`
  ```
- **处置建议**：direction 是 LLM 的核心决策字段，不应要求它与机器 prefill 一致。应删除该一致性要求，改为对不一致样本做 fail-closed 回问（要求显式说明）而不是在提示词中预绑定方向。

### AUTH-05 ✅ — high · C 兜底侵占

- **字段/提示词**：q4_confirmations / q5_invalidation 缺失时的机器兜底
- **位置**：`analysis/v2/assemble-v2.cjs:222-223, 242-243`
- **证据**：
  ```
  `const q4 = o.q4_confirmations || { selected: 'long', signals: [] };` `const q5 = o.q5_invalidation || { conditions: [] };`
  ```
- **处置建议**：LLM 缺 q4/q5 时，引擎用 selected:'long' 和空数组填充并写入 analysis-v2，equivalence 仅检查 Array.isArray 会放行空壳。应 fail-closed 要求重跑，缺 q4/q5 不得组装通过。

### AUTH-02 — medium · A 预答泄漏

- **字段/提示词**：P2 prompt 中 prefill q2/q6 预答注入
- **位置**：`analysis/v2/prompt-builder-v2.cjs:76`
- **证据**：
  ```
  `L.push("- prefill q2: ${pf.q2.judgment}/${pf.q2.priceAlignment}; q6=${JSON.stringify(pf.q6)}");`
  ```
- **处置建议**：不要在 LLM 输入中给出 q2/q6 成品结论文本；只给组成数据（ma20/ma60/chg5/volMult/contractValue 等），让 LLM 自行形成判断。

### AUTH-04 — medium · A 预答泄漏

- **字段/提示词**：输出 JSON 示例中 costAnchorRef.routeRefs/evidenceIds 预置答案
- **位置**：`analysis/v2/prompt-builder-v2.cjs:95`
- **证据**：
  ```
  `"costAnchorRef":{"used":true,"routeRefs":["天然碱法","氨碱法"],"evidenceIds":["cost_anchor.routes"]}`
  ```
- **处置建议**：这是真实品种（SA0 纯碱）的路线名，却被硬编码进全品种通用 JSON 示例。应替换为中性占位符（如 ["<route>"])，避免 LLM 对非纯碱品种复述该答案。

### AUTH-06 ✅ — medium · D 事后篡改

- **字段/提示词**：confidence 字段在 pass/neutral 时被静默改写为 low
- **位置**：`analysis/v2/assemble-v2.cjs:230, 271`
- **证据**：
  ```
  `confidence: direction === 'neutral' ? 'low' : o.confidence,`；同一函数写入 reasoning-results 的却是 `confidence: o.confidence,`
  ```
- **处置建议**：pass/neutral 的 confidence 应由 LLM 输出或契约明示，不应在组装时静默覆盖；否则 analysis-v2 与 reasoning-results-v2 携带两个不同 confidence，下游仍视为 LLM 判断。

### AUTH-07 — medium · C 兜底侵占

- **字段/提示词**：cost-anchor record.confidence / route.status 默认值
- **位置**：`analysis/v2/cost-anchor/extract.cjs:43, 48`
- **证据**：
  ```
  `confidence: raw.confidence || 'low',`；`status: r.status || 'known',`
  ```
- **处置建议**：confidence 缺失时应保持 undefined，交给 validate.cjs 的 deriveConfidence/capProvidedConfidence 按来源层级推导，避免机器预填 low 抢占策略推导；route.status 缺失应标 unknown 或拒绝，不应默认为 known。

### AUTH-08 — low · C 兜底侵占

- **字段/提示词**：pass_reason / mechanismRef 缺失兜底
- **位置**：`analysis/v2/assemble-v2.cjs:272, 278`
- **证据**：
  ```
  `pass_reason: o.direction === 'pass' ? (o.passReason || 'model_abstain') : null,`；`mechanismRef: o.mechanismRef || { family: 'none', mechanismId: null, matchStatus: 'unknown' },`
  ```
- **处置建议**：这些是 LLM 输出字段，缺失时应在 provenance 标记 fallback 或 fail-closed，避免下游把机器默认值当 LLM 结论使用。

### ALLOW-01 — info · 合法对照

- **字段/提示词**：Q4 语义事实校验
- **位置**：`analysis/v2/assemble-v2.cjs:194-200`
- **证据**：
  ```
  `const q4Sem = validateQ4Semantics(outputs, packets); if (!q4Sem.ok) { console.error('FATAL: Q4 semantic-fact validation failed:'); for (const e of q4Sem.errors) console.error(...); process.exit(1); }`
  ```
- **处置建议**：合法对照：只做一致性校验并在冲突时终止，不静默改写 LLM 文本。

### ALLOW-02 — info · 合法对照

- **字段/提示词**：volatilityRegime 计算
- **位置**：`analysis/probability/stage-4-5.cjs:367-374`
- **证据**：
  ```
  `// 波动率 regime 契约（唯一生产者）` `const volatilityRegime = computeVolatilityRegime({ close, atr5, hvAnnual: hvResult.hv, currentState, bars: ohlcArray });`
  ```
- **处置建议**：合法对照：该字段是确定性计算并标注为计算值/唯一生产者，与 LLM 无交界。

## strategy-reasoning

> 已逐文件审计 5 个指定文件。LLM 交界点共两处：strategy-reasoning-prompt.cjs 生成 Strategy-LLM 的输入 prompt；strategy-reasoning-validate.cjs / pricing-validate.cjs / semantic-fact-validate.cjs 消费 LLM 输出的 strategy-reasoning.json 并硬校验。主要问题是 expression.type 与 entry.trigger 这两个本应由 LLM 决定的字段被“提示词映射 + 校验器决策表”双重俘获：删除 LLM 后，代码中的 allowedTypesForPosition/firstActionWord 仍能判定该用哪种表达与措辞；换更强模型只要合规输出也不会变；冲突时校验器直接报错打回，不回问。pricing-validate 的“>1×ATR 应为 conditional”在错误信息中注入表达类型决策。另有两处轻微兜底：validator 对缺失 confidence 默认 'low'，semantic validator 对缺失 type/direction 默认 conditional-watch/bullish。strategy-library.json 在本链路中与 Strategy-LLM 无直接交界（strategy-reasoning-prompt.cjs 未 import 它；其固定执行模板如 line 881 由确定性 strategy-matcher 消费），因此未计 authority mismatch；该文件的 riskConfig/positionSizing 均标注为确定性公式，不属 LLM 决策字段。

### SR-B-001 ✅ — high · B 模板规定

- **字段/提示词**：strategy-reasoning.json strategies[].expression.type / entry.trigger
- **位置**：`analysis/strategy/strategy-reasoning-prompt.cjs:49`
- **证据**：
  ```
  strategy-reasoning-prompt.cjs:49 `L.push('4. 语义自洽：现价相对价值区的位置必须与表达类型和触发文案一致——现价在区间内用“确认”，在区间上方等待下跌用“回踩”，在区间下方等待站上用“突破/站回”；不得出现“现价在区间内却写回踩”。');`
  ```
- **处置建议**：删除提示词中“位置→表达类型/触发措辞”的映射；只提供 frozen 的现价位置事实（inside/above/below）并要求 LLM 说明选择理由，让 expression.type 与 trigger 文案真正由 LLM 判断产生。删除测试：semantic-fact-validate.cjs:36-46 的 allowedTypesForPosition 表可独立复现同一决策；换脑测试：任何合规 LLM 都会输出相同映射；所有权追问：终点是提示词中的模板规定。

### SR-B-002 ✅ — high · B 模板规定

- **字段/提示词**：strategy-reasoning.json strategies[].expression.type / entry.trigger
- **位置**：`analysis/strategy/semantic-fact-validate.cjs:36-46, 106-110`
- **证据**：
  ```
  semantic-fact-validate.cjs:37-44 `if (position === 'above') return ['pullback','conditional-watch','breakout']; if (position === 'inside') return ['confirmation','breakout','conditional-watch']; if (position === 'below') return ['breakout','reclaim','conditional-watch'];` 及 :106-110 `if (!allowed.includes(type)) { errors.push(...表达类型 ${type} 不匹配（允许：${allowed.join('/')}）...); } if (!typeMatchesAction(type, action)) { errors.push(...触发文案首动作词 ${action} 不一致); }`
  ```
- **处置建议**：校验器不应内置“何种价格位置必须用何种表达/措辞”的决策表；改为校验 LLM 自述的位置与 frozen 事实是否一致，或把该表提升为显式配置并承认这些字段是机器决定而非 LLM 判断。冲突处理测试：LLM 输出 pullback+inside 时，代码不修改、不回问，而是直接报错，使有效输出只能是代码表内值。

### SR-A-004 ✅ — low · A 预答泄漏

- **字段/提示词**：strategy-reasoning.json 示例中的 direction / strategyConfidence / expression.type / entry.triggerLevel / stop.stopPrice / stop.basis
- **位置**：`analysis/strategy/strategy-reasoning-prompt.cjs:89`
- **证据**：
  ```
  strategy-reasoning-prompt.cjs:89 `L.push('{"schema":"futures-radar-strategy-reasoning/1","runId":"...","strategies":[{"symbol":"SA0","direction":"neutral","strategyConfidence":"low",..."expression":{"type":"conditional-watch","reason":"..."},"entry":{"trigger":"...","triggerSource":"...","triggerLevel":1018,"triggerTiming":"...","execution":"..."},"stop":{"stopPrice":1018,"basis":"Q5 失效位/概率尾"},...`
  ```
- **处置建议**：JSON 结构示例只保留键名与占位符，去掉具体数字 1018、具体枚举值 neutral/low/conditional-watch 与具体 basis 文案，避免弱模型直接复述示例答案；schema 约束交给 strategy-reasoning-validate 完成。

### SR-B-003 ✅ — low · B 模板规定

- **字段/提示词**：strategy-reasoning.json strategies[].expression.type（通过 entry.triggerLevel 距离判定）
- **位置**：`analysis/strategy/pricing-validate.cjs:47-49`
- **证据**：
  ```
  pricing-validate.cjs:47-49 `if (isConditional(r)) continue; if (entryDistAtr != null && entryDistAtr > 1.0) { errors.push(`${r.symbol}: 入场距离现价 ${entryDistAtr.toFixed(2)}×ATR > 1.0×ATR，应为 conditional`); }`
  ```
- **处置建议**：入场距离阈值作为风险约束可保留，但应去掉错误信息中“应为 conditional”的决策指令；冲突时应打回 LLM 重新判断表达类型，或把该规则显式写进 prompt 并声明为机器约束，避免校验器在错误文案里替 LLM 做表达决策。其余 1.5×ATR / 1.5R 阈值属于解空间硬约束，尚在合法边界。

### SR-C-005 — low · C 兜底侵占

- **字段/提示词**：strategy-reasoning.json strategies[].strategyConfidence（校验口径）
- **位置**：`analysis/strategy/strategy-reasoning-validate.cjs:34-35`
- **证据**：
  ```
  strategy-reasoning-validate.cjs:34-35 `const reportConf = opp.thesis?.finalConfidence || 'low'; const stratConf = r.strategyConfidence || 'low';`
  ```
- **处置建议**：报告 finalConfidence 或 LLM strategyConfidence 缺失时应报缺失错误并打回，而不是默认 'low'。当前默认值会静默放行 LLM 漏填 strategyConfidence，或在报告字段缺失时把 LLM 可写范围钳到 low，构成兜底侵占。

### SR-C-006 — low · C 兜底侵占

- **字段/提示词**：strategy-reasoning.json strategies[].expression.type / direction（校验口径）
- **位置**：`analysis/strategy/semantic-fact-validate.cjs:99-101`
- **证据**：
  ```
  semantic-fact-validate.cjs:99-101 `const type = r.expression?.type || 'conditional-watch'; const action = firstActionWord(r.entry?.trigger); const direction = r.direction || opp.thesis?.finalDirection || 'bullish';`
  ```
- **处置建议**：LLM 漏填 expression.type 或 direction 时应报缺失错误；默认 'conditional-watch' 会绕过 typeMatchesAction，默认 'bullish' 会改变 allowedTypesForPosition 的判定分支，不应在语义校验器里静默兜底。

### SR-OK-001 — info · 合法对照

- **字段/提示词**：strategy-reasoning.json strategies[].regimePlan.normal/elevated/extreme
- **位置**：`analysis/strategy/strategy-reasoning-validate.cjs:54-60`
- **证据**：
  ```
  strategy-reasoning-validate.cjs:54-60 `const allowed = { normal: ['full','reduced','watch'], elevated: ['reduced','watch'], extreme: ['watch'] }; ... else if (!allowed[grade].includes(v)) errors.push(...非法（允许 ...）)`
  ```
- **处置建议**：这是对必填字段的枚举/覆盖约束（三档必须齐全、extreme 只允许 watch），只限制解空间、不替 LLM 选具体值，属合法边界。

### SR-OK-002 — info · 合法对照

- **字段/提示词**：strategy-reasoning.md 中注入的 near_term / 现价位置
- **位置**：`analysis/strategy/strategy-reasoning-prompt.cjs:73-74`
- **证据**：
  ```
  strategy-reasoning-prompt.cjs:73-74 `const pos = opp.marketFacts?.close < near.valueAreaLow ? 'below' : opp.marketFacts?.close > near.valueAreaHigh ? 'above' : 'inside'; L.push(`- near_term: valueArea=[${near.valueAreaLow}, ${near.valueAreaHigh}] pdh=${near.pdh} pdl=${near.pdl} atr5=${near.atr5} 现价位置=${pos}`);`
  ```
- **处置建议**：这是用冻结行情数据计算的事实（收盘价相对价值区的位置），不是决策值，注入 prompt 属合法的冻结事实数据。

## strategy-ticket

> 逐文件扫描了 7 个指定文件。near-term-structure.cjs 为冻结行情算术（PDH/PDL/价值区/ATR5），与 LLM 无交界，干净；strategy-ticket-prompt.cjs 对“偏离 >X 放弃”“T+N 交易日”等属格式/解空间约束，X、N 仍由 LLM 决定，未命中；ticket-recorder-prompt.cjs 输出示例中 direction:'bearish' 是具体决策值，低危预答泄漏；ticket-elements.cjs 多数为一致性校验并回问（合法），但校验不要求 abandon、targets.t2、stop.basis，给 strategy-matcher 的机器兜底留下缺口；build-strategy-plan.cjs 在 LLM 产物缺失时静默走确定性 matcher 并照常出计划；strategy-matcher.cjs 是问题集中地：gapThresholdPts、targets.t2、entry 执行/时点文案、stop.basis、strategyConfidence 等名义上由 LLM 决定的字段均有机器公式/固定文案兜底或恒由代码生成，且不与 LLM 输出对账；strategy-plan.schema.json 进一步用描述把 0.5/0.75×ATR5 等机器公式固化为契约。删除测试：去掉交易员/录入员输出后，strategy-matcher 仍能产出 gapThresholdPts、entry.execution、targets、stop.basis 的当前值；换脑测试：这些兜底值与 LLM 无关，换模型不变；所有权追问：终点在 playbookGap/buildTargets/固定字符串。冲突处理：executionConvention 与交易单 abandon 点数可能并存冲突且不回问。

### ST-01 ✅ — high · C 兜底侵占

- **字段/提示词**：entry.gapThresholdPts / abandon 点数（执行偏离放弃点数）
- **位置**：`analysis/strategy/strategy-matcher.cjs:1048-1050`
- **证据**：
  ```
  strategy-matcher.cjs:1048 `const playbookGap = round2((pb.playbookId === 'PB-07' || pb.playbookId === 'PB-03') ? 0.75 * atr5ForGap : 0.5 * atr5ForGap);` 与 :1050 `const gapThresholdPts = elements && Number.isFinite(ticketGap) ? round2(ticketGap) : playbookGap;`。交易员提示词要求 LLM 决定 X（strategy-ticket-prompt.cjs:55 `写“偏离 >X 放弃”，X 是点数`），但 ticket-elements.cjs:110-111 仅在有 abandon 数字时回看 note：`const abandonPts = firstNumber(t.abandon); if (abandonPts != null) checkNumberInNote(abandonPts, 'abandon 点数');`，abandon 缺失/无数值可通过校验，strategy-plan.schema.json:575 还把 `PB-07/PB-03 为 0.75×ATR5，其余为 0.5×ATR5` 固化为契约。
  ```
- **处置建议**：在 validateElements 中将 abandon 设为必填且必须含数字，缺失时按 unresolved 回问交易员；禁止用 playbookGap 静默填入 gapThresholdPts。

### ST-02 ✅ — high · C 兜底侵占

- **字段/提示词**：targets.t2 / targets.basis（第二目标与目标依据）
- **位置**：`analysis/strategy/strategy-matcher.cjs:1076-1080`
- **证据**：
  ```
  strategy-matcher.cjs:1078 `t2: (elements && elements.targets && elements.targets.t2) || (reasoningTargets && reasoningTargets.t2) || targets.t2,` 其中 targets 来自 buildTargets 固定文案，如 :968 `{ t1: '2R（平 50%）', t2: '3R 或 3d p95 沿（先到者）', basis: 'R 口径' }`、:974 `{ t1: ..., t2: \`3d p95 ${dir === 'bullish' ? '上' : '下'}沿 ...\`, basis: '概率锥区间' }`。strategy-ticket-prompt.cjs:57 要求 LLM“对了看哪两个目标”，但 ticket-elements.cjs:84-85 只校验 `targets.t1` 非空，t2/basis 缺失不拦。
  ```
- **处置建议**：validateElements 应要求 targets.t2（及 basis）非空，缺失时回问交易员；删除 buildTargets 对 LLM 票单路径的 t2 兜底。

### ST-03 ✅ — medium · C 兜底侵占

- **字段/提示词**：entry.trigger / entry.triggerTiming / entry.execution（触发与执行文案）
- **位置**：`analysis/strategy/strategy-matcher.cjs:1055-1066`
- **证据**：
  ```
  strategy-matcher.cjs:1059-1063 `triggerTiming: ... || (dir === 'neutral' ? '无执行时点（观察）' : (pb.playbookId === 'PB-07' ? 'T+1 交易日收盘确认；确认后下一交易日开盘执行' : 'T+1 交易日开盘执行'))`；:1064-1066 `execution: ... || (pb.playbookId === 'PB-07' ? 'T+1 交易日收盘确认；确认后下一交易日开盘执行；执行偏离 >0.75×ATR5 放弃' : (pb.playbookId === 'PB-03' ? 'T+1 交易日开盘；执行偏离 >0.75×ATR5 放弃' : 'T+1 交易日开盘；执行偏离 >0.5×ATR5 放弃'))`。当 reasoning/elements 缺失时（build-strategy-plan.cjs:120 `using legacy deterministic matcher (回放/兼容模式)`），这些本由交易员决定的执行时点/放弃口径由固定字符串填满。
  ```
- **处置建议**：LLM 产物缺失时不要用机器文案冒充交易决策；可显式标记计划为 deterministic/compat 来源，或直接失败要求先产出交易单。

### ST-04 ✅ — medium · D 事后篡改

- **字段/提示词**：playbook.executionConvention（执行口径/偏离放弃阈值）
- **位置**：`analysis/strategy/strategy-matcher.cjs:1024-1033`
- **证据**：
  ```
  strategy-matcher.cjs:1024-1033 恒由 playbookId 生成执行口径：`if (playbookOut.playbookId === 'PB-03') { executionConvention = dir === 'bullish' ? 'T+1 开盘；执行偏离 >0.75×ATR5 放弃；多头回踩要求持仓不塌（报告既有表述）' : ... } ... else { executionConvention = \`T+1 开盘；执行偏离 >0.5×ATR5 放弃；${dirClause}\`; }`。该字段与交易员在 entry/abandon 中给出的点数（strategy-ticket-prompt.cjs:55）不进行对账；两者冲突时（如票单写“偏离 >20 放弃”而代码写 >0.5×ATR5）不回问，同一 plan 内出现两个并存口径。
  ```
- **处置建议**：有 elements 时 executionConvention 应从票单 entry/abandon 派生；无法派生则留空并回问，不应恒写固定公式文本。

### ST-05 ✅ — medium · C 兜底侵占

- **字段/提示词**：strategyConfidence（策略表达置信度）
- **位置**：`analysis/strategy/strategy-matcher.cjs:1043-1045`
- **证据**：
  ```
  strategy-matcher.cjs:1043 `const reasoningConf = reasoning && reasoning.strategyConfidence ? reasoning.strategyConfidence : null;` 与 :1045 `const strategyConfidence = reasoningConf || reportConf;`。strategy-plan.schema.json:367 声明 `策略表达置信度，由 Strategy-LLM 判断；不得高于 reportBaseline.confidence`；当 LLM 漏填时引擎静默取报告置信度填入，且 strategy-reasoning-validate.cjs 也未强制该字段存在。
  ```
- **处置建议**：在 reasoning 校验中强制 strategyConfidence 存在并合法；缺失应失败或回问，禁止回退到 reportConf 冒充 LLM 判断。

### ST-08 ✅ — medium · C 兜底侵占

- **字段/提示词**：整体策略计划（LLM 交易单/推理全部缺失时）
- **位置**：`analysis/strategy/build-strategy-plan.cjs:119-121`
- **证据**：
  ```
  build-strategy-plan.cjs:119-121 `strategy-elements.json / strategy-reasoning.json not found — using legacy deterministic matcher (回放/兼容模式)` 后继续调用 `buildStrategyPlan(...)` 并写出 strategy-plan.json（:123-134）；此时 entry/targets/stop/执行口径均由 strategy-matcher 的公式与固定文案产出，而下游仍按统一 strategy-plan 契约消费。
  ```
- **处置建议**：在计划中增加显式 provenance/来源标记（如 planMode: 'deterministic-compat'），或在该模式下拒绝产出计划并要求先完成 LLM 交易单链路。

### ST-06 ✅ — low · C 兜底侵占

- **字段/提示词**：stop.basis（止损依据文案）
- **位置**：`analysis/strategy/strategy-matcher.cjs:1074`
- **证据**：
  ```
  strategy-matcher.cjs:1074 `basis: (elements && elements.stop && elements.stop.basis) || (reasoningStop && reasoningStop.basis) || \`min(stopK×ATR5, 0.8×limitPct×close, |Q5 结构位−close|)${risk.notes.length ? '；' + risk.notes.join('；') : ''}\``。ticket-elements.cjs:81-82 只校验 `stop.level` 是数字，不要求 stop.basis；缺失时引擎自产公式文案作为最终依据。
  ```
- **处置建议**：validateElements 要求 stop.basis 非空，或在缺失时置空并回问，不写机器公式文案。

### ST-07 ✅ — low · A 预答泄漏

- **字段/提示词**：direction（交易方向示例值）
- **位置**：`analysis/strategy/ticket-recorder-prompt.cjs:61`
- **证据**：
  ```
  ticket-recorder-prompt.cjs:61 输出 JSON 示例中 `direction: 'bearish',` 是具体方向值；:80 仅声明 `上面的尖括号内容全部是占位符，禁止照抄`，未把 bearish 标为占位符，录入员可能直接照抄示例方向。
  ```
- **处置建议**：将示例改为 `direction: '<bullish|bearish|neutral>'` 之类的占位符，避免具体答案进入提示词。

### AL-01 — info · 合法对照

- **字段/提示词**：near-term structure（PDH/PDL/价值区/ATR5/distances）
- **位置**：`analysis/strategy/near-term-structure.cjs:39-55`
- **证据**：
  ```
  near-term-structure.cjs:39-49 `const atr5 = atr5FromBars(bars, idx); const pdh = prev.high; const pdl = prev.low;` 与 :51-54 `const pts = round(level - close, 2); return { pts, atr: round(pts / atr5, 2) };`。这些是冻结行情数据的算术/事实字段，不是 LLM 决策字段。
  ```
- **处置建议**：保持现状；确认下游仍把该结构标注为计算值而非交易员判断。

### AL-02 — info · 合法对照

- **字段/提示词**：bindCheck 一致性校验与回问
- **位置**：`analysis/strategy/ticket-elements.cjs:182-192；build-strategy-plan.cjs:82-94`
- **证据**：
  ```
  ticket-elements.cjs:187-190 `空单偏离带上沿 ... 高于止损 ... 请交易员改单` 与 build-strategy-plan.cjs:82-83 `交易单方向 ${el.direction} 与分析六问结论 ${opp.thesis.finalDirection} 不一致，请交易员确认`。代码只校验冲突并写 strategy-askback.md 后退出，不静默修值，符合合法边界。
  ```
- **处置建议**：保持该回问模式，并将其推广到 abandon/targets.t2/stop.basis 等当前静默兜底的字段。

## execution-signal

> 审计了 4 个文件：feedback.cjs 与 signal-pool.cjs 均声明不调用 LLM，属于 LLM 输出（strategy-plan.json / filtered.json）的消费方；apply-tracking-seats.cjs 明确运行在“LLM 初筛写完 filtered.json 之后”，是 LLM 输出的改写方；shared/strategy-state.cjs 是状态词汇/事件投影层，无 LLM 交界，基本干净（仅保留枚举归一化）。共发现 5 个权威错位问题：1 个 D（high）——apply-tracking-seats 把机器生成的 KEEP 候选拼入 LLM 初筛产物并静默覆盖 downgraded、重算 outputCount；4 个 C/D 兜底/篡改——feedback.cjs 对 gapThresholdPts、target1、triggerTiming 缺字段或不可解析时用机器公式/默认文案决定验证结果，signal-pool.cjs 对 entry.triggerTiming 写入默认执行文案。另给出 2 条合法对照（strategy-state 枚举映射、feedback.cjs 显式标注的回测计划生成）。

### AUTH-C-02 ✅ — high · C 兜底侵占

- **字段/提示词**：target1（T1 目标价，验证/信号池兑现判断用）
- **位置**：`analysis/strategy/feedback.cjs:494-504`
- **证据**：
  ```
  line 496-503: "const priceMatch = tText.match(/(\d{3,}(?:\.\d+)?)/); const rMatch = tText.match(/(\d+(?:\.\d+)?)\s*R/); if (priceMatch) { target1 = parseFloat(priceMatch[1]); } else if (rMatch && stop != null) { target1 = entryPrice + sign * parseFloat(rMatch[1]) * (entryPrice - stop); } else if (stop != null) { target1 = entryPrice + sign * 2 * (entryPrice - stop); }"
  ```
- **处置建议**：当 LLM/计划的目标文本不可解析（如 PB-03 的“前高/前低 或 3d p68 沿（先到者）”、PB-06 的“对侧边界”）时，不要静默替换为 2R 公式；应标记 unverifiable 或回问交易员，避免 target1_hit/fulfilled 基于机器自产目标价被记录。

### AUTH-D-01 ✅ — high · D 事后篡改

- **字段/提示词**：filtered.json candidates[].decision/rank/directionBias/confidence 及 meta.outputCount（LLM 初筛输出文件）
- **位置**：`signals/seats/apply-tracking-seats.cjs:3-8,45-68`
- **证据**：
  ```
  line 3: "// 在 LLM 初筛写完 filtered.json 之后、freeze-packets 之前运行："; line 6-7: "// 行为：读取信号池 ledger，把所有池内（active/downgraded）信号品种强制加入 filtered.json 的 candidates（KEEP）"; line 45-50: "candidates.push({ ... directionBias: directionHint, decision: 'KEEP', confidence, ... })"; line 60-66: "const nextDowngraded = downgraded.filter((d) => { if (added.includes(d.symbol) || candidateSymbols.has(d.symbol)) return false; return true; }); ... filtered.downgraded = nextDowngraded;"; line 68: "filtered.meta.outputCount = candidates.filter((c) => c.decision === 'KEEP').length;"
  ```
- **处置建议**：不要把机器生成的 KEEP 席位写进 LLM 初筛的 filtered.json candidates/downgraded，也不要重算 meta.outputCount；应写入独立文件（如 tracking-seats.json）并在下游显式标注来源，或要求 LLM/用户确认后再并入。当前管道已由 stories/seats/build-filtered-from-story-pool.cjs 重写 filtered.json（filter-llm 已退役），本脚本应按遗留脚本废弃或禁止在 LLM 初筛后运行。

### AUTH-C-04 ✅ — medium · C 兜底侵占

- **字段/提示词**：gapThresholdPts（执行偏离放弃阈值，用于 skipped_gap 判定）
- **位置**：`analysis/strategy/feedback.cjs:465-470`
- **证据**：
  ```
  line 465: "// 执行偏离阈值优先用计划内置 gapThresholdPts（与 execution 文案一致）；旧计划无该字段时回退 0.5×|stop-trigger|。"; line 466-470: "const gapThreshold = Number.isFinite(Number(record.gapThresholdPts)) ? Number(record.gapThresholdPts) : (record.stopPrice != null && record.stopPrice !== record.triggerLevel) ? Math.abs(record.stopPrice - record.triggerLevel) * 0.5 : null;"
  ```
- **处置建议**：gapThresholdPts 是执行放弃决策值；旧计划缺字段时不应由代码用 0.5×|stop-trigger| 自产阈值决定 skipped_gap。缺失时应标 unverifiable 或回问，而不是用公式兜底并写入验证结果。

### AUTH-C-05 ✅ — medium · C 兜底侵占

- **字段/提示词**：version.entry.triggerTiming（信号池版本中的触发/执行时点）
- **位置**：`signals/lib/signal-pool.cjs:195`
- **证据**：
  ```
  line 195: "triggerTiming: (p.entry && p.entry.triggerTiming) || 'T+1 收盘确认；确认后下一交易日开盘执行',"
  ```
- **处置建议**：signal-pool 声明只读 strategy-plan.json，却对缺失的 triggerTiming 写入完整执行决策文案，该版本随后用于视图展示（summarizeSignal line 822）与验证（versionToRecord line 672）。缺失时应保留空/null 或标 unverifiable，不要注入机器默认执行口径。

### AUTH-D-03 ✅ — medium · D 事后篡改

- **字段/提示词**：record.triggerTiming（验证记录中的触发/执行时点语义）
- **位置**：`analysis/strategy/feedback.cjs:104-110`
- **证据**：
  ```
  line 104-108: "let triggerTiming = (p.entry && p.entry.triggerTiming) || ''; if (mode === 'signal' && (!triggerTiming || /无执行时点|仅观察/.test(triggerTiming))) { triggerTiming = (p.entry && p.entry.execution) || (p.playbook && p.playbook.executionConvention) || 'T+1 收盘确认；确认后下一交易日开盘执行'; }"; line 110: "if (!triggerTiming) triggerTiming = 'T+1 收盘确认；确认后下一交易日开盘执行';"
  ```
- **处置建议**：不要静默覆盖 LLM/计划已写入的“无执行时点/仅观察”语义，也不要对缺失字段填入完整执行文案；缺失时标记 unverifiable 或保留空值并回问，避免验证引擎按代码默认的“T+1 收盘确认”口径错判触发。

### ALLOW-01 — info · 合法对照

- **字段/提示词**：planStateOf 的 executable/watch/skip → armed/watching/suspended 映射
- **位置**：`shared/strategy-state.cjs:48,78-82`
- **证据**：
  ```
  line 48: "const PLAN_STATE_ALIASES = { executable: 'armed', watch: 'watching', skip: 'suspended' };"; line 78-82: "function planStateOf(plan) { if (!plan) return 'watching'; if (isExecutionState(plan.state)) return plan.state; return PLAN_STATE_ALIASES[plan.executionStatus] || 'watching'; }"
  ```
- **处置建议**：保留。这是旧词到新词的枚举归一化，不生成新的推理/决策内容，属于合法约束边界。

### ALLOW-02 — info · 合法对照

- **字段/提示词**：buildHistoricalPlan 生成的回测/测试计划字段
- **位置**：`analysis/strategy/feedback.cjs:816-847`
- **证据**：
  ```
  line 812-814: "用截断到 signalDate 的 bars 构造一个可证伪计划（回测/测试用）。只允许读取 bars[0..signalIdx]，禁止任何未来数据。"; line 832-834: "const triggerLevel = parseFloat((close + sign * 0.5 * atr5).toFixed(1)); const stopPrice = parseFloat((close - sign * 1.5 * atr5).toFixed(1)); const target1 = parseFloat((close + sign * 2 * atr5).toFixed(1));"; line 844: "target1Text: `${target1}（回测目标）`"
  ```
- **处置建议**：保留。该函数显式标注为回测/测试用，目标是自产计算值并写入“（回测目标）”文案，不冒充 LLM 判断，属于标注为计算值的合法算术。

## rendering

> 已逐文件审计 output/ 下 7 个渲染器。render-report-html.cjs、render-ticket-html.cjs、render-story-pool-html.cjs 为纯确定性渲染，无 LLM 字段被代码决定/改写（仅做枚举映射、HTML 转义与缺失 '—' 兜底）。问题集中在三处交界：1) render-strategy-section.cjs 的「执行口径」行只渲染代码生成的 playbook.executionConvention，压制了 LLM 产出的 entry.execution，且实际 run 中两者存在 T+1 vs T+2、0.5×ATR5 vs 13.8 点的真实冲突；2) render-markdown.cjs 的 spotBasisLine 由代码自产带判断色彩的解读句「期货升水，追多安全边际较差」；3) 多个渲染器对 LLM 决策字段（finalDirection、confidence、theoryFit、执行文案）存在静默默认/改写。提示词生成（A/B 预答/模板）不在这 7 个文件内，本批未发现位于渲染器中的提示词注入；但渲染器通过选择代码字段与默认值，已形成 C/D 型权威错位。

### REND-01 ✅ — high · D 事后篡改

- **字段/提示词**：strategy-plan.json 的 entry.execution(LLM) vs playbook.executionConvention(代码模板) → report.md「执行口径」
- **位置**：`output/render-strategy-section.cjs:530-532, 570-572; output/render-markdown.cjs:584-585`
- **证据**：
  ```
  render-strategy-section.cjs:532 `lines.push('| 执行口径 | ${p.playbook.executionConvention} |');`（旧版分支 :572 同）；渲染器从不展示 `p.entry.execution`。实测 20260920-2108-auto：report.md 显示『执行口径: T+1 开盘；执行偏离 >0.5×ATR5 放弃…』，而 strategy-plan.json 的 entry.execution（源自 LLM 交易单/strategy-elements）为『T+2 交易日 开盘入场；偏离 >13.8 放弃』。render-markdown.cjs:585 `- 阈值：PB-07/PB-03 为 0.75×ATR5，其余 playbook 为 0.5×ATR5；旧计划无内置阈值时回退 0.5×|止损−触发|。` 证明该句式与阈值为代码固定。冲突处理测试：LLM 与代码不一致时未回问，报告静默采用代码版本。
  ```
- **处置建议**：报告「执行口径」应优先渲染 LLM 的 entry.execution；若保留 playbook.executionConvention，必须标注其为代码生成模板，并与 entry.execution 做一致性校验，冲突时回问（ask-back）而不是静默显示代码版本。

### REND-02 ✅ — medium · C 兜底侵占

- **字段/提示词**：spotBasisLine 的期现结构解读句（报告附录「期现结构」）
- **位置**：`output/render-markdown.cjs:158-160`
- **证据**：
  ```
  render-markdown.cjs:158-160 `const meaning = b.source === 'mysteel' ? (b.basisRate != null && b.basisRate < 0 ? '期货升水，追多安全边际较差' : b.basisRate != null && b.basisRate > 0 ? '现货升水，期货贴水' : '基差接近平水') : '市场综合价，不作为交割基差';` 该句完全由渲染器按 basisRate 符号生成，再拼入 `return ... — ${meaning}` 作为报告正文。删除 LLM 环节，该判断句仍原样产出；所有权终点是渲染器中的预置答案。
  ```
- **处置建议**：只渲染事实数据（现货价、基差、基差率）；「追多安全边际较差」这类判断句应由 LLM 在 report-model.json 中产出，缺省显示 '—'，渲染器不得代写分析结论。

### REND-03 ✅ — medium · C 兜底侵占

- **字段/提示词**：report-model.json 的 thesis.finalDirection 缺省值
- **位置**：`output/render-dashboard-html.cjs:389, 403`
- **证据**：
  ```
  render-dashboard-html.cjs:389 `const dir = t.finalDirection || 'neutral';`；:403 `const dir = t.finalDirection || 'neutral';`。finalDirection 是 LLM 决策字段，缺失时看板将其显示为 neutral/观望（:396 与 :429 渲染），而 render-markdown.cjs:86-88 对缺失方向显示 '—'。删除 LLM 环节代码仍独立产出 neutral。
  ```
- **处置建议**：缺 finalDirection 时显示 '—' 或跳过该品种，不要用 neutral 顶替 LLM 判断；如必须默认，应显式标注为数据缺失而非 LLM 结论。

### REND-04 — low · C 兜底侵占

- **字段/提示词**：confidenceLabel / confidenceMeter 对缺失 confidence 的默认值
- **位置**：`output/render-strategy-section.cjs:72-74; output/render-dashboard-html.cjs:44-49, 429`
- **证据**：
  ```
  render-strategy-section.cjs:72-74 `return conf === 'high' ? '高' : conf === 'medium' ? '中' : '低';`；render-dashboard-html.cjs:44-45 `const n = level === 'high' ? 3 : level === 'medium' ? 2 : 1;` 缺失/未知值被映射为「低/1格」。而 render-markdown.cjs:76-81 的 confidenceLabel 对缺失返回 '—'。finalConfidence/strategyConfidence 均属 LLM 决策字段，缺省被机器渲染为「低置信度」。
  ```
- **处置建议**：统一缺省口径：缺失 confidence 时显示 '—'，与 render-markdown.cjs 保持一致；仅在 LLM 明确输出 low 时才显示低置信度。

### REND-05 ✅ — low · D 事后篡改

- **字段/提示词**：entry.execution 执行文案被 concreteAtrText 正则改写
- **位置**：`output/render-signal-pool-html.cjs:52-57, 873`
- **证据**：
  ```
  render-signal-pool-html.cjs:52-57 `function concreteAtrText(text, atr5){ ... return s.replace(/(\d+(?:\.\d+)?)\s*×ATR5/g, (_, m) => (Number(m) * Number(atr5)).toFixed(1)); }`；:873 `escapeHtml(concreteAtrText(d.execution, v.atr5 != null ? v.atr5 : sig.atr5AtCreation))` 将执行文案中的『0.5×ATR5』静默替换为数字（无单位、无标注），结果直接作为最终展示。属于正则改写语义且不回问。
  ```
- **处置建议**：替换时保留原表达式并追加换算值（如『0.5×ATR5(≈13.8点)』）并标注换算口径；若确认原文为旧代码生成文本，可继续换算但需显示单位，避免被读作 LLM 原始判断。

### REND-06 — low · C 兜底侵占

- **字段/提示词**：strategy-reasoning 的 theoryFit 缺省显示
- **位置**：`output/render-strategy-section.cjs:513`
- **证据**：
  ```
  render-strategy-section.cjs:513 `const fitLabel = p.theoryFit === 'aligned' ? '较好符合' : p.theoryFit === 'approximate' ? '大致符合' : '无合适理论';`。theoryFit 是 strategy-reasoning LLM 输出字段；缺省或任何未识别值被渲染为『无合适理论』，把机器默认变成 LLM 判断结论。
  ```
- **处置建议**：缺省/未知 theoryFit 显示 '—'；仅在 LLM 明确输出 theoryFit=none 时才写『无合适理论』。

### REND-ALLOW-01 — info · 合法对照

- **字段/提示词**：Markdown→HTML 纯转换（合法对照）
- **位置**：`output/render-report-html.cjs:30-34, 70-145`
- **证据**：
  ```
  render-report-html.cjs:30-34 `function inlineMd(s){ let t = escapeHtml(s); t = t.replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>'); ... }`；:70-145 `function mdToHtml(md)` 只做标题/表格/列表/引用/段落的结构识别，不生成、不改写任何决策字段。
  ```
- **处置建议**：保持现状。

### REND-ALLOW-02 — info · 合法对照

- **字段/提示词**：交易单视图枚举映射与缺省 '—'（合法对照）
- **位置**：`output/render-ticket-html.cjs:23-39`
- **证据**：
  ```
  render-ticket-html.cjs:25-26 `const dirText = dir === 'bullish' ? '多' : dir === 'bearish' ? '空' : '观察';`；:31-39 仅做字段拼接与缺失 '—' 兜底（如 `v.t1 || '—'`），不产生新的决策内容，不覆盖 LLM 交易单原文。
  ```
- **处置建议**：保持现状。

## legacy-research

> 已逐文件阅读 12 个指定文件。prompt-renderer.js 本身只做模板渲染，但其加载的 FinCoT 四臂 prompt 模板存在 B/A 注入（AM-02、AM-05）。post-processor.js 以校验为主，但 opposing_ids/invalidate_if 缺失时由代码默认 []（AM-06）。grounding-validator.js 为纯校验、不改写（ALLOW-01）。reasoning-runner.js 在 grounding 失败时静默把 LLM 决策改写为 pass/low/model_abstain（AM-01，D/C，high）。context-assembler.cjs 为确定性组装、无 LLM 交界，干净。pricing-layer-v8.cjs 是机器审计层：保留 originalExecutionStatus、只新增 effectiveExecutionStatus，未见 LLM 决策字段被改，干净。build-plans-v7.cjs 为 T2 确定性模板，但对 LLM 输出的 blueprintId 与 q6.riskExecution 存在静默兜底（AM-03）。strategy-plan-adapter.cjs 为回测适配器，对 LLM 文本字段存在兜底/占位（AM-04、AM-07）。llm-outcome.cjs 为纯算术评分，干净。llm-replay.cjs 按 packetHash+arm 回放既有 LLM 输出、不修改，干净。llm-scorecard.cjs 为纯聚合、不做阈值判断（ALLOW-02）。mini-pipeline.cjs 用正则从 LLM 文本提取 close/cone，但数值仍来自 LLM、未用代码公式替代 LLM 决策，不命中四形态，干净。

### AM-01 — high · D 事后篡改

- **字段/提示词**：result.direction / confidence / pass_reason / reasoning_summary / branch_status（grounding 失败降级路径）
- **位置**：`legacy/reasoning/reasoning/lib/reasoning-runner.js:134-159`
- **证据**：
  ```
  reasoning-runner.js:141-153：`result: { ... direction: 'pass', confidence: 'low', pass_reason: 'model_abstain', evidence_ids: [], opposing_ids: [], reasoning_summary: \`grounding 校验失败（${ungroundedPaths.join(', ')} 不存在于 packet），降级为 pass\`, invalidate_if: [], branch_status: { regime: 'available', macro_fundamental: 'abstain', position_flow: 'abstain' } ... }`；且 :155 把返回给下游的 grounding 写成 `{ grounded: true, ... }`。冲突处理测试：LLM 已给出 long/short 判断，仅 evidence_ids 未通过 grounding，代码不回问 LLM，直接静默替换成 pass；删除测试：去掉 LLM 判断后该 pass 结果仍由代码独立产出。
  ```
- **处置建议**：grounding 失败时保留原 LLM 结果并返回 status='grounding_degraded'（result 置 null 或原样附 originalGrounding），或把未通过路径回传给 LLM 要求修正 evidence_ids，禁止由引擎伪造 direction/confidence/pass_reason/branch_status。

### AM-02 — high · B 模板规定

- **字段/提示词**：FinCoT 输出 direction / pass_reason / confidence
- **位置**：`legacy/reasoning/reasoning/prompts/fincot-prompt.md:61-86（由 legacy/reasoning/reasoning/lib/post-processor.js:105-128 同规则强制）`
- **证据**：
  ```
  fincot-prompt.md:64 `available分支 < 2 → 强制pass (data_insufficient)`；:68 `分支方向冲突 → 强制pass (conflict_unresolved)`；:82 `单域支持 → 降级为 medium confidence 或 pass`；:85-86 `如果 opposing_ids 非空 → confidence 必须为 medium 或 direction 为 pass；不得在存在未解决冲突时输出 high confidence`。post-processor.js:112-127 用同样的分支计数规则抛错强制（如 :115 `FinCoT ${result.direction} requires >=2 available branches...`）。换脑测试：任何 LLM 在 available 分支<2 或分支冲突时都会被模板固定到同一 pass/pass_reason，输出不随模型变化；所有权终点是模板规则。
  ```
- **处置建议**：决策门禁应降级为约束声明（如“分支不足时倾向 pass 并说明理由”）并把分支可用性作为输入交给 LLM 判断；或至少在 LLM 输出与门禁冲突时回问 LLM 而不是由提示词/解析器机械决定最终 direction/pass_reason。

### AM-03 — medium · C 兜底侵占

- **字段/提示词**：blueprintId（蓝图选择→planTemplate）/ q6_risk.riskExecution
- **位置**：`legacy/strategies/signal-backtest/build-plans-v7.cjs:19,36`
- **证据**：
  ```
  build-plans-v7.cjs:19 `const bp = bps[e.blueprintId] || bps['BP-TREND'];`；:36 `const riskExec = e.q.q6_risk.riskExecution || { positionScale: 1, weekendRule: 'hold', maxAdverseExcursionR: 1.0 };`。删除测试：删掉 LLM 选择的 blueprintId 或缺失 riskExecution 时，代码仍能独立产出 BP-TREND 计划与默认风控参数；LLM 若选了未知/未收录蓝图，会被静默替换为 BP-TREND（triggerType/targetR/stopAtrMult 随之改变），不回问。
  ```
- **处置建议**：blueprintId 未知或缺失应 fail-closed（抛错/标记 invalid），不要把 BP-TREND 当隐式默认；riskExecution 的默认值要么显式来自 blueprint 的 planTemplate（并注明模板来源），要么要求 LLM 必填，不要硬编码在代码里静默兜底。

### AM-04 — low · C 兜底侵占

- **字段/提示词**：thesis.invalidations.conditions / analysis.q5_invalidations.conditions 文本
- **位置**：`legacy/strategies/signal-backtest/adapters/strategy-plan-adapter.cjs:149-151,172-174`
- **证据**：
  ```
  strategy-plan-adapter.cjs:149-151：`invalidations: { conditions: [fin.q.q5_invalidation.levelType === 'ma20_relative' ? \`MA20（约${fin.q.q5_invalidation.level}）${fin.q.q5_invalidation.reason || 'Q5 失效'}\` : \`${fin.q.q5_invalidation.reason || 'Q5 失效'}（Q5 结构位 ${fin.q.q5_invalidation.level}）\`] }`；:172-174 对 analysis 同样写法。删除测试：LLM 未给 q5_invalidation.reason 时，代码自行补写“Q5 失效”文案并作为最终失效条件输出，下游把它当 LLM 失效条件使用。
  ```
- **处置建议**：q5_invalidation.reason 缺失时应标记该条件为 unavailable/derived，或回写原字段缺省，不要生成看似 LLM 给出的失效文案；至少保留 provenance 说明该句由适配器模板生成。

### AM-05 — low · A 预答泄漏

- **字段/提示词**：invalidate_if 示例值（完整决策句式）
- **位置**：`legacy/reasoning/reasoning/prompts/fincot-prompt.md:103；sp-prompt.md:28；st-cot-prompt.md:44；ust-cot-prompt.md:26`
- **证据**：
  ```
  四份 prompt 的 JSON 示例均含完整决策句：`"invalidate_if": ["若价格跌破MA20且成交量放大→失效"]`（如 fincot-prompt.md:103、sp-prompt.md:28）。换脑测试：低强度模型可能直接复述该示例作为自己的失效条件，导致 invalidate_if 与具体品种证据脱钩；预答泄漏风险。
  ```
- **处置建议**：示例改为占位符（如 ["<失效条件1>"]）或明确标注“仅示意格式，不得照抄”，并在解析侧对示例句做去重/告警。

### AM-06 — low · C 兜底侵占

- **字段/提示词**：opposing_ids / invalidate_if 缺省值
- **位置**：`legacy/reasoning/reasoning/lib/post-processor.js:72-74`
- **证据**：
  ```
  post-processor.js:72-74：`// opposing_ids, invalidate_if 可选` `const opposing_ids = Array.isArray(result.opposing_ids) ? result.opposing_ids : [];` `const invalidate_if = Array.isArray(result.invalidate_if) ? result.invalidate_if : [];`。这两个数组会影响 FinCoT 冲突门禁（opposing_ids 非空→confidence 受限/pass）与失效条件；LLM 漏输出时代码直接填 []，等同于替 LLM 声明“无反方证据、无失效条件”，且不回问。
  ```
- **处置建议**：对 FinCoT 臂在无 macro 的 11 字段契约中明确 opposing_ids 必填（至少可为 [] 但需显式输出），或缺失时返回 parse_failed 重试/回问，避免默认 [] 静默通过冲突门禁。

### AM-07 — low · C 兜底侵占

- **字段/提示词**：analysis.q6_risks.limitDistance 占位值
- **位置**：`legacy/strategies/signal-backtest/adapters/strategy-plan-adapter.cjs:175`
- **证据**：
  ```
  strategy-plan-adapter.cjs:175：`q6_risks: { items: [fin.q.q6_risk.text || ''], limitDistance: '4%' }`。该字段在生产链路中是 LLM 输出的涨跌停/风险距离文本（strategy-matcher 用 parseFirstPct 解析），适配器用固定 '4%' 填入；删除测试：无 LLM 时该字段仍为 '4%'，下游无法区分真值与占位。
  ```
- **处置建议**：占位值应显式标注（如 'v7-adapter placeholder: 4%'）或改为 null 并在 plan provenance 中声明回测不采用真实涨跌停口径，避免下游把固定 4% 当作 LLM/真实品种分析结果。

### ALLOW-01 — info · 合法对照

- **字段/提示词**：evidence_ids / opposing_ids / macro_evidence_ids 存在性校验
- **位置**：`legacy/reasoning/reasoning/lib/grounding-validator.js:38-57`
- **证据**：
  ```
  grounding-validator.js:41-49 仅计算 `ungrounded_evidence`、`ungrounded_opposing`、`ungrounded_macro` 并返回 `grounded` 布尔值，不修改 result；这是对 LLM 输出的纯一致性校验，问题交由调用方处理（虽然 runner 的处理方式见 AM-01）。
  ```
- **处置建议**：保持只读校验；建议调用方以回问/重试方式处理 ungrounded，而不是伪造替代结果。

### ALLOW-02 — info · 合法对照

- **字段/提示词**：scorecard calibration 聚合指标
- **位置**：`research/backtest/llm-scorecard.cjs:33-47`
- **证据**：
  ```
  llm-scorecard.cjs:35-43 按 confidence 分组统计 n/correct/accuracy/netMean，只做透明聚合，不做“是否达标/显著”等阈值判断；LLM 决策字段原样作为分组键与结果使用，未被改写或兜底。
  ```
- **处置建议**：保持纯聚合；如需验收阈值，应作为独立、显式标注的评测层，不与 LLM 决策字段混用。

## 已识别的重复项

- `AUTH-D-01`（execution-signal 分区）与 `ASM-02`（stories 分区）指向同一文件同一问题：`signals/seats/apply-tracking-seats.cjs` 把机器 KEEP 席位写入 LLM 初筛产物。
- `ASM-03` 与 `AUTH-D-01` 同族：`stories/seats/build-filtered-from-story-pool.cjs` 整表重写 filtered.json，与 apply-tracking-seats 属同一席位层病根。

## 处置记录

- 批次1（六问层，commit `d05fd5e`）：
  - AUTH-01：prefill 不再产出 Q2；Q6 数值事实加 `provenance.kind=deterministic-facts`；assemble 的 Q2/eventRisk 改为消费 LLM 输出。
  - AUTH-02：prompt-builder 改为只贴 `risk_facts` 数值事实，不再注入 prefill q2/q6 结论。
  - AUTH-03：删除"方向必须与 prefill 结构一致"约束。
  - AUTH-04：costAnchorRef 示例 routeRefs 改 `<route>` 占位符。
  - AUTH-05：assemble 对缺失 q4/q5 fail-closed（`validateLlmOutputShape`）。
  - AUTH-06：confidence 不再因 neutral 静默改写为 low；pass 也要求给出合法 confidence。
  - AUTH-07：cost-anchor extract 不再预填 confidence=low / route.status=known，交 validate.cjs 推导。
  - AUTH-08：pass_reason/mechanismRef 缺失 fail-closed，不再用 `model_abstain` / `{family:'none'}` 占位。
  - 测试：新增 `test/analyze-v2.test.js`（6 条），`npm test` 853 通过。
