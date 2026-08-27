#!/usr/bin/env node
/**
 * time-sampler.cjs — 时间轴采样器
 *
 * 功能：
 * - 从历史缓存提取交易日列表
 * - 支持三种采样模式：uniform（均匀）、random（随机）、monthly（月度）
 *
 * Usage:
 *   const { generateSamplePoints } = require('./time-sampler.cjs');
 *   const samples = generateSamplePoints({
 *     startDate: '2019-01-01',
 *     endDate: '2026-07-31',
 *     sampleCount: 50,
 *     mode: 'random'
 *   });
 */

const fs = require('fs');
const path = require('path');

const CACHE_PATH = path.join(__dirname, 'data', 'historical-cache.json');

/**
 * 从缓存中提取交易日列表
 * @param {string} startDate - 起始日期 (YYYY-MM-DD)
 * @param {string} endDate - 结束日期 (YYYY-MM-DD)
 * @returns {string[]} 交易日数组
 */
function getTradingDaysFromCache(startDate, endDate, cache = null) {
  let cacheData = cache;
  if (!cacheData) {
    if (!fs.existsSync(CACHE_PATH)) {
      throw new Error(`Cache not found: ${CACHE_PATH}. Run full-history-collector first.`);
    }
    cacheData = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
  }

  // 从第一个品种提取日期列表（所有品种应该共享相同的交易日历）
  const firstSymbol = Object.keys(cacheData.contracts)[0];
  if (!firstSymbol) {
    throw new Error('Cache contains no contracts');
  }

  const allDates = cacheData.contracts[firstSymbol].ohlcv.dates;

  // 过滤日期区间
  const filtered = allDates.filter(d => d >= startDate && d <= endDate);

  if (filtered.length === 0) {
    throw new Error(`No trading days found between ${startDate} and ${endDate}`);
  }

  return filtered;
}

/**
 * Fisher-Yates 洗牌算法
 */
function shuffleArray(array) {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

/**
 * 生成采样时间点
 * @param {Object} config
 * @param {string} config.startDate - 起始日期
 * @param {string} config.endDate - 结束日期
 * @param {number} config.sampleCount - 采样数量
 * @param {string} config.mode - 采样模式: 'uniform' | 'random' | 'monthly'
 * @param {number} [config.randomSeed] - 随机种子（可选，用于复现）
 * @returns {string[]} 采样时间点数组
 */
function generateSamplePoints(config) {
  const { startDate, endDate, sampleCount, mode, randomSeed } = config;

  // Get all trading days in range
  const allDays = getTradingDaysFromCache(startDate, endDate);

  console.log(`Total trading days in range: ${allDays.length}`);

  switch (mode) {
    case 'uniform':
      return sampleUniform(allDays, sampleCount);

    case 'random':
      return sampleRandom(allDays, sampleCount, randomSeed);

    case 'monthly':
      return sampleMonthly(allDays);

    default:
      throw new Error(`Unknown sampling mode: ${mode}. Use 'uniform', 'random', or 'monthly'.`);
  }
}

/**
 * 均匀采样
 */
function sampleUniform(allDays, sampleCount) {
  if (sampleCount >= allDays.length) {
    console.warn(`Sample count (${sampleCount}) >= total days (${allDays.length}), returning all days`);
    return allDays;
  }

  const step = Math.floor(allDays.length / sampleCount);
  const samples = [];

  for (let i = 0; i < allDays.length && samples.length < sampleCount; i += step) {
    samples.push(allDays[i]);
  }

  return samples;
}

/**
 * 随机采样
 */
function sampleRandom(allDays, sampleCount, seed) {
  if (sampleCount >= allDays.length) {
    console.warn(`Sample count (${sampleCount}) >= total days (${allDays.length}), returning all days`);
    return allDays;
  }

  // 设置随机种子（如果提供）
  if (seed !== undefined) {
    // 简单的伪随机种子（生产环境应使用更robust的seedrandom库）
    Math.seedrandom = (s) => {
      let state = s;
      return function() {
        state = (state * 9301 + 49297) % 233280;
        return state / 233280;
      };
    };
    const oldRandom = Math.random;
    Math.random = Math.seedrandom(seed);
    const shuffled = shuffleArray(allDays);
    Math.random = oldRandom;
    return shuffled.slice(0, sampleCount);
  }

  // 无种子：真随机
  return shuffleArray(allDays).slice(0, sampleCount);
}

/**
 * 月度采样（每月第一个交易日）
 */
function sampleMonthly(allDays) {
  const samples = [];
  let prevMonth = null;

  for (const day of allDays) {
    const date = new Date(day);
    const currMonth = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

    if (currMonth !== prevMonth) {
      samples.push(day);
      prevMonth = currMonth;
    }
  }

  return samples;
}

// ── CLI ──────────────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help')) {
    console.log('Usage: node time-sampler.cjs --start YYYY-MM-DD --end YYYY-MM-DD --count N --mode MODE');
    console.log('');
    console.log('Options:');
    console.log('  --start DATE    Start date (default: 2019-01-01)');
    console.log('  --end DATE      End date (default: today)');
    console.log('  --count N       Sample count (default: 30)');
    console.log('  --mode MODE     Sampling mode: uniform | random | monthly (default: uniform)');
    console.log('  --seed N        Random seed for reproducibility (random mode only)');
    process.exit(0);
  }

  const getArg = (flag, defaultVal) => {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : defaultVal;
  };

  const startDate = getArg('--start', '2019-01-01');
  const endDate = getArg('--end', new Date().toISOString().split('T')[0]);
  const sampleCount = parseInt(getArg('--count', '30'), 10);
  const mode = getArg('--mode', 'uniform');
  const seed = args.includes('--seed') ? parseInt(getArg('--seed', '42'), 10) : undefined;

  try {
    const samples = generateSamplePoints({ startDate, endDate, sampleCount, mode, randomSeed: seed });

    console.log(`\nGenerated ${samples.length} sample points (${mode} mode):`);
    console.log(samples.join('\n'));
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  }
}

module.exports = { generateSamplePoints, getTradingDaysFromCache };
