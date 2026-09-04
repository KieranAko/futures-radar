import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { validateSemanticFacts, positionOf, firstActionWord } = require('../strategies/lib/semantic-fact-validate.cjs');

function rawFor(bars) {
  return {
    contracts: {
      SA0: {
        ohlcv: {
          dates: bars.map((b) => b.date),
          open: bars.map((b) => b.open),
          high: bars.map((b) => b.high),
          low: bars.map((b) => b.low),
          close: bars.map((b) => b.close)
        }
      }
    }
  };
}

function bar(date, high, low, close) {
  return { date, open: close, high, low, close };
}

const bars = [
  bar('2026-08-27', 1037, 1006, 1011),
  bar('2026-08-28', 1050, 1001, 1047),
  bar('2026-08-31', 1070, 1044, 1061),
  bar('2026-09-01', 1074, 1048, 1070),
  bar('2026-09-02', 1083, 1053, 1056),
  bar('2026-09-03', 1074, 1046, 1056)
];
const raw = rawFor(bars);
const reportModel = { opportunities: [{ symbol: 'SA0', marketFacts: { close: 1056 } }] };

describe('semantic-fact-validate 语义事实校验', () => {
  it('positionOf 正确判定价格相对价值区位置', () => {
    assert.equal(positionOf(1056, 1053, 1074), 'inside');
    assert.equal(positionOf(1080, 1053, 1074), 'above');
    assert.equal(positionOf(1040, 1053, 1074), 'below');
  });

  it('firstActionWord 识别触发文案首动作词', () => {
    assert.equal(firstActionWord('回踩 1053–1074 且站稳'), 'pullback');
    assert.equal(firstActionWord('放量突破 1083'), 'breakout');
    assert.equal(firstActionWord('价格处于区间内，放量站稳确认'), 'confirmation');
  });

  it('inside 位置用 pullback 表达触发文案含回踩 → 报错', () => {
    const reasoning = { strategies: [{ symbol: 'SA0', direction: 'bullish', expression: { type: 'pullback' }, entry: { trigger: '回踩 1053–1074 且站稳' } }] };
    const out = validateSemanticFacts(reasoning, reportModel, raw);
    assert.equal(out.ok, false);
    assert.ok(out.errors.some((e) => e.includes('表达类型 pullback 不匹配')));
  });

  it('inside 位置用 confirmation 表达且文案为确认 → 通过', () => {
    const reasoning = { strategies: [{ symbol: 'SA0', direction: 'bullish', expression: { type: 'confirmation' }, entry: { trigger: '价格处于 1053–1074 区间内，放量站稳确认' } }] };
    const out = validateSemanticFacts(reasoning, reportModel, raw);
    assert.equal(out.ok, true);
  });

  it('conditional-watch 总是通过', () => {
    const reasoning = { strategies: [{ symbol: 'SA0', direction: 'bullish', expression: { type: 'conditional-watch' }, entry: { trigger: '等待放量突破 1083' } }] };
    const out = validateSemanticFacts(reasoning, reportModel, raw);
    assert.equal(out.ok, true);
  });
});
