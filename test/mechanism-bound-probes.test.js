import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MECH = path.join(ROOT, 'strategies', 'research', 'v2', 'falsification', 'mechanism');
const { stableHash } = require(path.join(ROOT, 'strategies', 'research', 'v2', 'falsification', 'harness-lib', 'util.cjs'));

const ids = ['H-MECH-01', 'H-MECH-02', 'H-MECH-03'];

function loadHypothesis(id) {
  const file = fs.readdirSync(MECH).find((f) => f.startsWith(id) && f.endsWith('-hypothesis.json')) || fs.readdirSync(MECH).find((f) => f.startsWith(id) && f.endsWith('.json'));
  return JSON.parse(fs.readFileSync(path.join(MECH, file), 'utf8'));
}

describe('mechanism hypothesis generation (round 1)', () => {
  it('three preregistered hypotheses exist with complete five-segment skeletons', () => {
    for (const id of ids) {
      const h = loadHypothesis(id);
      assert.equal(h.id, id);
      assert.ok(['macro', 'fundamental', 'trader'].includes(h.family));
      for (const seg of ['theory', 'marketModel', 'strategy', 'dataContract', 'falsification']) {
        assert.ok(h[seg] && Object.keys(h[seg]).length > 0, `${id}.${seg} missing`);
      }
      assert.ok(Array.isArray(h.marketModel.formulas) && h.marketModel.formulas.length >= 3, `${id} formulas`);
      assert.equal(h.probe.preregistered, true);
      assert.match(h.probe.binding, /marketModel/);
      assert.ok(h.probe.decisionRules && h.probe.primaryStatistic && h.probe.powerSpec, `${id} probe preregistration incomplete`);
    }
  });

  it('probe preregistration hashes are frozen and verifiable', () => {
    for (const id of ids) {
      const h = loadHypothesis(id);
      const { preregistrationHash, ...rest } = h.probe;
      assert.ok(/^[0-9a-f]{64}$/.test(preregistrationHash), `${id} hash format`);
      assert.equal(stableHash(rest), preregistrationHash, `${id} hash mismatch`);
    }
  });

  it('probe results exist and decisions are consistent with the registered rules', () => {
    for (const id of ids) {
      const r = JSON.parse(fs.readFileSync(path.join(MECH, 'probe-results', `${id}-probe.json`), 'utf8'));
      assert.equal(r.id, id);
      assert.equal(r.seed, 20260828);
      assert.equal(r.alphaAdj, 0.0167);
      assert.ok(['promote', 'discard', 'screen_pending', 'insufficient_sample'].includes(r.decision));
      const { n, ci, meanNetPct } = r.primary;
      if (r.decision === 'insufficient_sample') assert.ok(n < 100);
      else {
        assert.ok(n >= 100);
        if (r.decision === 'promote') assert.ok(meanNetPct > 0 && ci.lo > 0);
        if (r.decision === 'discard') assert.ok(ci.hi < 0);
        if (r.decision === 'screen_pending') assert.ok(ci.lo <= 0 && ci.hi >= 0);
      }
    }
  });

  it('probe runner is deterministic (re-run changes no statistical fields)', async () => {
    const runner = require(path.join(MECH, 'mechanism-bound-probes.cjs'));
    const before = {};
    for (const id of ids) {
      before[id] = JSON.parse(fs.readFileSync(path.join(MECH, 'probe-results', `${id}-probe.json`), 'utf8'));
    }
    runner.main();
    for (const id of ids) {
      const after = JSON.parse(fs.readFileSync(path.join(MECH, 'probe-results', `${id}-probe.json`), 'utf8'));
      assert.deepEqual(after, before[id], `${id} result drifted on re-run`);
    }
  });

  it('library experimentIntegrity records the round without touching core manifest', () => {
    const lib = require(path.join(ROOT, 'strategies', 'strategy-library-v2.json'));
    const mp = lib.experimentIntegrity.mechanismProbes;
    assert.equal(mp.round, 1);
    assert.equal(mp.hypotheses.length, 3);
    assert.equal(mp.decisions['H-MECH-01'], 'screen_pending');
    assert.equal(mp.decisions['H-MECH-02'], 'screen_pending');
    assert.equal(mp.decisions['H-MECH-03'], 'screen_pending');
    const oldStates = lib.strategies.map((s) => `${s.id}:${s.status}:${s.evidenceTier}`);
    assert.deepEqual(oldStates, [
      'TR-01:suspended:strategy_gate_failed',
      'TR-03:retired:falsified',
      'TR-06:suspended:not_evaluable',
      'FS-02:designed:untested',
      'FS-04:suspended:not_evaluable',
      'FS-05:suspended:not_evaluable',
      'M1:suspended:insufficient_sample',
      'EC-01:retired:falsified',
    ]);
  });

  it('consolidated report 25 exists and matches decisions', () => {
    const md = fs.readFileSync(path.join(MECH, '..', '25-mechanism-bound-probes.md'), 'utf8');
    assert.match(md, /H-MECH-01/);
    assert.match(md, /screen_pending/);
    assert.match(md, /不改变 strategy-library-v2/);
  });
});
