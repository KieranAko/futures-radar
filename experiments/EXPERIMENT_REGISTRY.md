# Futures-Radar Experiment Registry v1.0

**Optimization Target:** P1 replay opportunity gate (backtest framework).  
**Production Scanner Migration:** Separate initiative, not covered by this registry.

**Registry Status:** DRAFT (awaiting 缅因猫 approval)  
**Commit Date:** TBD (locks prospective forward embargo start)  
**Principal Investigator:** 布偶猫  
**Discovery Data:** 44-run purged walk-forward (2024-12-05 → 2026-06-16), BURNED for validation  
**Forward Embargo:** Starts from registry commit date, minimum 30 trading days

---

## Baseline Definition

**Current P1 Baseline (Development Set):**
- **Ranker:** ATR14 percentile (`atr14 / currentPrice * 100`)
- **Selection:** Top 10 by descending ATR%
- **Entry:** T+1 open after signal date
- **Hold:** 5 trading days
- **Cost Model:** `calculateCosts(entryPrice, exitPrice)` from `shared-backtest-lib.cjs`
  - Formula: `((entryPrice + exitPrice)/2 * 0.0003 + entryPrice * 0.0002) / entryPrice`
  - Returns: fraction of entry price
- **Pre-Ranking Universe:** Contracts passing liquidity + hard filter on signal date
  - `avgTurnover5d >= 1e8` (100M CNY)
  - `avgOI5d >= 10000` (10k contracts)
  - Not at涨跌停封板 (limit lock)
  - No consecutive limit locks in past 3 days

**Development Set Performance (Discovery Phase, INVALID for claims):**
- 44-run conditional OOS: **Negative returns**
- This data is BURNED — no validation claims permitted

---

## Pre-Ranking Eligible Universe

**Definition:** On each signal date T, the pre-ranking eligible universe U(T) consists of all contracts satisfying:

1. **Liquidity Thresholds** (from `filter/rules.json`):
   ```
   avgTurnover5d(T) >= 1e8 CNY
   avgOI5d(T) >= 10000 contracts
   ```
   where:
   ```
   avgTurnover5d(T) = mean(volume[T-4:T]) * mean(close[T-4:T]) * multiplier
   avgOI5d(T) = mean(openInterest[T-4:T])
   ```

2. **涨跌停 Filter** (from `filter/rules.json`):
   ```
   |change(T)| < 3% OR amplitude(T) > 0.5%
   ```
   where:
   ```
   change(T) = (close[T] - close[T-1]) / close[T-1] * 100
   amplitude(T) = (high[T] - low[T]) / close[T-1] * 100
   ```

3. **No Consecutive Limit Locks:**
   ```
   ¬∃(i, j) ∈ [T-2, T] × [T-2, T]: i < j AND isLimitLock(i) AND isLimitLock(j)
   ```

4. **Sufficient OHLC History:**
   ```
   dates[0:signalIdx+1].length >= 95
   ```
   Justification: ATR14 requires 15 bars, 90-day percentile requires 90 bars, 5-bar margin for robustness.

**Feature-Valid Intersection F(T):** Subset of U(T) with sufficient history for all experimental features:
```
F(T) = { s ∈ U(T) : length(close_s[0:signalIdx+1]) >= 110 }
```
Justification: HV20 window + 90-day percentile = 20 + 90 = 110 bars minimum.

---

## E1: Opportunity Ranker Comparison

**Research Question:** Does volatility measurement method affect opportunity identification?

**Hypothesis:** Short-term directional HV (HV20) or efficiency ratio (ER20) outperforms ATR14% ranking in capturing profitable volatility.

### E1.1: HV20 Percentile Ranker

**Policy:**
```python
def hv20_ranker(raw, signalDate):
    U = pre_ranking_eligible_universe(raw, signalDate)
    candidates = []
    for symbol in U:
        close = raw.contracts[symbol].ohlcv.close[0:signalIdx+1]
        if len(close) < 110:
            continue  # Insufficient history
        
        # HV20 calculation
        returns = [log(close[i] / close[i-1]) for i in range(len(close)-19, len(close)+1)]
        hv20_annual = std(returns) * sqrt(252)
        
        # 90-day percentile
        window90 = close[-110:-20]  # 90 prices for percentile, exclude HV20 window
        hv90d = [calculate_hv20(window90[i:i+21]) for i in range(len(window90)-20)]
        percentile = percentileofscore(hv90d, hv20_annual)
        
        candidates.append((symbol, percentile))
    
    candidates.sort(key=lambda x: x[1], reverse=True)
    return [s for s, _ in candidates[:10]]
```

**Index Assertions:**
```python
assert len(returns) == 20, "HV20 uses exactly 20 log returns"
assert returns[0] == log(close[-20] / close[-21])
assert returns[-1] == log(close[-1] / close[-2])
assert len(window90) == 90, "Percentile window spans 90 days"
assert window90[-1] == close[-21], "No overlap with HV20 window"
```

**Null Hypothesis H0:** HV20 percentile ranking performs no better than random Top-10 selection from F(T).

**Null Distribution:**
```python
def random_null_hv20(raw, signalDate, nReps=10000):
    F = feature_valid_intersection(raw, signalDate)
    if len(F) < 10:
        return None  # Insufficient universe
    
    null_returns = []
    for _ in range(nReps):
        selected = random.sample(F, 10)  # Sample without replacement
        returns_per_symbol = [simulate_trade(s, raw, signalDate) for s in selected]
        date_cluster_return = mean(returns_per_symbol)
        null_returns.append(date_cluster_return)
    
    return null_returns
```

**Test Statistic:** Date-cluster equal-weight mean return, aggregated across 44 test runs:
```python
T_hv20 = mean([run_i_return for i in range(44)])
```

**Rejection Rule:** One-sided test at α=0.05 (FWER-corrected):
```python
reject_H0 if T_hv20 > quantile(null_distribution, 0.95)
```

**Expected Direction:** Positive improvement (HV20 > random).

**Coverage Rule:** Experiment fails if `len(F(T)) < 10` on >10% of test runs (insufficient universe).

---

### E1.2: ER20 (Efficiency Ratio) Ranker

**Policy:**
```python
def er20_ranker(raw, signalDate):
    U = pre_ranking_eligible_universe(raw, signalDate)
    candidates = []
    for symbol in U:
        close = raw.contracts[symbol].ohlcv.close[0:signalIdx+1]
        if len(close) < 21:
            continue
        
        # ER20 = |net_change| / sum(|daily_changes|)
        net_change = abs(close[-1] - close[-21])
        daily_changes = sum([abs(close[i] - close[i-1]) for i in range(len(close)-20, len(close)+1)])
        er20 = net_change / daily_changes if daily_changes > 0 else 0
        
        candidates.append((symbol, er20))
    
    candidates.sort(key=lambda x: x[1], reverse=True)
    return [s for s, _ in candidates[:10]]
```

**Index Assertions:**
```python
assert len(close[-21:]) == 21, "ER20 uses 21 prices (20 intervals)"
assert len(daily_changes_list) == 20, "20 daily changes"
```

**Null Hypothesis H0:** ER20 ranking performs no better than random Top-10 selection from U(T).

**Null Distribution:** Random sampling from U(T) (not F(T), since ER20 requires only 21 bars).

**Test Statistic:** Mean return across 44 test runs.

**Rejection Rule:** One-sided at α=0.05.

**Coverage Rule:** Fails if `len(U(T)) < 10` on >10% of test runs.

---

### E1.3: ATR5 Percentile Ranker

**Policy:**
```python
def atr5_pct_ranker(raw, signalDate):
    U = pre_ranking_eligible_universe(raw, signalDate)
    candidates = []
    for symbol in U:
        ohlc = raw.contracts[symbol].ohlcv
        high = ohlc.high[0:signalIdx+1]
        low = ohlc.low[0:signalIdx+1]
        close = ohlc.close[0:signalIdx+1]
        
        if len(close) < 95:
            continue  # ATR5 + 90-day percentile
        
        # ATR5 calculation
        tr = [max(high[i] - low[i], 
                  abs(high[i] - close[i-1]), 
                  abs(low[i] - close[i-1])) 
              for i in range(len(close)-4, len(close)+1)]
        atr5 = mean(tr)
        atr5_pct = (atr5 / close[-1]) * 100
        
        # 90-day percentile
        window90_ohlc = {
            'high': high[-95:-5],
            'low': low[-95:-5],
            'close': close[-95:-5]
        }
        atr90d = [calculate_atr5(window90_ohlc, i) for i in range(len(window90_ohlc['close'])-5+1)]
        percentile = percentileofscore(atr90d, atr5)
        
        candidates.append((symbol, percentile))
    
    candidates.sort(key=lambda x: x[1], reverse=True)
    return [s for s, _ in candidates[:10]]
```

**Index Assertions:**
```python
assert len(tr) == 5, "ATR5 uses 5 true ranges"
assert tr[0] corresponds to close[T-4:T-3] transition
assert len(window90_ohlc['close']) == 90
assert window90_ohlc['close'][-1] == close[T-5]
```

**Null Hypothesis H0:** ATR5 percentile ranking performs no better than random Top-10 from U(T) intersect {length >= 95}.

**Test Statistic:** Mean return across 44 test runs.

**Rejection Rule:** One-sided at α=0.05.

**Coverage Rule:** Fails if eligible universe < 10 on >10% of runs.

---

### E1.4: VEC (Volatility-Efficiency Composite) Ranker

**Policy:**
```python
def vec_ranker(raw, signalDate):
    U = pre_ranking_eligible_universe(raw, signalDate)
    candidates = []
    for symbol in U:
        close = raw.contracts[symbol].ohlcv.close[0:signalIdx+1]
        if len(close) < 110:
            continue
        
        # HV20
        returns_hv = [log(close[i] / close[i-1]) for i in range(len(close)-19, len(close)+1)]
        hv20 = std(returns_hv) * sqrt(252)
        
        # HV20 percentile
        window90 = close[-110:-20]
        hv90d = [calculate_hv20(window90[i:i+21]) for i in range(len(window90)-20)]
        hv_pctl = percentileofscore(hv90d, hv20)
        
        # ER20
        net_change = abs(close[-1] - close[-21])
        daily_changes = sum([abs(close[i] - close[i-1]) for i in range(len(close)-20, len(close)+1)])
        er20 = net_change / daily_changes if daily_changes > 0 else 0
        
        # Composite score
        vec_score = hv_pctl * er20
        
        candidates.append((symbol, vec_score))
    
    candidates.sort(key=lambda x: x[1], reverse=True)
    return [s for s, _ in candidates[:10]]
```

**Null Hypothesis H0:** VEC composite ranking performs no better than random Top-10 from F(T).

**Test Statistic:** Mean return across 44 test runs.

**Rejection Rule:** One-sided at α=0.05.

**Coverage Rule:** Fails if `len(F(T)) < 10` on >10% of runs.

---

### E1 Family-Wise Error Rate Control

**Method:** Max-T correction with block permutation.

**Null Distribution Generation:**
```python
def generate_max_t_null(raw, test_runs, nPerm=10000):
    T_obs = {
        'hv20': mean([run_hv20(run) for run in test_runs]),
        'er20': mean([run_er20(run) for run in test_runs]),
        'atr5': mean([run_atr5(run) for run in test_runs]),
        'vec': mean([run_vec(run) for run in test_runs])
    }
    
    max_t_distribution = []
    for _ in range(nPerm):
        # Block permutation: 5-date blocks
        blocks = partition_into_5day_blocks(test_runs)
        shuffled_blocks = fisher_yates_shuffle(blocks)
        permuted_runs = flatten(shuffled_blocks)
        
        T_perm = {
            'hv20': mean([run_hv20(run) for run in permuted_runs]),
            'er20': mean([run_er20(run) for run in permuted_runs]),
            'atr5': mean([run_atr5(run) for run in permuted_runs]),
            'vec': mean([run_vec(run) for run in permuted_runs])
        }
        
        # Studentize
        T_studentized = {}
        for policy in ['hv20', 'er20', 'atr5', 'vec']:
            returns_perm = [run_policy(run) for run in permuted_runs]
            sd = std(returns_perm)
            mean_return = T_perm[policy]
            
            if sd == 0:
                if mean_return == 0:
                    T_studentized[policy] = 0
                else:
                    T_studentized[policy] = float('inf') if mean_return > 0 else float('-inf')
            else:
                T_studentized[policy] = mean_return / sd
        
        max_t_distribution.append(max(T_studentized.values()))
    
    return max_t_distribution, T_obs
```

**Rejection Rule:**
```python
critical_value = quantile(max_t_distribution, 0.95)  # One-sided
for policy in ['hv20', 'er20', 'atr5', 'vec']:
    T_studentized_obs = T_obs[policy] / std([run_policy(run) for run in test_runs])
    reject_H0[policy] = (T_studentized_obs > critical_value)
```

**FWER Guarantee:** P(any false rejection) ≤ 0.05 under joint null.

---

## E2: Regime Filter Policy

**Research Question:** Does volatility regime filtering improve returns?

**Design:** 2×2 factorial (Regime × Direction), policy-level paired comparison.

**Pre-Filter:** All E2 experiments start from **ATR14% Top-10 baseline pool** (not re-ranked).

### E2.1: High-HV Regime Filter

**Policy:**
```python
def high_hv_filter(baseline_pool, raw, signalDate):
    filtered = []
    for symbol in baseline_pool:
        close = raw.contracts[symbol].ohlcv.close[0:signalIdx+1]
        if len(close) < 110:
            continue
        
        # HV20 percentile
        returns = [log(close[i] / close[i-1]) for i in range(len(close)-19, len(close)+1)]
        hv20 = std(returns) * sqrt(252)
        
        window90 = close[-110:-20]
        hv90d = [calculate_hv20(window90[i:i+21]) for i in range(len(window90)-20)]
        percentile = percentileofscore(hv90d, hv20)
        
        if percentile >= 50:  # High-HV regime
            filtered.append(symbol)
    
    return filtered
```

**Null Hypothesis H0:** High-HV filter provides no improvement over no-filter.

**Paired Design:**
```
Policy A: ATR14 Top-10, no regime filter
Policy B: ATR14 Top-10, high-HV filter

For each test run i:
    return_A[i] = simulate_policy_A(run_i)
    return_B[i] = simulate_policy_B(run_i)
    diff[i] = return_B[i] - return_A[i]

T_regime = mean(diff) / (std(diff) / sqrt(44))
```

**Rejection Rule:** Two-sided t-test at α=0.05.
```python
reject_H0 if |T_regime| > t_critical(df=43, alpha=0.025)
```

**Coverage Rule:** Fails if high-HV filter returns empty set on >20% of test runs.

---

### E2.2: Low-HV Regime Filter

**Policy:** Same as E2.1, but `percentile < 50`.

**Null Hypothesis H0:** Low-HV filter provides no improvement over no-filter.

**Test Statistic:** Paired difference t-statistic.

**Rejection Rule:** Two-sided at α=0.05.

**Coverage Rule:** Fails if low-HV filter returns empty set on >20% of test runs.

---

### E2 FWER Control

**Method:** Max-T with joint permutation of regime labels.

**Null Distribution:**
```python
def generate_e2_max_t_null(test_runs, nPerm=10000):
    max_t_distribution = []
    for _ in range(nPerm):
        # Permute regime labels only (direction is deterministic model output)
        regime_labels = ['high_hv', 'low_hv']
        permuted_regimes = [random.choice(regime_labels) for _ in range(44)]
        
        # Recalculate paired differences under permutation
        diff_high = [...]
        diff_low = [...]
        
        T_high = mean(diff_high) / (std(diff_high) / sqrt(44))
        T_low = mean(diff_low) / (std(diff_low) / sqrt(44))
        
        max_t_distribution.append(max(abs(T_high), abs(T_low)))
    
    return max_t_distribution
```

**Rejection Rule:**
```python
critical_value = quantile(max_t_distribution, 0.95)
reject_high_hv = (abs(T_high_obs) > critical_value)
reject_low_hv = (abs(T_low_obs) > critical_value)
```

---

## E3: Direction Policy

**Research Question:** Does directional filter improve returns?

**Design:** Policy-level paired comparison within each regime.

**Pre-Filter:** ATR14 Top-10 + regime filter (if any) from E2.

### E3.1: Long-Only Direction

**Policy:**
```python
def long_only_filter(symbol_pool, raw, signalDate):
    filtered = []
    for symbol in symbol_pool:
        close = raw.contracts[symbol].ohlcv.close[0:signalIdx+1]
        ma20 = mean(close[-20:])
        
        if close[-1] > ma20:  # Bullish
            filtered.append(symbol)
    
    return filtered
```

**Null Hypothesis H0:** Long-only filter provides no improvement over no-direction-filter.

**Paired Design:**
```
Policy A: Regime-filtered pool, no direction filter
Policy B: Regime-filtered pool, long-only filter

diff[i] = return_B[i] - return_A[i]
T_long = mean(diff) / (std(diff) / sqrt(44))
```

**Rejection Rule:** One-sided at α=0.05 (expected positive improvement).

**Coverage Rule:** Fails if long-only filter returns <3 symbols on >20% of test runs.

---

### E3.2: Short-Only Direction

**Policy:** Same as E3.1, but `close[-1] < ma20`.

**Null Hypothesis H0:** Short-only filter provides no improvement.

**Test Statistic:** Paired difference t-statistic.

**Rejection Rule:** One-sided at α=0.05.

**Coverage Rule:** Fails if short-only filter returns <3 symbols on >20% of test runs.

---

### E3 FWER Control

**Method:** Max-T with block permutation (5-date blocks).

**Note:** Direction labels are NOT permuted (direction is deterministic function of price vs MA20). Only the assignment of test runs to policies is permuted via block shuffle.

---

## E4: Execution Parameters

**Research Question:** Do hold period and portfolio size affect returns?

**Design:** Grid search with Bonferroni correction.

### E4.1: Hold Period

**Policies:**
```
H3: 3 trading days
H5: 5 trading days (baseline)
H7: 7 trading days
```

**Null Hypothesis H0:** No hold period provides superior returns to H5.

**Test Statistic:** Pairwise comparisons via paired t-tests.
```
T_H3_vs_H5 = mean(diff_H3_H5) / (std(diff_H3_H5) / sqrt(44))
T_H7_vs_H5 = mean(diff_H7_H5) / (std(diff_H7_H5) / sqrt(44))
```

**Rejection Rule:** Bonferroni-corrected two-sided tests at α=0.05/2 = 0.025 each.

**Coverage Rule:** No specific coverage requirement (execution layer).

---

### E4.2: Portfolio Size

**Policies:**
```
N5: Top 5 symbols
N10: Top 10 symbols (baseline)
N15: Top 15 symbols
```

**Null Hypothesis H0:** No portfolio size provides superior returns to N10.

**Test Statistic:** Pairwise paired t-tests.

**Rejection Rule:** Bonferroni-corrected at α=0.05/2 = 0.025 each.

**Coverage Rule:** Fails if N15 policy cannot fill 15 symbols on >20% of test runs.

---

## Forward Validation Protocol

**Embargo Period:** Minimum 30 trading days after registry commit date.

**Validation Trigger:** After embargo expires AND铲屎官 explicitly authorizes validation run.

**Validation Procedure:**
1. Lock registry commit SHA-256 hash
2. Run committed experimental code on forward data (no modifications allowed)
3. Compare observed test statistics to pre-registered null distributions
4. Report results without cherry-picking

**Validation Claims:** Only experiments that reject H0 in forward validation may claim improvement.

**Development Set Prohibition:** 44-run discovery data must NOT appear in validation claims, charts, or promotional materials.

---

## Implementation Checklist

- [ ] Implement `pre_ranking_eligible_universe(raw, signalDate)` utility
- [ ] Implement `feature_valid_intersection(raw, signalDate)` utility
- [ ] Implement E1.1-E1.4 ranker scripts
- [ ] Implement E2.1-E2.2 regime filter scripts
- [ ] Implement E3.1-E3.2 direction filter scripts
- [ ] Implement E4.1-E4.2 execution parameter variants
- [ ] Implement Max-T null distribution generator (block permutation, Fisher-Yates)
- [ ] Implement studentized t-statistic calculator with zero-variance handling
- [ ] Implement coverage failure detector
- [ ] Write unit tests for all rankers (index assertions)
- [ ] Generate dependency manifest (files, line ranges, formulas)
- [ ] Commit registry + code to version control
- [ ] Lock commit SHA-256 hash
- [ ] Start prospective forward embargo

---

## Success Criteria

**P0 (Registry Approval):**
- [ ] 缅因猫 approves experimental design (no logical errors)
- [ ] All formulas, index ranges, and null hypotheses precisely defined
- [ ] Baseline correctly identified as ATR14% Top-10
- [ ] Pre-ranking universe properly defined
- [ ] FWER control methods mathematically sound

**P1 (Implementation):**
- [ ] All experimental scripts execute without errors on 44-run data
- [ ] Coverage failure rates documented
- [ ] Null distributions generated with 10k permutations
- [ ] Results written to `experiments/discovery_results.json`

**P2 (Forward Validation):**
- [ ] Embargo period respected (≥30 trading days)
- [ ] Forward validation reproduces experimental pipeline exactly
- [ ] Results reported honestly (no p-hacking, no cherry-picking)

---

**End of Registry v1.0 DRAFT**
