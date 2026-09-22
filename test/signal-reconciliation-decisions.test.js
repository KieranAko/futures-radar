import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { validateReconciliation } = require('../signals/reconciliation/ticket-reconciliation-lib.cjs');
const { validateDecisions } = require('../signals/decisions/signal-decision-lib.cjs');
const { updateSignalPool, loadLedger, loadSignal } = require('../signals/lib/signal-pool.cjs');
const { buildPrompt, applyReconciliation } = require('../signals/cli/signal-reconcile-cli.cjs');

describe('ticket-reconciliation 对账结果契约', () => {
  it('合法对账输出通过', () => {
    const doc = {
      schema: 'futures-radar-ticket-reconciliation/1',
      runId: 'r1',
      signals: [{
        signalId: 'SIG-RB0-20260918-01',
        quotes: [{
          versionId: 'SIG-RB0-20260918-01:V2',
          summary: '新旧两份交易单在止损与目标上存在差异。',
          conflicts: [
            { field: 'stop.stopPrice', severity: 'attention', explanation: '旧单止损 3140，新单止损 3132，交易员对上方容忍空间收紧。' }
          ]
        }]
      }]
    };
    assert.deepEqual(validateReconciliation(doc), { ok: true, errors: [] });
  });

  it('缺解释文字/缺 severity → 拒绝', () => {
    const doc = {
      schema: 'futures-radar-ticket-reconciliation/1',
      runId: 'r1',
      signals: [{ signalId: 'S', quotes: [{ versionId: 'S:V2', summary: '', conflicts: [] }] }]
    };
    const r = validateReconciliation(doc);
    assert.equal(r.ok, false);
    assert.ok(r.errors.length >= 1);
  });
});

describe('signal-decisions 人类决策契约', () => {
  it('合法决策通过', () => {
    const doc = {
      schema: 'futures-radar-signal-decisions/1',
      runId: 'r1',
      decisions: [{
        signalId: 'SIG-RB0-20260918-01',
        quoteVersionId: 'SIG-RB0-20260918-01:V2',
        action: 'adopt',
        reason: '新单止损收紧更符合当前波动率'
      }]
    };
    assert.deepEqual(validateDecisions(doc), { ok: true, errors: [] });
  });

  it('缺理由或非法 action → 拒绝', () => {
    const doc = {
      schema: 'futures-radar-signal-decisions/1',
      runId: 'r1',
      decisions: [{ signalId: 'S', quoteVersionId: 'S:V2', action: 'adopt', reason: '' }]
    };
    const r = validateDecisions(doc);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes('reason')));
  });
});

describe('signal-reconcile-cli 提示词与回填', () => {
  function makePlan(runId, symbol, overrides = {}) {
    const { signalDate = '2026-08-26', ...p } = overrides;
    return {
      meta: { runId, signalDate, inputsSha: 'x' },
      plans: [{
        symbol, name: symbol, contract: null, rank: 1, executionStatus: 'executable',
        reportBaseline: { direction: 'bearish', confidence: 'medium', driver: '测试驱动' },
        matchedStrategies: [{ strategyId: 'MS-01' }],
        playbook: { playbookId: 'PB-01' },
        entry: { trigger: '反抽不破', triggerLevel: 100, triggerSource: 'Q4', triggerTiming: 'T+1 收盘确认', execution: 'T+2 开盘', gapThresholdPts: 2, triggerStyle: 'close', triggerMode: 'pullback' },
        stop: { stopPrice: 105, basis: '收盘站上 105' },
        targets: { t1: '90', t2: '80', basis: '区间下沿' },
        riskAssessment: { atr5: 5, maxHoldingDays: 3, regimeGrade: 'normal', regimeDirection: 'stable' },
        invalidation: { hard: ['收盘站上 105'], timeStop: 'T+4' },
        ...p
      }]
    };
  }

  it('buildPrompt 并列 livingTicket 与新报价并包含 diff；apply 回填 reconciliation', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-recon-'));
    try {
      updateSignalPool({ runId: 'run-1', raw: { contracts: {} }, rootOverride: root, plan: makePlan('run-1', 'RB0') });
      updateSignalPool({ runId: 'run-2', raw: { contracts: {} }, rootOverride: root, plan: makePlan('run-2', 'RB0', { signalDate: '2026-08-27', stop: { stopPrice: 104, basis: '收盘站上 104' } }) });
      const { prompt, quoteCount } = buildPrompt('run-2', root);
      assert.equal(quoteCount, 1);
      assert.ok(prompt.includes('当前有效交易单（livingTicket'));
      assert.ok(prompt.includes('新报价'));
      assert.ok(prompt.includes('stop.stopPrice'));
      assert.ok(prompt.includes('禁止'));

      const ledger = loadLedger(root);
      const sig = loadSignal(ledger.signals[0].signalId, root);
      const quote = sig.versions.find((v) => v.decision && v.decision.status === 'pending');
      const file = path.join(root, 'reconcile-output.json');
      const doc = {
        schema: 'futures-radar-ticket-reconciliation/1',
        runId: 'run-2',
        signals: [{
          signalId: sig.signalId,
          quotes: [{
            versionId: quote.versionId,
            summary: '新旧报价仅止损不同，新报价把失效线收紧 1 点。',
            conflicts: [{ field: 'stop.stopPrice', severity: 'attention', explanation: '交易员对上方容忍空间收紧。' }]
          }]
        }]
      };
      fs.writeFileSync(file, JSON.stringify(doc), 'utf8');
      applyReconciliation('run-2', file, root);
      const updated = loadSignal(sig.signalId, root);
      const q = updated.versions.find((v) => v.versionId === quote.versionId);
      assert.ok(q.reconciliation);
      assert.equal(q.reconciliation.summary, doc.signals[0].quotes[0].summary);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
