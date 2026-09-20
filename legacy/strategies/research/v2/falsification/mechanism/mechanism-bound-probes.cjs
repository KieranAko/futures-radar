// strategies/research/v2/falsification/mechanism/mechanism-bound-probes.cjs
//
// 机制绑定式廉价探针（24-preregistration-protocol.md）
// - 每个探针的信号/前向收益公式与 hypothesis JSON 中 marketModel 编号一一对应（F-A..F-H 精神）
// - 预注册哈希校验：probe 字段与注册快照不一致时拒绝运行
// - 只用 GA-1..GA-7 本地数据；无网络、无未来函数；随机性全部 seeded
// - 结论只产生 promote/discard/screen_pending/insufficient_sample，不改变 strategy-library-v2
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  loadDaily,
  loadDerived,
  loadMacro,
  loadRollJumps,
  loadCalendar,
} = require('../harness-lib/data.cjs');
const S = require('../harness-lib/stats.cjs');
const { stableHash, round } = require('../harness-lib/util.cjs');

const MECH_DIR = __dirname;
const OUT_DIR = path.join(MECH_DIR, 'probe-results');
const ALPHA_ADJ = 0.0167;
const SEED = 20260828;
const B_BOOT = 10000;

const round6 = (x) => (x == null || !Number.isFinite(x) ? x : Math.round(x * 1e6) / 1e6);

function readHypothesis(id) {
  const file = fs.readdirSync(MECH_DIR).find((f) => f.startsWith(id) && f.endsWith('.json'));
  if (!file) throw new Error(`hypothesis ${id} not found in ${MECH_DIR}`);
  return JSON.parse(fs.readFileSync(path.join(MECH_DIR, file), 'utf8'));
}

function verifyPreregistration(h) {
  const { preregistrationHash, ...rest } = h.probe;
  const hash = stableHash(rest);
  if (preregistrationHash !== hash) {
    throw new Error(
      `H-MECH preregistration hash mismatch for ${h.id}: stored ${preregistrationHash}, computed ${hash}`
    );
  }
  return hash;
}

// ---------- shared stats ----------
function hitRatePower(n, p0, p1, alpha) {
  // normal approximation, one-sided (greater), continuity not applied
  if (!n || n <= 0) return null;
  const zAlpha = zQuantile(alpha); // one-sided upper-tail z
  const se0 = Math.sqrt((p0 * (1 - p0)) / n);
  const se1 = Math.sqrt((p1 * (1 - p1)) / n);
  const c = p0 + zAlpha * se0;
  return 1 - S.normalCdf((c - p1) / se1);
}

function normalQuantile(p) {
  // bisection inverse of S.normalCdf (deterministic, sufficient for power reporting)
  if (!(p > 0 && p < 1)) return p <= 0 ? -Infinity : Infinity;
  let lo = -12;
  let hi = 12;
  for (let k = 0; k < 80; k++) {
    const mid = (lo + hi) / 2;
    if (S.normalCdf(mid) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

function zQuantile(p) {
  // one-sided z for upper tail probability p
  return -normalQuantile(p);
}

function meanPowerForMDE(n, sigma, delta, alpha, twoSided = true) {
  // normal approximation power of one-sample t vs 0 at alpha (two-sided default)
  if (!n || n < 2 || !sigma || sigma <= 0) return null;
  const z = zQuantile(twoSided ? alpha / 2 : alpha);
  const se = sigma / Math.sqrt(n);
  return 1 - S.normalCdf(z - delta / se);
}

function bootstrapCI(xs) {
  return S.bootstrapMeanCI(xs, { level: 0.95, B: B_BOOT, seed: SEED });
}

function decide(n, ci, meanNet) {
  if (n < 100) return 'insufficient_sample';
  if (meanNet > 0 && ci.lo > 0) return 'promote';
  if (ci.hi < 0) return 'discard';
  return 'screen_pending';
}

function finalizeBase(h, events, extra) {
  const nets = events.map((e) => e.net);
  const meanNet = S.mean(nets);
  const ci = bootstrapCI(nets);
  const n = nets.length;
  const hit = nets.filter((v) => v > 0).length;
  const binom = S.binomialTest(hit, n, 0.5, 'greater');
  const power3pp = hitRatePower(n, 0.5, 0.53, ALPHA_ADJ);
  const sigma = S.std(nets, 1);
  const mdeParsed = parseFloat(String(h.probe.powerSpec.meanMDE).match(/δ\s*=\s*([\d.]+)%/)?.[1] || '0.10');
  const meanPower = meanPowerForMDE(n, sigma, mdeParsed, ALPHA_ADJ, true);
  const result = {
    schema: 'futures-strategy-mechanism-probe-result/1',
    id: h.id,
    name: h.name,
    family: h.family,
    preregistrationHash: h.probe.preregistrationHash,
    runAt: h.probe.registeredAt,
    runCommand: `node strategies/research/v2/falsification/mechanism/mechanism-bound-probes.cjs --hypothesis ${h.id}`,
    seed: SEED,
    alphaAdj: ALPHA_ADJ,
    decision: decide(n, ci, meanNet),
    primary: {
      meanNetPct: round6(meanNet),
      ci: { lo: round6(ci.lo), hi: round6(ci.hi), level: 0.95, B: B_BOOT, seed: SEED, method: ci.method },
      n,
      sigmaPct: round6(sigma),
    },
    secondary: {
      hitRate: {
        k: hit,
        n,
        rate: n ? round6(hit / n) : null,
        pOneSided: binom.p,
        alphaAdj: ALPHA_ADJ,
        powerFor3pp: round6(power3pp),
        validityGate: power3pp != null && power3pp >= 0.8 ? 'valid' : 'low_power_no_conclusion',
      },
      ...extra,
    },
    powerReport: {
      meanMdePct: mdeParsed,
      meanPowerAtMde: round6(meanPower),
      meanPowerRule: '报告用途；探针非策略级主检验（24 协议 §2.4 适用于策略级）',
      hitRatePowerFor3pp: round6(power3pp),
    },
    events: events.map((e) => ({
      date: e.date,
      symbol: e.symbol,
      direction: e.direction,
      z: round6(e.z),
      gapPct: round6(e.gapPct),
      netPct: round6(e.net),
    })),
  };
  return result;
}

// ---------- shared PIT helpers ----------
function macroSeries(indicator) {
  const m = loadMacro(indicator);
  const series = m.series.map((s) => ({ date: s.date, value: Number(s.value) }));
  const dates = series.map((s) => s.date);
  return { series, dates };
}

function pitAt(macro, date) {
  // last value with series.date <= date (as-of discipline)
  const dates = macro.dates;
  let lo = 0;
  let hi = dates.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid] <= date) lo = mid + 1;
    else hi = mid;
  }
  const idx = lo - 1;
  return idx < 0 ? null : macro.series[idx].value;
}

// ---------- H-MECH-01: macro dual-anchor ----------
function runH01() {
  const h = readHypothesis('H-MECH-01');
  verifyPreregistration(h);
  const au = loadDaily('AU0');
  const ag = loadDaily('AG0');
  const agIdx = new Map(ag.dates.map((d, i) => [d, i]));
  const us = macroSeries('US10Y');
  const dx = macroSeries('DXY');
  const jumps = loadRollJumps().bySymbol;

  const events = [];
  let cooldown = 0;
  let single = [];
  let scd = 0;
  for (let t = 5; t + 10 < au.dates.length; t++) {
    cooldown = Math.max(0, cooldown - 1);
    scd = Math.max(0, scd - 1);
    const dT = au.dates[t];
    const dT5 = au.dates[t - 5];
    const u0 = pitAt(us, dT5);
    const u1 = pitAt(us, dT);
    const x0 = pitAt(dx, dT5);
    const x1 = pitAt(dx, dT);
    if (u0 == null || u1 == null || x0 == null || x1 == null || x0 === 0) continue;
    const dr5 = u1 - u0;
    const dd5 = ((x1 - x0) / x0) * 100;
    const tight = dr5 >= 0.15 && dd5 >= 0.3;
    const loose = dr5 <= -0.15 && dd5 <= -0.3;
    const sig = tight ? -1 : loose ? 1 : 0;

    // single-anchor control (US10Y only, same thresholds) — evaluated before the dual gate
    const sigSingle = dr5 >= 0.15 ? -1 : dr5 <= -0.15 ? 1 : 0;
    if (sigSingle !== 0) {
      if (scd <= 0) {
        scd = 10;
        const fwdSingle = forwardBasket({ au, agIdx, ag, t, jumps });
        if (fwdSingle != null) single.push({ net: sigSingle * fwdSingle * 100 - 0.07, date: dT });
      }
    }

    if (sig === 0) continue;
    if (cooldown > 0) continue;
    const fwd = forwardBasket({ au, agIdx, ag, t, jumps });
    if (fwd == null) continue;
    cooldown = 10;
    events.push({
      date: dT,
      symbol: 'AU0+AG0',
      direction: sig,
      z: dr5,
      gapPct: dd5,
      net: sig * fwd * 100 - 0.07,
    });
  }

  const singleNets = single.map((e) => e.net);
  const welch = S.welchTTest(events.map((e) => e.net), singleNets);
  const looseNets = events.filter((e) => e.direction > 0).map((e) => e.net);
  const tightNets = events.filter((e) => e.direction < 0).map((e) => e.net);
  const res = finalizeBase(h, events, {
    singleAnchorComparison: {
      dualN: events.length,
      singleN: single.length,
      dualMean: round6(S.mean(events.map((e) => e.net))),
      singleMean: round6(S.mean(singleNets)),
      welchT: round6(welch.t),
      welchP: round6(welch.p),
      alphaAdj: ALPHA_ADJ,
      use: 'exploratory-only',
    },
    looseVsTight: {
      loose: { n: looseNets.length, meanNetPct: round6(S.mean(looseNets)) },
      tight: { n: tightNets.length, meanNetPct: round6(S.mean(tightNets)) },
    },
  });
  return res;
}

function forwardBasket({ au, agIdx, ag, t, jumps }) {
  // equal-weight of active symbols with valid T+1 open and T+10 close
  const parts = [];
  const auJumpT = jumps['AU0']?.has(au.dates[t]) || jumps['AU0']?.has(au.dates[t + 1]);
  if (!auJumpT && au.open[t + 1] != null && au.close[t + 10] != null) {
    parts.push(au.close[t + 10] / au.open[t + 1] - 1);
  }
  const agT = agIdx.get(au.dates[t]);
  if (agT != null) {
    const jump = jumps['AG0']?.has(ag.dates[agT]) || jumps['AG0']?.has(ag.dates[agT + 1]);
    if (!jump && ag.open[agT + 1] != null && ag.close[agT + 10] != null) {
      parts.push(ag.close[agT + 10] / ag.open[agT + 1] - 1);
    }
  }
  if (parts.length === 0) return null;
  return parts.reduce((s, v) => s + v, 0) / parts.length;
}

// ---------- H-MECH-02: fundamental J/I ratio ----------
function runH02() {
  const h = readHypothesis('H-MECH-02');
  verifyPreregistration(h);
  const j = loadDaily('J0');
  const i = loadDaily('I0');
  const iIdx = new Map(i.dates.map((d, k) => [d, k]));
  const jumps = loadRollJumps().bySymbol;
  const calendar = loadCalendar();

  const events = [];
  let cooldown = 0;
  const allDay = [];
  const zCache = new Map(); // idx -> z (rolling anchor t-250..t-1)
  function zAt(t) {
    if (zCache.has(t)) return zCache.get(t);
    const ii = iIdx.get(j.dates[t]);
    if (ii == null || ii < 250) return null;
    let mu = 0;
    let m2 = 0;
    let cnt = 0;
    const rows = [];
    for (let k = t - 250; k < t; k++) {
      const ik = iIdx.get(j.dates[k]);
      if (ik == null) { zCache.set(t, null); return null; }
      rows.push(Math.log(j.close[k] / i.close[ik]));
    }
    for (const r of rows) { cnt += 1; const d = r - mu; mu += d / cnt; m2 += d * (r - mu); }
    if (cnt < 250) return null;
    const sd = Math.sqrt(m2 / (cnt - 1));
    const ii2 = iIdx.get(j.dates[t]);
    const z = sd === 0 ? null : (Math.log(j.close[t] / i.close[ii2]) - mu) / sd;
    zCache.set(t, z);
    return z;
  }

  for (let t = 250; t + 10 < j.dates.length; t++) {
    cooldown = Math.max(0, cooldown - 1);
    const ii = iIdx.get(j.dates[t]);
    if (ii == null || ii < 250) continue;
    const z = zAt(t);
    if (z == null) continue;
    // baseline all-day spread return (exploratory control)
    if (j.open[t + 1] != null && j.close[t + 10] != null && i.open[ii + 1] != null && i.close[ii + 10] != null) {
      allDay.push((Math.log(j.close[t + 10] / j.open[t + 1]) - Math.log(i.close[ii + 10] / i.open[ii + 1])) * 100 - 0.14);
    }
    const sig = z <= -1.5 ? 1 : z >= 1.5 ? -1 : 0;
    if (sig === 0) continue;
    // F5 acceleration guard
    const z1 = zAt(t - 1);
    const z2 = zAt(t - 2);
    if (z1 != null && z2 != null && Math.abs(z) > Math.abs(z1) && Math.abs(z1) > Math.abs(z2)) continue;
    if (cooldown > 0) continue;
    const dT = j.dates[t];
    if (jumps['J0']?.has(dT) || jumps['J0']?.has(j.dates[t + 1]) ||
        jumps['I0']?.has(i.dates[ii]) || jumps['I0']?.has(i.dates[ii + 1])) continue;
    const spread = (Math.log(j.close[t + 10] / j.open[t + 1]) - Math.log(i.close[ii + 10] / i.open[ii + 1])) * 100;
    cooldown = 10;
    events.push({
      date: dT,
      symbol: 'J0/I0',
      direction: sig,
      z,
      gapPct: null,
      net: sig * spread - 0.14,
      policyWindow: calendar.events.some((ev) => ev.type === 'policy_window' && ev.sector === 'black' && ev.date <= dT && ev.end >= dT),
    });
  }

  const inW = events.filter((e) => e.policyWindow);
  const outW = events.filter((e) => !e.policyWindow);
  const res = finalizeBase(h, events, {
    policyWindowSplit: {
      inside: { n: inW.length, meanNetPct: round6(S.mean(inW.map((e) => e.net))) },
      outside: { n: outW.length, meanNetPct: round6(S.mean(outW.map((e) => e.net))) },
      note: '探索性分段；promote 后须政策窗口内保真复跑',
    },
    baselineSpreadReturn: {
      n: allDay.length,
      meanNetPct: round6(S.mean(allDay)),
      note: '全样本 10 日两腿对数收益 − 0.14（无信号对照，仅报告）',
    },
  });
  return res;
}

// ---------- H-MECH-03: trader overnight gap reversal ----------
function runH03() {
  const h = readHypothesis('H-MECH-03');
  verifyPreregistration(h);
  const universe = h.probe.universe;
  const jumps = loadRollJumps().bySymbol;
  const events = [];
  const followNets = [];
  const perSymbol = {};
  for (const sym of universe) {
    let daily;
    let derived;
    try {
      daily = loadDaily(sym);
      derived = loadDerived(sym, ['atr5']);
    } catch (err) {
      // missing derived file: pre-registered data contract failure for that symbol
      perSymbol[sym] = { n: 0, meanNetPct: null, skipped: err.message };
      continue;
    }
    const jSet = jumps[sym] || new Set();
    let cooldown = 0;
    const nets = [];
    for (let t = 60; t + 5 < daily.dates.length; t++) {
      cooldown = Math.max(0, cooldown - 1);
      const pc = daily.close[t - 1];
      const atr5 = derived.atr5[t];
      if (pc == null || pc === 0 || atr5 == null) continue;
      const gap = daily.open[t] / pc - 1;
      const thr = Math.max(0.02, (2 * atr5) / pc);
      if (Math.abs(gap) < thr) continue;
      if (jSet.has(daily.dates[t]) || jSet.has(daily.dates[t + 1])) continue;
      if (daily.open[t + 1] == null || daily.close[t + 5] == null) continue;
      if (cooldown > 0) continue;
      cooldown = 10;
      const sig = -Math.sign(gap);
      const fwd = daily.close[t + 5] / daily.open[t + 1] - 1;
      const net = sig * fwd * 100 - 0.07;
      nets.push(net);
      events.push({ date: daily.dates[t], symbol: sym, direction: sig, z: null, gapPct: gap * 100, net });
      followNets.push(Math.sign(gap) * fwd * 100 - 0.07);
    }
    perSymbol[sym] = { n: nets.length, meanNetPct: round6(S.mean(nets)) };
  }
  const up = events.filter((e) => e.direction < 0);
  const down = events.filter((e) => e.direction > 0);
  const res = finalizeBase(h, events, {
    upVsDownGap: {
      upGap: { n: up.length, meanNetPct: round6(S.mean(up.map((e) => e.net))) },
      downGap: { n: down.length, meanNetPct: round6(S.mean(down.map((e) => e.net))) },
    },
    followDirectionControl: {
      n: followNets.length,
      meanNetPct: round6(S.mean(followNets)),
      note: '同事件集追涨杀跌方向净收益（仅报告）',
    },
    perSymbol,
  });
  return res;
}

// ---------- main ----------
function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const arg = process.argv.indexOf('--hypothesis');
  const only = arg >= 0 ? process.argv[arg + 1] : null;
  const runners = {
    'H-MECH-01': runH01,
    'H-MECH-02': runH02,
    'H-MECH-03': runH03,
  };
  const ids = only ? [only] : Object.keys(runners);
  const results = {};
  for (const id of ids) {
    if (!runners[id]) throw new Error(`unknown hypothesis ${id}`);
    const res = runners[id]();
    results[id] = res;
    fs.writeFileSync(path.join(OUT_DIR, `${id}-probe.json`), JSON.stringify(res, null, 2) + '\n');
    console.log(`[${id}] decision=${res.decision} n=${res.primary.n} meanNet=${res.primary.meanNetPct} ci=[${res.primary.ci.lo}, ${res.primary.ci.hi}]`);
  }
  const summary = {
    schema: 'futures-strategy-mechanism-probe-summary/1',
    generatedAt: '2026-08-28',
    protocolRef: 'strategies/research/v2/falsification/24-preregistration-protocol.md',
    results: Object.fromEntries(Object.entries(results).map(([id, r]) => [id, {
      name: r.name,
      family: r.family,
      decision: r.decision,
      n: r.primary.n,
      meanNetPct: r.primary.meanNetPct,
      ciLo: r.primary.ci.lo,
      ciHi: r.primary.ci.hi,
    }])),
  };
  fs.writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  return summary;
}

if (require.main === module) {
  main();
}

module.exports = { main, readHypothesis, verifyPreregistration };
