// stories/seats/build-filtered-from-story-pool.cjs — V2 初筛替代品
//
// 故事池 proven 链 = KEEP 名单的唯一来源（filter-llm 已退役）。
// 与 apply-story-seats 的区别：本脚本【重写】filtered.json 的 candidates，
// 而不是在 LLM 初筛结果上追加——旧 filter-llm 不再参与 KEEP 决策。
//
// 运行时机：observe --runId 之后、freeze-packets 之前。
//   node stories/seats/build-filtered-from-story-pool.cjs --runId <runId>
//
// 行为：
//   1. proven 链的代表品种 → KEEP（tracking=true, storyChainId）
//   2. 信号池 active/downgraded 追踪席位 → KEEP（tracking=true, signalId）
//   3. 无 proven 链且无追踪席位 → 空 candidates（空仓合法）
//   4. candidates.json 同步补席位（build-facts symbol join 需要）
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { runDir, skillRoot } = require('../../shared/workspace.cjs');
const { loadLedger, loadChain, isActive } = require('../lib/story-chain.cjs');
const signalPool = require('../../signals/lib/signal-pool.cjs');

function flagVal(args, flag) {
  const i = args.indexOf(flag);
  return i === -1 ? null : args[i + 1];
}

function readJSON(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function writeJSONAtomic(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, p);
}

function trackingSeatEntries(poolSignals) {
  const out = [];
  // 只有诞生自故事链的信号才允许继续占深挖席位；孤儿/legacy 信号只留在信号池验证，不进入机会分析
  const withStory = (poolSignals || []).filter((s) => s && s.storyChainId);
  for (const sig of withStory) {
    // ASM-04：方向缺失/非法时跳过，不静默当作 bullish。
    if (!['bearish', 'bullish'].includes(sig.direction)) continue;
    const cur = (sig.versions || []).find((v) => v.versionId === sig.currentVersionId) || (sig.versions || [])[sig.versions.length - 1];
    out.push({
      symbol: sig.symbol,
      rank: 90 + out.length,
      directionHint: sig.direction,
      directionBias: sig.direction,
      decision: 'KEEP',
      // ASM-04：confidence 缺失时如实置 null，不用 'medium' 冒充判断。
      confidence: cur && ['high', 'medium', 'low'].includes(cur.confidence) ? cur.confidence : null,
      reason: `信号池追踪席位 ${sig.signalId}：入池 ${sig.createdDate}，${sig.thesis || '品种机会持续追踪'}`,
      informationGap: '信号池追踪席位：需与故事席位同规格完整再分析',
      tracking: true,
      signalId: sig.signalId,
      author: 'machine-seat',
    });
  }
  return out;
}

function branchRefsOfChain(c) {
  if (!c || c.provisional === true) return []; // provisional 链仅观察，不产生故事席位
  if (c && Array.isArray(c.terminals) && c.terminals.length > 0) {
    return c.terminals
      .filter((t) => ['resolving', 'pending', 'proven'].includes(t.status))
      .map((t) => ({
        branchId: t.nodeId,
        symbol: t.symbol,
        direction: t.direction,
        priority: t.priority || 'secondary',
        status: t.status,
        impactRationale: t.impactRationale || null,
        proofIndex: t.proofIndex || null,
      }));
  }
  if (c && c.representative) {
    const dir = c.direction === -1 || c.direction === 'bearish' || c.direction === 'short'
      ? -1
      : c.direction === 1 || c.direction === 'bullish' || c.direction === 'long' ? 1 : null;
    if (dir !== null) {
      return [{
        branchId: null,
        symbol: c.representative,
        direction: dir,
        priority: 'primary',
        status: c.status || 'pending',
        impactRationale: null,
        proofIndex: c.entryProofIndex || null,
      }];
    }
  }
  return [];
}

function storySeatEntries(chains) {
  const bySymbol = new Map();
  const order = [];
  for (const c of chains || []) {
    for (const ref of branchRefsOfChain(c)) {
      if (!bySymbol.has(ref.symbol)) {
        bySymbol.set(ref.symbol, []);
        order.push(ref.symbol);
      }
      bySymbol.get(ref.symbol).push({
        chainId: c.chainId,
        theme: c.theme || '',
        themeDetail: c.themeDetail || null,
        status: ref.status,
        ...ref,
      });
    }
  }
  const PRIORITY = { primary: 0, secondary: 1 };
  const STATUS = { proven: 0, pending: 1, resolving: 2 };
  return order.map((symbol, i) => {
    const refs = bySymbol.get(symbol).sort((a, b) =>
      (PRIORITY[a.priority] ?? 2) - (PRIORITY[b.priority] ?? 2)
      || (STATUS[a.status] ?? 3) - (STATUS[b.status] ?? 3)
      || String(a.chainId).localeCompare(String(b.chainId))
    );
    const primary = refs[0];
    const seatDir = primary.direction === -1 ? 'bearish' : primary.direction === 1 ? 'bullish' : null;
    if (!seatDir) return null; // ASM-04：方向缺失/非法时跳过，不默认 bullish。
    return {
      symbol,
      rank: 80 + i,
      directionHint: seatDir,
      directionBias: seatDir,
      decision: 'KEEP',
      confidence: null, // ASM-03：席位为确定性注入，置信度不冒充 LLM 判断。
      reason: `故事传导链席位：${refs.map((r) => `${r.chainId}${r.branchId ? '/' + r.branchId : ''}(${r.status})`).join('、')}`,
      informationGap: '故事传导链席位：只要有故事链即完整六问深挖',
      tracking: true,
      storyChainId: primary.chainId,
      author: 'machine-seat',
      storyRefs: refs.map((r) => ({
        chainId: r.chainId,
        branchId: r.branchId,
        priority: r.priority,
        direction: r.direction,
        status: r.status,
        impactRationale: r.impactRationale,
      })),
    };
  }).filter(Boolean);
}

/**
 * 纯函数：构建 V2 filtered.json。
 * @param {object} base { runId, filteredAt, provenChains, poolSignals }
 */
function buildFilteredFromStoryPool({ runId, filteredAt, provenChains = [], poolSignals = [] }) {
  const storySeats = storySeatEntries(provenChains);
  const storySymbols = new Set(storySeats.map((c) => c.symbol));
  const trackingSeats = trackingSeatEntries(poolSignals).filter((c) => !storySymbols.has(c.symbol));
  const candidates = [...storySeats, ...trackingSeats];
  return {
    meta: {
      runId,
      filteredAt,
      inputCount: 0,
      outputCount: candidates.filter((c) => c.decision === 'KEEP').length,
      hardFilterRejectsImmutable: true,
      note: `V2 初筛：故事池活跃链席位 ${storySeats.length}（resolving/pending/proven 都分析）+ 信号池追踪席位 ${trackingSeats.length}（已去重，孤儿/legacy 信号不入深挖）；filter-llm 已退役`,
      storySeats: storySeats.length,
      trackingSeats: trackingSeats.length,
      author: 'deterministic-seats',
    },
    candidates,
    downgraded: [],
  };
}

function mean(xs) {
  const v = xs.filter((x) => Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

function basicIndicators(contract) {
  const o = contract && contract.ohlcv;
  const empty = { atr5: 0, atrPct: 0, hv5: 0, hv20: 0, volPercentile: 0, volMultiplier: 0, change5d: 0 };
  const emptyTrend = { close: 0, vsMA20: 0, vsMA60: 0, direction: 'flat' };
  const emptyLiq = { avgVolume5d: 0, avgTurnover5d: 0, avgOI5d: 0 };
  if (!o || !Array.isArray(o.close) || o.close.length < 6) return { indicators: empty, trend: emptyTrend, liquidity: emptyLiq };
  const n = o.close.length;
  const close = o.close[n - 1];
  const trs = [];
  for (let i = Math.max(1, n - 5); i < n; i++) {
    const h = Number.isFinite(o.high && o.high[i]) ? o.high[i] : o.close[i];
    const l = Number.isFinite(o.low && o.low[i]) ? o.low[i] : o.close[i];
    const pc = o.close[i - 1];
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const atr5 = trs.length ? mean(trs) : 0;
  const ma = (k) => (n > k ? mean(o.close.slice(n - k)) : null);
  const ma20 = ma(20);
  const ma60 = ma(60);
  const chg5 = n > 5 && o.close[n - 6] > 0 ? (close / o.close[n - 6] - 1) * 100 : 0;
  const vol = Array.isArray(o.volume) ? o.volume.slice(-5).filter((x) => Number.isFinite(x) && x > 0) : [];
  const oi = Array.isArray(o.openInterest) ? o.openInterest.slice(-5).filter((x) => Number.isFinite(x) && x > 0) : [];
  return {
    indicators: { atr5, atrPct: close > 0 ? (atr5 / close) * 100 : 0, hv5: 0, hv20: 0, volPercentile: 0, volMultiplier: 0, change5d: chg5 },
    trend: {
      close,
      vsMA20: ma20 ? (close / ma20 - 1) * 100 : 0,
      vsMA60: ma60 ? (close / ma60 - 1) * 100 : 0,
      direction: ma20 && ma60 ? (close >= ma20 && close >= ma60 ? 'up' : close < ma20 && close < ma60 ? 'down' : 'flat') : 'flat',
    },
    liquidity: { avgVolume5d: mean(vol) || 0, avgTurnover5d: 0, avgOI5d: mean(oi) || 0 },
  };
}

function patchCandidatesFile(candidatesPath, entries, rawJson = {}, runId = null) {
  let candidates;
  if (fs.existsSync(candidatesPath)) {
    candidates = readJSON(candidatesPath);
  } else {
    candidates = {
      meta: {
        runId,
        generatedAt: new Date().toISOString(),
        generatedBy: 'stories/seats/build-filtered-from-story-pool.cjs',
        note: 'V2 故事席位候选（不来自波动率扫描）'
      },
      candidates: []
    };
  }
  candidates.meta = candidates.meta || {};
  if (runId && !candidates.meta.runId) candidates.meta.runId = runId;
  candidates.meta.generatedBy = 'stories/seats/build-filtered-from-story-pool.cjs';
  candidates.meta.note = 'V2 故事席位候选（不来自波动率扫描）';
  const symbolsConfig = JSON.parse(fs.readFileSync(path.join(skillRoot, 'config', 'symbols.json'), 'utf8'));
  const cfgMap = new Map((symbolsConfig.symbols || []).map((c) => [c.symbol, c]));
  const candList = [];
  const seen = new Set();
  let rank = 1;
  for (const e of entries) {
    if (!e || seen.has(e.symbol)) continue;
    seen.add(e.symbol);
    const cfg = cfgMap.get(e.symbol) || {};
    const contract = (rawJson.contracts || {})[e.symbol] || {};
    const ind = basicIndicators(contract);
    candList.push({
      symbol: e.symbol,
      name: cfg.name || e.symbol,
      exchange: cfg.exchange || '',
      sector: cfg.sector || '',
      rank,
      indicators: ind.indicators,
      trend: ind.trend,
      liquidity: ind.liquidity,
      score: 0,
      tracking: true,
      storyChainId: e.storyChainId || null,
      signalId: e.signalId || null,
    });
    rank++;
  }
  candidates.candidates = candList;
  writeJSONAtomic(candidatesPath, candidates);
}

function main() {
  const args = process.argv.slice(2);
  const runId = flagVal(args, '--runId');
  if (!runId) { console.error('FATAL: --runId required'); process.exit(1); }

  const dir = runDir(runId);
  const storyLedger = loadLedger();
  const activeChains = storyLedger.chains
    .filter((r) => isActive(r.status))
    .map((r) => loadChain(r.chainId))
    .filter(Boolean);

  const sigLedger = signalPool.loadLedger();
  const poolSignals = sigLedger.signals
    .map((r) => signalPool.loadSignal(r.signalId))
    .filter((s) => s && s.poolStatus !== 'closed');

  const filtered = buildFilteredFromStoryPool({
    runId,
    filteredAt: new Date().toISOString(),
    provenChains: activeChains,
    poolSignals,
  });

  const filteredPath = path.join(dir, 'filtered.json');
  writeJSONAtomic(filteredPath, filtered);
  const rawJson = fs.existsSync(path.join(dir, 'raw.json')) ? readJSON(path.join(dir, 'raw.json')) : {};
  patchCandidatesFile(path.join(dir, 'candidates.json'), filtered.candidates, rawJson, runId);
  console.log(`V2 filtered.json: storySeats=${filtered.meta.storySeats}, trackingSeats=${filtered.meta.trackingSeats}, KEEP=${filtered.meta.outputCount}`);
  if (filtered.candidates.length === 0) console.log('  空仓合法：故事池为空且无信号池追踪席位，本期不深挖。');
}

if (require.main === module) main();
module.exports = { main, buildFilteredFromStoryPool, storySeatEntries, trackingSeatEntries, patchCandidatesFile };
