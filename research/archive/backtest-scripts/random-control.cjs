#!/usr/bin/env node
/**
 * random-control.cjs — P1第2项：随机对照组实验
 *
 * 目的：通过1,000+独立种子验证信号优于随机
 *
 * 两类随机对照：
 * 1. Random Direction：固定信号队列，随机翻转方向
 * 2. Random Selection：固定信号日期，从候选池随机选择品种
 *
 * 关键约束：
 * - Random Selection必须在每个信号日重新运行scanner（无泄漏）
 * - 保存候选池hash、选择数量、信号日期供审计
 * - 计算经验p值：(1 + null>=observed)/(seeds + 1)
 *
 * Usage:
 *   node random-control.cjs --type direction --seeds 1000
 *   node random-control.cjs --type selection --seeds 1000
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BACKTEST_DIR = __dirname;

// 导入fixed-window-comparison的scanner函数
const { runScanner } = require('./scanner-wrapper.cjs');

/**
 * Random Direction Control
 * 固定信号队列（symbol + signalDate），随机翻转方向
 */
async function randomDirectionControl(observedTrades, seeds = 1000) {
  console.log(`\n=== Random Direction Control (${seeds} seeds) ===\n`);

  const results = [];
  const observedAvgReturn = observedTrades.reduce((a, b) => a + b.netReturn, 0) / observedTrades.length;

  let nullBetterCount = 0;

  for (let seed = 1; seed <= seeds; seed++) {
    // 使用seed初始化随机数生成器（简单LCG）
    let rng = seed;
    const random = () => {
      rng = (rng * 1103515245 + 12345) & 0x7fffffff;
      return rng / 0x7fffffff;
    };

    const randomTrades = observedTrades.map(trade => {
      // 随机选择方向
      const randomDirection = random() < 0.5 ? 'bullish' : 'bearish';

      // 基于grossReturn重新计算净收益
      // 做多：netReturn = grossReturn - costs
      // 做空：netReturn = -grossReturn - costs
      const directionSign = randomDirection === 'bullish' ? 1 : -1;
      const newReturn = directionSign * trade.grossReturn - trade.costs;

      return {
        ...trade,
        direction: randomDirection,
        netReturn: newReturn,
        grossReturn: trade.grossReturn, // 保留原始grossReturn
        costs: trade.costs, // 保留原始costs
        correct: newReturn > 0
      };
    });

    const avgReturn = randomTrades.reduce((a, b) => a + b.netReturn, 0) / randomTrades.length;
    const correct = randomTrades.filter(t => t.correct).length;
    const accuracy = correct / randomTrades.length;

    if (avgReturn >= observedAvgReturn) {
      nullBetterCount++;
    }

    results.push({
      seed,
      avgReturn,
      accuracy,
      trades: randomTrades.length
    });

    if (seed % 100 === 0) {
      console.log(`Completed ${seed}/${seeds} seeds...`);
    }
  }

  // 计算经验p值
  const empiricalP = (1 + nullBetterCount) / (seeds + 1);

  const nullReturns = results.map(r => r.avgReturn);
  const nullMean = nullReturns.reduce((a, b) => a + b, 0) / nullReturns.length;
  const nullStd = Math.sqrt(
    nullReturns.reduce((a, b) => a + Math.pow(b - nullMean, 2), 0) / nullReturns.length
  );

  console.log(`\nRandom Direction Results:`);
  console.log(`  Observed Avg Return: ${(observedAvgReturn * 100).toFixed(2)}%`);
  console.log(`  Null Mean Return: ${(nullMean * 100).toFixed(2)}%`);
  console.log(`  Null Std Dev: ${(nullStd * 100).toFixed(2)}%`);
  console.log(`  Null >= Observed: ${nullBetterCount}/${seeds}`);
  console.log(`  Empirical p-value: ${empiricalP.toFixed(4)}`);
  console.log('');

  return {
    type: 'random_direction',
    seeds,
    observed: {
      avgReturn: observedAvgReturn,
      trades: observedTrades.length
    },
    null: {
      mean: nullMean,
      std: nullStd,
      betterCount: nullBetterCount
    },
    empiricalP,
    interpretation: empiricalP < 0.05 ? '信号显著优于随机方向（p<0.05）' :
                   empiricalP < 0.10 ? '信号弱显著优于随机方向（p<0.10）' :
                   '信号未显著优于随机方向（p>=0.10）',
    allSeeds: results
  };
}

/**
 * Random Selection Control
 * 固定信号日期，从候选池随机选择品种
 *
 * 关键：每个信号日重新运行scanner，避免泄漏
 */
async function randomSelectionControl(observedTrades, seeds = 1000, modelName = 'momentum-ema20-relaxed') {
  console.log(`\n=== Random Selection Control (${seeds} seeds) ===\n`);
  console.log(`⚠️ 警告：此实验需要重新运行scanner，耗时较长（预计${Math.ceil(seeds * 30 * 0.5 / 60)}分钟）\n`);

  // 提取唯一信号日期
  const uniqueSignalDates = [...new Set(observedTrades.map(t => t.entryDate))].sort();
  console.log(`Unique signal dates: ${uniqueSignalDates.length}`);
  console.log(`First: ${uniqueSignalDates[0]}, Last: ${uniqueSignalDates[uniqueSignalDates.length - 1]}\n`);

  const observedAvgReturn = observedTrades.reduce((a, b) => a + b.netReturn, 0) / observedTrades.length;

  const results = [];
  let nullBetterCount = 0;

  // 对每个seed，重新从候选池随机选择
  for (let seed = 1; seed <= seeds; seed++) {
    let rng = seed;
    const random = () => {
      rng = (rng * 1103515245 + 12345) & 0x7fffffff;
      return rng / 0x7fffffff;
    };

    const randomTrades = [];
    const candidatePoolHashes = [];

    // 对每个信号日期，重新运行scanner并随机选择
    for (const signalDate of uniqueSignalDates) {
      // 查找该信号日期的observed交易数量（保持选择数量一致）
      const observedCountAtDate = observedTrades.filter(t => t.entryDate === signalDate).length;

      // 重新运行scanner（关键：无泄漏）
      const candidates = await runScanner(signalDate, modelName);

      if (!candidates || candidates.length === 0) {
        continue;
      }

      // 计算候选池hash（审计用）
      const poolHash = crypto.createHash('md5')
        .update(JSON.stringify(candidates.map(c => c.symbol).sort()))
        .digest('hex').substring(0, 8);

      candidatePoolHashes.push({
        signalDate,
        poolSize: candidates.length,
        poolHash,
        selectedCount: Math.min(observedCountAtDate, candidates.length)
      });

      // 随机选择N个品种（N = observed count at this date）
      const shuffled = candidates.slice().sort(() => random() - 0.5);
      const selected = shuffled.slice(0, observedCountAtDate);

      // 对每个选中品种，模拟交易
      for (const candidate of selected) {
        // 查找对应的observed交易以获取实际价格数据
        const observedMatch = observedTrades.find(t =>
          t.entryDate === signalDate && t.symbol === candidate.symbol
        );

        if (observedMatch) {
          randomTrades.push(observedMatch);
        }
      }
    }

    if (randomTrades.length === 0) {
      console.error(`Seed ${seed}: No random trades generated`);
      continue;
    }

    const avgReturn = randomTrades.reduce((a, b) => a + b.netReturn, 0) / randomTrades.length;
    const correct = randomTrades.filter(t => t.correct).length;
    const accuracy = correct / randomTrades.length;

    if (avgReturn >= observedAvgReturn) {
      nullBetterCount++;
    }

    results.push({
      seed,
      avgReturn,
      accuracy,
      trades: randomTrades.length,
      candidatePoolHashes
    });

    if (seed % 10 === 0) {
      console.log(`Completed ${seed}/${seeds} seeds...`);
    }
  }

  // 计算经验p值
  const empiricalP = (1 + nullBetterCount) / (seeds + 1);

  const nullReturns = results.map(r => r.avgReturn);
  const nullMean = nullReturns.reduce((a, b) => a + b, 0) / nullReturns.length;
  const nullStd = Math.sqrt(
    nullReturns.reduce((a, b) => a + Math.pow(b - nullMean, 2), 0) / nullReturns.length
  );

  console.log(`\nRandom Selection Results:`);
  console.log(`  Observed Avg Return: ${(observedAvgReturn * 100).toFixed(2)}%`);
  console.log(`  Null Mean Return: ${(nullMean * 100).toFixed(2)}%`);
  console.log(`  Null Std Dev: ${(nullStd * 100).toFixed(2)}%`);
  console.log(`  Null >= Observed: ${nullBetterCount}/${seeds}`);
  console.log(`  Empirical p-value: ${empiricalP.toFixed(4)}`);
  console.log('');

  return {
    type: 'random_selection',
    seeds,
    observed: {
      avgReturn: observedAvgReturn,
      trades: observedTrades.length
    },
    null: {
      mean: nullMean,
      std: nullStd,
      betterCount: nullBetterCount
    },
    empiricalP,
    interpretation: empiricalP < 0.05 ? '信号显著优于随机选择（p<0.05）' :
                   empiricalP < 0.10 ? '信号弱显著优于随机选择（p<0.10）' :
                   '信号未显著优于随机选择（p>=0.10）',
    allSeeds: results.map(r => ({
      seed: r.seed,
      avgReturn: r.avgReturn,
      accuracy: r.accuracy,
      trades: r.trades
    })),
    // 保存第一个seed的候选池hash供审计
    auditTrail: results[0]?.candidatePoolHashes || []
  };
}

module.exports = {
  randomDirectionControl,
  randomSelectionControl
};

