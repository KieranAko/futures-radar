import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { recordExecutablePlans, verifyPlans } = require('../strategies/lib/feedback.cjs');

function makePlan(runId, symbol, overrides = {}) {
  return {
    meta: { runId, signalDate: '2026-08-26', inputsSha: 'x' },
    plans: [{
      symbol,
      name: symbol,
      contract: null,
      executionStatus: 'executable',
      reportBaseline: { direction: 'bullish', confidence: 'medium' },
      matchedStrategies: [{ strategyId: 'CS-06', name: 'x' }],
      playbook: { playbookId: 'PB-07' },
      entry: { trigger: '收盘站稳 100 上方', triggerLevel: 100, triggerTiming: 'T+1 收盘确认；确认后下一交易日开盘执行' },
      stop: { stopPrice: 95, stopDistancePts: 5 },
      targets: { t1: '110（50%）', t2: '2R' },
      riskAssessment: { maxHoldingDays: 2 },
      invalidation: { hard: ['跌破95'] },
      ...overrides
    }]
  };
}

describe('strategy-feedback 证伪反馈机制', () => {
  it('只冻结 executable 计划，不记录 watch/skip', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-feedback-'));
    try {
      const plan = makePlan('run-exec', 'RM0');
      const n = recordExecutablePlans(plan, '2026-08-26T00:00:00Z', root);
      assert.equal(n, 1);
      const watchPlan = makePlan('run-watch', 'MA0', { executionStatus: 'watch' });
      assert.equal(recordExecutablePlans(watchPlan, '2026-08-26T00:00:00Z', root), 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('触发后止损离场：验证 stopped_out + 方向错误归因', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-feedback-'));
    try {
      recordExecutablePlans(makePlan('run-prev', 'RM0'), '2026-08-26T00:00:00Z', root);
      const raw = {
        contracts: {
          RM0: {
            ohlcv: {
              dates: ['2026-08-26', '2026-08-27', '2026-08-28'],
              open: [98, 102, 99], high: [101, 103, 99], low: [97, 99, 94], close: [100, 101, 95]
            }
          }
        }
      };
      const out = verifyPlans('run-next', raw, root);
      const r = out.results[0];
      assert.equal(r.status, 'verified');
      assert.equal(r.exitType, 'stopped_out');
      assert.equal(r.directionCorrect, false);
      assert.ok(r.attribution.some(a => a.code === 'stop_hit'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('T+1 未触发 → invalidated_not_triggered', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-feedback-'));
    try {
      recordExecutablePlans(makePlan('run-prev', 'RM0'), '2026-08-26T00:00:00Z', root);
      const raw = {
        contracts: {
          RM0: {
            ohlcv: {
              dates: ['2026-08-26', '2026-08-27'],
              open: [98, 99], high: [101, 99.5], low: [97, 98], close: [100, 99]
            }
          }
        }
      };
      const out = verifyPlans('run-next', raw, root);
      assert.equal(out.results[0].status, 'invalidated_not_triggered');
      assert.ok(out.results[0].attribution.some(a => a.code === 'trigger_miss'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
