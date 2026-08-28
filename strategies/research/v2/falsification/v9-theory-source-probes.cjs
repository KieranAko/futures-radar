// strategies/research/v2/falsification/v9-theory-source-probes.cjs — V9 理论来源探针实验
//
// 实验问题：三类理论来源（A 学术模式 / B 市场机制-日历 / C 微观结构）在廉价预注册探针下通过率如何？
// 纪律：只做探针，不改变任何策略状态；PIT 无未来函数；通过≠可执行，只决定 V10 研究方向。
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const HIST = JSON.parse(fs.readFileSync(path.join(ROOT, 'research', 'backtest', 'data', 'historical-cache.json'), 'utf8'));
const GA2 = path.join(__dirname, 'data', 'ga2-derived');
const MACRO = JSON.parse(fs.readFileSync(path.join(ROOT, 'strategies', 'signal-backtest', 'recordings', 'v5', 'macro-history.json'), 'utf8'));
const CAL = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'ga7-policy-calendar-v0.json'), 'utf8'));
const ROLL = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'ga1-roll-jumps.json'), 'utf8'));

const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const sd = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))); };
const ci = a => { if (a.length < 2) return [null, null]; const m = mean(a); const se = sd(a) / Math.sqrt(a.length); return [m - 1.96 * se, m + 1.96 * se]; };
const round = (v, d = 4) => (v == null || !isFinite(v) ? v : Math.round(v * Math.pow(10, d)) / Math.pow(10, d));

function barsOf(sym) { const c = HIST.contracts[sym]; return c && c.ohlcv ? c.ohlcv : null; }
function derived(sym) { const p = path.join(GA2, `${sym}.json`); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')).series : null; }
function idxOf(bars, date) { return bars.dates.indexOf(date); }

function evalProbe(name, rets) {
  const n = rets.length;
  const hit = rets.filter(r => r > 0).length;
  const m = mean(rets);
  const c = ci(rets);
  const pass = n >= 200 && hit / n >= 0.55 && m > 0.10 && c[0] != null && c[0] > 0;
  return { name, n, hitRate: n ? round(hit / n * 100, 2) : null, meanPct: round(m, 4), ci: c.map(x => x == null ? null : round(x, 4)), pass };
}

// A1 TR-02 压缩→突破（学术）
function probeA1() {
  const rets = [];
  for (const sym of Object.keys(HIST.contracts || {})) {
    const b = barsOf(sym); const d = derived(sym);
    if (!b || !d || b.dates.length < 80) continue;
    for (let i = 60; i + 6 < b.dates.length; i++) {
      if (d.hvPct90[i] == null || d.hvPct90[i] > 30) continue;
      const high20 = Math.max(...b.high.slice(i - 20, i));
      const low20 = Math.min(...b.low.slice(i - 20, i));
      let dir = 0;
      if (b.close[i] > high20) dir = 1;
      else if (b.close[i] < low20) dir = -1;
      if (dir === 0) continue;
      rets.push((b.close[i + 5] / b.open[i + 1] - 1) * 100 * dir);
    }
  }
  return evalProbe('A1-TR02-压缩突破', rets);
}

// A2 M3 美债实际利率→贵金属（学术）
function probeA2() {
  const us = new Map(MACRO.indicators.US10Y.series.map(([d, v]) => [d, v]));
  const rets = [];
  for (const sym of ['AU0', 'AG0']) {
    const b = barsOf(sym); if (!b) continue;
    for (let i = 60; i + 10 < b.dates.length; i++) {
      const v0 = [...us.keys()].filter(d => d <= b.dates[i - 5]).sort().at(-1);
      const v1 = [...us.keys()].filter(d => d <= b.dates[i]).sort().at(-1);
      if (v0 == null || v1 == null) continue;
      const chg = us.get(v1) - us.get(v0);
      if (Math.abs(chg) < 0.10) continue;
      rets.push((b.close[i + 10] / b.open[i + 1] - 1) * 100 * (-Math.sign(chg)));
    }
  }
  return evalProbe('A2-M3-利率→贵金属', rets);
}

// B1 政策窗口后事件方向延续（机制-日历）
function probeB1() {
  const dirByType = { policy_window: 1, structural_event: 1, reserve_window: 0 };
  const rets = [];
  for (const ev of CAL.events || []) {
    if (!ev.scope || !ev.date) continue;
    let dir = dirByType[ev.type] ?? 1;
    // 事件 id 特化：反倾销→农产品多；负油价→能化空；俄乌→能化多（首日冲击方向代理）
    if (/2024ad/.test(ev.id)) dir = 1;
    if (/2020oil/.test(ev.id)) dir = -1;
    if (/2022ru/.test(ev.id)) dir = 1;
    for (const s of ev.scope) {
      if (!/0$/.test(s)) continue;
      const b = barsOf(s); if (!b) continue;
      let i = idxOf(b, ev.date);
      if (i < 0) i = b.dates.findIndex(d => d >= ev.date);
      if (i < 60 || i + 6 >= b.dates.length) continue;
      rets.push((b.close[i + 5] / b.open[i + 1] - 1) * 100 * dir);
    }
  }
  return evalProbe('B1-政策窗口延续', rets);
}

// B2 换月周漂移延续（机制-微观）
function probeB2() {
  const rets = [];
  for (const [sym, rows] of Object.entries(ROLL.bySymbol || {})) {
    const b = barsOf(sym); if (!b) continue;
    for (const row of rows) {
      const i = idxOf(b, row.date);
      if (i < 10 || i + 6 >= b.dates.length) continue;
      const dir = Math.sign(b.close[i] - b.close[i - 5]);
      if (dir === 0) continue;
      rets.push((b.close[i + 5] / b.open[i + 1] - 1) * 100 * dir);
    }
  }
  return evalProbe('B2-换月周漂移', rets);
}

// C1 隔夜大跳空反向（微观结构）
function probeC1() {
  const rets = [];
  for (const sym of Object.keys(HIST.contracts || {})) {
    const b = barsOf(sym); const d = derived(sym);
    if (!b || !d) continue;
    for (let i = 60; i + 6 < b.dates.length; i++) {
      const gap = b.open[i] / b.close[i - 1] - 1;
      const thr = 1.5 * (d.atr5[i - 1] || 0) / b.close[i - 1];
      if (Math.abs(gap) < thr) continue;
      const dir = -Math.sign(gap);
      rets.push((b.close[i + 5] / b.open[i] - 1) * 100 * dir);
    }
  }
  return evalProbe('C1-隔夜跳空反向', rets);
}

// C2 放量极端日反向（微观结构）
function probeC2() {
  const rets = [];
  for (const sym of Object.keys(HIST.contracts || {})) {
    const b = barsOf(sym); const d = derived(sym);
    if (!b || !d) continue;
    for (let i = 60; i + 6 < b.dates.length; i++) {
      const r = b.close[i] / b.close[i - 1] - 1;
      const thr = 1.5 * (d.atr5[i - 1] || 0) / b.close[i - 1];
      if ((d.volumeRatio[i] || 0) < 2.5 || Math.abs(r) < thr) continue;
      const dir = -Math.sign(r);
      rets.push((b.close[i + 5] / b.open[i + 1] - 1) * 100 * dir);
    }
  }
  return evalProbe('C2-放量极端反向', rets);
}

function main() {
  const probes = [probeA1(), probeA2(), probeB1(), probeB2(), probeC1(), probeC2()];
  const arms = { A_academic: probes.filter(p => p.name.startsWith('A')), B_mechanism: probes.filter(p => p.name.startsWith('B')), C_microstructure: probes.filter(p => p.name.startsWith('C')) };
  const summary = {};
  for (const [arm, ps] of Object.entries(arms)) summary[arm] = { probes: ps.length, pass: ps.filter(p => p.pass).length, results: ps };
  const out = {
    schema: 'futures-strategy-v9-theory-source-probes/1',
    generatedAt: new Date().toISOString(),
    preregisteredCriteria: 'n>=200, hitRate>=55%, mean>0.10%, 95% CI lower>0（5日对齐收益，成本0.07%未扣）',
    arms: summary,
    conclusionHint: summary.A_academic.pass + summary.B_mechanism.pass + summary.C_microstructure.pass === 0
      ? '本轮三来源均无探针通过；V10 应停止按现有来源扩充，转向机制访谈/新数据'
      : '存在通过探针的来源；V10 优先对该来源做完整证伪'
  };
  fs.writeFileSync(path.join(__dirname, '22-v9-theory-source-probes.json'), JSON.stringify(out, null, 2), 'utf8');
  console.log(JSON.stringify(out, null, 2));
}

if (require.main === module) main();
module.exports = { main, probeA1, probeA2, probeB1, probeB2, probeC1, probeC2 };
