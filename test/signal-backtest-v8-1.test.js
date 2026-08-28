import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ROOT = path.resolve(__dirname, '..', 'strategies', 'signal-backtest');
const V7 = path.join(ROOT, 'recordings', 'v7');
const OUTPUT = path.join(ROOT, 'output');

describe('V8.1 pricing layer（F1-F5）', () => {
  it('audits all 30 production plans and only releases structurally valid executable plans', () => {
    const j = JSON.parse(fs.readFileSync(path.join(V7, 'pricing-layer-v8.json'), 'utf8'));
    assert.equal(j.entries.length, 30);
    assert.equal(j.summary.executableOriginal, 12);
    assert.equal(j.summary.executableEffective, 6);
    for (const e of j.entries) {
      if (e.originalExecutionStatus === 'executable') {
        if (e.effectiveExecutionStatus === 'watch') {
          assert.ok(e.downgradeReasons.length > 0);
          for (const r of e.downgradeReasons) assert.match(r, /^F[1235]_/);
        }
      }
      assert.equal(typeof e.f1BandAtr, 'number');
      assert.equal(typeof e.structuralTarget, 'boolean');
      assert.ok(e.planPath.includes('strategy-plans'));
    }
  });

  it('baseline-v8-1 reflects pricing-layer releases', () => {
    const j = JSON.parse(fs.readFileSync(path.join(OUTPUT, 'signal-quality-baseline-v8-1.json'), 'utf8'));
    assert.equal(j.schema, 'futures-radar-signal-backtest/8-1');
    assert.equal(j.aggregate.executable, 12);
    assert.equal(j.aggregate.pricingWatch, 6);
    assert.equal(j.aggregate.effectiveExecutable, 6);
    assert.equal(j.aggregate.verifiedCount, 2);
    const watched = j.signals.filter(s => s.status === 'pricing_watch');
    assert.equal(watched.length, 6);
    for (const s of watched) assert.ok(s.pricing.downgradeReasons.length > 0);
    const md = fs.readFileSync(path.join(OUTPUT, 'signal-quality-baseline-v8-1.md'), 'utf8');
    assert.match(md, /定价层放行/);
  });
});
