# Signal Pool Blueprint — 信号池 v6 设计

## 定位

信号池是**信号质量追踪器**，不是交易单执行流水账。

- 信号 = 一张生效观察的交易单（机会分析 → 交易员 LLM → 交易单入池）。
- 交易单自带生效条件与证伪条件，因此信号可验证、可证伪。
- 信号池追踪：市场是在一步步实现交易单的预测，还是一步步证伪它。

## 身份与时间锚点

- **同一信号 = symbol + contract + storyChainId/主题**。交易信号必须可执行，合约是身份的一部分；换合约 = 新信号。
- **T0 = 信号出生日（createdDate），永不变**。所有 T+N（T+1 确认、T+2 入场、时间止损）都从 T0 起算。
- 版本/报价日期（quoteDate / signalDate）只作“这一版交易单是哪一轮 run 产生的”，不参与 T+N 计算。

## 交易单的生命

- `livingTicket`：市场当前正在追踪、已由人类采纳的交易单（出生单默认 living）。
- 每轮 run 的新 executable 交易单 = 同一信号的**新报价**：
  - 结构化 diff（`signals/lib/ticket-diff.cjs`）逐字段比较；
  - 归类 `aligned / refined / conflicted`（仅展示用）；
  - **不自动采纳**：新报价以 `decision.status = pending` 进入 ticketHistory；
  - 市场兑现/证伪继续按 livingTicket 追踪，pending 报价不驱动信号进出池。
- 反向 executable 报价同样只记录 conflicted 新报价，**不自动翻转关闭旧信号**。

## 对账 LLM 的边界

- 输入：livingTicket + 待决策新报价 + 结构化 diff + 市场追踪状态；
- 输出：差异说明与冲突解释（`signals/reconciliation/ticket-reconciliation-lib.cjs`）；
- **不判胜负、不改单、不给方向结论**；判断权在人类。

## 人类决策（dashboard 交互）

- dashboard 信号池并排展示 livingTicket 与新报价，diff 字段高亮；
- 操作：**采用新报价 / 维持旧单 / 暂停 / 关闭**，必须填理由；
- 决策 JSON（`futures-radar-signal-decisions/1`）由 dashboard 导出，`signals/cli/signal-pool-decision-cli.cjs apply` 回填；
- 采用同向报价：更新 livingTicket，T0 不变；
- 采用反向报价：旧信号按 flipped 关闭，新报价作为新信号出生（新 T0）。

## 自动部分（池子仍自己做的）

- livingTicket 的触发/证伪/时间止损的确定性验证；
- 价格追踪、兑现进度、失效距离；
- fulfilled / invalidated_q5 / faded / expired 出池。
