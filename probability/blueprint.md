# Probability Estimator — Stage 4.5

> Stage: 4.5 (between analyze and report) | Type: Node.js script | Output: `probability.json`

## Purpose

Calculate HV (Historical Volatility) probability cone for Top 3 candidates, using Yang-Zhang estimator with automatic fallback to Garman-Klass or Close-to-Close when data is incomplete.

## Input

- `candidates.json` — Top 10 scan results with close/atr5
- `filtered.json` — Identifies which 3 candidates are KEEP
- Historical OHLC data (need to fetch from akshare or use cached raw data)

## Output

`probability.json`:

```json
{
  "meta": {
    "runId": "20260730-1701-auto",
    "calculatedAt": "2026-07-30T09:30:00.000Z",
    "estimator": "yang_zhang",
    "fallback": {
      "SC0": "yang_zhang",
      "EG0": "yang_zhang",
      "M0": "garman_klass"
    }
  },
  "probabilities": [
    {
      "symbol": "SC0",
      "close": 568.2,
      "hv": {
        "annual": 0.338,
        "periodDays": 20,
        "percentile90d": 84.7,
        "estimator": "yang_zhang"
      },
      "cone": {
        "3d": {
          "p68": [541.2, 596.8],
          "p95": [515.6, 626.4]
        },
        "5d": {
          "p68": [533.5, 605.3],
          "p95": [501.3, 643.8]
        }
      },
      "atrComparison": {
        "atr5": 32.8,
        "atr2xBand": [502.6, 633.8],
        "hv95Band": [515.6, 626.4],
        "divergencePct": 2.4,
        "interpretation": "两种方法区间基本一致，波动率模型稳定 ✅"
      }
    }
  ]
}
```

## Implementation

### Core Functions

Located in `probability/`:
- `hv-estimators.js` — Yang-Zhang / Garman-Klass / Close-to-Close volatility estimators
- `probability-cone.js` — Closed-form GBM probability cone calculator
- `test-hv-cone.js` — Test suite with synthetic data

### Data Requirements

**Minimum**:
- 20 days OHLC for HV calculation
- 21 days (20 + 1 for overnight calculation in Yang-Zhang)

**Optimal**:
- 110+ days OHLC (20 for HV + 90 for percentile calculation)

**Fallback**:
- If OHLC incomplete → use Garman-Klass (HLC only) or Close-to-Close
- If historical data < 90 days → percentile = null

### Calculation Flow

```
1. Load filtered.json → get KEEP candidates (≤3)
2. For each candidate:
   a. Fetch historical OHLC (110 days if available)
   b. Auto-select estimator (Yang-Zhang > Garman-Klass > C2C)
   c. Calculate HV (20-day window)
   d. Calculate HV percentile (if 90+ days available)
   e. Calculate probability cone (3d/5d, 68%/95%)
   f. Compare with ATR 2× band
3. Output probability.json
```

## Integration Point

Insert Stage 4.5 **between analyze and report**:

```
filter-llm → analyze → [NEW: probability-estimate] → report
```

**Why here**:
- `analyze.json` already has 6-question framework (Q1-Q6)
- `probability.json` adds statistical price range
- `report` generator reads both to produce final markdown

## Usage Example

```javascript
import { generateProbabilityAnalysis } from './probability/probability-cone.js';
import { readJSON } from './lib/file-utils.js';

// Load candidates
const candidates = await readJSON('runs/20260730-1701-auto/candidates.json');
const filtered = await readJSON('runs/20260730-1701-auto/filtered.json');

// Get KEEP candidates
const keepSymbols = filtered.candidates
  .filter(c => c.decision === 'KEEP')
  .map(c => c.symbol);

// Calculate probability for each
const probabilities = [];
for (const symbol of keepSymbols) {
  const candidate = candidates.candidates.find(c => c.symbol === symbol);
  
  // Fetch OHLC (TODO: implement data fetcher)
  const ohlcData = await fetchOHLC(symbol, 110);
  
  const analysis = await generateProbabilityAnalysis({
    symbol,
    close: candidate.trend.close,
    atr5: candidate.indicators.atr5,
    ohlcData,
    hvWindow: 20
  });
  
  probabilities.push(analysis);
}

// Write output
await writeJSON('runs/20260730-1701-auto/probability.json', {
  meta: {
    runId: '20260730-1701-auto',
    calculatedAt: new Date().toISOString(),
    // ... fallback info
  },
  probabilities
});
```

## Next Steps

1. **Implement data fetcher**: Need function to get historical OHLC from akshare
2. **Create Stage 4.5 script**: Standalone Node.js script or integrate into pipeline
3. **Update report generator**: Modify `report/generate.js` to read `probability.json`
4. **Update template**: Already done (supports ATR + HV comparison)

## Testing

Run test suite:
```bash
node .claude/skills/futures-radar/probability/test-hv-cone.js
```

Expected output:
- Yang-Zhang HV ~15-25% for steady uptrend
- Garman-Klass slightly lower (ignores overnight)
- Close-to-Close lowest (misses intraday)
- Probability cone bands widen with more days
- ATR vs HV divergence <10% for stable markets
