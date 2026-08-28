import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { buildPlans } = require('../strategies/signal-backtest/build-plans-v7.cjs');

const ROOT = path.resolve(__dirname, '..', 'strategies', 'signal-backtest');
const V7 = path.join(ROOT, 'recordings', 'v7');
const OUTPUT = path.join(ROOT, 'output');
const SYMBOLS = ['RB0', 'M0', 'SC0'];
const BPS = ['BP-TREND', 'BP-BREAK', 'BP-PULL', 'BP-RANGE', 'BP-SHOCK'];

describe('V7 FinCoT recordings（blueprint/thinking/output/selfCheck）', () => {
  it('has 10 valid FinCoT entries per symbol, all self-checks pass', () => {
    let fresh = 0; let reused = 0;
    for (const sym of SYMBOLS) {
      const j = JSON.parse(fs.readFileSync(path.join(V7, `fincot-v7-${sym}.json`), 'utf8'));
      assert.equal(j.schemaVersion, 'fincot/2');
      assert.equal(j.entries.length, 10);
      for (const [i, e] of j.entries.entries()) {
        assert.ok(BPS.includes(e.blueprintId), `${sym}[${i}] blueprint`);
        assert.match(e.mode, /^(fresh|reused)$/);
        if (e.mode === 'fresh') fresh++; else { reused++; assert.ok(e.reusedFrom); }
        assert.equal(e.selfCheck.unitCheck, 'pass');
        assert.equal(e.selfCheck.evidenceCheck, 'pass');
        assert.equal(e.selfCheck.opposingCheck, 'pass');
        assert.ok(e.thinking && e.thinking.length > 0);
        assert.equal(typeof e.q.q4_confirmation.level, 'number');
        assert.equal(typeof e.q.q5_invalidation.level, 'number');
        if (e.direction === 'neutral') assert.match(e.q.q1_driver.text, /abstain|data_insufficient|model_abstain|conflict_unresolved/i);
        else assert.ok(e.q.q3_odds.opposingRefs.length > 0, `${sym}[${i}] opposingRefs`);
      }
    }
    assert.ok(fresh > 0 && reused >= 0);
  });
});

describe('V7 T2 deterministic template plans', () => {
  it('rebuilds plans deterministically from FinCoT + evidence + blueprints', () => {
    for (const sym of SYMBOLS) {
      const committed = JSON.parse(fs.readFileSync(path.join(V7, `plans-v7-${sym}.json`), 'utf8'));
      const rebuilt = buildPlans(sym);
      assert.equal(JSON.stringify(rebuilt.anchors), JSON.stringify(committed.anchors));
      for (const p of committed.anchors) {
        if (p.direction !== 'neutral') {
          assert.match(p.executionStatus, /^(executable|watch|skip)$/);
          assert.equal(typeof p.invalidationLevel, 'number');
          assert.ok(p.exitManagement && p.riskExecution);
          assert.ok(p.finCotRefs.length > 0);
        }
      }
    }
  });
});

describe('V7 baseline artifacts', () => {
  it('produces blueprint-grounded C-arm comparison with gate cost and FinCoT stats', () => {
    const p = path.join(OUTPUT, 'signal-quality-baseline-v7.json');
    assert.ok(fs.existsSync(p), 'run `node strategies/signal-backtest/runner-v7.cjs` first');
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.equal(j.schema, 'futures-radar-signal-backtest/7');
    assert.equal(j.meta.anchorsPerSymbol, 10);
    assert.equal(j.meta.inSample, true);
    assert.ok(j.comparison.v5C && j.comparison.v61C);
    assert.equal(j.fincotStats.fresh + j.fincotStats.reused, 30);
    assert.ok(j.aggregate.verifiedCount > 0);
    for (const s of j.signals.filter(x => x.status === 'verified')) assert.ok(BPS.includes(s.blueprintId));
    const md = fs.readFileSync(path.join(OUTPUT, 'signal-quality-baseline-v7.md'), 'utf8');
    assert.match(md, /FinCoT 蓝图/);
    assert.match(md, /V7 C 臂 vs 同窗口 v5\/v6\.1/);
  });
});
