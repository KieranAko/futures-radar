# Control Group Results — High-Volatility Scanner Bias Analysis

## Purpose

Establish baseline performance to answer:
1. Does high-volatility scanner create directional bias?
2. What is the null hypothesis (random) expected return?
3. Do current models beat naive strategies?

## Control Groups

| Model | Strategy | Purpose |
|-------|----------|---------|
| control-always-long | Enter long on all candidates | Test for natural long bias |
| control-always-short | Enter short on all candidates | Test for natural short bias |
| control-random-fixed | Random direction (seed=12345) | Null hypothesis baseline |

## Results Summary (44 runs, 427 trades per window)

### T+5 Window

| Strategy | Accuracy | Avg Return | Win Rate | Profit Factor | Sharpe | Max DD |
|----------|----------|------------|----------|---------------|--------|--------|
| **Always Long** | 41.7% | **-0.78%** | 41.5% | 0.70 | -1.76 | 465% |
| **Always Short** | **58.3%** | **+0.64%** | 57.9% | 1.34 | 1.44 | 154% |
| Random (fixed) | 53.4% | +0.11% | 52.9% | 1.05 | 0.24 | 93% |

### T+10 Window

| Strategy | Accuracy | Avg Return | Win Rate | Profit Factor | Sharpe | Max DD |
|----------|----------|------------|----------|---------------|--------|--------|
| **Always Long** | 40.0% | **-0.25%** | 39.7% | 0.92 | -0.40 | 435% |
| **Always Short** | **60.1%** | **+0.11%** | 58.9% | 1.04 | 0.18 | 274% |

## Critical Finding: Natural Short Bias

**High-volatility commodities exhibit a strong short bias:**

1. **Always Long loses money**: 40-42% accuracy, negative returns
2. **Always Short makes money**: 58-60% accuracy, positive returns
3. **The bias persists across both T+5 and T+10 windows**

### Why This Happens (Hypothesis)

High volatility often signals:
- **Parabolic tops** before corrections (bearish)
- **Panic selling exhaustion** (but less frequent)
- **Overextended trends** ready to reverse downward
- **Fundamental deterioration** (supply gluts, demand drops)

Commodities with sudden volatility spikes are more likely to be topping out than bottoming.

## Implications for Model Design

### 1. Baseline Performance Reinterpreted

| Model | T+5 Return | Explanation |
|-------|-----------|-------------|
| Baseline | +0.16% | Beats Always Long (-0.78%) but far below Always Short (+0.64%) |
| Model-C | +0.25% | Random direction with 50% shorts captures half of short bias |

**Baseline's +0.16% is not an edge** — it's simply avoiding the worst of the long bias while missing the short opportunity.

### 2. Model-C T+10 Success Explained

Model-C T+10 achieved +7.13% avg return with 60% accuracy.

**Previous hypothesis**: "Random direction benefits from trend persistence"  
**Corrected understanding**: "Random direction benefits from natural 60% short-side accuracy"

If Model-C generated 50% short signals, and shorts have 60% base accuracy, that alone explains the performance without any model skill.

### 3. Why Model-A/B Failed

Both models inherit baseline's MA alignment, which likely favors **bullish** signals (all three indicators positive). This fights against the natural short bias, resulting in zero executable signals.

## Recommendations

### 1. Flip the Strategy

Instead of trying to predict which high-volatility contracts will go **up**, focus on:
- **Filtering out the few that will go up** (avoid false shorts)
- **Going short on the rest** (default to the 60% base rate)

### 2. Reframe Direction Layer

**Old approach**: Predict direction from neutral (50/50 prior)  
**New approach**: Start with 60% short prior, look for signals to override to long

Example:
```
if (strong_bullish_signal):
    direction = 'bullish'
else:
    direction = 'bearish'  # default to short bias
```

### 3. Test Directional Filters Against Short Baseline

Any directional model must beat:
- **Always Short T+5: +0.64%, Sharpe 1.44**
- **Always Short T+10: +0.11%, Sharpe 0.18**

This is the new performance bar, not "random 50%".

### 4. Investigate Source of Short Bias

Before building models on top of this bias, validate it's not an artifact:
- Is this a 2024-2026 bear market effect?
- Does it hold across different commodity sectors?
- Are we catching rollover artifacts (contango/backwardation)?
- Do continuous contract splicing methods create phantom trends?

## Next Steps

1. ✅ **Control groups established** (this document)
2. 🔄 **Validate bias is real**: Test on different time periods, sectors
3. ⏳ **Simple directional models**: Test change5d, EMA20, Donchian against Always Short baseline
4. ⏳ **Data quality audit**: Check for rollover effects, limit moves, OHLC violations

---

Generated: 2026-08-06  
Framework: strict-backtest.cjs (zero look-ahead bias)  
Sample: 44 runs (2024-01-02 to 2026-06-08), 427 trades per window  
Key Finding: High-volatility commodities have 58-60% natural short-side accuracy
