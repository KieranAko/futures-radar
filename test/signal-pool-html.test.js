import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { renderSignalPoolHtml, escapeHtml } = require('../report/render-signal-pool-html.cjs');

function makeView() {
  const signal = {
    signalId: 'SIG-PP0-20260910-01',
    symbol: 'PP0',
    name: '聚丙烯',
    contract: 'PP2701',
    direction: 'bullish',
    thesis: '成本端推动',
    poolStatus: 'downgraded',
    createdRunId: '20260910-1604-auto',
    createdDate: '2026-09-10',
    lastSeenRunId: '20260915-0925-auto',
    lastSeenDate: '2026-09-14',
    versionCount: 2,
    consecutiveNonExecutable: 1,
    currentVersion: { executionStatus: 'skip', entryTrigger: '放量突破 9086' },
    latestVerification: { status: 'verified', exitType: 'time_exit', directionCorrect: true },
    priceTracking: { startClose: 8939, latestClose: 8876, maxFavorablePts: 336, maxAdversePts: -155 },
    closedAt: null,
    closeReason: null,
    verdict: null
  };
  const version = {
    versionId: 'SIG-PP0-20260910-01:V1',
    runId: '20260910-1604-auto',
    signalDate: '2026-09-10',
    executionStatus: 'executable',
    direction: 'bullish',
    confidence: 'medium',
    strategyId: 'MS-01',
    playbookId: 'PB-01',
    stateTransition: 'signal_created',
    entry: { trigger: '回踩 8798–8845', triggerLevel: 8819, triggerTiming: 'T+1 收盘确认', execution: '执行偏离 >0.75×ATR5 放弃' },
    stop: { stopPrice: 8619, basis: 'Q5' },
    targets: { t1: '9235', t2: '2R' },
    invalidation: { hard: ['收盘跌破 8619'] },
    regime: { grade: 'elevated', direction: 'rising' },
    verification: { status: 'verified', terminal: true, lastResult: { status: 'verified', exitType: 'time_exit', directionCorrect: true, entryPrice: 8800, exitPrice: 8876 } }
  };
  return {
    schema: 'futures-radar-signal-pool-view/1',
    meta: { runId: 'r1', generatedAt: '2026-09-15T00:00:00Z' },
    pool: [signal],
    recentClosed: [{
      ...signal,
      signalId: 'SIG-TA0-20260901-01',
      symbol: 'TA0',
      name: 'PTA',
      poolStatus: 'closed',
      closedAt: '2026-09-10T00:00:00Z',
      closeReason: 'flipped',
      verdict: 'hit'
    }],
    historyStats: { totalClosed: 1, byCloseReason: { flipped: 1 }, byVerdict: { hit: 1 } },
    details: {
      'SIG-PP0-20260910-01': { ...signal, versions: [version] },
      'SIG-TA0-20260901-01': { ...signal, signalId: 'SIG-TA0-20260901-01', poolStatus: 'closed', closedAt: '2026-09-10T00:00:00Z', closeReason: 'flipped', verdict: 'hit', versions: [version] }
    }
  };
}

describe('signal-pool-html 看板渲染', () => {
  it('输出自包含 HTML，含双 tab 与报告链接', () => {
    const html = renderSignalPoolHtml(makeView(), { runId: 'r1' });
    assert.ok(html.includes('<!doctype html>'));
    assert.ok(html.includes('📊 信号池看板'));
    assert.ok(html.includes('📄 完整报告'));
    assert.ok(html.includes('id="tab-dashboard"'));
    assert.ok(html.includes('id="tab-report"'));
    assert.ok(html.includes('href="runs/r1/report.md"'));
    assert.ok(!html.includes('<script src'));
    assert.ok(!html.includes('https://'));
    assert.ok(!html.includes('http://'));
  });

  it('看板包含池内信号卡片、出池卡片、历史统计', () => {
    const html = renderSignalPoolHtml(makeView(), { runId: 'r1' });
    assert.ok(html.includes('池内信号（全量追踪）'));
    assert.ok(html.includes('SIG-PP0-20260910-01'));
    assert.ok(html.includes('聚丙烯（PP2701）'));
    assert.ok(html.includes('全部暂停（连续 1 期无生效策略）'));
    assert.ok(html.includes('最近出池信号（最新 5 个）'));
    assert.ok(html.includes('SIG-TA0-20260901-01'));
    assert.ok(html.includes('历史统计'));
    assert.ok(html.includes('历史已出池信号'));
    assert.ok(html.includes('>1</b>'));
  });

  it('信号与策略均为可展开 details', () => {
    const html = renderSignalPoolHtml(makeView(), { runId: 'r1' });
    assert.ok(html.includes('<details class="card'));
    assert.ok(html.includes('<details class="version">'));
    assert.ok(html.includes('策略版本（1）'));
    assert.ok(html.includes('V1 · 🟢 时间离场盈利'));
    assert.ok(html.includes('回踩 8798–8845'));
    assert.ok(html.includes('执行偏离 &gt;0.75×ATR5 放弃'));
  });

  it('确定性：同输入两次渲染字节一致', () => {
    const a = renderSignalPoolHtml(makeView(), { runId: 'r1' });
    const b = renderSignalPoolHtml(makeView(), { runId: 'r1' });
    assert.equal(a, b);
  });

  it('escapeHtml 转义 HTML 特殊字符', () => {
    assert.equal(escapeHtml('<a href="x">'), '&lt;a href=&quot;x&quot;&gt;');
  });

  it('空池渲染不崩溃', () => {
    const html = renderSignalPoolHtml({
      schema: 'futures-radar-signal-pool-view/1',
      meta: { runId: 'r1' },
      pool: [],
      recentClosed: [],
      historyStats: { totalClosed: 0, byCloseReason: {}, byVerdict: {} },
      details: {}
    }, { runId: 'r1' });
    assert.ok(html.includes('当前池内无信号。'));
    assert.ok(html.includes('暂无出池信号。'));
  });
});
