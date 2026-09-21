import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { recordExecutablePlans, verifyPlans, verifyIncremental, verifyTradeRecord } = require('../analysis/strategy/feedback.cjs');

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

  it('pullback 触发：反抽未到触发位附近不作数，必须盘中触位且收盘不破位', () => {
    const record = {
      recordId: 'pullback-test',
      symbol: 'RM0',
      name: 'RM0',
      contract: null,
      direction: 'bearish',
      verificationMode: 'trade',
      signalDate: '2026-08-26',
      executionStatus: 'executable',
      triggerLevel: 100,
      triggerMode: 'pullback',
      triggerStyle: 'close',
      atr5: 10,
      stopPrice: 105,
      target1Text: '90',
      gapThresholdPts: 5,
      maxHoldingDays: 3
    };
    const baseRaw = (dates, open, high, low, close) => ({
      contracts: { RM0: { ohlcv: { dates, open, high, low, close } } }
    });
    // T+1 盘中从未反弹到 95（触发位 100 附近）→ 不算触发
    const miss = verifyTradeRecord(record, baseRaw(
      ['2026-08-26', '2026-08-27'],
      [98, 92], [101, 93], [97, 90], [100, 91]
    ), 'next', new Map());
    assert.equal(miss.status, 'invalidated_not_triggered');
    assert.match(miss.attribution[0].detail, /反抽\/回踩不破未成立/);

    // T+1 反抽至 99（进入 100 下方 0.5×ATR 范围）且收盘 98 仍在下 → 触发成立
    const hit = verifyTradeRecord(record, baseRaw(
      ['2026-08-26', '2026-08-27'],
      [98, 96], [101, 99.5], [97, 95.5], [100, 98]
    ), 'next', new Map());
    assert.equal(hit.status, 'triggered_pending_entry');
  });

  it('入场价越过止损直接放弃：空头不得高于止损，多头不得低于止损', () => {
    const baseRecord = {
      recordId: 'stop-cap',
      symbol: 'RM0',
      name: 'RM0',
      contract: null,
      verificationMode: 'trade',
      signalDate: '2026-08-26',
      executionStatus: 'executable',
      triggerLevel: 100,
      triggerMode: 'pullback',
      triggerStyle: 'close',
      atr5: 10,
      stopPrice: 105,
      target1Text: '90',
      gapThresholdPts: 5,
      maxHoldingDays: 3
    };
    const raw = {
      contracts: {
        RM0: {
          ohlcv: {
            dates: ['2026-08-26', '2026-08-27', '2026-08-28'],
            open: [98, 96, 106], high: [101, 99.5, 107], low: [97, 95.5, 104], close: [100, 98, 105.5]
          }
        }
      }
    };
    const short = verifyTradeRecord({ ...baseRecord, direction: 'bearish' }, raw, 'next', new Map());
    assert.equal(short.status, 'skipped_gap');
    assert.match(short.attribution[0].detail, /越过止损/);
    const longRaw = {
      contracts: {
        RM0: {
          ohlcv: {
            dates: ['2026-08-26', '2026-08-27', '2026-08-28'],
            open: [98, 102, 94], high: [101, 103, 95], low: [97, 100, 92], close: [100, 102, 93]
          }
        }
      }
    };
    const long = verifyTradeRecord({ ...baseRecord, direction: 'bullish', triggerLevel: 100 }, longRaw, 'next', new Map());
    assert.equal(long.status, 'skipped_gap');
    assert.match(long.attribution[0].detail, /越过止损/);
  });
});
