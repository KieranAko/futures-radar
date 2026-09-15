import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  updateSignalPool,
  loadLedger,
  loadSignal,
  buildView,
  transitionLabel,
  q5Triggered,
  computeVerdict
} = require('../strategies/lib/signal-pool.cjs');

function makePlan(runId, symbol, overrides = {}) {
  return {
    meta: { runId, signalDate: '2026-08-26', inputsSha: 'x', generatedAt: '2026-08-26T00:00:00Z' },
    plans: [{
      symbol,
      name: symbol,
      contract: null,
      rank: 1,
      executionStatus: 'executable',
      reportBaseline: { direction: 'bullish', confidence: 'medium', driver: '测试驱动' },
      matchedStrategies: [{ strategyId: 'MS-01', name: 'x' }],
      playbook: { playbookId: 'PB-01', gateStatus: 'pass' },
      entry: { trigger: '收盘站稳 100 上方', triggerLevel: 100, triggerSource: 'Q4', triggerTiming: 'T+1 收盘确认；确认后下一交易日开盘执行', execution: 'T+1 开盘', gapThresholdPts: 2, triggerStyle: 'close' },
      stop: { stopPrice: 95, stopDistancePts: 5, basis: 'Q5 收盘跌破 95' },
      targets: { t1: '110（50%）', t2: '2R', basis: 'p68' },
      riskAssessment: { atr5: 5, maxHoldingDays: 2, regimeGrade: 'normal', regimeDirection: 'stable' },
      invalidation: { hard: ['收盘跌破 95'], timeStop: 'T+5' },
      ...overrides
    }]
  };
}

function makeRaw(symbol, dates, open, high, low, close) {
  return {
    contracts: {
      [symbol]: {
        ohlcv: { dates, open, high, low, close, volume: dates.map(() => 1000) }
      }
    }
  };
}

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fr-signal-pool-'));
}

describe('signal-pool 信号池核心生命周期', () => {
  it('入池：executable 策略创建信号，V1 即首个版本', () => {
    const root = tmpRoot();
    try {
      const plan = makePlan('run-1', 'PP0');
      const raw = makeRaw('PP0', ['2026-08-24', '2026-08-25', '2026-08-26'], [98, 99, 100], [100, 101, 102], [97, 98, 99], [100, 100, 100]);
      const { view, meta } = updateSignalPool({ runId: 'run-1', raw, rootOverride: root, plan });
      assert.equal(meta.createdThisRun, 1);
      assert.equal(view.pool.length, 1);
      const sig = loadSignal(view.pool[0].signalId, root);
      assert.equal(sig.poolStatus, 'active');
      assert.equal(sig.versions.length, 1);
      assert.equal(sig.versions[0].versionId, `${sig.signalId}:V1`);
      assert.equal(sig.versions[0].stateTransition, 'signal_created');
      assert.match(sig.signalId, /^SIG-PP0-20260826-\d{2}$/);
      const ledger = loadLedger(root);
      assert.equal(ledger.signals.length, 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('watch/skip 无主信号不入池，只写 observation', () => {
    const root = tmpRoot();
    try {
      const plan = makePlan('run-1', 'MA0', { executionStatus: 'watch' });
      const raw = { contracts: {} };
      const { view } = updateSignalPool({ runId: 'run-1', raw, rootOverride: root, plan });
      assert.equal(view.pool.length, 0);
      const obsFile = path.join(root, 'observations', 'run-1.json');
      assert.ok(fs.existsSync(obsFile));
      const obs = JSON.parse(fs.readFileSync(obsFile, 'utf8'));
      assert.equal(obs.length, 1);
      assert.equal(obs[0].executionStatus, 'watch');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('追踪：同向后续 plan 追加版本，状态转移正确（维持/降级/升级/维持观察）', () => {
    const root = tmpRoot();
    try {
      const raw = { contracts: {} };
      updateSignalPool({ runId: 'run-1', raw, rootOverride: root, plan: makePlan('run-1', 'PP0') });
      const { view } = updateSignalPool({
        runId: 'run-2', raw, rootOverride: root,
        plan: makePlan('run-2', 'PP0', { executionStatus: 'watch' })
      });
      assert.equal(view.pool.length, 1);
      let sig = loadSignal(view.pool[0].signalId, root);
      assert.equal(sig.versions.length, 2);
      assert.equal(sig.versions[1].stateTransition, '降级观察');
      assert.equal(sig.poolStatus, 'downgraded');
      assert.equal(sig.consecutiveNonExecutable, 1);

      updateSignalPool({ runId: 'run-3', raw, rootOverride: root, plan: makePlan('run-3', 'PP0', { executionStatus: 'skip' }) });
      sig = loadSignal(sig.signalId, root);
      assert.equal(sig.versions[2].stateTransition, '维持观察');
      assert.equal(sig.consecutiveNonExecutable, 2);

      updateSignalPool({ runId: 'run-4', raw, rootOverride: root, plan: makePlan('run-4', 'PP0') });
      sig = loadSignal(sig.signalId, root);
      assert.equal(sig.versions[3].stateTransition, '升级执行');
      assert.equal(sig.poolStatus, 'active');
      assert.equal(sig.consecutiveNonExecutable, 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('反向 executable 翻转：旧信号 closed(flipped)，新信号入池', () => {
    const root = tmpRoot();
    try {
      const raw = { contracts: {} };
      updateSignalPool({ runId: 'run-1', raw, rootOverride: root, plan: makePlan('run-1', 'PP0') });
      const { view } = updateSignalPool({
        runId: 'run-2', raw, rootOverride: root,
        plan: makePlan('run-2', 'PP0', {
          reportBaseline: { direction: 'bearish', confidence: 'medium', driver: '反转向下' }
        })
      });
      assert.equal(view.pool.length, 1);
      const ledger = loadLedger(root);
      assert.equal(ledger.signals.length, 2);
      const oldId = ledger.signals[0].signalId;
      const old = loadSignal(oldId, root);
      assert.equal(old.poolStatus, 'closed');
      assert.equal(old.closeReason, 'flipped');
      const newId = ledger.signals.find((s) => s.signalId !== oldId).signalId;
      const neu = loadSignal(newId, root);
      assert.equal(neu.direction, 'bearish');
      assert.equal(neu.poolStatus, 'active');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('skip 版本验证为 suppressed，不进入交易模拟', () => {
    const root = tmpRoot();
    try {
      const raw = makeRaw('PP0', ['2026-08-24', '2026-08-25', '2026-08-26'], [98, 99, 100], [100, 101, 102], [97, 98, 99], [100, 100, 100]);
      updateSignalPool({ runId: 'run-1', raw, rootOverride: root, plan: makePlan('run-1', 'PP0') });
      updateSignalPool({ runId: 'run-2', raw, rootOverride: root, plan: makePlan('run-2', 'PP0', { executionStatus: 'skip' }) });
      const ledger = loadLedger(root);
      const sig = loadSignal(ledger.signals[0].signalId, root);
      assert.equal(sig.versions.length, 2);
      // 本期 skip 版本下期才验证；追加第三期后 V2 应 suppressed
      updateSignalPool({ runId: 'run-3', raw, rootOverride: root, plan: makePlan('run-3', 'PP0') });
      const sig2 = loadSignal(ledger.signals[0].signalId, root);
      const v2 = sig2.versions[1];
      assert.equal(v2.verification.status, 'suppressed');
      assert.equal(v2.verification.terminal, true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('价格追踪：bullish 记录最大有利/不利偏移', () => {
    const root = tmpRoot();
    try {
      const raw = makeRaw('PP0',
        ['2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27'],
        [98, 99, 100, 102], [100, 101, 102, 106], [97, 98, 99, 100], [100, 100, 100, 103]);
      const plan = makePlan('run-1', 'PP0');
      updateSignalPool({ runId: 'run-1', raw, rootOverride: root, plan });
      const ledger = loadLedger(root);
      const sig = loadSignal(ledger.signals[0].signalId, root);
      assert.equal(sig.startClose, 100);
      assert.equal(sig.maxFavorablePts, 6); // 106-100
      assert.equal(sig.maxAdversePts, -1); // 99-100
      assert.equal(sig.latestClose, 103);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('Q5 收盘跌破触发 invalidated_q5 出池', () => {
    const root = tmpRoot();
    try {
      const raw = makeRaw('PP0',
        ['2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27'],
        [98, 99, 100, 99], [100, 101, 102, 100], [97, 98, 99, 93], [100, 100, 100, 94]);
      updateSignalPool({ runId: 'run-1', raw, rootOverride: root, plan: makePlan('run-1', 'PP0') });
      const ledger = loadLedger(root);
      const sig = loadSignal(ledger.signals[0].signalId, root);
      assert.equal(sig.poolStatus, 'closed');
      assert.equal(sig.closeReason, 'invalidated_q5');
      assert.ok(['hit', 'miss', 'unresolved'].includes(sig.verdict));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('连续 3 期非 executable 且价格无进展 → faded 出池', () => {
    const root = tmpRoot();
    try {
      const raw = { contracts: {} };
      updateSignalPool({ runId: 'run-1', raw, rootOverride: root, plan: makePlan('run-1', 'PP0') });
      updateSignalPool({ runId: 'run-2', raw, rootOverride: root, plan: makePlan('run-2', 'PP0', { executionStatus: 'watch' }) });
      updateSignalPool({ runId: 'run-3', raw, rootOverride: root, plan: makePlan('run-3', 'PP0', { executionStatus: 'watch' }) });
      const { view } = updateSignalPool({ runId: 'run-4', raw, rootOverride: root, plan: makePlan('run-4', 'PP0', { executionStatus: 'watch' }) });
      assert.equal(view.pool.length, 0);
      const ledger = loadLedger(root);
      const sig = loadSignal(ledger.signals[0].signalId, root);
      assert.equal(sig.poolStatus, 'closed');
      assert.equal(sig.closeReason, 'faded');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('过期出池：超过 10 个交易日硬上限', () => {
    const root = tmpRoot();
    try {
      const dates = [];
      const open = [], high = [], low = [], close = [];
      const start = new Date('2026-08-26T00:00:00Z');
      for (let i = 0; i < 13; i++) {
        const d = new Date(start.getTime() + i * 86400000);
        dates.push(d.toISOString().slice(0, 10));
        open.push(100 + i); high.push(102 + i); low.push(99 + i); close.push(101 + i);
      }
      const raw = makeRaw('PP0', dates, open, high, low, close);
      updateSignalPool({ runId: 'run-1', raw, rootOverride: root, plan: makePlan('run-1', 'PP0') });
      const ledger = loadLedger(root);
      const sig = loadSignal(ledger.signals[0].signalId, root);
      assert.equal(sig.poolStatus, 'closed');
      assert.equal(sig.closeReason, 'expired');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('幂等：同一 run 重复执行不重复追加版本', () => {
    const root = tmpRoot();
    try {
      const raw = { contracts: {} };
      updateSignalPool({ runId: 'run-1', raw, rootOverride: root, plan: makePlan('run-1', 'PP0') });
      updateSignalPool({ runId: 'run-2', raw, rootOverride: root, plan: makePlan('run-2', 'PP0', { executionStatus: 'watch' }) });
      updateSignalPool({ runId: 'run-2', raw, rootOverride: root, plan: makePlan('run-2', 'PP0', { executionStatus: 'watch' }) });
      const ledger = loadLedger(root);
      const sig = loadSignal(ledger.signals[0].signalId, root);
      assert.equal(sig.versions.length, 2);
      assert.equal(sig.versions.filter((v) => v.runId === 'run-2').length, 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('视图：池内全量 + 最近出池 5 个 + 历史统计', () => {
    const root = tmpRoot();
    try {
      const raw = { contracts: {} };
      // 创建 7 个信号（不同品种），逐个翻转出池
      const symbols = ['A0', 'B0', 'C0', 'D0', 'E0', 'F0', 'G0'];
      for (const s of symbols) {
        updateSignalPool({ runId: `run-${s}`, raw, rootOverride: root, plan: makePlan(`run-${s}`, s) });
        updateSignalPool({
          runId: `run-${s}-flip`, raw, rootOverride: root,
          plan: makePlan(`run-${s}-flip`, s, { reportBaseline: { direction: 'bearish', confidence: 'medium', driver: '翻转' } })
        });
      }
      const ledger = loadLedger(root);
      const view = buildView('final', ledger, root);
      assert.equal(view.pool.length, 7); // 翻转后新信号在池
      assert.equal(view.recentClosed.length, 5);
      assert.equal(view.historyStats.totalClosed, 7);
      assert.equal(view.historyStats.byCloseReason.flipped, 7);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
