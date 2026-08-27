import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { recordExecutablePlans, verifyPlans, buildHistoricalPlan } = require('../strategies/lib/feedback.cjs');

const FIXTURE = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'reasoning', 'test', 'fixtures', 'sa2701-history.json'), 'utf8'));
const BARS = FIXTURE.bars;
const SIGNAL_DATE = BARS[58].date; // 预留 6 根未来 bar 用于验证

function rawFromBars(bars, symbol = 'SA0') {
  return {
    contracts: {
      [symbol]: {
        ohlcv: {
          dates: bars.map(b => b.date),
          open: bars.map(b => b.open),
          high: bars.map(b => b.high),
          low: bars.map(b => b.low),
          close: bars.map(b => b.close)
        }
      }
    }
  };
}

describe('strategy-feedback 截断交易日回测', () => {
  it('buildHistoricalPlan 严格只读 signalDate 及之前的数据（截断/全量结果一致）', () => {
    const idx = BARS.findIndex(b => b.date === SIGNAL_DATE);
    const truncated = BARS.slice(0, idx + 1);
    const planFromTruncated = buildHistoricalPlan(truncated, SIGNAL_DATE);
    const planFromFull = buildHistoricalPlan(BARS, SIGNAL_DATE);
    assert.deepEqual(planFromFull, planFromTruncated);
  });

  it('用截断计划在完整未来数据上完成一次证伪回测', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-feedback-backtest-'));
    try {
      const idx = BARS.findIndex(b => b.date === SIGNAL_DATE);
      const hp = buildHistoricalPlan(BARS.slice(0, idx + 1), SIGNAL_DATE);
      const plan = {
        meta: { runId: 'bt-truncated', signalDate: SIGNAL_DATE, inputsSha: 'bt' },
        plans: [{
          symbol: 'SA0',
          name: '纯碱',
          contract: null,
          executionStatus: 'executable',
          reportBaseline: { direction: hp.direction, confidence: 'medium' },
          matchedStrategies: [{ strategyId: 'PB-01', name: '趋势动量延续' }],
          playbook: { playbookId: 'PB-07' },
          entry: {
            trigger: `${hp.direction === 'bullish' ? '↑ 多' : '↓ 空'}：收盘触发 ${hp.triggerLevel}`,
            triggerLevel: hp.triggerLevel,
            triggerTiming: hp.triggerTiming
          },
          stop: { stopPrice: hp.stopPrice, stopDistancePts: 1.5 * hp.atr5 },
          targets: { t1: hp.target1Text, t2: '2R' },
          riskAssessment: { maxHoldingDays: 5 },
          invalidation: { hard: [`跌破 ${hp.stopPrice}`] }
        }]
      };
      recordExecutablePlans(plan, '2026-08-27T00:00:00Z', root);
      const out = verifyPlans('bt-next', rawFromBars(BARS), root);
      assert.equal(out.results.length, 1);
      const r = out.results[0];
      assert.ok(['verified', 'invalidated_not_triggered', 'triggered_pending_entry', 'skipped_gap'].includes(r.status), r.status);
      if (r.status === 'invalidated_not_triggered') {
        assert.ok(r.attribution.some(a => a.code === 'trigger_miss'));
      }
      if (r.status === 'verified') {
        assert.ok(['stopped_out', 'target1_hit', 'time_exit'].includes(r.exitType));
        assert.ok(typeof r.directionCorrect === 'boolean');
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
