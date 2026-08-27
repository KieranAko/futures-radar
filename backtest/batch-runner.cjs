#!/usr/bin/env node
/**
 * batch-runner.cjs — 批量回测执行器
 *
 * 功能：
 * - 从配置文件读取回测参数（时间区间、采样策略、验证天数）
 * - 调用time-sampler生成时间点
 * - 对每个时间点：切片窗口 → 运行轻量管道 → 验证预测
 * - 增量写入JSONL日志（防止中断丢失）
 * - 完成后调用aggregator生成汇总统计
 *
 * Usage:
 *   node backtest/batch-runner.cjs --config backtest-config.json
 *   node backtest/batch-runner.cjs --start 2019-01-01 --end 2026-07-31 --count 30 --mode random
 */

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const { generateSamplePoints } = require('./time-sampler.cjs');
const { sliceAllSymbols, loadCache } = require('./cache-slicer.cjs');
const { runMiniPipeline } = require('./mini-pipeline.cjs');
const dataStore = require('../data-store/index.cjs');

// ── Paths ────────────────────────────────────────────────────
const BACKTEST_DIR = __dirname;
const RUNS_DIR = path.join(BACKTEST_DIR, 'runs');
const LOGS_DIR = path.join(BACKTEST_DIR, 'logs');
const PYTHON_VERIFIER = path.join(BACKTEST_DIR, 'quick-verifier.py');
const CACHE_PATH = path.join(BACKTEST_DIR, 'data', 'historical-cache.json');

// ── Utilities ────────────────────────────────────────────────
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function appendJSONL(filePath, data) {
  const line = JSON.stringify(data) + '\n';
  fs.appendFileSync(filePath, line, 'utf8');
}

/**
 * 执行Python验证器
 */
function runVerifier(cachePath, predictionPath, verifyDays, outputPath) {
  return new Promise((resolve, reject) => {
    const args = [
      PYTHON_VERIFIER,
      '--cache-path', cachePath,
      '--prediction-path', predictionPath,
      '--verify-days', verifyDays.toString(),
      '--output', outputPath
    ];

    const proc = cp.spawn('python', args, {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    proc.on('close', code => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`Verifier failed: ${stderr}`));
      }
    });
  });
}

/**
 * 运行单次回测
 */
async function runSingleBacktest(asOfDate, windowDays, verifyDays, logStream, cachePath = CACHE_PATH) {
  const startTime = Date.now();

  console.log(`\n[${asOfDate}] Starting backtest...`);

  try {
    // 1. 切片窗口数据
    console.log(`  [1/3] Slicing ${windowDays}-day window...`);
    const windowData = sliceAllSymbols(asOfDate, windowDays);

    if (windowData.meta.succeeded === 0) {
      throw new Error('No symbols successfully sliced');
    }

    // 2. 运行轻量管道
    console.log(`  [2/3] Running mini-pipeline...`);
    const prediction = await runMiniPipeline(asOfDate, windowData);

    const runDir = path.join(RUNS_DIR, prediction.runId);
    const predictionPath = path.join(runDir, 'backtest-prediction.json');

    if (!fs.existsSync(predictionPath)) {
      throw new Error('Mini-pipeline did not generate backtest-prediction.json');
    }

    // 3. 验证预测
    console.log(`  [3/3] Verifying predictions (T+${verifyDays})...`);
    const verificationPath = path.join(runDir, 'verification.json');

    await runVerifier(cachePath, predictionPath, verifyDays, verificationPath);

    const verification = JSON.parse(fs.readFileSync(verificationPath, 'utf8'));

    // 4. 写入日志
    const elapsed = Date.now() - startTime;

    const logEntry = {
      runId: prediction.runId,
      asOfDate,
      windowDays,
      verifyDays,
      predictionsCount: verification.meta.totalPredictions,
      elapsed,
      status: 'success',
      timestamp: new Date().toISOString()
    };

    appendJSONL(logStream, logEntry);
    console.log(`  ✅ Complete (${elapsed}ms)`);

    return logEntry;

  } catch (err) {
    const elapsed = Date.now() - startTime;

    const logEntry = {
      asOfDate,
      windowDays,
      verifyDays,
      elapsed,
      status: 'error',
      error: err.message,
      timestamp: new Date().toISOString()
    };

    appendJSONL(logStream, logEntry);
    console.error(`  ❌ Failed: ${err.message}`);

    return logEntry;
  }
}

/**
 * 批量回测主流程
 */
async function runBatchBacktest(config) {
  const {
    startDate,
    endDate,
    sampleCount,
    samplingMode,
    randomSeed,
    windowDays = 60,
    verifyDays = 3
  } = config;

  console.log('=== Batch Backtest Runner ===');
  console.log(`Date range: ${startDate} → ${endDate}`);
  console.log(`Sampling: ${samplingMode} mode, ${sampleCount} points`);
  console.log(`Window: ${windowDays} days | Verify: T+${verifyDays}`);

  // 确保目录存在
  ensureDir(RUNS_DIR);
  ensureDir(LOGS_DIR);

  // 加载历史缓存一次（优先 data-store 文件库，旧缓存回退），并准备 Python 验证器输入文件
  console.log('\n[Step 0] Loading historical cache...');
  const cache = loadCache();
  let cachePath = CACHE_PATH;
  if (cache && cache.meta && cache.meta.source === 'data-store') {
    cachePath = dataStore.exportHistoricalCache();
    console.log(`  cache source: data-store → ${cachePath}`);
  } else {
    console.log(`  cache source: legacy → ${cachePath}`);
  }

  // 生成采样时间点
  console.log('\n[Step 1] Generating sample points...');
  const samplePoints = generateSamplePoints({
    startDate,
    endDate,
    sampleCount,
    mode: samplingMode,
    randomSeed
  }, cache);

  console.log(`Generated ${samplePoints.length} sample points`);

  // 创建日志文件
  const batchId = `batch-${Date.now()}`;
  const logPath = path.join(LOGS_DIR, `${batchId}.jsonl`);

  console.log(`\n[Step 2] Running backtests (log: ${logPath})`);

  // 写入元信息
  const metaEntry = {
    type: 'meta',
    batchId,
    config,
    samplePoints,
    startedAt: new Date().toISOString()
  };
  appendJSONL(logPath, metaEntry);

  // 执行回测
  let successCount = 0;
  let errorCount = 0;

  for (let i = 0; i < samplePoints.length; i++) {
    const asOfDate = samplePoints[i];

    console.log(`\n[${i + 1}/${samplePoints.length}] Processing ${asOfDate}...`);

    const result = await runSingleBacktest(asOfDate, windowDays, verifyDays, logPath, cachePath);

    if (result.status === 'success') {
      successCount++;
    } else {
      errorCount++;
    }

    // 进度打印
    const progress = ((i + 1) / samplePoints.length * 100).toFixed(1);
    console.log(`Progress: ${progress}% (${successCount} OK, ${errorCount} errors)`);
  }

  // 写入完成标记
  const completeEntry = {
    type: 'complete',
    batchId,
    successCount,
    errorCount,
    completedAt: new Date().toISOString()
  };
  appendJSONL(logPath, completeEntry);

  console.log('\n=== Batch Complete ===');
  console.log(`✅ Success: ${successCount}`);
  console.log(`❌ Errors: ${errorCount}`);
  console.log(`📄 Log: ${logPath}`);

  // 调用汇总器
  console.log('\n[Step 3] Aggregating results...');
  const aggregatorScript = path.join(BACKTEST_DIR, 'aggregator.cjs');

  if (fs.existsSync(aggregatorScript)) {
    try {
      const { aggregateResults } = require(aggregatorScript);
      const summary = await aggregateResults(logPath);
      console.log('📊 Summary generated:', summary.summaryPath);
    } catch (err) {
      console.warn(`⚠️  Aggregator failed: ${err.message}`);
    }
  } else {
    console.warn('⚠️  Aggregator not found, skipping summary');
  }

  return { batchId, logPath, successCount, errorCount };
}

// ── CLI ──────────────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help')) {
    console.log('Usage:');
    console.log('  node batch-runner.cjs --config CONFIG_FILE');
    console.log('  node batch-runner.cjs --start DATE --end DATE --count N --mode MODE [options]');
    console.log('');
    console.log('Options:');
    console.log('  --config FILE       Config JSON file');
    console.log('  --start DATE        Start date (YYYY-MM-DD)');
    console.log('  --end DATE          End date (YYYY-MM-DD)');
    console.log('  --count N           Sample count');
    console.log('  --mode MODE         Sampling mode: uniform | random | monthly');
    console.log('  --window N          Window days (default: 60)');
    console.log('  --verify N          Verify days (default: 3)');
    console.log('  --seed N            Random seed (random mode only)');
    process.exit(0);
  }

  const getArg = (flag, defaultVal) => {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : defaultVal;
  };

  let config;

  // 从配置文件读取
  if (args.includes('--config')) {
    const configPath = getArg('--config');
    if (!fs.existsSync(configPath)) {
      console.error(`ERROR: Config file not found: ${configPath}`);
      process.exit(1);
    }
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } else {
    // 从命令行参数读取
    config = {
      startDate: getArg('--start', null),
      endDate: getArg('--end', null),
      sampleCount: parseInt(getArg('--count', '30'), 10),
      samplingMode: getArg('--mode', 'uniform'),
      windowDays: parseInt(getArg('--window', '60'), 10),
      verifyDays: parseInt(getArg('--verify', '3'), 10),
      randomSeed: args.includes('--seed') ? parseInt(getArg('--seed'), 10) : undefined
    };

    if (!config.startDate || !config.endDate) {
      console.error('ERROR: --start and --end are required');
      process.exit(1);
    }
  }

  // 运行批量回测
  runBatchBacktest(config)
    .then(result => {
      console.log('\n✅ Batch backtest complete');
      console.log(`Batch ID: ${result.batchId}`);
      process.exit(0);
    })
    .catch(err => {
      console.error(`\n❌ FATAL: ${err.message}`);
      console.error(err.stack);
      process.exit(1);
    });
}

module.exports = { runBatchBacktest, runSingleBacktest };
