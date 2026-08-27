# Experiment Registry Implementation Checklist

**Status:** DRAFT (blocked on registry approval)  
**Last Updated:** 2026-08-06  
**Owner:** 布偶猫

---

## Phase 0: Registry Approval

**Blocking Condition:** Cannot proceed to implementation until 缅因猫 approves registry v1.0.

- [ ] Registry submitted for Round 7 review
- [ ] 缅因猫 approves experimental design (no logical errors)
- [ ] All index ranges verified
- [ ] FWER control methods validated
- [ ] Baseline identity confirmed (ATR14% Top10)
- [ ] Pre-ranking universe definition approved
- [ ] Registry committed to version control
- [ ] Commit SHA-256 hash locked
- [ ] Prospective forward embargo starts (≥30 trading days)

**Exit Criteria:** Registry file frozen, commit hash recorded, embargo clock started.

---

## Phase 1: Utility Functions

**Priority:** P0 (foundation for all experiments)  
**Estimated Time:** 4 hours

### 1.1 Pre-Ranking Universe Builder

**File:** `.claude/skills/futures-radar/experiments/lib/universe-builder.cjs`

**Function Signature:**
```javascript
/**
 * Build pre-ranking eligible universe U(T) for a given signal date.
 * 
 * @param {Object} raw - Parsed raw.json
 * @param {string} signalDate - Signal date (YYYY-MM-DD)
 * @returns {Array<string>} Array of eligible symbol codes
 */
function buildPreRankingUniverse(raw, signalDate) { ... }
```

**Implementation Steps:**
- [ ] Read `filter/rules.json` for liquidity thresholds
- [ ] For each symbol in raw.contracts:
  - [ ] Find signalIdx in dates array
  - [ ] Truncate OHLCV to signalIdx (inclusive)
  - [ ] Calculate avgTurnover5d
  - [ ] Calculate avgOI5d
  - [ ] Check涨跌停 lock condition
  - [ ] Check consecutive limit locks
  - [ ] Verify sufficient history (≥95 bars)
- [ ] Return filtered symbol list

**Unit Tests:**
- [ ] Test with known-passing symbol (e.g., SC0 on 2024-12-05)
- [ ] Test with known-failing symbol (low liquidity)
- [ ] Test with insufficient history (<95 bars)
- [ ] Test with涨跌停 locked symbol
- [ ] Verify universe size matches manual count on sample run

**Acceptance:** Passes all unit tests, produces same U(T) as manual calculation.

---

### 1.2 Feature-Valid Intersection Builder

**File:** `.claude/skills/futures-radar/experiments/lib/universe-builder.cjs`

**Function Signature:**
```javascript
/**
 * Build feature-valid intersection F(T) ⊆ U(T).
 * 
 * @param {Object} raw - Parsed raw.json
 * @param {string} signalDate - Signal date
 * @returns {Array<string>} Symbols with ≥110 bars history
 */
function buildFeatureValidIntersection(raw, signalDate) { ... }
```

**Implementation Steps:**
- [ ] Call buildPreRankingUniverse(raw, signalDate)
- [ ] Filter to symbols with length(close[0:signalIdx+1]) ≥ 110

**Unit Tests:**
- [ ] Test subset relationship: F(T) ⊆ U(T)
- [ ] Test boundary case: symbol with exactly 110 bars
- [ ] Test exclusion: symbol with 109 bars

**Acceptance:** F(T) is always subset of U(T), minimum history enforced.

---

### 1.3 HV20 Calculator with Percentile

**File:** `.claude/skills/futures-radar/experiments/lib/features.cjs`

**Function Signature:**
```javascript
/**
 * Calculate HV20 and 90-day percentile.
 * 
 * @param {Array<number>} close - Close prices truncated to signalIdx
 * @returns {Object} { hv20: number, percentile90d: number | null }
 */
function calculateHV20Percentile(close) { ... }
```

**Implementation Steps:**
- [ ] Verify close.length ≥ 110
- [ ] Calculate HV20 from close[-20:]
  - [ ] Compute 20 log returns
  - [ ] Calculate std * sqrt(252)
- [ ] Extract 90-day window: close[-110:-20]
- [ ] Rolling HV20 over 90-day window (71 values)
- [ ] Calculate percentile rank of current HV20

**Index Assertions:**
```javascript
assert(returns.length === 20, "HV20 uses 20 returns");
assert(returns[0] === Math.log(close[close.length-20] / close[close.length-21]));
assert(window90.length === 90, "Percentile window is 90 days");
assert(window90[window90.length-1] === close[close.length-21], "No overlap");
assert(hv90d.length === 71, "90 prices → 71 rolling values");
```

**Unit Tests:**
- [ ] Test with synthetic log-normal returns (known HV)
- [ ] Test with flat prices (HV ≈ 0)
- [ ] Test percentile calculation against manual ranking
- [ ] Test insufficient data (<110 bars) returns null

**Acceptance:** Produces mathematically correct HV20 and percentile, all assertions pass.

---

### 1.4 ER20 Calculator

**File:** `.claude/skills/futures-radar/experiments/lib/features.cjs`

**Function Signature:**
```javascript
/**
 * Calculate 20-period Efficiency Ratio.
 * 
 * @param {Array<number>} close - Close prices truncated to signalIdx
 * @returns {number} ER20 value [0, 1]
 */
function calculateER20(close) { ... }
```

**Implementation Steps:**
- [ ] Verify close.length ≥ 21
- [ ] Calculate net change: abs(close[-1] - close[-21])
- [ ] Calculate sum of daily changes: sum(abs(close[i] - close[i-1]) for i in [-20, -1])
- [ ] Return net / sum (or 0 if sum == 0)

**Index Assertions:**
```javascript
assert(close.length >= 21, "ER20 requires 21 prices");
const dailyChanges = [];
for (let i = close.length - 20; i < close.length; i++) {
  dailyChanges.push(Math.abs(close[i] - close[i-1]));
}
assert(dailyChanges.length === 20, "20 daily changes");
```

**Unit Tests:**
- [ ] Test with trending prices (ER → 1.0)
- [ ] Test with oscillating prices (ER → 0.0)
- [ ] Test with flat prices (returns 0)

**Acceptance:** ER20 ∈ [0, 1], handles edge cases correctly.

---

### 1.5 ATR5 Percentile Calculator

**File:** `.claude/skills/futures-radar/experiments/lib/features.cjs`

**Function Signature:**
```javascript
/**
 * Calculate ATR5 percentile using 90-day lookback.
 * 
 * @param {Object} ohlc - { high: [], low: [], close: [] } truncated to signalIdx
 * @returns {Object} { atr5: number, atr5Pct: number, percentile90d: number | null }
 */
function calculateATR5Percentile(ohlc) { ... }
```

**Implementation Steps:**
- [ ] Verify ohlc.close.length ≥ 95
- [ ] Calculate ATR5 from last 5 bars
- [ ] Calculate atr5Pct = (atr5 / close[-1]) * 100
- [ ] Extract 90-day OHLC window: [T-95:T-5]
- [ ] Rolling ATR5 over 90-day window (86 values)
- [ ] Calculate percentile rank

**Index Assertions:**
```javascript
const tr = calculateTrueRange(high.slice(-5), low.slice(-5), close.slice(-6));
assert(tr.length === 5, "ATR5 uses 5 true ranges");
assert(window90_close.length === 90);
assert(atr90d.length === 86, "90 bars → 86 rolling ATR5 values");
```

**Unit Tests:**
- [ ] Test ATR5 against shared-backtest-lib.cjs reference
- [ ] Test percentile against manual ranking
- [ ] Test insufficient data (<95 bars) returns null

**Acceptance:** ATR5 matches reference implementation, percentile correct.

---

### 1.6 VEC Score Calculator

**File:** `.claude/skills/futures-radar/experiments/lib/features.cjs`

**Function Signature:**
```javascript
/**
 * Calculate Volatility-Efficiency Composite score.
 * 
 * @param {Array<number>} close - Close prices truncated to signalIdx
 * @returns {Object} { hv20: number, hvPercentile: number, er20: number, vecScore: number }
 */
function calculateVEC(close) { ... }
```

**Implementation Steps:**
- [ ] Call calculateHV20Percentile(close)
- [ ] Call calculateER20(close)
- [ ] Return vecScore = hvPercentile * er20

**Unit Tests:**
- [ ] Test VEC = 0 when ER20 = 0 (oscillating prices)
- [ ] Test VEC = hvPercentile when ER20 = 1.0 (trending)

**Acceptance:** VEC correctly combines HV percentile and ER20.

---

### 1.7 Statistical Utilities

**File:** `.claude/skills/futures-radar/experiments/lib/stats.cjs`

**Functions:**
- [ ] `percentileOfScore(arr, value)` — Returns percentile rank [0, 100]
- [ ] `studentizedT(returns)` — Returns T-statistic with zero-variance handling
- [ ] `fisherYatesShuffle(arr)` — In-place uniform random permutation
- [ ] `blockPermutation(runs, blockSize=5)` — Block-wise permutation

**Unit Tests:**
- [ ] Test percentileOfScore against scipy reference
- [ ] Test studentizedT edge cases (sd=0 with mean=0/±value)
- [ ] Test fisherYatesShuffle uniformity (χ² test, 10k trials)
- [ ] Test blockPermutation preserves within-block order

**Acceptance:** All statistical functions match reference implementations, edge cases handled.

---

## Phase 2: E1 Ranker Implementations

**Priority:** P0  
**Estimated Time:** 8 hours

### 2.1 HV20 Percentile Ranker

**File:** `.claude/skills/futures-radar/experiments/rankers/hv20-ranker.cjs`

**Function Signature:**
```javascript
/**
 * Rank candidates by HV20 percentile, return Top 10.
 * 
 * @param {Object} raw - Parsed raw.json
 * @param {string} signalDate - Signal date
 * @returns {Array<string>} Top 10 symbols by HV20 percentile (descending)
 */
function hv20Ranker(raw, signalDate) { ... }
```

**Implementation:**
- [ ] Call buildFeatureValidIntersection(raw, signalDate)
- [ ] For each symbol in F(T):
  - [ ] Extract close array truncated to signalIdx
  - [ ] Call calculateHV20Percentile(close)
  - [ ] Store (symbol, percentile) pair
- [ ] Sort by percentile descending
- [ ] Return top 10 symbols

**Unit Tests:**
- [ ] Test with known universe (manually verify Top 10)
- [ ] Test with <10 eligible symbols (coverage failure)
- [ ] Test index assertions pass for all candidates

**Acceptance:** Returns correct Top 10, handles edge cases, passes unit tests.

---

### 2.2 ER20 Ranker

**File:** `.claude/skills/futures-radar/experiments/rankers/er20-ranker.cjs`

**Implementation:** Similar to 2.1, but uses buildPreRankingUniverse (only needs 21 bars) and calculateER20.

**Tasks:**
- [ ] Implement ranker function
- [ ] Unit tests (same pattern as 2.1)

---

### 2.3 ATR5 Percentile Ranker

**File:** `.claude/skills/futures-radar/experiments/rankers/atr5-ranker.cjs`

**Implementation:** Uses U(T) ∩ {length ≥ 95}, calls calculateATR5Percentile.

**Tasks:**
- [ ] Implement ranker function
- [ ] Unit tests

---

### 2.4 VEC Ranker

**File:** `.claude/skills/futures-radar/experiments/rankers/vec-ranker.cjs`

**Implementation:** Uses F(T) (110 bars), calls calculateVEC.

**Tasks:**
- [ ] Implement ranker function
- [ ] Unit tests

---

### 2.5 E1 Null Distribution Generator

**File:** `.claude/skills/futures-radar/experiments/null-generators/e1-random-null.cjs`

**Function Signature:**
```javascript
/**
 * Generate random Top-10 null distribution for E1 experiments.
 * 
 * @param {Object} raw - Parsed raw.json
 * @param {string} signalDate - Signal date
 * @param {string} rankerType - 'hv20' | 'er20' | 'atr5' | 'vec'
 * @param {number} nReps - Number of permutations (default 10000)
 * @returns {Array<number>} Null distribution of date-cluster returns
 */
function generateE1RandomNull(raw, signalDate, rankerType, nReps = 10000) { ... }
```

**Implementation:**
- [ ] Determine eligible universe based on rankerType:
  - HV20/VEC → F(T)
  - ER20 → U(T)
  - ATR5 → U(T) ∩ {length ≥ 95}
- [ ] For each repetition:
  - [ ] Sample 10 symbols without replacement
  - [ ] Simulate trades for each symbol
  - [ ] Calculate date-cluster equal-weight return
  - [ ] Append to null distribution
- [ ] Return null_returns array

**Unit Tests:**
- [ ] Test with known universe (verify sampling without replacement)
- [ ] Test insufficient universe (<10 symbols) returns null
- [ ] Test null distribution length == nReps

**Acceptance:** Generates valid null distribution, handles edge cases.

---

### 2.6 E1 Max-T Null Generator

**File:** `.claude/skills/futures-radar/experiments/null-generators/e1-max-t-null.cjs`

**Function Signature:**
```javascript
/**
 * Generate Max-T null distribution for E1 FWER control.
 * 
 * @param {Array<Object>} testRuns - 44 test runs from test-runs.json
 * @param {Object} raw - Raw data lookup
 * @param {number} nPerm - Number of permutations (default 10000)
 * @returns {Object} { maxTDistribution: [], observedT: {} }
 */
function generateE1MaxTNull(testRuns, raw, nPerm = 10000) { ... }
```

**Implementation:**
- [ ] Calculate observed T statistics for all 4 rankers
- [ ] For each permutation:
  - [ ] Block permutation (5-date blocks, Fisher-Yates on blocks)
  - [ ] Recalculate returns for all 4 rankers on permuted runs
  - [ ] Studentize each ranker's mean return
  - [ ] Record max(T_studentized) across 4 rankers
- [ ] Return {maxTDistribution, observedT}

**Unit Tests:**
- [ ] Test block permutation preserves within-block order
- [ ] Test studentization handles zero variance cases
- [ ] Test maxTDistribution length == nPerm

**Acceptance:** Produces valid Max-T distribution, FWER control mathematically sound.

---

## Phase 3: E2 Regime Filter Implementations

**Priority:** P1  
**Estimated Time:** 4 hours

### 3.1 High-HV Regime Filter

**File:** `.claude/skills/futures-radar/experiments/filters/high-hv-filter.cjs`

**Function Signature:**
```javascript
/**
 * Filter baseline pool to high-HV regime (percentile ≥ 50).
 * 
 * @param {Array<string>} baselinePool - ATR14% Top-10 symbols
 * @param {Object} raw - Parsed raw.json
 * @param {string} signalDate - Signal date
 * @returns {Array<string>} Filtered symbols
 */
function highHVFilter(baselinePool, raw, signalDate) { ... }
```

**Implementation:**
- [ ] For each symbol in baselinePool:
  - [ ] Calculate HV20 percentile
  - [ ] If percentile ≥ 50, include in output
- [ ] Return filtered list

**Unit Tests:**
- [ ] Test with known high-HV symbol (percentile > 50)
- [ ] Test with known low-HV symbol (percentile < 50)
- [ ] Test empty result (all symbols low-HV)

**Acceptance:** Correctly filters high-HV regime, handles edge cases.

---

### 3.2 Low-HV Regime Filter

**File:** `.claude/skills/futures-radar/experiments/filters/low-hv-filter.cjs`

**Implementation:** Same as 3.1, but `percentile < 50`.

**Tasks:**
- [ ] Implement filter function
- [ ] Unit tests

---

### 3.3 E2 Paired Comparison Runner

**File:** `.claude/skills/futures-radar/experiments/runners/e2-paired-comparison.cjs`

**Function Signature:**
```javascript
/**
 * Run paired comparison for E2 regime filter.
 * 
 * @param {Array<Object>} testRuns - 44 test runs
 * @param {Function} regimeFilter - Filter function (high-HV or low-HV)
 * @returns {Object} { pairedDiff: [], tStatistic: number, pValue: number }
 */
function runE2PairedComparison(testRuns, regimeFilter) { ... }
```

**Implementation:**
- [ ] For each test run:
  - [ ] Policy A: ATR14 Top-10, no filter
  - [ ] Policy B: ATR14 Top-10, regime filter applied
  - [ ] Calculate return_A and return_B
  - [ ] Store diff[i] = return_B[i] - return_A[i]
- [ ] Calculate paired t-statistic: mean(diff) / (std(diff) / sqrt(44))
- [ ] Calculate two-sided p-value

**Unit Tests:**
- [ ] Test with known positive effect (mocked filter)
- [ ] Test with no effect (filter == identity)
- [ ] Test zero variance in diffs (sd = 0 handling)

**Acceptance:** Produces valid paired comparison results, t-test correct.

---

### 3.4 E2 Max-T Null Generator

**File:** `.claude/skills/futures-radar/experiments/null-generators/e2-max-t-null.cjs`

**Implementation:** Joint permutation of regime labels (high-HV vs low-HV), not direction labels.

**Tasks:**
- [ ] Implement permutation logic
- [ ] Generate Max-T distribution
- [ ] Unit tests

---

## Phase 4: E3 Direction Filter Implementations

**Priority:** P1  
**Estimated Time:** 4 hours

### 4.1 Long-Only Direction Filter

**File:** `.claude/skills/futures-radar/experiments/filters/long-only-filter.cjs`

**Function Signature:**
```javascript
/**
 * Filter to bullish symbols (close > MA20).
 * 
 * @param {Array<string>} symbolPool - Input pool
 * @param {Object} raw - Parsed raw.json
 * @param {string} signalDate - Signal date
 * @returns {Array<string>} Bullish symbols
 */
function longOnlyFilter(symbolPool, raw, signalDate) { ... }
```

**Implementation:**
- [ ] For each symbol:
  - [ ] Calculate MA20 from close[-20:]
  - [ ] If close[-1] > MA20, include
- [ ] Return filtered list

**Unit Tests:**
- [ ] Test with bullish symbol (close > MA20)
- [ ] Test with bearish symbol (close < MA20)
- [ ] Test insufficient coverage (<3 symbols)

**Acceptance:** Correctly identifies bullish symbols.

---

### 4.2 Short-Only Direction Filter

**File:** `.claude/skills/futures-radar/experiments/filters/short-only-filter.cjs`

**Implementation:** Same as 4.1, but `close[-1] < MA20`.

**Tasks:**
- [ ] Implement filter function
- [ ] Unit tests

---

### 4.3 E3 Paired Comparison Runner

**File:** `.claude/skills/futures-radar/experiments/runners/e3-paired-comparison.cjs`

**Implementation:** Similar to E2 paired comparison, but for direction filters.

**Tasks:**
- [ ] Implement runner function
- [ ] Unit tests

---

### 4.4 E3 Max-T Null Generator

**File:** `.claude/skills/futures-radar/experiments/null-generators/e3-max-t-null.cjs`

**Implementation:** Block permutation only (direction is deterministic, not permutable).

**Tasks:**
- [ ] Implement block permutation logic
- [ ] Generate Max-T distribution
- [ ] Unit tests

---

## Phase 5: E4 Execution Parameter Implementations

**Priority:** P2  
**Estimated Time:** 3 hours

### 5.1 Hold Period Variants

**File:** `.claude/skills/futures-radar/experiments/execution/hold-period.cjs`

**Policies:**
- [ ] Implement H3 (3-day hold)
- [ ] Implement H5 (5-day hold, baseline)
- [ ] Implement H7 (7-day hold)

**Tasks:**
- [ ] Modify simulateExit to accept holdDays parameter
- [ ] Run paired comparisons: H3 vs H5, H7 vs H5
- [ ] Apply Bonferroni correction (α = 0.025 each)

---

### 5.2 Portfolio Size Variants

**File:** `.claude/skills/futures-radar/experiments/execution/portfolio-size.cjs`

**Policies:**
- [ ] Implement N5 (Top 5 symbols)
- [ ] Implement N10 (Top 10 symbols, baseline)
- [ ] Implement N15 (Top 15 symbols)

**Tasks:**
- [ ] Modify ranker output to support variable N
- [ ] Run paired comparisons: N5 vs N10, N15 vs N10
- [ ] Apply Bonferroni correction

---

## Phase 6: Coverage Failure Detection

**Priority:** P0  
**Estimated Time:** 2 hours

**File:** `.claude/skills/futures-radar/experiments/lib/coverage-checker.cjs`

**Function Signature:**
```javascript
/**
 * Check if experiment meets coverage requirements.
 * 
 * @param {Array<Object>} testRuns - 44 test runs
 * @param {Function} policy - Policy function to test
 * @param {Object} coverageRules - { minSymbols: 10, maxFailureRate: 0.10 }
 * @returns {Object} { passed: boolean, failureRate: number, failedRuns: [] }
 */
function checkCoverage(testRuns, policy, coverageRules) { ... }
```

**Implementation:**
- [ ] For each test run:
  - [ ] Apply policy function
  - [ ] Count output symbols
  - [ ] Record failure if < minSymbols
- [ ] Calculate failureRate = failedRuns / totalRuns
- [ ] Return { passed: failureRate <= maxFailureRate, ... }

**Unit Tests:**
- [ ] Test with all-passing policy (failureRate = 0)
- [ ] Test with boundary case (failureRate = 0.10)
- [ ] Test with all-failing policy (failureRate = 1.0)

**Acceptance:** Accurately detects coverage failures, thresholds enforced.

---

## Phase 7: Integration & Discovery Run

**Priority:** P0  
**Estimated Time:** 4 hours

### 7.1 Discovery Run Orchestrator

**File:** `.claude/skills/futures-radar/experiments/run-discovery.cjs`

**Command:**
```bash
node .claude/skills/futures-radar/experiments/run-discovery.cjs \
  --output experiments/discovery_results.json
```

**Tasks:**
- [ ] Load test-runs.json (44 runs)
- [ ] Run E1.1-E1.4 rankers on all runs
- [ ] Generate E1 Max-T null distribution (10k permutations)
- [ ] Run E2.1-E2.2 filters on all runs
- [ ] Generate E2 Max-T null distribution
- [ ] Run E3.1-E3.2 filters on all runs
- [ ] Generate E3 Max-T null distribution
- [ ] Run E4.1-E4.2 execution variants
- [ ] Check coverage for all experiments
- [ ] Write results to JSON

**Output Schema:**
```json
{
  "meta": {
    "runAt": "ISO-8601",
    "registryCommit": "SHA-256",
    "totalTestRuns": 44
  },
  "e1": {
    "hv20": { "observedT": 1.23, "criticalValue": 2.14, "rejected": false, "coverage": { "passed": true, "failureRate": 0.045 } },
    "er20": { ... },
    "atr5": { ... },
    "vec": { ... }
  },
  "e2": { ... },
  "e3": { ... },
  "e4": { ... }
}
```

**Acceptance:**
- [ ] Runs without errors on 44-run discovery data
- [ ] All null distributions have 10k samples
- [ ] Coverage checks performed for all experiments
- [ ] Results JSON written successfully

---

### 7.2 Results Validation

**Tasks:**
- [ ] Verify observedT values are finite (no NaN/Infinity)
- [ ] Verify criticalValue > 0 for all experiments
- [ ] Verify coverage failureRate ∈ [0, 1]
- [ ] Spot-check 1-2 experiments with manual calculation
- [ ] Document any coverage failures

**Acceptance:** Results are mathematically valid, no computational errors.

---

## Phase 8: Documentation & Handoff

**Priority:** P1  
**Estimated Time:** 2 hours

### 8.1 Discovery Results Report

**File:** `.claude/skills/futures-radar/experiments/DISCOVERY_REPORT.md`

**Contents:**
- [ ] Summary of all experiments run
- [ ] Coverage failure rates per experiment
- [ ] Observed test statistics vs critical values
- [ ] Which experiments rejected H0 (discovery phase only)
- [ ] Warnings about development data being BURNED
- [ ] Next steps: prospective forward validation

---

### 8.2 Errata Log

**File:** `.claude/skills/futures-radar/experiments/ERRATA.md`

**Purpose:** Document any bugs or issues discovered post-freeze.

**Format:**
```markdown
## Issue 1: Off-by-one in HV20 window

**Discovered:** 2026-08-10  
**File:** lib/features.cjs, line 42  
**Impact:** Low (±0.5% percentile error)  
**Fix:** Applied in forward validation code (SHA: abc123)  
**Registry Amendment:** Not required (minor implementation detail)
```

---

### 8.3 Forward Validation Protocol

**File:** `.claude/skills/futures-radar/experiments/FORWARD_VALIDATION.md`

**Contents:**
- [ ] Embargo end date calculation
- [ ] Validation trigger conditions
- [ ] Step-by-step validation procedure
- [ ] SHA-256 verification checklist
- [ ] Results reporting template

---

## Phase 9: Version Control & Freeze

**Priority:** P0  
**Estimated Time:** 1 hour

**Tasks:**
- [ ] Commit all experimental code to git
- [ ] Tag commit: `futures-radar-experiments-v1.0`
- [ ] Record commit SHA-256 in registry
- [ ] Lock dependencies manifest (commit SHAs for all libs)
- [ ] Create read-only archive of discovery data (44-run raw.json files)
- [ ] Update registry status: DRAFT → FROZEN
- [ ] Start embargo clock (record date in registry)

**Acceptance:** Registry frozen, commit hash locked, embargo started.

---

## Success Criteria Summary

**P0 (Must Have):**
- [ ] Registry approved by 缅因猫 (Round 7+)
- [ ] All utility functions implemented and tested
- [ ] All E1-E4 experiments implemented
- [ ] Coverage checks working
- [ ] Discovery run completes without errors
- [ ] Results JSON written
- [ ] Code committed and tagged
- [ ] Embargo started

**P1 (Should Have):**
- [ ] Comprehensive unit test coverage (>80%)
- [ ] Discovery report written
- [ ] Forward validation protocol documented
- [ ] Errata log template created

**P2 (Nice to Have):**
- [ ] Integration tests for full pipeline
- [ ] Performance benchmarks (discovery run < 30 minutes)
- [ ] Visualization scripts for null distributions

---

**Total Estimated Time:** ~32 hours (4 working days)

**Blocking Dependencies:**
1. Registry approval (Phase 0) blocks all implementation phases
2. Utility functions (Phase 1) block E1-E4 implementations
3. Discovery run (Phase 7) requires all prior phases complete

---

**End of Implementation Checklist DRAFT**
