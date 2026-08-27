#!/usr/bin/env node
/**
 * full-history-collector.cjs — 全量历史数据采集器
 *
 * 功能：
 * - 采集 symbols.json 所有活跃品种的完整历史数据
 * - 复用主管道的 parallel-collector 多线程架构
 * - 输出到 backtest/data/historical-cache.json
 *
 * Usage:
 *   node backtest/full-history-collector.cjs
 */

const fs = require('fs');
const path = require('path');
const { ParallelCollector } = require('../../collector/parallel-collector.cjs');
const dataStore = require('../../data-store/index.cjs');

// ── Paths ────────────────────────────────────────────────────
const SKILL_ROOT = path.join(__dirname, '../..');
const BACKTEST_DIR = __dirname;
const DATA_DIR = path.join(BACKTEST_DIR, 'data');
const SYMBOLS_PATH = path.join(SKILL_ROOT, 'config', 'symbols.json');
const PYTHON_SCRIPT = path.join(SKILL_ROOT, 'collector', 'futures_collector.py');
const CACHE_PATH = path.join(DATA_DIR, 'historical-cache.json');
const META_PATH = path.join(DATA_DIR, 'cache-meta.json');

// ── Main ─────────────────────────────────────────────────────
async function main() {
  console.log('=== Full History Collector ===');
  console.log(`Target: ${CACHE_PATH}\n`);

  // 1. Ensure data directory exists
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  // 2. Read symbol whitelist
  if (!fs.existsSync(SYMBOLS_PATH)) {
    console.error(`ERROR: symbols.json not found: ${SYMBOLS_PATH}`);
    process.exit(1);
  }

  const symbolsConfig = JSON.parse(fs.readFileSync(SYMBOLS_PATH, 'utf8'));
  const activeSymbols = symbolsConfig.symbols.filter(s => s.active);

  console.log(`Active symbols: ${activeSymbols.length}/${symbolsConfig.symbols.length}`);

  // 3. Run parallel collection with days=-1 (full history)
  console.log('\nStarting parallel collection (full history)...');
  const t0 = Date.now();

  const collector = new ParallelCollector(
    activeSymbols.map(s => s.symbol),
    {
      maxWorkers: 4,
      batchSize: 5,
      days: -1,  // Full history mode
      timeout: 300000, // 5 minutes per batch (full data is larger)
      maxRetries: 3,
      pythonScript: PYTHON_SCRIPT,
      tempDir: DATA_DIR
    }
  );

  const collectionResult = await collector.run();
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  // 4. Check collection success
  if (collectionResult.success.length === 0) {
    console.error('\nERROR: All batches failed, no data collected');
    process.exit(1);
  }

  console.log(`\nCollection complete: ${elapsed}s`);
  console.log(`Success: ${collectionResult.success.length} batches`);
  console.log(`Failed: ${collectionResult.failed.length} batches`);

  // 5. Merge results into cache structure
  const cache = {
    meta: {
      collectedAt: new Date().toISOString(),
      source: 'akshare',
      sourceVersion: null,
      totalSymbols: 0,
      succeeded: 0,
      failed: 0,
      dateRange: {
        earliest: null,
        latest: null
      }
    },
    contracts: {}
  };

  // Merge successful batches
  for (const batchResult of collectionResult.success) {
    if (!cache.meta.sourceVersion && batchResult.data.meta) {
      cache.meta.sourceVersion = batchResult.data.meta.sourceVersion;
    }
    Object.assign(cache.contracts, batchResult.data.contracts || {});
  }

  cache.meta.totalSymbols = activeSymbols.length;
  cache.meta.succeeded = Object.keys(cache.contracts).length;
  cache.meta.failed = collectionResult.failed.length;

  // 6. Calculate date range
  let earliestDate = null;
  let latestDate = null;

  for (const contract of Object.values(cache.contracts)) {
    const dates = contract.ohlcv.dates;
    if (dates.length === 0) continue;

    const first = dates[0];
    const last = dates[dates.length - 1];

    if (!earliestDate || first < earliestDate) earliestDate = first;
    if (!latestDate || last > latestDate) latestDate = last;
  }

  cache.meta.dateRange.earliest = earliestDate;
  cache.meta.dateRange.latest = latestDate;

  // 7. Write cache file
  console.log('\nWriting cache...');
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));

  const cacheSize = (fs.statSync(CACHE_PATH).size / 1024 / 1024).toFixed(2);
  console.log(`Cache written: ${CACHE_PATH} (${cacheSize} MB)`);

  // 7.5 写入 data-store 文件库：后续回测切片统一从 data/daily 读取，
  // historical-cache.json 仅保留为兼容导出。
  try {
    const storeResult = dataStore.ingestRunBars({
      runId: `bt-full-${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}`,
      rawJson: cache,
      provenance: null
    });
    console.log(`data-store: ${storeResult.written} symbols mirrored, ${storeResult.barsChanged} bars changed`);
    dataStore.exportHistoricalCache();
  } catch (err) {
    console.warn(`⚠️ data-store ingest failed (non-blocking): ${err.message}`);
  }

  // 8. Write metadata file
  const meta = {
    cacheFile: 'historical-cache.json',
    createdAt: cache.meta.collectedAt,
    lastUpdatedAt: cache.meta.collectedAt,
    totalSymbols: cache.meta.succeeded,
    dateRange: cache.meta.dateRange,
    elapsedSeconds: parseFloat(elapsed),
    version: '0.1.0'
  };

  fs.writeFileSync(META_PATH, JSON.stringify(meta, null, 2));
  console.log(`Metadata written: ${META_PATH}`);

  // 9. Log failures if any
  if (collectionResult.failed.length > 0) {
    const failuresPath = path.join(DATA_DIR, 'collection-failures.json');
    fs.writeFileSync(failuresPath, JSON.stringify(collectionResult.failed, null, 2));
    console.log(`\n⚠️ ${collectionResult.failed.length} batches failed, logged to collection-failures.json`);
  }

  // 10. Summary
  console.log('\n=== COLLECTION SUMMARY ===');
  console.log(`Total symbols: ${cache.meta.totalSymbols}`);
  console.log(`Succeeded: ${cache.meta.succeeded}`);
  console.log(`Failed: ${cache.meta.failed}`);
  console.log(`Date range: ${earliestDate} to ${latestDate}`);
  console.log(`Cache size: ${cacheSize} MB`);
  console.log(`Elapsed: ${elapsed}s`);

  process.exit(0);
}

main().catch(err => {
  console.error(`FATAL: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
