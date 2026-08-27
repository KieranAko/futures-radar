# research/ — 离线研究与回测

本目录与日常雷达（`pipeline/`）解耦，不参与报告生成，也不会被日常 Agent 流程加载。

```
research/
├── backtest/       # 保留的回测核心设计（切片/采样/批量/LMM replay/评分卡）
├── experiments/    # 已收口实验代码与测试（整体保留，供回放与 parity）
└── archive/        # 一次性实验脚本、参数研究模型、历史报告
    ├── backtest-scripts/
    ├── backtest-models/
    └── backtest-reports/
```

## 回测核心与数据文件库的关系

- `cache-slicer.cjs` / `time-sampler.cjs` / `batch-runner.cjs` 优先读取
  `data/daily/`（经 `data-store`），旧 `historical-cache.json` 仅作回退。
- `full-history-collector.cjs` 采集后同时写入 `data/daily/` 并导出
  `data/export/historical-cache.json`。
- `shared-backtest-lib.cjs` 的交易成本口径来自根 `lib/costs.cjs`。

## archive 内的脚本

归档脚本仅供复现历史结论，不作为核心能力维护；路径已随目录迁移修正，
但没有新增测试覆盖。
