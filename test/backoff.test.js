// test/backoff.test.js — P2 统一退避工具单元测试
import { test } from 'node:test';
import assert from 'node:assert/strict';
import bk from '../collector/backoff.cjs';
const { retryWithBackoff, SourceCooldown } = bk;

test('retryWithBackoff: 失败后重试至成功', async () => {
  let calls = 0;
  const r = await retryWithBackoff(async () => {
    calls++;
    if (calls < 3) throw new Error('456 Client Error');
    return 'ok';
  }, { label: 't', attempts: 4, baseMs: 1, maxMs: 5, jitter: 0 });
  assert.equal(r, 'ok');
  assert.equal(calls, 3);
});

test('retryWithBackoff: 达上限后抛出带 cause 的错误', async () => {
  let calls = 0;
  await assert.rejects(
    retryWithBackoff(async () => { calls++; throw new Error('boom'); }, { label: 't', attempts: 3, baseMs: 1, maxMs: 5, jitter: 0 }),
    /failed after 3 attempt/
  );
  assert.equal(calls, 3);
});

test('retryWithBackoff: shouldRetry=false 立即停止', async () => {
  let calls = 0;
  await assert.rejects(
    retryWithBackoff(async () => { calls++; throw new Error('fatal'); }, {
      label: 't', attempts: 5, baseMs: 1, maxMs: 5, jitter: 0,
      shouldRetry: (e) => !/fatal/.test(e.message)
    }),
    /fatal/
  );
  assert.equal(calls, 1);
});

test('SourceCooldown: 连续失败达阈值后进入冷却，成功即清除', () => {
  const c = new SourceCooldown({ maxFailures: 2, windowMs: 60000 });
  assert.equal(c.coolingDown('sina'), false);
  c.recordFailure('sina');
  assert.equal(c.coolingDown('sina'), false);
  c.recordFailure('sina');
  assert.equal(c.coolingDown('sina'), true);
  assert.ok(c.remainingMs('sina') > 0);
  c.recordSuccess('sina');
  assert.equal(c.coolingDown('sina'), false);
});

test('SourceCooldown: 冷却到期自动清除', () => {
  const c = new SourceCooldown({ maxFailures: 1, windowMs: -1000 });
  c.recordFailure('sina');
  assert.equal(c.coolingDown('sina'), false); // 已过期
});
