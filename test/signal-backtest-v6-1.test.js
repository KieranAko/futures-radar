import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ROOT = path.resolve(__dirname, '..', 'strategies', 'signal-backtest');
const OUTPUT = path.join(ROOT, 'output');
const V5 = path.join(ROOT, 'recordings', 'v5');

describe('v6.1 hard-constraint baseline', () => {
  it('G1 is scoped to context arms only and gate cost is fully accounted', () => {
    const j = JSON.parse(fs.readFileSync(path.join(OUTPUT, 'signal-quality-baseline-v6-1.json'), 'utf8'));
    assert.equal(j.schema, 'futures-radar-signal-backtest/6-1');
    assert.equal(j.meta.engine, 'v6.1-safe');
    assert.equal(j.meta.inSample, true, 'current batch was used for calibration');
    assert.equal(j.gateReasons.A.length, 0, 'A arm has no macro/sector fields, G1 must abstain');
    assert.ok(j.gateReasons.B.length > 0);
    assert.ok(j.gateReasons.C.length > 0);
    assert.ok(j.skippedCF.B.savedPnl > 0);
    assert.equal(j.skippedCF.C.savedPnl, 10.47);
    assert.equal(j.skippedCF.C.costPnl, 7.08);
    const md = fs.readFileSync(path.join(OUTPUT, 'signal-quality-baseline-v6-1.md'), 'utf8');
    assert.match(md, /闸门成本/);
    assert.match(md, /前10（校准）\/ 后10（验证）拆分/);
    assert.match(md, /diff 阈值敏感性/);
  });

  it('P5 risk symmetry: no signal may carry R = targetDist/stopDist < 1', () => {
    const j = JSON.parse(fs.readFileSync(path.join(OUTPUT, 'signal-quality-baseline-v6-1.json'), 'utf8'));
    for (const arm of ['A', 'B', 'C']) {
      for (const s of j.signals[arm]) {
        if (s.status === 'gate_skipped' || s.triggerLevel == null) continue;
        const stopDist = Math.abs(s.triggerLevel - s.stopPrice);
        const targetDist = Math.abs(s.triggerLevel - s.target1Level);
        assert.ok(targetDist >= stopDist - 1e-9, `${arm} ${s.symbol} ${s.signalDate} R<1`);
      }
    }
  });

  it('P6 invalidation exit applicability is recorded and net PnL is reported', () => {
    const j = JSON.parse(fs.readFileSync(path.join(OUTPUT, 'signal-quality-baseline-v6-1.json'), 'utf8'));
    for (const arm of ['A', 'B', 'C']) {
      assert.ok(j.arms[arm].aggregate.invalidationNotApplicable >= 0);
      assert.equal(typeof j.arms[arm].aggregate.avgNetPnlPct, 'number');
    }
    const verified = j.signals.C.filter(s => s.status === 'verified');
    for (const s of verified) assert.equal(typeof s.netPnlPct, 'number');
  });

  it('P3 split excludes the four attribution trades from promotion statistics', () => {
    const j = JSON.parse(fs.readFileSync(path.join(OUTPUT, 'signal-quality-baseline-v6-1.json'), 'utf8'));
    assert.deepEqual(j.meta.knownAttributionTradesExcluded, ['RB0|2026-06-30', 'SC0|2026-04-17', 'SC0|2026-06-24', 'SC0|2026-08-17']);
    assert.ok(j.splits.C.cal && j.splits.C.val && j.splits.C.valExcludingKnownTrades);
    assert.equal(j.splits.C.valExcludingKnownTrades.verifiedCount, 0);
  });

  it('P10 diff sensitivity is frozen and only reported', () => {
    const p = path.join(V5, 'diff-sensitivity.json');
    assert.ok(fs.existsSync(p));
    const sens = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.equal(sens.symbols.length, 3);
    for (const sym of sens.symbols) assert.ok(sym.counts.some(c => c.config === 'baseline'));
    const j = JSON.parse(fs.readFileSync(path.join(OUTPUT, 'signal-quality-baseline-v6-1.json'), 'utf8'));
    assert.ok(j.diffSensitivity);
  });
});
