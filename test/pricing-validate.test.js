import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { validatePricing } = require('../strategies/lib/pricing-validate.cjs');

const reportModel = {
  opportunities: [
    { symbol: 'SA0', marketFacts: { close: 1056 }, priceRanges: [{ atrBand: { atr5: 31.8 } }] }
  ]
};
const probability = { probabilities: [{ symbol: 'SA0' }] };

function reasoningWith(strategy) {
  return { strategies: [strategy] };
}

describe('pricing-validate 交易定价硬校验', () => {
  it('conditional-watch 可豁免入场/止损/RR 硬校验', () => {
    const r = reasoningWith({
      symbol: 'SA0',
      expression: { type: 'conditional-watch' },
      entry: { triggerLevel: 1083 },
      stop: { stopPrice: 1027.8 },
      targets: { t1: '1085.0' }
    });
    const out = validatePricing(r, reportModel, probability);
    assert.equal(out.ok, true);
  });

  it('非 conditional 且入场距离 >1×ATR 报错', () => {
    const r = reasoningWith({
      symbol: 'SA0',
      expression: { type: 'pullback' },
      entry: { triggerLevel: 1000 },
      stop: { stopPrice: 980 },
      targets: { t1: '1083' }
    });
    const out = validatePricing(r, reportModel, probability);
    assert.equal(out.ok, false);
    assert.ok(out.errors.some((e) => e.includes('入场距离')));
  });

  it('止损距离 >1.5×ATR 报错', () => {
    const r = reasoningWith({
      symbol: 'SA0',
      expression: { type: 'breakout' },
      entry: { triggerLevel: 1083 },
      stop: { stopPrice: 1001 },
      targets: { t1: '1200' }
    });
    const out = validatePricing(r, reportModel, probability);
    assert.equal(out.ok, false);
    assert.ok(out.errors.some((e) => e.includes('止损距离')));
  });

  it('R/R <1.5 报错', () => {
    const r = reasoningWith({
      symbol: 'SA0',
      expression: { type: 'breakout' },
      entry: { triggerLevel: 1056 },
      stop: { stopPrice: 1024 },
      targets: { t1: '1083' }
    });
    const out = validatePricing(r, reportModel, probability);
    assert.equal(out.ok, false);
    assert.ok(out.errors.some((e) => e.includes('盈亏比')));
  });
});
