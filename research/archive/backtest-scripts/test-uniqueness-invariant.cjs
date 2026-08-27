#!/usr/bin/env node
/**
 * test-uniqueness-invariant.cjs — 補抽唯一性不变量测试
 *
 * 测试：
 * 1. attemptedSymbols 在每次 try (成功或失败) 前增长
 * 2. 失败候选不会被重复尝试
 * 3. 候选池耗尽时正确触发 coverage failure
 * 4. 跨日期同一品种可重复使用（不违反 per-run 唯一性）
 *
 * 本测试不断言任何 p-value。
 */

const assert = require('assert');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS: ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL: ${name}`);
    console.log(`    ${e.message}`);
  }
}

// ─── Test 1: attemptedSymbols records failures ─────

test('attemptedSymbols records failed retry candidates', () => {
  // Simulate the 補抽 logic from V3.1
  const attemptedSymbols = new Set();
  const candidates = ['A', 'B', 'C', 'D'];
  const selected = candidates.slice(0, 2); // ['A', 'B']

  // Mock: A succeeds, B and all backups fail
  const succeedMap = { 'A': true, 'B': false, 'C': false, 'D': false };
  const mockExecute = (sym) => succeedMap[sym] ? { symbol: sym } : null;

  const trades = [];
  let coverageFailed = false;

  for (const s of selected) {
    // Primary selection uniqueness check
    assert(!attemptedSymbols.has(s), `primary duplicate: ${s}`);
    attemptedSymbols.add(s);

    const trade = mockExecute(s);
    if (!trade) {
      let found = false;
      for (let j = 2; j < candidates.length; j++) {
        if (attemptedSymbols.has(candidates[j])) continue;
        attemptedSymbols.add(candidates[j]); // mark BEFORE attempt
        const retry = mockExecute(candidates[j]);
        if (retry) {
          trades.push(retry);
          found = true;
          break;
        }
        // failed retry stays in attemptedSymbols
      }
      if (!found) { coverageFailed = true; break; }
    } else {
      trades.push(trade);
    }
  }

  // Verify: all 4 symbols were attempted
  assert.equal(attemptedSymbols.size, 4, `Expected 4 attempted, got ${attemptedSymbols.size}`);
  assert(attemptedSymbols.has('A'), 'A should be attempted');
  assert(attemptedSymbols.has('B'), 'B should be attempted');
  assert(attemptedSymbols.has('C'), 'C should be attempted (failed retry)');
  assert(attemptedSymbols.has('D'), 'D should be attempted (failed retry)');
  assert(coverageFailed, 'Should trigger coverage failure when all fail');

  // Verify A succeeded and was traded
  assert.equal(trades.length, 1, `Expected 1 trade, got ${trades.length}`);
  assert.equal(trades[0].symbol, 'A');
});

// ─── Test 2: Failed candidate NOT retried ─────

test('failed retry candidate is NOT re-attempted at next position', () => {
  // B's primary attempt fails. C is tried as retry, also fails.
  // D is tried next — should NOT try C again (it's in attemptedSymbols).
  const attemptedSymbols = new Set();
  const candidates = ['A', 'B', 'C', 'D', 'E'];
  const selected = candidates.slice(0, 2); // ['A', 'B']

  // Only D succeeds as retry
  const succeedMap = { 'A': true, 'B': false, 'C': false, 'D': true, 'E': true };
  const mockExecute = (sym) => succeedMap[sym] ? { symbol: sym } : null;
  const attemptLog = [];

  const trades = [];

  for (const s of selected) {
    attemptedSymbols.add(s);
    attemptLog.push(`primary:${s}`);

    const trade = mockExecute(s);
    if (!trade) {
      let found = false;
      for (let j = 2; j < candidates.length; j++) {
        if (attemptedSymbols.has(candidates[j])) continue;
        attemptedSymbols.add(candidates[j]);
        attemptLog.push(`retry:${candidates[j]}`);
        const retry = mockExecute(candidates[j]);
        if (retry) {
          trades.push(retry);
          found = true;
          break;
        }
      }
      if (!found) break;
    } else {
      trades.push(trade);
    }
  }

  // B fails → try C (fails) → try D (succeeds)
  // C should appear exactly once in attemptLog
  const cCount = attemptLog.filter(e => e === 'retry:C').length;
  assert.equal(cCount, 1, `C should be attempted exactly once, got ${cCount}. Log: ${attemptLog.join(', ')}`);

  // Verify D was the retry that succeeded
  assert.equal(trades.length, 2);
  assert.equal(trades[0].symbol, 'A');
  assert.equal(trades[1].symbol, 'D');
});

// ─── Test 3: Scrambled input still respects uniqueness ──

test('shuffled candidates with duplicates in pool are caught', () => {
  // If the candidate pool has duplicate symbols (shouldn't happen in real data,
  // but test the defensive check), the uniqueness invariant should catch it.
  const attemptedSymbols = new Set();
  const candidates = ['A', 'A', 'B', 'C']; // Duplicate A!
  const selected = candidates.slice(0, 2); // ['A', 'A']

  const succeedMap = { 'A': true };
  const mockExecute = (sym) => succeedMap[sym] ? { symbol: sym } : null;

  let uniquenessViolation = false;

  for (const s of selected) {
    if (attemptedSymbols.has(s)) {
      uniquenessViolation = true;
      break;
    }
    attemptedSymbols.add(s);
    // ... execute (won't get here because duplicate triggers break)
  }

  assert(uniquenessViolation, 'Should detect duplicate in primary selection');
});

// ─── Test 4: Per-run scope — same symbol allowed across runs ──

test('same symbol allowed across different runs (per-run scope)', () => {
  // Run 1: symbol A used
  const run1Attempted = new Set();
  run1Attempted.add('A');
  assert(run1Attempted.has('A'));

  // Run 2: NEW attemptedSymbols, symbol A is fresh
  const run2Attempted = new Set();
  assert(!run2Attempted.has('A'), 'New run should have fresh set');
  run2Attempted.add('A');
  assert(run2Attempted.has('A'));
});

// ─── Test 5: Coverage failure when retry pool is empty ──

test('coverage failure when all retry candidates exhausted', () => {
  const attemptedSymbols = new Set();
  const candidates = ['A', 'B'];
  const selected = ['A'];
  const succeedMap = { 'A': false, 'B': false };
  const mockExecute = (sym) => succeedMap[sym] ? { symbol: sym } : null;

  const trades = [];
  let coverageFailed = false;

  for (const s of selected) {
    attemptedSymbols.add(s);
    const trade = mockExecute(s);
    if (!trade) {
      let found = false;
      for (let j = 1; j < candidates.length; j++) {
        if (attemptedSymbols.has(candidates[j])) continue;
        attemptedSymbols.add(candidates[j]);
        const retry = mockExecute(candidates[j]);
        if (retry) { trades.push(retry); found = true; break; }
      }
      if (!found) { coverageFailed = true; break; }
    } else {
      trades.push(trade);
    }
  }

  assert(coverageFailed, 'Should trigger coverage failure when all exhausted');
  assert.equal(trades.length, 0, 'No trades should succeed');
  assert.equal(attemptedSymbols.size, 2, 'Both candidates attempted');
});

// ─── Summary ──

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
