// experiment-line/probes/carry-basis-g1.cjs — TH-CARRY-01 G1 命题检验（最便宜实验）
//
// 依据 theory-base 02（期限结构）：基差是库存影子价格，极端后向中枢回归；收益主要来自展期分层。
// G1 只做三件便宜的事（不建策略、不写 adapter）：
//   1. 半衰期估计：每品种 br 序列 AR(1)，报告 half-life 分布（02：半衰期先于持有期）。
//   2. 极端回归命题检验：滚动 180d z，|z|≥1.5 → 方向化持有 20d，T+1 开盘执行，净 7bp。
//   3. carry 分层前哨：月度横截面 br 分三层，多最高层/空最低层（仅报告，不参与 G1 判决）。
//
// 标准 G1 结果协议 → experiment-line/results/g1/<id>-result.json
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const basisLib = require(path.join(ROOT, 'strategies', 'research', 'v2', 'falsification', 'harness-lib', 'basis.cjs'));
const { loadDaily, loadRollJumps } = require(path.join(ROOT, 'strategies', 'research', 'v2', 'falsification', 'harness-lib', 'data.cjs'));
const S = require(path.join(ROOT, 'strategies', 'research', 'v2', 'falsification', 'harness-lib', 'stats.cjs'));

const SYMBOLS = ['RB', 'M', 'RM', 'CU', 'AL', 'ZN', 'NI', 'SN', 'PB', 'AG', 'AU'];
const WINDOW = 180;
const Z_THRESHOLD = 1.5;
const HOLD_DAYS = 20;
const COST_BPS = 7;
const SEED = 20260828;

function round(v, d = 6) {
  if (v === null || v === undefined || !Number.isFinite(v)) return v;
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

// GA-8 store dates are YYYYMMDD; data/daily uses YYYY-MM-DD
function normDate(d) {
  if (!d) return d;
  return d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d;
}

function estimateHalfLife(rows) {
  const xs = [];
  const ys = [];
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1].br;
    const cur = rows[i].br;
    if (prev != null && cur != null) {
      xs.push(prev);
      ys.push(cur);
    }
  }
  if (xs.length < 30) return null;
  const fit = S.ols(xs, ys);
  const phi = fit.beta;
  if (!Number.isFinite(phi) || phi <= 0 || phi >= 1) return { phi: round(phi), halfLifeDays: null, n: xs.length };
  return { phi: round(phi), halfLifeDays: round(Math.log(2) / -Math.log(phi), 1), n: xs.length };
}

function main() {
  const args = process.argv.slice(2);
  const flag = (name, dflt) => {
    const i = args.indexOf(name);
    return i === -1 ? dflt : args[i + 1];
  };
  const id = flag('--id', 'TH-CARRY-01');
  const holdDays = Number(flag('--hold', HOLD_DAYS));
  const longOnly = flag('--long-only', '0') === '1';
  const jumps = loadRollJumps().bySymbol;

  const halfLives = {};
  const events = [];
  const layerRows = [];

  for (const src of SYMBOLS) {
    const lib = `${src}0`;
    const basis = basisLib.loadBasisHistory(lib);
    const rows = basis.rows;
    if (!rows.length) continue;
    const hl = estimateHalfLife(rows);
    if (hl) halfLives[src] = hl;

    let daily;
    try {
      daily = loadDaily(lib);
    } catch (e) {
      continue;
    }
    const idxByDate = new Map(daily.dates.map((d, i) => [d, i]));
    const zs = basisLib.basisZSeries(rows, { window: WINDOW, minObs: WINDOW });

    let cooldown = 0;
    for (let t = 0; t < rows.length; t++) {
      cooldown = Math.max(0, cooldown - 1);
      const r = rows[t];
      const zr = zs[t];
      if (zr.z === null) continue;
      // 主力切换日剔除（02：切换即结构断裂，G1 便宜版只剔除切换日）
      if (t > 0 && rows[t - 1].domContract && r.domContract && rows[t - 1].domContract !== r.domContract) continue;
      const date = normDate(r.date);
      if (jumps[lib]?.has(date)) continue;
      if (cooldown > 0) continue;
      const idx = idxByDate.get(date);
      if (idx === undefined || idx + holdDays >= daily.dates.length) continue;
      let direction = 0;
      if (zr.z <= -Z_THRESHOLD) direction = +1; // 深度贴水 → 多期货收敛
      else if (!longOnly && zr.z >= Z_THRESHOLD) direction = -1; // 深度升水 → 空期货收敛（TH-CARRY-02 不启用）
      if (direction === 0) continue;
      const entry = daily.open[idx + 1];
      const exit = daily.close[idx + holdDays];
      if (!Number.isFinite(entry) || !Number.isFinite(exit) || entry <= 0) continue;
      const net = direction * ((exit - entry) / entry) * 100 - COST_BPS / 100;
      cooldown = holdDays;
      events.push({
        symbol: lib,
        date,
        direction,
        z: round(zr.z, 3),
        netPct: round(net, 4),
        policyWindow: false, // ga7 分段在 v6 G1 阶段只记录窗口标记，不剔除（后续 G2 处理）
      });
    }
  }

  // 3. carry 分层前哨（月度横截面）
  const byMonth = new Map();
  for (const src of SYMBOLS) {
    const basis = basisLib.loadBasisHistory(`${src}0`);
    for (const r of basis.rows) {
      if (r.br == null) continue;
      const date = normDate(r.date);
      const m = date.slice(0, 7);
      if (!byMonth.has(m)) byMonth.set(m, []);
      byMonth.get(m).push({ symbol: `${src}0`, date, br: r.br });
    }
  }
  for (const [m, rows] of [...byMonth.entries()].sort()) {
    const bySymbol = new Map();
    for (const r of rows) bySymbol.set(r.symbol, r);
    if (bySymbol.size < 3) continue;
    const arr = [...bySymbol.values()].sort((a, b) => a.br - b.br);
    const k = Math.max(1, Math.floor(arr.length / 3));
    const low = arr.slice(0, k);
    const high = arr.slice(arr.length - k);
    const fwd = (item, side) => {
      try {
        const daily = loadDaily(item.symbol);
        const idx = daily.dates.indexOf(item.date);
        if (idx < 0 || idx + holdDays >= daily.dates.length) return null;
        const entry = daily.open[idx + 1];
        const exit = daily.close[idx + holdDays];
        if (!Number.isFinite(entry) || !Number.isFinite(exit) || entry <= 0) return null;
        return side * ((exit - entry) / entry) * 100;
      } catch (e) {
        return null;
      }
    };
    const topRets = high.map((x) => fwd(x, +1)).filter((v) => v != null);
    const botRets = low.map((x) => fwd(x, -1)).filter((v) => v != null);
    if (topRets.length && botRets.length) {
      const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
      layerRows.push({
        month: m,
        topN: topRets.length,
        bottomN: botRets.length,
        spreadNetPct: round(mean(topRets) - mean(botRets) - (2 * COST_BPS) / 100, 4),
      });
    }
  }

  const nets = events.map((e) => e.netPct);
  const n = nets.length;
  const meanNet = S.mean(nets);
  const ci = S.bootstrapMeanCI(nets, { level: 0.95, B: 10000, seed: SEED });
  let decision = 'screen_pending';
  if (n < 100) decision = 'insufficient_sample';
  else if (meanNet > 0 && ci.lo > 0) decision = 'promote';
  else if (ci.hi < 0) decision = 'discard';

  const layerNets = layerRows.map((x) => x.spreadNetPct);
  const hlVals = Object.values(halfLives).map((x) => x.halfLifeDays).filter((v) => v != null).sort((a, b) => a - b);
  const result = {
    schema: 'futures-radar-g1-result/1',
    id,
    family: 'carry',
    theoryRef: '02-term-structure.md §一 T1-T4',
    seed: SEED,
    holdDays,
    longOnly,
    decision,
    primary: {
      meanNetPct: round(meanNet, 6),
      ci: { lo: round(ci.lo, 6), hi: round(ci.hi, 6), level: 0.95, B: 10000, seed: SEED, method: ci.method },
      n,
      sigmaPct: round(S.std(nets, 1), 6),
    },
    secondary: {
      halfLife: {
        perSymbol: halfLives,
        medianDays: hlVals.length ? hlVals[Math.floor(hlVals.length / 2)] : null,
        note: 'AR(1) on daily br per symbol; median across 11 symbols',
      },
      carryLayers: {
        nMonths: layerRows.length,
        meanSpreadNetPct: round(S.mean(layerNets), 6),
        ci: layerNets.length >= 5 ? { lo: round(S.bootstrapMeanCI(layerNets, { level: 0.95, B: 10000, seed: SEED }).lo, 6), hi: round(S.bootstrapMeanCI(layerNets, { level: 0.95, B: 10000, seed: SEED }).hi, 6) } : null,
        note: 'monthly cross-section br terciles, long top/short bottom, 20d, both legs 7bp; forward-looking preview only, not part of G1 verdict',
      },
    },
    events: events.map((e) => ({ symbol: e.symbol, date: e.date, direction: e.direction, z: e.z, netPct: e.netPct })),
  };
  const outDir = path.join(__dirname, '..', 'results', 'g1');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `${id}-result.json`), JSON.stringify(result, null, 2) + '\n');
  console.log(`[${id}] n=${n} meanNet=${result.primary.meanNetPct} ci=[${result.primary.ci.lo}, ${result.primary.ci.hi}] decision=${decision}`);
  console.log(`halfLife median=${result.secondary.halfLife.medianDays}d; carry layers ${layerRows.length} months, mean ${result.secondary.carryLayers.meanSpreadNetPct}`);
  return result;
}

if (require.main === module) main();
module.exports = { main, estimateHalfLife };
