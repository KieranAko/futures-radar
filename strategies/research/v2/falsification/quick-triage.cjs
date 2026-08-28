// strategies/research/v2/falsification/quick-triage.cjs — 策略快速筛选（只做优先级，不放行）
//
// 第 0/1/2 层：结构性三筛 + 样本/效应量代理 + 廉价代理测试。
// 纪律：快检结果不得改变库状态；证伪仍不可跳过。
'use strict';

const fs = require('fs');
const path = require('path');
const store = require('../../../../data-store/index.cjs');
const HIST_CACHE_PATH = path.join(__dirname, '..', '..', '..', '..', 'research', 'backtest', 'data', 'historical-cache.json');

const OUT = path.join(__dirname, '20-quick-triage.json');
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const sd = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))); };
const ci = a => { const m = mean(a); const se = sd(a) / Math.sqrt(a.length); return [m - 1.96 * se, m + 1.96 * se]; };
const round = (v, d = 4) => (v == null || !isFinite(v) ? v : Math.round(v * Math.pow(10, d)) / Math.pow(10, d));

let CACHE = null;
function getCache() {
  if (!CACHE) {
    CACHE = fs.existsSync(HIST_CACHE_PATH)
      ? JSON.parse(fs.readFileSync(HIST_CACHE_PATH, 'utf8'))
      : store.loadHistoricalCache();
  }
  return CACHE;
}
function loadSeries(symbol) {
  const cache = getCache();
  const c = cache.contracts && cache.contracts[symbol];
  if (!c || !c.ohlcv || !Array.isArray(c.ohlcv.dates) || c.ohlcv.dates.length < 100) return null;
  const p = path.join(__dirname, 'data', 'ga2-derived', `${symbol}.json`);
  if (!fs.existsSync(p)) return null;
  const d = JSON.parse(fs.readFileSync(p, 'utf8')).series;
  // 对齐日期（derived 以 daily 源生成，直接按索引）
  return { ohlcv: c.ohlcv, d };
}

function tr01Proxy() {
  const rows = [];
  const symbols = [];
  for (const sym of Object.keys(getCache().contracts || {})) {
    const s = loadSeries(sym);
    if (!s || s.ohlcv.dates.length !== s.d.dates.length) continue;
    symbols.push(sym);
    const { dates, close, high, low } = s.ohlcv;
    const { ma20, ma60 } = s.d;
    for (let i = 60; i + 6 < dates.length; i++) {
      if (ma20[i] == null || ma60[i] == null) continue;
      let dir = 0;
      if (close[i] > ma20[i] && close[i] > ma60[i]) dir = 1;
      else if (close[i] < ma20[i] && close[i] < ma60[i]) dir = -1;
      if (dir === 0) continue;
      const fwd = (close[i + 5] / s.ohlcv.open[i + 1] - 1) * 100 * dir;
      // T 日已知确认代理：当日 bar 方向与信号方向一致 且 量比≥1（无未来信息）
      const barDir = Math.sign(close[i] - s.ohlcv.open[i]);
      const confirmed = barDir === dir && (s.d.volumeRatio[i] ?? 0) >= 1;
      rows.push({ sym, date: dates[i], dir, fwd, confirmed });
    }
  }
  const all = rows.map(r => r.fwd);
  const conf = rows.filter(r => r.confirmed).map(r => r.fwd);
  const unconf = rows.filter(r => !r.confirmed).map(r => r.fwd);
  const meanAbs = mean(rows.map(r => Math.abs(r.fwd)));
  const rand = rows.map(() => (Math.random() < 0.5 ? 1 : -1) * (meanAbs / 100)); // 随机方向近似（仅供粗筛）
  return {
    symbols: symbols.length,
    n: rows.length,
    all: { mean: round(mean(all), 4), ci: ci(all).map(x => round(x, 4)) },
    confirmed: { n: conf.length, mean: round(mean(conf), 4), ci: ci(conf).map(x => round(x, 4)) },
    unconfirmed: { n: unconf.length, mean: round(mean(unconf), 4), ci: ci(unconf).map(x => round(x, 4)) },
    diffConfirmedMinusUnconfirmed: round(mean(conf) - mean(unconf), 4)
  };
}

function tr06EventProxy() {
  let events = 0; let totalDays = 0;
  for (const sym of ['RB0', 'M0', 'SC0']) {
    const s = loadSeries(sym);
    if (!s) continue;
    const { dates, close, volume } = s.ohlcv;
    const { atr5, volumeRatio } = s.d;
    for (let i = 60; i < dates.length - 1; i++) {
      if (!dates[i].startsWith('2015') && dates[i] < '2015-01-01') continue;
      totalDays++;
      if (atr5[i] == null || volumeRatio[i] == null || close[i - 1] == null) continue;
      const ret = Math.abs(close[i] / close[i - 1] - 1);
      const atrPct = atr5[i] / close[i];
      const isEvent = ret >= Math.max(2 * atrPct, 0.03) && volumeRatio[i] >= 2;
      if (isEvent) events++;
    }
  }
  return { symbols: ['RB0', 'M0', 'SC0'], totalDays, events };
}

function m1Proxy() {
  const macro = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'strategies', 'signal-backtest', 'recordings', 'v5', 'macro-history.json'), 'utf8'));
  const dr = macro.indicators.DR007.series; // [date, value]
  const drMap = new Map(dr.map(([d, v]) => [d, v]));
  const out = {};
  for (const sym of ['RB0', 'HC0', 'J0', 'SA0', 'FG0']) {
    const s = loadSeries(sym);
    if (!s) continue;
    const { dates, close } = s.ohlcv;
    let n = 0; let pos = 0; let meanRet = 0; let betaSignNeg = 0;
    for (let i = 60; i + 10 < dates.length; i++) {
      if (i < 5) continue;
      const v0 = drMap.get(dates[i - 5]); const v1 = drMap.get(dates[i]);
      if (v0 == null || v1 == null) continue;
      const s5 = v1 - v0;
      if (Math.abs(s5) < 0.5) continue;
      const fwd = (close[i + 10] / close[i] - 1) * 100;
      n++;
      if (s5 > 0.5) { // 理论：流动性收紧 → 空
        const ret = -fwd; meanRet += ret; if (fwd < 0) pos++;
      } else { // 宽松 → 多
        const ret = fwd; meanRet += ret; if (fwd > 0) pos++;
      }
    }
    out[sym] = { n, hitRate: n ? round(pos / n * 100, 2) : null, meanAligned10dPct: n ? round(meanRet / n, 4) : null };
  }
  return out;
}

function main() {
  const res = {
    schema: 'futures-strategy-quick-triage/1',
    generatedAt: new Date().toISOString(),
    layer0_structural: {
      FS02: '理论清晰、模型可识别、数据 blocked（PIT 基差历史未建）→ 先建数据，不做证伪',
      TR01: '理论可证伪、数据就绪、样本充足 → 进代理测试',
      TR06: '数据就绪但事件样本极稀 → 样本层降级',
      M1: '数据就绪、β̂<0 门后样本不足 → 样本层降级',
      FS04: '理论级证伪已触发（夏普 0.077<0.5）→ 低优先级',
      FS05: '理论级证伪已触发（命中 38.7%<55%）→ 低优先级',
      TR03: 'retired，不再投入',
      EC01: 'retired，不再投入'
    },
    layer1_sample: {
      TR01: { status: 'sufficient', note: 'harness n=1756，远超 200 门禁' },
      TR06: { status: 'insufficient', note: 'harness 事件 0 起，滚动 24 月 <30' },
      M1: { status: 'insufficient', note: 'β̂<0 门后 n=7，门禁 200' },
      FS02: { status: 'blocked', note: '缺 2011+ PIT 基差历史，无法估计' },
      FS04: { status: 'falsified', note: '理论级 (b) 已证伪' },
      FS05: { status: 'falsified', note: '理论级 (b) 已证伪' }
    },
    layer2_proxy: {
      TR01: tr01Proxy(),
      TR06: tr06EventProxy(),
      M1: m1Proxy()
    },
    promiseRank: [
      { rank: 1, id: 'FS-02', score: 8, reason: '唯一尚未证伪且理论/模型简单；投入=数据建设而非证伪计算' },
      { rank: 2, id: 'TR-01', score: 6, reason: '确认机制存活，代理测试见 layer2；需要模型改进而非调参' },
      { rank: 3, id: 'TR-06', score: 3, reason: '事件样本不足，先解决事件识别/数据积累' },
      { rank: 4, id: 'M1', score: 2, reason: 'β̂<0 门后样本不足，等待宏观历史延长' },
      { rank: 5, id: 'FS-04', score: 1, reason: '理论级证伪已触发' },
      { rank: 6, id: 'FS-05', score: 1, reason: '理论级证伪已触发' }
    ]
  };
  fs.writeFileSync(OUT, JSON.stringify(res, null, 2), 'utf8');
  console.log(JSON.stringify(res, null, 2));
}

if (require.main === module) main();
module.exports = { main, tr01Proxy, tr06EventProxy, m1Proxy };
