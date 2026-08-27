/**
 * Test Suite for HV Estimators and Probability Cone
 *
 * Assertion-based tests with fixed fixtures
 */

import { yangZhangVolatility, garmanKlassVolatility, closeToCloseVolatility, autoEstimateHV, hvPercentile } from './hv-estimators.js';
import { probabilityCone, compareBands, generateProbabilityAnalysis } from './probability-cone.js';
import assert from 'node:assert';

/**
 * Test Case 1: Yang-Zhang with synthetic data
 */
function testYangZhang() {
  console.log('=== Test 1: Yang-Zhang Volatility ===');

  // Synthetic OHLC data (21 days for 20-day window)
  const ohlc = [
    { open: 100, high: 102, low: 99, close: 101 },
    { open: 101, high: 103, low: 100, close: 102 },
    { open: 102, high: 104, low: 101, close: 103 },
    { open: 103, high: 105, low: 102, close: 104 },
    { open: 104, high: 106, low: 103, close: 105 },
    { open: 105, high: 107, low: 104, close: 106 },
    { open: 106, high: 108, low: 105, close: 107 },
    { open: 107, high: 109, low: 106, close: 108 },
    { open: 108, high: 110, low: 107, close: 109 },
    { open: 109, high: 111, low: 108, close: 110 },
    { open: 110, high: 112, low: 109, close: 111 },
    { open: 111, high: 113, low: 110, close: 112 },
    { open: 112, high: 114, low: 111, close: 113 },
    { open: 113, high: 115, low: 112, close: 114 },
    { open: 114, high: 116, low: 113, close: 115 },
    { open: 115, high: 117, low: 114, close: 116 },
    { open: 116, high: 118, low: 115, close: 117 },
    { open: 117, high: 119, low: 116, close: 118 },
    { open: 118, high: 120, low: 117, close: 119 },
    { open: 119, high: 121, low: 118, close: 120 },
    { open: 120, high: 122, low: 119, close: 121 }
  ];

  const result = yangZhangVolatility(ohlc, 20);
  console.log(`Yang-Zhang HV (20d): ${(result.hv * 100).toFixed(2)}%`);

  // Assert: steady uptrend should produce HV in 15-30% range
  assert(result.hv >= 0.15 && result.hv <= 0.30, `Expected HV in [0.15, 0.30], got ${result.hv}`);
  console.log('✅ Assertion passed: HV in expected range [15%, 30%]\n');
}

/**
 * Test Case 2: Garman-Klass fallback
 */
function testGarmanKlass() {
  console.log('=== Test 2: Garman-Klass Volatility (fallback) ===');

  // HLC data (missing Open)
  const hlc = Array.from({ length: 21 }, (_, i) => ({
    high: 100 + i + 2,
    low: 100 + i - 1,
    close: 100 + i + 1
  }));

  const hv = garmanKlassVolatility(hlc, 20);
  console.log(`Garman-Klass HV (20d): ${(hv * 100).toFixed(2)}%`);

  // Assert: should be in similar range to Yang-Zhang
  assert(hv >= 0.15 && hv <= 0.35, `Expected HV in [0.15, 0.35], got ${hv}`);
  console.log('✅ Assertion passed: HV in expected range [15%, 35%]\n');
}

/**
 * Test Case 3: Close-to-Close minimal fallback
 */
function testCloseToClose() {
  console.log('=== Test 3: Close-to-Close Volatility (minimal fallback) ===');

  const closes = Array.from({ length: 21 }, (_, i) => 100 + i);
  const hv = closeToCloseVolatility(closes, 20);
  console.log(`Close-to-Close HV (20d): ${(hv * 100).toFixed(2)}%`);

  // Assert: pure linear trend should have very low HV
  assert(hv >= 0 && hv <= 0.05, `Expected HV near 0 for linear trend, got ${hv}`);
  console.log('✅ Assertion passed: HV near 0 for linear trend\n');
}

/**
 * Test Case 4: Probability Cone calculation
 */
function testProbabilityCone() {
  console.log('=== Test 4: Probability Cone (Closed-form) ===');

  const close = 568.2;
  const hvAnnual = 0.338;

  const cone = probabilityCone(close, hvAnnual, [3, 5], [1.0, 1.96]);

  console.log('SC0 Probability Cone:');
  console.log('3-day bands:');
  console.log(`  68% (1σ): [${cone['3d']['p68'][0]}, ${cone['3d']['p68'][1]}]`);
  console.log(`  95% (2σ): [${cone['3d']['p95'][0]}, ${cone['3d']['p95'][1]}]`);
  console.log('5-day bands:');
  console.log(`  68% (1σ): [${cone['5d']['p68'][0]}, ${cone['5d']['p68'][1]}]`);
  console.log(`  95% (2σ): [${cone['5d']['p95'][0]}, ${cone['5d']['p95'][1]}]`);

  // Assert: cone width should increase with days
  const width3d = cone['3d']['p95'][1] - cone['3d']['p95'][0];
  const width5d = cone['5d']['p95'][1] - cone['5d']['p95'][0];
  assert(width5d > width3d, `Expected 5d width > 3d width, got ${width5d} <= ${width3d}`);

  // Assert: bands should be symmetric around close (within 1% due to exponential)
  const mid3d = (cone['3d']['p95'][0] + cone['3d']['p95'][1]) / 2;
  const symmetryError = Math.abs(mid3d - close) / close;
  assert(symmetryError < 0.01, `Expected symmetric bands, got ${symmetryError * 100}% error`);

  console.log('✅ Assertion passed: 5d wider than 3d, bands symmetric\n');
}

/**
 * Test Case 5: ATR vs HV comparison
 */
function testBandComparison() {
  console.log('=== Test 5: ATR vs HV Band Comparison ===');

  const close = 568.2;
  const atr5 = 32.8;
  const atrBand = [close - 2 * atr5, close + 2 * atr5];

  const hvAnnual = 0.338;
  const cone = probabilityCone(close, hvAnnual, [3], [1.96]);
  const hvBand = cone['3d']['p95'];

  const comparison = compareBands(atrBand, hvBand);

  console.log(`ATR 2× Band: [${atrBand[0].toFixed(1)}, ${atrBand[1].toFixed(1)}]`);
  console.log(`HV 95% Band: [${hvBand[0]}, ${hvBand[1]}]`);
  console.log(`Divergence: ${comparison.divergencePct}%`);
  console.log(`Interpretation: ${comparison.interpretation}`);

  // Assert: divergence should be a valid percentage
  assert(comparison.divergencePct >= 0 && comparison.divergencePct < 200,
    `Expected divergence in [0, 200], got ${comparison.divergencePct}`);

  // Assert: interpretation should be one of three valid strings
  const validInterpretations = [
    '两种方法区间基本一致，波动率模型稳定 ✅',
    '两种方法区间存在差异，波动率结构可能变化 ⚠️',
    '两种方法区间严重背离，波动率模型不稳定 ❌'
  ];
  assert(validInterpretations.includes(comparison.interpretation),
    `Invalid interpretation: ${comparison.interpretation}`);

  console.log('✅ Assertion passed: valid divergence and interpretation\n');
}

/**
 * Test Case 6: Auto-estimator selection
 */
function testAutoEstimator() {
  console.log('=== Test 6: Auto-Estimator Selection ===');

  const fullOHLC = Array.from({ length: 21 }, (_, i) => ({
    open: 100 + i,
    high: 100 + i + 2,
    low: 100 + i - 1,
    close: 100 + i + 1
  }));

  const result1 = autoEstimateHV(fullOHLC, 20);
  console.log(`Full OHLC → ${result1.estimator}: ${(result1.hv * 100).toFixed(2)}%`);
  assert(result1.estimator === 'yang_zhang', `Expected yang_zhang, got ${result1.estimator}`);

  // Missing Open
  const missingOpen = fullOHLC.map(({ high, low, close }) => ({ high, low, close }));
  const result2 = autoEstimateHV(missingOpen, 20);
  console.log(`Missing Open → ${result2.estimator}: ${(result2.hv * 100).toFixed(2)}%`);
  assert(result2.estimator === 'garman_klass', `Expected garman_klass, got ${result2.estimator}`);

  // Only Close
  const onlyClose = fullOHLC.map(({ close }) => ({ close }));
  const result3 = autoEstimateHV(onlyClose, 20);
  console.log(`Only Close → ${result3.estimator}: ${(result3.hv * 100).toFixed(2)}%`);
  assert(result3.estimator === 'close_to_close', `Expected close_to_close, got ${result3.estimator}`);

  console.log('✅ Assertion passed: correct estimator selection\n');
}

/**
 * Test Case 8: Real SC0 data with corrections (P1 verification)
 */
function testRealSC0WithCorrections() {
  console.log('=== Test 8: Real SC0 Data (20260730-1701-auto) ===');

  // Real SC0 OHLC from data/futures-radar/runs/20260730-1701-auto/raw.json
  // Last 21 bars (2026-07-02 to 2026-07-30) for 20-day Yang-Zhang HV
  // Extracted directly from raw.json - no synthetic bars, actual market data
  const realSC0 = [
    { date: '2026-07-02', open: 447.9, high: 451.7, low: 432.3, close: 434.3 },
    { date: '2026-07-03', open: 433.7, high: 445.4, low: 433.4, close: 441.3 },
    { date: '2026-07-06', open: 436.6, high: 441.5, low: 432.8, close: 438.6 },
    { date: '2026-07-07', open: 436.6, high: 443.5, low: 435.7, close: 443.0 },
    { date: '2026-07-08', open: 441.4, high: 468.3, low: 440.6, close: 466.8 },
    { date: '2026-07-09', open: 472.3, high: 493.7, low: 467.2, close: 473.6 },
    { date: '2026-07-10', open: 481.6, high: 484.0, low: 466.2, close: 471.2 },
    { date: '2026-07-13', open: 470.0, high: 489.7, low: 462.1, close: 482.6 },
    { date: '2026-07-14', open: 483.5, high: 520.7, low: 477.8, close: 519.4 },
    { date: '2026-07-15', open: 522.0, high: 524.6, low: 508.7, close: 521.1 },
    { date: '2026-07-16', open: 518.6, high: 522.2, low: 511.2, close: 514.7 },
    { date: '2026-07-17', open: 522.5, high: 526.2, low: 502.1, close: 510.5 },
    { date: '2026-07-20', open: 521.0, high: 555.0, low: 520.4, close: 548.4 },
    { date: '2026-07-21', open: 537.5, high: 537.5, low: 524.7, close: 531.0 },
    { date: '2026-07-22', open: 543.1, high: 559.9, low: 542.2, close: 559.4 },
    { date: '2026-07-23', open: 564.9, high: 573.4, low: 554.2, close: 573.0 },
    { date: '2026-07-24', open: 583.1, high: 606.2, low: 580.5, close: 589.4 },
    { date: '2026-07-27', open: 580.0, high: 585.6, low: 540.5, close: 542.1 },
    { date: '2026-07-28', open: 545.7, high: 549.8, low: 527.5, close: 532.7 },
    { date: '2026-07-29', open: 531.5, high: 553.8, low: 519.4, close: 544.2 },
    { date: '2026-07-30', open: 560.0, high: 569.4, low: 547.1, close: 568.2 }
  ];

  const result = yangZhangVolatility(realSC0, 20, { autoCorrect: true });

  console.log(`Yang-Zhang HV: ${(result.hv * 100).toFixed(2)}%`);
  console.log(`Corrections made: ${result.correctionCount}`);
  console.log(`Degraded: ${result.degraded}`);
  console.log(`Latest close (from raw.json): ${realSC0[realSC0.length - 1].close}`);

  // Assert: Real SC0 data from raw.json should have 0 violations (data is clean)
  assert(result.correctionCount === 0, `Expected 0 corrections for clean raw.json data, got ${result.correctionCount}`);

  // Assert: HV should match Stage 4.5 output (47.8% from probability.json)
  const hvPercent = result.hv * 100;
  assert(hvPercent >= 47.0 && hvPercent <= 49.0, `Expected HV ~47.8%, got ${hvPercent.toFixed(2)}%`);

  // Assert: Should NOT be degraded (no corrections)
  assert(result.degraded === false, `Expected degraded=false (no corrections), got ${result.degraded}`);

  // Assert: Latest close matches raw.json (568.2)
  const latestClose = realSC0[realSC0.length - 1].close;
  assert(latestClose === 568.2, `Expected latest close=568.2 from raw.json, got ${latestClose}`);

  console.log('✅ Assertion passed: Real SC0 data from raw.json (20260730-1701-auto)\n');
}

/**
 * Test Case 9: Auto-correction disabled should fail
 */
function testAutoCorrectionDisabled() {
  console.log('=== Test 9: Auto-Correction Disabled ===');

  const invalidOHLC = [
    { open: 100, high: 99, low: 98, close: 99 } // high < open
  ].concat(Array(20).fill({ open: 100, high: 102, low: 99, close: 101 }));

  try {
    yangZhangVolatility(invalidOHLC, 20, { autoCorrect: false });
    assert.fail('Expected validation error when autoCorrect=false');
  } catch (err) {
    assert(err.message.includes('OHLC validation failed'), `Wrong error: ${err.message}`);
    console.log('✅ Auto-correction disabled correctly rejects invalid data\n');
  }
}

/**
 * Run all tests
 */
function runAllTests() {
  console.log('╔═══════════════════════════════════════════════════════╗');
  console.log('║   HV Estimators & Probability Cone Test Suite        ║');
  console.log('╚═══════════════════════════════════════════════════════╝\n');

  try {
    testYangZhang();
    testGarmanKlass();
    testCloseToClose();
    testProbabilityCone();
    testBandComparison();
    testAutoEstimator();
    testRealSC0WithCorrections();
    testAutoCorrectionDisabled();

    console.log('✅ All tests passed!\n');
    console.log('Next steps:');
    console.log('1. Submit to 砚砚 for third review');
    console.log('2. After approval, integrate into Stage 4.5 pipeline');
    console.log('3. Test with real SC0/EG0/M0 data from raw.json');
  } catch (err) {
    console.error('❌ Test failed:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

// Export for manual execution
export { runAllTests };

// Run tests if executed directly
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
  runAllTests();
}
