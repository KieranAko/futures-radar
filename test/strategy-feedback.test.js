import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { recordExecutablePlans, verifyPlans, verifyIncremental } = require('../strategies/lib/feedback.cjs');

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
  it('全策略口径：executable 与 watch 均进入证伪账本', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-feedback-'));
    try {
      const plan = makePlan('run-exec', 'RM0');
      assert.equal(recordExecutablePlans(plan, '2026-08-26T00:00:00Z', root), 1);
      const watchPlan = makePlan('run-watch', 'MA0', { executionStatus: 'watch' });
      assert.equal(recordExecutablePlans(watchPlan, '2026-08-26T00:00:00Z', root), 1);
      const raw = { contracts: {} };
      const out = verifyIncremental('run-next', raw, root);
      assert.equal(out.summary.totalPlans, 2);
      assert.equal(out.summary.byExecutionStatus.executable, 1);
      assert.equal(out.summary.byExecutionStatus.watch, 1);
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

  it('增量验证：已终态记录在后续 run 不再被重复验证', () => {
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
      const first = verifyIncremental('run-next', raw, root);
      assert.equal(first.summary.terminalPlans, 1);
      const second = verifyIncremental('run-next-2', raw, root);
      assert.equal(second.meta.incrementalAttempted, 0, '终态记录不应再被增量验证');
      assert.equal(second.summary.totalPlans, 1);
      assert.equal(second.summary.terminalPlans, 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('中性观察策略使用信号模式验证：确认信号兑现 → confirmed', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-feedback-'));
    try {
      recordExecutablePlans(makePlan('run-neutral', 'SA0', {
        executionStatus: 'watch',
        reportBaseline: {
          direction: 'neutral',
          confidence: 'low',
          confirmSignals: ['收盘站稳 100 上方且量能维持 1.2x 以上→多头延续']
        },
        entry: {
          trigger: '→ 中性：收盘站稳 100 上方且量能维持 1.2x 以上→多头延续',
          triggerLevel: 100,
          triggerSource: '收盘站稳 100 上方且量能维持 1.2x 以上→多头延续',
          triggerTiming: '无执行时点（观察）',
          execution: 'T+1 收盘确认；确认后下一交易日开盘执行'
        },
        position: { lots: 0 }
      }), '2026-08-26T00:00:00Z', root);
      const raw = {
        contracts: {
          SA0: {
            ohlcv: {
              dates: ['2026-08-26', '2026-08-27', '2026-08-28'],
              open: [100, 100, 101], high: [101, 100, 103], low: [99, 98, 100], close: [100, 99, 102]
            }
          }
        }
      };
      const out = verifyIncremental('run-next', raw, root);
      const row = out.recentRuns[0].rows[0];
      assert.equal(row.verificationMode, 'signal');
      assert.equal(row.status, 'confirmed');
      assert.equal(out.summary.byStatus.confirmed, 1);
      assert.equal(out.summary.byMode.signal.total, 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('非价格目标文本（如 3d p68）不会被误解析成价格 3', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-feedback-'));
    try {
      const plan = makePlan('run-target', 'RM0', {
        entry: { trigger: '收盘站稳 100 上方', triggerLevel: 100, triggerTiming: 'T+1 收盘确认；确认后下一交易日开盘执行' },
        targets: { t1: '前高/前低 或 3d p68 沿（先到者，平 50%）', t2: '2R–3R' }
      });
      recordExecutablePlans(plan, '2026-08-26T00:00:00Z', root);
      const raw = {
        contracts: {
          RM0: {
            ohlcv: {
              dates: ['2026-08-26', '2026-08-27', '2026-08-28', '2026-08-29'],
              open: [98, 102, 101, 101], high: [101, 103, 102, 102], low: [97, 99, 96, 96], close: [100, 101, 100, 101]
            }
          }
        }
      };
      const out = verifyPlans('run-next', raw, root);
      const r = out.results[0];
      assert.equal(r.status, 'verified');
      assert.notEqual(r.exitPrice, 3);
      assert.ok(r.exitPrice > 90, 'exit price should be a real price, not parsed indicator number');
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
