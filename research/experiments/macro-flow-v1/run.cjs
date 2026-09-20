// research/experiments/macro-flow-v1/run.cjs — MFLOW-01 历史验证
//
// 验证 V2 逻辑矛：板块 OI 流（5 日增仓方向）+ 板块相对强度（5 日）同向确认后，
// T+1 开盘进入板块代表品种；信号反转或满 10 个交易日退出。
//
// 用法: node research/experiments/macro-flow-v1/run.cjs
// 输出: research/experiments/macro-flow-v1/results/{results.json,report.md}
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const DATA_DIR = path.join(ROOT, 'data', 'daily');
const RES_DIR = path.join(__dirname, 'results');

const ELIGIBLE_SECTORS = ['black', 'nonferrous', 'energy_chemical', 'agriculture'];
const COST_PCT = 0.07;           // 往返成本（lib/costs.cjs 口径）
const MAX_HOLD_BARS = 10;        // 持仓满 10 个代表品种交易日 → 第 11 个 bar 开盘退出
const MAX_ENTRY_GAP_DAYS = 7;    // 信号日与代表品种下一 bar 间隔超 7 自然日则跳过
const MIN_OI_MEMBERS = 3;        // 板块 OI 求和要求的最小成员数
const MIN_MARKET_SECTORS = 2;    // 市场基准至少需要的板块数
const B = 10000;
const SEED = 20260918;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function mean(xs) {
  if (!xs || xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function round(v, d = 4) {
  return v === null || v === undefined || !Number.isFinite(v) ? null : Number(v.toFixed(d));
}

function lastIdxLE(dates, target) {
  // dates 升序；返回最后一个 <= target 的下标，没有则 -1
  let lo = 0, hi = dates.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid] <= target) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return ans;
}

function dayDiff(a, b) {
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000);
}

// ── 数据加载 ────────────────────────────────────────────────
function loadSeries(symbol) {
  const file = path.join(DATA_DIR, `${symbol}.json`);
  const d = readJson(file);
  const o = d && d.contract && d.contract.ohlcv;
  if (!o) throw new Error(`daily file missing for ${symbol}`);
  return {
    symbol,
    dates: o.dates,
    open: o.open,
    close: o.close,
    volume: o.volume,
    oi: o.openInterest,
  };
}

// ── 板块指数（与 collector/sector-aggregator.cjs 同口径）────
function buildSectorIndex(members, sortedDates) {
  const closeMap = new Map();
  for (const m of members) {
    const map = new Map();
    for (let i = 0; i < m.dates.length; i++) map.set(m.dates[i], m.close[i]);
    closeMap.set(m.symbol, map);
  }
  const rows = [];
  let lastLevel = 1000;
  for (let i = 0; i < sortedDates.length; i++) {
    const date = sortedDates[i];
    const prevDate = i > 0 ? sortedDates[i - 1] : null;
    const rets = [];
    for (const m of members) {
      const map = closeMap.get(m.symbol);
      const cur = map.get(date);
      const prev = prevDate === null ? null : map.get(prevDate);
      if (Number.isFinite(cur) && Number.isFinite(prev) && prev > 0 && cur > 0) {
        rets.push((cur / prev - 1) * 100);
      }
    }
    if (rets.length === 0) continue;
    const avg = mean(rets);
    const level = lastLevel * (1 + avg / 100);
    rows.push({ date, level });
    lastLevel = level;
  }
  const levelByDate = new Map(rows.map((r) => [r.date, r.level]));
  const ret5ByDate = new Map();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    r.ret5 = i >= 5 ? (r.level / rows[i - 5].level - 1) * 100 : null;
    ret5ByDate.set(r.date, r.ret5);
  }
  return { rows, levelByDate, ret5ByDate };
}

// ── 板块 OI 求和（信号日与 5 行前同成员对）─────────────────
function buildSectorOi(members, sortedDates) {
  const oiMap = new Map();
  for (const m of members) {
    const map = new Map();
    for (let i = 0; i < m.dates.length; i++) map.set(m.dates[i], m.oi[i]);
    oiMap.set(m.symbol, map);
  }
  const byDate = new Map();
  for (let i = 0; i < sortedDates.length; i++) {
    const date = sortedDates[i];
    const prevDate = i >= 5 ? sortedDates[i - 5] : null;
    let sumNow = 0, sumPrev = 0, cnt = 0;
    for (const m of members) {
      const map = oiMap.get(m.symbol);
      const cur = map.get(date);
      const prev = prevDate === null ? null : map.get(prevDate);
      if (Number.isFinite(cur) && cur > 0 && Number.isFinite(prev) && prev > 0) {
        sumNow += cur; sumPrev += prev; cnt++;
      }
    }
    if (cnt >= MIN_OI_MEMBERS) byDate.set(date, { sumNow, sumPrev, cnt });
  }
  return byDate;
}

function nearestLevelLE(levelByDate, sortedLevelDates, target) {
  const idx = lastIdxLE(sortedLevelDates, target);
  return idx >= 0 ? levelByDate.get(sortedLevelDates[idx]) : null;
}

// ── bootstrap percentile CI ────────────────────────────────
function bootstrapCI(values, b = B, seed = SEED) {
  const n = values.length;
  if (n === 0) return null;
  let state = seed >>> 0;
  const means = [];
  for (let k = 0; k < b; k++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      sum += values[state % n];
    }
    means.push(sum / n);
  }
  means.sort((a, b) => a - b);
  return {
    lo: means[Math.floor(b * 0.025)],
    hi: means[Math.floor(b * 0.975)],
    level: 0.95,
    B: b,
    seed,
    method: 'bootstrap-percentile',
  };
}

function summarize(trades) {
  const nets = trades.map((t) => t.netPct);
  const n = nets.length;
  if (n === 0) return { n: 0, meanNetPct: null, ci: null, winRate: null, sigmaPct: null, sumNetPct: null };
  const m = mean(nets);
  const winRate = nets.filter((x) => x > 0).length / n;
  const sigma = Math.sqrt(nets.reduce((s, x) => s + (x - m) ** 2, 0) / n);
  return {
    n,
    meanNetPct: round(m),
    medianNetPct: round(nets.slice().sort((a, b) => a - b)[Math.floor(n / 2)]),
    ci: bootstrapCI(nets),
    winRate: round(winRate),
    sigmaPct: round(sigma),
    sumNetPct: round(nets.reduce((a, b) => a + b, 0)),
  };
}

function sectorSignals(sectors, sortedDates) {
  // sectors: [{id, series, index, oi}]
  const marketByDate = new Map();
  for (let i = 0; i < sortedDates.length; i++) {
    const d = sortedDates[i];
    const vals = [];
    for (const s of sectors) {
      const r = s.index.ret5ByDate.get(d);
      if (Number.isFinite(r)) vals.push(r);
    }
    marketByDate.set(d, vals.length >= MIN_MARKET_SECTORS ? mean(vals) : null);
  }
  const signalBySector = new Map();
  for (const s of sectors) {
    const map = new Map();
    for (let i = 0; i < sortedDates.length; i++) {
      const d = sortedDates[i];
      const px5 = s.index.ret5ByDate.get(d);
      const market5 = marketByDate.get(d);
      const oi = s.oi.get(d);
      if (!Number.isFinite(px5) || !Number.isFinite(market5) || !oi) { map.set(d, 0); continue; }
      const oiChg = oi.sumNow - oi.sumPrev;
      const flowDir = oiChg > 0 ? Math.sign(px5) : 0;
      const rs = px5 - market5;
      const sig = flowDir !== 0 && flowDir === Math.sign(rs) ? flowDir : 0;
      map.set(d, sig);
    }
    signalBySector.set(s.id, map);
  }
  return signalBySector;
}

function pickRepresentative(members, d) {
  let best = null;
  for (const m of members) {
    const idx = lastIdxLE(m.dates, d);
    if (idx < 0 || m.dates[idx] !== d) continue;
    const win = m.volume.slice(Math.max(0, idx - 59), idx + 1).filter((v) => Number.isFinite(v) && v > 0);
    if (win.length === 0) continue;
    const avg = mean(win);
    if (best === null || avg > best.avg) best = { symbol: m.symbol, avg };
  }
  return best ? best.symbol : null;
}

function main() {
  const t0 = Date.now();
  const cfg = readJson(path.join(ROOT, 'config', 'symbols.json'));
  const active = (cfg.symbols || []).filter((s) => s.active && ELIGIBLE_SECTORS.includes(s.sector));
  const seriesBySymbol = new Map();
  const membersBySector = new Map();
  for (const s of ELIGIBLE_SECTORS) membersBySector.set(s, []);
  for (const s of active) {
    const series = loadSeries(s.symbol);
    series.sector = s.sector;
    seriesBySymbol.set(s.symbol, series);
    membersBySector.get(s.sector).push(series);
  }

  const allDatesSet = new Set();
  for (const s of seriesBySymbol.values()) for (const d of s.dates) allDatesSet.add(d);
  const sortedDates = [...allDatesSet].sort();

  const sectors = ELIGIBLE_SECTORS.map((id) => {
    const members = membersBySector.get(id);
    return {
      id,
      members,
      index: buildSectorIndex(members, sortedDates),
      oi: buildSectorOi(members, sortedDates),
    };
  });
  const signalBySector = sectorSignals(sectors, sortedDates);

  const positions = new Map(); // sector -> {dir, symbol, entryIdx, entryPrice, entryDate, signalDate}
  const trades = [];
  const skipped = { no_rep: 0, no_next_bar: 0, gap_too_wide: 0, bad_price: 0 };
  let signalDays = 0;

  for (let i = 0; i < sortedDates.length; i++) {
    const d = sortedDates[i];
    const exitedSectors = new Set();

    for (const s of sectors) {
      const pos = positions.get(s.id);
      if (!pos) continue;
      const sym = seriesBySymbol.get(pos.symbol);
      const nowIdx = lastIdxLE(sym.dates, d);
      if (nowIdx < pos.entryIdx) continue; // 尚未到入场日
      const sig = signalBySector.get(s.id).get(d) || 0;
      const heldBars = nowIdx - pos.entryIdx + 1;
      let exitReason = null;
      if (sig !== pos.dir) exitReason = 'flow_reverse';
      else if (heldBars >= MAX_HOLD_BARS) exitReason = 'max_hold';
      if (!exitReason) continue;

      let exitDate, exitPrice, forced = false;
      const nextIdx = nowIdx + 1;
      if (nextIdx < sym.dates.length && Number.isFinite(sym.open[nextIdx]) && sym.open[nextIdx] > 0) {
        exitDate = sym.dates[nextIdx];
        exitPrice = sym.open[nextIdx];
      } else if (nowIdx < sym.dates.length && Number.isFinite(sym.close[nowIdx]) && sym.close[nowIdx] > 0) {
        exitDate = sym.dates[nowIdx];
        exitPrice = sym.close[nowIdx];
        forced = true;
        exitReason = forced ? 'forced_end' : exitReason;
      } else {
        skipped.bad_price++;
        positions.delete(s.id);
        continue;
      }

      const grossPct = pos.dir * (exitPrice / pos.entryPrice - 1) * 100;
      const netPct = grossPct - COST_PCT;
      const idxByDate = s.index.levelByDate;
      const idxDates = [...idxByDate.keys()].sort();
      const entryLevel = nearestLevelLE(idxByDate, idxDates, pos.entryDate);
      const exitLevel = nearestLevelLE(idxByDate, idxDates, exitDate);
      const sectorRetPct = entryLevel && exitLevel && entryLevel > 0
        ? pos.dir * (exitLevel / entryLevel - 1) * 100 : null;

      trades.push({
        sector: s.id,
        symbol: pos.symbol,
        dir: pos.dir,
        signalDate: pos.signalDate,
        entryDate: pos.entryDate,
        exitDate,
        entryPrice: round(pos.entryPrice),
        exitPrice: round(exitPrice),
        heldBars,
        exitReason,
        grossPct: round(grossPct),
        netPct: round(netPct),
        sectorRetPct: round(sectorRetPct),
      });
      positions.delete(s.id);
      exitedSectors.add(s.id);
    }

    for (const s of sectors) {
      if (exitedSectors.has(s.id) || positions.has(s.id)) continue;
      const sig = signalBySector.get(s.id).get(d) || 0;
      if (sig === 0) continue;
      signalDays++;
      const rep = pickRepresentative(s.members, d);
      if (!rep) { skipped.no_rep++; continue; }
      const sym = seriesBySymbol.get(rep);
      const nowIdx = lastIdxLE(sym.dates, d);
      if (nowIdx < 0 || sym.dates[nowIdx] !== d) { skipped.no_rep++; continue; }
      const nextIdx = nowIdx + 1;
      if (nextIdx >= sym.dates.length) { skipped.no_next_bar++; continue; }
      const gap = dayDiff(sym.dates[nextIdx], d);
      if (gap > MAX_ENTRY_GAP_DAYS) { skipped.gap_too_wide++; continue; }
      const entryPrice = sym.open[nextIdx];
      if (!Number.isFinite(entryPrice) || entryPrice <= 0) { skipped.bad_price++; continue; }
      positions.set(s.id, {
        dir: sig,
        symbol: rep,
        entryIdx: nextIdx,
        entryPrice,
        entryDate: sym.dates[nextIdx],
        signalDate: d,
      });
    }
  }

  // 数据末尾仍持仓的，按最后一根 close 强制了结（记录）
  for (const [sector, pos] of positions) {
    const sym = seriesBySymbol.get(pos.symbol);
    const last = sym.dates.length - 1;
    const exitPrice = sym.close[last];
    if (!Number.isFinite(exitPrice) || exitPrice <= 0) continue;
    const grossPct = pos.dir * (exitPrice / pos.entryPrice - 1) * 100;
    const netPct = grossPct - COST_PCT;
    const s = sectors.find((x) => x.id === sector);
    const idxByDate = s.index.levelByDate;
    const idxDates = [...idxByDate.keys()].sort();
    const entryLevel = nearestLevelLE(idxByDate, idxDates, pos.entryDate);
    const exitLevel = nearestLevelLE(idxByDate, idxDates, sym.dates[last]);
    trades.push({
      sector, symbol: pos.symbol, dir: pos.dir, signalDate: pos.signalDate,
      entryDate: pos.entryDate, exitDate: sym.dates[last], entryPrice: round(pos.entryPrice),
      exitPrice: round(exitPrice), heldBars: last - pos.entryIdx + 1, exitReason: 'forced_end',
      grossPct: round(grossPct), netPct: round(netPct),
      sectorRetPct: entryLevel && exitLevel && entryLevel > 0 ? round(pos.dir * (exitLevel / entryLevel - 1) * 100) : null,
    });
  }

  const overall = summarize(trades);
  const bySector = {};
  for (const s of sectors) {
    bySector[s.id] = summarize(trades.filter((t) => t.sector === s.id));
  }
  const byDir = {};
  for (const dir of [1, -1]) {
    byDir[dir === 1 ? 'long' : 'short'] = summarize(trades.filter((t) => t.dir === dir));
  }
  const byYear = {};
  for (const y of [...new Set(trades.map((t) => t.entryDate.slice(0, 4)))].sort()) {
    byYear[y] = summarize(trades.filter((t) => t.entryDate.slice(0, 4) === y));
  }

  const sectorNetMean = mean(trades.map((t) => t.sectorRetPct).filter((v) => Number.isFinite(v)));
  const decision = overall.ci && overall.meanNetPct > 0 && overall.ci.lo > 0 ? 'promote'
    : overall.ci && overall.meanNetPct < 0 && overall.ci.hi < 0 ? 'discard'
      : 'screen_pending';

  const out = {
    schema: 'futures-radar-experiment-result/1',
    id: 'MFLOW-01',
    generatedAt: new Date().toISOString(),
    runCommand: 'node research/experiments/macro-flow-v1/run.cjs',
    seed: SEED,
    elapsedMs: Date.now() - t0,
    settings: {
      eligibleSectors: ELIGIBLE_SECTORS,
      costPct: COST_PCT,
      maxHoldBars: MAX_HOLD_BARS,
      maxEntryGapDays: MAX_ENTRY_GAP_DAYS,
      minOiMembers: MIN_OI_MEMBERS,
      minMarketSectors: MIN_MARKET_SECTORS,
      bootstrap: { B, seed: SEED },
    },
    signalDays,
    trades: trades.length,
    skipped,
    decision,
    primary: overall,
    secondary: { sectorNetMeanPct: round(sectorNetMean), sectorNetN: trades.filter((t) => Number.isFinite(t.sectorRetPct)).length },
    bySector,
    byDirection: byDir,
    byYear,
    dataRange: { first: sortedDates[0], last: sortedDates[sortedDates.length - 1], tradingDates: sortedDates.length },
  };

  const signalExport = {};
  for (const s of sectors) signalExport[s.id] = {};
  for (let i = 0; i < sortedDates.length; i++) {
    const d = sortedDates[i];
    const marketVals = [];
    for (const s of sectors) {
      const r = s.index.ret5ByDate.get(d);
      if (Number.isFinite(r)) marketVals.push(r);
    }
    const market5 = marketVals.length >= MIN_MARKET_SECTORS ? mean(marketVals) : null;
    for (const s of sectors) {
      const sig = signalBySector.get(s.id).get(d) || 0;
      const oi = s.oi.get(d);
      const px5 = s.index.ret5ByDate.get(d);
      if (sig !== 0 || oi) {
        signalExport[s.id][d] = {
          sig,
          px5: round(px5),
          market5: round(market5),
          rs: Number.isFinite(px5) && Number.isFinite(market5) ? round(px5 - market5) : null,
          oiChg: oi ? round(oi.sumNow - oi.sumPrev) : null,
          oiChgPct: oi && oi.sumPrev > 0 ? round((oi.sumNow / oi.sumPrev - 1) * 100) : null,
        };
      }
    }
  }

  fs.mkdirSync(RES_DIR, { recursive: true });
  fs.writeFileSync(path.join(RES_DIR, 'results.json'), JSON.stringify(out, null, 2) + '\n');
  fs.writeFileSync(path.join(RES_DIR, 'trades.json'), JSON.stringify(trades, null, 2) + '\n');
  fs.writeFileSync(path.join(RES_DIR, 'signals.json'), JSON.stringify(signalExport, null, 2) + '\n');
  writeReport(out);
  console.log(JSON.stringify({
    decision: out.decision,
    trades: out.trades,
    meanNetPct: out.primary.meanNetPct,
    ci: out.primary.ci ? [out.primary.ci.lo, out.primary.ci.hi] : null,
    winRate: out.primary.winRate,
    sectorNetMeanPct: out.secondary.sectorNetMeanPct,
    skipped,
  }, null, 2));
  return out;
}

function writeReport(out) {
  const L = [];
  const p = out.primary;
  L.push('# MFLOW-01 板块资金流双确认信号 — 历史验证报告');
  L.push('');
  L.push(`- 生成时间：${out.generatedAt}`);
  L.push(`- 数据范围：${out.dataRange.first} ~ ${out.dataRange.last}（${out.dataRange.tradingDates} 个交易日）`);
  L.push(`- 口径：${out.settings.eligibleSectors.join('/')} 四个板块；OI 流+相对强度双确认；T+1 开盘进代表品种；反转或满 ${out.settings.maxHoldBars} 个交易日退出；往返成本 ${out.settings.costPct}%`);
  L.push('');
  L.push(`## 判决：${out.decision}`);
  L.push('');
  L.push('| 指标 | 值 |');
  L.push('|------|----|');
  L.push(`| 交易笔数 | ${out.trades}（信号日 ${out.signalDays}，跳过 ${JSON.stringify(out.skipped)}） |`);
  L.push(`| 平均单笔净收益 | ${p.meanNetPct}% |`);
  L.push(`| 中位数净收益 | ${p.medianNetPct}% |`);
  L.push(`| 胜率（net>0） | ${p.winRate === null ? '—' : (p.winRate * 100).toFixed(1) + '%'} |`);
  L.push(`| 单笔收益 σ | ${p.sigmaPct}% |`);
  L.push(`| 95% bootstrap CI | [${p.ci.lo}, ${p.ci.hi}] |`);
  L.push(`| 净收益合计（朴素求和） | ${p.sumNetPct}% |`);
  L.push(`| 板块指数方向化收益均值（信号质量） | ${out.secondary.sectorNetMeanPct}% |`);
  L.push('');
  L.push('## 分板块');
  L.push('');
  L.push('| 板块 | n | 平均净收益% | 胜率% | CI |');
  L.push('|------|---|-----------|-------|----|');
  for (const [sec, s] of Object.entries(out.bySector)) {
    L.push(`| ${sec} | ${s.n} | ${s.meanNetPct ?? '—'} | ${s.winRate === null ? '—' : (s.winRate * 100).toFixed(1)} | ${s.ci ? `[${s.ci.lo}, ${s.ci.hi}]` : '—'} |`);
  }
  L.push('');
  L.push('## 分方向');
  L.push('');
  L.push('| 方向 | n | 平均净收益% | 胜率% |');
  L.push('|------|---|-----------|-------|');
  for (const [dir, s] of Object.entries(out.byDirection)) {
    L.push(`| ${dir} | ${s.n} | ${s.meanNetPct ?? '—'} | ${s.winRate === null ? '—' : (s.winRate * 100).toFixed(1)} |`);
  }
  L.push('');
  L.push('## 分年度');
  L.push('');
  L.push('| 年份 | n | 平均净收益% | 胜率% |');
  L.push('|------|---|-----------|-------|');
  for (const [y, s] of Object.entries(out.byYear)) {
    L.push(`| ${y} | ${s.n} | ${s.meanNetPct ?? '—'} | ${s.winRate === null ? '—' : (s.winRate * 100).toFixed(1)} |`);
  }
  L.push('');
  L.push('## 口径与边界');
  L.push('');
  L.push('- 本试验只验证「矛尖」：资金流双确认信号本身是否携带正期望，不做组合、不加杠杆、不接 LLM 故事层。');
  L.push('- 代表品种=信号日近 60 日平均成交量最大的板块成员（PIT）；进入/退出用该品种 open，无未来函数。');
  L.push('- 板块指数与生产 sector-aggregator 同口径（等权日收益链式）；主连续 OI 含换月跳变，未剔除——这是已知保守偏差。');
  L.push('- 阈值（5 日、60 日、10 日持仓上限）为预注册固定值，不进行参数寻优；变体只能作为后续独立预注册。');
  L.push('');
  fs.writeFileSync(path.join(RES_DIR, 'report.md'), L.join('\n') + '\n');
}

if (require.main === module) main();
module.exports = {
  main,
  summarize,
  bootstrapCI,
  buildSectorIndex,
  buildSectorOi,
  sectorSignals,
  loadSeries,
  pickRepresentative,
  lastIdxLE,
  dayDiff,
};
