# Futures-Radar Experiment Registry v1.1

**Optimization Target:** P1 replay opportunity gate (backtest framework).  
**Production Scanner Migration:** Separate initiative, not covered by this registry.

**Registry Status:** DRAFT v1.1 (awaiting 缅因猫 Round 8 approval)  
**Commit Date:** TBD (locks prospective forward embargo start)  
**Principal Investigator:** 布偶猫  
**Discovery Data:** 29-run conditional OOS from purged-walkforward.cjs, BURNED for validation  
**Forward Embargo:** Starts from registry commit date, minimum 20 signal-date clusters + 30 completed trades

---

## P1 Baseline Definition (Exact Replay Identity)

**Source:** `shared-backtest-lib.cjs` + `purged-walkforward.cjs`

**Ranker:** ATR14 percentage (NOT percentile)
```javascript
// shared-backtest-lib.cjs L111-121
atr14 = calculateATR(truncHigh, truncLow, truncClose, 14);
atrPct = (atr14 / currentPrice) * 100;
// Sort descending, Top 10
```

**Pre-Ranking Filter:**
```javascript
// Liquidity only (shared-backtest-lib.cjs L108-109)
avgTurnover5d >= 1e8  // 100M CNY
avgOI5d >= 10000      // 10k contracts
```

**Post-Ranking Hard Filter:**
```javascript
// shared-backtest-lib.cjs L221-237
// Signal-date涨跌停 rejection only
change = abs((close[signalIdx] - close[signalIdx-1]) / close[signalIdx-1]);
if (change >= 0.095) reject;  // ±9.5%
// NO production rules: no 3%+amplitude, no consecutive locks
```

**Entry Timing:** T+1 open after signal date
```javascript
// shared-backtest-lib.cjs L245-261
entryIdx = signalIdx + 1;
entryPrice = open[entryIdx];
// Gap limit check: abs((open[T+1] - close[T]) / close[T]) >= 0.095 → reject
```

**Hold Period:** T+10 (NOT T+5)
```javascript
// purged-walkforward.cjs L74
exitIdx = entryIdx + 10;
exitPrice = close[exitIdx];
```

**Cost Model (Double-Sided Slippage):**
```javascript
// shared-backtest-lib.cjs L281-285
avgPrice = (entryPrice + exitPrice) / 2;
commission = avgPrice * 0.0003;
slippage = entryPrice * 0.0002 * 2;  // BOTH sides
costs = (commission + slippage) / entryPrice;
```

**Test Set:** 29 signal-date runs from 3-fold purged walk-forward
- Fold 1: runs 15-24 (10 test)
- Fold 2: runs 25-34 (10 test)
- Fold 3: runs 35-43 (9 test)
- Total: 29 conditional OOS runs (purged-walkforward.cjs Gate 1 output)

**Development Set Performance (BURNED, invalid for claims):**
- 29-run conditional OOS: **-4.02% net return** (normalized-capital portfolio)
- This data is BURNED — no validation claims permitted

---

## Common Feature-Valid Universe F(T)

**Motivation:** To ensure fair head-to-head comparison, all E1 rankers (including ATR14 baseline) must operate on the **same eligible universe** on each signal date.

**Definition:**
```python
def build_common_universe(raw, signalDate):
    """
    Common feature-valid universe for all E1 rankers.
    Ensures all features (ATR14, HV20, ER20, ATR5, VEC) can be calculated.
    """
    F = []
    for symbol in raw.contracts:
        signalIdx = raw.contracts[symbol].ohlcv.dates.index(signalDate)
        close = raw.contracts[symbol].ohlcv.close[0:signalIdx+1]
        high = raw.contracts[symbol].ohlcv.high[0:signalIdx+1]
        low = raw.contracts[symbol].ohlcv.low[0:signalIdx+1]
        volume = raw.contracts[symbol].ohlcv.volume[0:signalIdx+1]
        oi = raw.contracts[symbol].ohlcv.openInterest[0:signalIdx+1]
        
        # Liquidity thresholds (P1 exact)
        if len(close) < 5: continue
        avgTurnover5d = mean(volume[-5:]) * mean(close[-5:]) * multiplier
        avgOI5d = mean(oi[-5:]) if len(oi) >= 5 else 0
        if avgTurnover5d < 1e8: continue
        if avgOI5d < 10000: continue
        
        # All features calculable (110 bars for HV20 + 90-day percentile)
        if len(close) < 110: continue
        
        F.append(symbol)
    
    return F
```

**Index Assertions:**
```python
assert len(close) >= 110, "Need 110 bars for HV20 percentile"
assert len(volume) >= 5, "Need 5 bars for turnover"
assert len(oi) >= 5, "Need 5 bars for OI"
```

**Note:** This is a **standardized-universe discovery experiment**. We acknowledge this differs slightly from P1's original per-ranker universe (where ATR14 only needs 15 bars). A separate sensitivity test (ATR14-original vs ATR14-on-F) will quantify the universe-shift effect.

---

## E1: Opportunity Ranker Comparison

**Research Question:** Does alternative volatility measurement improve opportunity identification **versus ATR14 baseline**?

**Design:** Paired date-cluster comparison, each candidate vs ATR14 on same dates.

**Primary Contrasts (4 total):**
- HV20 percentile vs ATR14 percentage
- ER20 efficiency ratio vs ATR14 percentage  
- ATR5 percentile vs ATR14 percentage
- VEC composite vs ATR14 percentage

**Null Hypothesis H0 (per candidate):** Candidate provides no improvement over ATR14 baseline.

### E1.1: HV20 Percentile Ranker

**Policy:**
```python
def hv20_ranker(raw, signalDate):
    F = build_common_universe(raw, signalDate)
    candidates = []
    for symbol in F:
        close = raw.contracts[symbol].ohlcv.close[0:signalIdx+1]
        
        # HV20 calculation (20 log returns)
        n = len(close)
        returns = [log(close[i] / close[i-1]) for i in range(n-20, n)]
        hv20_annual = std(returns) * sqrt(252)
        
        # 90-day percentile (70 rolling HV20 values, INCLUDES current endpoint)
        window110 = close[-110:]  # 110 prices
        hv90d = []
        for i in range(len(window110) - 20):
            window_i = window110[i : i+21]
            returns_i = [log(window_i[j] / window_i[j-1]) for j in range(1, 21)]
            hv_i = std(returns_i) * sqrt(252)
            hv90d.append(hv_i)
        
        percentile = percentileofscore(hv90d, hv20_annual)
        candidates.append((symbol, percentile))
    
    candidates.sort(key=lambda x: (x[1], x[0]), reverse=True)  # Tie-break by symbol asc
    return [s for s, _ in candidates[:10]]
```

**Index Assertions:**
```python
assert len(returns) == 20, "HV20 uses exactly 20 log returns"
assert returns[0] == log(close[n-20] / close[n-21])
assert returns[-1] == log(close[n-1] / close[n-2])
assert len(window110) == 110, "Need 110 prices"
assert len(hv90d) == 91, "110 prices → 91 rolling HV20 values (including current)"
```

### E1.2: ER20 Efficiency Ratio Ranker

**Policy:**
```python
def er20_ranker(raw, signalDate):
    F = build_common_universe(raw, signalDate)
    candidates = []
    for symbol in F:
        close = raw.contracts[symbol].ohlcv.close[0:signalIdx+1]
        n = len(close)
        
        # ER20 = |net_change| / sum(|daily_changes|)
        net_change = abs(close[n-1] - close[n-21])
        daily_changes_sum = sum([abs(close[i] - close[i-1]) for i in range(n-20, n)])
        er20 = net_change / daily_changes_sum if daily_changes_sum > 0 else 0
        
        candidates.append((symbol, er20))
    
    candidates.sort(key=lambda x: (x[1], x[0]), reverse=True)
    return [s for s, _ in candidates[:10]]
```

**Index Assertions:**
```python
assert len(close) >= 21, "ER20 requires 21 prices for 20 intervals"
daily_changes_list = [abs(close[i] - close[i-1]) for i in range(n-20, n)]
assert len(daily_changes_list) == 20
```

### E1.3: ATR5 Percentile Ranker

**Policy:**
```python
def atr5_ranker(raw, signalDate):
    F = build_common_universe(raw, signalDate)
    candidates = []
    for symbol in F:
        ohlc = raw.contracts[symbol].ohlcv
        high = ohlc.high[0:signalIdx+1]
        low = ohlc.low[0:signalIdx+1]
        close = ohlc.close[0:signalIdx+1]
        n = len(close)
        
        # ATR5 calculation (5 true ranges)
        tr = []
        for i in range(n-5, n):
            tr.append(max(
                high[i] - low[i],
                abs(high[i] - close[i-1]) if i > 0 else 0,
                abs(low[i] - close[i-1]) if i > 0 else 0
            ))
        atr5 = mean(tr)
        atr5_pct = (atr5 / close[n-1]) * 100
        
        # 90-day percentile of ATR5% (INCLUDES current)
        # Need 95 bars: 5 for current ATR5 + 90 for percentile
        window95_high = high[-95:]
        window95_low = low[-95:]
        window95_close = close[-95:]
        
        atr90d_pct = []
        for i in range(len(window95_close) - 5):
            tr_i = []
            for j in range(i, i+5):
                tr_i.append(max(
                    window95_high[j] - window95_low[j],
                    abs(window95_high[j] - window95_close[j-1]) if j > 0 else 0,
                    abs(window95_low[j] - window95_close[j-1]) if j > 0 else 0
                ))
            atr_i = mean(tr_i)
            atr_i_pct = (atr_i / window95_close[i+4]) * 100
            atr90d_pct.append(atr_i_pct)
        
        percentile = percentileofscore(atr90d_pct, atr5_pct)
        candidates.append((symbol, percentile))
    
    candidates.sort(key=lambda x: (x[1], x[0]), reverse=True)
    return [s for s, _ in candidates[:10]]
```

**Index Assertions:**
```python
assert len(tr) == 5, "ATR5 uses 5 true ranges"
assert len(window95_close) == 95
assert len(atr90d_pct) == 91, "95 bars → 91 rolling ATR5% values (including current)"
```

### E1.4: VEC (HV20-pctl × ER20) Ranker

**Policy:** Composite of HV20 percentile and ER20
```python
vec_score = hv20_percentile * er20
```

---

## E1 Statistical Testing

### Paired Comparison Design

**For each signal date d ∈ {1..29}:**
1. Run ATR14 baseline → symbols_ATR14[d]
2. Run candidate ranker k → symbols_k[d]
3. Simulate all trades with exact P1 protocol (T+1 open, T+10 close, double-sided costs)
4. Calculate date-cluster equal-weight net return:
   ```python
   R_ATR14[d] = mean([netReturn(s) for s in symbols_ATR14[d]])
   R_k[d] = mean([netReturn(s) for s in symbols_k[d]])
   Δ_k[d] = R_k[d] - R_ATR14[d]
   ```

**Test Statistic (per candidate k):**
```python
t_k = mean(Δ_k) / (std(Δ_k) / sqrt(29))
```

**Null Distribution:** Block sign-flip on paired deltas
```python
def generate_e1_null(deltas_dict, nPerm=10000):
    # deltas_dict = {'hv20': Δ_hv20[1..29], 'er20': ..., 'atr5': ..., 'vec': ...}
    
    # Partition 29 dates into 5-date blocks (5 blocks + 4 remainder)
    blocks = [deltas_dict keys [i:i+5] for i in range(0, 29, 5)]
    # blocks = [[1-5], [6-10], [11-15], [16-20], [21-25], [26-29]]
    
    max_t_distribution = []
    for perm_seed in range(nPerm):
        # Generate common block sign-flips (same flips across all candidates)
        rng = create_rng(perm_seed)
        block_signs = [1 if rng() > 0.5 else -1 for _ in blocks]
        
        t_perm = {}
        for k in ['hv20', 'er20', 'atr5', 'vec']:
            # Apply block signs to deltas
            deltas_flipped = []
            for block_idx, block_dates in enumerate(blocks):
                sign = block_signs[block_idx]
                for date_idx in block_dates:
                    deltas_flipped.append(sign * deltas_dict[k][date_idx])
            
            mean_delta = mean(deltas_flipped)
            sd_delta = std(deltas_flipped)
            
            if sd_delta == 0:
                if mean_delta == 0:
                    t_perm[k] = 0
                else:
                    t_perm[k] = float('inf') if mean_delta > 0 else float('-inf')
            else:
                t_perm[k] = mean_delta / (sd_delta / sqrt(29))
        
        # One-sided: we expect improvement (t > 0)
        max_t_distribution.append(max(t_perm.values()))
    
    return max_t_distribution
```

**Rejection Rule (One-Sided, FWER α=0.05):**
```python
critical_value = quantile(max_t_distribution, 0.95)
for k in ['hv20', 'er20', 'atr5', 'vec']:
    reject_H0[k] = (t_k_observed > critical_value)
```

**FWER Guarantee:** P(any false rejection among 4 candidates) ≤ 0.05 under joint null.

**Limitation:** With 29 dates and 5-date blocks, only 2^6 = 64 unique sign-flip patterns exist. This is a **discovery heuristic**, not a general FWER guarantee. Report exact achievable α based on realized sign patterns.

### Coverage Failure Rule

**Definition:** Experiment fails if eligible universe F(T) < 10 symbols on >10% of test runs (>2.9 runs).

**Rationale:** Top-10 rankers require at least 10 candidates to be meaningful.

---

## E2: Regime Filter Policy

**Research Question:** Does volatility regime filtering improve returns versus no-filter?

**Design:** Two paired comparisons (high-HV vs none, low-HV vs none), policy-level contrasts.

**Pre-Filter:** All E2 experiments start from **ATR14 Top-10 baseline pool** (not re-ranked).

### E2.1: High-HV Regime Filter

**Policy A (baseline):** ATR14 Top-10, no regime filter  
**Policy B (treatment):** ATR14 Top-10, keep only high-HV symbols (HV20 percentile ≥ 50)

**Paired Comparison:**
```python
for date_d in test_runs:
    symbols_A = atr14_ranker(raw, date_d)  # Top 10
    symbols_B = [s for s in symbols_A if hv20_percentile(s) >= 50]
    
    R_A[d] = mean([simulate_trade(s, raw, date_d) for s in symbols_A]) if len(symbols_A) > 0 else 0
    R_B[d] = mean([simulate_trade(s, raw, date_d) for s in symbols_B]) if len(symbols_B) > 0 else 0
    Δ_high[d] = R_B[d] - R_A[d]

t_high = mean(Δ_high) / (std(Δ_high) / sqrt(29))
```

**Null Hypothesis H0:** High-HV filter provides no improvement over no-filter.

**Test:** Two-sided paired t-test (regime could help or hurt)

**Null Distribution:** Block sign-flip on Δ_high (same method as E1)

**Coverage Failure:** Fails if high-HV filter returns 0 symbols on >20% of test runs (>5.8 runs).

### E2.2: Low-HV Regime Filter

**Policy B (treatment):** ATR14 Top-10, keep only low-HV symbols (HV20 percentile < 50)

**Null Hypothesis H0:** Low-HV filter provides no improvement.

**Test:** Two-sided paired t-test

**Coverage Failure:** Fails if low-HV filter returns 0 symbols on >20% of test runs.

### E2 FWER Control

**Method:** Max-|T| with joint block sign-flip across both contrasts

```python
def generate_e2_null(delta_high, delta_low, nPerm=10000):
    max_abs_t = []
    for perm_seed in range(nPerm):
        # Common block sign-flips for both contrasts
        block_signs = generate_block_signs(perm_seed, n_blocks=6)
        
        delta_high_flipped = apply_block_signs(delta_high, block_signs)
        delta_low_flipped = apply_block_signs(delta_low, block_signs)
        
        t_high = mean(delta_high_flipped) / (std(delta_high_flipped) / sqrt(29))
        t_low = mean(delta_low_flipped) / (std(delta_low_flipped) / sqrt(29))
        
        max_abs_t.append(max(abs(t_high), abs(t_low)))
    
    return max_abs_t
```

**Rejection Rule (Two-sided, FWER α=0.05):**
```python
critical_value = quantile(max_abs_t_distribution, 0.95)
reject_high = (abs(t_high_obs) > critical_value)
reject_low = (abs(t_low_obs) > critical_value)
```

---

## E3: Direction Policy

**Research Question:** Does directional filter improve returns versus always-long?

**Design:** Fixed symbol-date cohort, test different direction assignment rules.

**Critical Clarification:** E3 tests **direction assignment policies**, not symbol selection filters.

### E3.1: EMA20 Slope Direction

**Policy A (baseline):** Always-long (sign = +1 for all symbols)  
**Policy B (treatment):** EMA20 slope direction
```python
ema20 = mean(close[-20:])
ema20_prev = mean(close[-21:-1])
slope = (ema20 - ema20_prev) / ema20_prev

if slope > 0.003:  # Bullish threshold (0.3%)
    direction = 'long'
elif slope < -0.003:  # Bearish threshold
    direction = 'short'
else:
    direction = 'neutral'  # Skip trade

# Net return calculation
if direction == 'long':
    net_return = (exit_price - entry_price) / entry_price - costs
elif direction == 'short':
    net_return = (entry_price - exit_price) / entry_price - costs
else:
    net_return = 0  # No trade
```

**Paired Comparison:**
```python
for date_d in test_runs:
    symbols = atr14_ranker(raw, date_d)  # Fixed cohort
    
    R_A[d] = mean([long_trade(s, raw, date_d) for s in symbols])
    R_B[d] = mean([ema_direction_trade(s, raw, date_d) for s in symbols])
    Δ_ema[d] = R_B[d] - R_A[d]

t_ema = mean(Δ_ema) / (std(Δ_ema) / sqrt(29))
```

**Null Hypothesis H0:** EMA direction provides no improvement over always-long.

**Test:** One-sided (expected positive, since direction should add value)

**Coverage Failure:** Fails if EMA direction returns 0 trades (all neutral) on >20% of test runs.

### E3.2: Pure Direction Null (Negative Control)

**Policy C:** Random direction (50% long, 50% short, fixed seed per date)

**Purpose:** Verify that random direction does NOT produce positive returns (would indicate straddle-like profit, which is wrong).

**Expected Result:** Random direction ≈ 0 net return (after costs eat directional noise).

### E3 FWER Control

**Method:** Max-T with block sign-flip on Δ_ema only (single primary contrast)

---

## E4: Execution Parameters

**Research Question:** Do hold period and portfolio size affect returns?

**Design:** Single-variable changes from frozen baseline.

**Frozen Baseline (from E1-E3 winner selection):**
- Ranker: Winner from E1 (or ATR14 if no winner)
- Regime: Winner from E2 (or no-filter if no winner)
- Direction: Winner from E3 (or always-long if no winner)
- Entry: T+1 open
- Hold: **T+10** (P1 baseline)
- Portfolio: Top 10
- Costs: Double-sided slippage

### E4.1: Hold Period Variants

**Policies:**
- H7: 7 trading days
- H10: 10 trading days (baseline)
- H15: 15 trading days

**Paired Comparisons:**
```python
Δ_H7 = R_H7 - R_H10
Δ_H15 = R_H15 - R_H10

t_H7 = mean(Δ_H7) / (std(Δ_H7) / sqrt(29))
t_H15 = mean(Δ_H15) / (std(Δ_H15) / sqrt(29))
```

**Null Hypothesis H0:** No hold period provides superior returns to H10.

**Test:** Two-sided paired t-tests with Bonferroni correction (α = 0.025 each)

### E4.2: Portfolio Size Variants

**Policies:**
- N5: Top 5 symbols (ranker outputs Top 10, take first 5)
- N10: Top 10 symbols (baseline)
- N15: Top 15 symbols (ranker must output Top 15, requires E1 winner to support N=15)

**Paired Comparisons:**
```python
Δ_N5 = R_N5 - R_N10
Δ_N15 = R_N15 - R_N10
```

**Null Hypothesis H0:** No portfolio size provides superior returns to N10.

**Test:** Two-sided paired t-tests with Bonferroni correction (α = 0.025 each)

**Coverage Failure (N15 only):** Fails if ranker cannot produce 15 symbols on >20% of test runs.

**Critical Note:** E4 uses **date-cluster paired comparisons**, not account-level portfolio simulation. This limits interpretation to "average per-date effect" rather than "realized portfolio P&L". For account-level conclusions, must integrate with `account-simulator.cjs` v5 normalized-capital framework (out of scope for this registry).

---

## Forward Validation Protocol

**Embargo Trigger:** Minimum **20 signal-date clusters** + **30 completed trades** (not calendar days).

**Validation Procedure:**
1. **Freeze Single Challenger Policy** from discovery phase:
   - Best ranker from E1 (if any rejected H0)
   - Best regime filter from E2 (if any rejected H0)
   - Best direction policy from E3 (if any rejected H0)
   - Best execution params from E4 (if any rejected H0)
   - If no winners: challenger = exact P1 baseline (ATR14, no-filter, always-long, T+10, Top10)

2. **Lock Registry Commit:**
   - Commit registry + all experimental code
   - Record SHA-256 hash
   - Start embargo clock

3. **Wait for Embargo Conditions:**
   - Collect forward data until: ≥20 signal-date clusters AND ≥30 completed trades
   - Maximum wait: 90 calendar days (if insufficient data, report "inconclusive")

4. **Execute Confirmatory Test (One-Shot):**
   - Run frozen challenger vs frozen baseline on forward cohort
   - Generate null distribution using same block sign-flip algorithm + frozen RNG seeds
   - Calculate t-statistic and p-value
   - Report result honestly (no cherry-picking)

5. **Validation Claims:**
   - Only challenger that rejects H0 in forward validation may claim improvement
   - Development set (29-run conditional OOS) must NOT appear in validation claims, charts, or materials
   - If forward validation fails to reject H0: report "no evidence of improvement in forward period"

**Critical Constraint:** Forward cohort is used **once only** for **one frozen challenger**. No iterative selection, no re-optimization, no "let's try another candidate". Forward validation is confirmatory, not exploratory.

---

## Deterministic Details

### Tie-Breaking
- All rankers: Sort by `(score DESC, symbol ASC)`
- Ensures reproducibility when multiple symbols have identical scores

### NaN/Infinity Handling
- Feature calculation returns NaN → exclude symbol from that ranker's universe
- Division by zero in ER20 → ER20 = 0 (defined explicitly in policy)
- Zero-variance studentized-T: defined in E1 null generation code

### Missing Data
- Insufficient OHLC history → exclude from F(T)
- Failed entry (gap limit lock) → record as failed attempt, do NOT backfill
- Failed exit (data ends before T+10) → record as failed attempt, do NOT backfill
- Coverage denominator includes ALL frozen test dates (even zero-trade dates)

### RNG Algorithm
```python
def create_rng(seed):
    """Linear congruential generator (LCG) for reproducible permutations"""
    state = seed
    def next():
        nonlocal state
        state = (state * 1103515245 + 12345) & 0x7fffffff
        return state / 0x7fffffff
    return next
```

**Seed List (pre-registered):**
- E1 null generation: seeds 1000-10999 (10k permutations)
- E2 null generation: seeds 2000-11999
- E3 null generation: seeds 3000-12999
- Forward validation: seeds 5000-14999

### Per-Date Accounting
```python
for date_d in test_runs:
    target_count[d] = 10  # Top 10 target
    attempt_count[d] = len(ranker_output[d])
    success_count[d] = len([s for s in ranker_output[d] if entry_succeeded(s) and exit_succeeded(s)])
    failed_entry[d] = [s for s in ranker_output[d] if not entry_succeeded(s)]
    failed_exit[d] = [s for s in ranker_output[d] if entry_succeeded(s) but not exit_succeeded(s)]
```

**Output:** Per-date trade log with target/attempt/success counts.

---

## Implementation Manifest

**Required Source Files (Pre-Freeze):**

1. `shared-backtest-lib.cjs`
   - Lines 31-44: `calculateATR(high, low, close, period=14)`
   - Lines 111-143: `runScanner(raw, signalDate)` → ATR14% Top10
   - Lines 221-237: `runHardFilter(candidates, raw, signalDate)` → ±9.5% check only
   - Lines 245-261: `simulateEntry(symbol, raw, signalDate)` → T+1 open
   - Lines 267-274: `simulateExit(symbol, raw, entryIdx, holdDays=10)` → T+10 close
   - Lines 281-285: `calculateCosts(entryPrice, exitPrice)` → double-sided slippage

2. `purged-walkforward.cjs`
   - Lines 40-44: FOLDS definition (3-fold, indices 15-43)
   - Line 74: `executeTrade(..., 10)` → Hold=10 confirmation
   - Lines 273-305: Gate 1 output → 29 test runs

3. `config/symbols.json` → multiplier for turnover calculation

**Pre-Freeze Verification:**
- [ ] Run purged-walkforward.cjs, verify Gate 1 output = 29 test runs
- [ ] Verify calculateCosts test vector: entry=100, exit=105 → 0.000007075 (not 0.00066)
- [ ] Verify all index assertions pass for HV20/ER20/ATR5/VEC calculators

---

## Success Criteria

**P0 (Registry Approval):**
- [ ] 缅因猫 approves v1.1 experimental design (Round 8)
- [ ] All P1-1/P1-3/P1-4/P1-7 corrections verified
- [ ] Baseline matches P1 exact replay identity (Hold=10, double-sided slippage, 29 runs)
- [ ] E1 tests candidate-vs-ATR14 paired contrasts (not vs random)
- [ ] Block sign-flip null mathematically valid (not degenerate)
- [ ] Forward protocol freezes single challenger (not iterative selection)

**P1 (Implementation):**
- [ ] All utility functions pass unit tests
- [ ] Discovery run executes on 29-run conditional OOS data
- [ ] Coverage failure rates documented
- [ ] Parity assertions table: registry definition ↔ source function ↔ line range

**P2 (Forward Validation):**
- [ ] Embargo conditions met (≥20 clusters + ≥30 trades)
- [ ] Confirmatory test executes with frozen code + frozen seeds
- [ ] Results reported honestly (no p-hacking)

---

**End of Registry v1.1 DRAFT**
