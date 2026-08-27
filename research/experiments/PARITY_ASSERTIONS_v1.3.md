# Registry v1.3 ↔ Source Code Parity Assertions

**Purpose:** Verify that every registry definition has exact corresponding source code implementation.

**Status:** Pre-freeze verification checklist (Round 10 submission)

**Round 9 Corrections Applied:** 14 items (P0: 8, P1: 6)

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
| **Exit: T+11 close (P0-1)** | `shared-backtest-lib.cjs` | L267 | `exitIdx = entryIdx + holdDays; exitPrice = close[exitIdx]` | ✅ |
| NOT T+11 open | Same | L267 | Code uses `close[exitIdx]`, NOT `open[exitIdx]` | ✅ |
| **Cost: double-sided slippage** | `shared-backtest-lib.cjs` | L281-285 | `slippage = entryPrice * 0.0002 * 2` | ⏳ |
| Formula exact | `shared-backtest-lib.cjs` | L281-285 | `((entry+exit)/2 * 0.0003 + entry * 0.0002 * 2) / entry` | ⏳ |
| **Test runs: 29 conditional OOS** | `purged-walkforward.cjs` | L273-305 | Gate 1 output: `Test: 29, Train: 35` | ⏳ |
| **Tie-break: symbol lexicographic** | TBD (experiments/) | TBD | Stable sort by symbol name when ATR14% equal | ⏳ |
| **61 signal vs 44 account (P0-2)** | `purged-walkforward.cjs` | Output | 61 trades = signal level, 44 trades = account level, -4.02% = account total return NOT trade mean | ✅ |
| **Calendar: non-trading retained (P0-13)** | TBD (experiments/) | TBD | Exchange holidays recorded as non-trading, zero-trade retained in paired dates | ✅ |

**Verification Commands:**
```bash
# Verify Hold=10, exit=close
grep -n "simulateExit.*10" backtest/purged-walkforward.cjs
grep -A 5 "function simulateExit" backtest/shared-backtest-lib.cjs | grep "close\[exitIdx\]"

# Verify double-sided slippage
grep -A 3 "function calculateCosts" backtest/shared-backtest-lib.cjs | grep "* 2"

# Verify 29 test runs
node backtest/purged-walkforward.cjs 2>&1 | grep "Gate 1"

# Verify observed policy thresholds
grep -n "hvThreshold\|atrThreshold\|emaSlopeThreshold" backtest/models/momentum-ema20-parameterized.cjs
```

---

## Feature Calculation Index Ranges

### HV20 Percentile (P0-3 Correction)

| Registry Definition | Implementation | Parity Assertion | Status |
|---------------------|----------------|------------------|--------|
| **110 prices → 90 rolling HV20** | `lib/features.cjs` (TBD) | `window110 = close[T-109:T+1]; assert len(window110) == 110` | ✅ |
| **Rolling window construction** | Same | `for i in range(90): prices = window110[i:i+21]` produces 90 windows | ✅ |
| Each window: 21 prices | Same | `assert len(prices) == 21` for all windows | ✅ |
| Each window: 20 log returns | Same | `returns = [log(prices[j]/prices[j-1]) for j in range(1,21)]` | ✅ |
| Current HV20 is last window | Same | Current = window110[-21:], not separate calculation | ✅ |
| NOT non-overlapping | Same | Delete "不与 current 重叠" assertion from v1.2 | ✅ |
| Variance: population | Same | `std_population(returns) = sqrt(sum((x-mean)^2) / n)`, NOT n-1 | ⏳ |
| Annualization factor | Same | `sqrt(252)` exactly | ⏳ |
| **Percentile ties (P0-5)** | Same | `sum(hv <= hv20_current for hv in hv90d) / 90 * 100` (use <=) | ✅ |
| Flat prices → 100 | Same | When all HV = 0, percentile = 100 (NOT 50) | ✅ |

**Test Vector:**
```python
# Synthetic flat prices: close = [100] * 110
# Expected: all log returns = 0, all HV20 = 0
# Percentile: sum(0 <= 0 for _ in range(90)) / 90 * 100 = 100
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

### ATR5 Percentile (P0-4 Correction)

| Registry Definition | Implementation | Parity Assertion | Status |
|---------------------|----------------|------------------|--------|
| **95 bars → 90 rolling ATR5%** | `lib/features.cjs` (TBD) | `high95 = high[T-94:T+1]; assert len(high95) == 95` | ✅ |
| **Endpoint loop** | Same | `for e in range(5, 95):` produces endpoints 5..94 (90 values) | ✅ |
| Each window: 5 bars | Same | `for i in range(e-4, e+1):` produces 5 TRs per window | ✅ |
| Each TR has valid prev | Same | Earliest TR at endpoint 5 uses bar 0 close as prev (always valid) | ✅ |
| ATR5% normalized by endpoint | Same | `atr5_pct = mean(trs) / close95[e] * 100` | ✅ |
| Current ATR5% is last window | Same | Current = bars 90..94 (endpoint 94), not separate calculation | ✅ |
| NOT non-overlapping | Same | Delete "不与 current 重叠" assertion from v1.2 | ✅ |
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
| **Studentized T (P0-8):** | Same | `t = mean(Δ) / (s / sqrt(29))` where `s² = sum((Δ-mean)²) / (n-1)` | ✅ |
| Sample variance (n-1) | Same | Denominator is `n-1 = 28`, NOT `n = 29` | ✅ |
| NOT population variance | Same | Code uses `n-1` divisor, not `n` divisor | ✅ |
| **Zero-variance: mean=0** | Same | `if s==0 and mean==0: return 0` | ⏳ |
| **Zero-variance: mean>0** | Same | `if s==0 and mean>0: return +inf` | ⏳ |
| **Zero-variance: mean<0** | Same | `if s==0 and mean<0: return -inf` | ⏳ |
| **Block structure: 6 blocks** | `null-generators/block-signflip.cjs` (TBD) | `blocks = [[0-4], [5-9], [10-14], [15-19], [20-24], [25-28]]` | ⏳ |
| 29 dates → 6 blocks | Same | 5 full blocks + 1 remainder block of 4 | ⏳ |
| **64-pattern enumeration** | Same | `for pattern in itertools.product([+1,-1], repeat=6):` all 64 | ⏳ |
| NOT 10k resampling | Same | Code does NOT contain `for seed in range(10000):` or Monte Carlo loop | ✅ |
| **Observed = all-plus** | Same | `(+1,+1,+1,+1,+1,+1)` is the observed assignment | ⏳ |
| **Common block signs** | Same | All candidates use SAME block_signs per pattern | ⏳ |
| **E1/E3 Max-T FWER (signed):** | Same | `null_max_T = [max(t_k for k in candidates) for pattern in 64]` | ⏳ |
| NOT absolute value | Same | Use signed `t_k`, not `abs(t_k)` for E1/E3 | ✅ |
| **E2 Max-|T| FWER (P0-6):** | Same | `null_max_absT = [max(abs(t_k) for k in variants) for pattern in 64]` | ✅ |
| Take abs first | Same | `abs(t_k)` computed before `max()`, NOT `abs(max(t_k))` | ✅ |
| **Adjusted p-value (P0-7):** | Same | `p_adj(k) = count(null_max >= observed) / 64` exactly | ✅ |
| NO mid-p correction | Same | Use exact count/64, not (count+0.5)/64 or (count+1)/65 | ✅ |
| NO quantile decision | Same | Quantile is informational only, NOT primary decision rule | ✅ |
| **One-sided rejection (E1, E3):** | Same | `reject if p_adj <= 0.05 and t_obs > 0` | ⏳ |
| **Two-sided rejection (E2):** | Same | `reject if p_adj <= 0.05` (no direction requirement) | ⏳ |

**Test Vector (P0-8 correction):**
```python
# Constant positive deltas: Δ = [+0.01] * 29
# After applying block sign pattern (+1,-1,+1,-1,+1,-1):
#   Δ_permuted = [+0.01]*5 + [-0.01]*5 + [+0.01]*5 + [-0.01]*5 + [+0.01]*5 + [-0.01]*4
# Expected: mean ≈ 0.00034, s > 0, T is finite (NOT ±∞)
# Zero-variance only occurs for truly constant values AFTER sign flip

# All deltas zero: Δ = [0.0] * 29
# Expected: mean = 0, s = 0, T = 0 (by convention)
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
| **Two-sided test** | Same | Use max-|T|, reject if `p_adj <= 0.05` (no direction requirement) | ⏳ |
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
| **Donchian (P1-9 frozen)** | Same | `priorHigh20 = max(high[T-20:T]); priorLow20 = min(low[T-20:T])` | ✅ |
| Donchian: exclude current T | Same | Breakout compares `close[T]` against prior 20 bars EXCLUDING T | ✅ |
| Donchian: no alternative | Same | Code does NOT include T in channel calculation | ✅ |
| **Control: always-long** | Same | `direction = 'long'` for all symbols in cohort | ⏳ |
| **Control: always-short** | Same | `direction = 'short'` for all symbols in cohort | ⏳ |
| **Control: random** | Same | `direction = 'long' if rng.next() > 0.5 else 'short'` with reproducible RNG | ⏳ |
| **Controls cannot win** | Same | Excluded from winner selection even if p_adj < 0.05 | ⏳ |
| **Net return formula (long)** | Same | `(exit - entry) / entry - costs` | ⏳ |
| **Net return formula (short)** | Same | `(entry - exit) / entry - costs` | ⏳ |
| **One-sided test** | Same | `reject if p_adj <= 0.05 and t_obs > 0` | ⏳ |
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
| **E4b: signal provider interface (P1-11)** | `runners/e4b-account-gate.cjs` (TBD) | Parameterized signal provider with unified input schema | ✅ |
| Unified input: foldsDetail | Same | Both baseline/challenger use same foldsDetail structure | ✅ |
| Unified input: testRunDateMetadata | Same | Both baseline/challenger use same calendar/dates | ✅ |
| Unified input: allOOSTrades | Same | Both baseline/challenger use same trade-level schema | ✅ |
| NO mixed paths | Same | Code does NOT read one from artifact, one from provider | ✅ |
| **Initial capital** | Same | 1,000,000 CNY normalized | ⏳ |
| **Nine gates (P1-12)** | Same | All 9 gates listed by name, not generic "margin/position/..." | ✅ |
| Gate 1: Calendar coverage | Same | All test dates valid trading dates | ✅ |
| Gate 2: Daily settle/carry | Same | Intraday position reconciliation | ✅ |
| Gate 3: Open-before-close cash chain | Same | No cash flow breaks | ✅ |
| Gate 4: Cost parity | Same | Actual costs match declared formula | ✅ |
| Gate 5: Equity identity | Same | Equity = cash + position value at each moment | ✅ |
| Gate 6: Risk-budget compliance | Same | No position exceeds risk limits | ✅ |
| Gate 7: Input classification | Same | All trades properly categorized | ✅ |
| Gate 8: Period match | Same | Entry/exit dates align with calendar | ✅ |
| Gate 9: Final identity | Same | Closing equity/cash-flow invariants hold | ✅ |
| **Pass: final equity > initial +5% (P1-10)** | Same | `assert final_equity > 1_000_000 * 1.05` | ✅ |
| **Pass: max DD <= 15% (P1-10)** | Same | `assert max_drawdown_pct <= 15.0` | ✅ |
| **Pass: no liquidation** | Same | `assert no_liquidation_events == True` | ⏳ |
| **Pass: cash flow invariant** | Same | `assert cash_flow_diff == 0` | ⏳ |
| **Forward: challenger equity +2% (P1-10)** | Same | `assert challenger_equity > baseline_equity * 1.02` | ✅ |
| **Forward: challenger DD +3% tolerance (P1-10)** | Same | `assert challenger_DD <= baseline_DD + 3.0` | ✅ |

---

## RNG Reproducibility

| Registry Definition | Implementation | Parity Assertion | Status |
|---------------------|----------------|------------------|--------|
| **LCG algorithm** | `lib/rng.cjs` (TBD) | `state = (state * 1103515245 + 12345) & 0x7fffffff` | ⏳ |
| **Seed ranges (non-overlapping)** | Same | E3 random-direction: 3000-3999, Forward: 5000-5999 | ⏳ |
| **No seed overlap** | Same | Each experiment uses disjoint seed ranges | ⏳ |
| **64-pattern needs NO RNG** | Same | Complete enumeration is deterministic, no seeds needed | ✅ |
| E1/E2/E4a use enumeration | Same | These experiments do NOT use RNG at all | ✅ |

**Test Vector:**
```python
# Seed 3000, first 5 outputs (for E3 random-direction control):
rng = create_rng(3000)
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
| **Zero-trade dates retained (P0-13)** | Same | Dates with 0 trades NOT deleted from paired_dates | ✅ |
| Non-trading dates recorded | Same | Exchange holidays recorded but not counted toward 30 minimum | ✅ |
| **Block structure: ≥6 blocks** | Same | `assert len(blocks) >= 6` (ensures min p_exact resolution) | ⏳ |
| **Block size: 5 consecutive** | Same | Each block contains 5 consecutive dates (except last) | ⏳ |
| **Statistical test: one-sided** | Same | `p_exact = #{max_T >= t_obs} / 2^B` where B ≥ 6 | ⏳ |
| **Reject threshold: 0.05** | Same | `reject if p_exact <= 0.05` (no FWER, single comparison) | ⏳ |
| **Economic co-gate: 7 criteria (P1-10)** | `forward/economic-gate.cjs` (TBD) | All 7 frozen criteria must pass | ✅ |
| Criterion 1: No liquidation | Same | No liquidation events occurred | ✅ |
| Criterion 2: Equity/cash identity | Same | All 9 gates pass | ✅ |
| Criterion 3: Final equity +5% | Same | Challenger equity > 1M * 1.05 | ✅ |
| Criterion 4: Max DD 15% absolute | Same | Challenger DD <= 15% | ✅ |
| Criterion 5: Equity improvement +2% | Same | Challenger > baseline * 1.02 | ✅ |
| Criterion 6: DD tolerance +3% | Same | Challenger DD <= baseline DD + 3% | ✅ |
| Criterion 7: Cash flow invariant | Same | cash_flow_diff == 0 | ✅ |
| **Combined decision: AND** | Same | Statistical pass AND economic pass → production support | ⏳ |
| **Max wait: 90 trading days** | Same | `if days_elapsed > 90 and not_ready: return 'INCONCLUSIVE'` | ⏳ |

---

## Pre-Freeze Checklist

- [ ] Run `node backtest/purged-walkforward.cjs`, verify Gate 1 = 29 test runs
- [ ] Grep `simulateExit.*10`, verify Hold=10 in purged-walkforward.cjs L74
- [ ] Grep `close\[exitIdx\]`, verify exit uses close NOT open in shared-backtest-lib.cjs L267
- [ ] Grep `* 2` in calculateCosts, verify double-sided slippage L284
- [ ] Verify observed policy thresholds: 1.1, 2.0, 0.3 in momentum-ema20-parameterized.cjs
- [ ] Implement HV20 calculator (110 prices → 90 windows), run flat prices test (expect 100)
- [ ] Implement ER20 calculator, run test vector (trending prices → ER=1.0)
- [ ] Implement ATR5 calculator (95 bars → 90 windows), verify against shared-backtest-lib.cjs
- [ ] Implement 64-pattern enumeration, verify NO 10k resampling loop
- [ ] Implement studentized T with sample variance (n-1), test zero-variance cases
- [ ] Implement EMA20 5-point regression, test slope calculation
- [ ] Implement Donchian with frozen definition (prior 20-bar, exclude T)
- [ ] Implement tie-break by symbol lexicographic order
- [ ] Verify 61 signal trades vs 44 account trades identity (separate statistical objects)
- [ ] Verify calendar coverage: non-trading dates recorded, zero-trade retained
- [ ] Implement signal provider unified adapter (foldsDetail/testRunDateMetadata/allOOSTrades)
- [ ] List 9 account gates by name (not generic "margin/position/...")
- [ ] Freeze all 7 thresholds (no TBD/X% remain): +5%, 15%, +2%, +3%, 30 dates, 30 trades, 90 days
- [ ] Run full E1 discovery on 29 runs, verify all assertions pass
- [ ] Generate SHA-256 hash of all locked files
- [ ] Record hash in registry header

---

**End of Parity Assertions v1.3**

