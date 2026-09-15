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

  it('机会卡片含价格趋势图/区间条/多空面板/chips', () => {
    const model = makeReportModel();
    model.opportunities[0].priceRanges = [
      { period: '3d', hvCone: { p68: [8607.7, 9152.7], p95: [8357.7, 9426.4] } },
      { period: '5d', hvCone: { p68: [8531.1, 9234.8], p95: [8212.7, 9592.9] } }
    ];
    model.opportunities[0].thesis.confidenceRationale = {
      supportingFactors: [{ note: '5日 +3.69%' }],
      opposingFactors: [{ note: 'volMult 1.02x' }],
      uncertainties: ['不确定项']
    };
    const dates = []; const open = []; const high = []; const low = []; const close = [];
    const start = new Date('2026-06-01T00:00:00Z');
    for (let i = 0; i < 80; i++) {
      const d = new Date(start.getTime() + i * 86400000);
      dates.push(d.toISOString().slice(0, 10));
      open.push(1000 + i); high.push(1010 + i); low.push(990 + i); close.push(1005 + i);
    }
    const raw = { contracts: { PP0: { ohlcv: { dates, open, high, low, close } } } };
    const html = renderDashboardHtml({ runId: 'r1', reportModel: model, signalPoolView: makeSignalPoolView(), history: [], raw, signalDate: dates[dates.length - 1] });
    assert.ok(html.includes('<svg class="price-chart"'));
    assert.ok(html.includes('<polyline'));
    assert.ok(html.includes('MA20'));
    assert.ok(html.includes('MA60'));
    assert.ok(html.includes('range-p68'));
    assert.ok(html.includes('factor-panel support'));
    assert.ok(html.includes('factor-panel oppose'));
    assert.ok(html.includes('chip green'));
    assert.ok(html.includes('chip red'));
    assert.ok(html.includes('chip gray'));
  });

  it('机会面板含交易策略卡（执行要素/风险/状态）', () => {
    const strategyPlan = { meta: { runId: 'r1' }, plans: [{
      symbol: 'PP0', executionStatus: 'skip', strategyConfidence: 'low',
      matchedStrategies: [{ strategyId: 'MS-01', name: '时间序列动量 / 趋势跟踪' }],
      playbook: { playbookId: 'PB-01', gateStatus: 'pass', executionConvention: 'T+1 开盘' },
      entry: { trigger: '观察：放量突破 9086', triggerLevel: 9086, triggerTiming: 'T+1 盘中确认', execution: '执行偏离 >0.75×ATR5 放弃' },
      stop: { stopPrice: 8784, basis: 'Q5 3日低点' },
      targets: { t1: '9086（前日高点）', t2: '9144（3日 p68 上沿）' },
      position: { lots: 0, lotsBasis: 'min(风险预算 1 手, 波动率目标 2 手, 保证金 27 手)' },
      invalidation: { hard: ['收盘跌破 8784'], timeStop: 'T+5' },
      riskAssessment: { unitRiskCny: 1285, marginPerLotCny: 3550, tailGapPct3d: -5.8 },
      statusReasons: ['波动率 regime extreme：跳过']
    }] };
    const html = renderDashboardHtml({ runId: 'r1', reportModel: makeReportModel(), signalPoolView: makeSignalPoolView(), history: [], strategyPlan });
    assert.ok(html.includes('📌 交易策略'));
    assert.ok(html.includes('strategy-card st-skip'));
    assert.ok(html.includes('触发价 9086.0'));
    assert.ok(html.includes('止损'));
    assert.ok(html.includes('8784.0'));
    assert.ok(html.includes('每手风险 1285 CNY'));
    assert.ok(html.includes('波动率 regime extreme：跳过'));
  });

  it('watch 计划渲染转执行触发行', () => {
    const strategyPlan = { meta: { runId: 'r1' }, plans: [{
      symbol: 'PP0', executionStatus: 'watch', strategyConfidence: 'low',
      matchedStrategies: [{ strategyId: 'MS-01', name: '时间序列动量' }],
      playbook: { playbookId: 'PB-01', gateStatus: 'pass' },
      entry: { trigger: '观察：放量突破 9086', triggerLevel: 9086, triggerTiming: 'T+1 确认', execution: 'T+1 开盘' },
      stop: { stopPrice: 8784, basis: 'Q5' },
      targets: { t1: '9086', t2: '9144' },
      position: { lots: 0, lotsBasis: 'min(...)' },
      invalidation: { hard: ['收盘跌破 8784'], timeStop: 'T+5' },
      riskAssessment: { unitRiskCny: 1285, marginPerLotCny: 3550, tailGapPct3d: -5.8 },
      statusReasons: []
    }] };
    const html = renderDashboardHtml({ runId: 'r1', reportModel: makeReportModel(), signalPoolView: makeSignalPoolView(), history: [], strategyPlan });
    assert.ok(html.includes('strategy-card st-watch'));
    assert.ok(html.includes('转执行触发'));
    assert.ok(html.includes('watch-trigger'));
  });

  it('机会分析左侧导航布局：默认第一项激活', () => {
    const html = renderDashboardHtml({ runId: 'r1', reportModel: makeReportModel(), signalPoolView: makeSignalPoolView(), history: [] });
    assert.ok(html.includes('class="opp-layout"'));
    assert.ok(html.includes('class="opp-nav-item active" data-opp="PP0"'));
    assert.ok(html.includes('class="opp-pane active" data-opp="PP0"'));
    assert.ok(html.includes('oppNavItems'));
  });

  it('历史报告分页控件与行渲染', () => {
    const history = Array.from({ length: 22 }, (_, i) => ({
      runId: `run-${String(i).padStart(2, '0')}`, date: '2026-09-15', oppSymbols: 'PP0', href: `runs/run-${String(i).padStart(2, '0')}/report.html`
    }));
    const html = renderDashboardHtml({ runId: 'r1', reportModel: makeReportModel(), signalPoolView: makeSignalPoolView(), history });
    assert.ok(html.includes('class="pagination"'));
    assert.ok(html.includes('data-page="1"'));
    assert.ok(html.includes('data-page="2"'));
    assert.ok(html.includes('data-page="3"'));
    assert.ok(html.includes('共 22 份 · 第'));
    assert.ok(html.includes('id="history-rows"'));
    assert.ok(html.includes('table.index'));
  });

  it('确定性：同输入两次渲染一致', () => {
    const args = { runId: 'r1', reportModel: makeReportModel(), signalPoolView: makeSignalPoolView(), history: [{ runId: 'r1', date: '2026-09-15', oppSymbols: 'PP0', href: 'runs/r1/report.html' }] };
    assert.equal(renderDashboardHtml(args), renderDashboardHtml(args));
  });
});
