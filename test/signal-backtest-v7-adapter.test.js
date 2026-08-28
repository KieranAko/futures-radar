import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { validatePlan } = require('../strategies/lib/strategy-matcher.cjs');

const ROOT = path.resolve(__dirname, '..', 'strategies', 'signal-backtest');
const DIR = path.join(ROOT, 'recordings', 'v7', 'strategy-plans');
const SCHEMA = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'report', 'strategy-plan.schema.json'), 'utf8'));

describe('V7 production strategy-plan adapter', () => {
  it('produces 30 strategy plans that pass the production plan schema', () => {
    const files = fs.readdirSync(DIR).filter(f => f.endsWith('.json') && f !== 'manifest.json');
    assert.equal(files.length, 30);
    let executable = 0; let nonBase = 0;
    for (const f of files) {
      const plan = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
      const check = validatePlan(plan, SCHEMA);
      assert.ok(check.ok, `${f}: ${check.errors?.join('; ')}`);
      const p = plan.plans[0];
      assert.ok(p.matchedStrategies.length >= 1);
      assert.ok(p.reportBaseline.direction && p.reportBaseline.confidence);
      assert.ok(p.entry && p.stop && p.targets && p.position && p.riskAssessment);
      assert.match(p.executionStatus, /^(executable|watch|skip)$/);
      if (p.executionStatus === 'executable') executable++;
      if (p.matchedStrategies[0].strategyId !== 'BASE-01') nonBase++;
    }
    assert.ok(executable > 0, 'at least one executable plan');
    assert.ok(nonBase > 0, 'at least one library strategy match beyond BASE-01');
  });

  it('propagates FinCoT analysis direction into the adapted strategy plans', () => {
    for (const sym of ['RB0', 'M0', 'SC0']) {
      const fin = JSON.parse(fs.readFileSync(path.join(ROOT, 'recordings', 'v7', `fincot-v7-${sym}.json`), 'utf8'));
      for (const e of fin.entries) {
        const plan = JSON.parse(fs.readFileSync(path.join(DIR, `${sym}-${e.anchorDate}.json`), 'utf8'));
        assert.equal(plan.plans[0].reportBaseline.direction, e.direction, `${sym} ${e.anchorDate} direction mismatch`);
      }
    }
  });
});
