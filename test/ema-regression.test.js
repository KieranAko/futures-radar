import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { calculateEMA20Slope } from '../lib/features.js';

describe('EMA20 5-point regression', () => {
  it('should calculate slope in %/day units', () => {
    // Upward trend: EMA values increasing by 1 each day
    const emaValues = [100, 101, 102, 103, 104];
    const slope = calculateEMA20Slope(emaValues);

    // Raw OLS slope = 1.0 (price units/day)
    // Normalized: (1.0 / 104) * 100 = 0.9615% per day
    // This matches baseline: momentum-ema20-parameterized.cjs:42-43
    const expected = (1.0 / 104) * 100;
    assert.ok(Math.abs(slope - expected) < 0.001, `Slope should be ${expected.toFixed(4)}%/day, got ${slope.toFixed(4)}`);
  });

  it('should return 0 for flat EMA values', () => {
    const emaValues = [100, 100, 100, 100, 100];
    const slope = calculateEMA20Slope(emaValues);

    assert.equal(slope, 0, 'Flat EMA should have slope = 0');
  });

  it('should return negative slope for downtrend', () => {
    const emaValues = [104, 103, 102, 101, 100];
    const slope = calculateEMA20Slope(emaValues);

    // Raw OLS slope = -1.0
    // Normalized: (-1.0 / 100) * 100 = -1.0% per day
    const expected = (-1.0 / 100) * 100;
    assert.ok(slope < 0, 'Downtrend should have negative slope');
    assert.ok(Math.abs(slope - expected) < 0.001, `Downtrend slope should be ${expected.toFixed(4)}%/day`);
  });

  it('should require exactly 5 EMA values', () => {
    assert.throws(() => {
      calculateEMA20Slope([100, 101, 102, 103]);
    }, /requires 5 EMA values/);

    assert.throws(() => {
      calculateEMA20Slope([100, 101, 102, 103, 104, 105]);
    }, /requires 5 EMA values/);
  });

  it('should use days 0-4 as x-axis with %/day normalization', () => {
    // Non-linear pattern to verify OLS calculation
    const emaValues = [100, 102, 101, 103, 105];
    const slope = calculateEMA20Slope(emaValues);

    // Manual OLS calculation:
    // x = [0,1,2,3,4], mean_x = 2
    // y = [100,102,101,103,105], mean_y = 102.2
    // numerator = (-2*-2.2) + (-1*-0.2) + (0*-1.2) + (1*0.8) + (2*2.8) = 11.0
    // denominator = 4 + 1 + 0 + 1 + 4 = 10
    // raw_slope = 11.0 / 10 = 1.1
    // Normalized: (1.1 / 105) * 100 = 1.0476% per day
    const expected = (1.1 / 105) * 100;
    assert.ok(Math.abs(slope - expected) < 0.001, `OLS should calculate slope = ${expected.toFixed(4)}%/day`);
  });

  it('should match baseline parity vector', () => {
    // Parity test against momentum-ema20-parameterized.cjs
    // Test vector from actual backtest run
    const emaValues = [3500, 3520, 3540, 3530, 3560];
    const slope = calculateEMA20Slope(emaValues);

    // Manual OLS calculation:
    // x = [0,1,2,3,4], mean_x = 2
    // y = [3500,3520,3540,3530,3560], mean_y = 3530
    // numerator = (-2*-30) + (-1*-10) + (0*10) + (1*0) + (2*30)
    //           = 60 + 10 + 0 + 0 + 60 = 130
    // denominator = 4 + 1 + 0 + 1 + 4 = 10
    // raw_slope = 130 / 10 = 13.0
    // Normalized: (13.0 / 3560) * 100 = 0.3652% per day
    const rawSlope = 13.0;
    const expected = (rawSlope / 3560) * 100;

    assert.ok(Math.abs(slope - expected) < 0.001, `Baseline parity: expected ${expected.toFixed(4)}%/day, got ${slope.toFixed(4)}`);

    // Verify this crosses the 0.3%/day threshold used in baseline
    assert.ok(Math.abs(slope) > 0.3, 'Should exceed baseline threshold of 0.3%/day');
  });
});
