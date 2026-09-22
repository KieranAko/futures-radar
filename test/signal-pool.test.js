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
  saveSignal,
  buildView,
  transitionLabel,
  q5Triggered,
  computeVerdict
} = require('../signals/lib/signal-pool.cjs');

function makePlan(runId, symbol, overrides = {}) {
  const { signalDate = '2026-08-26', ...planOverrides } = overrides;
  return {
    meta: { runId, signalDate, inputsSha: 'x', generatedAt: `${signalDate}T00:00:00Z` },
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
      ...planOverrides
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

  it('追踪：同向后续 plan 追加版本；可执行新报价不自动采纳，只有人类采纳后才重置降级计数', () => {
    const root = tmpRoot();
    try {
      const raw = { contracts: {} };
      updateSignalPool({ runId: 'run-1', raw, rootOverride: root, plan: makePlan('run-1', 'PP0') });
      const { view } = updateSignalPool({
        runId: 'run-2', raw, rootOverride: root,
        plan: makePlan('run-2', 'PP0', { signalDate: '2026-08-27', executionStatus: 'watch' })
      });
      assert.equal(view.pool.length, 1);
      let sig = loadSignal(view.pool[0].signalId, root);
      assert.equal(sig.versions.length, 2);
      assert.equal(sig.versions[1].stateTransition, '降级观察');
      assert.equal(sig.poolStatus, 'downgraded');
      assert.equal(sig.consecutiveNonExecutable, 1);

      updateSignalPool({ runId: 'run-3', raw, rootOverride: root, plan: makePlan('run-3', 'PP0', { signalDate: '2026-08-28', executionStatus: 'skip' }) });
      sig = loadSignal(sig.signalId, root);
      assert.equal(sig.versions[2].stateTransition, '维持观察');
      assert.equal(sig.consecutiveNonExecutable, 2);

      updateSignalPool({ runId: 'run-4', raw, rootOverride: root, plan: makePlan('run-4', 'PP0', { signalDate: '2026-08-29' }) });
      sig = loadSignal(sig.signalId, root);
      assert.equal(sig.versions[3].stateTransition, '升级执行');
      assert.equal(sig.versions[3].decision.status, 'pending');
      assert.equal(sig.livingVersionId, `${sig.signalId}:V1`);
      assert.equal(sig.poolStatus, 'active');
      assert.equal(sig.consecutiveNonExecutable, 2); // 未采纳前不重置
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('反向 executable：只记录 conflicted 新报价待人类决策，不自动翻转关闭旧信号', () => {
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
      assert.equal(ledger.signals.length, 1);
      const old = loadSignal(ledger.signals[0].signalId, root);
      assert.equal(old.poolStatus, 'active');
      assert.equal(old.closeReason, null);
      assert.equal(old.versions.length, 2);
      const quote = old.versions[1];
      assert.equal(quote.decision.status, 'pending');
      assert.equal(quote.diff.relation, 'conflicted');
      assert.ok(quote.diff.changedFields.some((d) => d.field === 'direction'));
      assert.equal(old.livingVersionId, `${old.signalId}:V1`);
      assert.equal(old.direction, 'bullish'); // livingTicket 仍是出生单方向
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('skip 版本验证为 suppressed，不进入交易模拟', () => {
    const root = tmpRoot();
    try {
      const raw = makeRaw('PP0',
        ['2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27', '2026-08-28'],
        [98, 99, 100, 100, 100], [100, 101, 102, 102, 102], [97, 98, 99, 99, 99], [100, 100, 100, 100, 100]);
      updateSignalPool({ runId: 'run-1', raw, rootOverride: root, plan: makePlan('run-1', 'PP0') });
      updateSignalPool({ runId: 'run-2', raw, rootOverride: root, plan: makePlan('run-2', 'PP0', { signalDate: '2026-08-27', executionStatus: 'skip' }) });
      const ledger = loadLedger(root);
      const sig = loadSignal(ledger.signals[0].signalId, root);
      assert.equal(sig.versions.length, 2);
      // 本期 skip 版本下期才验证；追加第三期后 V2 应 suppressed
      updateSignalPool({ runId: 'run-3', raw, rootOverride: root, plan: makePlan('run-3', 'PP0', { signalDate: '2026-08-28' }) });
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
      assert.equal(sig.verdict, 'invalidated');
      assert.ok(sig.fulfillProgress < 1);
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
        open.push(100); high.push(101); low.push(99); close.push(100);
      }
      const raw = makeRaw('PP0', dates, open, high, low, close);
      updateSignalPool({ runId: 'run-1', raw, rootOverride: root, plan: makePlan('run-1', 'PP0') });
      updateSignalPool({ runId: 'run-2', raw, rootOverride: root, plan: { meta: { runId: 'run-2', signalDate: '2026-08-27', inputsSha: 'x' }, plans: [] } });
      const ledger = loadLedger(root);
      const sig = loadSignal(ledger.signals[0].signalId, root);
      assert.equal(sig.poolStatus, 'closed');
      assert.equal(sig.closeReason, 'expired');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('T+2 已入场但数据未到 T+5 → holding（持仓中），不提前时间离场', () => {
    const root = tmpRoot();
    try {
      const raw = makeRaw('PP0',
        ['2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27', '2026-08-28'],
        [98, 99, 100, 101, 102], [100, 101, 103, 104, 105], [97, 98, 99, 100, 101], [100, 100, 100, 101, 103]);
      const plan = makePlan('run-1', 'PP0', { riskAssessment: { atr5: 5, maxHoldingDays: 5, regimeGrade: 'normal', regimeDirection: 'stable' } });
      updateSignalPool({ runId: 'run-1', raw, rootOverride: root, plan });
      updateSignalPool({ runId: 'run-2', raw, rootOverride: root, plan: { meta: { runId: 'run-2', signalDate: '2026-08-27', inputsSha: 'x' }, plans: [] } });
      const ledger = loadLedger(root);
      const sig = loadSignal(ledger.signals[0].signalId, root);
      const v1 = sig.versions[0];
      assert.equal(v1.verification.status, 'holding');
      assert.equal(v1.verification.terminal, false);
      assert.equal(v1.verification.lastResult.entryPrice, 102);
      assert.equal(v1.verification.lastResult.triggerDate, '2026-08-27');
      assert.equal(v1.verification.lastResult.entryDate, '2026-08-28');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('价格偏移不自动兑现：executable 版本未命中目标1则继续追踪', () => {
    const root = tmpRoot();
    try {
      const raw = makeRaw('PP0',
        ['2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27', '2026-08-28'],
        [98, 99, 100, 101, 102], [100, 101, 108, 108, 106], [97, 98, 99, 100, 100], [100, 100, 100, 101, 103]);
      const plan = makePlan('run-1', 'PP0', { riskAssessment: { atr5: 5, maxHoldingDays: 5, regimeGrade: 'normal', regimeDirection: 'stable' } });
      updateSignalPool({ runId: 'run-1', raw, rootOverride: root, plan });
      updateSignalPool({ runId: 'run-2', raw, rootOverride: root, plan: { meta: { runId: 'run-2', signalDate: '2026-08-27', inputsSha: 'x' }, plans: [] } });
      const ledger = loadLedger(root);
      const sig = loadSignal(ledger.signals[0].signalId, root);
      assert.notEqual(sig.poolStatus, 'closed');
      assert.equal(sig.closeReason, null);
      assert.ok(sig.fulfillProgress < 0.2);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('executable 版本命中目标1 → 信号兑现出池', () => {
    const root = tmpRoot();
    try {
      const raw = makeRaw('PP0',
        ['2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27', '2026-08-28'],
        [98, 99, 100, 101, 102], [100, 101, 106, 107, 112], [97, 98, 99, 100, 100], [100, 100, 100, 101, 111]);
      const plan = makePlan('run-1', 'PP0', { riskAssessment: { atr5: 5, maxHoldingDays: 5, regimeGrade: 'normal', regimeDirection: 'stable' } });
      updateSignalPool({ runId: 'run-1', raw, rootOverride: root, plan });
      updateSignalPool({ runId: 'run-2', raw, rootOverride: root, plan: { meta: { runId: 'run-2', signalDate: '2026-08-27', inputsSha: 'x' }, plans: [] } });
      const ledger = loadLedger(root);
      const sig = loadSignal(ledger.signals[0].signalId, root);
      assert.equal(sig.poolStatus, 'closed');
      assert.equal(sig.closeReason, 'fulfilled');
      assert.equal(sig.verdict, 'fulfilled');
      assert.equal(sig.fulfillProgress, 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('持仓中 + 连续3期降级 → 不出池，信号保持 active', () => {
    const root = tmpRoot();
    try {
      const raw = makeRaw('PP0',
        ['2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27', '2026-08-28'],
        [98, 99, 100, 101, 102], [100, 101, 103, 104, 105], [97, 98, 99, 100, 101], [100, 100, 100, 101, 103]);
      const plan = makePlan('run-1', 'PP0', { riskAssessment: { atr5: 5, maxHoldingDays: 5, regimeGrade: 'normal', regimeDirection: 'stable' } });
      updateSignalPool({ runId: 'run-1', raw, rootOverride: root, plan });
      updateSignalPool({ runId: 'run-2', raw, rootOverride: root, plan: { meta: { runId: 'run-2', signalDate: '2026-08-27', inputsSha: 'x' }, plans: [] } });
      for (let i = 3; i <= 5; i++) {
        updateSignalPool({ runId: `run-${i}`, raw, rootOverride: root, plan: makePlan(`run-${i}`, 'PP0', { signalDate: `2026-08-${26 + i}`, executionStatus: 'skip' }) });
      }
      const ledger = loadLedger(root);
      const sig = loadSignal(ledger.signals[0].signalId, root);
      assert.equal(sig.poolStatus, 'active');
      assert.equal(sig.closeReason, null);
      assert.equal(sig.consecutiveNonExecutable, 3);
      assert.equal(sig.versions[0].verification.status, 'holding');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('同一 run 重复执行：退出判定完全幂等，不误触发 faded', () => {
    const root = tmpRoot();
    try {
      const raw = makeRaw('PP0',
        ['2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27', '2026-08-28'],
        [98, 99, 100, 101, 102], [100, 101, 103, 104, 105], [97, 98, 99, 100, 101], [100, 100, 100, 101, 103]);
      const plan = makePlan('run-1', 'PP0', { riskAssessment: { atr5: 5, maxHoldingDays: 5, regimeGrade: 'normal', regimeDirection: 'stable' } });
      updateSignalPool({ runId: 'run-1', raw, rootOverride: root, plan });
      updateSignalPool({ runId: 'run-2', raw, rootOverride: root, plan: { meta: { runId: 'run-2', signalDate: '2026-08-27', inputsSha: 'x' }, plans: [] } });
      for (let i = 3; i <= 5; i++) {
        updateSignalPool({ runId: `run-${i}`, raw, rootOverride: root, plan: makePlan(`run-${i}`, 'PP0', { signalDate: `2026-08-${26 + i}`, executionStatus: 'skip' }) });
      }
      updateSignalPool({ runId: 'run-5', raw, rootOverride: root, plan: makePlan('run-5', 'PP0', { signalDate: '2026-08-31', executionStatus: 'skip' }) });
      const ledger = loadLedger(root);
      const sig = loadSignal(ledger.signals[0].signalId, root);
      assert.equal(sig.poolStatus, 'active');
      assert.equal(sig.closeReason, null);
      assert.equal(sig.observations.filter((o) => o.runId === 'run-5').length, 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('幂等：同一 run 重复执行不重复追加版本', () => {
    const root = tmpRoot();
    try {
      const raw = { contracts: {} };
      updateSignalPool({ runId: 'run-1', raw, rootOverride: root, plan: makePlan('run-1', 'PP0') });
      updateSignalPool({ runId: 'run-2', raw, rootOverride: root, plan: makePlan('run-2', 'PP0', { signalDate: '2026-08-27', executionStatus: 'watch' }) });
      updateSignalPool({ runId: 'run-2', raw, rootOverride: root, plan: makePlan('run-2', 'PP0', { signalDate: '2026-08-27', executionStatus: 'watch' }) });
      const ledger = loadLedger(root);
      const sig = loadSignal(ledger.signals[0].signalId, root);
      assert.equal(sig.versions.length, 2);
      assert.equal(sig.versions.filter((v) => v.runId === 'run-2').length, 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('同一天多个 plan 不追加版本：最新计划覆盖旧版本', () => {
    const root = tmpRoot();
    try {
      const raw = { contracts: {} };
      updateSignalPool({ runId: 'run-1', raw, rootOverride: root, plan: makePlan('run-1', 'PP0') });
      const { view, meta } = updateSignalPool({
        runId: 'run-2', raw, rootOverride: root,
        plan: makePlan('run-2', 'PP0', { signalDate: '2026-08-26', entry: { trigger: '收盘站稳 105 上方', triggerLevel: 105 } })
      });
      assert.equal(meta.versionsAddedThisRun, 0);
      assert.equal(meta.versionsUpdatedThisRun, 1);
      const sig = loadSignal(view.pool[0].signalId, root);
      assert.equal(sig.versions.length, 1);
      assert.equal(sig.versions[0].runId, 'run-2');
      assert.equal(sig.versions[0].signalDate, '2026-08-26');
      assert.equal(sig.versions[0].entry.triggerLevel, 105);
      assert.equal(sig.currentVersionId, sig.versions[0].versionId);
      // 同一 run 重复执行不再次覆盖
      updateSignalPool({ runId: 'run-2', raw, rootOverride: root, plan: makePlan('run-2', 'PP0', { signalDate: '2026-08-26', entry: { trigger: '收盘站稳 999 上方', triggerLevel: 999 } }) });
      const sig2 = loadSignal(sig.signalId, root);
      assert.equal(sig2.versions.length, 1);
      assert.equal(sig2.versions[0].entry.triggerLevel, 105);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('视图：池内全量 + 最近出池 5 个 + 历史统计', () => {
    const root = tmpRoot();
    try {
      const raw = { contracts: {} };
      const symbols = ['A0', 'B0', 'C0', 'D0', 'E0', 'F0', 'G0'];
      for (const s of symbols) {
        updateSignalPool({ runId: `run-${s}`, raw, rootOverride: root, plan: makePlan(`run-${s}`, s) });
      }
      const ledger = loadLedger(root);
      // 直接构造 7 个已出池信号（新模型下反向报价不再自动关闭，出池由市场/时间/人类决定）。
      for (const row of ledger.signals) {
        const sig = loadSignal(row.signalId, root);
        sig.poolStatus = 'closed';
        sig.closeReason = 'invalidated_q5';
        sig.closedAt = '2026-08-27';
        sig.closeClass = 'direction_wrong';
        sig.directionVerdict = 'miss';
        sig.executionVerdict = 'noexec';
        saveSignal(sig, root);
      }
      const view = buildView('final', ledger, root);
      assert.equal(view.pool.length, 0);
      assert.equal(view.recentClosed.length, 5);
      assert.equal(view.historyStats.totalClosed, 7);
      assert.equal(view.historyStats.byCloseReason.invalidated_q5, 7);
      assert.equal(view.historyStats.byCloseClass.direction_wrong, 7);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('signal-pool 出池质量分类（方向 × 执行）', () => {
  it('目标1兑现 → 方向正确·执行盈利', () => {
    const root = tmpRoot();
    try {
      const raw = makeRaw('PP0',
        ['2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27', '2026-08-28'],
        [98, 99, 100, 101, 102], [100, 101, 106, 107, 112], [97, 98, 99, 100, 100], [100, 100, 100, 101, 111]);
      const plan = makePlan('run-1', 'PP0', { riskAssessment: { atr5: 5, maxHoldingDays: 5, regimeGrade: 'normal', regimeDirection: 'stable' } });
      updateSignalPool({ runId: 'run-1', raw, rootOverride: root, plan });
      updateSignalPool({ runId: 'run-2', raw, rootOverride: root, plan: { meta: { runId: 'run-2', signalDate: '2026-08-27', inputsSha: 'x' }, plans: [] } });
      const ledger = loadLedger(root);
      const sig = loadSignal(ledger.signals[0].signalId, root);
      assert.equal(sig.poolStatus, 'closed');
      assert.equal(sig.closeReason, 'fulfilled');
      assert.equal(sig.closeClass, 'direction_hit_profit');
      assert.equal(sig.directionVerdict, 'hit');
      assert.equal(sig.executionVerdict, 'profit');
      assert.equal(sig.directionResult, 'hit');
      assert.equal(sig.executionResult, 'profit');
      assert.equal(sig.executionEvent, 'target_hit');
      assert.equal(sig.verdict, 'fulfilled');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('Q5证伪且价格未走出方向 → 方向错误', () => {
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
      assert.equal(sig.closeClass, 'direction_wrong');
      assert.equal(sig.directionVerdict, 'miss');
      assert.equal(sig.directionResult, 'miss');
      assert.equal(sig.executionResult, 'noexec');
      assert.equal(sig.verdict, 'invalidated');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('faded：方向对但已执行亏损 → 方向正确·执行亏损', () => {
    const root = tmpRoot();
    try {
      const raw = makeRaw('PP0',
        ['2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27', '2026-08-28', '2026-08-29', '2026-08-30', '2026-08-31'],
        [98, 99, 100, 100, 102, 102, 102, 102],
        [100, 101, 102, 103, 103, 103, 103, 103],
        [97, 98, 99, 100, 100, 100, 100, 100],
        [100, 100, 100, 101, 101, 101, 101, 101]);
      const plan = makePlan('run-1', 'PP0', { riskAssessment: { atr5: 5, maxHoldingDays: 5, regimeGrade: 'normal', regimeDirection: 'stable' } });
      updateSignalPool({ runId: 'run-1', raw, rootOverride: root, plan });
      updateSignalPool({ runId: 'run-2', raw, rootOverride: root, plan: makePlan('run-2', 'PP0', { signalDate: '2026-08-27', executionStatus: 'watch' }) });
      updateSignalPool({ runId: 'run-3', raw, rootOverride: root, plan: makePlan('run-3', 'PP0', { signalDate: '2026-08-28', executionStatus: 'watch' }) });
      updateSignalPool({ runId: 'run-4', raw, rootOverride: root, plan: makePlan('run-4', 'PP0', { signalDate: '2026-08-29', executionStatus: 'watch' }) });
      const ledger = loadLedger(root);
      const sig = loadSignal(ledger.signals[0].signalId, root);
      assert.equal(sig.poolStatus, 'closed');
      assert.equal(sig.closeReason, 'faded');
      assert.equal(sig.closeClass, 'direction_hit_loss');
      assert.equal(sig.directionVerdict, 'hit');
      assert.equal(sig.executionVerdict, 'loss');
      assert.equal(sig.directionResult, 'hit');
      assert.equal(sig.executionResult, 'loss');
      assert.equal(sig.executionEvent, 'time_exit_loss');
      assert.equal(sig.verdict, 'invalidated');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('faded：方向对但跳空未执行 → 方向正确·未执行', () => {
    const root = tmpRoot();
    try {
      const raw = makeRaw('PP0',
        ['2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27', '2026-08-28', '2026-08-29', '2026-08-30', '2026-08-31'],
        [98, 99, 100, 100, 120, 120, 120, 120],
        [100, 101, 102, 106, 121, 121, 121, 121],
        [97, 98, 99, 99, 119, 119, 119, 119],
        [100, 100, 100, 105, 120, 120, 120, 120]);
      const plan = makePlan('run-1', 'PP0', { riskAssessment: { atr5: 5, maxHoldingDays: 5, regimeGrade: 'normal', regimeDirection: 'stable' } });
      updateSignalPool({ runId: 'run-1', raw, rootOverride: root, plan });
      updateSignalPool({ runId: 'run-2', raw, rootOverride: root, plan: makePlan('run-2', 'PP0', { signalDate: '2026-08-27', executionStatus: 'watch' }) });
      updateSignalPool({ runId: 'run-3', raw, rootOverride: root, plan: makePlan('run-3', 'PP0', { signalDate: '2026-08-28', executionStatus: 'watch' }) });
      updateSignalPool({ runId: 'run-4', raw, rootOverride: root, plan: makePlan('run-4', 'PP0', { signalDate: '2026-08-29', executionStatus: 'watch' }) });
      const ledger = loadLedger(root);
      const sig = loadSignal(ledger.signals[0].signalId, root);
      assert.equal(sig.poolStatus, 'closed');
      assert.equal(sig.closeReason, 'faded');
      assert.equal(sig.closeClass, 'direction_hit_noexec');
      assert.equal(sig.directionVerdict, 'hit');
      assert.equal(sig.executionVerdict, 'noexec');
      assert.equal(sig.directionResult, 'hit');
      assert.equal(sig.executionResult, 'noexec');
      assert.equal(sig.executionEvent, 'gap_skipped');
      assert.equal(sig.verdict, 'invalidated');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('旧 closed 信号缺 closeClass → buildView 惰性回填', () => {
    const root = tmpRoot();
    try {
      const raw = { contracts: {} };
      updateSignalPool({ runId: 'run-1', raw, rootOverride: root, plan: makePlan('run-1', 'PP0') });
      const ledger = loadLedger(root);
      const oldId = ledger.signals[0].signalId;
      const old = loadSignal(oldId, root);
      old.poolStatus = 'closed';
      old.closeReason = 'invalidated_q5';
      old.closedAt = '2026-08-27';
      delete old.closeClass;
      delete old.directionVerdict;
      delete old.executionVerdict;
      delete old.executionBestPnlPts;
      saveSignal(old, root);
      const view = buildView('final', ledger, root);
      const migrated = loadSignal(oldId, root);
      assert.ok(migrated.closeClass);
      assert.equal(migrated.closeClass, 'direction_wrong');
      assert.equal(migrated.directionVerdict, 'miss');
      assert.equal(migrated.executionVerdict, 'noexec');
      assert.equal(view.historyStats.byCloseClass.direction_wrong, 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('signal-pool V2 前向盖章（故事席位血缘）', () => {
  it('plan.storyChainId 前向盖章到信号与版本', () => {
    const root = tmpRoot();
    try {
      const plan = makePlan('run-story-1', 'RB0', { storyChainId: 'CH-BLACK-20260918-01' });
      const raw = makeRaw('RB0', ['2026-08-24', '2026-08-25', '2026-08-26'], [98, 99, 100], [100, 101, 102], [97, 98, 99], [100, 100, 100]);
      const { view } = updateSignalPool({ runId: 'run-story-1', raw, rootOverride: root, plan });
      const sig = loadSignal(view.pool[0].signalId, root);
      assert.equal(sig.storyChainId, 'CH-BLACK-20260918-01');
      assert.equal(sig.versions[0].storyChainId, 'CH-BLACK-20260918-01');
      assert.equal(view.pool[0].storyChainId, 'CH-BLACK-20260918-01');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('signal-pool v6：信号身份、T0 锚点与报价决策', () => {
  it('信号身份 = symbol + contract + storyChainId；换合约诞生新信号', () => {
    const root = tmpRoot();
    try {
      const raw = { contracts: {} };
      const plan1 = makePlan('run-1', 'RB0', { contract: 'RB2701', storyChainId: 'CH-1' });
      const { view } = updateSignalPool({ runId: 'run-1', raw, rootOverride: root, plan: plan1 });
      assert.equal(view.pool.length, 1);
      const plan2 = makePlan('run-2', 'RB0', { contract: 'RB2705', storyChainId: 'CH-1', signalDate: '2026-08-27' });
      const r2 = updateSignalPool({ runId: 'run-2', raw, rootOverride: root, plan: plan2 });
      assert.equal(r2.meta.createdThisRun, 1);
      assert.equal(r2.view.pool.length, 2);
      const ledger = loadLedger(root);
      assert.equal(ledger.signals.length, 2);
      const old = loadSignal(ledger.signals[0].signalId, root);
      const neu = loadSignal(ledger.signals[1].signalId, root);
      assert.equal(old.contract, 'RB2701');
      assert.equal(neu.contract, 'RB2705');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('T0 不变：后续报价的 T+1/T+2 仍按信号出生日计算', () => {
    const root = tmpRoot();
    try {
      const raw = makeRaw('PP0',
        ['2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27', '2026-08-28'],
        [98, 99, 100, 101, 102], [100, 101, 103, 104, 105], [97, 98, 99, 100, 101], [100, 100, 100, 101, 103]);
      const plan = makePlan('run-1', 'PP0', { riskAssessment: { atr5: 5, maxHoldingDays: 5, regimeGrade: 'normal', regimeDirection: 'stable' } });
      updateSignalPool({ runId: 'run-1', raw, rootOverride: root, plan });
      // 08-27 的同向新报价（pending）：T+1/T+2 仍应从 T0=08-26 数起。
      updateSignalPool({ runId: 'run-2', raw, rootOverride: root, plan: makePlan('run-2', 'PP0', { signalDate: '2026-08-27', riskAssessment: { atr5: 5, maxHoldingDays: 5, regimeGrade: 'normal', regimeDirection: 'stable' } }) });
      // 08-28 只追踪不产生报价，触发对往期版本验证。
      updateSignalPool({ runId: 'run-3', raw, rootOverride: root, plan: { meta: { runId: 'run-3', signalDate: '2026-08-28', inputsSha: 'x' }, plans: [] } });
      const ledger = loadLedger(root);
      const sig = loadSignal(ledger.signals[0].signalId, root);
      const quote = sig.versions.find((v) => v.signalDate === '2026-08-27');
      assert.ok(quote);
      assert.equal(quote.decision.status, 'pending');
      // 新报价验证：T+1 = 08-27（信号出生日 + 1），T+2 = 08-28，而不是从报价日 08-27 再 +1。
      assert.equal(quote.verification.lastResult.triggerDate, '2026-08-27');
      assert.equal(quote.verification.lastResult.entryDate, '2026-08-28');
      assert.equal(quote.verification.lastResult.entryPrice, 102);
      assert.equal(sig.livingVersionId, `${sig.signalId}:V1`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('人类决策回填：采用同向报价更新 livingTicket，维持旧单留痕', () => {
    const root = tmpRoot();
    try {
      const raw = { contracts: {} };
      updateSignalPool({ runId: 'run-1', raw, rootOverride: root, plan: makePlan('run-1', 'PP0') });
      updateSignalPool({ runId: 'run-2', raw, rootOverride: root, plan: makePlan('run-2', 'PP0', { signalDate: '2026-08-27' }) });
      const ledger = loadLedger(root);
      const sig = loadSignal(ledger.signals[0].signalId, root);
      const quote = sig.versions.find((v) => v.signalDate === '2026-08-27');
      const { applyDecisions } = require('../signals/cli/signal-pool-decision-cli.cjs');
      const doc = {
        schema: 'futures-radar-signal-decisions/1',
        runId: 'run-2',
        decisions: [{
          signalId: sig.signalId,
          quoteVersionId: quote.versionId,
          action: 'adopt',
          reason: '采用新报价作为当前有效交易单',
          decidedAt: '2026-08-27'
        }]
      };
      const file = path.join(root, 'decisions.json');
      fs.writeFileSync(file, JSON.stringify(doc), 'utf8');
      applyDecisions('run-2', file, root);
      const updated = loadSignal(sig.signalId, root);
      const adopted = updated.versions.find((v) => v.versionId === quote.versionId);
      assert.equal(updated.livingVersionId, quote.versionId);
      assert.equal(adopted.decision.status, 'adopted');
      assert.equal(adopted.decision.reason, '采用新报价作为当前有效交易单');
      assert.equal(updated.decisionRecords.length, 1);
      assert.equal(updated.decisionRecords[0].action, 'adopt');
      assert.equal(updated.decisionRecords[0].status, 'applied');
      assert.equal(updated.decisionRecords[0].signalId, sig.signalId);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
