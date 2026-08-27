# P0-4 Fix Implementation Summary（历史归档）

**Date:** 2026-08-08  
**Historical Status:** 当时完成；一次性 replay 实现、fixtures 与对应测试已于 2026-08-25 深度清理
**Historical Tests:** 95 passing, 0 failing（仅为结案时证据，不表示当前可重跑）

> 本文仅保留 P0-4 当时的实现与验证记录。当前机会层、方向层及 retained test suite 的真相源为 `experiments/STATUS.md`；本文列出的 `baseline-parity.js`、`experiment-runner.js` 及其 run-dependent tests 已删除，不再是可执行入口。

---

## Overview

Successfully transformed E1-E4b experiments from statistical post-processors to end-to-end replay systems that verify baseline parity trade-by-trade across 29 conditional OOS dates.

---

## Implementation Details

### Step 1: Replay Adapter (7 tests)
**File:** `experiments/lib/replay-adapter.js`

Unified 29-date artifact loader with validation functions:
- `loadWalkForwardArtifact()` — Loads walk-forward-result.json
- `getTestRunDates()` — Extracts 29 test date metadata
- `getBaselineTrades()` — Extracts baseline trades from allOOSTrades
- `groupTradesBySignalDate()` — Groups trades by signal date
- `getZeroSignalDates()` — Identifies 9 zero-signal dates
- `validate29DateStructure()` — Enforces 29 dates, uniqueness, chronology

**Tests:** `experiments/test/replay-adapter.test.js`

---

### Step 2: Baseline Parity Verification (Implicit in baseline-parity.js)
**File:** `experiments/baseline-parity.js`

Verified exact HV=1 baseline reproduction across all 29 dates:
- Baseline config: `{hvThreshold: 1, atrThreshold: 2, emaSlopeThreshold: 0.3}`
- All 29 dates achieve parity (trade-by-trade matching)
- Direction logic uses EMA slope sign (5-point OLS regression)
- Exit price: T+11 close (not open)
- Cost model: commission=0.0003, slippage=0.0002

**Verification Output:** All dates show `✅ PARITY ACHIEVED`

---

### Step 3: Experiment Runner (6 tests)
**Files:**
- `experiments/lib/experiment-runner.js` (3 tests)
- `experiments/test/experiment-runner.test.js`
- `experiments/test/experiment-runner-invariants.test.js` (3 tests)

End-to-end replay infrastructure:
- `generateExperimentData(baselineConfig, challengers)` — Replays baseline vs challengers
- `replaySignalDate(signalDate, raw, config)` — Replays single date with given config
- `computeDateCohortReturn(trades)` — Averages trade returns for date
- Input validation: config structure, finite numbers, required fields
- Output validation: exactly 29 returns, all finite

**Tests:**
- Baseline returns match artifact trades
- Challenger configs generate valid returns
- Zero-signal dates produce return=0
- Rejects invalid inputs (NaN, missing fields, wrong types)
- Output structure validated (29 finite numbers)

---

### Step 4: V5 Core Extraction
**Status:** SKIPPED

缅因猫's feedback clarified that E4b needs multi-position selection with risk budgeting, not the full 9-gate event-driven simulator. The simplified portfolio-simulator.js in Step 5 provides required functionality.

---

### Step 5: Portfolio Simulator (5 tests)
**Files:**
- `experiments/lib/portfolio-simulator.js`
- `experiments/test/portfolio-simulator.test.js`

Multi-position selection with ATR risk budgeting:

**Key Functions:**
- `selectTopCandidates(candidates, maxPositions, criterion)` — Ranks by ATR14% or grossReturn
- `calculatePositionSize(equity, budgetRate, atr14Pct, stopATRMult)` — Risk-based sizing
- `simulatePortfolio(dateMetadata, getCandidatesForDate, config)` — Full simulation loop

**Position Sizing Formula:**
```javascript
riskBudget = equity × budgetRate
stopDistancePct = atr14Pct × stopATRMult / 100
positionSize = riskBudget / (equity × stopDistancePct)
```

**Portfolio Constraints:**
- `maxDailyNew` — Max new positions per signal date (default: 5)
- `maxTotalPositions` — Max open positions at any time (default: 10)
- `budgetRate` — Risk per position (default: 0.02 = 2%)
- `stopATRMult` — Stop distance in ATR multiples (default: 2.0)

**Economic Gates:**
- No liquidation (equity > 0)
- Drawdown ≤ maxDrawdownThreshold (default: 15%)
- Final equity ≥ initialCapital × minFinalEquity (default: 1.05x = 5% gain)

**Tests:**
- Single candidate executes correctly
- Max daily positions constraint enforced
- Risk budget position sizing correct
- Zero-signal dates handled
- Position exits on correct date

---

### Step 6: Production Invariants (3 tests)
**File:** `experiments/test/experiment-runner-invariants.test.js`

Input validation:
- baselineConfig must be object with hvThreshold, atrThreshold, emaSlopeThreshold
- All config values must be finite numbers
- challengers must be array with {name, config} structure
- Each challenger config validated same as baseline

Output validation:
- Exactly 29 returns per experiment
- All returns must be finite numbers

Structure validation (in replay-adapter.js):
- Exactly 29 dates (via validate29DateStructure)
- Dates unique and strictly increasing (chronological)
- Zero-signal dates preserved (9 dates with no trades retained)

---

### Step 7: Documentation Sync
**Files Updated:**
- `experiments/STATUS.md` — Updated to reflect completion
- `experiments/IMPLEMENTATION_SUMMARY.md` — This file

---

## File Inventory

**New Files (7):**
1. `experiments/baseline-parity.js` — Baseline reproduction verification script
2. `experiments/lib/replay-adapter.js` — 29-date artifact loader
3. `experiments/lib/experiment-runner.js` — End-to-end replay runner
4. `experiments/lib/portfolio-simulator.js` — Multi-position simulator
5. `experiments/test/replay-adapter.test.js` — 7 tests
6. `experiments/test/experiment-runner.test.js` — 3 tests
7. `experiments/test/experiment-runner-invariants.test.js` — 3 tests
8. `experiments/test/portfolio-simulator.test.js` — 5 tests

**Modified Files (1):**
- `experiments/STATUS.md` — Updated with completion status

---

## Test Summary

**Total:** 95 tests passing, 0 failing

**Breakdown:**
- `futures-radar/test/*.test.js` — 77 tests (E1-E4a statistical tests, feature calculations)
- `experiments/test/replay-adapter.test.js` — 7 tests
- `experiments/test/experiment-runner.test.js` — 3 tests
- `experiments/test/experiment-runner-invariants.test.js` — 3 tests
- `experiments/test/portfolio-simulator.test.js` — 5 tests

---

## Next Steps

**Phase 8: Discovery Run (Ready to Execute)**
1. Run E1 scanner experiments (4 candidates vs ATR14 baseline)
2. Run E2 eligibility ablation (3 variants vs combined gate)
3. Run E3 direction experiments (2 candidates + 3 random controls)
4. Run E4a hold period (H7/H15 vs H10 baseline)
5. Run E4b account-level gate on winning config
6. Generate discovery_results.json
7. Registry freeze + SHA-256 hash
8. Start forward embargo clock (≥30 paired evaluation dates)

---

## Key Learnings

1. **End-to-end replay > post-processing:** Loading raw data and replaying configs ensures reproducibility and verifies baseline parity trade-by-trade
2. **Direction uses EMA slope sign:** Not MA20/MA60 comparison as initially assumed
3. **Multi-position selection is the requirement:** E4b doesn't need full 9-gate event-driven simulator, just portfolio-level selection with risk constraints
4. **Zero-signal dates must be preserved:** 9 of 29 dates have no trades, must retain as return=0
5. **Invariants catch errors early:** Input/output validation prevents NaN propagation and dimension mismatches
6. **29-date structure is non-negotiable:** Exactly 29 unique, chronologically ordered dates from walk-forward artifact

---

**Implementation Time:** ~4 hours (2026-08-08 session)  
**Lines of Code:** ~850 (excluding tests)  
**Test Coverage:** 18 tests covering replay, experiment generation, and portfolio simulation
