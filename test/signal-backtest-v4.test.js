import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { pilotAnchors, seriesAsOf, V4, CONTEXT_DIR } = require('../strategies/signal-backtest/context-assembler.cjs');
const { isBannedCombo } = require('../strategies/signal-backtest/runner.cjs');

const ROOT = path.resolve(__dirname, '..', 'strategies', 'signal-backtest');
const OUTPUT = path.join(ROOT, 'output');
const SYMBOLS = ['RB0', 'M0', 'SC0'];
const DATES = ['2026-06-11', '2026-06-18', '2026-06-26', '2026-07-03', '2026-07-10', '2026-07-17', '2026-07-24', '2026-07-31', '2026-08-07', '2026-08-14'];

describe('v4 context packets（asOf 截断与无泄漏）', () => {
  it('freezes 30 context packets, one per symbol/date, with no asOf later than anchor date', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(V4, 'context-manifest.json'), 'utf8'));
    for (const sym of SYMBOLS) {
      assert.equal(manifest.symbols[sym].length, 10);
      for (const entry of manifest.symbols[sym]) {
        assert.ok(DATES.includes(entry.date));
        const p = JSON.parse(fs.readFileSync(path.join(V4, entry.path), 'utf8'));
        assert.equal(p.anchorDate, entry.date);
        for (const item of p.macro.items) {
          assert.ok(item.asOf === null || item.asOf <= p.anchorDate, `${sym} ${p.anchorDate} macro ${item.id} asOf ${item.asOf}`);
        }
        for (const e of p.events.past) assert.ok(e.date <= p.anchorDate, `${sym} ${p.anchorDate} past event ${e.date}`);
        for (const e of p.events.nextScheduled) assert.ok(e.date > p.anchorDate, `${sym} ${p.anchorDate} next event ${e.date}`);
        assert.equal(p.price.close, pilotAnchors()[sym].find(a => a.date === p.anchorDate).close);
      }
    }
  });

  it('macro seriesAsOf picks the last bar <= anchorDate and recomputes change5d', () => {
    const h = JSON.parse(fs.readFileSync(path.join(V4, 'macro-history.json'), 'utf8'));
    const s = seriesAsOf(h.indicators.DXY.series, '2026-07-10');
    assert.equal(s.asOf, '2026-07-10');
    assert.equal(typeof s.value, 'number');
    assert.equal(typeof s.change5d, 'number');
    assert.equal(seriesAsOf(h.indicators.DXY.series, '1800-01-01'), null);
  });

  it('frozen sector-history covers every sector member used by the assembler', () => {
    const cfg = JSON.parse(fs.readFileSync(path.resolve(ROOT, '..', '..', 'config', 'symbols.json'), 'utf8'));
    const sh = JSON.parse(fs.readFileSync(path.join(V4, 'sector-history.json'), 'utf8'));
    for (const sym of SYMBOLS) {
      const target = Object.values(cfg.symbols).find(v => v.symbol === sym);
      const members = Object.values(cfg.symbols).filter(v => v.sector === target.sector && v.active !== false);
      for (const m of members) assert.ok(sh.symbols[m.symbol] && sh.symbols[m.symbol].length > 0, `missing sector member bars ${m.symbol}`);
    }
  });
});

describe('v4 arm recordings（A/B/C + FinCoT）', () => {
  it('A/B/C arms each have 10 valid plans per symbol and no banned combo', () => {
    for (const arm of ['A', 'B', 'C']) {
      const p = arm === 'A'
        ? JSON.parse(fs.readFileSync(path.join(V4, 'arm-A.json'), 'utf8'))
        : null;
      for (const sym of SYMBOLS) {
        const j = p ? p.symbols[sym] : JSON.parse(fs.readFileSync(path.join(V4, `arm-${arm}-${sym}.json`), 'utf8')).anchors;
        assert.equal(j.length, 10);
        assert.deepEqual(j.map(a => a.date), DATES);
        for (const a of j) {
          assert.match(a.direction, /^(bullish|bearish|neutral)$/);
          assert.ok(!isBannedCombo(a), `${arm} ${sym} ${a.date} banned combo`);
          if (arm !== 'A') {
            assert.match(a.executionStatus, /^(executable|watch|skip)$/);
            assert.match(a.macroBias, /^(bullish|bearish|neutral|conflict|not_applicable)$/);
            assert.match(a.sectorBias, /^(bullish|bearish|neutral|not_applicable)$/);
            assert.match(a.eventRisk, /^(low|medium|high)$/);
            assert.ok(Array.isArray(a.contextRefs));
          }
          if (arm === 'C') {
            assert.match(a.finCotAlignment, /^(aligned|diverged|not_applicable)$/);
            assert.ok(Array.isArray(a.finCotRefs));
          }
        }
      }
    }
  });

  it('freezes 30 full six-question FinCoT replay packets', () => {
    for (const sym of SYMBOLS) {
      for (const d of DATES) {
        const p = JSON.parse(fs.readFileSync(path.join(V4, 'fincot', `${sym}-${d}.json`), 'utf8'));
        assert.equal(p.anchorDate, d);
        assert.match(p.direction, /^(bullish|bearish|neutral)$/);
        for (const q of ['q1', 'q2', 'q3', 'q4', 'q5', 'q6']) assert.ok(p[q] && p[q].length > 0, `${sym} ${d} ${q}`);
        assert.ok(p.evidenceRefs.length > 0 || p.direction === 'neutral');
        assert.ok(p.invalidateIf);
      }
    }
  });
});

describe('v4 baseline artifacts', () => {
  it('produces three-arm comparison with populated C context cross-tabs', () => {
    const p = path.join(OUTPUT, 'signal-quality-baseline-v4.json');
    assert.ok(fs.existsSync(p), 'run `node strategies/signal-backtest/runner-v4.cjs` first');
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.equal(j.schema, 'futures-radar-signal-backtest/4');
    for (const arm of ['A', 'B', 'C']) {
      assert.ok(j.arms[arm] && j.arms[arm].aggregate, `missing arm ${arm}`);
      assert.ok(Array.isArray(j.signals[arm]));
    }
    assert.equal(j.ablation.length, 3);
    for (const key of ['byMacroBias', 'bySectorBias', 'byEventRisk', 'byFinCotAlignment']) {
      assert.ok(j.crossTabs.C[key].length > 0, `empty ${key}`);
      assert.ok(!j.crossTabs.C[key].every(r => r.value === 'null'), `${key} all null`);
    }
    const md = fs.readFileSync(path.join(OUTPUT, 'signal-quality-baseline-v4.md'), 'utf8');
    assert.match(md, /三臂总览/);
    assert.match(md, /消融结论/);
    assert.match(md, /finCotAlignment 交叉证伪/);
  });
});
