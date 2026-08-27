#!/usr/bin/env node
// strategies/backtest/pilot-runner.cjs — 完整策略链小批量回测试点
//
// 链路：截断 raw → sector/概率/报告基线 → strategy-matcher（含 recorded LLM 决策）
//       → 冻结 executable 计划 → feedback 验证 → baseline 汇总
//
// 用法: node strategies/backtest/pilot-runner.cjs
// 输出: strategies/backtest/baseline-report.json / .md

'use strict';

const fs = require('fs');
const path = require('path');

const pilotRoot = path.resolve(__dirname, '..', '..', 'output', 'backtest-pilot');
process.env.FUTURES_RUNTIME_ROOT = pilotRoot;

const { skillRoot } = require('../../lib/workspace.cjs');
const dataStore = require('../../data-store/index.cjs');
const { buildSectorSnapshot } = require('../../collector/sector-aggregator.cjs');
const { buildStrategyPlan, validatePlan } = require('../../strategies/lib/strategy-matcher.cjs');
const { recordExecutablePlans, verifyPlans } = require('../../strategies/lib/feedback.cjs');

const SYMBOLS = JSON.parse(fs.readFileSync(path.join(skillRoot, 'config', 'symbols.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'recordings', 'manifest.json'), 'utf8'));
const cache = dataStore.loadHistoricalCache();

function mean(a) { return a.reduce((x, y) => x + y, 0) / a.length; }

function hvCloseToClose(closes, window = 20) {
  const slice = closes.slice(-window - 1);
  const rets = [];
  for (let i = 1; i < slice.length; i++) rets.push(Math.log(slice[i] / slice[i - 1]));
  const m = mean(rets);
  const variance = mean(rets.map(r => (r - m) ** 2));
  return Math.sqrt(variance) * Math.sqrt(242);
}

function cone(close, hv, days) {
  const sd = hv / Math.sqrt(242);
  const band = (z) => [Math.round(close * Math.exp(-z * sd * Math.sqrt(days)) * 10) / 10, Math.round(close * Math.exp(z * sd * Math.sqrt(days)) * 10) / 10];
  return { p68: band(1), p95: band(1.96) };
}

function truncateRaw(date) {
  const contracts = {};
  for (const [sym, c] of Object.entries(cache.contracts)) {
    const o = c.ohlcv;
    const idx = o.dates.indexOf(date);
    if (idx < 20) continue;
    const arr = (key) => o[key].slice(0, idx + 1);
    const dates = o.dates.slice(0, idx + 1);
    const close = arr('close');
    const high = arr('high');
    const low = arr('low');
    const volume = arr('volume');
    const oi = o.openInterest ? arr('openInterest') : dates.map(() => 0);
    contracts[sym] = {
      symbol: sym, name: c.name || sym, exchange: c.exchange, sector: c.sector,
      multiplier: c.multiplier || 1, unit: c.unit || '',
      ohlcv: { dates, open: arr('open'), high, low, close, volume, openInterest: oi, settle: arr('settle') },
      derived: {
        change5d: close.length >= 6 ? +((close[close.length - 1] / close[close.length - 6] - 1) * 100).toFixed(2) : null
      }
    };
  }
  return { meta: { runId: `bt-pilot-${date}`, signalDate: date, collectedAt: `${date}T15:00:00Z` }, contracts, gaps: {} };
}

function makeArtifacts(runDir, date, raw, decision) {
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'raw.json'), JSON.stringify(raw, null, 2));
  fs.writeFileSync(path.join(runDir, 'macro-snapshot.json'), JSON.stringify({ meta: { runId: `bt-pilot-${date}`, signalDate: date }, indicators: {} }, null, 2));

  const sector = buildSectorSnapshot(raw, SYMBOLS, { runId: `bt-pilot-${date}`, signalDate: date });
  fs.writeFileSync(path.join(runDir, 'sector-snapshot.json'), JSON.stringify(sector, null, 2));

  const sectorDriver = { meta: { runId: `bt-pilot-${date}`, signalDate: date, mode: 'sector-driver' }, sectors: {} };
  for (const [sid, sec] of Object.entries(sector.sectors)) {
    const d = decision.sectorDriver[sid];
    sectorDriver.sectors[sid] = d
      ? { sector: sid, signalDate: date, status: d.status, direction_observed: sec.direction, member_structure: 'broad_based', relation_to_individual: 'context_only', driver: { primary: d.primary, category: 'macro', confidence: d.confidence, evidence: [], invalidation: ['驱动逻辑失效'] }, reason: null }
      : { sector: sid, signalDate: date, status: 'unknown', direction_observed: sec.direction, member_structure: 'broad_based', relation_to_individual: 'context_only', driver: null, reason: '试点未记录该板块驱动' };
  }
  fs.writeFileSync(path.join(runDir, 'sector-driver.json'), JSON.stringify(sectorDriver, null, 2));

  const sym = decision.filter.KEEP[0];
  const c = raw.contracts[sym];
  const closes = c.ohlcv.close;
  const highs = c.ohlcv.high;
  const lows = c.ohlcv.low;
  const close = closes[closes.length - 1];
  let trs = [];
  for (let i = 1; i < closes.length; i++) trs.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  const atr5 = mean(trs.slice(-5));
  const hv = hvCloseToClose(closes);
  const prob = {
    meta: { runId: `bt-pilot-${date}`, calculatedAt: `${date}T15:00:00Z` },
    probabilities: [{
      symbol: sym, close,
      hv: { annual: hv, periodDays: 20, percentile90d: null, estimator: 'close_to_close', correctionCount: 0, totalBars: closes.length, degraded: false },
      cone: { '3d': cone(close, hv, 3), '5d': cone(close, hv, 5) },
      atrComparison: {
        atr5, atr2xBand: [close - 2 * atr5, close + 2 * atr5],
        divergencePct: Math.round(Math.abs((4 * atr5 - (cone(close, hv, 3).p95[1] - cone(close, hv, 3).p95[0])) / (cone(close, hv, 3).p95[1] - cone(close, hv, 3).p95[0])) * 1000) / 10,
        interpretation: '试点口径'
      }
    }]
  };
  fs.writeFileSync(path.join(runDir, 'probability.json'), JSON.stringify(prob, null, 2));

  const a = decision.analysis[sym];
  const analysis = {
    meta: { runId: `bt-pilot-${date}`, analyzedAt: `${date}T15:00:00Z` },
    analyses: [{
      symbol: sym, name: c.name,
      direction: a.direction, confidence: a.confidence,
      q1_driver: { primary: a.driver, secondary: null, evidence: a.driver, source: 'recorded-llm' },
      q2_trendOrImpulse: { judgment: 'trend', volumeConviction: 'recorded', oiStructure: 'recorded', priceAlignment: 'recorded' },
      q3_odds: { bias: a.direction, longCase: [], shortCase: [], summary: a.driver },
      q4_confirmation: { signals: [a.confirm] },
      q5_invalidation: { conditions: [a.invalidation] },
      q6_risks: { limitDistance: '试点默认 4%', overnightGap: '有夜盘', margin: '试点', eventRisk: 'recorded' }
    }]
  };
  fs.writeFileSync(path.join(runDir, 'analysis.json'), JSON.stringify(analysis, null, 2));

  const reportModel = {
    meta: { runId: `bt-pilot-${date}`, generatedAt: `${date}T15:00:00Z` },
    opportunities: [{
      symbol: sym, name: c.name, rank: 1, sector: c.sector,
      marketFacts: { hv: { annual: hv } },
      priceRanges: [{ atrBand: { atr5 } }],
      screening: { initialDirection: a.direction, initialConfidence: a.confidence },
      thesis: {
        finalDirection: a.direction, finalConfidence: a.confidence,
        driver: { primary: a.driver },
        confirmations: { signals: [a.confirm] },
        invalidations: { conditions: [a.invalidation] }
      }
    }]
  };
  fs.writeFileSync(path.join(runDir, 'report-model.json'), JSON.stringify(reportModel, null, 2));
  return sym;
}

function main() {
  const rows = [];
  const feedbackRoot = path.join(pilotRoot, 'feedback');
  const manifestRoot = path.join(__dirname, 'recordings');
  for (const date of manifest.dates) {
    const decision = manifest.llmDecisions[date];
    const runId = `bt-pilot-${date}`;
    const raw = truncateRaw(date);
    const runDir = path.join(pilotRoot, 'runs', runId);
    const sym = makeArtifacts(runDir, date, raw, decision);
    const { plan, schema } = buildStrategyPlan({ runId, equityCny: 100000 });
    const check = validatePlan(plan, schema);
    if (!check.ok) throw new Error(`${runId}: schema failed ${check.errors.join('; ')}`);
    fs.writeFileSync(path.join(runDir, 'strategy-plan.json'), JSON.stringify(plan, null, 2));
    recordExecutablePlans(plan, `${date}T15:00:00Z`, feedbackRoot);
    const feedback = verifyPlans(`verify-${date}`, cache, feedbackRoot);
    const p = plan.plans[0];
    const prev = feedback.results.find(r => r.recordId !== `${runId}:${sym}` && r.status !== 'pending_data');
    rows.push({ date, sym, direction: p.reportBaseline.direction, playbook: p.playbook.playbookId, status: p.executionStatus, triggerLevel: p.entry.triggerLevel, stop: p.stop.stopPrice, prevFeedback: prev ? prev.status : null });
  }

  // 最后再跑一遍 verify，把所有历史计划都纳入
  const finalFeedback = verifyPlans('verify-final', cache, feedbackRoot);
  const report = {
    meta: {
      mode: 'full-chain-pilot',
      universe: manifest.universe,
      dates: manifest.dates,
      websearch: manifest.websearch,
      note: '小批量、样本内、含 LLM recorded 输出；不代表未来表现'
    },
    plans: rows,
    feedback: finalFeedback
  };
  fs.writeFileSync(path.join(__dirname, 'baseline-report.json'), JSON.stringify(report, null, 2));
  const md = [
    '# 完整策略链回测试点 baseline',
    '',
    `- universe: ${manifest.universe.join(', ')}`,
    `- dates: ${manifest.dates.join(', ')}`,
    `- LLM mode: ${manifest.websearch}`,
    '',
    '| date | symbol | direction | playbook | plan status | trigger | stop | prior feedback |',
    '|------|--------|-----------|----------|-------------|---------|------|----------------|',
    ...rows.map(r => `| ${r.date} | ${r.sym} | ${r.direction} | ${r.playbook} | ${r.status} | ${r.triggerLevel} | ${r.stop} | ${r.prevFeedback || '—'} |`),
    '',
    '## feedback results',
    '```json',
    JSON.stringify(finalFeedback, null, 2),
    '```'
  ].join('\n');
  fs.writeFileSync(path.join(__dirname, 'baseline-report.md'), md);
  console.log(`Wrote ${path.join(__dirname, 'baseline-report.md')}`);
  console.table(rows);
}

main();
