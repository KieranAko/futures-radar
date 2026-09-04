import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { computeNearTermStructure } = require('../strategies/lib/near-term-structure.cjs');

function bar(date, high, low, close) {
  return { date, open: close, high, low, close };
}

describe('near-term-structure 近端结构', () => {
  const bars = [
    bar('2026-08-27', 1037, 1006, 1011),
    bar('2026-08-28', 1050, 1001, 1047),
    bar('2026-08-31', 1070, 1044, 1061),
    bar('2026-09-01', 1074, 1048, 1070),
    bar('2026-09-02', 1083, 1053, 1056),
    bar('2026-09-03', 1074, 1046, 1056)
  ];

  it('计算 PDH/PDL、3日高低与价值区近似', () => {
    const s = computeNearTermStructure(bars, '2026-09-03');
    assert.equal(s.pdh, 1083);
    assert.equal(s.pdl, 1053);
    assert.equal(s.h3, 1083);
    assert.equal(s.l3, 1044);
    assert.ok(s.valueAreaHigh <= 1083);
    assert.ok(s.valueAreaLow >= 1044);
    assert.ok(s.atr5 > 0);
  });

  it('距离字段给出点数与 ATR 倍数', () => {
    const s = computeNearTermStructure(bars, '2026-09-03');
    assert.equal(s.distances.pdl.pts, 1053 - 1056);
    assert.ok(s.distances.pdl.atr < 0);
    assert.ok(Math.abs(s.distances.pdh.pts) <= s.atr5 * 2);
  });
});
