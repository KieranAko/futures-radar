import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const EL = path.join(ROOT, 'experiment-line');
const { normalize, compareArtifact, firstDiff, cmdReplay } = require(path.join(EL, 'mirror.cjs'));
const g1 = require(path.join(EL, 'g1.cjs'));

describe('experiment-line v6 (full mirror of production)', () => {
  it('blueprint encodes v6 policy (whole-segment promote, G1 gate, no hot-update)', () => {
    const b = JSON.parse(fs.readFileSync(path.join(EL, 'blueprint.json'), 'utf8'));
    assert.equal(b.architectureVersion, 'v6');
    assert.equal(b.policy.promoteUnit, 'whole-stage-segment');
    assert.equal(b.policy.hotUpdateWhitelist, false);
    assert.equal(b.policy.g1GateRequired, true);
    assert.equal(b.policy.shadow.fixedObservationWindow, false);
    assert.ok(b.stages.length >= 13);
    const ids = b.stages.map((s) => s.id);
    for (const id of ['collect', 'scan', 'filter-hard', 'analyze', 'probability', 'report-5a', 'publish-current']) {
      assert.ok(ids.includes(id), id);
    }
  });

  it('normalize strips timestamp keys, runId and pipeline-version text', () => {
    const obj = {
      runId: 'r1',
      meta: { generatedAt: 'x', scannedAt: 'x', pipelineVersion: '0.1.5' },
      rows: [{ runId: 'r1', kept: 1 }],
    };
    const n = normalize(obj, 'r1', 'r1');
    assert.equal(n.runId, '<RUNID>');
    assert.equal(n.meta.generatedAt, undefined);
    assert.equal(n.meta.scannedAt, undefined);
    assert.deepEqual(n.rows[0], { runId: '<RUNID>', kept: 1 });
    const text = normalize('管道版本：0.1.5', 'r1', 'r1');
    assert.equal(text, '管道版本：<PIPELINE>');
  });

  it('compareArtifact classifies pipelineVersion-only drift as version-drift', () => {
    const prod = { meta: { runId: 'r1', pipelineVersion: '0.1.5' }, value: 1 };
    const mirror = { meta: { runId: 'r1', pipelineVersion: '0.1.19' }, value: 1 };
    const cmp = compareArtifact(prod, mirror, 'r1', 'r1');
    assert.equal(cmp.status, 'version-drift');
  });

  it('stable replay baseline: latest production run reproduces (diff=0, error=0)', () => {
    const prodRunId = '20260827-2159-auto';
    const prodDir = path.join(ROOT, 'output', 'runs', prodRunId);
    if (!fs.existsSync(prodDir)) return; // 历史 run 不存在时跳过
    const report = cmdReplay(prodRunId);
    assert.equal(report.summary.diff, 0, JSON.stringify(report.checks.filter((c) => c.status === 'diff')));
    assert.equal(report.summary.error, 0);
    const plan = report.checks.find((c) => c.stage === 'strategy-plan');
    assert.equal(plan.status, 'pass');
  });

  it('g1 register validates required mechanism fields and rejects missing theoryRef', () => {
    const tmp = path.join(EL, 'registry-src', '_tmp-g1-test.json');
    const bad = { id: 'TMP-01', name: 'x', family: 'carry' };
    fs.writeFileSync(tmp, JSON.stringify(bad));
    assert.throws(() => g1.cmdRegister(tmp), /missing required fields/);
    const noTheory = { ...bad, theoryRef: 'nope', proposition: {}, whyItWorks: 'x', applicableStates: {}, timeScale: '1d', invalidation: 'x', probeRef: 'x', g1Decision: { promote: 'promote', discard: [] } };
    fs.writeFileSync(tmp, JSON.stringify(noTheory));
    assert.throws(() => g1.cmdRegister(tmp), /theoryRef/);
    const noRunner = { ...noTheory, theoryRef: '02-term-structure.md §一 T1' };
    delete noRunner.probeRef;
    fs.writeFileSync(tmp, JSON.stringify(noRunner));
    assert.throws(() => g1.cmdRegister(tmp), /probeRef.*g1Runner/);
    fs.rmSync(tmp, { force: true });
  });

  it('carry G1 half-life estimator recovers known AR(1) persistence', () => {
    const { estimateHalfLife } = require(path.join(EL, 'probes', 'carry-basis-g1.cjs'));
    const rows = [{ br: 0.01 }];
    for (let i = 1; i < 500; i++) {
      rows.push({ br: 0.5 * rows[i - 1].br });
    }
    const hl = estimateHalfLife(rows);
    assert.ok(Math.abs(hl.phi - 0.5) < 0.001, `phi ${hl.phi}`);
    assert.ok(Math.abs(hl.halfLifeDays - 1) < 0.05, `halfLife ${hl.halfLifeDays}`);
  });
});
