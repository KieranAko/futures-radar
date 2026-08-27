#!/usr/bin/env node
/**
 * cache-slicer.cjs — 缓存窗口切片器
 *
 * 功能：
 * - 从历史缓存中切片指定时间点的N天窗口数据
 * - 严格防止未来函数（只返回T及之前的数据）
 *
 * Usage:
 *   const { sliceWindow, sliceAllSymbols } = require('./cache-slicer.cjs');
 *   const window = sliceWindow('SC0', '2026-07-01', 60);
 */

const fs = require('fs');
const path = require('path');

const CACHE_PATH = path.join(__dirname, 'data', 'historical-cache.json');

// 缓存加载（单例模式）
let _cache = null;

function loadCache() {
  if (_cache) return _cache;

  if (!fs.existsSync(CACHE_PATH)) {
    throw new Error(`Cache not found: ${CACHE_PATH}. Run full-history-collector first.`);
  }

  _cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
  return _cache;
}

/**
 * 切片单个品种的窗口数据
 * @param {string} symbol - 品种代码 (e.g., 'SC0')
 * @param {string} asOfDate - 时间点T (YYYY-MM-DD)
 * @param {number} windowDays - 窗口天数（向前切）
 * @returns {Object} 窗口数据
 */
function sliceWindow(symbol, asOfDate, windowDays = 60, cache = null) {
  const cacheData = cache ?? loadCache();
  const contract = cacheData.contracts[symbol];

  if (!contract) {
    throw new Error(`Symbol ${symbol} not found in cache`);
  }

  const dates = contract.ohlcv.dates;

  // 找到T点索引
  const asOfIdx = dates.findIndex(d => d === asOfDate);

  if (asOfIdx === -1) {
    throw new Error(`Date ${asOfDate} not found for ${symbol}. Available range: ${dates[0]} to ${dates[dates.length - 1]}`);
  }

  // 向前切windowDays天（包含T点）
  const startIdx = Math.max(0, asOfIdx - windowDays + 1);
  const endIdx = asOfIdx + 1; // 不包含T+1

  // 防止未来函数检查
  if (endIdx > asOfIdx + 1) {
    throw new Error('CRITICAL: Future function detected - attempting to slice data after asOfDate');
  }

  return {
    symbol,
    name: contract.name || symbol,
    exchange: contract.exchange || 'unknown',
    sector: contract.sector || 'unknown',
    multiplier: contract.multiplier || 1,
    unit: contract.unit || '',
    asOfDate,
    windowDays: endIdx - startIdx,
    dataStart: dates[startIdx],
    dataEnd: dates[asOfIdx],
    ohlcv: {
      dates: dates.slice(startIdx, endIdx),
      open: contract.ohlcv.open.slice(startIdx, endIdx),
      high: contract.ohlcv.high.slice(startIdx, endIdx),
      low: contract.ohlcv.low.slice(startIdx, endIdx),
      close: contract.ohlcv.close.slice(startIdx, endIdx),
      volume: contract.ohlcv.volume.slice(startIdx, endIdx),
      openInterest: (contract.ohlcv.openInterest || contract.ohlcv.open_interest).slice(startIdx, endIdx),
      settle: contract.ohlcv.settle ? contract.ohlcv.settle.slice(startIdx, endIdx) : null
    }
  };
}

/**
 * 切片所有品种的窗口数据
 * @param {string} asOfDate - 时间点T
 * @param {number} windowDays - 窗口天数
 * @returns {Object} 所有品种的窗口数据
 */
function sliceAllSymbols(asOfDate, windowDays = 60) {
  const cache = loadCache();
  const symbols = Object.keys(cache.contracts);

  console.log(`Slicing ${symbols.length} symbols at ${asOfDate} (window: ${windowDays} days)...`);

  const windowData = {
    meta: {
      asOfDate,
      windowDays,
      symbolCount: symbols.length,
      slicedAt: new Date().toISOString()
    },
    contracts: {}
  };

  let successCount = 0;
  let failCount = 0;

  for (const symbol of symbols) {
    try {
      windowData.contracts[symbol] = sliceWindow(symbol, asOfDate, windowDays);
      successCount++;
    } catch (err) {
      console.warn(`  ⚠️ ${symbol}: ${err.message}`);
      failCount++;
    }
  }

  console.log(`  ✅ Success: ${successCount}, ❌ Failed: ${failCount}`);

  windowData.meta.succeeded = successCount;
  windowData.meta.failed = failCount;

  return windowData;
}

/**
 * 获取验证窗口数据（T+1 到 T+K）
 * 用于回测验证阶段
 * @param {string} symbol - 品种代码
 * @param {string} asOfDate - 时间点T
 * @param {number} verifyDays - 验证天数K
 * @returns {Object} 验证窗口数据
 */
function getVerifyWindow(symbol, asOfDate, verifyDays = 3, cache = null) {
  const cacheData = cache ?? loadCache();
  const contract = cacheData.contracts[symbol];

  if (!contract) {
    throw new Error(`Symbol ${symbol} not found in cache`);
  }

  const dates = contract.ohlcv.dates;
  const closes = contract.ohlcv.close;
  const opens = contract.ohlcv.open;

  // 找到T点索引
  const tIdx = dates.findIndex(d => d === asOfDate);

  if (tIdx === -1) {
    throw new Error(`Date ${asOfDate} not found for ${symbol}`);
  }

  // 找到T+K点索引
  const tkIdx = tIdx + verifyDays;

  if (tkIdx >= dates.length) {
    return null; // 验证窗口超出缓存范围
  }

  return {
    symbol,
    t_date: dates[tIdx],
    t_close: closes[tIdx],
    t1_open: opens[tIdx + 1],
    tk_date: dates[tkIdx],
    tk_close: closes[tkIdx],
    change_pct: ((closes[tkIdx] - closes[tIdx]) / closes[tIdx] * 100).toFixed(2),
    price_path: closes.slice(tIdx, tkIdx + 1)
  };
}

// ── CLI ──────────────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help')) {
    console.log('Usage: node cache-slicer.cjs --symbol SYM --date YYYY-MM-DD [--window N]');
    console.log('       node cache-slicer.cjs --all --date YYYY-MM-DD [--window N]');
    console.log('');
    console.log('Options:');
    console.log('  --symbol SYM    Symbol code (e.g., SC0)');
    console.log('  --all           Slice all symbols');
    console.log('  --date DATE     As-of date (T point)');
    console.log('  --window N      Window days (default: 60)');
    process.exit(0);
  }

  const getArg = (flag, defaultVal) => {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : defaultVal;
  };

  const symbol = getArg('--symbol', null);
  const all = args.includes('--all');
  const asOfDate = getArg('--date', null);
  const windowDays = parseInt(getArg('--window', '60'), 10);

  if (!asOfDate) {
    console.error('ERROR: --date is required');
    process.exit(1);
  }

  try {
    if (all) {
      const windowData = sliceAllSymbols(asOfDate, windowDays);
      console.log('\nWindow data summary:');
      console.log(`  As-of date: ${windowData.meta.asOfDate}`);
      console.log(`  Symbols: ${windowData.meta.succeeded} succeeded, ${windowData.meta.failed} failed`);
      console.log(`  Window: ${windowData.meta.windowDays} days`);
    } else if (symbol) {
      const window = sliceWindow(symbol, asOfDate, windowDays);
      console.log('\nWindow data:');
      console.log(JSON.stringify(window, null, 2));
    } else {
      console.error('ERROR: Either --symbol or --all is required');
      process.exit(1);
    }
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  }
}

module.exports = { sliceWindow, sliceAllSymbols, getVerifyWindow, loadCache };
