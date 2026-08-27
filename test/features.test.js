import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateHV20Percentile,
  calculateER20,
  calculateATR5Percentile,
  calculateVEC
} from '../lib/features.js';

describe('HV20 Percentile', () => {
  it('should calculate 90 rolling windows from 110 prices', () => {
    const prices = Array(110).fill(100);
    const result = calculateHV20Percentile(prices);

    assert.ok(result.hv90d, 'Should return hv90d array');
    assert.equal(result.hv90d.length, 90, 'Should have 90 windows');
    assert.equal(result.hvCurrent, 0, 'Flat prices should have HV=0');
    assert.equal(result.percentile, 100, 'Flat prices percentile should be 100');
  });

  it('should use current HV as last rolling window', () => {
    const prices = Array(110).fill(0).map((_, i) => 100 + i * 0.1);
    const result = calculateHV20Percentile(prices);

    // Current window is last 21 prices: prices[89:110]
    const lastWindow = prices.slice(89, 110);
    assert.equal(lastWindow.length, 21, 'Last window should have 21 prices');

    // Current HV should be calculated from this window
    assert.ok(result.hvCurrent > 0, 'Trending prices should have HV>0');
  });

  it('should handle percentile ties with <= comparison', () => {
    const prices = Array(110).fill(100);
    const result = calculateHV20Percentile(prices);

    // All HV values are 0, current is also 0
    // sum(hv <= 0 for hv in hv90d) / 90 * 100 = 90/90 * 100 = 100
    assert.equal(result.percentile, 100, 'All zeros should give percentile 100');
  });

  it('should require exactly 110 prices', () => {
    assert.throws(() => {
      calculateHV20Percentile(Array(109).fill(100));
    }, /requires 110 prices/);

    assert.throws(() => {
      calculateHV20Percentile(Array(111).fill(100));
    }, /requires 110 prices/);
  });
});

describe('ER20', () => {
  it('should calculate from 21 prices (20 intervals)', () => {
    const prices = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110,
                    111, 112, 113, 114, 115, 116, 117, 118, 119, 120];
    const result = calculateER20(prices);

    // net = abs(120 - 100) = 20
    // sum of daily changes = 20 (each change is 1)
    // ER20 = 20 / 20 = 1.0
    assert.equal(result, 1.0, 'Perfect trend should have ER=1.0');
  });

  it('should return 0 for zero daily changes', () => {
    const prices = Array(21).fill(100);
    const result = calculateER20(prices);

    assert.equal(result, 0, 'Flat prices should have ER=0');
  });

  it('should require exactly 21 prices', () => {
    assert.throws(() => {
      calculateER20(Array(20).fill(100));
    }, /requires 21 prices/);
  });
});

describe('ATR5 Percentile', () => {
  it('should calculate 90 rolling windows from 95 bars', () => {
    const high = Array(95).fill(102);
    const low = Array(95).fill(98);
    const close = Array(95).fill(100);

    const result = calculateATR5Percentile(high, low, close);

    assert.ok(result.atr90dPct, 'Should return atr90dPct array');
    assert.equal(result.atr90dPct.length, 90, 'Should have 90 windows');
  });

  it('should use endpoints 5..94 for rolling windows', () => {
    const high = Array(95).fill(102);
    const low = Array(95).fill(98);
    const close = Array(95).fill(100);

    const result = calculateATR5Percentile(high, low, close);

    // Endpoint 5 uses bars 1..5 (5 TRs)
    // Endpoint 94 uses bars 90..94 (5 TRs)
    // Total: 90 windows (endpoints 5 through 94)
    assert.equal(result.atr90dPct.length, 90);
  });

  it('should use current ATR5 as last rolling window', () => {
    const high = Array(95).fill(102);
    const low = Array(95).fill(98);
    const close = Array(95).fill(100);

    const result = calculateATR5Percentile(high, low, close);

    // Current ATR5% should be from bars 90..94 (endpoint 94)
    assert.ok(result.atr5CurrentPct > 0);
  });

  it('should require exactly 95 bars', () => {
    const high = Array(94).fill(102);
    const low = Array(94).fill(98);
    const close = Array(94).fill(100);

    assert.throws(() => {
      calculateATR5Percentile(high, low, close);
    }, /requires 95 bars/);
  });

  it('should have valid prev close for all TR calculations', () => {
    const high = Array(95).fill(102);
    const low = Array(95).fill(98);
    const close = Array(95).fill(100);

    // Should not throw - all TRs have valid prev close
    const result = calculateATR5Percentile(high, low, close);
    assert.ok(result);
  });
});

describe('VEC Score', () => {
  it('should multiply HV percentile by ER20', () => {
    const prices = Array(110).fill(100);
    const result = calculateVEC(prices);

    // HV percentile = 100, ER20 = 0
    // VEC = 100 * 0 = 0
    assert.equal(result, 0);
  });
});
