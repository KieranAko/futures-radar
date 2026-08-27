#!/usr/bin/env node
/**
 * mini-pipeline.cjs — 轻量分析管道
 *
 * 功能：
 * - 运行 Stage 2-4（跳过Stage 1采集和Stage 5报告生成）
 * - 从缓存切片的窗口数据直接进入扫描→筛选→分析
 * - 提取核心判断（方向、置信度、价格区间）
 *
 * Usage:
 *   const { runMiniPipeline } = require('./mini-pipeline.cjs');
 *   const prediction = await runMiniPipeline('2026-07-01', windowData);
 */

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const SKILL_ROOT = path.join(__dirname, '..');
const BACKTEST_DIR = __dirname;
const RUNS_DIR = path.join(BACKTEST_DIR, 'runs');

/**
 * 执行单个Stage脚本
 */
function execStage(scriptPath, args = []) {
  return new Promise((resolve, reject) => {
    const fullPath = path.join(SKILL_ROOT, scriptPath);

    const proc = cp.spawn('node', [fullPath, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: SKILL_ROOT
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
      process.stdout.write(data); // 实时输出
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
      process.stderr.write(data);
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`Stage failed with code ${code}: ${stderr}`));
      }
    });
  });
}

/**
 * 运行轻量分析管道
 * @param {string} asOfDate - 时间点T
 * @param {Object} windowData - 从缓存切片的窗口数据
 * @param {Object} [options] - 可选 LLM replay（默认 off，旧行为零影响）：
 *   reasoningMode 'off'|'mock'|'recorded'|'live-model'、arms、provider、pointInTimePackets、recordedSource
 * @returns {Object} 预测结果
 */
async function runMiniPipeline(asOfDate, windowData, {
  reasoningMode = 'off',
  arms = ['fincot'],
  provider = null,
  pointInTimePackets = null,
  recordedSource = null
} = {}) {
  const runId = `bt-${asOfDate.replace(/-/g, '')}`;
  const runDir = path.join(RUNS_DIR, runId);

  console.log(`\n=== Mini Pipeline: ${runId} ===`);

  // 1. 创建运行目录
  if (!fs.existsSync(runDir)) {
    fs.mkdirSync(runDir, { recursive: true });
  }

  // 2. 为每个contract计算derived字段
  const enrichedContracts = {};
  for (const [symbol, contract] of Object.entries(windowData.contracts)) {
    const o = contract.ohlcv;
    const len = o.close.length;

    // 计算5日平均成交量、成交额、持仓量
    const last5Volume = len >= 5 ? o.volume.slice(-5) : o.volume;
    const last5OI = len >= 5 ? o.openInterest.slice(-5) : o.openInterest;
    const last5Close = len >= 5 ? o.close.slice(-5) : o.close;

    const avgVolume5d = last5Volume.reduce((a, b) => a + b, 0) / last5Volume.length;
    const avgOI5d = last5OI.reduce((a, b) => a + b, 0) / last5OI.length;

    // 成交额 = 成交量 × 平均收盘价 × 合约乘数
    const avgClose5d = last5Close.reduce((a, b) => a + b, 0) / last5Close.length;
    const avgTurnover5d = avgVolume5d * avgClose5d * (contract.multiplier || 1);

    // 5日涨跌幅
    const change5d = len >= 6 ? ((o.close[len - 1] - o.close[len - 6]) / o.close[len - 6] * 100) : null;

    enrichedContracts[symbol] = {
      ...contract,
      derived: {
        avgVolume5d: Math.round(avgVolume5d),
        avgTurnover5d: Math.round(avgTurnover5d),
        avgOI5d: Math.round(avgOI5d),
        change5d: change5d != null ? parseFloat(change5d.toFixed(2)) : null
      }
    };
  }

  // 3. 写入窗口数据（模拟raw.json）
  const rawJsonPath = path.join(runDir, 'raw.json');
  const rawJson = {
    meta: {
      runId,
      collectedAt: windowData.meta.slicedAt,
      source: 'cache-slice',
      sourceVersion: 'backtest',
      symbolsScanned: windowData.meta.symbolCount,
      symbolsSucceeded: windowData.meta.succeeded,
      symbolsFailed: windowData.meta.failed,
      daysPerSymbol: windowData.meta.windowDays,
      fullPull: false,
      backtest: true,
      asOfDate
    },
    contracts: enrichedContracts,
    gaps: {},
    macroAnchors: {
      _note: 'Backtest mode - macro anchors not collected',
      collected: false
    }
  };

  fs.writeFileSync(rawJsonPath, JSON.stringify(rawJson, null, 2));
  console.log(`  raw.json → ${rawJsonPath}`);

  // 3. Stage 2: Scan
  console.log('\n[Stage 2: Scan]');
  await execStage('scanner/index.cjs', ['--runId', runId, '--runDir', runDir]);

  const candidatesPath = path.join(runDir, 'candidates.json');
  if (!fs.existsSync(candidatesPath)) {
    throw new Error('Stage 2 failed: candidates.json not found');
  }

  // 4. Stage 3a: Hard Filter (if exists)
  const hardFilterScript = path.join(SKILL_ROOT, 'filter', 'hard-filter.cjs');
  if (fs.existsSync(hardFilterScript)) {
    console.log('\n[Stage 3a: Hard Filter]');
    await execStage('filter/hard-filter.cjs', ['--runId', runId, '--runDir', runDir]);
  }

  // 5. Stage 3b: LLM Filter
  console.log('\n[Stage 3b: LLM Filter]');
  console.log('⚠️  LLM filter requires manual execution');
  console.log(`   Please run: cd ${SKILL_ROOT} && node filter/filter-llm.cjs --runId ${runId} --runDir ${runDir}`);
  console.log('   Then press Enter to continue...');

  // 等待filtered.json出现
  const filteredPath = path.join(runDir, 'filtered.json');
  if (!fs.existsSync(filteredPath)) {
    throw new Error('Stage 3b blocked: filtered.json not found. Run filter-llm.cjs manually.');
  }

  // 6. Stage 4: Analyze
  console.log('\n[Stage 4: Analyze]');
  console.log('⚠️  Analysis requires manual execution');
  console.log(`   Please run analyze stage for runId ${runId}`);

  const analysisPath = path.join(runDir, 'analysis.json');
  if (!fs.existsSync(analysisPath)) {
    throw new Error('Stage 4 blocked: analysis.json not found. Run analyze stage manually.');
  }

  // 6.5 Stage 4.5 (optional): LLM reasoning replay — 默认 off 不影响旧路径
  if (reasoningMode !== 'off') {
    console.log('\n[Stage 4.5: LLM Replay]');
    await runReasoningReplay({ runId, runDir, asOfDate, rawJson, reasoningMode, arms, provider, pointInTimePackets, recordedSource });
  }

  // 7. 提取核心判断
  console.log('\n[Extract Predictions]');
  const filtered = JSON.parse(fs.readFileSync(filteredPath, 'utf8'));
  const analysis = JSON.parse(fs.readFileSync(analysisPath, 'utf8'));

  const predictions = analysis.analyses.map(a => {
    // 从Q6 risks中提取收盘价
    const closeMatch = a.q6_risks?.limitDistance?.match(/收盘([\d.]+)/) ||
                       a.q6_risks?.limitDistance?.match(/([\d.]+)元/);
    const close = closeMatch ? parseFloat(closeMatch[1]) : null;

    return {
      symbol: a.symbol,
      name: a.name,
      direction: a.direction,
      confidence: a.confidence,
      close,
      hvCone3d: extractCone(a, '3d'),
      hvCone5d: extractCone(a, '5d'),
      confirmSignal: a.q4_confirmation?.signals?.[0] || null,
      invalidation: a.q5_invalidation?.conditions?.[0] || null
    };
  });

  const predictionJson = {
    runId,
    asOfDate,
    predictions
  };

  const predictionPath = path.join(runDir, 'backtest-prediction.json');
  fs.writeFileSync(predictionPath, JSON.stringify(predictionJson, null, 2));
  console.log(`  backtest-prediction.json → ${predictionPath}`);

  return predictionJson;
}

/**
 * Stage 4.5: LLM reasoning replay → outcome 评分 → scorecard
 * 无 point-in-time 冻结包时以空 stub 走真实资格评估（工程诊断，全 non_point_in_time）
 */
async function runReasoningReplay({ runId, runDir, asOfDate, rawJson, reasoningMode, arms, provider, pointInTimePackets, recordedSource }) {
  const { replayReasoning } = require('./llm-replay.cjs');
  const { scoreReasoningOutcome } = require('./llm-outcome.cjs');
  const { buildLlmScorecard } = require('./llm-scorecard.cjs');
  const symbols = readFilteredSymbols(path.join(runDir, 'filtered.json'));

  let packets;
  let providerMode = reasoningMode;
  let resolvedProvider = provider;
  let resolvedRecorded = recordedSource;
  if (Array.isArray(pointInTimePackets) && pointInTimePackets.length > 0) {
    packets = pointInTimePackets.filter((p) => symbols.includes(p.symbol));
  } else {
    packets = symbols.map((symbol) => ({ symbol, signalDate: asOfDate }));
    providerMode = 'diagnostic';
    resolvedProvider = { async complete() { throw new Error('diagnostic provider must never be called'); } };
    resolvedRecorded = null;
  }

  const rows = await replayReasoning({ replayId: `${runId}-replay`, packets, arms, providerMode, provider: resolvedProvider, recordedSource: resolvedRecorded });

  for (const row of rows) {
    if (row.scoringStatus === null) {
      const scored = scoreReasoningOutcome({ result: row.result, symbol: row.symbol, signalDate: row.signalDate, raw: rawJson });
      row.outcome = scored.outcome;
      row.scoringStatus = scored.scoringStatus;
    }
  }

  const replayPath = path.join(runDir, 'reasoning-replay.jsonl');
  fs.writeFileSync(replayPath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const scorecardPath = path.join(runDir, 'llm-scorecard.json');
  fs.writeFileSync(scorecardPath, JSON.stringify({ runId, asOfDate, ...buildLlmScorecard(rows) }, null, 2));
  console.log(`  reasoning-replay.jsonl (${rows.length} rows) / llm-scorecard.json → ${runDir}`);
}

function readFilteredSymbols(filteredPath) {
  const filtered = JSON.parse(fs.readFileSync(filteredPath, 'utf8'));
  if (Array.isArray(filtered.symbols)) return filtered.symbols.filter((s) => typeof s === 'string');
  if (Array.isArray(filtered)) return filtered.map((f) => f && f.symbol).filter(Boolean);
  return [];
}

/**
 * 从analysis中提取HV概率锥数据
 */
function extractCone(analysis, days) {
  // 尝试从不同可能的位置提取概率锥数据

  // 方式1: 从probability数据（如果有Stage 4.5）
  if (analysis.probability && analysis.probability.cone && analysis.probability.cone[days]) {
    return analysis.probability.cone[days];
  }

  // 方式2: 从q6_risks文本解析（fallback）
  const risksText = JSON.stringify(analysis.q6_risks || {});

  // 查找类似 "[547.2, 590.0]" 的模式
  const p68Match = risksText.match(/68%[^\[]*\[(\d+\.?\d*)[^\d]*(\d+\.?\d*)\]/);
  const p95Match = risksText.match(/95%[^\[]*\[(\d+\.?\d*)[^\d]*(\d+\.?\d*)\]/);

  if (p68Match && p95Match) {
    return {
      p68: [parseFloat(p68Match[1]), parseFloat(p68Match[2])],
      p95: [parseFloat(p95Match[1]), parseFloat(p95Match[2])]
    };
  }

  return null;
}

// ── CLI ──────────────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help')) {
    console.log('Usage: node mini-pipeline.cjs --date YYYY-MM-DD [--window N]');
    console.log('');
    console.log('Options:');
    console.log('  --date DATE     As-of date (T point)');
    console.log('  --window N      Window days (default: 60)');
    process.exit(0);
  }

  const getArg = (flag, defaultVal) => {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : defaultVal;
  };

  const asOfDate = getArg('--date', null);
  const windowDays = parseInt(getArg('--window', '60'), 10);

  if (!asOfDate) {
    console.error('ERROR: --date is required');
    process.exit(1);
  }

  (async () => {
    try {
      // 1. 切片窗口数据
      const { sliceAllSymbols } = require('./cache-slicer.cjs');
      const windowData = sliceAllSymbols(asOfDate, windowDays);

      // 2. 运行轻量管道
      const prediction = await runMiniPipeline(asOfDate, windowData);

      console.log('\n=== PIPELINE COMPLETE ===');
      console.log(`Predictions: ${prediction.predictions.length}`);
      console.log(JSON.stringify(prediction, null, 2));
    } catch (err) {
      console.error(`FATAL: ${err.message}`);
      process.exit(1);
    }
  })();
}

module.exports = { runMiniPipeline };
