import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { evaluatePolicy } = require(path.join(__dirname, '..', 'scripts', 'git-push-policy.cjs'));

const base = {
  ahead: 0,
  behind: 0,
  lines: 0,
  commits: [],
  lastPushAt: null,
  now: Date.parse('2026-09-01T12:00:00Z')
};

describe('git push policy v1', () => {
  it('无未推送提交 → HOLD', () => {
    assert.equal(evaluatePolicy(base).verdict, 'HOLD');
  });

  it('落后远端 → HOLD，禁止直接推送', () => {
    const r = evaluatePolicy({ ...base, ahead: 2, behind: 1 });
    assert.equal(r.verdict, 'HOLD');
    assert.match(r.reasons.join('；'), /落后远端/);
  });

  it('T0 紧急通道优先', () => {
    const r = evaluatePolicy({ ...base, ahead: 1, emergency: true });
    assert.equal(r.verdict, 'PUSH');
    assert.equal(r.tier, 'T0');
  });

  it('T1 里程碑：feat 提交', () => {
    const r = evaluatePolicy({ ...base, ahead: 1, commits: [{ subject: 'feat: cost-anchor', body: '' }] });
    assert.equal(r.tier, 'T1');
  });

  it('T2 累积量：提交数或行数达标', () => {
    assert.equal(evaluatePolicy({ ...base, ahead: 3 }).tier, 'T2');
    assert.equal(evaluatePolicy({ ...base, ahead: 1, lines: 151 }).tier, 'T2');
  });

  it('T3 时间上限', () => {
    const r = evaluatePolicy({
      ...base,
      ahead: 1,
      lastPushAt: '2026-08-31T12:00:00Z',
      now: Date.parse('2026-09-01T12:00:00Z')
    });
    assert.equal(r.tier, 'T3');
  });

  it('低于阈值 → HOLD 并给出进度', () => {
    const r = evaluatePolicy({
      ...base,
      ahead: 2,
      lines: 40,
      lastPushAt: '2026-09-01T00:00:00Z',
      now: Date.parse('2026-09-01T12:00:00Z')
    });
    assert.equal(r.verdict, 'HOLD');
    assert.ok(r.reasons.some((x) => x.includes('2/3')));
    assert.ok(r.reasons.some((x) => x.includes('40/150')));
  });
});
