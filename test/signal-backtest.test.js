import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { makeSignal, verifySignal, loadBars } = require('../strategies/signal-backtest/runner.cjs');
const store = require('../data-store/index.cjs');

const ROOT = path.resolve(__dirname, '..', 'strategies', 'signal-backtest');
const RECORDINGS = path.join(ROOT, 'recordings');
const OUTPUT = path.join(ROOT, 'output');
const SYMBOLS = ['RB0', 'M0', 'SC0'];

function syntheticBars(n = 30) {
  const bars = [];
  let close = 3000;
  for (let i = 0; i < n; i++) {
    close += i % 2 === 0 ? 8 : -3;
    const d = new Date(Date.UTC(2025, 0, 1 + i));
    const date = d.toISOString().slice(0, 10);
    bars.push({ date, open: close - 2, high: close + 12, low: close - 12, close, volume: 100 });
  }
  return bars;
}

describe('signal-backtest recordings', () => {
  it('has one recorded anchor file per symbol with valid contract shape', () => {
    for (const sym of SYMBOLS) {
      const p = path.join(RECORDINGS, `anchors-${sym}.json`);
      assert.ok(fs.existsSync(p), `missing ${p}`);
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      assert.equal(j.symbol, sym);
      assert.equal(j.step, 10);
      assert.ok(j.anchors.length >= 20, `${sym} should cover ~1 year of 10-day anchors`);
      for (const [i, a] of j.anchors.entries()) {
        assert.match(a.date, /^\d{4}-\d{2}-\d{2}$/, `${sym}[${i}] bad date`);
        assert.match(a.direction, /^(bullish|bearish|neutral)$/, `${sym}[${i}] bad direction`);
        assert.match(a.confidence, /^(high|medium|low)$/, `${sym}[${i}] bad confidence`);
        assert.ok(a.driver && a.rationale, `${sym}[${i}] missing LLM text`);
        if (a.direction === 'neutral') {
          assert.equal(a.invalidationLevel, null, `${sym}[${i}] neutral must not set invalidation`);
        } else {
          assert.ok(a.triggerAtrMult >= 0.2 && a.triggerAtrMult <= 2, `${sym}[${i}] triggerAtrMult range`);
          assert.ok(a.stopAtrMult >= 1 && a.stopAtrMult <= 3, `${sym}[${i}] stopAtrMult range`);
          assert.ok(a.targetR >= 1 && a.targetR <= 4, `${sym}[${i}] targetR range`);
          assert.ok(a.maxHoldDays >= 2 && a.maxHoldDays <= 10, `${sym}[${i}] maxHoldDays range`);
          assert.equal(typeof a.invalidationLevel, 'number', `${sym}[${i}] invalidationLevel`);
        }
      }
    }
  });

  it('anchor dates align with the 10-day feature grid', () => {
    const features = JSON.parse(fs.readFileSync(path.join(RECORDINGS, 'features.json'), 'utf8'));
    for (const sym of SYMBOLS) {
      const j = JSON.parse(fs.readFileSync(path.join(RECORDINGS, `anchors-${sym}.json`), 'utf8'));
      const featDates = features.anchors[sym].map(f => f.date);
      assert.deepEqual(j.anchors.map(a => a.date), featDates, `${sym} anchors must be in feature order`);
    }
  });

  it('ships a frozen 1-year OHLC fixture and falls back to it without data-store', () => {
    const fixture = JSON.parse(fs.readFileSync(path.join(RECORDINGS, 'history-1y.json'), 'utf8'));
    for (const sym of SYMBOLS) {
      assert.equal(fixture.symbols[sym].bars.length, 250, `${sym} fixture should cover 1 year`);
    }
    const original = store.loadHistoricalCache;
    store.loadHistoricalCache = () => ({ contracts: {} });
    try {
      const { bars, source } = loadBars('RB0');
      assert.equal(bars.length, 250);
      assert.match(source, /fixture/);
    } finally {
      store.loadHistoricalCache = original;
    }
  });
});

describe('signal-backtest verifier (feedback semantics)', () => {
  const anchor = {
    date: '2025-01-01', direction: 'bullish', confidence: 'medium',
    triggerAtrMult: 0.5, stopAtrMult: 1.5, targetR: 2, maxHoldDays: 5,
    invalidationLevel: 2900, driver: '趋势延续', rationale: '测试锚点'
  };

  it('builds a plan from truncated features only', () => {
    const bars = syntheticBars();
    const sIdx = 15;
    const close = bars[sIdx].close;
    const sig = makeSignal('TEST0', anchor, sIdx, bars, { atr5: 10, ma20: close - 1 });
    // 触发价 = 信号日收盘 + 0.5*ATR，无未来项
    assert.equal(sig.triggerLevel, Number((close + 5).toFixed(1)));
    assert.equal(sig.stopPrice, Number((close + 5 - 15).toFixed(1)));
    assert.match(sig.triggerTiming, /T\+1 收盘确认/);
  });

  it('marks T+1 close miss as trigger_miss', () => {
    const bars = syntheticBars();
    const sig = makeSignal('TEST0', anchor, 10, bars, { atr5: 10, ma20: bars[10].close - 1 });
    const res = verifySignal(sig, bars);
    assert.equal(res.status, 'trigger_miss');
    assert.equal(res.attribution[0].code, 'trigger_miss');
  });

  it('verifies target1 / stop / time exit on the T+2 open entry path', () => {
    const bars = syntheticBars();
    const sig = makeSignal('TEST0', anchor, 10, bars, { atr5: 10, ma20: bars[10].close - 1 });
    // 构造 T+1 收盘越过触发价，T+2 开盘无跳空，T+3 高点到目标1
    const t1 = bars[11];
    t1.close = sig.triggerLevel + 1;
    const entryBar = bars[12];
    entryBar.open = sig.triggerLevel + 0.5;
    const hit = bars[13];
    hit.high = sig.target1Level + 1;
    hit.low = sig.stopPrice + 1;
    const res = verifySignal(sig, bars);
    assert.equal(res.status, 'verified');
    assert.equal(res.exitType, 'target1_hit');
    assert.equal(res.directionCorrect, true);
    assert.ok(res.pnlPct > 0);
  });

  it('skips execution on an excessive gap', () => {
    const bars = syntheticBars();
    const sig = makeSignal('TEST0', anchor, 10, bars, { atr5: 10, ma20: bars[10].close - 1 });
    bars[11].close = sig.triggerLevel + 1;
    bars[12].open = sig.triggerLevel + 20; // 跳空 > 0.5*止损距离
    const res = verifySignal(sig, bars);
    assert.equal(res.status, 'gap_skip');
    assert.equal(res.attribution[0].code, 'gap_skip');
  });
});

describe('signal-quality baseline artifacts', () => {
  it('produces a JSON baseline consistent with its markdown export', () => {
    const p = path.join(OUTPUT, 'signal-quality-baseline.json');
    assert.ok(fs.existsSync(p), 'run `node strategies/signal-backtest/runner.cjs` first');
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.equal(j.schema, 'futures-radar-signal-backtest/1');
    assert.deepEqual(j.meta.universe, SYMBOLS);
    assert.equal(j.meta.anchorStep, 10);
    assert.equal(j.meta.anchorCount, 69);
    const perSymbolSignals = SYMBOLS.reduce((acc, s) => acc + j.perSymbol[s].signalCount, 0);
    assert.equal(j.aggregate.signalCount, perSymbolSignals);
    assert.equal(j.signals.length, perSymbolSignals);
    const md = fs.readFileSync(path.join(OUTPUT, 'signal-quality-baseline.md'), 'utf8');
    assert.match(md, /# 信号质量回测基线/);
    assert.match(md, /方向正确率/);
  });
});
