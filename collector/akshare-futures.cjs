#!/usr/bin/env node
/**
 * akshare-futures.cjs — futures-radar collector (Phase 3)
 * Wraps Python futures_collector.py, enriches with metadata, writes output artifacts.
 *
 * Usage:
 *   node collector/akshare-futures.cjs --runId 20260730-1645-auto
 */

const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { runtimeRoot, skillRoot } = require('../lib/workspace.cjs');
const { ParallelCollector } = require('./parallel-collector.cjs');
const { rejectFutureDateContracts } = require('./future-date-guard.cjs');
const { fetchCloseSnapshot, mergeSnapshotBars, todayStr } = require('./close-snapshot.cjs');
const { runCfmmcVerification } = require('./cfmmc-verify.cjs');
const dataStore = require('../data-store/index.cjs');

// ── CLI ──────────────────────────────────────────────────────
const args = process.argv.slice(2);
const runIdIdx = args.indexOf('--runId');
const runId = runIdIdx >= 0 ? args[runIdIdx + 1] : null;

if (!runId) {
  console.error('ERROR: --runId is required');
  process.exit(1);
}

const RUN_DIR = path.join(runtimeRoot, 'runs', runId);
fs.mkdirSync(RUN_DIR, { recursive: true }); // 独立运行时先建 run 目录（管道场景由 probe 阶段创建，此处幂等）
const SYMBOLS_PATH = path.join(skillRoot, 'config', 'symbols.json');
const PYTHON_SCRIPT = path.join(skillRoot, 'collector', 'futures_collector.py');

// ── Main ─────────────────────────────────────────────────────
async function main() {
  console.log(`=== futures-radar collect ===`);
  console.log(`runId: ${runId}`);

  // 1. Read symbols whitelist (dynamic)
  if (!fs.existsSync(SYMBOLS_PATH)) {
    console.error(`ERROR: symbols.json not found: ${SYMBOLS_PATH}`);
    process.exit(1);
  }
  const symbolsConfig = JSON.parse(fs.readFileSync(SYMBOLS_PATH, 'utf8'));
  const activeSymbols = symbolsConfig.symbols.filter(s => s.active);
  const symbolMap = {};
  for (const s of symbolsConfig.symbols) {
    symbolMap[s.symbol] = s;
  }

  console.log(`Active symbols: ${activeSymbols.length}/${symbolsConfig.symbols.length}`);

  // 2. P1 增量缓存计划（v0.1.2）：复用最近 run 的历史序列，只拉源端已更新的品种
  // 契约：先 1 次探测 sina 最新 bar 日期，缓存末 bar 同日 → 复用；缓存缺失/落后/
  // 序列非法 → 重拉；缓存超过 5 天 → 全量校准；FUTURES_FULL_PULL=1 强制全量。
  // 任何失败回退全量（fail-open 保持既有行为）。
  // v0.1.3 快照优先增量（snapshot-first）：日线已发布今日 bar 且缓存恰好落后一根时，
  // 用收盘快照（1 次 HTTP 调用 + CFMMC 交叉验证）补当日 bar，跳过 ~59 次日线重拉（~13s）。
  const localTodayP1 = todayStr();
  let collectMode = 'full';
  let cachePlan = null;
  let snapshotFirstEligible = false;
  if (process.env.FUTURES_FULL_PULL !== '1') {
    try {
      const ic = require('./incremental-cache.cjs');
      const cache = ic.findLatestCacheRaw(runtimeRoot, runId);
      if (cache && !ic.isCacheStale(cache.raw, {})) {
        const latestBars = await ic.probeLatestSinaBarDates(PYTHON_SCRIPT, 'RB0');
        if (!latestBars) {
          console.warn('⚠️ sina latest-bar probe failed, falling back to full pull');
        } else {
          const plan = ic.planIncremental(activeSymbols.map(s => s.symbol), cache.raw, {
            latestBarDate: latestBars.latest, today: localTodayP1
          });
          if (plan.reuse.length > 0 || plan.fetch.length > 0) {
            cachePlan = { cacheRunId: cache.runId, latestBarDate: latestBars.latest, plan, cacheRaw: cache.raw };
            collectMode = 'incremental';
          }
          if (process.env.FUTURES_FAST_CLOSE !== '0') {
            const sf = ic.planSnapshotFirst(cache.raw, activeSymbols.map(s => s.symbol), {
              latest: latestBars.latest, prev: latestBars.prev, today: localTodayP1
            });
            if (sf.eligible) {
              snapshotFirstEligible = true;
            } else if (process.env.FUTURES_VERBOSE === '1') {
              console.log(`snapshot-first: not eligible (${sf.reason})`);
            }
          }
        }
      }
    } catch (err) {
      console.warn(`⚠️ incremental plan failed, falling back to full pull: ${err.message}`);
    }
  }

  // v0.1.3: 快照优先尝试 — 用收盘快照一次性补齐当日 bar；覆盖率不足则回退日线重拉
  let snapshotFirst = null; // { snapshot } | null
  if (snapshotFirstEligible && cachePlan) {
    const tS0 = Date.now();
    const snapshot = await fetchCloseSnapshot(activeSymbols.map((s) => s.symbol), { localToday: localTodayP1 });
    const okCount = Object.keys(snapshot.bars).length;
    const minCoverage = Math.ceil(activeSymbols.length * 0.9);
    if (okCount >= minCoverage) {
      snapshotFirst = { snapshot };
      collectMode = 'incremental-snapshot';
      console.log(`snapshot-first: snapshot covers ${okCount}/${activeSymbols.length} → skipping day-line refetch (${((Date.now() - tS0) / 1000).toFixed(1)}s)`);
    } else {
      console.warn(`snapshot-first: coverage ${okCount}/${activeSymbols.length} < ${minCoverage} → falling back to day-line refetch`);
    }
  }

  const fetchSymbols = snapshotFirst ? [] : (cachePlan ? cachePlan.plan.fetch : activeSymbols.map(s => s.symbol));
  console.log(`collect mode: ${collectMode}${cachePlan
    ? ` (cache run ${cachePlan.cacheRunId}, latest=${cachePlan.latestBarDate}, fetch=${fetchSymbols.length}, reuse=${cachePlan.plan.reuse.length})`
    : ''}`);

  // 2. Run parallel collection（仅拉取需要更新的品种；fetch=0 时全部走缓存，跳过采集）
  const t0 = Date.now();
  let collectionResult;
  if (fetchSymbols.length > 0) {
    const collector = new ParallelCollector(
      fetchSymbols,
      {
        maxWorkers: 4,
        // P1 实测：batchSize 15 × 4 workers = 60 并发连续请求触发 sina 限流（456，重试仍失败）；
        // 4×5=20 并发经多轮实测可靠 → 维持 5。提速由增量缓存承担（复用后 fetch≈0）。
        batchSize: 5,
        days: 60,
        timeout: 180000, // 3 minutes per batch
        maxRetries: 3,
        pythonScript: PYTHON_SCRIPT,
        tempDir: RUN_DIR
      }
    );
    collectionResult = await collector.run();
    if (collectionResult.success.length === 0) {
      console.error(`ERROR: All batches failed, no data collected`);
      process.exit(1);
    }
  } else {
    console.log('(no symbols to fetch — all reused from cache)');
    collectionResult = { success: [], failed: [], stats: {} };
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  // 3. Merge results from all successful batches
  const rawData = {
    meta: {
      sourceVersion: null, // Will extract from first batch; 全复用场景从缓存继承
      totalSymbols: activeSymbols.length,
      succeeded: 0,
      failed: 0,
      daysPerSymbol: 60
    },
    contracts: {},
    gaps: {}
  };
  if (cachePlan && !rawData.meta.sourceVersion && cachePlan.cacheRaw.meta && cachePlan.cacheRaw.meta.sourceVersion) {
    rawData.meta.sourceVersion = cachePlan.cacheRaw.meta.sourceVersion;
  }

  // Merge successful batches
  for (const batchResult of collectionResult.success) {
    if (!rawData.meta.sourceVersion && batchResult.data.meta) {
      rawData.meta.sourceVersion = batchResult.data.meta.sourceVersion;
    }
    Object.assign(rawData.contracts, batchResult.data.contracts || {});
    Object.assign(rawData.gaps, batchResult.data.gaps || {});
  }

  // P1: 增量模式 — 复用缓存序列（深拷贝），新拉取优先覆盖
  rawData.meta.collectMode = collectMode;
  if (cachePlan) {
    const ic = require('./incremental-cache.cjs');
    // v0.1.3 快照优先：全部品种从缓存复用（跳过日线重拉），随后快照补当日 bar
    const reuseList = snapshotFirst
      ? activeSymbols.map((s) => ({ symbol: s.symbol }))
      : cachePlan.plan.reuse;
    const reusedContracts = ic.cloneContractsForReuse(cachePlan.cacheRaw, reuseList);
    rawData.contracts = { ...reusedContracts, ...rawData.contracts };
    rawData.meta.cacheInfo = {
      runId: cachePlan.cacheRunId,
      latestBarDate: cachePlan.latestBarDate,
      reused: reuseList.length,
      fetched: snapshotFirst ? 0 : cachePlan.plan.fetch.length,
      validationFailures: cachePlan.plan.validationFailures,
      snapshotFirst: snapshotFirst ? true : undefined
    };
    if (cachePlan.plan.validationFailures.length > 0) {
      console.warn(`  ⚠️ cache validation failures (refetched): ${cachePlan.plan.validationFailures.map(v => v.symbol).join(',')}`);
    }
  }

  // 3.4b v0.1.3 快照优先：收盘快照补当日 bar（append-only；date==今日 && time>=15:00
  // 与 OHLC 自洽校验在 close-snapshot.cjs 内完成，CFMMC 交叉验证在 3.7 统一执行）
  if (snapshotFirst) {
    const merged = mergeSnapshotBars(rawData, snapshotFirst.snapshot, { localToday: localTodayP1 });
    rawData.meta.fastClose = {
      used: merged.appended.length > 0,
      source: 'sina_close_snapshot',
      fetchedAt: snapshotFirst.snapshot.fetchedAt,
      localToday: localTodayP1,
      appended: merged.appended.length,
      skipped: merged.skipped.length,
      failed: merged.failed.length,
      errors: snapshotFirst.snapshot.errors,
      note: 'snapshot-first: day-line refetch skipped (cache one bar behind, snapshot filled today)'
    };
    console.log(`snapshot-first: appended=${merged.appended.length} skipped=${merged.skipped.length} failed=${merged.failed.length}`);
    if (merged.appended.length) console.log(`  appended: ${merged.appended.join(',')}`);
  }

  // 3.5 Future-date guard (冻结不变量 #1)
  // 末 bar 日期 > 本地今日或非法日期（非严格 YYYY-MM-DD/真实日历）视为源行为异常
  // （应永不触发）。必须在 enrich/持久化前剔除，否则污染数据会被后续增量采集
  // 复用。fail-loud: 告警日志含完整诊断（symbol/rawDate/lastBarDate/fetchedAt/reason）。
  const now = new Date();
  const localToday =
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const { ok: guardOk, rejected: guardRejected, contractsLeft } = rejectFutureDateContracts(rawData, localToday);
  if (!guardOk) {
    console.warn(`⚠️ [future-date-guard] ${guardRejected.length} contract(s) rejected (should never happen; local today = ${localToday})`);
    for (const r of guardRejected) {
      console.warn(`  ✗ ${r.symbol}: lastBarDate=${r.lastBarDate || 'N/A'} rawDate=${r.rawDate == null ? 'N/A' : r.rawDate} fetchedAt=${r.fetchedAt || 'N/A'} reason=${r.reason}`);
    }
    if (contractsLeft === 0) {
      console.error(`FATAL: all ${guardRejected.length} contract(s) rejected by future-date-guard; aborting collect`);
      process.exit(1);
    }
  }

  rawData.meta.succeeded = Object.keys(rawData.contracts).length;
  rawData.meta.failed = Object.keys(rawData.gaps).length + collectionResult.failed.length;

  // 3.6 收盘快照快速通道（v0.1.2）
  // sina 日线接口收盘后经常延迟发布当日 bar；若日线序列缺少本地今日，
  // 用 sina 收盘快照（date==今日 && time>=15:00 完整会话）兜底补入，append-only。
  // FUTURES_FAST_CLOSE=0 可关闭（默认开）。
  // v0.1.3 快照优先模式已在 3.4b 完成快照合并（meta.fastClose 已写），此处跳过。
  if (!snapshotFirst) {
    rawData.meta.fastClose = { used: false, source: 'sina_close_snapshot', note: 'disabled or not needed' };
  }
  if (!snapshotFirst && process.env.FUTURES_FAST_CLOSE !== '0') {
    const localTodaySnapshot = todayStr();
    const needSnapshot = Object.values(rawData.contracts).some(
      (c) => c.ohlcv && Array.isArray(c.ohlcv.dates) && !c.ohlcv.dates.includes(localTodaySnapshot)
    );
    if (needSnapshot) {
      try {
        console.log(`\n=== Fast-close snapshot (day-line lagging, filling ${localTodaySnapshot}) ===`);
        const snapshot = await fetchCloseSnapshot(activeSymbols.map((s) => s.symbol), { localToday: localTodaySnapshot });
        const merged = mergeSnapshotBars(rawData, snapshot, { localToday: localTodaySnapshot });
        rawData.meta.fastClose = {
          used: merged.appended.length > 0,
          source: 'sina_close_snapshot',
          fetchedAt: snapshot.fetchedAt,
          localToday: localTodaySnapshot,
          appended: merged.appended.length,
          skipped: merged.skipped.length,
          failed: merged.failed.length,
          errors: snapshot.errors
        };
        console.log(`fastClose: appended=${merged.appended.length} skipped=${merged.skipped.length} failed=${merged.failed.length}`);
        if (merged.appended.length) console.log(`  appended: ${merged.appended.join(',')}`);
        if (merged.failed.length) console.log(`  failed:   ${merged.failed.join(',')}`);
      } catch (err) {
        // 快照通道失败不阻塞采集（warn）：日线接口数据仍为权威主序列
        console.warn(`⚠️ fast-close snapshot failed (non-blocking): ${err.message}`);
        rawData.meta.fastClose = { used: false, source: 'sina_close_snapshot', note: 'fetch_failed: ' + err.message };
      }
    } else {
      rawData.meta.fastClose = { used: false, source: 'sina_close_snapshot', note: 'day-line already contains localToday, snapshot not needed' };
    }
  }

  // 3.7 CFMMC 交叉验证层（P0 时效闭环，v0.1.2）
  // 快照通道补入的当日 bar 与 CFMMC 官方日线逐品种比对（SHFE/INE/GFEX 首轮、
  // DCE 重试 2 次、CZCE 延后），divergence 记 provenance；warn-only 不阻塞采集。
  // FUTURES_CFMMC_VERIFY=0 可关闭（默认开）。
  rawData.meta.cfmmcVerify = null;
  if (process.env.FUTURES_CFMMC_VERIFY !== '0' && rawData.meta.fastClose && rawData.meta.fastClose.used) {
    try {
      console.log('\n=== CFMMC cross-verification (fast-close bars) ===');
      const cfmmcResult = await runCfmmcVerification(rawData, { skillRoot });
      const s = cfmmcResult.summary;
      console.log(`cfmmcVerify: verified=${s.verified} diverged=${s.diverged} unverified=${s.unverified} settleProvisional=${s.settleProvisionalCount}`);
      if (s.diverged > 0) console.log(`  ⚠️ diverged symbols: ${Object.entries(rawData.contracts).filter(([, c]) => c.lastBarVerification && c.lastBarVerification.status === 'diverged').map(([k]) => k).join(',')}`);
    } catch (err) {
      // 验证层失败不阻塞采集（warn）：快照通道的 date/time 校验仍是底线
      console.warn(`⚠️ cfmmc verification failed (non-blocking): ${err.message}`);
      rawData.meta.cfmmcVerify = { checkedAt: new Date().toISOString(), note: 'fetch_failed: ' + err.message };
    }
  }

  // Log failures
  if (collectionResult.failed.length > 0) {
    const failedPath = path.join(RUN_DIR, 'collection-failures.json');
    fs.writeFileSync(failedPath, JSON.stringify(collectionResult.failed, null, 2));
    console.log(`\n⚠️ ${collectionResult.failed.length} batches failed, logged to collection-failures.json`);
  }

  // 4. Enrich contracts with metadata + derived fields
  const collectedAt = new Date().toISOString();
  const enriched = {};

  for (const [sym, contract] of Object.entries(rawData.contracts)) {
    const meta = symbolMap[sym] || { symbol: sym, name: sym, exchange: 'unknown', sector: 'unknown' };
    const ohlcv = contract.ohlcv;
    const close = ohlcv.close;
    const n = close.length;

    const multiplier = meta.multiplier || 1;

    // Derived: turnover = volume * settle * multiplier (per bar, in 元)
    const turnover = ohlcv.volume.map((v, i) => {
      const s = ohlcv.settle[i] || ohlcv.close[i] || 0;
      return Math.round(v * s * multiplier);
    });

    // Derived: 1d/3d/5d/20d change
    function pctChange(lag) {
      if (n <= lag) return null;
      const prev = close[n - 1 - lag];
      const cur = close[n - 1];
      if (!prev || prev === 0) return null;
      return parseFloat(((cur - prev) / prev * 100).toFixed(2));
    }

    // Derived: average of last N bars
    function avgLast(field, days) {
      const arr = field;
      const slice = arr.slice(Math.max(0, arr.length - days));
      if (slice.length === 0) return null;
      return parseFloat((slice.reduce((a, b) => a + b, 0) / slice.length).toFixed(2));
    }

    enriched[sym] = {
      symbol: sym,
      name: meta.name,
      exchange: meta.exchange,
      sector: meta.sector,
      multiplier: multiplier,
      unit: meta.unit || '',
      status: 'ok',
      fetchedAt: contract.fetchedAt,
      totalBars: contract.totalBars,
      usedBars: contract.usedBars,
      dataStart: contract.dataStart,
      dataEnd: contract.dataEnd,
      lastBarSource: contract.lastBarSource || 'akshare_sina_daily',
      lastBarAsOf: contract.lastBarAsOf || null,
      lastBarNote: contract.lastBarNote || null,
      lastBarVerification: contract.lastBarVerification || null,
      cacheReused: contract.cacheReused === true,
      cacheOriginRunId: contract.cacheOriginRunId || null,
      ohlcv: {
        dates: ohlcv.dates,
        open: ohlcv.open,
        high: ohlcv.high,
        low: ohlcv.low,
        close: ohlcv.close,
        volume: ohlcv.volume,
        turnover: turnover,
        openInterest: ohlcv.open_interest,
        settle: ohlcv.settle
      },
      derived: {
        change1d: pctChange(1),
        change3d: pctChange(3),
        change5d: pctChange(5),
        change20d: pctChange(20),
        avgVolume5d: avgLast(ohlcv.volume, 5),
        avgTurnover5d: avgLast(turnover, 5),
        avgOI5d: avgLast(ohlcv.open_interest, 5),
        close: close[n - 1],
        settle: ohlcv.settle[n - 1]
      }
    };
  }

  // 5. Enrich gaps with metadata
  const gaps = {};
  for (const [sym, gap] of Object.entries(rawData.gaps)) {
    const meta = symbolMap[sym] || {};
    gaps[sym] = {
      symbol: sym,
      name: meta.name || sym,
      exchange: meta.exchange || 'unknown',
      sector: meta.sector || 'unknown',
      status: 'gap',
      reason: gap.reason || 'unknown',
      fetchedAt: collectedAt
    };
  }

  // 6. Write raw.json
  const rawJson = {
    meta: {
      runId,
      collectedAt,
      source: 'akshare',
      sourceVersion: rawData.meta.sourceVersion,
      symbolsScanned: rawData.meta.totalSymbols,
      symbolsSucceeded: rawData.meta.succeeded,
      symbolsFailed: rawData.meta.failed,
      daysPerSymbol: rawData.meta.daysPerSymbol,
      elapsedSeconds: parseFloat(elapsed),
      fullPull: rawData.meta.collectMode !== 'incremental',
      collectMode: rawData.meta.collectMode || 'full',
      cacheInfo: rawData.meta.cacheInfo || null,
      fastClose: rawData.meta.fastClose || { used: false, source: 'sina_close_snapshot', note: 'n/a' },
      cfmmcVerify: rawData.meta.cfmmcVerify || null
    },
    contracts: enriched,
    gaps,
    macroAnchors: {
      _note: 'Macro anchors deferred to Phase 3 macro pass or Top 3 analysis stage',
      collected: false
    }
  };

  const rawJsonPath = path.join(RUN_DIR, 'raw.json');
  fs.writeFileSync(rawJsonPath, JSON.stringify(rawJson, null, 2));
  console.log(`raw.json → ${rawJsonPath}`);

  // 7. Write provenance.json
  const provenance = {
    runId,
    collectedAt,
    pipelineVersion: '0.1.2',
    sources: {
      akshare: {
        version: rawData.meta.sourceVersion,
        status: 'available',
        contractsCollected: rawData.meta.succeeded,
        contractsFailed: rawData.meta.failed,
        elapsedSeconds: parseFloat(elapsed)
      }
    },
    perSymbol: {}
  };

  for (const [sym, c] of Object.entries(enriched)) {
    provenance.perSymbol[sym] = {
      source: 'akshare',
      fetchedAt: c.fetchedAt,
      dataStart: c.dataStart,
      dataEnd: c.dataEnd,
      bars: c.usedBars,
      status: 'ok',
      lastBarSource: c.lastBarSource || 'akshare_sina_daily',
      lastBarAsOf: c.lastBarAsOf || null,
      lastBarVerification: c.lastBarVerification
        ? { status: c.lastBarVerification.status, contract: c.lastBarVerification.contract || null, diffs: c.lastBarVerification.diffs || null, settleProvisional: c.lastBarVerification.settleProvisional || false }
        : null,
      cacheReused: c.cacheReused === true,
      cacheOriginRunId: c.cacheOriginRunId || null
    };
  }
  for (const [sym, g] of Object.entries(gaps)) {
    provenance.perSymbol[sym] = {
      source: 'akshare',
      fetchedAt: g.fetchedAt,
      status: 'gap',
      reason: g.reason
    };
  }

  const provenancePath = path.join(RUN_DIR, 'provenance.json');
  fs.writeFileSync(provenancePath, JSON.stringify(provenance, null, 2));
  console.log(`provenance.json → ${provenancePath}`);

  // 7.5 文件库镜像（v0.1.4）：raw.json 仍是本 run 权威；文件库供增量采集/回测复用。
  // 写入失败不阻断采集（warn-only），下次 run 会自然补齐。
  try {
    const storeResult = dataStore.ingestRunBars({ runId, rawJson, provenance });
    console.log(`data-store: ${storeResult.written} symbols mirrored, ${storeResult.barsChanged} bars changed`);
  } catch (err) {
    console.warn(`⚠️ data-store ingest failed (non-blocking): ${err.message}`);
  }

  // 8. Write raw-snapshot.md (human-readable)
  function fmtTurnover(val) {
    if (val >= 1e12) return (val / 1e12).toFixed(2) + 'T';
    if (val >= 1e8) return (val / 1e8).toFixed(2) + '亿';
    if (val >= 1e4) return (val / 1e4).toFixed(2) + '万';
    return Math.round(val).toLocaleString();
  }

  const sectorGroups = {};
  for (const c of Object.values(enriched)) {
    const s = c.sector || 'unknown';
    if (!sectorGroups[s]) sectorGroups[s] = [];
    sectorGroups[s].push(c);
  }

  const sectorLabels = {
    black: '黑色系', nonferrous: '有色金属', precious: '贵金属',
    energy_chemical: '能化', agriculture: '农产品',
    financial: '金融期货', shipping: '航运', new_materials: '新材料'
  };

  let md = `# Futures Radar — Raw Snapshot\n\n`;
  md += `**Run ID**: ${runId}\n`;
  md += `**Collected**: ${collectedAt}\n`;
  md += `**Source**: akshare ${rawData.meta.sourceVersion}\n`;
  md += `**Collect mode**: ${rawData.meta.collectMode || 'full'}${rawData.meta.cacheInfo
    ? ` (cache run ${rawData.meta.cacheInfo.runId}, reused ${rawData.meta.cacheInfo.reused}, fetched ${rawData.meta.cacheInfo.fetched})`
    : ''}\n`;
  if (rawData.meta.fastClose && rawData.meta.fastClose.used) {
    md += `**Fast-close**: ${rawData.meta.fastClose.appended} 品种当日 bar 来自 sina 收盘快照（日线接口尚未发布，date/time 校验通过，source=${rawData.meta.fastClose.source}）\n`;
  }
  md += `**Summary**: ${rawData.meta.succeeded} OK / ${rawData.meta.failed} gaps / ${rawData.meta.totalSymbols} scanned\n`;
  md += `**Elapsed**: ${elapsed}s\n\n`;

  md += `## 板块概览\n\n`;
  md += `| 板块 | OK | Gap |\n`;
  md += `|------|----|-----|\n`;
  for (const [sector, label] of Object.entries(sectorLabels)) {
    const sectorEnriched = Object.values(enriched).filter(c => c.sector === sector);
    const sectorGaps = Object.values(gaps).filter(g => g.sector === sector);
    if (sectorEnriched.length + sectorGaps.length > 0) {
      md += `| ${label} | ${sectorEnriched.length} | ${sectorGaps.length} |\n`;
    }
  }

  md += `\n## 品种行情\n\n`;
  for (const [sector, label] of Object.entries(sectorLabels)) {
    const sectorEnriched = Object.values(enriched).filter(c => c.sector === sector);
    const sectorGaps = Object.values(gaps).filter(g => g.sector === sector);
    if (sectorEnriched.length + sectorGaps.length === 0) continue;

    md += `### ${label}\n\n`;
    md += `| 品种 | 代码 | 收盘价 | 涨跌(1d) | 涨跌(5d) | 涨跌(20d) | 成交量(5d均) | 成交额(5d均) | 持仓量(5d均) |\n`;
    md += `|------|------|--------|----------|----------|-----------|-------------|-------------|-------------|\n`;

    for (const c of sectorEnriched.sort((a, b) => a.symbol.localeCompare(b.symbol))) {
      const ch1 = c.derived.change1d != null ? `${c.derived.change1d > 0 ? '+' : ''}${c.derived.change1d}%` : '-';
      const ch5 = c.derived.change5d != null ? `${c.derived.change5d > 0 ? '+' : ''}${c.derived.change5d}%` : '-';
      const ch20 = c.derived.change20d != null ? `${c.derived.change20d > 0 ? '+' : ''}${c.derived.change20d}%` : '-';
      const vol = c.derived.avgVolume5d != null ? Math.round(c.derived.avgVolume5d).toLocaleString() : '-';
      const to = c.derived.avgTurnover5d != null ? fmtTurnover(c.derived.avgTurnover5d) : '-';
      const oi = c.derived.avgOI5d != null ? Math.round(c.derived.avgOI5d).toLocaleString() : '-';
      md += `| ${c.name} | ${c.symbol} | ${c.derived.close} | ${ch1} | ${ch5} | ${ch20} | ${vol} | ${to} | ${oi} |\n`;
    }

    for (const g of Object.values(gaps).filter(g => g.sector === sector)) {
      md += `| ${g.name} | ${g.symbol} | ⚠️ GAP | ${g.reason} | - | - | - | - |\n`;
    }

    md += `\n`;
  }

  if (Object.keys(gaps).length > 0) {
    md += `## 采集缺口\n\n`;
    for (const [sym, g] of Object.entries(gaps)) {
      md += `- **${g.name}** (${sym}): ${g.reason}\n`;
    }
    md += `\n`;
  }

  md += `## 宏观锚点\n\n`;
  md += `_宏观锚点由 pipeline Macro 阶段采集，见 ${runId}/macro-snapshot.json。_\n`;

  const snapshotPath = path.join(RUN_DIR, 'raw-snapshot.md');
  fs.writeFileSync(snapshotPath, md);
  console.log(`raw-snapshot.md → ${snapshotPath}`);

  // 9. Summary
  console.log(`\n=== COLLECT COMPLETE ===`);
  console.log(`${rawData.meta.succeeded} OK, ${rawData.meta.failed} gaps, ${elapsed}s`);
  if (rawData.meta.failed > 0) {
    console.log(`Gaps: ${Object.keys(gaps).join(', ')}`);
  }

  process.exit(0);
}

main().catch(err => {
  console.error(`FATAL: ${err.message}`);
  process.exit(1);
});
