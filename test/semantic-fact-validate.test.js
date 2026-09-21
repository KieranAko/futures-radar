import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { validateSemanticFacts, validateQ4Semantics, positionOf } = require('../analysis/strategy/semantic-fact-validate.cjs');

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

describe('semantic-fact-validate 语义事实校验（权威错位修复后）', () => {
  it('positionOf 正确判定价格相对价值区位置（数值事实，保留）', () => {
    assert.equal(positionOf(1056, 1053, 1074), 'inside');
    assert.equal(positionOf(1080, 1053, 1074), 'above');
    assert.equal(positionOf(1040, 1053, 1074), 'below');
  });

  it('不再用决策表替 LLM 判定表达类型：inside+pullback 也放行，只回传位置事实', () => {
    const reasoning = { strategies: [{ symbol: 'SA0', direction: 'bullish', expression: { type: 'pullback' }, entry: { trigger: '回踩 1053–1074 且站稳' } }] };
    const out = validateSemanticFacts(reasoning, reportModel, raw);
    assert.equal(out.ok, true);
    assert.equal(out.checks[0].position, 'inside');
  });

  it('缺少 report/raw 上下文仍 fail-closed（结构校验）', () => {
    const reasoning = { strategies: [{ symbol: 'SA0', expression: { type: 'confirmation' } }] };
    const out = validateSemanticFacts(reasoning, { opportunities: [] }, raw);
    assert.equal(out.ok, false);
    assert.ok(out.errors.some((e) => e.includes('缺少 report/raw 上下文')));
  });

  it('Q4 校验只做上下文可用性检查，不再用正则判定“回踩”语义', () => {
    const outputs = { results: [{ symbol: 'SA0', direction: 'long', q4_confirmations: { signals: ['回踩 1053–1074 且站稳'] } }] };
    const packets = {
      SA0: {
        price_data: { close: 1056 },
        near_term: { valueAreaLow: 1053, valueAreaHigh: 1074 }
      }
    };
    assert.equal(validateQ4Semantics(outputs, packets).ok, true);
    const badPackets = { SA0: { price_data: { close: 1056 } } };
    const out = validateQ4Semantics(outputs, badPackets);
    assert.equal(out.ok, false);
    assert.ok(out.errors.some((e) => e.includes('缺少 near_term/price_data')));
  });
});
