#!/usr/bin/env node
/**
 * ga1-driver.cjs — GA-1 主力连续全历史回填驱动
 *
 * 职责：
 *   1. 用 collector/futures_collector.py（--days -1，分品种批次）拉取 59 个
 *      active 扫描品种的全量历史日线（akshare futures_main_sina，SR-01）；
 *   2. 未来日期守卫：丢弃 date > 执行日的 bar 并留档；
 *   3. per-bar source 盖章（akshare_sina_dayline）+ lastBarSource/lastBarAsOf 元数据；
 *   4. dataStore.ingestRunBars(runId='ga-1-full-history') 增量入库（日期去重合并、
 *      ledger 留痕 → 幂等：重复运行不产生重复 bar）；
 *   5. 导出 historical-cache（research/backtest/data/ + data/export/）；
 *   6. 计算换月跳变（|r|>=9.5%）留档 ga1-roll-jumps.json（F5 供回测剔除）；
 *   7. 输出状态文件 ga1-state.json（支持 --resume 只补失败品种）。
 *
 * Usage:
 *   node strategies/research/v2/falsification/ga1-driver.cjs [--workers 2] [--resume]
 *   node strategies/research/v2/falsification/ga1-driver.cjs --rebuild-from-store
 *     （不联网；从 data/daily 权威合并库重建 historical-cache/cache-meta/roll-jumps/state）
 */

const fs = require('fs');
const path = require('path');

const SKILL_ROOT = path.join(__dirname, '../../../..');
const BACKTEST_DIR = path.join(SKILL_ROOT, 'research', 'backtest');
const DATA_DIR = path.join(BACKTEST_DIR, 'data');
const SYMBOLS_PATH = path.join(SKILL_ROOT, 'config', 'symbols.json');
const PYTHON_SCRIPT = path.join(SKILL_ROOT, 'collector', 'futures_collector.py');
const CACHE_PATH = path.join(DATA_DIR, 'historical-cache.json');
const META_PATH = path.join(DATA_DIR, 'cache-meta.json');
const STATE_PATH = path.join(DATA_DIR, 'ga1-state.json');
const FALS_DIR = path.join(__dirname, 'data');
const ROLL_JUMPS_PATH = path.join(FALS_DIR, 'ga1-roll-jumps.json');

const { ParallelCollector } = require(path.join(SKILL_ROOT, 'collector', 'parallel-collector.cjs'));
const dataStore = require(path.join(SKILL_ROOT, 'data-store', 'index.cjs'));

const RUN_ID = 'ga-1-full-history';
const ROLL_JUMP_THRESHOLD = 0.095; // F5：换月跳变 ≥9.5% 剔除

// ── 工具函数 ─────────────────────────────────────────────────

function localDateString(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function isDateString(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function normalizeOne(symbol, raw, today, futureDrops) {
  // 未来日期守卫 + per-bar source 盖章
  const o = raw && raw.ohlcv;
  if (!o || !Array.isArray(o.dates) || o.dates.length === 0) return null;
  const keep = [];
  for (let i = 0; i < o.dates.length; i++) {
    const dt = String(o.dates[i]);
    if (!isDateString(dt)) { futureDrops.push({ symbol, date: dt, reason: 'malformed' }); continue; }
    if (dt > today) { futureDrops.push({ symbol, date: dt, reason: 'future-date' }); continue; }
    keep.push(i);
  }
  if (keep.length === 0) return null;
  const pick = (arr, fill = null) => (Array.isArray(arr) ? keep.map((i) => arr[i]) : new Array(keep.length).fill(fill));
  const n = keep.length;
  const last = keep[keep.length - 1];
  return {
    symbol,
    status: 'ok',
    fetchedAt: raw.fetchedAt || new Date().toISOString(),
    totalBars: raw.totalBars ?? n,
    usedBars: n,
    dataStart: String(o.dates[keep[0]]),
    dataEnd: String(o.dates[last]),
    lastBarSource: 'akshare_sina_dayline',
    lastBarAsOf: String(o.dates[last]),
    lastBarNote: 'ga-1 full-history (akshare futures_main_sina)',
    ohlcv: {
      dates: pick(o.dates),
      open: pick(o.open),
      high: pick(o.high),
      low: pick(o.low),
      close: pick(o.close),
      volume: pick(o.volume),
      open_interest: pick(o.open_interest ?? o.openInterest),
      settle: pick(o.settle),
      sources: new Array(n).fill('akshare_sina_dayline')
    }
  };
}

function computeRollJumps(contracts) {
  const out = {};
  for (const [symbol, c] of Object.entries(contracts)) {
    const o = c && c.ohlcv;
    if (!o || !Array.isArray(o.close)) continue;
    const jumps = [];
    for (let i = 1; i < o.close.length; i++) {
      const prev = Number(o.close[i - 1]);
      const cur = Number(o.close[i]);
      if (!Number.isFinite(prev) || !Number.isFinite(cur) || prev === 0) continue;
      const r = cur / prev - 1;
      if (Math.abs(r) >= ROLL_JUMP_THRESHOLD) {
        jumps.push({ date: o.dates[i], ret: Number(r.toFixed(6)), close: cur, prevClose: prev });
      }
    }
    out[symbol] = jumps;
  }
  return out;
}

// ── 主流程 ──────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const workers = args.includes('--workers') ? parseInt(args[args.indexOf('--workers') + 1] || '2', 10) : 2;
  const resume = args.includes('--resume');
  const rebuild = args.includes('--rebuild-from-store');
  const t0 = Date.now();
  const today = localDateString();

  console.log('=== GA-1 Full History Driver ===');
  console.log(`runId=${RUN_ID} today=${today} workers=${workers} resume=${resume} rebuild=${rebuild}\n`);

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(FALS_DIR, { recursive: true });

  // ── rebuild-from-store：不联网，从 data/daily 权威库重建输出文件 ──
  if (rebuild) {
    const cache = dataStore.loadHistoricalCache();
    cache.meta.runId = RUN_ID;
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
    fs.writeFileSync(META_PATH, JSON.stringify({
      cacheFile: 'historical-cache.json',
      runId: RUN_ID,
      createdAt: cache.meta.collectedAt,
      lastUpdatedAt: new Date().toISOString(),
      totalSymbols: cache.meta.succeeded,
      failedSymbols: [],
      dateRange: cache.meta.dateRange,
      elapsedSeconds: ((Date.now() - t0) / 1000).toFixed(1),
      futureDateDrops: 0,
      version: 'ga-1/1.0',
      note: 'rebuilt from data-store (no network)'
    }, null, 2));
    const rollJumps = computeRollJumps(cache.contracts);
    fs.writeFileSync(ROLL_JUMPS_PATH, JSON.stringify({
      schema: 'ga1-roll-jumps/1',
      threshold: ROLL_JUMP_THRESHOLD,
      computedAt: new Date().toISOString(),
      note: 'F5 换月拼接纪律：|r_t| >= 9.5% 的 bar 标记为疑似换月跳变，walk-forward 回测按换月日剔除',
      bySymbol: rollJumps,
      totalJumpBars: Object.values(rollJumps).reduce((a, v) => a + v.length, 0)
    }, null, 2));
    fs.writeFileSync(STATE_PATH, JSON.stringify({
      runId: RUN_ID,
      lastRunAt: new Date().toISOString(),
      succeeded: Object.keys(cache.contracts),
      failed: []
    }, null, 2));
    console.log(`=== GA-1 Rebuild Summary (from store, no network) ===`);
    console.log(`symbols=${cache.meta.succeeded} bars=${Object.values(cache.contracts).reduce((a, c) => a + c.ohlcv.dates.length, 0)}`);
    console.log(`dateRange: ${cache.meta.dateRange.earliest} .. ${cache.meta.dateRange.latest}`);
    return;
  }

  const symbolsConfig = JSON.parse(fs.readFileSync(SYMBOLS_PATH, 'utf8'));
  let targetSymbols = symbolsConfig.symbols.filter((s) => s.active).map((s) => s.symbol);

  const state = fs.existsSync(STATE_PATH) ? JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) : { runId: null, succeeded: [], failed: [], lastRunAt: null };
  if (resume) {
    const done = new Set(state.succeeded || []);
    const before = targetSymbols.length;
    targetSymbols = targetSymbols.filter((s) => !done.has(s));
    console.log(`[resume] skipping ${before - targetSymbols.length} already-succeeded symbols, fetching ${targetSymbols.length}\n`);
    if (targetSymbols.length === 0) {
      console.log('=== GA-1 Resume: nothing to fetch (idempotency no-op). No files rewritten. ===');
      return;
    }
  }

  const futureDrops = [];
  const collected = {};
  const gaps = {};
  const perSymbolMs = {};

  const doRun = async (symbols) => {
    const collector = new ParallelCollector(symbols, {
      maxWorkers: workers,
      batchSize: 5,
      days: -1,
      timeout: 300000,
      maxRetries: 3,
      retryBackoffMs: 4000,
      pythonScript: PYTHON_SCRIPT,
      tempDir: DATA_DIR
    });
    return collector.run();
  };

  // 第一遍：全量批次
  if (targetSymbols.length > 0) {
    const r1 = await doRun(targetSymbols);
    for (const batch of r1.success) {
      const data = batch.data || {};
      for (const [sym, raw] of Object.entries(data.contracts || {})) {
        const norm = normalizeOne(sym, raw, today, futureDrops);
        if (norm) { collected[sym] = norm; perSymbolMs[sym] = (perSymbolMs[sym] || 0); }
      }
      for (const [sym, gap] of Object.entries(data.gaps || {})) gaps[sym] = gap;
    }
    for (const f of r1.failed) {
      for (const sym of f.symbols) gaps[sym] = { symbol: sym, status: 'gap', reason: `batch-failed: ${f.error || 'unknown'} (retries=${f.retries})` };
    }
  }

  // 第二遍：gap 品种逐个重试（batchSize=1 由新 collector 实例处理，本驱动手动逐符号）
  const stillGap = Object.keys(gaps).filter((s) => !collected[s]);
  if (stillGap.length > 0 && !resume) {
    console.log(`\n=== Symbol-level retry for ${stillGap.length} gaps ===`);
  }
  const retrySymbols = resume ? [] : stillGap;
  for (const sym of retrySymbols) {
    const r2 = await doRun([sym]);
    let got = false;
    for (const batch of r2.success) {
      const data = batch.data || {};
      for (const [s2, raw] of Object.entries(data.contracts || {})) {
        if (s2 !== sym) continue;
        const norm = normalizeOne(s2, raw, today, futureDrops);
        if (norm) { collected[s2] = norm; delete gaps[s2]; got = true; }
      }
    }
    if (!got) gaps[sym] = gaps[sym] || { symbol: sym, status: 'gap', reason: 'symbol-retry-failed' };
  }

  // 组装 cache（resume 模式下与既有 cache 合并，避免覆盖已采集品种）
  const prevCache = resume && fs.existsSync(CACHE_PATH)
    ? JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'))
    : null;
  const mergedContracts = resume && prevCache && prevCache.contracts
    ? { ...prevCache.contracts, ...collected }
    : collected;
  const mergedGaps = resume && prevCache && prevCache.gaps
    ? { ...prevCache.gaps, ...gaps }
    : gaps;

  const cache = {
    meta: {
      runId: RUN_ID,
      collectedAt: new Date().toISOString(),
      source: 'akshare',
      sourceVersion: null,
      totalSymbols: targetSymbols.length,
      succeeded: Object.keys(mergedContracts).length,
      failed: Object.keys(mergedGaps).length,
      dateRange: { earliest: null, latest: null },
      futureDateDrops: futureDrops.length
    },
    contracts: mergedContracts,
    gaps: mergedGaps
  };
  for (const c of Object.values(cache.contracts)) {
    if (!cache.meta.sourceVersion && c.totalBars) cache.meta.sourceVersion = 'akshare-sina-main';
    const d0 = c.ohlcv.dates[0];
    const d1 = c.ohlcv.dates[c.ohlcv.dates.length - 1];
    if (!cache.meta.dateRange.earliest || d0 < cache.meta.dateRange.earliest) cache.meta.dateRange.earliest = d0;
    if (!cache.meta.dateRange.latest || d1 > cache.meta.dateRange.latest) cache.meta.dateRange.latest = d1;
  }

  // 写 historical-cache + cache-meta（回测兼容）
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
  const meta = {
    cacheFile: 'historical-cache.json',
    runId: RUN_ID,
    createdAt: cache.meta.collectedAt,
    lastUpdatedAt: cache.meta.collectedAt,
    totalSymbols: cache.meta.succeeded,
    failedSymbols: Object.keys(gaps),
    dateRange: cache.meta.dateRange,
    elapsedSeconds: ((Date.now() - t0) / 1000).toFixed(1),
    futureDateDrops: futureDrops,
    version: 'ga-1/1.0'
  };
  fs.writeFileSync(META_PATH, JSON.stringify(meta, null, 2));

  // ingestRunBars 入库（runId=ga-1-full-history）；只摄入本轮新采集品种（幂等）
  const ingestResult = dataStore.ingestRunBars({
    runId: RUN_ID,
    rawJson: { contracts: collected, gaps },
    provenance: { driver: 'ga1-driver.cjs', futureDateGuard: today, source: 'akshare futures_main_sina' }
  });
  console.log(`\ningestRunBars: written=${ingestResult.written} barsChanged=${ingestResult.barsChanged}`);

  // 导出回测兼容缓存（data/export/historical-cache.json）
  let exportResult = null;
  try {
    exportResult = dataStore.exportHistoricalCache();
    console.log(`exportHistoricalCache: ${JSON.stringify(exportResult)}`);
  } catch (err) {
    console.warn(`⚠️ exportHistoricalCache failed (non-blocking): ${err.message}`);
  }

  // 换月跳变留档（F5）
  const rollJumps = computeRollJumps(cache.contracts);
  fs.writeFileSync(ROLL_JUMPS_PATH, JSON.stringify({
    schema: 'ga1-roll-jumps/1',
    threshold: ROLL_JUMP_THRESHOLD,
    computedAt: new Date().toISOString(),
    note: 'F5 换月拼接纪律：|r_t| >= 9.5% 的 bar 标记为疑似换月跳变，walk-forward 回测按换月日剔除',
    bySymbol: rollJumps,
    totalJumpBars: Object.values(rollJumps).reduce((a, v) => a + v.length, 0)
  }, null, 2));

  // 状态文件（--resume 依据）
  const newState = {
    runId: RUN_ID,
    lastRunAt: new Date().toISOString(),
    succeeded: resume ? (state.succeeded || []).concat(Object.keys(collected)) : Object.keys(collected),
    failed: Object.keys(gaps)
  };
  fs.writeFileSync(STATE_PATH, JSON.stringify(newState, null, 2));

  // 汇总
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n=== GA-1 Run Summary ===`);
  console.log(`elapsed=${elapsed}s succeeded=${cache.meta.succeeded}/${targetSymbols.length} failed=${cache.meta.failed} futureDrops=${futureDrops.length}`);
  console.log(`dateRange: ${cache.meta.dateRange.earliest} .. ${cache.meta.dateRange.latest}`);
  if (Object.keys(gaps).length > 0) {
    console.log('FAILED SYMBOLS:');
    for (const [sym, gap] of Object.entries(gaps)) console.log(`  ${sym}: ${gap.reason || JSON.stringify(gap)}`);
  }
  if (futureDrops.length > 0) {
    console.log(`future-date guard dropped ${futureDrops.length} bars:`);
    console.log(JSON.stringify(futureDrops.slice(0, 20), null, 2));
  }
  console.log('outputs:');
  console.log(`  ${CACHE_PATH}`);
  console.log(`  ${META_PATH}`);
  console.log(`  ${ROLL_JUMPS_PATH}`);
  console.log(`  ${STATE_PATH}`);
}

main().catch((err) => {
  console.error('GA-1 driver FATAL:', err);
  process.exit(1);
});
