/**
 * Opportunity Feature Tests
 *
 * Validates ER20 calculation, window construction, T-day truncation,
 * and flat price handling semantics.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { calculateER } from '../experiments/lib/opportunity-features.js';
import { calculateER20 } from '../lib/features.js';

describe('Opportunity Features - ER20', () => {
  it('should match production calculateER20 on normal prices', () => {
    // 21 prices for calculateER20 (T-20 to T)
    const prices = [
      100, 102, 101, 103, 105, 107, 106, 108, 110, 109,
      111, 113, 112, 114, 116, 115, 117, 119, 118, 120, 122
    ];

    const productionER = calculateER20(prices);

    // calculateER expects full history, uses slice(-21)
    const experimentER = calculateER(prices, 20);

    assert.strictEqual(
      experimentER,
      productionER,
      `Experiment ER (${experimentER}) should match production ER (${productionER})`
    );
  });

  it('should handle flat prices consistently', () => {
    const flatPrices = Array(21).fill(100);

    // Production returns 0 for flat prices
    const productionER = calculateER20(flatPrices);
    assert.strictEqual(productionER, 0, 'Production ER20 should return 0 for flat prices');

    // Experiment now returns 0 for flat prices (fixed to match production)
    const experimentER = calculateER(flatPrices, 20);
    assert.strictEqual(experimentER, 0, 'Experiment ER should return 0 for flat prices (matches production)');

    console.log('✓ Semantic consistency verified: both return 0 for flat prices');
  });

  it('should return 0 for choppy range-bound prices', () => {
    // Up-down-up-down pattern, net change near zero
    const choppyPrices = [
      100, 101, 100, 101, 100, 101, 100, 101, 100, 101,
      100, 101, 100, 101, 100, 101, 100, 101, 100, 101, 100
    ];

    const er = calculateER(choppyPrices, 20);

    // Net change = 0, sum of changes = 20
    assert.strictEqual(er, 0, 'Choppy prices with zero net change should return ER=0');
  });

  it('should return ~1.0 for strong trending prices', () => {
    // Pure uptrend: +1 every day
    const trendPrices = [];
    for (let i = 0; i <= 20; i++) {
      trendPrices.push(100 + i);
    }

    const er = calculateER(trendPrices, 20);

    // Net change = 20, sum of changes = 20
    assert.strictEqual(er, 1.0, 'Pure trend should return ER=1.0');
  });

  it('should handle insufficient data', () => {
    const shortPrices = [100, 101, 102]; // Only 3 prices

    const er = calculateER(shortPrices, 20);
    assert.strictEqual(er, null, 'Should return null when data length < period + 1');
  });

  it('should use correct window (last 21 prices)', () => {
    // 30 prices, ER should only use last 21
    const prices = [];
    for (let i = 0; i < 30; i++) {
      prices.push(100 + i);
    }

    const er = calculateER(prices, 20);

    // Last 21 prices: 109, 110, ..., 129
    // Net change = 129 - 109 = 20
    // Sum of changes = 20 * 1 = 20
    assert.strictEqual(er, 1.0, 'Should use last 21 prices only');
  });

  it('should calculate ER for decreasing prices', () => {
    // Pure downtrend: -1 every day
    const downPrices = [];
    for (let i = 0; i <= 20; i++) {
      downPrices.push(120 - i);
    }

    const er = calculateER(downPrices, 20);

    // Net change = abs(100 - 120) = 20
    // Sum of changes = 20 * 1 = 20
    assert.strictEqual(er, 1.0, 'Direction-agnostic: downtrend should also return ER=1.0');
  });

  it('should handle mixed trend with noise', () => {
    const noisyTrend = [
      100, 102, 101, 103, 102, 104, 103, 105, 104, 106,
      105, 107, 106, 108, 107, 109, 108, 110, 109, 111, 110
    ];

    const er = calculateER(noisyTrend, 20);

    // Net change = abs(110 - 100) = 10
    // Sum of changes = 2*20 - (sum of backtracks) ≈ 30
    // ER ≈ 10/30 = 0.33

    assert.ok(er > 0.2 && er < 0.5, `Noisy trend should return moderate ER (got ${er})`);
  });
});

describe('Opportunity Features - Semantic Consistency', () => {
  it('should match production calculateER20 for flat prices', () => {
    const flatPrices = Array(21).fill(100);

    const productionER = calculateER20(flatPrices);
    const experimentER = calculateER(flatPrices, 20);

    assert.strictEqual(
      experimentER,
      productionER,
      `Experiment ER (${experimentER}) should match production ER (${productionER}) for flat prices`
    );
    assert.strictEqual(experimentER, 0, 'Both should return 0 for flat prices');
  });
});
