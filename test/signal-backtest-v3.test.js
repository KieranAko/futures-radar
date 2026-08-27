import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { makeSignalV3 } = require('../strategies/signal-backtest/runner-v3.cjs');
const { isBannedCombo } = require('../strategies/signal-backtest/runner.cjs');

const ROOT = path.resolve(__dirname, '..', 'strategies', 'signal-backtest');
const RECORDINGS = path.join(ROOT, 'recordings', 'v3');
const OUTPUT = path.join(ROOT, 'output');
const SYMBOLS = ['RB0', 'M0', 'SC0'];
const REGIMES = ['trend', 'range', 'transition', 'shock'];
const EDGES = ['trend_continuation', 'breakout', 'pullback', 'mean_reversion', 'range_fade'];
const FLAGS = ['trend_aligned', 'volume_confirmed', 'structure_clean', 'volatility_normal', 'event_risk'];

describe('signal-backtest v3 qualitative anchor recordings', () => {
  it('has 95 valid qualitative anchors per symbol, aligned with features, no banned combo', () => {
    const features = JSON.parse(fs.readFileSync(path.join(RECORDINGS, 'features.json'), 'utf8'));
    assert.equal(features.step, 5);
    for (const sym of SYMBOLS) {
      const p = path.join(RECORDINGS, `anchors-${sym}.json`);
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      assert.equal(j.step, 5);
      assert.equal(j.anchors.length, 95);
      const featDates = features.anchors[sym].map(f => f.date);
      assert.deepEqual(j.anchors.map(a => a.date), featDates);
      for (const [i, a] of j.anchors.entries()) {
        assert.match(a.direction, /^(bullish|bearish|neutral)$/);
        assert.match(a.confidence, /^(high|medium|low)$/);
        assert.ok(REGIMES.includes(a.regime), `${sym}[${i}] regime ${a.regime}`);
        assert.ok(a.thesis && a.driver && a.rationale && a.invalidationReason, `${sym}[${i}] missing LLM text`);
        assert.ok(Array.isArray(a.qualityFlags) && a.qualityFlags.length <= 3 && a.qualityFlags.every(f => FLAGS.includes(f)));
        if (a.direction === 'neutral') {
          assert.equal(a.edge, null); assert.equal(a.triggerType, null);
          assert.equal(a.triggerAtrMult, null); assert.equal(a.stopAtrMult, null);
          assert.equal(a.targetR, null); assert.equal(a.maxHoldDays, null);
          assert.equal(a.invalidationLevel, null); assert.equal(a.pullbackLevel, null);
        } else {
          assert.ok(EDGES.includes(a.edge), `${sym}[${i}] edge ${a.edge}`);
          assert.match(a.triggerType, /^(breakout|pullback)$/);
          assert.ok(a.stopAtrMult >= 1 && a.stopAtrMult <= 3);
          assert.ok(a.targetR >= 1 && a.targetR <= 4);
          assert.ok(a.maxHoldDays >= 2 && a.maxHoldDays <= 10);
          assert.equal(typeof a.invalidationLevel, 'number');
          if (a.triggerType === 'breakout') assert.ok(a.triggerAtrMult >= 0.2 && a.triggerAtrMult <= 2);
          if (a.triggerType === 'pullback') assert.equal(typeof a.pullbackLevel, 'number');
          assert.ok(!isBannedCombo(a), `${sym}[${i}] banned combo`);
        }
      }
    }
  });

  it('frozen v3 feature rows contain no look-ahead', () => {
    const features = JSON.parse(fs.readFileSync(path.join(RECORDINGS, 'features.json'), 'utf8'));
    const history = JSON.parse(fs.readFileSync(path.join(RECORDINGS, 'history-2y.json'), 'utf8'));
    const mean = arr => arr.reduce((x, y) => x + y, 0) / arr.length;
    for (const sym of SYMBOLS) {
      const bars = history.symbols[sym].bars;
      assert.equal(bars.length, 500);
      for (const f of features.anchors[sym]) {
        const i = f.idx;
        const closes = bars.slice(0, i + 1).map(b => b.close);
        const highs = bars.slice(0, i + 1).map(b => b.high);
        const lows = bars.slice(0, i + 1).map(b => b.low);
        const trs = [];
        for (let j = 1; j <= i; j++) trs.push(Math.max(highs[j] - lows[j], Math.abs(highs[j] - closes[j - 1]), Math.abs(lows[j] - closes[j - 1])));
        assert.ok(Math.abs(f.atr5 - mean(trs.slice(-5))) < 0.05);
        assert.ok(Math.abs(f.ma20 - mean(closes.slice(-20))) < 0.1);
        assert.ok(Math.abs(f.ma60 - mean(closes.slice(-60))) < 0.1);
      }
    }
  });
});

describe('signal-backtest v3 plan semantics', () => {
  const anchor = {
    date: '2025-01-01', direction: 'bullish', confidence: 'high', regime: 'trend',
    edge: 'trend_continuation', triggerType: 'breakout',
    triggerAtrMult: 0.5, stopAtrMult: 1.5, targetR: 2, maxHoldDays: 5,
    pullbackLevel: null, invalidationLevel: 2900, qualityFlags: ['trend_aligned'],
    thesis: 't', driver: 'd', rationale: 'r', invalidationReason: 'i'
  };
  const bars = [{ date: '2025-01-10', open: 3000, high: 3010, low: 2990, close: 3000 }];

  it('breakout plan anchors the trigger to signal close + triggerAtrMult*ATR', () => {
    const sig = makeSignalV3('TEST0', anchor, 0, bars, { atr5: 10, ma20: 2990 });
    assert.equal(sig.triggerLevel, 3005);
    assert.equal(sig.stopPrice, 2990);
    assert.equal(sig.target1Level, 3035);
    assert.equal(sig.regime, 'trend');
    assert.equal(sig.edge, 'trend_continuation');
  });

  it('pullback plan anchors trigger/stop/target to the LLM pullbackLevel', () => {
    const a = { ...anchor, edge: 'pullback', triggerType: 'pullback', triggerAtrMult: null, pullbackLevel: 2980, stopAtrMult: 1.5, targetR: 2 };
    const sig = makeSignalV3('TEST0', a, 0, bars, { atr5: 10, ma20: 3000 });
    assert.equal(sig.triggerLevel, 2980);
    assert.equal(sig.stopPrice, 2965);
    assert.equal(sig.target1Level, 3010);
  });
});

describe('signal-quality v3 baseline artifacts', () => {
  it('produces qualitative cross-tabs and a quant-only control arm', () => {
    const p = path.join(OUTPUT, 'signal-quality-baseline-v3.json');
    assert.ok(fs.existsSync(p), 'run `node strategies/signal-backtest/runner-v3.cjs` first');
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.equal(j.schema, 'futures-radar-signal-backtest/3');
    assert.deepEqual(j.meta.universe, SYMBOLS);
    assert.equal(j.meta.anchorStep, 5);
    assert.equal(j.meta.anchorCount, 285);
    for (const key of ['byRegime', 'byEdge', 'byTriggerType', 'byQualityFlag']) {
      assert.ok(Array.isArray(j.crossTab[key]), `missing crossTab.${key}`);
      assert.ok(j.crossTab[key].length > 0, `empty crossTab.${key}`);
    }
    assert.ok(j.control && j.control.aggregate && j.control.aggregate.verifiedCount > 0, 'control arm missing');
    assert.ok(j.aggregate.verifiedCount > 0);
    assert.ok(j.falsification.some(l => /纯量化对照臂/.test(l)));
    for (const sig of j.signals) assert.ok(!isBannedCombo(sig), `banned combo leaked: ${sig.symbol} ${sig.signalDate}`);
    const md = fs.readFileSync(path.join(OUTPUT, 'signal-quality-baseline-v3.md'), 'utf8');
    assert.match(md, /LLM 定性判断交叉证伪 · regime/);
    assert.match(md, /纯量化对照臂/);
    assert.match(md, /执行参数分布（观察，不选优）/);
  });
});
