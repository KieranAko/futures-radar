// strategies/research/v2/falsification/waitlist-screening.cjs — 候补池筛选（只排序，不入核心库）
//
// 目的：为“扩充策略库”从 05 文档 §8 候补池筛选下一批值得升级/建设的候选。
// 纪律：不改变任何库状态；代理测试无未来函数；证伪门禁不可跳过。
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const HIST = JSON.parse(fs.readFileSync(path.join(ROOT, 'research', 'backtest', 'data', 'historical-cache.json'), 'utf8'));
const CONTRACTS = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'symbols.json'), 'utf8'));
const MACRO = JSON.parse(fs.readFileSync(path.join(ROOT, 'strategies', 'signal-backtest', 'recordings', 'v5', 'macro-history.json'), 'utf8'));
const GA2_DIR = path.join(__dirname, 'data', 'ga2-derived');

const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const round = (v, d = 4) => (v == null || !isFinite(v) ? v : Math.round(v * Math.pow(10, d)) / Math.pow(10, d));

function parseWaitlistTable() {
  const s = fs.readFileSync(path.join(__dirname, '..', '05-strategy-library-design.md'), 'utf8');
  const section = s.slice(s.indexOf('## 8. 候补池'), s.indexOf('## 9.'));
  const rows = [];
  for (const line of section.split('\n')) {
    const m = line.match(/^\|\s*(M\d+|FS-\d+|FS-P1-\d+|TR-\d+)\s*\|([^|]+)\|([^|]+)\|([^|]+)\|([^|]+)\|/);
    if (m) rows.push({ id: m[1], name: m[2].trim(), status: m[3].trim(), gap: m[4].trim(), upgrade: m[5].trim() });
  }
  return rows;
}

function macroMap(indicator) {
  return new Map((MACRO.indicators[indicator].series || []).map(([d, v]) => [d, v]));
}

function seriesAt(map, date) {
  // 返回 ≤date 的最新值（只用于代理，不写库）
  const keys = [...map.keys()].filter(d => d <= date).sort();
  return keys.length ? map.get(keys[keys.length - 1]) : null;
}

function m2Proxy() {
  const usdcnh = macroMap('USDCNH');
  const symbols = ['CU0', 'AL0', 'ZN0', 'M0', 'RM0', 'P0', 'Y0'];
  const out = {};
  for (const sym of symbols) {
    const c = HIST.contracts[sym];
    if (!c || !c.ohlcv) continue;
    const { dates, close, open } = c.ohlcv;
    let n = 0; let negBeta = 0; let aligned = 0; let meanRet = 0;
    for (let i = 60; i + 10 < dates.length; i++) {
      const d0 = dates[i - 5]; const d1 = dates[i];
      const v0 = seriesAt(usdcnh, d0); const v1 = seriesAt(usdcnh, d1);
      if (v0 == null || v1 == null || v0 === 0) continue;
      const chg5 = (v1 - v0) / v0 * 100;
      if (Math.abs(chg5) < 0.3) continue;
      const fwd = (close[i + 10] / open[i + 1] - 1) * 100;
      const theory = -Math.sign(chg5); // 汇率升值(负) → 商品多；贬值(正) → 商品空
      n++;
      const ret = theory * fwd;
      if (chg5 * fwd < 0) negBeta++;
      if (ret > 0) aligned++;
      meanRet += ret;
    }
    out[sym] = { n, negBetaPct: n ? round(negBeta / n * 100, 1) : null, alignedPct: n ? round(aligned / n * 100, 1) : null, meanAligned10dPct: n ? round(meanRet / n, 4) : null };
  }
  return out;
}

function m3Proxy() {
  const us10y = macroMap('US10Y');
  const symbols = ['AU0', 'AG0'];
  const out = {};
  for (const sym of symbols) {
    const c = HIST.contracts[sym];
    if (!c || !c.ohlcv) continue;
    const { dates, close, open } = c.ohlcv;
    let n = 0; let negBeta = 0; let aligned = 0; let meanRet = 0;
    for (let i = 60; i + 10 < dates.length; i++) {
      const v0 = seriesAt(us10y, dates[i - 5]); const v1 = seriesAt(us10y, dates[i]);
      if (v0 == null || v1 == null) continue;
      const chg5 = v1 - v0;
      if (Math.abs(chg5) < 0.1) continue;
      const fwd = (close[i + 10] / open[i + 1] - 1) * 100;
      const theory = -Math.sign(chg5); // 利率升 → 贵金属空
      n++;
      const ret = theory * fwd;
      if (chg5 * fwd < 0) negBeta++;
      if (ret > 0) aligned++;
      meanRet += ret;
    }
    out[sym] = { n, negBetaPct: n ? round(negBeta / n * 100, 1) : null, alignedPct: n ? round(aligned / n * 100, 1) : null, meanAligned10dPct: n ? round(meanRet / n, 4) : null };
  }
  return out;
}

function tr02Proxy() {
  const out = {};
  for (const sym of Object.keys(HIST.contracts || {})) {
    const c = HIST.contracts[sym];
    const g = path.join(GA2_DIR, `${sym}.json`);
    if (!c || !c.ohlcv || !fs.existsSync(g)) continue;
    const d = JSON.parse(fs.readFileSync(g, 'utf8')).series;
    const { dates, close, open } = c.ohlcv;
    let n = 0; let expanded = 0; let meanRet = 0;
    for (let i = 60; i + 6 < dates.length; i++) {
      if (d.hvPct90[i] == null || d.atr5[i] == null || d.volumeRatio[i] == null) continue;
      if (d.hvPct90[i] > 30) continue; // 压缩态代理：HV 90 分位 ≤30
      // 扩张确认代理：未来 5 日 ATR5 均值 / 当前 ATR5 ≥ 1.3（用当前已知？此处只作快速估计，不计入证伪）
      const futureAtrs = d.atr5.slice(i + 1, i + 6).filter(x => x != null);
      const fa = mean(futureAtrs);
      if (!(fa >= d.atr5[i] * 1.3)) continue;
      expanded++;
      const brk = close[i] >= d.ma20[i] ? 1 : -1; // 简化突破方向代理
      const fwd = (close[i + 5] / open[i + 1] - 1) * 100 * brk;
      meanRet += fwd;
      n++;
    }
    if (n > 0) out[sym] = { n, expanded, meanFwdPct: round(meanRet / n, 4) };
  }
  return out;
}

function seasonalityProxy() {
  // FS-07：按日历月统计 5 日方向对齐收益（所有品种；正向月份计数）
  const months = Array.from({ length: 12 }, () => ({ n: 0, sum: 0 }));
  for (const sym of Object.keys(HIST.contracts || {})) {
    const c = HIST.contracts[sym];
    if (!c || !c.ohlcv) continue;
    const { dates, close, open } = c.ohlcv;
    for (let i = 60; i + 6 < dates.length; i++) {
      const m = Number(dates[i].slice(5, 7)) - 1;
      const dir = Math.sign(close[i] - close[i - 1]);
      const fwd = (close[i + 5] / open[i + 1] - 1) * 100 * dir;
      months[m].n++;
      months[m].sum += fwd;
    }
  }
  return months.map((x, i) => ({ month: i + 1, n: x.n, meanPct: round(x.sum / Math.max(1, x.n), 4) }));
}

function score(rows, proxies) {
  const needKeywords = ['needs-extension', '未验', '重设计', '未回测'];
  return rows.map(r => {
    const data = r.status.includes('available') ? 3 : r.status.includes('needs-extension') ? 1 : 0;
    const theory = /薄弱|未验|重设计|未回测|稀疏/.test(r.gap) ? 1 : 2;
    const gapPenalty = needKeywords.some(k => r.gap.includes(k)) ? 1 : 0;
    const proxy = proxies[r.id] || null;
    let proxyScore = 0;
    if (r.id === 'M2' && proxy) proxyScore = Math.max(...Object.values(proxy).map(x => x.alignedPct || 0)) >= 55 ? 2 : 1;
    if (r.id === 'M3' && proxy) proxyScore = Math.max(...Object.values(proxy).map(x => x.alignedPct || 0)) >= 55 ? 2 : 1;
    if (r.id === 'TR-02' && proxy) proxyScore = Object.values(proxy).some(x => x.n >= 30 && x.meanFwdPct > 0.1) ? 2 : 1;
    const promise = Math.min(10, data * 2 + theory + proxyScore - gapPenalty);
    return { id: r.id, name: r.name, status: r.status, gap: r.gap, upgrade: r.upgrade, dataScore: data, theoryScore: theory, proxy, promise };
  }).sort((a, b) => b.promise - a.promise);
}

function main() {
  const rows = parseWaitlistTable();
  const proxies = { M2: m2Proxy(), M3: m3Proxy(), 'TR-02': tr02Proxy(), 'FS-07': { seasonality: seasonalityProxy() } };
  const ranked = score(rows, proxies);
  const out = {
    schema: 'futures-strategy-waitlist-screening/1',
    generatedAt: new Date().toISOString(),
    total: rows.length,
    ranked,
    note: '只用于筛选/扩充决策；不改变库状态；代理测试不替代证伪。'
  };
  fs.writeFileSync(path.join(__dirname, '21-waitlist-screening.json'), JSON.stringify(out, null, 2), 'utf8');
  console.log(JSON.stringify(out, null, 2));
}

if (require.main === module) main();
module.exports = { main, parseWaitlistTable, m2Proxy, m3Proxy, tr02Proxy, seasonalityProxy };
