// strategies/signal-backtest/adapters/strategy-plan-adapter.cjs — 回测 → 生产 strategy-plan 适配器
//
// 目标（V8 架构裁定）：
//   FinCoT 只是分析模块，保证分析质量；交易策略适配模块必须消费 FinCoT 分析，
//   经由生产策略库/匹配引擎（strategies/lib/strategy-matcher.cjs）产出 strategy-plan，
//   执行引擎再按 strategy-plan 执行。
//
// 本适配器把一个锚点的回测证据 + FinCoT 包装成生产 run 目录形状，
// 原样调用 buildStrategyPlan()，不修改生产 matcher、不调用 LLM。
'use strict';

const fs = require('fs');
const path = require('path');
const { runDir } = require('../../../lib/workspace.cjs');
const { buildStrategyPlan, validatePlan } = require('../../lib/strategy-matcher.cjs');

const ROOT = path.resolve(__dirname, '..');
const V7 = path.join(ROOT, 'recordings', 'v7');
const HISTORY = JSON.parse(fs.readFileSync(path.join(V5_ORIGIN(), 'history-2y.json'), 'utf8'));

function V5_ORIGIN() { return path.join(ROOT, 'recordings', 'v5'); }

const SYMBOLS = ['RB0', 'M0', 'SC0'];

function loadContext(symbol) {
  const evidence = JSON.parse(fs.readFileSync(path.join(V7, `evidence-${symbol}.json`), 'utf8'));
  const fincot = JSON.parse(fs.readFileSync(path.join(V7, `fincot-v7-${symbol}.json`), 'utf8'));
  const rowByDate = Object.fromEntries(evidence.rows.map(r => [r.d, r]));
  const finByDate = Object.fromEntries(fincot.entries.map(e => [e.anchorDate, e]));
  return { rowByDate, finByDate };
}

function truncateBars(symbol, date) {
  const bars = HISTORY.symbols[symbol].bars;
  const idx = bars.findIndex(b => b.date === date);
  if (idx < 20) throw new Error(`${symbol} ${date}: need >=21 bars`);
  return bars.slice(0, idx + 1);
}

function macroSnapshot(row) {
  const indicators = {};
  for (const [id, arr] of Object.entries(row.macro)) {
    const [mmdd, value, change5d] = arr || [];
    indicators[id] = {
      status: mmdd === row.d.slice(5) ? 'fresh' : 'stale',
      value, change5d, asOf: mmdd ? `2026-${mmdd}` : null,
      source: 'v7-evidence', fetchedAt: null
    };
  }
  return { meta: { runId: 'v7-adapter', signalDate: row.d, schemaVersion: '1.0.0' }, indicators, quality: {} };
}

function sectorSnapshot(symbol, row) {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, '..', '..', 'config', 'symbols.json'), 'utf8'));
  const target = Object.values(cfg.symbols).find(v => v.symbol === symbol);
  const sector = target.sector;
  const s = row.sect;
  const dir = (s.r5 ?? 0) > 0.3 ? 'up' : (s.r5 ?? 0) < -0.3 ? 'down' : 'flat';
  return {
    schema: 'futures-radar-sector-snapshot/1',
    meta: { runId: 'v7-adapter', signalDate: row.d, generatedAt: null, method: 'v7-evidence', directionThresholdPct: 0.3, source: 'derived:v5-sector-history' },
    sectors: {
      [sector]: {
        sector, label: cfg.sectors[sector]?.label || sector, direction: dir,
        indexLevel: 1000 * (1 + (s.r20 ?? 0) / 100),
        ret1d: s.r1, ret5d: s.r5, ret20d: s.r20,
        advanceRatio1d: (s.br ?? 0.5) * 100, advanceRatio5d: (s.br ?? 0.5) * 100,
        coherence1d: (s.co ?? 0.5) * 100,
        volumeRatio20d: 1,
        leaderSymbol: s.lead ? s.lead.split(',')[0].split(':')[0] : symbol,
        leaderName: s.lead ? s.lead.split(',')[0].split(':')[0] : symbol,
        leaderRet5d: s.lead ? parseFloat(s.lead.split(',')[0].split(':')[1] || 0) : 0,
        leaders: [], laggards: []
      }
    }
  };
}

function sectorDriver(symbol, row, fin) {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, '..', '..', 'config', 'symbols.json'), 'utf8'));
  const sector = Object.values(cfg.symbols).find(v => v.symbol === symbol).sector;
  return {
    meta: { runId: 'v7-adapter', signalDate: row.d, generatedAt: null, mode: 'v7-fincot' },
    sectors: {
      [sector]: {
        sector, signalDate: row.d, status: 'ok',
        direction_observed: (row.sect.r5 ?? 0) > 0 ? 'up' : 'down',
        member_structure: 'v7-evidence',
        driver: { primary: fin.sectorSupport || 'neutral', confidence: 'low' },
        reason: '由 V7 FinCoT 分析映射；回测不执行板块级 WebSearch',
        relation_to_individual: 'context_only'
      }
    }
  };
}

function probability(symbol, date, atr5, close) {
  return {
    meta: { runId: 'v7-adapter', calculatedAt: null, stage: 'v7', estimatorUsed: { [symbol]: 'atr-proxy' } },
    probabilities: [{
      symbol, seriesSource: `main-continuous:${symbol}`, close,
      hv: { annual: 0.2, periodDays: 20, percentile90d: 50, degraded: false },
      cone: { '3d': [close - 1.5 * atr5, close + 1.5 * atr5], '5d': [close - 2 * atr5, close + 2 * atr5] },
      atrComparison: { hv95Band3d: [close - 1.5 * atr5, close + 1.5 * atr5], atr5 }
    }]
  };
}

function reportModel(symbol, row, fin, atr5, close) {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, '..', '..', 'config', 'symbols.json'), 'utf8'));
  const target = Object.values(cfg.symbols).find(v => v.symbol === symbol);
  const sector = target.sector;
  return {
    meta: { runId: 'v7-adapter', generatedAt: `${row.d}T00:00:00Z`, signalDate: row.d },
    screening: {}, rejected: [],
    macro: { indicators: macroSnapshot(row).indicators },
    sector: { direction: (row.sect.r5 ?? 0) > 0 ? 'up' : 'down', movement: { ret5d: row.sect.r5 } },
    sectorDriver: { sectors: sectorDriver(symbol, row, fin).sectors },
    freshness: {},
    opportunities: [{
      symbol, name: target.name, rank: 1, sector, contract: symbol,
      marketFacts: { hv: { annual: 0.2, periodDays: 20, percentile90d: 50, degraded: false }, provenance: {} },
      priceRanges: [{
        period: '3d',
        hvCone: { p68: [close - atr5, close + atr5], p95: [close - 2 * atr5, close + 2 * atr5] },
        atrBand: { atr5, band: [close - 2 * atr5, close + 2 * atr5] },
        divergence: { pct: 0, interpretation: 'v7 代理口径' },
        provenance: {}
      }],
      thesis: {
        driver: { primary: fin.q.q1_driver.text || '', secondary: '' },
        trendOrImpulse: { assessment: fin.q.q2_trend.text || '' },
        odds: { bias: fin.direction === 'bullish' ? 'bullish' : fin.direction === 'bearish' ? 'bearish' : 'neutral', reasoning: fin.q.q3_odds.text || '' },
        confirmations: { signals: [`${fin.blueprintId}:${fin.q.q4_confirmation.type}@${fin.q.q4_confirmation.level}`] },
        invalidations: { conditions: [fin.q.q5_invalidation.reason || ''] },
        risks: { items: [fin.q.q6_risk.text || ''] },
        finalDirection: fin.direction,
        finalConfidence: fin.confidence
      }
    }]
  };
}

function analysis(symbol, fin) {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, '..', '..', 'config', 'symbols.json'), 'utf8'));
  const name = Object.values(cfg.symbols).find(v => v.symbol === symbol).name;
  return {
    meta: { runId: 'v7-adapter', analyzedAt: `${fin.anchorDate}T00:00:00Z`, candidateCount: 1, mode: 'v7-fincot' },
    analyses: [{
      symbol, name, reasoningRef: { artifactId: 'fincot-v7', arm: 'fincot' },
      direction: fin.direction, confidence: fin.confidence, override: null,
      q1_driver: { primary: fin.q.q1_driver.text || '', secondary: '', evidence: '' },
      q2_trendOrImpulse: { judgment: fin.regime, volumeConviction: fin.q.q2_trend.text || '' },
      q3_odds: { bias: fin.direction, reasoning: fin.q.q3_odds.text || '', opposing: (fin.q.q3_odds.opposingRefs || []).join(',') },
      q4_confirmations: { signals: [`${fin.q.q4_confirmation.type}@${fin.q.q4_confirmation.level}`] },
      q5_invalidations: { conditions: [fin.q.q5_invalidation.reason || ''] },
      q6_risks: { items: [fin.q.q6_risk.text || ''], limitDistance: '4%' }
    }]
  };
}

function rawJson(symbol, date, bars) {
  const o = bars.map(b => [b.date, b.open, b.high, b.low, b.close, b.volume]);
  return {
    contracts: {
      [symbol]: {
        ohlcv: {
          dates: o.map(x => x[0]), open: o.map(x => x[1]), high: o.map(x => x[2]),
          low: o.map(x => x[3]), close: o.map(x => x[4]), volume: o.map(x => x[5])
        },
        derived: {}
      }
    }
  };
}

function writeRunDir(runId, symbol, date, row, fin) {
  const dir = runDir(runId);
  fs.mkdirSync(path.join(dir, 'analyze'), { recursive: true });
  const bars = truncateBars(symbol, date);
  const close = row.c;
  const atr5 = row.a5;
  fs.writeFileSync(path.join(dir, 'report-model.json'), JSON.stringify(reportModel(symbol, row, fin, atr5, close), null, 2));
  fs.writeFileSync(path.join(dir, 'analysis.json'), JSON.stringify(analysis(symbol, fin), null, 2));
  fs.writeFileSync(path.join(dir, 'macro-snapshot.json'), JSON.stringify(macroSnapshot(row), null, 2));
  fs.writeFileSync(path.join(dir, 'sector-snapshot.json'), JSON.stringify(sectorSnapshot(symbol, row), null, 2));
  fs.writeFileSync(path.join(dir, 'sector-driver.json'), JSON.stringify(sectorDriver(symbol, row, fin), null, 2));
  fs.writeFileSync(path.join(dir, 'probability.json'), JSON.stringify(probability(symbol, date, atr5, close), null, 2));
  fs.writeFileSync(path.join(dir, 'raw.json'), JSON.stringify(rawJson(symbol, date, bars), null, 2));
  fs.writeFileSync(path.join(dir, 'analyze', 'main-series.json'), JSON.stringify({ [symbol]: { contract: symbol, bars } }, null, 2));
}

function adaptOne(symbol, date, { equityCny = 100000 } = {}) {
  const { rowByDate, finByDate } = loadContext(symbol);
  const row = rowByDate[date];
  const fin = finByDate[date];
  if (!row || !fin) throw new Error(`missing context for ${symbol} ${date}`);
  const runId = `v7-${symbol}-${date}`;
  writeRunDir(runId, symbol, date, row, fin);
  const { plan, schema } = buildStrategyPlan({ runId, equityCny });
  const check = validatePlan(plan, schema);
  if (!check.ok) throw new Error(`${symbol} ${date}: schema fail: ${check.errors.join('; ')}`);
  const outDir = path.join(V7, 'strategy-plans');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `${symbol}-${date}.json`), JSON.stringify(plan, null, 2), 'utf8');
  return plan;
}

function adaptAll() {
  const manifest = { schema: 'futures-radar-v7-strategy-plan-manifest/1', generatedAt: new Date().toISOString(), symbols: [] };
  for (const sym of SYMBOLS) {
    const { rowByDate, finByDate } = loadContext(sym);
    const rows = Object.keys(rowByDate).sort();
    const plans = [];
    for (const date of rows) {
      const plan = adaptOne(sym, date);
      plans.push({
        date,
        symbol: sym,
        direction: plan.plans[0]?.reportBaseline?.direction,
        matchedStrategies: plan.plans[0]?.matchedStrategies?.map(m => m.strategyId) || [],
        executionStatus: plan.plans[0]?.executionStatus,
        playbookId: plan.plans[0]?.playbook?.playbookId
      });
    }
    manifest.symbols.push({ symbol: sym, plans });
  }
  fs.writeFileSync(path.join(V7, 'strategy-plans', 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return manifest;
}

if (require.main === module) console.log(JSON.stringify(adaptAll(), null, 2));

module.exports = { adaptOne, adaptAll, loadContext };
