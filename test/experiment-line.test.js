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

  it('blueprint attaches registered candidates to their stages', () => {
    const b = JSON.parse(fs.readFileSync(path.join(EL, 'blueprint.json'), 'utf8'));
    const analyze = b.stages.find((s) => s.id === 'analyze');
    assert.ok(analyze.candidate.some((c) => c.id === 'analyze-mechanism-identification-v1'));
    const r5c = b.stages.find((s) => s.id === 'report-5c');
    assert.ok(r5c.candidate.some((c) => c.id === 'report-trust-model-v1'));
  });

  it('trust model rates by family/match/fidelity and infers family by keyword rule', () => {
    const trust = require(path.join(EL, 'trust-model.cjs'));
    assert.equal(trust.familyScore('carry'), 1); // g1 closed, all three forms retired, no active preview
    assert.equal(trust.familyScore('value'), 0); // not_evaluable_or_falsified
    assert.equal(trust.familyScore('volatility'), 0);
    assert.equal(trust.rate({ fs: 3, ms: 2, xs: 2 }), 'A');
    assert.equal(trust.rate({ fs: 2, ms: 1, xs: 1 }), 'B');
    assert.equal(trust.rate({ fs: 1, ms: 0, xs: 0 }), 'C');
    assert.equal(trust.rate({ fs: 0, ms: 2, xs: 2 }), 'D');
    assert.equal(trust.inferFamily('基差深度贴水后回归'), 'carry');
    assert.equal(trust.inferFamily('趋势延续，突破确认'), 'momentum');
    assert.equal(trust.inferFamily('无明确驱动'), 'none');
  });

  it('shadow framework snapshots evidence immutably and records reviews', () => {
    const prodRunId = '20260827-2159-auto';
    const replayFile = path.join(EL, 'results', `${prodRunId}-replay.json`);
    if (!fs.existsSync(replayFile)) return;
    const shadow = require(path.join(EL, 'shadow.cjs'));
    const recFile = path.join(shadow.SHADOW_DIR, 'report-trust-model-v1.json');
    fs.rmSync(recFile, { force: true });
    const rec = shadow.cmdInit('report-trust-model-v1');
    assert.equal(rec.status, 'observing');
    const rec2 = shadow.cmdReview('report-trust-model-v1', prodRunId);
    assert.equal(rec2.reviews.length, 1);
    const snap = JSON.parse(fs.readFileSync(rec2.reviews[0].snapshotRef, 'utf8'));
    assert.match(snap.evidence[`${prodRunId}-replay.json`].sha256, /^[0-9a-f]{64}$/);
  });

  it('mechanism identification emits family + registry match for mirror run', () => {
    const prodRunId = '20260827-2159-auto';
    const modelFile = path.join(EL, 'runs', prodRunId, 'report-model.json');
    if (!fs.existsSync(modelFile)) return;
    const mi = require(path.join(EL, 'mechanism-identify.cjs'));
    const out = mi.main(prodRunId);
    assert.equal(out.rows.length, 3);
    assert.ok(out.rows.every((r) => r.family && r.matchStatus));
  });

  it('g2 refuses mechanisms that did not pass the G1 gate', () => {
    const g1mod = require(path.join(EL, 'g1.cjs'));
    const regFile = path.join(g1mod.REGISTRY_DIR, 'TH-CARRY-03.json');
    const original = fs.existsSync(regFile) ? fs.readFileSync(regFile, 'utf8') : null;
    g1mod.cmdRegister(path.join(EL, 'registry-src', 'TH-CARRY-03.json'));
    const g2 = require(path.join(EL, 'g2.cjs'));
    const out = g2.assess('TH-CARRY-03');
    assert.equal(out.eligible, false);
    assert.match(out.reason, /G1 gate not passed/);
    assert.equal(g2.maxDrawdown([1, -2, 3, -1]), -2);
    // 恢复真实 registry 状态（本测试只验证门槛，不污染运行状态）
    if (original) fs.writeFileSync(regFile, original);
    else fs.rmSync(regFile, { force: true });
  });

  it('experiment-line report assembles real report + appendix', () => {
    const prodRunId = '20260827-2159-auto';
    const baseFile = path.join(EL, 'runs', prodRunId, 'report.md');
    if (!fs.existsSync(baseFile)) return;
    const report = require(path.join(EL, 'report.cjs'));
    const out = report.main(prodRunId);
    const md = fs.readFileSync(out.file, 'utf8');
    assert.ok(md.includes('## 五、交易策略板块（执行参考）'), 'real report body preserved');
    assert.ok(md.includes('## 附：实验线状态（实验线增量，不影响上方报告）'));
    assert.ok(md.includes('### 可信度评级'));
    assert.ok(md.includes('### 前向验证'));
  });

  it('forward verifier applies T+1 semantics with frozen plan parameters', () => {
    const { verifyPlan } = require(path.join(EL, 'forward-verify.cjs'));
    const dates = ['2026-08-25', '2026-08-26', '2026-08-27', '2026-08-28', '2026-08-29'];
    const daily = {
      dates,
      open: [100, 101, 102, 103, 104],
      high: [102, 103, 104, 105, 106],
      low: [99, 100, 101, 102, 103],
      close: [101, 102, 103, 104, 105],
    };
    const base = {
      symbol: 'X0',
      reportBaseline: { direction: 'bullish', confidence: 'medium' },
      matchedStrategies: [{ strategyId: 'MS-01' }],
      playbook: { playbookId: 'PB-03' },
      executionStatus: 'executable',
      entry: { triggerLevel: 102.5, triggerTiming: 'T+1 开盘执行', execution: 'T+1 开盘；跳空 >0.5×ATR5 放弃' },
      stop: { stopPrice: 99 },
      riskAssessment: { maxHoldingDays: 3 },
      position: { lots: 1 },
      invalidation: { hard: ['收盘跌破 m20'] },
    };
    // T+1 open 103 > trigger 102.5 → fill at 103; 目标 2R=107? risk=4 → T1=111，持有期内 high=106 未达，收盘退出
    const r = verifyPlan(base, daily, '2026-08-27');
    assert.equal(r.status, 'verified');
    assert.equal(r.entryDate, '2026-08-28');
    // watch 状态 → not_executable
    const watch = { ...base, executionStatus: 'watch' };
    assert.equal(verifyPlan(watch, daily, '2026-08-27').status, 'not_executable');
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
