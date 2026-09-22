import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { renderSignalPoolHtml, escapeHtml, signalPoolPanelsHtml, signalClosedPanelsHtml } = require('../output/render-signal-pool-html.cjs');

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
    entry: { trigger: '回踩 8798–8845', triggerLevel: 8819, triggerTiming: 'T+1 收盘确认', execution: '执行偏离 >0.75×ATR5 放弃', entryZone: { lower: 8798, upper: 8845, lowerBasis: '回踩不破 8798', upperBasis: '偏离 >47 放弃' } },
    stop: { stopPrice: 8619, basis: 'Q5' },
    targets: { t1: '9235', t2: '9445' },
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
    assert.ok(html.includes('全部暂停（连续 1 期未产生可执行策略）'));
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

  it('故事池式信号面板：折叠版本时间线、当前版本展开、价格轨迹图块', () => {
    const view = makeView();
    const html = signalPoolPanelsHtml(view);
    assert.ok(html.includes('class="story-panel signal-panel'));
    assert.ok(html.includes('class="sig-timeline"'));
    assert.ok(html.includes('tl-item tl-ok current'));
    assert.ok(html.includes('class="tl-details" open'));
    assert.ok(html.includes('>V1</span>'));
    assert.ok(html.includes('tl-current-tag'));
    assert.ok(html.includes('tl-row'));
    assert.ok(html.includes('sig-chart-block'));
    assert.ok(html.includes('sig-chart-missing'));
    assert.ok(!html.includes('<details class="version">'));
  });

  it('入场区间直接使用交易员 entryZone（8798.0 ~ 8845.0）而不是对称推导', () => {
    const view = makeView();
    const bars = [
      { date: '2026-09-10', open: 8800, high: 8860, low: 8790, close: 8810, volume: 1 },
      { date: '2026-09-11', open: 8810, high: 8880, low: 8800, close: 8830, volume: 1 },
      { date: '2026-09-14', open: 8830, high: 8890, low: 8810, close: 8850, volume: 1 },
    ];
    const html = signalPoolPanelsHtml(view, { barsOf: () => bars });
    assert.ok(html.includes('8798.0 ~ 8845.0'));
    assert.ok(html.includes('回踩不破 8798'));
    assert.ok(html.includes('偏离 &gt;47 放弃'));
  });

  it('出池信号与池内信号同面板样式，且默认折叠', () => {
    const view = makeView();
    const html = signalClosedPanelsHtml(view);
    assert.ok(html.includes('<details class="story-panel signal-panel is-closed">'));
    assert.ok(html.includes('class="sig-timeline"'));
    assert.ok(html.includes('sig-panel-body'));
    assert.ok(html.includes('PTA'));
    assert.ok(!html.includes('sig-closed-table'));
    assert.ok(!html.includes('<tr'));
  });

  it('报价对比：待决策新报价并排展示、diff 高亮、对账解释与人类决策按钮', () => {
    const base = makeView();
    const living = base.details['SIG-PP0-20260910-01'].versions[0];
    const quote = JSON.parse(JSON.stringify(living));
    quote.versionId = 'SIG-PP0-20260910-01:V2';
    quote.signalDate = '2026-09-11';
    quote.quoteDate = '2026-09-11';
    quote.stop = { stopPrice: 8700, basis: 'Q5 收紧' };
    quote.decision = { status: 'pending', reason: '', decidedAt: null };
    quote.diff = {
      relation: 'refined',
      changedFields: [{ field: 'stop.stopPrice', label: '止损价', oldValue: 8619, newValue: 8700 }]
    };
    quote.reconciliation = {
      summary: '新旧报价仅止损位不同：新报价把空头容忍空间收紧。',
      conflicts: [{ field: 'stop.stopPrice', severity: 'attention', explanation: '交易员对上方容忍空间收紧。' }]
    };
    const view = JSON.parse(JSON.stringify(base));
    const detail = view.details['SIG-PP0-20260910-01'];
    detail.versions = [living, quote];
    detail.livingVersionId = living.versionId;
    const html = signalPoolPanelsHtml(view);
    assert.ok(html.includes('quote-compare'));
    assert.ok(html.includes('新报价 SIG-PP0-20260910-01:V2'));
    assert.ok(html.includes('rel-refined'));
    assert.ok(html.includes('quote-compare-grid'));
    assert.ok(html.includes('tk-diff'));
    assert.ok(html.includes('止损价'));
    assert.ok(html.includes('对账 LLM 解释'));
    assert.ok(html.includes('交易员对上方容忍空间收紧'));
    assert.ok(html.includes('data-action="adopt"'));
    assert.ok(html.includes('data-action="keep"'));
    assert.ok(html.includes('data-action="pause"'));
    assert.ok(html.includes('data-action="close"'));
    assert.ok(html.includes('待对账 1'));
  });

  it('对账决策记录：服务端记录默认折叠展示，报价对比 N 忠实计数', () => {
    const base = makeView();
    const view = JSON.parse(JSON.stringify(base));
    const detail = view.details['SIG-PP0-20260910-01'];
    const living = detail.versions[0];
    const quote = JSON.parse(JSON.stringify(living));
    quote.versionId = 'SIG-PP0-20260910-01:V2';
    quote.signalDate = '2026-09-11';
    quote.quoteDate = '2026-09-11';
    quote.stop = { stopPrice: 8700, basis: 'Q5 收紧' };
    quote.decision = { status: 'adopted', reason: '采用新报价作为当前有效交易单', decidedAt: '2026-09-15T09:00:00.000Z' };
    quote.diff = { relation: 'refined', changedFields: [{ field: 'stop.stopPrice', label: '止损价', oldValue: 8619, newValue: 8700 }] };
    detail.versions = [living, quote];
    detail.decisionRecords = [{
      schema: 'futures-radar-signal-decision-record/1',
      recordId: 'DR-SIG-PP0-20260910-01-V2-1',
      signalId: 'SIG-PP0-20260910-01',
      quoteVersionId: 'SIG-PP0-20260910-01:V2',
      livingVersionIdBefore: 'SIG-PP0-20260910-01:V1',
      action: 'adopt',
      reason: '采用新报价作为当前有效交易单',
      decidedAt: '2026-09-15T09:00:00.000Z',
      decidedBy: 'human-dashboard',
      status: 'applied'
    }];
    detail.comparisonCount = 2;
    const html = signalPoolPanelsHtml(view);
    assert.ok(html.includes('class="decision-record is-applied"'));
    assert.ok(html.includes('对账决策'));
    assert.ok(html.includes('采用新报价'));
    assert.ok(html.includes('待回填') === false);
    assert.ok(html.includes('报价对比 2'));
    // 展开后重放完整对账视图：并排交易单 + 差异高亮 + 决策时 livingTicket。
    assert.ok(html.includes('quote-compare-grid'));
    assert.ok(html.includes('ticket-fields'));
    assert.ok(html.includes('tk-diff'));
    assert.ok(html.includes('决策时有效交易单 SIG-PP0-20260910-01:V1'));
    assert.ok(html.indexOf('对账决策记录') > html.indexOf('sig-timeline'));
  });
});
