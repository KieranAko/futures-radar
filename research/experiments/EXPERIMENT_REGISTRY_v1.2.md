# Experimental Registry v1.2

**Status:** DRAFT (Round 9 submission)  
**Created:** 2026-08-06  
**Last Updated:** 2026-08-06  
**Owner:** 布偶猫 (@ragdoll-vzes)  
**Reviewer:** 缅因猫 (@cat-g7k98t5f)

---

## 0. Registry Scope & Purpose

### 0.1 Optimization Target
**P1 replay opportunity gate** — the 29-run conditional out-of-sample test runs from purged walk-forward validation (2024-12-05 to 2026-06-16).

**NOT production scanner** — production uses composite score ranking and full hard filter rules; P1 baseline uses ATR14% ranking and exact hard filter only.

### 0.2 Pre-Registration Rationale
- **Prevent p-hacking:** All hypotheses, null distributions, and failure conditions declared before discovery run
- **Prospective forward validation:** After discovery, freeze winning configuration and embargo ≥30 evaluation dates
- **Parity verification:** Registry definitions must match source code implementation exactly (see PARITY_ASSERTIONS.md)

### 0.3 Data Partitions
- **Development (44 runs, 2024-12-05 to 2026-06-16):** Already observed, used for discovery experiments
- **Forward validation (≥30 evaluation dates):** Prospectively collected after freeze, not yet observed

### 0.4 Discovery vs Forward
- **Discovery:** Test multiple candidates, control FWER, report all results, select winner
- **Forward:** Single pre-registered challenger vs baseline, confirmatory test, economic co-gate

---

## 1. P1 Baseline Definition

### 1.1 Complete 4-Stage Pipeline

**Stage 1: Scanner (Opportunity Ranking)**
- Ranker: ATR14% Top10
- Formula: `atrPct = (atr14 / currentPrice) * 100`
- Pre-ranking filter: `avgTurnover5d >= 1e8 AND avgOI5d >= 10000`
- Post-ranking filter: Exact hard filter (±9.5% limit lock only)

**Stage 2: Model Eligibility Gate**
- Uses **observed policy configuration** `1.1/2.0/0.3` for all experiments
- HV ratio gate: `HV5/HV20 >= 1.1`
- ATR gate: `ATR14% >= 2.0`
- Symbols failing either gate are excluded

**Stage 3: Direction Determination**
- EMA20 five-point linear regression slope
- Formula: OLS fit on last 5 EMA20 values, return %/day slope
- Long if `slope >= +0.3 %/day`
- Short if `slope <= -0.3 %/day`
- Neutral (skip) if `abs(slope) < 0.3`

**Stage 4: Execution**
- Entry: T+1 open
- Hold: T+10 (exit at T+11 open)
- Cost: `((entry+exit)/2 * 0.0003 + entry * 0.0002 * 2) / entry`

### 1.2 Observed Policy vs Fold-Specific Replay

**Observed policy (1.1/2.0/0.3):** Used for all E1-E4 experiments to ensure fair comparison

**Fold-specific replay:** Separate parity verification using each fold's `selectedConfig` from historical walk-forward. Only used to prove data/execution engine matches 61-trade historical result. NOT mixed with candidate experiments.

### 1.3 Pre-Ranking Eligible Universe U(T)

At signal date T, the eligible universe U(T) includes all symbols passing:
1. **Data availability:** OHLCV arrays contain date T and ≥110 historical bars
2. **Liquidity filters:**
   - `avgTurnover5d >= 1e8` (100 million CNY, 5-day mean)
   - `avgOI5d >= 10000` (10k contracts, 5-day mean)
3. **No data quality issues:** All prices finite and positive

**Turnover formula:** `mean(volume[-5:]) * mean(close[-5:]) * multiplier`

### 1.4 Feature-Valid Intersection F(T)

Subset of U(T) where all ranking features can be calculated:
- HV20 percentile: requires 110 bars (90-day rolling window + current 20-day)
- ER20: requires 21 bars (20 intervals)
- ATR5 percentile: requires 95 bars (90-day rolling window + current 5-bar)
- VEC: requires 110 bars (driven by HV20 component)

**Minimum requirement:** 110 bars of valid OHLC data

### 1.5 Post-Ranking Hard Filter

Applied after scanner ranking, before model eligibility:

**Exact hard filter (limit lock only):**
- Reject if `abs(change_T) >= 9.5%` (change at signal date T)
- Change formula: `(close[T] - close[T-1]) / close[T-1] * 100`

**NOT included in P1 baseline:**
- Amplitude check (3% change + 0.5% amplitude)
- Consecutive limit lock (3-day window)
- Days to delivery filter

These production rules are excluded from P1 baseline for simplicity.

### 1.6 Test Run Structure

**29 conditional OOS test runs** from purged walk-forward validation:
- Fold 1: runs 15-24 (10 runs)
- Fold 2: runs 25-34 (10 runs)
- Fold 3: runs 35-43 (9 runs)
- Date range: 2024-12-05 to 2026-06-16

**Each test run:**
1. Truncate OHLCV to signal date (inclusive)
2. Run 4-stage pipeline
3. Execute trades at T+1 open
4. Exit at T+11 open (Hold=10)
5. Calculate net return per symbol after costs

### 1.7 Baseline Historical Performance

**Observed policy (1.1/2.0/0.3) on 29 runs:**
- Result: TBD (to be calculated in discovery)
- This is the comparator for all E1-E4 experiments

**Fold-specific replay (parity verification only):**
- 61 completed trades across 29 runs
- Mean return: -4.02%
- Purpose: verify execution engine matches historical results
- NOT used as baseline for candidate experiments

---

## 2. Feature Calculation Specifications

### 2.1 ATR14 Percentage (Baseline Ranker)

**Formula:**
```python
# Step 1: Calculate True Range for last 14 bars
tr = []
for i in range(T-13, T+1):  # 14 bars: [T-13, ..., T]
    tr.append(max(
        high[i] - low[i],
        abs(high[i] - close[i-1]),
        abs(low[i] - close[i-1])
    ))

# Step 2: ATR14 = mean of 14 TR values
atr14 = mean(tr)

# Step 3: Percentilize
atr14_pct = (atr14 / close[T]) * 100
```

**Index assertions:**
- Requires 15 close prices (for 14 TR calculations using close[T-14])
- `len(tr) == 14`
- `tr[0]` uses `close[T-14]` and `close[T-13]`
- `tr[-1]` uses `close[T-1]` and `close[T]`

### 2.2 HV20 Percentile (E1.1 Candidate)

**Formula:**
```python
# Step 1: Calculate HV20 from last 20 log returns
returns = [log(close[i] / close[i-1]) for i in range(T-19, T+1)]
# returns uses close[T-20] through close[T], producing 20 log returns
hv20_annual = std_population(returns) * sqrt(252)

# Step 2: Calculate 90-day rolling HV20 for percentile
window110 = close[T-109 : T-19]  # 90 prices, non-overlapping with current HV20
hv90d = []
for i in range(90):  # range(90) produces 90 windows
    window_i = window110[i : i+21]  # 21 prices for 20 returns
    returns_i = [log(window_i[j] / window_i[j-1]) for j in range(1, 21)]
    hv_i = std_population(returns_i) * sqrt(252)
    hv90d.append(hv_i)

# Step 3: Percentile rank
percentile = sum(hv <= hv20_annual for hv in hv90d) / 90 * 100
```

**Index assertions:**
- Requires 110 close prices
- `len(returns) == 20`
- `returns[0] == log(close[T-19] / close[T-20])`
- `returns[-1] == log(close[T] / close[T-1])`
- `len(window110) == 90`
- `window110[-1] == close[T-20]` (no overlap with current HV20)
- `len(hv90d) == 90`

**Variance:** Population variance (divide by n, not n-1) to match shared-backtest-lib.cjs

**Ties:** Use `<=` comparison for percentile rank

### 2.3 ER20 (E1.2 Candidate)

**Formula:**
```python
net_change = abs(close[T] - close[T-20])
daily_changes = sum([abs(close[i] - close[i-1]) for i in range(T-19, T+1)])
er20 = net_change / daily_changes if daily_changes > 0 else 0
```

**Index assertions:**
- Requires 21 close prices
- Daily changes array has 20 elements
- First change: `abs(close[T-19] - close[T-20])`
- Last change: `abs(close[T] - close[T-1])`

### 2.4 ATR5 Percentile (E1.3 Candidate)

**Formula:**
```python
# Step 1: Calculate ATR5 from last 5 bars
tr = []
for i in range(T-4, T+1):  # 5 bars: [T-4, ..., T]
    tr.append(max(
        high[i] - low[i],
        abs(high[i] - close[i-1]),
        abs(low[i] - close[i-1])
    ))
atr5 = mean(tr)
atr5_pct = (atr5 / close[T]) * 100

# Step 2: Calculate 90-day rolling ATR5 for percentile
window95_high = high[T-94 : T-4]  # 90 bars
window95_low = low[T-94 : T-4]
window95_close = close[T-94 : T-4]

atr90d_pct = []
for e in range(5, 95):  # endpoints 5..94, produces 90 windows
    trs = []
    for i in range(e-4, e+1):  # 5 bars per window
        prev = window95_close[i-1]
        trs.append(max(
            window95_high[i] - window95_low[i],
            abs(window95_high[i] - prev),
            abs(window95_low[i] - prev)
        ))
    atr5_i_pct = mean(trs) / window95_close[e] * 100
    atr90d_pct.append(atr5_i_pct)

# Step 3: Percentile rank
percentile = sum(x <= atr5_pct for x in atr90d_pct) / 90 * 100
```

**Index assertions:**
- Requires 95 bars of OHLC
- `len(tr) == 5`
- `tr[0]` uses `close[T-5]` (prev for bar T-4)
- `tr[-1]` uses `close[T-1]` (prev for bar T)
- `len(window95_close) == 90`
- `window95_close[-1] == close[T-5]` (no overlap with current ATR5)
- `len(atr90d_pct) == 90`
- First window uses bars 1..5, prev=bar0
- Last window uses bars 90..94, prev=bar89

**Ties:** Use `<=` comparison for percentile rank

### 2.5 VEC (E1.4 Candidate)

**Formula:**
```python
hv_pctl = hvPercentile(close, window=20, lookback=90)  # from 2.2
er20 = efficiencyRatio(close, window=20)  # from 2.3
vec_score = hv_pctl * er20
```

**Minimum data:** 110 bars (driven by HV20 percentile requirement)

---

## 3. Experimental Design

### 3.1 Overall Structure: 4-Stage Policy Decomposition

All experiments use the same 29 conditional OOS test runs and observed policy configuration (1.1/2.0/0.3).

**E1: Scanner/Opportunity Ranking**
- Baseline: ATR14% Top10
- Candidates: HV20 percentile, ER20, ATR5 percentile, VEC
- Fixed: Exact hard filter, model eligibility (1.1/2.0/0.3), EMA direction, T+10 execution

**E2: Eligibility/Regime Gate (Component Ablation)**
- Baseline: `HV5/HV20 >= 1.1 AND ATR14% >= 2.0`
- Candidates: only-HV, only-ATR, no-eligibility
- Fixed: ATR14% scanner, exact hard filter, EMA direction, T+10 execution

**E3: Direction Determination**
- Baseline: EMA20 5-point regression slope (|slope| >= 0.3 %/day)
- Candidates: change5d sign, Donchian breakout
- Controls: always-long, always-short, random-direction (cannot win)
- Fixed: Same model-eligible symbol-date cohort for all direction rules

**E4: Execution Parameters**
- E4a: Hold period (H7 vs H10 vs H15, Bonferroni α=0.025 per comparison)
- E4b: Account-level validation gate (normalized-capital simulation)
- Note: Portfolio size N is not a single-variable experiment (N15 changes rank depth)

### 3.2 Statistical Framework

**Primary endpoint:** Date-level net return (mean across all completed trades on that date)

**Comparison method:** Paired contrasts
- E1: Δ[d] = R_candidate[d] - R_ATR14[d]
- E2: Δ[d] = R_variant[d] - R_baseline[d]
- E3: Δ[d] = R_direction[d] - R_EMA20[d]
- E4a: Δ[d] = R_H7[d] - R_H10[d] and Δ[d] = R_H15[d] - R_H10[d]

**Test statistic:** Studentized t-statistic
```python
t = mean(Δ) / (std(Δ) / sqrt(29))
```

**Zero-variance handling:**
- If `std(Δ) == 0` and `mean(Δ) == 0`: t = 0
- If `std(Δ) == 0` and `mean(Δ) > 0`: t = +∞
- If `std(Δ) == 0` and `mean(Δ) < 0`: t = -∞

### 3.3 Null Distribution: Block Sign-Flip with Complete Enumeration

**Block structure:**
- 29 dates partitioned into 6 consecutive blocks: [5, 5, 5, 5, 5, 4]
- All experiments share the same block boundaries

**Sign-flip mechanism:**
```python
# For each of 64 patterns (2^6 combinations):
block_signs = [±1, ±1, ±1, ±1, ±1, ±1]  # one sign per block

# Apply to paired deltas:
Δ_permuted = [Δ[i] * block_signs[block_idx(i)] for i in range(29)]

# Calculate t-statistic:
t_permuted = mean(Δ_permuted) / (std(Δ_permuted) / sqrt(29))
```

**Complete enumeration (not resampling):**
- Generate all 64 sign patterns: `(+1,+1,+1,+1,+1,+1)` through `(-1,-1,-1,-1,-1,-1)`
- Observed data corresponds to all-plus pattern `(+1,+1,+1,+1,+1,+1)`
- No Monte Carlo sampling, no mid-p correction, no `(b+1)/(m+1)` adjustment

**Null hypothesis assumption:**
- Block-wise paired deltas satisfy sign symmetry under null
- This is a discovery heuristic, not an unconditional guarantee
- Preserves within-block temporal correlation

### 3.4 FWER Control: Max-T Method

**Family-wise null distribution:**
```python
null_max_T = []
for pattern in all_64_patterns:
    t_values = []
    for candidate_k in all_candidates:
        Δ_k_permuted = apply_sign_flip(Δ_k, pattern)
        t_k = studentized_t(Δ_k_permuted)
        t_values.append(t_k)
    null_max_T.append(max(t_values))
```

**Adjusted p-value:**
```python
p_adj(k) = #{patterns: max_j(T_j) >= T_k_observed} / 64
```

**One-sided test (E1, E3):** Reject if `t_observed > quantile(null_max_T, 0.95)`

**Two-sided test (E2):** Reject if `abs(t_observed) > quantile(abs(null_max_T), 0.95)`

**Bonferroni (E4a):** Two comparisons (H7 vs H10, H15 vs H10), test each at α=0.025

### 3.5 Coverage Failure Conditions

**Definition:** Coverage failure occurs when the experimental design cannot produce valid statistical inference due to insufficient eligible samples.

**E1 Scanner Experiments:**
- Failure: >20% of test runs have zero feature-valid symbols in F(T)
- Reason: Cannot rank if feature calculation fails for entire universe

**E2 Eligibility Experiments:**
- Failure: >20% of test runs have zero symbols passing eligibility gate
- Reason: Cannot compare direction/execution if cohort is empty

**E3 Direction Experiments:**
- Failure: Fixed cohort has >20% dates where all candidates return neutral (no position)
- Reason: Neutral dates must be retained (set return=0) to keep cohort fixed, but if too many neutrals, comparison loses power
- Note: Candidates cannot "cherry-pick" by neutral-skipping difficult dates

**E4a Hold Period:**
- Failure: Any hold period variant has >20% dates with zero completed trades
- Reason: Cannot compare H7 vs H10 if one arm has mostly missing data

**Handling:**
- If any experiment layer fails coverage, document failure and do NOT proceed to that layer
- Downstream layers can still be tested if they don't depend on failed layer
- Forward validation cannot use failed components

---

## 4. E1: Scanner/Opportunity Ranking Experiments

### 4.1 Hypothesis

**Baseline:** ATR14% Top10 ranking provides opportunity discovery

**Candidates:**
- H1.1: HV20 percentile ranking improves date-level mean return vs baseline
- H1.2: ER20 ranking improves date-level mean return vs baseline
- H1.3: ATR5 percentile ranking improves date-level mean return vs baseline
- H1.4: VEC ranking improves date-level mean return vs baseline

**Null:** Each candidate has same expected date-level return as baseline

### 4.2 Execution Protocol

**For each test run d in [1..29]:**

1. **Baseline (ATR14% Top10):**
   - Calculate ATR14% for all symbols in F(d)
   - Rank descending by ATR14%, break ties by symbol lexicographic order
   - Select Top 10
   - Apply exact hard filter (±9.5% limit lock)
   - Apply model eligibility gate (HV5/HV20 >= 1.1, ATR14% >= 2.0)
   - Apply EMA20 direction (slope >= ±0.3 %/day, else neutral)
   - Execute trades at T+1 open, exit at T+11 open
   - Calculate date-level mean return: R_ATR14[d] = mean(net_returns after costs)

2. **Candidate k (e.g., HV20 percentile):**
   - Calculate feature_k for all symbols in F(d)
   - Rank descending by feature_k, break ties by symbol lexicographic order
   - Select Top 10
   - Apply **same** exact hard filter, eligibility, direction, execution as baseline
   - Calculate date-level mean return: R_k[d]

3. **Paired delta:**
   - Δ_k[d] = R_k[d] - R_ATR14[d]

**After all 29 runs:**
- Calculate observed t-statistic: t_k_obs = mean(Δ_k) / (std(Δ_k) / sqrt(29))
- Generate 64-pattern null distribution via block sign-flip
- Calculate FWER-adjusted p-value via Max-T

### 4.3 Decision Rule

**One-sided test (expect improvement):**
- Reject null if t_k_obs > quantile(null_max_T, 0.95)
- Winner: Candidate with smallest p_adj among those with t_obs > 0

**If multiple candidates pass:**
- Select candidate with largest observed t-statistic
- Report all p-values for transparency

**If no candidate passes:**
- Report "no scanner improvement detected"
- Can still proceed to E2-E4 using ATR14% baseline scanner

---

## 5. E2: Eligibility/Regime Gate Experiments

### 5.1 Hypothesis (Component Ablation)

**Baseline:** Combined eligibility gate `HV5/HV20 >= 1.1 AND ATR14% >= 2.0`

**Variants:**
- H2.1: Only-HV gate (remove ATR gate) changes date-level return vs baseline
- H2.2: Only-ATR gate (remove HV gate) changes date-level return vs baseline
- H2.3: No-eligibility gate (remove both) changes date-level return vs baseline

**Null:** Each variant has same expected date-level return as baseline

**Rationale:** Test whether each eligibility component contributes value, without searching for new thresholds on burned data

### 5.2 Execution Protocol

**For each test run d in [1..29]:**

1. **Baseline (combined gate):**
   - Start from ATR14% Top10 after exact hard filter
   - Apply `HV5/HV20 >= 1.1 AND ATR14% >= 2.0`
   - Apply EMA20 direction, execute T+10
   - R_baseline[d] = date-level mean return

2. **Variant (e.g., only-HV):**
   - Start from same ATR14% Top10 after exact hard filter
   - Apply `HV5/HV20 >= 1.1` (no ATR gate)
   - Apply same EMA20 direction, execute T+10
   - R_variant[d] = date-level mean return

3. **Paired delta:**
   - Δ[d] = R_variant[d] - R_baseline[d]

**After all 29 runs:**
- Calculate observed t-statistic
- Generate 64-pattern null distribution
- Calculate FWER-adjusted p-value via Max-T

### 5.3 Decision Rule

**Two-sided test (change in either direction):**
- Reject null if abs(t_obs) > quantile(abs(null_max_T), 0.95)

**Winner selection:**
- If only-HV passes: use only-HV gate
- If only-ATR passes: use only-ATR gate
- If no-eligibility passes: remove eligibility gate entirely
- If none pass: keep baseline combined gate

**Tie-breaking:** Select variant with largest abs(t_obs)

---

## 6. E3: Direction Determination Experiments

### 6.1 Hypothesis

**Baseline:** EMA20 5-point regression slope (|slope| >= 0.3 %/day)

**Candidates:**
- H3.1: change5d sign improves date-level return vs baseline
- H3.2: Donchian breakout improves date-level return vs baseline

**Controls (cannot win):**
- always-long: every eligible symbol goes long
- always-short: every eligible symbol goes short
- random-direction: 50/50 coin flip per symbol

**Null:** Each candidate has same expected date-level return as baseline

### 6.2 Fixed Cohort Constraint

**Critical requirement:** All direction rules operate on the **same model-eligible symbol-date cohort**

**Implementation:**
1. For date d, run ATR14% scanner → hard filter → eligibility gate
2. This produces a fixed set of eligible symbols S[d]
3. Apply baseline EMA20 direction to S[d], record returns (including neutral=0)
4. Apply candidate direction rule to same S[d], record returns
5. Candidate cannot skip/neutral to avoid difficult dates — neutral must be recorded as 0 return

**Why:** Prevents candidates from gaming comparison by selective neutrality

### 6.3 Direction Rule Specifications

**EMA20 5-point regression (baseline):**
```python
# Calculate EMA20 for last 25 days (to have 5 EMA points)
ema20_values = [calculate_ema20(close[:T-i]) for i in range(4, -1, -1)]

# OLS fit: y = a + b*x, where x = [0,1,2,3,4]
slope_raw = ols_slope(ema20_values)  # in price units per day
slope_pct = slope_raw / ema20_values[-1] * 100  # convert to %/day

# Direction decision
if slope_pct >= +0.3:
    direction = 'long'
elif slope_pct <= -0.3:
    direction = 'short'
else:
    direction = 'neutral'  # return = 0, date retained
```

**change5d sign (candidate):**
```python
change5d = (close[T] - close[T-5]) / close[T-5] * 100
if change5d > 0:
    direction = 'long'
elif change5d < 0:
    direction = 'short'
else:
    direction = 'neutral'
```

**Donchian breakout (candidate):**
```python
high20 = max(high[T-19:T+1])
low20 = min(low[T-19:T+1])
if close[T] >= high20:
    direction = 'long'
elif close[T] <= low20:
    direction = 'short'
else:
    direction = 'neutral'
```

### 6.4 Execution Protocol

**For each test run d in [1..29]:**

1. **Generate fixed cohort:**
   - Run ATR14% scanner → hard filter → eligibility gate
   - S[d] = set of eligible symbol-date pairs

2. **Baseline (EMA20):**
   - For each symbol in S[d], apply EMA20 direction rule
   - Execute trades (or record neutral=0)
   - R_EMA20[d] = mean return across S[d]

3. **Candidate (e.g., change5d):**
   - For same symbols in S[d], apply change5d direction rule
   - Execute trades (or record neutral=0)
   - R_candidate[d] = mean return across S[d]

4. **Paired delta:**
   - Δ[d] = R_candidate[d] - R_EMA20[d]

**After all 29 runs:**
- Calculate observed t-statistic
- Generate 64-pattern null distribution
- Calculate FWER-adjusted p-value via Max-T

### 6.5 Decision Rule

**One-sided test (expect improvement):**
- Reject null if t_obs > quantile(null_max_T, 0.95)

**Winner selection:**
- Candidate with smallest p_adj among those with t_obs > 0
- Controls (always-long, always-short, random) are excluded even if they pass

**If no candidate passes:**
- Keep baseline EMA20 direction
- Report "no direction improvement detected"

---

## 7. E4: Execution Parameter Experiments

### 7.1 E4a: Hold Period

**Baseline:** H10 (hold 10 days, exit at T+11 open)

**Variants:**
- H7: hold 7 days, exit at T+8 open
- H15: hold 15 days, exit at T+16 open

**Comparison:** Two paired contrasts
- Δ_H7[d] = R_H7[d] - R_H10[d]
- Δ_H15[d] = R_H15[d] - R_H10[d]

**Bonferroni correction:** Test each at α=0.025 (family α=0.05)

**Decision rule:**
- If H7 passes and H15 fails: use H7
- If H15 passes and H7 fails: use H15
- If both pass: select one with larger t_obs
- If neither pass: keep H10

### 7.2 E4b: Account-Level Validation Gate

**Purpose:** Verify that winning configuration passes economic viability checks, not just statistical significance

**Implementation:** Normalized-capital event-driven simulation using v5 mechanics

**Configuration:**
- Initial capital: 1,000,000 CNY (normalized)
- Risk budget: Same as historical backtest
- Capacity constraints: Same as historical backtest
- Calendar: Use actual signal dates from 29 runs
- Cost model: Same double-sided slippage formula

**Simulation flow:**
1. Parameterize signal provider with baseline/challenger policy
2. Run event-driven simulation across 29 dates
3. Apply 9 gates (margin, position limit, capacity, liquidity, etc.)
4. Track cash flow, equity curve, drawdown

**Pass criteria (all must be satisfied):**
- No liquidation events
- No identity failures (cash flow invariant holds)
- All 9 gates pass on all dates
- Final equity > initial capital (positive net economic value)
- Max drawdown acceptable (to be defined by risk tolerance)

**Failure action:**
- If baseline fails: report "baseline not economically viable on 29 runs"
- If challenger passes statistical test but fails E4b: do NOT freeze challenger
- Both statistical test AND E4b must pass to proceed to forward validation

**Note:** E4b is a discovery gate, not a paired comparison. It checks absolute viability, not relative improvement.

---

## 8. Winner Selection & Freeze Protocol

### 8.1 Component Assembly

After E1-E4 discovery:
1. Select winning scanner (or keep ATR14% if no improvement)
2. Select winning eligibility gate (or keep combined if no change)
3. Select winning direction rule (or keep EMA20 if no improvement)
4. Select winning hold period (or keep H10 if no change)

### 8.2 Complete Challenger Replay

**Before freeze:**
1. Assemble complete policy: [Scanner + Eligibility + Direction + Hold]
2. Run complete replay on all 29 test runs
3. Verify statistical improvement vs complete baseline
4. Run E4b account-level gate on complete challenger
5. If both pass: freeze configuration

**No second chances:** If assembled challenger fails, cannot swap components or retry. Report discovery results as-is.

### 8.3 Freeze Commit

**Actions:**
1. Lock all source code files (shared-backtest-lib.cjs, models/*.cjs, filter/rules.json, etc.)
2. Generate SHA-256 hash of each locked file
3. Record hashes in registry header
4. Tag git commit with `experimental-freeze-v1.2-YYYYMMDD`
5. Archive discovery results as read-only (discovery_results.json)

**Immutability:**
- No modifications to locked files during forward validation
- If bugs discovered, document in errata (do not silently fix)
- Forward validation must use exact frozen versions

### 8.4 Prospective Forward Embargo

**Minimum requirement:** At least 30 consecutive paired evaluation dates

**Paired evaluation date definition:**
- Signal date where both baseline and challenger run complete frozen pipeline
- OHLCV data available and mature (exit window complete)
- No exchange holidays disrupting execution
- Zero-trade dates retained (do not delete)

**Trade count requirement:**
- Baseline arm: cumulative completed trades ≥ 30
- Challenger arm: cumulative completed trades ≥ 30
- Both conditions must be satisfied

**Embargo period:**
- Start: Day after freeze commit
- End: When 30+ paired dates AND 30+ trades per arm accumulated
- Maximum wait: 90 trading days (if still insufficient, declare INCONCLUSIVE)

**Unseal trigger:** Automated check runs daily, unseals when conditions met

---

## 9. Forward Confirmatory Validation

### 9.1 Statistical Primary Endpoint

**Test:** Single paired comparison (challenger vs baseline)

**Data:** ≥30 paired evaluation dates collected during embargo

**Statistic:** Block sign-flip exact test
- Partition dates into consecutive 5-date blocks (at least 6 blocks)
- Enumerate all 2^B sign patterns (B ≥ 6, so ≥64 patterns)
- Calculate exact one-sided p-value

**Decision rule:**
- Reject null if p_exact ≤ 0.05
- No FWER adjustment (single pre-registered comparison)

### 9.2 Account-Level Economic Co-Gate

**Simulation setup:**
- Same normalized-capital event-driven mechanics as E4b
- Initial capital: 1,000,000 CNY
- Same risk budget, capacity, cost assumptions
- Run on forward validation dates only

**Pass criteria (all must be satisfied):**
1. Challenger total net return > baseline total net return
2. Challenger final equity > initial capital (positive economic value)
3. Challenger max drawdown not worse than baseline by >X% (pre-registered tolerance)
4. All 9 gates pass (no liquidation, identity failures)
5. Cash flow invariant holds (diff = 0)

**Path dependency:** Total P&L and max drawdown are path-dependent metrics, not suitable for paired t-test. These are absolute gates, not statistical tests.

### 9.3 Combined Decision Rule

**Forward validation passes if:**
- Statistical test passes (p_exact ≤ 0.05) AND
- Account economic co-gate passes (all 5 criteria satisfied)

**Possible outcomes:**
- Both pass → Support production deployment
- Statistical passes, economic fails → No production (not economically viable)
- Statistical fails, economic passes → No production (insufficient evidence)
- Both fail → No production
- Sample insufficient (<30 dates after 90-day wait) → INCONCLUSIVE

**No selective reporting:** Must report both statistical and economic outcomes regardless of results

---

## 10. Implementation Checklist

**Phase 0: Pre-Implementation (CURRENT)**
- [x] Round 9 registry submission
- [ ] 缅因猫 approval
- [ ] Freeze registry commit SHA

**Phase 1: Utility Functions**
- [ ] Universe builder U(T) with liquidity filters
- [ ] Feature-valid intersection F(T) calculator
- [ ] HV20 percentile (90-window exact implementation)
- [ ] ER20 calculator
- [ ] ATR5 percentile (90-window exact implementation)
- [ ] VEC composite score
- [ ] EMA20 5-point regression
- [ ] change5d, Donchian direction rules
- [ ] Unit tests for all features

**Phase 2: Statistical Functions**
- [ ] Studentized t-statistic with zero-variance handling
- [ ] Block sign-flip generator (64-pattern enumeration)
- [ ] Max-T FWER-adjusted p-value calculator
- [ ] Bonferroni adjustment for E4a
- [ ] Coverage failure detector

**Phase 3: E1 Scanner Experiments**
- [ ] ATR14% baseline ranker (standardized policy 1.1/2.0/0.3)
- [ ] HV20 percentile ranker
- [ ] ER20 ranker
- [ ] ATR5 percentile ranker
- [ ] VEC ranker
- [ ] E1 paired contrast pipeline
- [ ] E1 null distribution generator
- [ ] E1 results aggregator

**Phase 4: E2 Eligibility Experiments**
- [ ] Combined gate (baseline)
- [ ] Only-HV gate
- [ ] Only-ATR gate
- [ ] No-eligibility gate
- [ ] E2 paired contrast pipeline
- [ ] E2 null distribution generator
- [ ] E2 results aggregator

**Phase 5: E3 Direction Experiments**
- [ ] Fixed cohort generator
- [ ] EMA20 baseline direction
- [ ] change5d direction
- [ ] Donchian direction
- [ ] Control directions (always-long, always-short, random)
- [ ] E3 paired contrast pipeline
- [ ] E3 null distribution generator
- [ ] E3 results aggregator

**Phase 6: E4 Execution Experiments**
- [ ] H7 vs H10 paired contrast
- [ ] H15 vs H10 paired contrast
- [ ] E4a Bonferroni test
- [ ] E4b account-level gate (parameterized signal provider)
- [ ] Event-driven simulation integration
- [ ] 9-gate validator

**Phase 7: Winner Selection**
- [ ] Component assembly logic
- [ ] Complete challenger replay
- [ ] Final statistical verification
- [ ] Final E4b gate check
- [ ] Freeze protocol automation

**Phase 8: Forward Validation**
- [ ] Embargo timer (30+ dates, 30+ trades per arm)
- [ ] Daily unseal condition checker
- [ ] Forward statistical test
- [ ] Forward economic co-gate
- [ ] Combined decision logic
- [ ] Results reporter

---

## 11. Appendix A: Test Vectors

### A.1 Cost Calculation
```python
# Realistic T+10 futures move
entry = 568.2
exit = 571.8  # +0.63% move
expected_cost = ((568.2 + 571.8)/2 * 0.0003 + 568.2 * 0.0002 * 2) / 568.2
              = (570.0 * 0.0003 + 568.2 * 0.0004) / 568.2
              = (0.171 + 0.2273) / 568.2
              = 0.000701 (0.0701%)
```

### A.2 HV20 (Flat Prices)
```python
# Synthetic flat prices
close = [100] * 110
# Expected: all log returns = 0, HV20 = 0, percentile undefined (all zeros)
# Implementation: percentile = 50 (all values equal)
```

### A.3 ER20 (Trending Prices)
```python
# Perfect trend
close = [100, 101, 102, ..., 120]  # 21 prices
# Expected: net = 20, sum of daily changes = 20, ER20 = 1.0
```

### A.4 Zero-Variance T-Statistic
```python
# All deltas equal
Δ = [0.01] * 29
# Expected: mean = 0.01, std = 0, T = +∞

# All deltas zero
Δ = [0.0] * 29
# Expected: mean = 0, std = 0, T = 0 (by convention)
```

### A.5 ATR14 Tie-Breaking
```python
# Two symbols with identical ATR14%
symbol_A: atr14_pct = 3.45
symbol_B: atr14_pct = 3.45
# Tie-break: lexicographic order (A before B if "A" < "B")
```

---

## 12. Appendix B: RNG Reproducibility

### B.1 LCG Algorithm
```python
# Linear Congruential Generator (glibc parameters)
def lcg_next(state):
    return (state * 1103515245 + 12345) & 0x7fffffff

def create_rng(seed):
    state = seed
    def next_float():
        nonlocal state
        state = lcg_next(state)
        return state / 0x7fffffff
    return next_float
```

### B.2 Seed Ranges (Non-Overlapping)
- E1 paired contrasts: seeds 1000-1999 (only need 1 for enumeration, reserve 1000)
- E2 regime filter: seeds 2000-2999
- E3 direction filter: seeds 3000-3999
- E4 execution params: seeds 4000-4999
- Forward validation: seeds 5000-5999

---

**End of Experimental Registry v1.2**

