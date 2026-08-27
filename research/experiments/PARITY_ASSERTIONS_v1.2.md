# Registry v1.2 ↔ Source Code Parity Assertions

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
| **Model eligibility: observed policy** | `momentum-ema20-parameterized.cjs` | L53-92 | Uses `1.1/2.0/0.3` fixed thresholds for experiments | ⏳ |
| HV5/HV20 >= 1.1 | Same | L62 | `if (c.hvRatio < 1.1) continue` | ⏳ |
| ATR14% >= 2.0 | Same | L63 | `if (c.atrPct < 2.0) continue` | ⏳ |
| **EMA20 direction: 5-point regression** | `momentum-ema20-parameterized.cjs` | L25-45 | OLS fit on last 5 EMA values | ⏳ |
| Slope threshold ±0.3 %/day | Same | L73-77 | `if (Math.abs(emaSlope) < 0.3) continue` | ⏳ |
| **Entry timing: T+1 open** | `shared-backtest-lib.cjs` | L245-261 | `entryIdx = signalIdx + 1; entryPrice = open[entryIdx]` | ⏳ |
| **Hold period: T+10** | `purged-walkforward.cjs` | L74 | `simulateExit(symbol, raw, entry.entryIdx, 10)` | ⏳ |
| NOT T+5 | `purged-walkforward.cjs` | L74 | Hard-coded literal `10`, not `5` or `CONFIG.HOLD_DAYS` | ⏳ |
| **Cost: double-sided slippage** | `shared-backtest-lib.cjs` | L281-285 | `slippage = entryPrice * 0.0002 * 2` | ⏳ |
| Formula exact | `shared-backtest-lib.cjs` | L281-285 | `((entry+exit)/2 * 0.0003 + entry * 0.0002 * 2) / entry` | ⏳ |
| **Test runs: 29 conditional OOS** | `purged-walkforward.cjs` | L273-305 | Gate 1 output: `Test: 29, Train: 35` | ⏳ |
| NOT 44 full history | `purged-walkforward.cjs` | L40-44 | FOLDS definition: testStart 15, testEnd 43 → 10+10+9=29 | ⏳ |
| **Tie-break: symbol lexicographic** | TBD (experiments/) | TBD | Stable sort by symbol name when ATR14% equal | ⏳ |

**Verification Commands:**
```bash
# Verify Hold=10
grep -n "simulateExit.*10" backtest/purged-walkforward.cjs

# Verify double-sided slippage
grep -A 3 "function calculateCosts" backtest/shared-backtest-lib.cjs | grep "* 2"

# Verify 29 test runs
node backtest/purged-walkforward.cjs 2>&1 | grep "Gate 1"

# Verify observed policy thresholds
grep -n "hvThreshold\|atrThreshold\|emaSlopeThreshold" backtest/models/momentum-ema20-parameterized.cjs
```

---

## Feature Calculation Index Ranges

### HV20 Percentile

| Registry Definition | Implementation | Parity Assertion | Status |
|---------------------|----------------|------------------|--------|
| **HV20: 20 log returns** | `lib/features.cjs` (TBD) | `returns = [log(close[i]/close[i-1]) for i in range(T-19, T+1)]` | ⏳ |
| Returns array length | Same | `assert len(returns) == 20` | ⏳ |
| First return | Same | `assert returns[0] == log(close[T-19] / close[T-20])` | ⏳ |
| Last return | Same | `assert returns[-1] == log(close[T] / close[T-1])` | ⏳ |
| Variance: population | Same | `std_population(returns) = sqrt(sum((x-mean)^2) / n)`, NOT n-1 | ⏳ |
| Annualization factor | Same | `sqrt(252)` exactly | ⏳ |
| **90-day percentile: 110 prices → 90 rolling HV20** | Same | `window110 = close[T-109:T-19]; assert len(window110) == 90` | ⏳ |
| Rolling HV count | Same | `for i in range(90): ...` produces 90 HV values | ⏳ |
| No overlap with current | Same | `window110[-1] == close[T-20]` (last window ends before current) | ⏳ |
| Percentile ties | Same | `sum(hv <= hv20_annual for hv in hv90d) / 90 * 100` (use <=) | ⏳ |

**Test Vector:**
```python
# Synthetic flat prices: close = [100] * 110
# Expected: all log returns = 0, HV20 = 0
# Percentile: 50 (all values equal, half <= current)
```

### ER20

| Registry Definition | Implementation | Parity Assertion | Status |
|---------------------|----------------|------------------|--------|
| **ER20: 21 prices, 20 intervals** | `lib/features.cjs` (TBD) | `assert len(close) >= 21` | ⏳ |
| Net change | Same | `net = abs(close[T] - close[T-20])` | ⏳ |
| Daily changes | Same | `changes = [abs(close[i] - close[i-1]) for i in range(T-19, T+1)]` | ⏳ |
| Daily changes count | Same | `assert len(changes) == 20` | ⏳ |
| First change | Same | `changes[0] == abs(close[T-19] - close[T-20])` | ⏳ |
| Last change | Same | `changes[-1] == abs(close[T] - close[T-1])` | ⏳ |

**Test Vector:**
```python
# Trending prices: close = [100, 101, 102, ..., 120] (21 prices)
# Expected: net = 20, sum(changes) = 20, ER20 = 1.0
```

### ATR5 Percentile

| Registry Definition | Implementation | Parity Assertion | Status |
|---------------------|----------------|------------------|--------|
| **ATR5: 5 true ranges** | `lib/features.cjs` (TBD) | `tr = [max(...) for i in range(T-4, T+1)]` | ⏳ |
| TR array length | Same | `assert len(tr) == 5` | ⏳ |
| First TR uses prev | Same | `tr[0]` uses `close[T-5]` as previous for bar T-4 | ⏳ |
| Last TR uses prev | Same | `tr[-1]` uses `close[T-1]` as previous for bar T | ⏳ |
| **90-day percentile: 95 bars → 90 rolling ATR5%** | Same | `window95 = ohlc[T-94:T-4]; assert len(window95) == 90` | ⏳ |
| Endpoint loop | Same | `for e in range(5, 95):` produces endpoints 5..94 (90 values) | ⏳ |
| ATR5% calculation | Same | `atr5_pct = (atr5 / close[e]) * 100` (normalized by endpoint) | ⏳ |
| No overlap with current | Same | `window95[-1] == close[T-5]` (last window ends before current) | ⏳ |
| No i>0 fallback | Same | Code does NOT contain `if i>0 else 0` (all TR use valid prev) | ⏳ |
| Percentile ties | Same | `sum(x <= atr5_pct for x in atr90d_pct) / 90 * 100` (use <=) | ⏳ |

**Test Vector:**
```python
# Use shared-backtest-lib.cjs calculateATR(high, low, close, 5) as reference
# Verify our ATR5 matches reference implementation exactly
```

---

## Statistical Testing

| Registry Definition | Implementation | Parity Assertion | Status |
|---------------------|----------------|------------------|--------|
| **Paired deltas: Δ[d] = R_k[d] - R_baseline[d]** | `runners/e1-paired.cjs` (TBD) | Delta calculated per date, not per symbol | ⏳ |
| **Studentized T:** | Same | `t = mean(Δ) / (std(Δ) / sqrt(29))` | ⏳ |
| NOT divided by std alone | Same | Denominator is `std(Δ) / sqrt(N)`, not `std(Δ)` | ⏳ |
| **Zero-variance: mean=0** | Same | `if std==0 and mean==0: return 0` | ⏳ |
| **Zero-variance: mean>0** | Same | `if std==0 and mean>0: return +inf` | ⏳ |
| **Zero-variance: mean<0** | Same | `if std==0 and mean<0: return -inf` | ⏳ |
| **Block structure: 6 blocks** | `null-generators/block-signflip.cjs` (TBD) | `blocks = [[0-4], [5-9], [10-14], [15-19], [20-24], [25-28]]` | ⏳ |
| 29 dates → 6 blocks | Same | 5 full blocks + 1 remainder block of 4 | ⏳ |
| **64-pattern enumeration** | Same | `for pattern in itertools.product([+1,-1], repeat=6):` all 64 | ⏳ |
| NOT 10k resampling | Same | Code does NOT contain `for seed in range(10000):` | ⏳ |
| **Observed = all-plus** | Same | `(+1,+1,+1,+1,+1,+1)` is the observed assignment | ⏳ |
| **Common block signs** | Same | All 4 candidates use SAME block_signs per pattern | ⏳ |
| **Max-T FWER:** | Same | `null_max_T = [max(t_k for k in candidates) for pattern in 64]` | ⏳ |
| **Adjusted p-value:** | Same | `p_adj(k) = #{patterns: max_T >= t_k_obs} / 64` | ⏳ |
| **One-sided rejection (E1, E3):** | Same | `reject if t_obs > quantile(null_max_T, 0.95)` | ⏳ |
| **Two-sided rejection (E2):** | Same | `reject if abs(t_obs) > quantile(abs(null_max_T), 0.95)` | ⏳ |
| **NO mid-p correction** | Same | Use exact count/64, not (count+0.5)/64 | ⏳ |

**Test Vector:**
```python
# All deltas = [+1] * 29 (constant positive)
# Expected: mean = 1, std = 0, T = +inf
# Null distribution: all permutations also have std=0, T = ±inf (sign-flipped mean)
```

---

## E2 Eligibility Gate

| Registry Definition | Implementation | Parity Assertion | Status |
|---------------------|----------------|------------------|--------|
| **Baseline: combined gate** | `runners/e2-eligibility.cjs` (TBD) | `HV5/HV20 >= 1.1 AND ATR14% >= 2.0` | ⏳ |
| **Only-HV variant** | Same | `HV5/HV20 >= 1.1` (remove ATR check) | ⏳ |
| **Only-ATR variant** | Same | `ATR14% >= 2.0` (remove HV check) | ⏳ |
| **No-eligibility variant** | Same | Remove both checks (all scanner outputs eligible) | ⏳ |
| **Fixed upstream** | Same | All variants start from same ATR14% Top10 after hard filter | ⏳ |
| **Two-sided test** | Same | `reject if abs(t_obs) > critical_value` | ⏳ |
| **Coverage: 0 symbols on >20%** | Same | `failure_rate = sum(len(eligible) == 0) / 29 > 0.20` | ⏳ |

---

## E3 Direction Policy

| Registry Definition | Implementation | Parity Assertion | Status |
|---------------------|----------------|------------------|--------|
| **Fixed cohort** | `runners/e3-direction.cjs` (TBD) | Same `symbols = eligible_after_gate(...)` for all direction rules | ⏳ |
| **EMA20 5-point regression** | Same | OLS fit on last 5 EMA20 values, return %/day slope | ⏳ |
| **Long threshold** | Same | `if slope >= +0.3: direction = 'long'` | ⏳ |
| **Short threshold** | Same | `if slope <= -0.3: direction = 'short'` | ⏳ |
| **Neutral retained** | Same | `else: direction = 'neutral'; return = 0` (date not deleted) | ⏳ |
| **change5d sign** | Same | `change5d = (close[T] - close[T-5]) / close[T-5] * 100` | ⏳ |
| **Donchian breakout** | Same | `high20 = max(high[T-19:T+1]); low20 = min(low[T-19:T+1])` | ⏳ |
| **Control: always-long** | Same | `direction = 'long'` for all symbols in cohort | ⏳ |
| **Control: always-short** | Same | `direction = 'short'` for all symbols in cohort | ⏳ |
| **Control: random** | Same | `direction = 'long' if random() > 0.5 else 'short'` | ⏳ |
| **Controls cannot win** | Same | Excluded from winner selection even if p_adj < 0.05 | ⏳ |
| **Net return formula (long)** | Same | `(exit - entry) / entry - costs` | ⏳ |
| **Net return formula (short)** | Same | `(entry - exit) / entry - costs` | ⏳ |
| **One-sided test** | Same | `reject if t_obs > quantile(null_max_T, 0.95)` | ⏳ |
| **Coverage: >20% all-neutral** | Same | `failure = sum(all_neutral_on_date) / 29 > 0.20` | ⏳ |

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
| **H7 vs H10** | Same | Paired delta: Δ[d] = R_H7[d] - R_H10[d] | ⏳ |
| **H15 vs H10** | Same | Paired delta: Δ[d] = R_H15[d] - R_H10[d] | ⏳ |
| **Bonferroni α=0.025** | Same | Two comparisons, each tested at 0.025 (family 0.05) | ⏳ |
| **E4b: event-driven sim** | `runners/e4b-account-gate.cjs` (TBD) | Parameterized signal provider (baseline/challenger) | ⏳ |
| **Initial capital** | Same | 1,000,000 CNY normalized | ⏳ |
| **9 gates validator** | Same | All gates from v5 mechanics applied | ⏳ |
| **Pass: final equity > initial** | Same | `assert final_equity > 1_000_000` | ⏳ |
| **Pass: no liquidation** | Same | `assert no_liquidation_events == True` | ⏳ |
| **Pass: cash flow invariant** | Same | `assert cash_flow_diff == 0` | ⏳ |

---

## RNG Reproducibility

| Registry Definition | Implementation | Parity Assertion | Status |
|---------------------|----------------|------------------|--------|
| **LCG algorithm** | `lib/rng.cjs` (TBD) | `state = (state * 1103515245 + 12345) & 0x7fffffff` | ⏳ |
| **Seed ranges (non-overlapping)** | Same | E1: 1000-1999, E2: 2000-2999, E3: 3000-3999, E4: 4000-4999, Forward: 5000-5999 | ⏳ |
| **No seed overlap** | Same | Each experiment uses disjoint seed ranges | ⏳ |
| **E1 only needs 1 seed** | Same | Complete enumeration of 64 patterns, not Monte Carlo sampling | ⏳ |

**Test Vector:**
```python
# Seed 1000, first 5 outputs:
rng = create_rng(1000)
# Record actual output values for regression testing
# (implementation-dependent, but must be reproducible)
```

---

## Forward Validation

| Registry Definition | Implementation | Parity Assertion | Status |
|---------------------|----------------|------------------|--------|
| **Embargo: 30+ paired dates** | `forward/embargo.cjs` (TBD) | `assert len(paired_dates) >= 30` | ⏳ |
| **Embargo: 30+ trades baseline** | Same | `assert sum(baseline_trades) >= 30` | ⏳ |
| **Embargo: 30+ trades challenger** | Same | `assert sum(challenger_trades) >= 30` | ⏳ |
| **Zero-trade dates retained** | Same | Dates with 0 trades NOT deleted from paired_dates | ⏳ |
| **Block structure: ≥6 blocks** | Same | `assert len(blocks) >= 6` (ensures min p_exact ≤ 1/64) | ⏳ |
| **Block size: 5 consecutive** | Same | Each block contains 5 consecutive dates (except last) | ⏳ |
| **Statistical test: one-sided** | Same | `p_exact = #{max_T >= t_obs} / 2^B` where B ≥ 6 | ⏳ |
| **Reject threshold: 0.05** | Same | `reject if p_exact <= 0.05` (no FWER, single comparison) | ⏳ |
| **Economic co-gate: 5 criteria** | `forward/economic-gate.cjs` (TBD) | All 5 criteria from Section 9.2 must pass | ⏳ |
| **Combined decision: AND** | Same | Statistical pass AND economic pass → production support | ⏳ |
| **Max wait: 90 trading days** | Same | `if days_elapsed > 90 and not_ready: return 'INCONCLUSIVE'` | ⏳ |

---

## Pre-Freeze Checklist

- [ ] Run `node backtest/purged-walkforward.cjs`, verify Gate 1 = 29 test runs
- [ ] Grep `simulateExit.*10`, verify Hold=10 in purged-walkforward.cjs L74
- [ ] Grep `* 2` in calculateCosts, verify double-sided slippage L284
- [ ] Verify observed policy thresholds: 1.1, 2.0, 0.3 in momentum-ema20-parameterized.cjs
- [ ] Implement HV20 calculator, run test vector (flat prices → HV≈0)
- [ ] Implement ER20 calculator, run test vector (trending prices → ER=1.0)
- [ ] Implement ATR5 calculator, verify against shared-backtest-lib.cjs reference
- [ ] Implement 64-pattern enumeration, verify NO 10k resampling loop
- [ ] Implement studentized T, test zero-variance cases (sd=0, mean=0 → T=0; sd=0, mean≠0 → T=±inf)
- [ ] Implement EMA20 5-point regression, test slope calculation
- [ ] Implement tie-break by symbol lexicographic order
- [ ] Run full E1 discovery on 29 runs, verify all assertions pass
- [ ] Generate SHA-256 hash of all locked files
- [ ] Record hash in registry header

---

**End of Parity Assertions v1.2**




