import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { renderDashboardHtml } = require('../report/render-dashboard-html.cjs');

function makeReportModel() {
  return {
    meta: { runId: 'r1', generatedAt: '2026-09-15T00:00:00Z' },
    opportunities: [{
      symbol: 'PP0',
      name: '聚丙烯',
      contract: 'PP2701',
      marketFacts: { close: 8876 },
      thesis: {
        finalDirection: 'bullish',
        finalConfidence: 'medium',
        driver: { primary: 'SC0 原油 5日 +29.37% 成本端推动', secondary: 'OI 5日 +6.49% 资金流入', evidence: '证据', source: '来源' },
        odds: { bias: 'bullish', reasoning: '趋势与成本偏多' },
        confirmations: { signals: ['放量突破 9086'] },
        invalidations: { conditions: ['收盘跌破 8619'] },
        risks: { items: ['涨跌停幅度 4%'] },
        trendOrImpulse: { assessment: '5日 +3.69%，向上' }
      }
    }]
  };
}

function makeSignalPoolView() {
  const sig = {
    signalId: 'SIG-PP0-20260910-01',
    symbol: 'PP0', name: '聚丙烯', contract: 'PP2701', direction: 'bullish',
    poolStatus: 'downgraded', createdDate: '2026-09-10', createdRunId: 'r0',
    lastSeenDate: '2026-09-14', lastSeenRunId: 'r1', versionCount: 1, consecutiveNonExecutable: 1,
    currentVersion: { executionStatus: 'skip', entryTrigger: '突破 9086' },
    latestVerification: { status: 'verified', exitType: 'time_exit', directionCorrect: true },
    priceTracking: { startClose: 8939, latestClose: 8876, maxFavorablePts: 336, maxAdversePts: -155 },
    closedAt: null, closeReason: null, verdict: null
  };
  const version = {
    versionId: 'SIG-PP0-20260910-01:V1', runId: 'r0', signalDate: '2026-09-10',
    executionStatus: 'executable', stateTransition: 'signal_created', direction: 'bullish', confidence: 'medium',
    strategyId: 'MS-01', playbookId: 'PB-01',
    entry: { trigger: '回踩 8798–8845', triggerLevel: 8819, triggerTiming: 'T+1 收盘确认', execution: '执行偏离 >0.75×ATR5 放弃' },
    stop: { stopPrice: 8619, basis: 'Q5' },
    targets: { t1: '9235', t2: '2R' },
    invalidation: { hard: ['收盘跌破 8619'] },
    regime: { grade: 'elevated', direction: 'rising' },
    verification: { status: 'verified', terminal: true, lastResult: { status: 'verified', exitType: 'time_exit', directionCorrect: true } }
  };
  return {
    schema: 'futures-radar-signal-pool-view/1',
    meta: { runId: 'r1' },
    pool: [sig],
    recentClosed: [],
    historyStats: { totalClosed: 0, byCloseReason: {}, byVerdict: {} },
    details: { 'SIG-PP0-20260910-01': { ...sig, versions: [version] } }
  };
}

describe('dashboard-html 三 Tab 看板', () => {
  it('包含三个 tab 与历史索引链接', () => {
    const html = renderDashboardHtml({
      runId: 'r1',
      reportModel: makeReportModel(),
      signalPoolView: makeSignalPoolView(),
      history: [{ runId: 'r1', date: '2026-09-15', oppSymbols: 'PP0 聚丙烯', href: 'runs/r1/report.html' }]
    });
    assert.ok(html.includes('📈 机会分析'));
    assert.ok(html.includes('📊 信号池'));
    assert.ok(html.includes('🗂 历史报告'));
    assert.ok(html.includes('id="tab-opportunities"'));
    assert.ok(html.includes('id="tab-pool"'));
    assert.ok(html.includes('id="tab-history"'));
    assert.ok(html.includes('href="runs/r1/report.html"'));
    assert.ok(!html.includes('<script src'));
    assert.ok(!html.includes('https://'));
  });

  it('机会分析 tab 渲染机会卡片字段', () => {
    const html = renderDashboardHtml({ runId: 'r1', reportModel: makeReportModel(), signalPoolView: makeSignalPoolView(), history: [] });
    assert.ok(html.includes('聚丙烯（PP2701）'));
    assert.ok(html.includes('SC0 原油 5日 +29.37% 成本端推动'));
    assert.ok(html.includes('趋势与成本偏多'));
    assert.ok(html.includes('放量突破 9086'));
    assert.ok(html.includes('收盘跌破 8619'));
    assert.ok(html.includes('涨跌停幅度 4%'));
  });

  it('信号池 tab 复用信号卡片与版本详情', () => {
    const html = renderDashboardHtml({ runId: 'r1', reportModel: makeReportModel(), signalPoolView: makeSignalPoolView(), history: [] });
    assert.ok(html.includes('池内信号（全量追踪）'));
    assert.ok(html.includes('SIG-PP0-20260910-01'));
    assert.ok(html.includes('<details class="version">'));
    assert.ok(html.includes('回踩 8798–8845'));
  });

  it('确定性：同输入两次渲染一致', () => {
    const args = { runId: 'r1', reportModel: makeReportModel(), signalPoolView: makeSignalPoolView(), history: [{ runId: 'r1', date: '2026-09-15', oppSymbols: 'PP0', href: 'runs/r1/report.html' }] };
    assert.equal(renderDashboardHtml(args), renderDashboardHtml(args));
  });
});
