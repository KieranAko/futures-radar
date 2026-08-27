# Experiment Registry Dependencies Manifest

**Status:** DEPRECATED — replaced by v1.3 implementation  
**Reason:** This document described a v1.0 post-processor design that was never implemented. The actual v1.3 implementation uses end-to-end experiment runners with integrated data pipeline.

**Current Truth:** See `EXPERIMENT_REGISTRY_v1.2.md` for registry specification and individual experiment files (e1-scanner.js, e2-eligibility.js, e3-direction.js, e4a-holdperiod.js, e4b-account-gate.js) for implementation.

---

## What Changed

### Original Vision (v1.0, documented here)
- Post-processor statistical layer consuming pre-computed backtest results
- Separate calculation of features (ATR, HV, ER, VEC) in standalone scripts
- Statistical functions applied after full backtest runs
- Dependencies on shared-backtest-lib.cjs and filter/rules.json

### Actual Implementation (v1.3)
- End-to-end experiment runners that own the complete pipeline
- Each experiment (E1-E4) directly processes raw.json → results
- Integrated feature calculation within experiment context
- Statistical validation (paired deltas, null distributions, FWER control) built into runners
- Input invariants validate array consistency and finite values

### Why the Divergence
- P0-4 review finding: "当前 E1-E4a 是统计后处理器，不拥有端到端流程" (current E1-E4a are statistical post-processors, do not own end-to-end flow)
- Need for atomic experiment units that can be re-run independently
- Better isolation between discovery experiments and forward validation
- Clearer ownership of data transformations within each experiment

---

## Current Architecture Reference

### E1-E4a Experiment Runners
Located in `experiments/`:
- `e1-scanner.js` — Tests 4 scanner candidates (HV20, ER20, ATR5, VEC) vs ATR14% baseline
- `e2-eligibility.js` — Tests 3 ablation variants (no HV, no ATR, no regime) vs combined gate baseline
- `e3-direction.js` — Tests 2 direction policies + 3 controls vs EMA20 baseline
- `e4a-holdperiod.js` — Tests H7/H15 vs H10 baseline (Bonferroni α=0.025)

Each runner:
1. Accepts `testData` with dates, baseline, candidates/variants
2. Validates input invariants (array lengths, finite values)
3. Calculates paired deltas
4. Generates null distribution via block sign-flip
5. Computes family-wise statistics (Max-T or Max-|T|)
6. Returns results with winner selection and p-values

### E4b Account-Level Gate
Located in `experiments/e4b-account-gate.js`:
- `validateAccountGate(trades, config)` — Economic viability checks
- `compareAccountPerformance(baseline, challenger, config)` — Relative improvement validation
- Phase 1 implementation: simplified sequential trade execution
- Future: Full event-driven v5 with nine gates enumerated

### Statistical Library
Located in `lib/statistics.js`:
- `generateBlockSignFlip(numBlocks)` — 64 sign-flip patterns for 6 blocks
- `applyBlockSigns(deltas, pattern)` — Apply sign-flip to paired deltas
- `calculateStudentizedT(deltas)` — Studentized t-statistic with zero-variance handling
- `calculateMaxT(tStats)` — Max-T family statistic (signed, one-sided)
- `calculateMaxAbsT(tStats)` — Max-|T| family statistic (absolute, two-sided)
- `calculateAdjustedPValue(tObs, nullDist)` — FWER-adjusted p-value

### Feature Calculation
Located in `lib/features.js`:
- `calculateEMA20Slope(emaValues)` — Five-point OLS regression, returns %/day slope
- Normalization: `(rawSlope / avgPrice) * 100`
- Parity verified against baseline momentum-ema20-parameterized.cjs

---

## Migration Path (If Needed)

If you need the original v1.0 vision dependencies:

1. **Feature formulas:** See Registry v1.2 Section 1.3-1.4 for ATR14%, HV20, ER20, ATR5, VEC definitions
2. **Statistical functions:** Implemented in `lib/statistics.js` with test coverage
3. **Data contracts:** raw.json schema in Registry v1.2 Section 8.2
4. **Baseline pipeline:** Complete 4-stage flow in Registry v1.2 Section 1.1

---

**Last Updated:** 2026-08-07  
**Deprecation Notice:** Do not reference this file for current implementation details. Use experiment source files and Registry v1.2 as source of truth.
