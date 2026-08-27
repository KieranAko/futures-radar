# One-Time Experiment Scripts Archive

**Archived:** 2026-08-14  
**Reason:** 实验已完成，这些CLI脚本仅用于一次性评分，不再需要

## 归档文件

1. `historical-holdout-cli.js` — 23日留出回测
2. `opportunity-knob-scan-cli.js` — 16旋钮扫描
3. `opportunity-walk-forward-cli.js` — walk-forward稳定性
4. `train-scan-cli.js` — train网格扫描
5. `train2-scan-cli.js` — train-2评分
6. `valid2-score-cli.js` — valid-2评分（机会层+方向层双模式）

## 仍在使用的CLI

- `forward-cli.js` — 前向验证工具（register/settle/status）

## 说明

这些脚本的输出已写入 `data/futures-radar/experiments-archive/`，相关测试保留在 `test/` 目录中作为回归保护。如需复现历史实验，可从此目录恢复脚本。
