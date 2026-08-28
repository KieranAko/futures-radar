// experiment-line/analyze-v2/packet-freeze-v2.cjs — O4/O5 前置：确定性冻结 packet（无网络）
//
// 与生产 freeze-packets 的差异（优化，不是照搬）：
//   - 期限结构来自 GA-8 本地基差库（不再逐品种网络拉取）
//   - 宏观/板块直接引用已冻结快照
//   - 注入机制候选（O3：来自实验线 registry，按 family 预筛）
//   - 增量上下文：把"昨日结论卡"（上一生产 run 的同品种 analysis）作为 cached 字段
//
// 用法: node experiment-line/analyze-v2/packet-freeze-v2.cjs --runId <runId>
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const EL = path.resolve(__dirname, '..');
const basisLib = require(path.join(ROOT, 'strategies', 'research', 'v2', 'falsification', 'harness-lib', 'basis.cjs'));

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function mean(a) {
  const xs = a.filter((v) => Number.isFinite(v));
  return xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null;
}

function normDate(d) {
  const s = String(d || '');
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s;
}

function atr5(o) {
  const trs = [];
  for (let i = o.dates.length - 5; i < o.dates.length; i++) {
    if (i < 1) continue;
    const tr = Math.max(
      o.high[i] - o.low[i],
      Math.abs(o.high[i] - o.close[i - 1]),
      Math.abs(o.low[i] - o.close[i - 1])
    );
    trs.push(tr);
  }
  return trs.length ? trs.reduce((s, v) => s + v, 0) / trs.length : null;
}

function latestBasis(libSymbol, signalDate) {
  const b = basisLib.loadBasisHistory(libSymbol);
  const target = normDate(signalDate);
  const rows = b.rows.filter((r) => normDate(r.date) <= target);
  return rows.length ? rows[rows.length - 1] : null;
}

function buildPacket(raw, sym, signalDate, macroSnapshot, sectorSnapshot, registry, prevAnalysis) {
  const c = raw.contracts[sym];
  const o = c.ohlcv;
  const n = o.dates.length;
  const close = o.close[n - 1];
  const closes = o.close.slice(-60);
  const ma20 = mean(o.close.slice(-20));
  const ma60 = mean(o.close.slice(-60));
  const a5 = atr5(o);
  const chg5 = (o.close[n - 1] / o.close[n - 6] - 1) * 100;
  const volWindow = o.volume.slice(-6, -1);
  const volMult = mean(volWindow) ? o.volume[n - 1] / mean(volWindow) : null;
  const hi20 = Math.max(...o.high.slice(-20));
  const lo20 = Math.min(...o.low.slice(-20));
  const basis = latestBasis(sym, signalDate);
  const sectorName = c.sector;
  const sector = sectorSnapshot?.sectors?.[sectorName] || null;
  const familyCandidates = {};
  for (const m of Object.values(registry || {})) {
    (familyCandidates[m.family] = familyCandidates[m.family] || []).push({ id: m.id, status: m.status });
  }
  const prev = prevAnalysis?.[sym] || null;
  return {
    symbol: sym,
    name: c.name,
    exchange: c.exchange,
    sector: sectorName,
    multiplier: c.multiplier,
    signalDate,
    price_data: {
      close,
      close_60d: closes,
      ma20: Math.round(ma20 * 100) / 100,
      ma60: Math.round(ma60 * 100) / 100,
      atr5: Math.round(a5 * 100) / 100,
      change5dPct: Math.round(chg5 * 100) / 100,
      volMultiplier: volMult == null ? null : Math.round(volMult * 100) / 100,
      high20d: hi20,
      low20d: lo20,
    },
    volume_oi: {
      volume_60d: o.volume.slice(-60),
      volumeLast: o.volume[n - 1],
      openInterestLast: o.openInterest?.[n - 1] ?? null,
      oiChange5dPct: o.openInterest && o.openInterest[n - 6]
        ? Math.round(((o.openInterest[n - 1] / o.openInterest[n - 6]) - 1) * 10000) / 100
        : null,
    },
    term_structure: basis
      ? { br: basis.br, domBasisRate: basis.domBasisRate, asOf: normDate(basis.date), note: 'GA-8 ≤信号日最新行；br=(S−F)/S，正=现货升水' }
      : null,
    macro_context: macroSnapshot?.indicators ? { indicators: macroSnapshot.indicators } : null,
    sector_context: sector
      ? { sector: sectorName, direction: sector.direction, ret1d: sector.ret1d, ret5d: sector.ret5d, advanceRatio1d: sector.advanceRatio1d }
      : null,
    mechanism_candidates: familyCandidates,
    prevAnalysisCache: prev
      ? { runId: prev.runId, direction: prev.direction, confidence: prev.confidence, q1: prev.q1_driver?.primary, q5: prev.q5_invalidation?.conditions }
      : null,
    source: `raw.json ${n} bars + GA-8 + macro/sector snapshot + registry`,
  };
}

function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--runId');
  const runId = i >= 0 ? args[i + 1] : null;
  if (!runId) throw new Error('--runId required');

  const runPath = path.join(EL, 'runs', runId);
  const raw = readJson(path.join(runPath, 'raw.json'));
  const filtered = readJson(path.join(runPath, 'filtered.json'));
  const macroSnapshot = readJson(path.join(runPath, 'macro-snapshot.json'));
  const sectorSnapshot = readJson(path.join(runPath, 'sector-snapshot.json'));
  const signalDate = filtered.meta?.runId?.slice(0, 8).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');

  // 机制目录（registry 运行状态；无文件时为空）
  const registry = {};
  const regDir = path.join(EL, 'registry');
  if (fs.existsSync(regDir)) {
    for (const f of fs.readdirSync(regDir).filter((x) => x.endsWith('.json'))) {
      registry[f.replace('.json', '')] = readJson(path.join(regDir, f));
    }
  }

  // 昨日结论卡（增量上下文 O5）：仅当目标 run 严格晚于上一生产 run 时注入（防未来信息）
  const prevAnalysis = {};
  const prevRunDir = path.join(ROOT, 'output', 'runs', '20260827-2159-auto');
  if (signalDate > '2026-08-27' && fs.existsSync(path.join(prevRunDir, 'analysis.json'))) {
    const prev = readJson(path.join(prevRunDir, 'analysis.json'));
    for (const a of prev.analyses || []) {
      prevAnalysis[a.symbol] = { runId: prev.meta.runId, direction: a.direction, confidence: a.confidence, q1_driver: a.q1_driver, q5_invalidation: a.q5_invalidation };
    }
  }

  const keep = (filtered.candidates || []).filter((c) => c.decision === 'KEEP');
  const packets = {};
  for (const c of keep) {
    packets[c.symbol] = buildPacket(raw, c.symbol, signalDate, macroSnapshot, sectorSnapshot, registry, prevAnalysis);
  }
  const out = {
    schema: 'futures-radar-analyze-v2-packets/1',
    generatedAt: new Date().toISOString(),
    runId,
    signalDate,
    symbols: Object.keys(packets),
    packets,
    note: 'v2 确定性冻结：无网络；期限结构=GA-8 本地；机制候选=registry；昨日结论=增量上下文缓存',
  };
  const outFile = path.join(runPath, 'analyze', 'packets-v2.json');
  writeJson(outFile, out);
  console.log(`packets-v2: ${outFile} (${Object.keys(packets).length} symbols)`);
  return out;
}

if (require.main === module) main();
module.exports = { main, buildPacket, atr5 };
