# HANDOFF: 主力连续污染修复 — 架构裁定

**交接对象**: @阿比西尼亚猫 (远远)
**裁定人**: 宪宪 (布偶猫, claude-opus-4-8)
**日期**: 2026-08-26
**优先级**: P0 (deep-dig 立即) + P1 (scan 后续独立 handoff)

---

## 诊断验证（已读源码确认）

远远根因诊断成立。我读源码确认，并追加一个改变可行修复集的关键发现：

1. **数据源 = `ak.futures_main_sina(symbol)`**（futures_collector.py:24）
   - 返回主力连续合成序列，非可交易合约
   - 采集列：日期/开高低收/成交量/持仓量/动态结算价（futures_collector.py:43-52）
   - **无逐 bar 合约代码列** —— 主力换月（2609→2701 @ 8-14）时序列直接拼接不同合约价格，无复权，产生跳空

2. **污染波及两层**（均基于 `o.close` 主力连续序列）：
   - **Scan**（scanner/index.cjs）：vsMA20/vsMA60（L183-184）、hv5/hv20（L178）、atr5（L175）全在污染序列上算；change5d（akshare-futures.cjs:166 `pctChange(5)`）同样
   - **Deep-dig**（freeze-packets → FinCoT）：price_data 同源污染 → 铲屎官抓到的 SA2701 MA20 984.85 vs 同花顺 1026.40

3. **追加发现（改变可行修复集）**：因 `futures_main_sina` 无逐 bar 合约码，我原设想的"scan 层用合约码做 roll 检测"不可直接实现。roll 检测只能靠启发式（异常跳空阈值）或改抓具体合约序列。

## 架构原则（本次确立）

> **主力连续是"筛选指数"，不是"价格水平数据源"。**
> 任何涉及具体价格水平的推理（MA 距离、支撑阻力、入场/离场触发价）必须用**当日主导合约自身序列**。
> Scan 可用主力连续做跨品种排序，但其跳空敏感指标（change5d/HV/ATR/MA60）须做 roll-robust 处理。

理由：主力连续价格不属于任何单一合约（它拼接），用它算 MA = 拿 A 合约的历史比 B 合约的现价，口径错误。具体合约自身序列在回看窗口内永不拼接 → 无跳空 → MA 干净且与同花顺一致。

## P0：Deep-dig 修复（立即，永久化）

**What**：freeze-packets 层的 price_data（MA20/MA60/HV/ATR/现价）改用当日主导合约自身序列，把远远的临时手动 override 替换为受测的永久实现。

**复用**：term_structure 已在解析并抓取主导合约（near/main/far 的 main 即主导合约）。P0 直接复用这条抓取路径，扩展为拉主导合约完整 OHLCV 历史，**不要另建平行通道**。

**验收标准**：
- 当日任一主导合约（如 SA2701）MA20/MA60 与同花顺期货 APP 一致（容差 <0.5%）
- 现价距 MA 百分比、HV、ATR 全部基于干净序列
- red test 先行：用已知污染案例（SA0 主力连续 vs SA2701 自身）写断言，先红后绿
- 回看窗口内无拼接跳空（单合约序列天然满足）

**边界检查**：验证主导合约有 ≥60 bar 历史（主导合约近交割通常足够）；不足则优雅降级（MA60=null）并在 packet 标注，**不得静默用短序列冒充**。

## P1：Scan roll-robustness（后续独立 handoff，不阻塞 P0）

Scan 污染真实存在（MA60 几乎恒被污染，change5d 周期性被污染），但 deep-dig 干净数据是兜底，最坏情况是"误促/漏选候选"而非错误交易决策。故列 P1，需独立设计探索：

- roll 检测方法（无合约码 → 启发式异常跳空阈值 vs 改抓各品种主导合约）
- 修正方式（等比复权 vs 跳空敏感分数降权 vs 命中 roll 的品种标注供 deep-dig 复核）
- 权衡：复权口径 vs 排序噪声容忍度

**不与 P0 捆绑** —— P0 紧急且定义清晰，P1 需探索。

## 回测口径决定

- 现有回测缓存全是主力连续口径。修复后 deep-dig 用具体合约 → 新旧不可直接比较。
- 裁定：回测缓存**仅保留用于 scan/filter 回归**（scan 层暂仍主力连续）。任何 **deep-dig 方向准确率**回测必须用具体合约口径重跑 —— 旧的主力连续方向准确率数字对 deep-dig 无效，不得引用。
- Phase 2 统计回测已裁 no-go，单臂对照（SINGLE_ARM_COMPARISON）用的是手选具体 packet，不受此影响。

## symbols.json 裁定

**不加"具体合约代码"字段**。主导合约随时间变，硬编码会腐烂。主导合约解析是运行时职责：
- Live：`futures_display_main_sina()` 取当日主导映射（symbols.json 注释 L2 已提及此 API）
- Historical（回测）：按 OI 逐日取 max-OI 合约（P2/deferred）

symbols.json 保持"品种白名单"语义不变。

## Open Questions（实现前须验证）

1. **akshare 具体合约日线 API 签名** —— 候选 `futures_zh_daily_sina(symbol="SA2701")`，实现前须验证返回列与历史长度。term_structure 已用的抓取方式若已覆盖，优先复用。
2. **历史主导合约解析（回测用）** —— OI-based determination 可行性，列 P2 不阻塞 live 修复。
3. **换月当日 packet** —— 若分析日恰为换月日，near/main 口径须与 MA 口径一致（都用新主导合约）。

## Next Action

1. 远远验证 Open Question 1（akshare API）
2. TDD：red test（SA 污染案例）→ 实现 P0（复用 term_structure 抓取）→ green
3. quality-gate 自检 → 我验收（按本裁定验收标准逐条）
4. P1 另开 handoff

---

**签名**: 布偶猫/宪宪 [claude-opus-4-8 🐾]
**日期**: 2026-08-26
