#!/usr/bin/env node
/**
 * aggregator.cjs — 回测结果汇总统计
 *
 * 功能：
 * - 读取批量回测JSONL日志
 * - 按置信度分层计算方向准确率
 * - 计算HV概率锥覆盖率（68%/95%）
 * - 生成汇总JSON + 可读文本报告
 *
 * Usage:
 *   node backtest/aggregator.cjs --log LOG_FILE [--output OUTPUT_FILE]
 */

const fs = require('fs');
const path = require('path');

const BACKTEST_DIR = __dirname;
const RUNS_DIR = path.join(BACKTEST_DIR, 'runs');

/**
 * 读取JSONL日志
 */
function readJSONL(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(line => line.trim());

  return lines.map(line => JSON.parse(line));
}

/**
 * 加载所有验证结果
 */
function loadVerifications(logEntries) {
  const verifications = [];

  for (const entry of logEntries) {
    if (entry.type === 'meta' || entry.type === 'complete') {
      continue;
    }

    if (entry.status !== 'success' || !entry.runId) {
      continue;
    }

    const runDir = path.join(RUNS_DIR, entry.runId);
    const verifyPath = path.join(runDir, 'verification.json');

    if (!fs.existsSync(verifyPath)) {
      console.warn(`⚠️  Verification not found: ${entry.runId}`);
      continue;
    }

    const verification = JSON.parse(fs.readFileSync(verifyPath, 'utf8'));

    for (const v of verification.verifications) {
      if (v.status === 'ok') {
        verifications.push({
          runId: entry.runId,
          asOfDate: entry.asOfDate,
          ...v
        });
      }
    }
  }

  return verifications;
}

/**
 * 按置信度分层统计方向准确率
 */
function calculateDirectionAccuracy(verifications) {
  const byConfidence = {
    high: { total: 0, correct: 0 },
    medium: { total: 0, correct: 0 },
    low: { total: 0, correct: 0 },
    all: { total: 0, correct: 0 }
  };

  for (const v of verifications) {
    const conf = v.prediction.confidence;
    const isCorrect = v.correct.direction;

    byConfidence.all.total++;
    if (isCorrect) byConfidence.all.correct++;

    if (conf === 'high' || conf === '高') {
      byConfidence.high.total++;
      if (isCorrect) byConfidence.high.correct++;
    } else if (conf === 'medium' || conf === '中等') {
      byConfidence.medium.total++;
      if (isCorrect) byConfidence.medium.correct++;
    } else if (conf === 'low' || conf === '低') {
      byConfidence.low.total++;
      if (isCorrect) byConfidence.low.correct++;
    }
  }

  // 计算准确率
  const result = {};
  for (const [level, stats] of Object.entries(byConfidence)) {
    result[level] = {
      total: stats.total,
      correct: stats.correct,
      accuracy: stats.total > 0 ? (stats.correct / stats.total * 100).toFixed(2) : 'N/A'
    };
  }

  return result;
}

/**
 * 计算HV概率锥覆盖率
 */
function calculateConeCoverage(verifications) {
  const coverage = {
    cone68_3d: { total: 0, inside: 0 },
    cone95_3d: { total: 0, inside: 0 },
    cone68_5d: { total: 0, inside: 0 },
    cone95_5d: { total: 0, inside: 0 }
  };

  for (const v of verifications) {
    const c = v.correct;

    if (c.cone68_3d !== null) {
      coverage.cone68_3d.total++;
      if (c.cone68_3d) coverage.cone68_3d.inside++;
    }

    if (c.cone95_3d !== null) {
      coverage.cone95_3d.total++;
      if (c.cone95_3d) coverage.cone95_3d.inside++;
    }

    if (c.cone68_5d !== null) {
      coverage.cone68_5d.total++;
      if (c.cone68_5d) coverage.cone68_5d.inside++;
    }

    if (c.cone95_5d !== null) {
      coverage.cone95_5d.total++;
      if (c.cone95_5d) coverage.cone95_5d.inside++;
    }
  }

  // 计算覆盖率
  const result = {};
  for (const [cone, stats] of Object.entries(coverage)) {
    result[cone] = {
      total: stats.total,
      inside: stats.inside,
      coverageRate: stats.total > 0 ? (stats.inside / stats.total * 100).toFixed(2) : 'N/A'
    };
  }

  return result;
}

/**
 * 按品种统计
 */
function calculateBySymbol(verifications) {
  const bySymbol = {};

  for (const v of verifications) {
    const sym = v.symbol;

    if (!bySymbol[sym]) {
      bySymbol[sym] = {
        symbol: sym,
        total: 0,
        directionCorrect: 0,
        avgChangePct: 0,
        changeSum: 0
      };
    }

    bySymbol[sym].total++;
    if (v.correct.direction) {
      bySymbol[sym].directionCorrect++;
    }
    bySymbol[sym].changeSum += Math.abs(v.actual.change_pct);
  }

  // 计算平均准确率和平均涨跌幅
  const result = Object.values(bySymbol).map(s => ({
    symbol: s.symbol,
    total: s.total,
    accuracy: ((s.directionCorrect / s.total) * 100).toFixed(2),
    avgChangePct: (s.changeSum / s.total).toFixed(2)
  }));

  // 按预测次数排序
  result.sort((a, b) => b.total - a.total);

  return result;
}

/**
 * 生成汇总统计
 */
async function aggregateResults(logPath) {
  console.log(`\n=== Aggregating Results ===`);
  console.log(`Log: ${logPath}`);

  // 1. 读取日志
  const entries = readJSONL(logPath);

  const metaEntry = entries.find(e => e.type === 'meta');
  const completeEntry = entries.find(e => e.type === 'complete');

  if (!metaEntry) {
    throw new Error('Log file missing meta entry');
  }

  console.log(`Batch ID: ${metaEntry.batchId}`);

  // 2. 加载验证结果
  console.log('Loading verification results...');
  const verifications = loadVerifications(entries);

  console.log(`Loaded ${verifications.length} valid verifications`);

  if (verifications.length === 0) {
    throw new Error('No valid verifications found');
  }

  // 3. 计算统计
  console.log('Calculating statistics...');

  const directionAccuracy = calculateDirectionAccuracy(verifications);
  const coneCoverage = calculateConeCoverage(verifications);
  const bySymbol = calculateBySymbol(verifications);

  // 4. 构建汇总对象
  const summary = {
    meta: {
      batchId: metaEntry.batchId,
      config: metaEntry.config,
      totalSamples: metaEntry.samplePoints.length,
      successCount: completeEntry ? completeEntry.successCount : null,
      errorCount: completeEntry ? completeEntry.errorCount : null,
      startedAt: metaEntry.startedAt,
      completedAt: completeEntry ? completeEntry.completedAt : null,
      aggregatedAt: new Date().toISOString()
    },
    statistics: {
      totalPredictions: verifications.length,
      directionAccuracy,
      coneCoverage,
      bySymbol
    }
  };

  // 5. 写入汇总JSON
  const summaryPath = logPath.replace('.jsonl', '-summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  console.log(`✅ Summary written: ${summaryPath}`);

  // 6. 生成可读报告
  const reportPath = logPath.replace('.jsonl', '-report.txt');
  const report = generateReport(summary);
  fs.writeFileSync(reportPath, report);
  console.log(`✅ Report written: ${reportPath}`);

  return { summary, summaryPath, reportPath };
}

/**
 * 生成可读文本报告
 */
function generateReport(summary) {
  const lines = [];

  lines.push('='.repeat(60));
  lines.push('期货雷达回测报告');
  lines.push('='.repeat(60));
  lines.push('');

  // 元信息
  lines.push('## 回测配置');
  lines.push(`批次ID: ${summary.meta.batchId}`);
  lines.push(`时间区间: ${summary.meta.config.startDate} → ${summary.meta.config.endDate}`);
  lines.push(`采样策略: ${summary.meta.config.samplingMode} (${summary.meta.totalSamples} 个时间点)`);
  lines.push(`验证窗口: T+${summary.meta.config.verifyDays} 天`);
  lines.push(`成功/失败: ${summary.meta.successCount} / ${summary.meta.errorCount}`);
  lines.push('');

  // 方向准确率
  lines.push('## 方向准确率（按置信度分层）');
  lines.push('');
  lines.push('| 置信度 | 预测数 | 正确数 | 准确率 |');
  lines.push('|--------|--------|--------|--------|');

  const acc = summary.statistics.directionAccuracy;
  lines.push(`| 高     | ${acc.high.total.toString().padStart(6)} | ${acc.high.correct.toString().padStart(6)} | ${acc.high.accuracy}% |`);
  lines.push(`| 中等   | ${acc.medium.total.toString().padStart(6)} | ${acc.medium.correct.toString().padStart(6)} | ${acc.medium.accuracy}% |`);
  lines.push(`| 低     | ${acc.low.total.toString().padStart(6)} | ${acc.low.correct.toString().padStart(6)} | ${acc.low.accuracy}% |`);
  lines.push(`| **总计** | **${acc.all.total.toString().padStart(6)}** | **${acc.all.correct.toString().padStart(6)}** | **${acc.all.accuracy}%** |`);
  lines.push('');

  // HV概率锥覆盖率
  lines.push('## HV 概率锥覆盖率');
  lines.push('');
  lines.push('| 概率锥 | 预测数 | 覆盖数 | 覆盖率 | 理论值 |');
  lines.push('|--------|--------|--------|--------|--------|');

  const cov = summary.statistics.coneCoverage;
  lines.push(`| 3日 68% | ${cov.cone68_3d.total.toString().padStart(6)} | ${cov.cone68_3d.inside.toString().padStart(6)} | ${cov.cone68_3d.coverageRate}% | 68.0% |`);
  lines.push(`| 3日 95% | ${cov.cone95_3d.total.toString().padStart(6)} | ${cov.cone95_3d.inside.toString().padStart(6)} | ${cov.cone95_3d.coverageRate}% | 95.0% |`);
  lines.push(`| 5日 68% | ${cov.cone68_5d.total.toString().padStart(6)} | ${cov.cone68_5d.inside.toString().padStart(6)} | ${cov.cone68_5d.coverageRate}% | 68.0% |`);
  lines.push(`| 5日 95% | ${cov.cone95_5d.total.toString().padStart(6)} | ${cov.cone95_5d.inside.toString().padStart(6)} | ${cov.cone95_5d.coverageRate}% | 95.0% |`);
  lines.push('');

  // 按品种统计（Top 10）
  lines.push('## 品种准确率（Top 10）');
  lines.push('');
  lines.push('| 品种 | 预测数 | 准确率 | 平均涨跌幅 |');
  lines.push('|------|--------|--------|------------|');

  const topSymbols = summary.statistics.bySymbol.slice(0, 10);
  for (const s of topSymbols) {
    lines.push(`| ${s.symbol.padEnd(4)} | ${s.total.toString().padStart(6)} | ${s.accuracy}% | ${s.avgChangePct}% |`);
  }
  lines.push('');

  // 总结
  lines.push('## 总结');
  lines.push('');
  lines.push(`总预测数: ${summary.statistics.totalPredictions}`);
  lines.push(`整体准确率: ${acc.all.accuracy}%`);
  lines.push('');

  // 置信度分析
  if (parseFloat(acc.high.accuracy) > parseFloat(acc.medium.accuracy)) {
    lines.push('✅ 高置信度预测准确率高于中等置信度，置信度分层有效');
  } else {
    lines.push('⚠️  高置信度准确率未明显高于中等置信度，需检查置信度判断逻辑');
  }

  // HV锥校准分析
  const cone68Rate = parseFloat(cov.cone68_3d.coverageRate);
  const cone95Rate = parseFloat(cov.cone95_3d.coverageRate);

  if (Math.abs(cone68Rate - 68) < 10) {
    lines.push('✅ HV 68%概率锥覆盖率接近理论值，校准良好');
  } else if (cone68Rate < 58) {
    lines.push('⚠️  HV 68%概率锥覆盖率偏低，可能低估波动率');
  } else if (cone68Rate > 78) {
    lines.push('⚠️  HV 68%概率锥覆盖率偏高，可能高估波动率');
  }

  if (Math.abs(cone95Rate - 95) < 5) {
    lines.push('✅ HV 95%概率锥覆盖率接近理论值，校准良好');
  } else if (cone95Rate < 90) {
    lines.push('⚠️  HV 95%概率锥覆盖率偏低，极端波动未充分覆盖');
  }

  lines.push('');
  lines.push('='.repeat(60));
  lines.push(`生成时间: ${summary.meta.aggregatedAt}`);
  lines.push('='.repeat(60));

  return lines.join('\n');
}

// ── CLI ──────────────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help')) {
    console.log('Usage:');
    console.log('  node aggregator.cjs --log LOG_FILE [--output OUTPUT_FILE]');
    console.log('');
    console.log('Options:');
    console.log('  --log FILE      JSONL log file from batch-runner');
    console.log('  --output FILE   Output summary JSON (default: <log>-summary.json)');
    process.exit(0);
  }

  const getArg = (flag, defaultVal) => {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : defaultVal;
  };

  const logPath = getArg('--log', null);

  if (!logPath) {
    console.error('ERROR: --log is required');
    process.exit(1);
  }

  if (!fs.existsSync(logPath)) {
    console.error(`ERROR: Log file not found: ${logPath}`);
    process.exit(1);
  }

  aggregateResults(logPath)
    .then(result => {
      console.log('\n✅ Aggregation complete');
      process.exit(0);
    })
    .catch(err => {
      console.error(`\n❌ FATAL: ${err.message}`);
      console.error(err.stack);
      process.exit(1);
    });
}

module.exports = { aggregateResults };
