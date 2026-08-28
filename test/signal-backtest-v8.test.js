import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { executePlan } = require('../strategies/signal-backtest/runner-v8.cjs');

const ROOT = path.resolve(__dirname, '..', 'strategies', 'signal-backtest');
const PLAN_DIR = path.join(ROOT, 'recordings', 'v7', 'strategy-plans');
const OUTPUT = path.join(ROOT, 'output');

describe('V8 production strategy-plan execution', () => {
  it('runs only executable production plans with triggerTiming semantics', () => {
    const j = JSON.parse(fs.readFileSync(path.join(OUTPUT, 'signal-quality-baseline-v8.json'), 'utf8'));
    assert.equal(j.schema, 'futures-radar-signal-backtest/8');
    assert.equal(j.aggregate.plans, 30);
    assert.equal(j.aggregate.executable, 12);
    assert.equal(j.aggregate.verifiedCount, 2);
    assert.equal(j.aggregate.gapSkip, 7);
    assert.equal(j.aggregate.triggerMiss, 3);
    for (const s of j.signals) {
      assert.ok(s.matchedStrategies.length >= 1);
      if (s.executionStatus === 'executable') assert.match(s.triggerTiming, /T\+1/);
      if (s.status === 'verified') assert.equal(typeof s.netPnlPct, 'number');
    }
    const md = fs.readFileSync(path.join(OUTPUT, 'signal-quality-baseline-v8.md'), 'utf8');
    assert.match(md, /生产 strategy-plan 执行/);
  });

  it('keeps watch plans out of execution and records trigger type', () => {
    const files = fs.readdirSync(PLAN_DIR).filter(f => f.endsWith('.json') && f !== 'manifest.json');
    let executable = 0;
    for (const f of files) {
      const plan = JSON.parse(fs.readFileSync(path.join(PLAN_DIR, f), 'utf8'));
      const p = plan.plans[0];
      if (p.executionStatus === 'executable') {
        executable++;
        const sym = f.split('-')[0];
        const res = executePlan(sym, path.join(PLAN_DIR, f));
        assert.notEqual(res.status, 'not_executable');
      }
    }
    assert.equal(executable, 12);
  });
});
