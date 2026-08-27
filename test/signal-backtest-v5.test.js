import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { buildBundle, seriesAsOf, V5 } = require('../strategies/signal-backtest/context-bundle-builder.cjs');
const { diffRows } = require('../strategies/signal-backtest/context-diff.cjs');
const { isBannedCombo } = require('../strategies/signal-backtest/runner.cjs');

const ROOT = path.resolve(__dirname, '..', 'strategies', 'signal-backtest');
const OUTPUT = path.join(ROOT, 'output');
const SYMBOLS = ['RB0', 'M0', 'SC0'];

describe('v5 compact bundles（20 锚点 / 每符号一个文件）', () => {
  it('bundles rebuild deterministically from frozen sources', () => {
    for (const sym of SYMBOLS) {
      const committed = JSON.parse(fs.readFileSync(path.join(V5, `bundle-${sym}.json`), 'utf8'));
      const rebuilt = buildBundle(sym);
      assert.equal(JSON.stringify(rebuilt.rows), JSON.stringify(committed.rows), `${sym} bundle rows must be reproducible`);
    }
  });

  it('bundle rows are compact and contain no asOf later than anchor date', () => {
    for (const sym of SYMBOLS) {
      const b = JSON.parse(fs.readFileSync(path.join(V5, `bundle-${sym}.json`), 'utf8'));
      assert.equal(b.rows.length, 20);
      for (const row of b.rows) {
        for (const [id, v] of Object.entries(row.macro)) {
          const asOf = v && v[0];
          assert.ok(asOf === null || `2026-${asOf}` <= row.d, `${sym} ${row.d} macro ${id} asOf ${asOf}`);
        }
        for (const e of row.evt) assert.ok(`2026-${e.split('|')[0]}` <= row.d, `${sym} ${row.d} evt ${e}`);
        for (const e of row.nxt) assert.ok(`2026-${e.split('|')[0]}` > row.d, `${sym} ${row.d} nxt ${e}`);
      }
    }
  });

  it('macro rows recompute change5d from the frozen series', () => {
    const h = JSON.parse(fs.readFileSync(path.join(V5, 'macro-history.json'), 'utf8'));
    const s = seriesAsOf(h.indicators.DXY.series, '2026-07-10');
    assert.equal(s.asOf, '2026-07-10');
    assert.equal(typeof s.change5d, 'number');
    const b = JSON.parse(fs.readFileSync(path.join(V5, 'bundle-RB0.json'), 'utf8'));
    const row = b.rows.find(r => r.d === '2026-07-10');
    assert.deepEqual(row.macro.DXY, [s.asOf.slice(5), s.value, s.change5d]);
  });
});

describe('v5 change detector（变化驱动 FinCoT）', () => {
  it('first anchor is always fresh and reused rows point to the previous anchor', () => {
    for (const sym of SYMBOLS) {
      const d = JSON.parse(fs.readFileSync(path.join(V5, `diff-${sym}.json`), 'utf8'));
      assert.equal(d.rows.length, 20);
      assert.equal(d.rows[0].changed, true);
      for (let i = 1; i < d.rows.length; i++) {
        if (!d.rows[i].changed) assert.equal(d.rows[i].reusedFrom, d.rows[i - 1].date);
      }
    }
  });

  it('high-impact events and macro flips trigger change, routine rows can reuse', () => {
    const prev = { d: '2026-04-20', c: 3000, m20: 3010, m60: 3050, chg5: 1.5, macro: { DXY: ['04-20', 100, 0.5], USDCNH: ['04-20', 6.7, 0.2], US10Y: ['04-20', 4, 0.1], DR007: ['04-20', 1.4, 0.1], SC0: ['04-20', 500, 1.0] }, sect: { r5: 2 }, evt: [] };
    const curr = { d: '2026-04-27', c: 3000, m20: 3005, m60: 3050, chg5: 1.2, macro: { DXY: ['04-27', 100.2, 0.4], USDCNH: ['04-27', 6.71, 0.1], US10Y: ['04-27', 4.02, 0.2], DR007: ['04-27', 1.41, 0.2], SC0: ['04-27', 502, 0.8] }, sect: { r5: 1.5 }, evt: ['04-22|eia_weekly|1'] };
    assert.equal(diffRows(prev, curr).changed, false);
    const withFomc = { ...curr, evt: ['04-22|eia_weekly|1', '04-27|fomc|1'] };
    assert.equal(diffRows(prev, withFomc).changed, true);
  });
});

describe('v5 A/B/C arms and FinCoT recordings', () => {
  it('A/B/C arms each have 20 valid plans, C has finCotRefs and no banned combo', () => {
    for (const arm of ['A', 'B', 'C']) {
      for (const sym of SYMBOLS) {
        const j = arm === 'A'
          ? JSON.parse(fs.readFileSync(path.join(V5, 'arm-A.json'), 'utf8')).symbols[sym]
          : JSON.parse(fs.readFileSync(path.join(V5, `arm-${arm}-${sym}.json`), 'utf8')).anchors;
        assert.equal(j.length, 20);
        for (const a of j) {
          assert.match(a.direction, /^(bullish|bearish|neutral)$/);
          assert.ok(!isBannedCombo(a), `${arm} ${sym} ${a.date}`);
          if (arm !== 'A') {
            assert.match(a.executionStatus, /^(executable|watch|skip)$/);
            assert.ok(Array.isArray(a.contextRefs));
          }
          if (arm === 'C') {
            assert.ok(Array.isArray(a.finCotRefs) && a.finCotRefs.length > 0, `${sym} ${a.date} missing finCotRefs`);
            assert.match(a.finCotAlignment, /^(aligned|diverged|not_applicable)$/);
          }
        }
      }
    }
  });

  it('FinCoT fresh/reused flags match the change detector and C plans consume FinCoT', () => {
    for (const sym of SYMBOLS) {
      const diff = JSON.parse(fs.readFileSync(path.join(V5, `diff-${sym}.json`), 'utf8'));
      const fin = JSON.parse(fs.readFileSync(path.join(V5, `fincot-${sym}.json`), 'utf8'));
      const plans = JSON.parse(fs.readFileSync(path.join(V5, `arm-C-${sym}.json`), 'utf8')).anchors;
      const finByDate = Object.fromEntries(fin.entries.map(e => [e.anchorDate, e]));
      for (const d of diff.rows) {
        assert.equal(finByDate[d.date].mode, d.changed ? 'fresh' : 'reused');
        if (!d.changed) assert.equal(finByDate[d.date].reusedFrom, d.reusedFrom);
      }
      for (const p of plans) {
        const f = finByDate[p.date];
        if (f.direction !== p.direction) {
          assert.equal(p.finCotAlignment, 'diverged');
          assert.ok(p.divergenceReason && p.counterEvidence);
        }
        if (f.direction === 'neutral') assert.notEqual(p.executionStatus, 'executable');
      }
    }
  });
});

describe('v5 baseline artifacts', () => {
  it('produces three-arm comparison with FinCoT reuse cross-tab', () => {
    const p = path.join(OUTPUT, 'signal-quality-baseline-v5.json');
    assert.ok(fs.existsSync(p), 'run `node strategies/signal-backtest/runner-v5.cjs` first');
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.equal(j.schema, 'futures-radar-signal-backtest/5');
    assert.equal(j.meta.anchorsPerSymbol, 20);
    for (const arm of ['A', 'B', 'C']) assert.ok(j.arms[arm] && Array.isArray(j.signals[arm]));
    assert.equal(j.ablation.length, 3);
    assert.ok(j.crossTabs.C.byFinCotMode.length > 0);
    const md = fs.readFileSync(path.join(OUTPUT, 'signal-quality-baseline-v5.md'), 'utf8');
    assert.match(md, /# 信号质量回测基线 v5/);
    assert.match(md, /FinCoT 复用/);
  });
});
