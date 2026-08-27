/**
 * LLM Outcome Test
 * 验证 reasoning 方向 → T+1 open / T+11 close outcome，复用共享 entry/exit/cost 真相源
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');
const { scoreReasoningOutcome } = require('../llm-outcome.cjs');
const { calculateCosts, simulateEntry, simulateExit } = require('../shared-backtest-lib.cjs');

const SYMBOL = 'RB0';
// dates[5] = '2026-06-06'（makeMatureRaw 的 30 日数组内）
const SIGNAL_DATE = '2026-06-06';

// 构造 30 个交易日，signalIdx=5 → entryIdx=6 → exitIdx=16
function makeRaw({ dates, open, close }) {
  return { contracts: { [SYMBOL]: { ohlcv: { dates, open, close } } } };
}

function makeMatureRaw({ openAt6 = 3100, closeAt16 = 3200, closeAt5 = 3090, dates = null, open = null, close = null } = {}) {
  const baseDates = Array.from({ length: 30 }, (_, i) => `2026-06-${String(1 + i).padStart(2, '0')}`);
  const datesArr = dates ?? baseDates;
  const openArr = open ?? Array.from({ length: 30 }, (_, i) => (i === 6 ? openAt6 : 3050));
  const closeArr = close ?? Array.from({ length: 30 }, (_, i) => {
    if (i === 5) return closeAt5;
    if (i === 16) return closeAt16;
    return 3050;
  });
  return makeRaw({ dates: datesArr, open: openArr, close: closeArr });
}

function result(direction) {
  return { direction, symbol: SYMBOL, signalDate: SIGNAL_DATE };
}

describe('scoreReasoningOutcome 方向矩阵', () => {
  test('long + 上涨 → 正 gross，扣一次成本', () => {
    const raw = makeMatureRaw({ openAt6: 3100, closeAt16: 3200 });
    const { outcome, scoringStatus } = scoreReasoningOutcome({
      result: result('long'),
      symbol: SYMBOL,
      signalDate: SIGNAL_DATE,
      raw
    });
    assert.strictEqual(scoringStatus, 'scored');
    assert.strictEqual(outcome.entryPrice, 3100);
    assert.strictEqual(outcome.exitPrice, 3200);
    const expectedGross = (3200 - 3100) / 3100;
    assert.ok(Math.abs(outcome.grossReturn - expectedGross) < 1e-12);
    assert.ok(Math.abs(outcome.cost - calculateCosts(3100, 3200)) < 1e-12);
    assert.ok(Math.abs(outcome.netReturn - (expectedGross - calculateCosts(3100, 3200))) < 1e-12);
    assert.ok(outcome.netReturn > 0);
  });

  test('long + 下跌 → 负', () => {
    const raw = makeMatureRaw({ openAt6: 3100, closeAt16: 3000 });
    const { outcome, scoringStatus } = scoreReasoningOutcome({
      result: result('long'),
      symbol: SYMBOL,
      signalDate: SIGNAL_DATE,
      raw
    });
    assert.strictEqual(scoringStatus, 'scored');
    assert.ok(outcome.netReturn < 0);
  });

  test('short + 下跌 → 正 gross，扣一次成本', () => {
    const raw = makeMatureRaw({ openAt6: 3100, closeAt16: 3000 });
    const { outcome, scoringStatus } = scoreReasoningOutcome({
      result: result('short'),
      symbol: SYMBOL,
      signalDate: SIGNAL_DATE,
      raw
    });
    assert.strictEqual(scoringStatus, 'scored');
    const expectedGross = -1 * ((3000 - 3100) / 3100);
    assert.ok(Math.abs(outcome.grossReturn - expectedGross) < 1e-12);
    assert.ok(Math.abs(outcome.netReturn - (expectedGross - calculateCosts(3100, 3000))) < 1e-12);
    assert.ok(outcome.netReturn > 0);
  });

  test('short + 上涨 → 负', () => {
    const raw = makeMatureRaw({ openAt6: 3100, closeAt16: 3200 });
    const { outcome, scoringStatus } = scoreReasoningOutcome({
      result: result('short'),
      symbol: SYMBOL,
      signalDate: SIGNAL_DATE,
      raw
    });
    assert.strictEqual(scoringStatus, 'scored');
    assert.ok(outcome.netReturn < 0);
  });

  test('pass → scoringStatus=pass，无 trade/netReturn，不混入 0 收益', () => {
    const raw = makeMatureRaw();
    const { outcome, scoringStatus } = scoreReasoningOutcome({
      result: result('pass'),
      symbol: SYMBOL,
      signalDate: SIGNAL_DATE,
      raw
    });
    assert.strictEqual(scoringStatus, 'pass');
    assert.strictEqual(outcome, null);
  });

  test('与共享 entry/exit 库内部一致（entryIdx/exitIdx 对齐）', () => {
    const raw = makeMatureRaw({ openAt6: 3100, closeAt16: 3200 });
    const entry = simulateEntry(SYMBOL, raw, SIGNAL_DATE);
    const exit = simulateExit(SYMBOL, raw, entry.entryIdx, 10);
    const { outcome } = scoreReasoningOutcome({
      result: result('long'),
      symbol: SYMBOL,
      signalDate: SIGNAL_DATE,
      raw
    });
    assert.strictEqual(outcome.entryDate, entry.entryDate);
    assert.strictEqual(outcome.entryPrice, entry.entryPrice);
    assert.strictEqual(outcome.exitDate, exit.exitDate);
    assert.strictEqual(outcome.exitPrice, exit.exitPrice);
  });
});

describe('scoreReasoningOutcome 边界', () => {
  test('跳空 ≥9.5% 无法入场 → entry_unavailable', () => {
    // close[5]=3090, open[6]=3400 → gap = 310/3090 ≈ 10% > 9.5%
    const raw = makeMatureRaw({ closeAt5: 3090, openAt6: 3400 });
    const { outcome, scoringStatus } = scoreReasoningOutcome({
      result: result('long'),
      symbol: SYMBOL,
      signalDate: SIGNAL_DATE,
      raw
    });
    assert.strictEqual(scoringStatus, 'entry_unavailable');
    assert.strictEqual(outcome, null);
  });

  test('T+11 数据不足 → outcome_immature', () => {
    const dates = Array.from({ length: 10 }, (_, i) => `2026-06-${String(1 + i).padStart(2, '0')}`);
    const open = Array.from({ length: 10 }, () => 3050);
    const close = Array.from({ length: 10 }, () => 3050);
    const raw = makeRaw({ dates, open, close });
    const { outcome, scoringStatus } = scoreReasoningOutcome({
      result: result('long'),
      symbol: SYMBOL,
      signalDate: SIGNAL_DATE,
      raw
    });
    assert.strictEqual(scoringStatus, 'outcome_immature');
    assert.strictEqual(outcome, null);
  });

  test('signalDate 不在数据中 → outcome_immature', () => {
    const raw = makeMatureRaw();
    const { scoringStatus } = scoreReasoningOutcome({
      result: result('long'),
      symbol: SYMBOL,
      signalDate: '2025-01-01',
      raw
    });
    assert.strictEqual(scoringStatus, 'outcome_immature');
  });

  test('非有限价格拒绝', () => {
    const raw = makeMatureRaw({ closeAt16: Infinity });
    assert.throws(
      () =>
        scoreReasoningOutcome({
          result: result('long'),
          symbol: SYMBOL,
          signalDate: SIGNAL_DATE,
          raw
        }),
      /finite/
    );
  });
});
