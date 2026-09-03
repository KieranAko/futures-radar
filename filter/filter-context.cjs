// filter/filter-context.cjs — 初筛上下文冻结（分诊式，不联网、不调用 LLM）
//
// 为 Top10 passed 候选生成 filter-context.json + filter-prompt.md：
//   行情 / 量仓（含 OI 5日变化）/ 板块 / 宏观 / 成本锚（主档有则带）
// 用途：filter-llm 三问分诊（有没有行情？有没有可验证线索？值不值得深挖？）
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { runDir } = require('../lib/workspace.cjs');
const dataStore = require('../data-store/index.cjs');
const { relevantAnchorsFor } = require('../report/build-facts.cjs');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function fmt(v, d = 2) {
  return Number.isFinite(Number(v)) ? Number(v).toFixed(d) : '—';
}

function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--runId');
  const runId = i >= 0 ? args[i + 1] : null;
  if (!runId) throw new Error('--runId required');

  const dir = runDir(runId);
  const hard = readJson(path.join(dir, 'filtered-hard.json'));
  const candidates = readJson(path.join(dir, 'candidates.json'));
  const raw = readJson(path.join(dir, 'raw.json'));
  const macro = readJson(path.join(dir, 'macro-snapshot.json'));
  const sectorSnap = readJson(path.join(dir, 'sector-snapshot.json'));
  const signalDate = sectorSnap.meta && sectorSnap.meta.signalDate;

  const rows = [];
  for (const c of hard.passed) {
    const rc = raw.contracts && raw.contracts[c.symbol];
    const o = rc && rc.ohlcv;
    const n = o && o.dates ? o.dates.length : 0;
    const close = o ? o.close[n - 1] : c.trend.close;
    const chg1d = n >= 2 ? ((o.close[n - 1] / o.close[n - 2]) - 1) * 100 : null;
    const oi = o && Array.isArray(o.openInterest) && o.openInterest.length >= 6
      ? ((o.openInterest[n - 1] / o.openInterest[n - 6]) - 1) * 100
      : null;
    const sector = sectorSnap.sectors && sectorSnap.sectors[c.sector] ? sectorSnap.sectors[c.sector] : null;
    const anchors = [];
    for (const id of relevantAnchorsFor(c.symbol)) {
      const ind = macro.indicators && macro.indicators[id];
      if (ind && ind.status !== 'missing') {
        anchors.push({ id, value: ind.value, change5d: ind.change5d, status: ind.status, asOf: ind.asOf });
      }
    }
    const costAnchor = dataStore.getCostAnchor(c.symbol, signalDate);
    rows.push({
      symbol: c.symbol,
      name: c.name,
      exchange: c.exchange,
      sector: c.sector,
      price: {
        close,
        change1dPct: chg1d == null ? null : Math.round(chg1d * 100) / 100,
        change5dPct: c.indicators.change5d,
        atr5: c.indicators.atr5,
        atrPct: c.indicators.atrPct,
        volPercentile: c.indicators.volPercentile,
        volMultiplier: c.indicators.volMultiplier,
        vsMA20: c.trend.vsMA20,
        vsMA60: c.trend.vsMA60,
        trendDirection: c.trend.direction,
        high20d: null,
        low20d: null
      },
      flow: {
        avgTurnover5dYi: c.liquidity.avgTurnover5d / 1e8,
        avgOI5dWan: c.liquidity.avgOI5d / 1e4,
        oiChange5dPct: oi == null ? null : Math.round(oi * 100) / 100
      },
      sectorContext: sector ? {
        direction: sector.direction,
        ret1d: sector.ret1d,
        ret5d: sector.ret5d,
        advanceRatio1d: sector.advanceRatio1d,
        coherence1d: sector.coherence1d != null ? sector.coherence1d : null,
        breadth1d: sector.breadth1d != null ? sector.breadth1d : null,
        downRatio1d: sector.downRatio1d != null ? sector.downRatio1d : null,
        leaderSymbol: sector.leaderSymbol,
        leaderName: sector.leaderName
      } : null,
      macroAnchors: anchors,
      costAnchor: costAnchor ? {
        anchorType: costAnchor.anchorType,
        indicator: costAnchor.indicator,
        valueLow: costAnchor.valueLow,
        valueHigh: costAnchor.valueHigh,
        confidence: costAnchor.confidence,
        asOf: costAnchor.asOf
      } : null,
      score: c.score,
      scoreRank: c.rank,
      scannerRank: c.rank
    });
  }

  const context = {
    schema: 'futures-radar-filter-context/1',
    runId,
    signalDate,
    rejectedTombstone: hard.rejected.map((r) => ({ symbol: r.symbol, reason: r.reason || 'hard filter' })),
    rows
  };
  const ctxPath = path.join(dir, 'filter-context.json');
  writeJson(ctxPath, context);

  function sectorResonanceLine(sc, trendDirection) {
    if (!sc || sc.coherence1d == null) return '板块方向不一致，共振中性';
    const dir = trendDirection;
    const aligned = (dir === 'up' && sc.direction === 'up') || (dir === 'down' && sc.direction === 'down');
    if (dir === 'flat' || sc.direction === 'flat') return `板块方向不一致，共振中性（coherence ${fmt(sc.coherence1d, 1)}%）`;
    if (aligned) return `与板块一致，共振 ${fmt(sc.coherence1d, 1)}%`;
    return `与板块相反，逆势 ${fmt(Math.max(0, 100 - sc.coherence1d), 1)}%`;
  }

  const lines = [];
  lines.push(`# Filter 初筛 prompt（runId=${runId}）`);
  lines.push('');
  lines.push('你是初筛员，不是分析师。只回答三问：');
  lines.push('1. 有没有行情？');
  lines.push('2. 有没有可验证的驱动线索（可作假设，不要求证实）？');
  lines.push('3. 值不值得占用一个 TOP3 深挖名额？');
  lines.push('');
  lines.push('方向中性：多头/空头完全对等，有行情机会的更优先；禁止因“上涨广度”否定空头候选。');
  lines.push('板块共振：多头看上涨共振，空头看下跌共振；逆势候选需要独立驱动才保留。');
  lines.push('禁止输出：赔率、longCase/shortCase、入场/止损/方向结论。');
  lines.push('KEEP ≤3；硬过滤墓碑不可复活；无来源线索必须标"待验证"。');
  lines.push('');
  for (const r of rows) {
    lines.push(`### ${r.symbol} ${r.name}（${r.sector}）`);
    lines.push(`- price: close=${fmt(r.price.close)} 1d=${fmt(r.price.change1dPct)}% 5d=${fmt(r.price.change5dPct)}% atr=${fmt(r.price.atr5)} atrPct=${fmt(r.price.atrPct)}% volP=${fmt(r.price.volPercentile)} volMult=${fmt(r.price.volMultiplier)} vs20=${fmt(r.price.vsMA20)}% vs60=${fmt(r.price.vsMA60)}%`);
    lines.push(`- flow: turnover=${fmt(r.flow.avgTurnover5dYi, 1)}亿 OIavg=${fmt(r.flow.avgOI5dWan, 1)}万 OI5d=${fmt(r.flow.oiChange5dPct)}%`);
    lines.push(`- sector: ${r.sectorContext ? `${r.sectorContext.direction} 1d=${fmt(r.sectorContext.ret1d)}% 5d=${fmt(r.sectorContext.ret5d)}% advance=${fmt(r.sectorContext.advanceRatio1d, 1)}% coherence=${fmt(r.sectorContext.coherence1d, 1)}% ${sectorResonanceLine(r.sectorContext, r.price.trendDirection)}` : '无'}`);
    lines.push(`- macro: ${r.macroAnchors.length ? r.macroAnchors.map((a) => `${a.id}=${a.value}(${a.change5d}%)`).join(', ') : '无'}`);
    lines.push(`- costAnchor: ${r.costAnchor ? JSON.stringify(r.costAnchor) : 'unavailable'}`);
    lines.push('');
  }
  lines.push('输出 filtered.json（每个候选）:');
  lines.push('{"symbol":"...","rank":1,"directionHint":"bullish|bearish|unclear","decision":"KEEP|DOWNGRADE","confidence":"high|medium|low","reason":"1-2句：行情事实+线索假设+为什么值得/不值得","informationGap":"进入深度分析需查证的问题"}');
  const promptPath = path.join(dir, 'filter-prompt.md');
  fs.writeFileSync(promptPath, lines.join('\n'), 'utf8');
  console.log(`filter-context: ${ctxPath}`);
  console.log(`filter-prompt: ${promptPath}`);
  return { context, prompt: promptPath };
}

if (require.main === module) main();
module.exports = { main };
