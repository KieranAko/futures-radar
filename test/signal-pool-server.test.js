import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-server-'));
process.env.FUTURES_RUNTIME_ROOT = path.join(base, 'runtime');
process.env.FUTURES_SKILL_ROOT = process.cwd();

const { updateSignalPool, loadLedger, loadSignal } = require('../signals/lib/signal-pool.cjs');
const { startServer } = require('../signals/cli/signal-pool-server.cjs');

function makePlan(runId, symbol, overrides = {}) {
  const { signalDate = '2026-08-26', ...p } = overrides;
  return {
    meta: { runId, signalDate, inputsSha: 'x' },
    plans: [{
      symbol, name: symbol, contract: null, rank: 1, executionStatus: 'executable',
      reportBaseline: { direction: 'bullish', confidence: 'medium', driver: '测试驱动' },
      matchedStrategies: [{ strategyId: 'MS-01' }],
      playbook: { playbookId: 'PB-01' },
      entry: { trigger: '收盘站稳 100 上方', triggerLevel: 100, triggerSource: 'Q4', triggerTiming: 'T+1 收盘确认', execution: 'T+1 开盘', gapThresholdPts: 2, triggerStyle: 'close' },
      stop: { stopPrice: 95, basis: 'Q5' },
      targets: { t1: '110', t2: '120', basis: 'p68' },
      riskAssessment: { atr5: 5, maxHoldingDays: 2, regimeGrade: 'normal', regimeDirection: 'stable' },
      invalidation: { hard: ['收盘跌破 95'], timeStop: 'T+5' },
      ...p
    }]
  };
}

describe('signal-pool-server 一期服务壳', () => {
  it('health 返回服务状态；decisions POST 回填文件库；shutdown 退出', async () => {
    const poolRoot = path.join(base, 'pool');
    updateSignalPool({ runId: 'run-1', raw: { contracts: {} }, rootOverride: poolRoot, plan: makePlan('run-1', 'PP0') });
    updateSignalPool({ runId: 'run-2', raw: { contracts: {} }, rootOverride: poolRoot, plan: makePlan('run-2', 'PP0', { signalDate: '2026-08-27' }) });

    const { server, start } = startServer({ runId: 'run-2', root: poolRoot, render: false, port: 0, host: '127.0.0.1' });
    const addr = await start();
    server.unref();
    const port = addr.port;
    const baseUrl = `http://127.0.0.1:${port}`;

    const health = await (await fetch(`${baseUrl}/api/health`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.runId, 'run-2');
    assert.equal(health.port, port);

    const ledger = loadLedger(poolRoot);
    const sig = loadSignal(ledger.signals[0].signalId, poolRoot);
    const quote = sig.versions.find((v) => v.decision && v.decision.status === 'pending');
    assert.ok(quote);

    const doc = {
      schema: 'futures-radar-signal-decisions/1',
      runId: 'run-2',
      decisions: [{ signalId: sig.signalId, quoteVersionId: quote.versionId, action: 'adopt', reason: '服务端回填测试', decidedAt: '2026-08-27' }]
    };
    const res = await (await fetch(`${baseUrl}/api/decisions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(doc)
    })).json();
    assert.equal(res.ok, true);
    assert.equal(res.summary.adopt, 1);

    const updated = loadSignal(sig.signalId, poolRoot);
    assert.equal(updated.decisionRecords.length, 1);
    assert.equal(updated.decisionRecords[0].status, 'applied');
    assert.equal(updated.decisionRecords[0].reason, '服务端回填测试');

    const shut = await (await fetch(`${baseUrl}/api/service/shutdown`, { method: 'POST' })).json();
    assert.equal(shut.ok, true);
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  it('非法决策返回 400 与 details', async () => {
    const poolRoot = path.join(base, 'pool2');
    updateSignalPool({ runId: 'run-1', raw: { contracts: {} }, rootOverride: poolRoot, plan: makePlan('run-1', 'PP0') });
    const { server, start } = startServer({ runId: 'run-1', root: poolRoot, render: false, port: 0, host: '127.0.0.1' });
    const addr = await start();
    server.unref();
    const res = await (await fetch(`http://127.0.0.1:${addr.port}/api/decisions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ schema: 'futures-radar-signal-decisions/1', runId: 'run-1', decisions: [{ signalId: 'S', quoteVersionId: 'S:V1', action: 'adopt', reason: '' }] })
    })).json();
    assert.equal(res.ok, false);
    assert.ok(Array.isArray(res.details));
    await new Promise((resolve) => {
      if (server.closeAllConnections) server.closeAllConnections();
      server.close(resolve);
    });
  });
});
