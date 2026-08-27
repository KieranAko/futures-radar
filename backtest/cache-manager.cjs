#!/usr/bin/env node
/**
 * cache-manager.cjs — 缓存管理工具
 *
 * 功能：
 * - 检查缓存状态（是否存在、是否过期）
 * - 更新缓存（增量补齐最新数据）
 * - 清理缓存
 *
 * Usage:
 *   node backtest/cache-manager.cjs --check
 *   node backtest/cache-manager.cjs --update
 *   node backtest/cache-manager.cjs --clean
 */

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

// ── Paths ────────────────────────────────────────────────────
const BACKTEST_DIR = __dirname;
const DATA_DIR = path.join(BACKTEST_DIR, 'data');
const CACHE_PATH = path.join(DATA_DIR, 'historical-cache.json');
const META_PATH = path.join(DATA_DIR, 'cache-meta.json');

// ── Commands ─────────────────────────────────────────────────
const args = process.argv.slice(2);
const command = args[0];

async function checkCache() {
  console.log('=== Cache Status ===\n');

  // Check if cache exists
  if (!fs.existsSync(CACHE_PATH)) {
    console.log('❌ Cache not found');
    console.log(`   Expected: ${CACHE_PATH}`);
    console.log('\n💡 Run: node backtest/full-history-collector.cjs');
    return { exists: false };
  }

  console.log('✅ Cache exists');

  // Read metadata
  if (!fs.existsSync(META_PATH)) {
    console.log('⚠️  Metadata not found, reading cache directly...');
    const cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    const stats = fs.statSync(CACHE_PATH);

    console.log(`   Symbols: ${Object.keys(cache.contracts).length}`);
    console.log(`   Date range: ${cache.meta.dateRange.earliest} to ${cache.meta.dateRange.latest}`);
    console.log(`   Size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
    console.log(`   Last modified: ${stats.mtime.toISOString()}`);

    return { exists: true, hasMetadata: false };
  }

  const meta = JSON.parse(fs.readFileSync(META_PATH, 'utf8'));
  const stats = fs.statSync(CACHE_PATH);

  console.log(`   Symbols: ${meta.totalSymbols}`);
  console.log(`   Date range: ${meta.dateRange.earliest} to ${meta.dateRange.latest}`);
  console.log(`   Size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
  console.log(`   Created: ${meta.createdAt}`);
  console.log(`   Last updated: ${meta.lastUpdatedAt}`);

  // Check if stale (>7 days)
  const lastUpdate = new Date(meta.lastUpdatedAt);
  const now = new Date();
  const daysSinceUpdate = (now - lastUpdate) / (1000 * 60 * 60 * 24);

  if (daysSinceUpdate > 7) {
    console.log(`\n⚠️  Cache is stale (${daysSinceUpdate.toFixed(1)} days old)`);
    console.log('   Consider running: node backtest/cache-manager.cjs --update');
  } else {
    console.log(`\n✅ Cache is fresh (${daysSinceUpdate.toFixed(1)} days old)`);
  }

  return { exists: true, hasMetadata: true, daysSinceUpdate };
}

async function updateCache() {
  console.log('=== Update Cache ===\n');

  // Check if cache exists
  if (!fs.existsSync(CACHE_PATH)) {
    console.log('❌ Cache not found, cannot update');
    console.log('   Run full collection first: node backtest/full-history-collector.cjs');
    process.exit(1);
  }

  console.log('Reading existing cache...');
  const cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
  const latestDate = cache.meta.dateRange.latest;

  console.log(`Current latest date: ${latestDate}`);
  console.log('\n⚠️  Incremental update not yet implemented');
  console.log('   For now, run full collection to refresh cache:');
  console.log('   node backtest/full-history-collector.cjs');

  // TODO: Implement incremental update
  // - Read symbols.json
  // - For each symbol, fetch data after latestDate
  // - Append to existing cache
  // - Update metadata
}

async function cleanCache() {
  console.log('=== Clean Cache ===\n');

  if (!fs.existsSync(CACHE_PATH) && !fs.existsSync(META_PATH)) {
    console.log('✅ Cache already clean (no files to remove)');
    return;
  }

  let removed = [];

  if (fs.existsSync(CACHE_PATH)) {
    fs.unlinkSync(CACHE_PATH);
    removed.push('historical-cache.json');
    console.log('🗑️  Removed: historical-cache.json');
  }

  if (fs.existsSync(META_PATH)) {
    fs.unlinkSync(META_PATH);
    removed.push('cache-meta.json');
    console.log('🗑️  Removed: cache-meta.json');
  }

  const failuresPath = path.join(DATA_DIR, 'collection-failures.json');
  if (fs.existsSync(failuresPath)) {
    fs.unlinkSync(failuresPath);
    removed.push('collection-failures.json');
    console.log('🗑️  Removed: collection-failures.json');
  }

  console.log(`\n✅ Cleaned ${removed.length} file(s)`);
}

// ── Main ─────────────────────────────────────────────────────
async function main() {
  if (!command || command === '--help' || command === '-h') {
    console.log('Usage:');
    console.log('  node backtest/cache-manager.cjs --check   # Check cache status');
    console.log('  node backtest/cache-manager.cjs --update  # Update cache (incremental)');
    console.log('  node backtest/cache-manager.cjs --clean   # Remove cache files');
    process.exit(0);
  }

  switch (command) {
    case '--check':
    case '-c':
      await checkCache();
      break;

    case '--update':
    case '-u':
      await updateCache();
      break;

    case '--clean':
      await cleanCache();
      break;

    default:
      console.error(`Unknown command: ${command}`);
      console.error('Run with --help for usage');
      process.exit(1);
  }
}

main().catch(err => {
  console.error(`FATAL: ${err.message}`);
  process.exit(1);
});
