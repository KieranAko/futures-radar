# 证伪测试运行报告 — DEMO (DEMO-MOMENTUM)

- 生成: 2026-08-28T09:34:42.666Z · seed=20260828 · folds=purged-expanding
- 数据: RB0 · 2015-01-05..2026-08-28 (4232 bars)

## 1. 策略级结果（G3 门禁）

| 指标 | 值 |
|---|---|
| trades | 83 |
| meanR | 0.987839 |
| sharpeTrade | 0.183465 |
| PF | 2.963567 |
| t (H0: mean=0) | 1.671442 (p=0.0984) |
| 95% CI (bootstrap) | [0.179395, 2.368088] |

### 门禁检查

| check | passed | detail |
|---|---|---|
| minTrades | FAIL | n=83 >= 200 |
| pfThreshold | PASS | PF=2.963567 vs 1.2 |
| ciExcludesZero | PASS | 95% CI=[0.179395,2.368088] |
| majorityYearsPositive | PASS | 8/12 years positive |

### 年度（fold）统计

| fold | n | meanR | hitRateNet |
|---|---|---|---|
| fold-1-2015 | 8 | 6.56439 | 0.625 |
| fold-2-2016 | 9 | 1.129178 | 0.777778 |
| fold-3-2017 | 4 | -0.209995 | 0.25 |
| fold-4-2018 | 7 | 0.133807 | 0.428571 |
| fold-5-2019 | 6 | 0.448152 | 0.5 |
| fold-6-2020 | 10 | 0.468629 | 0.5 |
| fold-7-2021 | 7 | -0.123671 | 0.285714 |
| fold-8-2022 | 7 | 0.232376 | 0.428571 |
| fold-9-2023 | 6 | 0.976057 | 0.666667 |
| fold-10-2024 | 6 | -0.576654 | 0.166667 |
| fold-11-2025 | 5 | 1.779188 | 1 |
| fold-12-2026 | 8 | -0.026526 | 0.375 |

## 2. 三基线对照

- **always-long**: n=12, meanRetBps=339.71 (per symbol per fold: hold from first non-jump bar open to last bar close, side=±1, roundtrip cost deducted)
  - strategy meanR=0.987839 · baseline meanBps=339.71 · baseline meanPseudoR=1.650471
- **always-short**: n=12, meanRetBps=-353.71 (per symbol per fold: hold from first non-jump bar open to last bar close, side=±1, roundtrip cost deducted)
  - strategy meanR=0.987839 · baseline meanBps=-353.71 · baseline meanPseudoR=-1.718489
- **random** (same-entries-flipped-side, 1 run(s)): pooled n=83, meanR=-0.310465
  - strategy − baseline meanR = 1.298305 · diff 95% CI=[0.311127, 2.753111] · beatsBaseline=true

## 3. 理论级证伪

- 假设: demo: 扣成本后 20 日突破动量仍有方向优势（命中率显著 > 50%）

| test | falsified | evidence |
|---|---|---|
| demo-direction-edge (扣成本命中率 > 50% 且二项检验 p < 0.05) | 是 | {"n":83,"hitRateNet":0.5060240963855421,"binomialP":0.49999999999997524} |
- killOn: demo-direction-edge 证伪 → retired（示例）

## 4. killRules 判定

| rule | metric | op | value | observed | triggered | onTrigger |
|---|---|---|---|---|---|---|
| demo-min-trades | n | lt | 200 | 83 | true | suspended |
| demo-pf | pf | lt | 1.2 | 2.963567 | false | suspended |

## 5. 建议状态

**retired**
- 理论级证伪成立: demo-direction-edge → retired
- killRule demo-min-trades 触发 (n lt 200, observed=83) → suspended
- 策略级门禁未通过: minTrades
- 最终状态由 t8 执行结论 + t9 复核 + 队长裁定决定；本引擎仅输出判定依据

## 6. 机器检查

- lookahead violations: 0（PIT 视图硬约束 + F5/F9 门禁全部通过）

- resultsHash: 17073cc3c2a25282fae936abe8aeccfff518ed4aa257a4e74c4b9a50b8b2a3b9
