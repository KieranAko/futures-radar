# FinCoT Phase 1 Implementation Report

**Date**: 2026-08-24（初版 2026-08-15，本版为最终复审版）
**Version**: v1.3.2
**Status**: ✅ 工程组件已交付，现作为 Analyze/回测基础；预测有效性未证明，Phase 2 未批准
**Implementer**: 宪宪（P0/P1-2/P1-3/P1-5）→ 远远 接手（P1-4 与收尾修正）

---

## Executive Summary

Phase 1 全部交付物已完成：**77 tests / 13 suites / 77 pass / 0 fail**。

重要真实性结论：真实 artifact `20260805-1027-auto/raw.json` 的 `contracts.RB0.fetchedAt` 为 `2026-08-05T10:28:05.739623`，晚于用于回放的 `2026-08-04T16:30:00+08:00` 冻结点。adapter 现保留该源时间，不再推算或覆盖 `fetchedAt`；因此该 artifact 只能作为 adapter/schema smoke fixture，不能作为正式 point-in-time Phase 2 样本。

复审历程：
1. **初版（08-15）**：41 测试，砚砚复审发现与冻结规格 v1.2+v1.3.x 实质性偏离（P0×4：索取 thinking、8 个 schema 字段缺失、FinCoT 蓝图错误、executable gate 可绕过；P1×4：grounding 不查嵌套路径、无 renderer、前向数据未接真实 raw.json、可复现性未验证）。
2. **二轮（宪宪修复后）**：72 测试通过，P1-2（前向烟测框架）放行；砚砚裁定剩余三项补齐后即可最终复审，且**不得启动 Phase 2**：
   - P1-3：真实 raw.json adapter 及其测试 ✅
   - P1-5：packet-validator 时间边界一致性（validator 层负例）测试 ✅
   - P1-4：固定 packet 的四臂重复输出一致性测试 ✅（远远接手完成）
3. **收尾修正（远远）**：
   - raw-adapter MA 计算原为数组尾部锚定，存在未来数据泄漏的潜在 bug —— 改为锚定 signalDate 索引，并加 2 个回归测试（含未来 bar 构造用例）。
   - raw-adapter 原先根据 signalDate 伪造 `fetchedAt`，掩盖历史 artifact 实际在次日抓取的事实 —— 改为保留 `contractData.fetchedAt`，时间门禁按真实时间 fail closed。
   - `volume_oi` 补齐冻结 schema 中的 `openInterest_60d`，窗口同样止于 signalDate。
   - four-arm-e2e FinCoT fixture 分支名非规范（`macro`/`position`）——改为冻结 schema 的 `macro_fundamental`/`position_flow` 并加断言锁。

---

## Test Results Summary

```bash
cd .claude/skills/futures-radar
node --test reasoning/test/*.test.js
# ✅ 77 tests, 13 suites, 77 pass, 0 fail
```

| Suite | Tests | 覆盖内容 |
|-------|-------|----------|
| outcome-parity.test.js | 6 | 净收益公式与 shared-backtest-lib 对齐（含成本恒等式） |
| packet-validator.test.js | 11 | schema + 时间边界 4 约束，validator 层负例（P1-5） |
| packet-builder.test.js | 12 | executable gate 负例、字段排除、quality_check 结构 |
| post-processor.test.js | 8 | 11 字段冻结 schema、pass_reason 必填、branch_status 规范名 |
| grounding-validator.test.js | 8 | 嵌套路径 grounding、分层覆盖矩阵 |
| prompt-renderer.test.js | 6 | 四臂 prompt 渲染、变量替换无残留 |
| mock-packet-smoke.test.js | 5 | 合成 packet 端到端链路 + 时间边界负例 |
| forward-packet-smoke.test.js | 5 | 前向 5 日合成场景框架 |
| four-arm-e2e.test.js | 4 | 四臂 packet → render → parse → validate 全链路 |
| raw-adapter.test.js | 10 | 真实 raw.json 提取、源时间真实性、MA 锚定回归（P1-3） |
| reproducibility.test.js | 2 | 固定真实 packet 四臂重复一致性（P1-4） |

---

## 砚砚三项补齐要求 — 交付证据

### P1-3: 真实 raw.json Adapter

- **实现**: `lib/raw-adapter.js`
  - `buildPacketFromRawJson(path, symbol, signalDate)`：读取真实 artifact，提取 `contracts[symbol].ohlcv.{dates, close, volume, openInterest}`。
  - `extractContractFields(...)`：导出函数，`close_60d`/`volume_60d`/`avgVolume5d` 均锚定 signalDate 索引；MA20/MA60 窗口止于 signalIndex，**禁止尾部锚定**（尾部可能含未来 bar）。
  - `buildPacketFromRawJson` 保留 `contractData.fetchedAt`；不会把 signalDate 推算时间写入 evidence。
  - 当前历史 artifact 不含 `basis`、`inventory`、`member_position`，因此只能验证 `price_data` + `volume_oi` 分支；增强证据缺失不能被解释成模型 abstention 以外的经济事实。
- **测试**: `test/raw-adapter.test.js`（10 项，真实 artifact `data/futures-radar/runs/20260805-1027-auto/raw.json`，RB0 / 2026-08-04）：
  - schema 结构验证通过，但真实 source `fetchedAt` 晚于历史冻结点，时间边界验证与 executable gate 必须失败。
  - 回归 1：构造 65 bar（后 5 根为未来）验证 MA20/MA60 与 close_60d 均止于 signalDate，不得混入未来 bar。
  - 回归 2：历史不足 60 bar 时 `ma60 = null` 且 `price_data.gap = 'missing'`，volume_oi 不受影响。
  - 负例：不存在 symbol 抛错；signalDate 不在数据范围返回空 fields。

### P1-5: 时间边界一致性（validator 层负例）

- **实现**: `lib/packet-validator.js` `validateTimeBoundary`
  - 顶层 `marketCutoffAt`/`packetFrozenAt` 无效时间戳 → violation。
  - 必填字段 `price_data`/`volume_oi` 缺 `asOf` 或 `fetchedAt` → violation；可选字段（basis/inventory 等）豁免。
  - 四条既有约束保持不变：`asOf ≤ marketCutoffAt`、`fetchedAt ≤ packetFrozenAt`、`_published_at ≤ marketCutoffAt`、非法时间戳检测。
- **测试**: `test/packet-validator.test.js`（11 项）覆盖全部负例路径。

### P1-4: 固定 Packet 四臂重复输出一致性

- **实现**: `test/reproducibility.test.js`（2 项）
  - 固定真实 packet（RB0 / 2026-08-04）→ 四臂各重复 12 次，每次 LLM 输出用 4 种文本包裹变体（```json 围栏 / ``` 围栏 / 裸 JSON / 空白填充）模拟真实输出差异。
  - 断言：prompt 渲染逐次一致（render 层无隐藏非确定性）；direction / pass_reason / evidence_ids 跨 12 次一致率 100%；grounding 48/48 全通过。
  - 第二测试锁定 mock 语义（SP/UST-CoT/FinCoT=long、ST-CoT=pass/conflict_unresolved、FinCoT branch_status 规范键集），防 mock 被无意识改动。
- **边界声明（写入测试头）**：mock provider 本身确定，本测试证明**管线注入的非确定性为 0**。真实 LLM 的采样可复现性属 Phase 2 模型层评估，不在 Phase 1 范围。

---

## 冻结 Schema（post-processor 校验）

四臂统一输出 11 字段：

| 字段 | 约束 |
|------|------|
| symbol / signalDate / strategy | 必填 |
| direction | `long` \| `short` \| `pass` |
| confidence | `high` \| `medium` \| `low` |
| pass_reason | direction=pass 时必填：`data_insufficient` \| `model_abstain` \| `conflict_unresolved`；否则 null |
| evidence_ids / opposing_ids | 数组，元素须存在于 packet.fields（嵌套路径检查） |
| reasoning_summary | 必填，≤150 字符 |
| invalidate_if | 数组 |
| branch_status | fincot：`{regime: available必需, macro_fundamental, position_flow 可选: available\|abstain}`；非 fincot 必须 null |

**已知边界（砚砚已确认）**：FinCoT 三分支门禁为 **prompt 层 + schema 层**约束，不执行数据可用性的运行时强制 —— 数据可用性判定属模型推理，Phase 1 不实现。

## 时间边界四约束

1. `asOf ≤ marketCutoffAt`（T 日 15:00 收盘）
2. `fetchedAt ≤ packetFrozenAt`（T 日 16:30 冻结）
3. `_published_at ≤ marketCutoffAt`（外源数据发布时点）
4. 违约束字段被 packet builder 排除出 `required_available`/`optional_available`，可致 `executable = false`

---

## Implementation Files

**lib/**：`fincot-outcome.js`（净收益）、`packet-builder.js`、`packet-validator.js`、`post-processor.js`、`grounding-validator.js`、`prompt-renderer.js`（renderFourArmPrompts → sp/ustCot/stCot/finCot）、`raw-adapter.js`

**prompts/**：`sp-prompt.md`、`ust-cot-prompt.md`、`st-cot-prompt.md`、`fincot-prompt.md`（Regime/Macro-Fundamental/Position-Flow 三分支蓝图，分支名与 schema 冻结一致）

**test/**：11 个套件（见上表）

---

## Phase 1 Scope Confirmation

✅ **Phase 1 范围（砚砚批准）**：packet builder、四臂 prompts、schema/grounding/outcome parity 验证、真实数据 adapter、管线可复现性。

❌ **不属于 Phase 1**：Phase 2 采样、有效性与预测力结论、生产集成、真实 LLM 采样可复现性（temperature 层评估）。

**下一步唯一动作**：砚砚最终复审。Phase 2 未经批准不得启动。

---

**END REPORT**
