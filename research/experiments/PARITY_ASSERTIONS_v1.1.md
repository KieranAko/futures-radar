# Registry v1.1 ↔ Source Code Parity Assertions

**Purpose:** Verify that every registry definition has exact corresponding source code implementation.

**Status:** Pre-freeze verification checklist

---

## P1 Baseline Parameters

| Registry Definition | Source File | Line Range | Parity Assertion | Status |
|---------------------|-------------|------------|------------------|--------|
| **Ranker: ATR14 percentage** | `shared-backtest-lib.cjs` | L111-121 | `atr14 = calculateATR(..., 14); atrPct = (atr14 / currentPrice) * 100` | ⏳ |
| NOT percentile, is percentage | Same | L121 | Variable name is `atrPct`, not `atrPercentile` | ⏳ |
| **Pre-ranking filter: liquidity only** | `shared-backtest-lib.cjs` | L108-109 | `avgTurnover5d >= 1e8 && avgOI5d >= 10000`, no other filters | ⏳ |
| **Post-ranking filter: ±9.5% only** | `shared-backtest-lib.cjs` | L221-237 | `runHardFilter` checks `change >= 0.095`, nothing else | ⏳ |
| NO 3%+amplitude filter | `shared-backtest-lib.cjs` | L221-237 | Code does NOT contain amplitude/consecutive check | ⏳ |
| **Entry timing: T+1 open** | `shared-backtest-lib.cjs` | L245-261 | `entryIdx = signalIdx + 1; entryPrice = open[entryIdx]` | ⏳ |
| **Hold period: T+10** | `purged-walkforward.cjs` | L74 | `simulateExit(symbol, raw, entry.entryIdx, 10)` | ⏳ |
| NOT T+5 | `purged-walkforward.cjs` | L74 | Hard-coded literal `10`, not `5` or `CONFIG.HOLD_DAYS` | ⏳ |
| **Cost: double-sided slippage** | `shared-backtest-lib.cjs` | L281-285 | `slippage = entryPrice * 0.0002 * 2` | ⏳ |
| Formula exact | `shared-backtest-lib.cjs` | L281-285 | `(avgPrice * 0.0003 + entryPrice * 0.0002 * 2) / entryPrice` | ⏳ |
| **Test runs: 29 conditional OOS** | `purged-walkforward.cjs` | L273-305 | Gate 1 output: `Test: 29, Train: 35` | ⏳ |
| NOT 44 full history | `purged-walkforward.cjs` | L40-44 | FOLDS definition: testStart 15, testEnd 43 → 10+10+9=29 | ⏳ |

**Verification Commands:**
```bash
# Verify Hold=10
grep -n "simulateExit.*10" backtest/purged-walkforward.cjs

# Verify double-sided slippage
grep -A 3 "function calculateCosts" backtest/shared-backtest-lib.cjs | grep "* 2"

# Verify 29 test runs
node backtest/purged-walkforward.cjs 2>&1 | grep "Gate 1"
```

---

## Feature Calculation Index Ranges

### HV20 Percentile

| Registry Definition | Implementation | Parity Assertion | Status |
|---------------------|----------------|------------------|--------|
| **HV20: 20 log returns** | `lib/features.cjs` (TBD) | `returns = [log(close[i]/close[i-1]) for i in range(n-20, n)]` | ⏳ |
| Returns array length | Same | `assert len(returns) == 20` | ⏳ |
| First return | Same | `assert returns[0] == log(close[n-20] / close[n-21])` | ⏳ |
| Last return | Same | `assert returns[-1] == log(close[n-1] / close[n-2])` | ⏳ |
| **90-day percentile: 110 prices → 91 rolling HV20** | Same | `window110 = close[-110:]; assert len(window110) == 110` | ⏳ |
| Rolling HV count | Same | `assert len(hv90d) == 91` (includes current endpoint) | ⏳ |

**Test Vector:**
```python
# Synthetic flat prices: close = [100] * 110
# Expected: HV20 ≈ 0, percentile undefined (all zeros)
```

### ER20

| Registry Definition | Implementation | Parity Assertion | Status |
|---------------------|----------------|------------------|--------|
| **ER20: 21 prices, 20 intervals** | `lib/features.cjs` (TBD) | `assert len(close) >= 21` | ⏳ |
| Net change | Same | `net = abs(close[n-1] - close[n-21])` | ⏳ |
| Daily changes | Same | `changes = [abs(close[i] - close[i-1]) for i in range(n-20, n)]` | ⏳ |
| Daily changes count | Same | `assert len(changes) == 20` | ⏳ |

**Test Vector:**
```python
# Trending prices: close = [100, 101, 102, ..., 120] (21 prices)
# Expected: net = 20, sum = 20, ER20 = 1.0
```

### ATR5 Percentile

| Registry Definition | Implementation | Parity Assertion | Status |
|---------------------|----------------|------------------|--------|
| **ATR5: 5 true ranges** | `lib/features.cjs` (TBD) | `tr = [max(...) for i in range(n-5, n)]` | ⏳ |
| TR array length | Same | `assert len(tr) == 5` | ⏳ |
| **90-day percentile: 95 bars → 91 rolling ATR5%** | Same | `window95 = close[-95:]; assert len(window95) == 95` | ⏳ |
| ATR5% calculation | Same | `atr5_pct = (atr5 / close[i+4]) * 100` (normalized by endpoint) | ⏳ |
| Rolling ATR count | Same | `assert len(atr90d_pct) == 91` (includes current) | ⏳ |

**Test Vector:**
```python
# Use shared-backtest-lib.cjs calculateATR(high, low, close, 5) as reference
# Verify our ATR5 matches reference implementation
```

---

## E1 Statistical Testing

| Registry Definition | Implementation | Parity Assertion | Status |
|---------------------|----------------|------------------|--------|
| **Paired deltas: Δ_k[d] = R_k[d] - R_ATR14[d]** | `runners/e1-paired.cjs` (TBD) | Delta calculated per date, not per symbol | ⏳ |
| **Studentized T:** | Same | `t = mean(Δ) / (std(Δ) / sqrt(29))` | ⏳ |
| NOT divided by std alone | Same | Denominator is `std(Δ) / sqrt(N)`, not `std(Δ)` | ⏳ |
| **Block sign-flip: 6 blocks** | `null-generators/e1-block-signflip.cjs` (TBD) | `blocks = [[1-5], [6-10], [11-15], [16-20], [21-25], [26-29]]` | ⏳ |
| 29 dates → 6 blocks | Same | 5 full blocks + 1 remainder block of 4 | ⏳ |
| **Common block signs** | Same | All 4 candidates use SAME block_signs per permutation | ⏳ |
| **One-sided rejection:** | Same | `reject if t_obs > quantile(null, 0.95)` | ⏳ |
| **Limitation note** | Same | 2^6 = 64 unique patterns, report as discovery heuristic | ⏳ |

**Test Vector:**
```python
# All deltas = [+1] * 29 (constant positive)
# Expected: mean = 1, std = 0, T = +inf
# Null distribution: all permutations also T = ±inf (sign-flipped mean, zero std)
```

---

## E2 Regime Filter

| Registry Definition | Implementation | Parity Assertion | Status |
|---------------------|----------------|------------------|--------|
| **Pre-filter: ATR14 Top-10** | `runners/e2-regime.cjs` (TBD) | Policy A and B both start from `atr14_ranker(raw, date)` | ⏳ |
| **High-HV: percentile ≥ 50** | Same | `symbols_B = [s for s in symbols_A if hv20_pctl(s) >= 50]` | ⏳ |
| **Low-HV: percentile < 50** | Same | `symbols_B = [s for s in symbols_A if hv20_pctl(s) < 50]` | ⏳ |
| **Two-sided test** | Same | `reject if abs(t_obs) > critical_value` | ⏳ |
| **Coverage: 0 symbols on >20%** | Same | `failure_rate = sum(len(symbols_B) == 0) / 29 > 0.20` | ⏳ |

---

## E3 Direction Policy

| Registry Definition | Implementation | Parity Assertion | Status |
|---------------------|----------------|------------------|--------|
| **Fixed cohort** | `runners/e3-direction.cjs` (TBD) | Same `symbols = atr14_ranker(...)` for policy A and B | ⏳ |
| **EMA20 slope > 0.003 → long** | Same | `slope = (ema20 - ema20_prev) / ema20_prev; if slope > 0.003: long` | ⏳ |
| **EMA20 slope < -0.003 → short** | Same | `if slope < -0.003: short` | ⏳ |
| **Else → neutral (skip)** | Same | `else: net_return = 0` | ⏳ |
| **Net return formula** | Same | `long: (exit-entry)/entry - costs; short: (entry-exit)/entry - costs` | ⏳ |
| **One-sided test** | Same | `reject if t_obs > quantile(null, 0.95)` | ⏳ |

**Test Vector:**
```python
# Flat prices: entry=100, exit=100, costs=0.0007
# Long: (100-100)/100 - 0.0007 = -0.0007
# Short: (100-100)/100 - 0.0007 = -0.0007
# Random 50/50: mean ≈ -0.0007 (costs eat both sides)
```

---

## E4 Execution Parameters

| Registry Definition | Implementation | Parity Assertion | Status |
|---------------------|----------------|------------------|--------|
| **H10 baseline** | `runners/e4-holdperiod.cjs` (TBD) | `simulateExit(..., holdDays=10)` | ⏳ |
| NOT H5 | Same | Baseline is 10, not 5 | ⏳ |
| **H7 vs H10** | Same | Paired delta calculated | ⏳ |
| **H15 vs H10** | Same | Paired delta calculated | ⏳ |
| **Bonferroni α=0.025** | Same | Two comparisons, each tested at 0.025 | ⏳ |
| **N10 baseline** | `runners/e4-portfoliosize.cjs` (TBD) | Ranker outputs Top 10 | ⏳ |
| **N5: take first 5** | Same | `symbols_N5 = ranker_output[:5]` | ⏳ |
| **N15: ranker outputs 15** | Same | Ranker must be modified to output Top 15 | ⏳ |

---

## RNG Reproducibility

| Registry Definition | Implementation | Parity Assertion | Status |
|---------------------|----------------|------------------|--------|
| **LCG algorithm** | `lib/rng.cjs` (TBD) | `state = (state * 1103515245 + 12345) & 0x7fffffff` | ⏳ |
| **Seed ranges** | Same | E1: 1000-10999, E2: 2000-11999, E3: 3000-12999, Forward: 5000-14999 | ⏳ |
| **No seed overlap** | Same | Each experiment uses disjoint seed ranges | ⏳ |

**Test Vector:**
```python
# Seed 1000, first 5 outputs:
rng = create_rng(1000)
assert rng() ≈ 0.00090748... (implementation-dependent, record actual)
```

---

## Pre-Freeze Checklist

- [ ] Run `node backtest/purged-walkforward.cjs`, verify Gate 1 = 29 test runs
- [ ] Grep `simulateExit.*10`, verify Hold=10 in purged-walkforward.cjs L74
- [ ] Grep `* 2` in calculateCosts, verify double-sided slippage L284
- [ ] Implement HV20 calculator, run test vector (flat prices → HV≈0)
- [ ] Implement ER20 calculator, run test vector (trending prices → ER=1.0)
- [ ] Implement ATR5 calculator, verify against shared-backtest-lib.cjs reference
- [ ] Implement block sign-flip, verify 29 dates → 6 blocks
- [ ] Implement studentized T, test zero-variance cases (sd=0, mean=0 → T=0; sd=0, mean≠0 → T=±inf)
- [ ] Implement EMA20 slope direction, test flat/trending cases
- [ ] Run full E1 discovery on 29 runs, verify all assertions pass
- [ ] Generate SHA-256 hash of all locked files
- [ ] Record hash in registry header

---

**End of Parity Assertions v1.1**
