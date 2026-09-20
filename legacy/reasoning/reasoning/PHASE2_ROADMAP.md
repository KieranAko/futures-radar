# Phase 2 Roadmap — 库存与供需事件字段

> 来源：Evidence Fields Extension 任务（2026-08-25）scope 裁定（宪宪）
> 裁定结果：路径 1（term_structure 落地）+ 路径 3（inventory / supply_demand_event 延后）

## 状态

- [x] Phase 1：term_structure（期限结构）已落地
  - `reasoning/lib/term-structure.js` + `collector/futures-term-structure.py`
  - Analyze 阶段调用，akshare 具体月份合约真实报价
- [ ] Phase 2：inventory（库存）— 数据源待确认
- [ ] Phase 2：supply_demand_event（供需事件）— 数据源待确认

## Phase 2: 库存字段（inventory）

**数据源待确认**:
- 原方案假设 `raw.json` 含 `inventory[symbol]` 时间序列 —— 实测不存在
- 原方案假设 mx-data 覆盖期货库存 —— 实测 mx-data 为股票/财务/关系数据，不覆盖
- 候选方向：
  - 交易所官方库存数据接口（上期所/大商所/郑商所/能源中心 周度库存）
  - 第三方数据源（Wind 万得，wind-mcp-skill 已全局安装，需确认期货库存覆盖范围）
  - 行业资讯站结构化抓取（需评估 freshness 与稳定性）

**字段结构参考**（原方案 §1.2，落地时复核）:
```javascript
{
  source: '<数据源>',
  asOf: '...', fetchedAt: '...', _published_at: '...',
  value, unit, weekly_change_pct, trend_3w, percentile: null,
  freshness: 'same_day|3d|7d', gap: null
}
```

**优先级**: P2（term_structure 单域增量验证后再启动）

## Phase 2: 供需事件字段（supply_demand_event）

**数据源待确认**:
- 原方案假设 `raw.json` 含 `events[symbol]` 事件列表 —— 实测不存在
- 需要设计事件抓取管道或人工标注
- 已知可行但未采用的路线：WebSearch+LLM 提取（2026-08-25 纯碱案例已验证：
  检修/停车事件可结构化提取，但 freshness 无法自动化保证）

**优先级**: P2（term_structure 单域增量验证后再启动）

## 启动条件

term_structure 单臂对照（`reasoning/test/SINGLE_ARM_COMPARISON.md`）证明
多域推理链对方向判断有正向增益后，按上面优先级启动 Phase 2。

## 2026-08-25 裁定（宪宪验收后）：Phase 2 不启动

单臂对照验收通过后，宪宪裁定 **不启动 Phase 2**（inventory / supply_demand_event），理由：

1. **term_structure 单字段已达成目标** — 从"结构性无法输出"（Before 10/10 强制 pass）
   恢复到"可输出"（After 8/10 方向 + 2/10 冲突 pass），准确率瓶颈已突破
2. **数据源不可靠** — inventory / supply_demand_event 需 WebSearch+LLM 或人工标注，
   freshness 与准确性无法保证
3. **边际收益递减** — SA0 假冲突是个案，不值得引入不稳定数据源

**后续路径**：mini Phase 2 = 真实 LLM（Claude/Gemini）跑 10 例 After prompts，
验证 reasoning_summary 是否真实多域交叉验证 → 质量达标则集成到 Analyze 阶段，
不达标则回调 prompt。由宪宪执行。

> 本文档后续作为历史记录保留，不再作为待办 roadmap 使用。
