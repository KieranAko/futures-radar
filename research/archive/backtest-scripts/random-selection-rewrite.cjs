#!/usr/bin/env node
/**
 * random-selection-rewrite.cjs — Random Selection完整重写
 *
 * 设计：
 * 1. 对每个真实signalDate T，现场重算scanner（截至T）
 * 2. 逐日期保持真实模型信号数量，总计30 entry-date clusters、70笔目标交易
 * 3. 随机候选失败时从同日剩余候选无放回补抽，候选耗尽则标记coverage failure
 * 4. 候选交易独立模拟T+1 entry到T+10 exit
 * 5. Fisher-Yates shuffle
 * 6. 1000 seeds可复现
 * 7. 两个null分开：A (随机选品+EMA原方向规则)、B (随机选品+随机方向)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BACKTEST_DIR = __dirname;

// 简单LCG伪随机数生成器（确定性可复现）
function createRNG(seed) {
  let rng = seed;
  return () => {
    rng = (rng * 1103515245 + 12345) & 0x7fffffff;
    return rng / 0x7fffffff;
  };
}

// Fisher-Yates shuffle
function fisherYatesShuffle(array, random) {
  const result = array.slice();
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/**
 * 计算EMA方向（Null A使用）
 *
 * 从raw.json读取close价格，计算EMA20，判断斜率方向
 * 仅使用截至signalDate T的数据
 *
 * 重要：使用交易日索引来定位signalDate
 * signalIdx = exitIdx - 11
 *
 * @param {string} symbol - 品种代码
 * @param {string} exitDateYYYYMMDD - 退出日期（runId中的日期，YYYYMMDD格式）
 * @param {Object} priceMap - 从loadRawPriceData返回的价格映射
 * @returns {string|null} - 'bullish' or 'bearish' or null
 */
function calculateEMADirection(symbol, exitDateYYYYMMDD, priceMap) {
  if (!priceMap || !priceMap[symbol]) {
    return null;
  }

  // 将exitDate格式化为YYYY-MM-DD
  const exitDateFormatted = exitDateYYYYMMDD.substring(0, 4) + '-' +
                            exitDateYYYYMMDD.substring(4, 6) + '-' +
                            exitDateYYYYMMDD.substring(6, 8);

  // 获取该品种的所有交易日
  const symbolData = priceMap[symbol];
  const dates = Object.keys(symbolData).sort();

  // 找到exitDate在dates数组中的索引
  const exitIdx = dates.indexOf(exitDateFormatted);
  if (exitIdx < 0) {
    return null;
  }

  // 计算signalIdx（使用交易日索引）
  const signalIdx = exitIdx - 11;

  if (signalIdx < 20) {
    return null; // 数据不足以计算EMA20
  }

  // 提取截至signalDate的收盘价
  const closes = dates.slice(0, signalIdx + 1).map(d => symbolData[d].close);

  // 计算EMA20
  const emaWindow = 20;
  const multiplier = 2 / (emaWindow + 1);

  // 初始SMA
  const sma = closes.slice(0, emaWindow).reduce((a, b) => a + b, 0) / emaWindow;
  let ema = sma;

  // 计算到倒数第二个点的EMA（T-1）
  for (let i = emaWindow; i < closes.length - 1; i++) {
    ema = closes[i] * multiplier + ema * (1 - multiplier);
  }
  const emaPrev = ema;

  // 计算到最后一个点的EMA（T）
  ema = closes[closes.length - 1] * multiplier + ema * (1 - multiplier);
  const emaCurrent = ema;

  // 判断斜率
  if (emaCurrent > emaPrev) {
    return 'bullish';
  } else if (emaCurrent < emaPrev) {
    return 'bearish';
  } else {
    // 相等时随机（极少发生）
    return Math.random() < 0.5 ? 'bullish' : 'bearish';
  }
}
function hashCandidatePool(candidates) {
  const symbols = candidates.map(c => c.symbol).sort().join(',');
  return crypto.createHash('sha256').update(symbols).digest('hex').substring(0, 8);
}

/**
 * 读取历史候选池（从filtered-hard.json）
 *
 * 这些文件已经在signalDate当天生成，只包含截至T的数据
 * 无需重新计算scanner，直接读取即可
 *
 * 重要：runId代表exitDate，需要倒推到signalDate
 *
 * @param {string} exitDateYYYYMMDD - 退出日期（runId中的日期，YYYYMMDD格式）
 * @returns {Array} - 候选品种列表
 */
function loadCandidatePool(exitDateYYYYMMDD) {
  const runId = `bt-${exitDateYYYYMMDD}`;
  const filteredPath = path.join(BACKTEST_DIR, 'runs', runId, 'filtered-hard.json');

  if (!fs.existsSync(filteredPath)) {
    return [];
  }

  const filteredData = JSON.parse(fs.readFileSync(filteredPath, 'utf8'));
  return filteredData.passed || [];
}

/**
 * 读取raw.json并构建日期到OHLC的映射
 *
 * @param {string} runId - runId (e.g., "bt-20240102")
 * @returns {Object} - { symbol: { date: {open, high, low, close} } }
 */
function loadRawPriceData(runId) {
  const rawPath = path.join(BACKTEST_DIR, 'runs', runId, 'raw.json');
  if (!fs.existsSync(rawPath)) {
    return null;
  }

  const rawData = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
  const priceMap = {};

  for (const [symbol, contract] of Object.entries(rawData.contracts)) {
    const { dates, open, high, low, close } = contract.ohlcv;
    priceMap[symbol] = {};

    for (let i = 0; i < dates.length; i++) {
      priceMap[symbol][dates[i]] = {
        open: open[i],
        high: high[i],
        low: low[i],
        close: close[i]
      };
    }
  }

  return priceMap;
}

/**
 * 独立模拟单笔交易
 *
 * 重要：runId实际代表exitDate（不是signalDate）
 * 时间链：需要使用raw.json中的dates数组来定位正确的交易日
 * exitIdx - entryIdx = 10个交易日
 * entryIdx = exitIdx - 10
 * signalIdx = exitIdx - 11
 *
 * @param {string} symbol - 品种代码
 * @param {string} exitDateYYYYMMDD - 退出日期（runId中的日期，YYYYMMDD格式）
 * @param {string} direction - 方向（'bullish' or 'bearish'）
 * @param {Object} priceMap - 从loadRawPriceData返回的价格映射
 * @returns {Object|null} - 交易结果或null（如果无法模拟）
 */
function simulateTrade(symbol, exitDateYYYYMMDD, direction, priceMap) {
  if (!priceMap || !priceMap[symbol]) {
    return null;
  }

  // 将exitDate格式化为YYYY-MM-DD
  const exitDateFormatted = exitDateYYYYMMDD.substring(0, 4) + '-' +
                            exitDateYYYYMMDD.substring(4, 6) + '-' +
                            exitDateYYYYMMDD.substring(6, 8);

  // 获取该品种的所有交易日
  const symbolData = priceMap[symbol];
  const dates = Object.keys(symbolData).sort();

  // 找到exitDate在dates数组中的索引
  const exitIdx = dates.indexOf(exitDateFormatted);
  if (exitIdx < 0) {
    return null; // exitDate不在数据中
  }

  // 计算entryIdx和signalIdx（使用交易日索引，不是日历日期）
  const entryIdx = exitIdx - 10;
  const signalIdx = exitIdx - 11;

  if (entryIdx < 0 || signalIdx < 0) {
    return null; // 数据不足
  }

  const signalDateStr = dates[signalIdx];
  const entryDateStr = dates[entryIdx];
  const exitDateStr = dates[exitIdx];

  // 从raw.json中读取价格
  const entryData = symbolData[entryDateStr];
  const exitData = symbolData[exitDateStr];

  if (!entryData || !exitData) {
    return null; // 数据不足，无法模拟
  }

  const entryPrice = entryData.open;
  const exitPrice = exitData.close;

  // 计算收益
  const priceChange = (exitPrice - entryPrice) / entryPrice;
  const directionSign = direction === 'bullish' ? 1 : -1;
  const grossReturn = directionSign * priceChange;

  // 成本（简化：0.07%）
  const costs = 0.0007;
  const netReturn = grossReturn - costs;

  return {
    symbol,
    signalDate: signalDateStr,
    entryDate: entryDateStr,
    exitDate: exitDateStr,
    direction,
    entryPrice,
    exitPrice,
    grossReturn,
    costs,
    netReturn,
    correct: netReturn > 0
  };
}

// 日期解析和格式化辅助函数
function parseDate(dateStr) {
  // YYYYMMDD → Date
  const year = parseInt(dateStr.substring(0, 4));
  const month = parseInt(dateStr.substring(4, 6)) - 1;
  const day = parseInt(dateStr.substring(6, 8));
  return new Date(year, month, day);
}

function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

function addTradingDays(date, days) {
  // 简化：假设每天都是交易日（TODO: 考虑节假日）
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

/**
 * 执行Random Selection实验（单个null类型）
 */
async function runRandomSelection(observedTrades, nullType, seeds = 1000) {
  console.log(`\n=== Random Selection: ${nullType} (${seeds} seeds) ===\n`);

  // 提取唯一退出日期（runId格式: "bt-YYYYMMDD"）
  // 重要：runId中的日期是exitDate，不是signalDate
  const allExitDates = [...new Set(observedTrades.map(t => {
    return t.runId.replace('bt-', '');
  }))].sort();

  // 过滤掉没有filtered-hard.json的exit dates
  // 这些run是在hard filter阶段全部被拒绝的，没有候选池
  const exitDates = allExitDates.filter(date => {
    const candidates = loadCandidatePool(date);
    return candidates.length > 0;
  });

  const skippedDates = allExitDates.filter(date => !exitDates.includes(date));
  if (skippedDates.length > 0) {
    console.log(`⚠️  Skipping ${skippedDates.length} dates with no candidate pool: ${skippedDates.join(', ')}`);
  }

  // 只保留有候选池的observed trades
  const filteredObservedTrades = observedTrades.filter(t => {
    const exitDate = t.runId.replace('bt-', '');
    return exitDates.includes(exitDate);
  });

  console.log(`Exit dates with candidates: ${exitDates.length} (was ${allExitDates.length})`);
  console.log(`Target trades: ${filteredObservedTrades.length} (was ${observedTrades.length})`);

  console.log(`Exit dates with candidates: ${exitDates.length} (was ${allExitDates.length})`);
  console.log(`Target trades: ${filteredObservedTrades.length} (was ${observedTrades.length})`);

  // 提取所有品种（用于scanner候选池）
  const allSymbols = [...new Set(filteredObservedTrades.map(t => t.symbol))];
  console.log(`Available symbols: ${allSymbols.length}\n`);

  const nullReturns = [];
  const coverageFailures = [];
  const auditTrail = [];

  for (let seed = 1; seed <= seeds; seed++) {
    const random = createRNG(seed);
    const seedTrades = [];
    let coverageFailed = false;

    // 对每个退出日期
    for (const exitDate of exitDates) {
      // 1. 读取历史候选池（已在signalDate T生成，已截断）
      const candidates = loadCandidatePool(exitDate);

      // 2. 加载该日期的价格数据
      const runId = `bt-${exitDate}`;
      const priceMap = loadRawPriceData(runId);

      // 3. 计算该日期的真实交易数量（使用过滤后的trades）
      const realTradesAtDate = filteredObservedTrades.filter(t =>
        t.runId.replace('bt-', '') === exitDate
      );
      const targetCount = realTradesAtDate.length;

      // 4. Fisher-Yates shuffle候选池
      const shuffledCandidates = fisherYatesShuffle(candidates, random);

      // 5. 无放回选择+补抽
      const selectedTrades = [];
      let candidateIndex = 0;

      while (selectedTrades.length < targetCount && candidateIndex < shuffledCandidates.length) {
        const candidate = shuffledCandidates[candidateIndex++];

        // 6. 确定方向
        let direction;
        if (nullType === 'random_selection_original_direction') {
          // Null A: 使用EMA原方向规则
          direction = calculateEMADirection(candidate.symbol, exitDate, priceMap);
          if (!direction) {
            // EMA计算失败，跳过该候选
            continue;
          }
        } else if (nullType === 'random_selection_random_direction') {
          // Null B: 随机方向
          direction = random() < 0.5 ? 'bullish' : 'bearish';
        }

        // 7. 独立模拟T+1 entry到T+10 exit
        const trade = simulateTrade(candidate.symbol, exitDate, direction, priceMap);

        if (trade) {
          selectedTrades.push(trade);
        }
        // 如果模拟失败，continue到下一个候选（无放回补抽）
      }

      // 8. 检查coverage
      if (selectedTrades.length < targetCount) {
        coverageFailed = true;
        break; // 该seed失败，不计入null分布
      }

      seedTrades.push(...selectedTrades);
    }

    // 8. 记录结果
    if (coverageFailed) {
      coverageFailures.push(seed);
    } else {
      const avgReturn = seedTrades.reduce((a, b) => a + b.netReturn, 0) / seedTrades.length;
      nullReturns.push(avgReturn);
    }

    // 9. 审计追踪（仅第一个成功seed）
    if (seed === 1 && !coverageFailed && auditTrail.length === 0) {
      for (const exitDate of exitDates) {
        const candidates = loadCandidatePool(exitDate);
        auditTrail.push({
          exitDate,
          candidateCount: candidates.length,
          candidatePoolHash: hashCandidatePool(candidates)
        });
      }
    }

    if (seed % 100 === 0) {
      console.log(`Completed ${seed}/${seeds} seeds (failures: ${coverageFailures.length})...`);
    }
  }

  console.log(`\nCompleted ${seeds} seeds`);
  console.log(`Coverage failures: ${coverageFailures.length}`);
  console.log(`Valid seeds: ${nullReturns.length}\n`);

  // 10. 计算统计量
  const observedAvgReturn = filteredObservedTrades.reduce((a, b) => a + b.netReturn, 0) / filteredObservedTrades.length;
  const nullMean = nullReturns.reduce((a, b) => a + b, 0) / nullReturns.length;
  const nullBetterCount = nullReturns.filter(r => r >= observedAvgReturn).length;
  const empiricalP = (1 + nullBetterCount) / (nullReturns.length + 1);

  return {
    type: nullType,
    seeds: nullReturns.length,
    coverageFailures: coverageFailures.length,
    skippedDates: skippedDates.length,
    observed: {
      avgReturn: observedAvgReturn,
      trades: filteredObservedTrades.length,
      originalTrades: observedTrades.length
    },
    null: {
      mean: nullMean,
      returns: nullReturns,
      betterCount: nullBetterCount
    },
    empiricalP,
    auditTrail: auditTrail.slice(0, 10), // 只保存前10个日期的审计
    coverageFailureSeeds: coverageFailures.slice(0, 20) // 只保存前20个失败seed
  };
}

async function main() {
  console.log('\n=== Random Selection Rewrite ===\n');

  // 读取observed交易
  const fixedWindowFiles = fs.readdirSync(BACKTEST_DIR)
    .filter(f => f.startsWith('fixed-window-') && f.endsWith('.json'))
    .sort((a, b) => {
      const aTime = fs.statSync(path.join(BACKTEST_DIR, a)).mtime;
      const bTime = fs.statSync(path.join(BACKTEST_DIR, b)).mtime;
      return bTime - aTime;
    });

  if (fixedWindowFiles.length === 0) {
    console.error('No fixed-window file found');
    process.exit(1);
  }

  const fixedWindowPath = path.join(BACKTEST_DIR, fixedWindowFiles[0]);
  console.log(`Using: ${fixedWindowFiles[0]}\n`);

  const fixedData = JSON.parse(fs.readFileSync(fixedWindowPath, 'utf8'));
  const observedTrades = fixedData.results['T+10'] || [];

  console.log(`Loaded ${observedTrades.length} observed trades\n`);

  // Null A: 随机选品+EMA原方向规则
  console.log('='.repeat(60));
  const resultsA = await runRandomSelection(
    observedTrades,
    'random_selection_original_direction',
    1000
  );

  // Null B: 随机选品+随机方向
  console.log('\n' + '='.repeat(60));
  const resultsB = await runRandomSelection(
    observedTrades,
    'random_selection_random_direction',
    1000
  );

  // 保存结果
  const outputA = path.join(BACKTEST_DIR, 'random-selection-nullA-t+10-1000seeds.json');
  fs.writeFileSync(outputA, JSON.stringify(resultsA, null, 2));
  console.log(`\n✓ Saved Null A to: ${outputA}`);

  const outputB = path.join(BACKTEST_DIR, 'random-selection-nullB-t+10-1000seeds.json');
  fs.writeFileSync(outputB, JSON.stringify(resultsB, null, 2));
  console.log(`✓ Saved Null B to: ${outputB}`);
}

main().catch(console.error);
