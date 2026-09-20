// research/experiments/macro-flow-v1/run-v2.cjs — MFLOW-02 流状态机验证
//
// 与 MFLOW-01 唯一差异：把单日双确认信号升级为 3/5 多数流状态。
// 原始指标口径完全不变（见 preregistration-mflow-02.json）。
//
// 用法: node research/experiments/macro-flow-v1/run-v2.cjs
// 输出: results/results-mflow-02.json + trades-mflow-02.json + report-mflow-02.md
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const DATA_DIR = path.join(ROOT, 'data', 'daily');
const RES_DIR = path.join(__dirname, 'results');

const {
  buildSectorIndex,
  buildSectorOi,
  sectorSignals,
  loadSeries,
  pickRepresentative,
  lastIdxLE,
  dayDiff,
  summarize,
} = require('./run.cjs');

const ELIGIBLE_SECTORS = ['black', 'nonferrous', 'energy_chemical', 'agriculture'];
const COST_PCT = 0.07;
const MAX_HOLD_BARS = 20;         // 满 20 个代表品种交易日 → 第 21 个 bar 开盘退出
const MAX_ENTRY_GAP_DAYS = 7;
const VALIDATION_START = '2020-01-01';
const PRIMARY = { M: 3, N: 5 };
const SENSITIVITY = [[2, 3], [3, 5], [4, 5], [4, 7]];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function round(v, d = 4) {
  return v === null || v === undefined || !Number.isFinite(v) ? null : Number(v.toFixed(d));
}

function buildFlowStates(rawSignalBySector, sortedDates, M, N) {
  const states = new Map();
  for (const [sector, raw] of rawSignalBySector) {
    const map = new Map();
    let cp = 0, cm = 0;
    for (let i = 0; i < sortedDates.length; i++) {
      const d = sortedDates[i];
      const s = raw.get(d) || 0;
      if (s > 0) cp++; else if (s < 0) cm++;
      if (i >= N) {
        const old = raw.get(sortedDates[i - N]) || 0;
        if (old > 0) cp--; else if (old < 0) cm--;
      }
      let st = 0;
      if (cp >= M) st = 1;
      else if (cm >= M) st = -1;
      map.set(d, st);
    }
    states.set(sector, map);
  }
  return states;
}

function nearestLevelLE(levelByDate, target) {
  const dates = [...levelByDate.keys()].sort();
  const idx = lastIdxLE(dates, target);
  return idx >= 0 ? levelByDate.get(dates[idx]) : null;
}

function runVariant({ M, N }, sectors, sortedDates, rawSignalBySector, seriesBySymbol) {
  const statesBySector = buildFlowStates(rawSignalBySector, sortedDates, M, N);
  const positions = new Map();
  const trades = [];
  const skipped = { no_rep: 0, no_next_bar: 0, gap_too_wide: 0, bad_price: 0 };
  let entryAttempts = 0;

  for (let i = 0; i < sortedDates.length; i++) {
    const d = sortedDates[i];
    const exitedSectors = new Set();

    for (const s of sectors) {
      const pos = positions.get(s.id);
      if (!pos) continue;
      const sym = seriesBySymbol.get(pos.symbol);
      const nowIdx = lastIdxLE(sym.dates, d);
      if (nowIdx < pos.entryIdx) continue;
      const state = statesBySector.get(s.id).get(d) || 0;
      const heldBars = nowIdx - pos.entryIdx + 1;
      let exitReason = null;
      if (state === 0) exitReason = 'flow_off';
      else if (state !== pos.dir) exitReason = 'flow_reverse';
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
        exitReason = 'forced_end';
      } else {
        skipped.bad_price++;
        positions.delete(s.id);
        continue;
      }

      const grossPct = pos.dir * (exitPrice / pos.entryPrice - 1) * 100;
      const netPct = grossPct - COST_PCT;
      const entryLevel = nearestLevelLE(s.index.levelByDate, pos.entryDate);
      const exitLevel = nearestLevelLE(s.index.levelByDate, exitDate);
      trades.push({
        M, N, sector: s.id, symbol: pos.symbol, dir: pos.dir,
        signalDate: pos.signalDate, entryDate: pos.entryDate, exitDate,
        entryPrice: round(pos.entryPrice), exitPrice: round(exitPrice),
        heldBars, exitReason,
        grossPct: round(grossPct), netPct: round(netPct),
        sectorRetPct: entryLevel && exitLevel && entryLevel > 0
          ? round(pos.dir * (exitLevel / entryLevel - 1) * 100) : null,
      });
      positions.delete(s.id);
      exitedSectors.add(s.id);
    }

    for (const s of sectors) {
      if (exitedSectors.has(s.id) || positions.has(s.id)) continue;
      const state = statesBySector.get(s.id).get(d) || 0;
      if (state === 0) continue;
      entryAttempts++;
      const rep = pickRepresentative(s.members, d);
      if (!rep) { skipped.no_rep++; continue; }
      const sym = seriesBySymbol.get(rep);
      const nowIdx = lastIdxLE(sym.dates, d);
      if (nowIdx < 0 || sym.dates[nowIdx] !== d) { skipped.no_rep++; continue; }
      const nextIdx = nowIdx + 1;
      if (nextIdx >= sym.dates.length) { skipped.no_next_bar++; continue; }
      if (dayDiff(sym.dates[nextIdx], d) > MAX_ENTRY_GAP_DAYS) { skipped.gap_too_wide++; continue; }
      const entryPrice = sym.open[nextIdx];
      if (!Number.isFinite(entryPrice) || entryPrice <= 0) { skipped.bad_price++; continue; }
      positions.set(s.id, {
        dir: state, symbol: rep, entryIdx: nextIdx, entryPrice,
        entryDate: sym.dates[nextIdx], signalDate: d,
      });
    }
  }

  for (const [sector, pos] of positions) {
    const sym = seriesBySymbol.get(pos.symbol);
    const last = sym.dates.length - 1;
    const exitPrice = sym.close[last];
    if (!Number.isFinite(exitPrice) || exitPrice <= 0) continue;
    const s = sectors.find((x) => x.id === sector);
    const grossPct = pos.dir * (exitPrice / pos.entryPrice - 1) * 100;
    const entryLevel = nearestLevelLE(s.index.levelByDate, pos.entryDate);
    const exitLevel = nearestLevelLE(s.index.levelByDate, sym.dates[last]);
    trades.push({
      M, N, sector, symbol: pos.symbol, dir: pos.dir, signalDate: pos.signalDate,
      entryDate: pos.entryDate, exitDate: sym.dates[last],
      entryPrice: round(pos.entryPrice), exitPrice: round(exitPrice),
      heldBars: last - pos.entryIdx + 1, exitReason: 'forced_end',
      grossPct: round(grossPct), netPct: round(grossPct - COST_PCT),
      sectorRetPct: entryLevel && exitLevel && entryLevel > 0
        ? round(pos.dir * (exitLevel / entryLevel - 1) * 100) : null,
    });
  }
  return { trades, skipped, entryAttempts };
}

function main() {
  const t0 = Date.now();
  const cfg = readJson(path.join(ROOT, 'config', 'symbols.json'));
  const active = (cfg.symbols || []).filter((s) => s.active && ELIGIBLE_SECTORS.includes(s.sector));
  const seriesBySymbol = new Map();
  const membersBySector = new Map();
  for (const id of ELIGIBLE_SECTORS) membersBySector.set(id, []);
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
    return { id, members, index: buildSectorIndex(members, sortedDates), oi: buildSectorOi(members, sortedDates) };
  });
  const rawSignalBySector = sectorSignals(sectors, sortedDates);

  const primaryRun = runVariant(PRIMARY, sectors, sortedDates, rawSignalBySector, seriesBySymbol);
  const valTrades = primaryRun.trades.filter((t) => t.entryDate >= VALIDATION_START);
  const designTrades = primaryRun.trades.filter((t) => t.entryDate < VALIDATION_START);
  const primaryVal = summarize(valTrades);
  const decision = primaryVal.ci && primaryVal.meanNetPct > 0 && primaryVal.ci.lo > 0 ? 'promote'
    : primaryVal.ci && primaryVal.meanNetPct < 0 && primaryVal.ci.hi < 0 ? 'discard'
      : 'screen_pending';

  const sensitivity = SENSITIVITY.map(([M, N]) => {
    const run = runVariant({ M, N }, sectors, sortedDates, rawSignalBySector, seriesBySymbol);
    const val = run.trades.filter((t) => t.entryDate >= VALIDATION_START);
    return {
      M, N,
      full: summarize(run.trades),
      validation: summarize(val),
      design: summarize(run.trades.filter((t) => t.entryDate < VALIDATION_START)),
    };
  });

  const primary = {
    M: PRIMARY.M, N: PRIMARY.N,
    full: summarize(primaryRun.trades),
    design: summarize(designTrades),
    validation: primaryVal,
  };

  const holdDist = {};
  for (const t of primaryRun.trades) holdDist[t.heldBars] = (holdDist[t.heldBars] || 0) + 1;
  const byExit = {};
  for (const t of primaryRun.trades) {
    if (!byExit[t.exitReason]) byExit[t.exitReason] = { n: 0, sumNet: 0, sumHeld: 0, wins: 0 };
    const r = byExit[t.exitReason];
    r.n++; r.sumNet += t.netPct; r.sumHeld += t.heldBars; if (t.netPct > 0) r.wins++;
  }

  const out = {
    schema: 'futures-radar-experiment-result/1',
    id: 'MFLOW-02',
    generatedAt: new Date().toISOString(),
    runCommand: 'node research/experiments/macro-flow-v1/run-v2.cjs',
    elapsedMs: Date.now() - t0,
    settings: {
      rawSignal: 'MFLOW-01 同口径（未改）',
      primary: PRIMARY,
      sensitivity: SENSITIVITY,
      costPct: COST_PCT,
      maxHoldBars: MAX_HOLD_BARS,
      validationStart: VALIDATION_START,
      bootstrap: { B: 10000, seed: 20260918 },
    },
    decision,
    primary,
    sensitivity,
    entryAttempts: primaryRun.entryAttempts,
    skipped: primaryRun.skipped,
    holdDistribution: holdDist,
    byExitReason: Object.fromEntries(Object.entries(byExit).map(([k, v]) => [k, {
      n: v.n,
      meanNetPct: round(v.sumNet / v.n),
      meanHeldBars: round(v.sumHeld / v.n, 2),
      winRate: round(v.wins / v.n),
    }])),
    dataRange: { first: sortedDates[0], last: sortedDates[sortedDates.length - 1], tradingDates: sortedDates.length },
  };

  fs.mkdirSync(RES_DIR, { recursive: true });
  fs.writeFileSync(path.join(RES_DIR, 'results-mflow-02.json'), JSON.stringify(out, null, 2) + '\n');
  fs.writeFileSync(path.join(RES_DIR, 'trades-mflow-02.json'), JSON.stringify(primaryRun.trades, null, 2) + '\n');
  writeReport(out);
  console.log(JSON.stringify({
    decision: out.decision,
    validation: out.primary.validation,
    full: out.primary.full,
    skipped: out.skipped,
    byExitReason: out.byExitReason,
    sensitivity: out.sensitivity.map((s) => ({
      mn: `${s.M}/${s.N}`,
      fullMean: s.full.meanNetPct,
      fullCI: s.full.ci ? [s.full.ci.lo, s.full.ci.hi] : null,
      valMean: s.validation.meanNetPct,
      valCI: s.validation.ci ? [s.validation.ci.lo, s.validation.ci.hi] : null,
      valN: s.validation.n,
    })),
  }, null, 2));
  return out;
}

function writeReport(out) {
  const L = [];
  const v = out.primary.validation;
  L.push('# MFLOW-02 流状态机（3/5 多数确认）— 历史验证报告');
  L.push('');
  L.push(`- 生成时间：${out.generatedAt}`);
  L.push(`- 数据范围：${out.dataRange.first} ~ ${out.dataRange.last}`);
  L.push(`- 原始信号：MFLOW-01 同口径（未改）；唯一变量：单日信号 → ${out.settings.primary.M}/${out.settings.primary.N} 流状态机`);
  L.push(`- 判决集：entryDate ≥ ${out.settings.validationStart}`);
  L.push('');
  L.push(`## 判决：${out.decision}`);
  L.push('');
  L.push('| 指标 | 判决集 (2020+) | 全样本 |');
  L.push('|------|--------------|--------|');
  L.push(`| 交易笔数 | ${v.n} | ${out.primary.full.n} |`);
  L.push(`| 平均单笔净收益 | ${v.meanNetPct}% | ${out.primary.full.meanNetPct}% |`);
  L.push(`| 胜率（net>0） | ${v.winRate === null ? '—' : (v.winRate * 100).toFixed(1) + '%'} | ${out.primary.full.winRate === null ? '—' : (out.primary.full.winRate * 100).toFixed(1) + '%'} |`);
  L.push(`| 95% bootstrap CI | ${v.ci ? `[${v.ci.lo}, ${v.ci.hi}]` : '—'} | ${out.primary.full.ci ? `[${out.primary.full.ci.lo}, ${out.primary.full.ci.hi}]` : '—'} |`);
  L.push('');
  L.push('## 退出原因分解（3/5 主口径）');
  L.push('');
  L.push('| 退出原因 | n | 平均持仓日 | 平均净收益% | 胜率% |');
  L.push('|---------|---|-----------|-----------|-------|');
  for (const [k, r] of Object.entries(out.byExitReason)) {
    L.push(`| ${k} | ${r.n} | ${r.meanHeldBars} | ${r.meanNetPct} | ${(r.winRate * 100).toFixed(1)} |`);
  }
  L.push('');
  L.push('## M/N 敏感性（只报告，不改变判决）');
  L.push('');
  L.push('| M/N | 全样本 n | 全样本均值% | 判决集 n | 判决集均值% | 判决集 CI |');
  L.push('|-----|---------|-----------|---------|-----------|----------|');
  for (const s of out.sensitivity) {
    L.push(`| ${s.M}/${s.N} | ${s.full.n} | ${s.full.meanNetPct ?? '—'} | ${s.validation.n} | ${s.validation.meanNetPct ?? '—'} | ${s.validation.ci ? `[${s.validation.ci.lo}, ${s.validation.ci.hi}]` : '—'} |`);
  }
  L.push('');
  L.push('## 口径与边界');
  L.push('');
  L.push('- 与 MFLOW-01 只差一个变量：流状态持久化（3/5 多数），便于归因。');
  L.push('- 状态 ON 期间单日 rawSig 归零/反向一律不动仓；状态 OFF 才退出。');
  L.push('- 代表品种=近 60 日均量最大成员（PIT）；T+1 open 进/出；往返成本 0.07%。');
  L.push('- 判决只看 2020+ 判决集与预注册的 3/5；M/N 其它组合仅作敏感性观察。');
  L.push('');
  fs.writeFileSync(path.join(RES_DIR, 'report-mflow-02.md'), L.join('\n') + '\n');
}

if (require.main === module) main();
module.exports = { main, buildFlowStates, runVariant };
