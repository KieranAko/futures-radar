/**
 * Stage 4.5: Probability Estimation
 *
 * Calculates HV-based probability cones and ATR comparison for KEEP candidates.
 * Positioned between Stage 4 (analyze) and Stage 5 (report).
 */

const fs = require('fs');
const path = require('path');
const { extractOHLC, getLatestClose } = require('./ohlc-reader.cjs');
const { autoEstimateHV, hvPercentile } = require('./hv-estimators.js');
const { probabilityCone, compareBands } = require('./probability-cone.js');

/**
 * P0（主力连续污染修复）：优先使用主导合约干净序列（analyze/main-series.json）。
 * 架构原则：主力连续是筛选指数，不是价格水平数据源 —— HV/ATR/现价
 * 必须用当日主导合约自身序列。旧 run（无 main-series.json）回退 raw.json。
 */

const CLEAN_MIN_BARS = 21; // 20 日 HV 窗口最低 bar 数

/**
 * 读取 analyze/main-series.json（freeze-packets 产出）
 * @param {string} runDir - Run directory path
 * @returns {Object} { [symbol]: { contract, bars } }（缺失/损坏时 {}）
 */
function loadMainSeries(runDir) {
  const p = path.join(runDir, 'analyze', 'main-series.json');
  if (!fs.existsSync(p)) {
    console.log('  main-series.json 不存在 → 回退 raw.json（旧 run 口径）');
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    console.log(`  ⚠️  main-series.json 解析失败（${err.message}）→ 回退 raw.json`);
    return {};
  }
}

/**
 * ATR(period) —— 与 scanner/index.cjs computeATR 同口径
 * TR[i] = max(high-low, |high-prevClose|, |low-prevClose|)，ATR = 最近 period 个 TR 均值
 * @param {Array<object>} bars - [{date, open, high, low, close}]
 * @param {number} period - ATR 窗口（默认 5）
 * @returns {number|null}
 */
function computeATRFromBars(bars, period = 5) {
  const tr = [];
  for (let i = 1; i < bars.length; i++) {
    tr.push(Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close)
    ));
  }
  if (tr.length < period) return null;
  const recent = tr.slice(-period);
  return recent.reduce((acc, v) => acc + v, 0) / recent.length;
}

/**
 * Execute Stage 4.5: Probability Estimation
 *
 * @param {string} runDir - Run directory path
 * @param {Object} artifacts - Input artifacts from previous stages
 * @param {Object} artifacts.filtered - Parsed filtered.json
 * @param {Object} artifacts.candidates - Parsed candidates.json
 * @param {Object} artifacts.raw - Parsed raw.json
 * @returns {Object} probability.json output
 */
async function execute(runDir, artifacts) {
  console.log('Stage 4.5: Probability Estimation');
  console.log('=================================\n');

  const { filtered, candidates, raw } = artifacts;

  // Extract KEEP candidates from filtered.json
  const keepCandidates = filtered.candidates.filter(c => c.decision === 'KEEP');

  if (keepCandidates.length === 0) {
    console.log('⚠️  No KEEP candidates found in filtered.json');
    const emptyOutput = {
      meta: {
        runId: filtered.meta.runId,
        calculatedAt: new Date().toISOString(),
        stage: '4.5',
        estimatorUsed: {}
      },
      probabilities: []
    };
    writeOutput(runDir, emptyOutput);
    return emptyOutput;
  }

  console.log(`Processing ${keepCandidates.length} KEEP candidates:\n`);

  const mainSeries = loadMainSeries(runDir);
  const probabilities = [];
  const estimatorUsed = {};

  for (const candidate of keepCandidates) {
    const { symbol } = candidate;
    console.log(`\n--- ${symbol} ---`);

    try {
      // P0：主导合约干净序列优先（HV/ATR/现价全基于自身序列）
      const clean = mainSeries[symbol];
      let ohlcArray;
      let close;
      let atr5;
      let seriesSource;

      if (clean && Array.isArray(clean.bars) && clean.bars.length >= CLEAN_MIN_BARS) {
        ohlcArray = clean.bars.map((b) => ({
          date: b.date, open: b.open, high: b.high, low: b.low, close: b.close
        }));
        close = ohlcArray[ohlcArray.length - 1].close;
        atr5 = computeATRFromBars(ohlcArray, 5);
        seriesSource = `specific_contract:${clean.contract}`;
        console.log(`  Clean series: ${clean.contract} (${ohlcArray.length} bars)`);
        console.log(`  Close (from ${clean.contract}): ${close}`);
        console.log(`  ATR5 (clean): ${atr5 != null ? atr5.toFixed(4) : null}`);
      } else {
        // Fallback：旧 run 无 main-series.json → raw.json（主力连续口径）
        try {
          ohlcArray = extractOHLC(raw, symbol);
          close = getLatestClose(raw, symbol);  // raw.json is the single source of truth for close
          seriesSource = 'main_continuous:raw.json';
          console.log(`  OHLC bars: ${ohlcArray.length}`);
          console.log(`  Close (from raw.json): ${close}`);
        } catch (err) {
          console.log(`  ❌ OHLC extraction failed: ${err.message}`);
          // Fallback to candidates.json only when raw.json fails
          const candidateData = candidates.candidates.find(c => c.symbol === symbol);
          const fallbackClose = candidateData?.trend.close || null;
          const fallbackAtr5 = candidateData?.indicators.atr5 || null;
          probabilities.push(createNullEntry(symbol, fallbackClose, fallbackAtr5, 'OHLC数据不足'));
          continue;
        }
      }

      // Extract ATR from candidates.json (secondary source, only for ATR comparison)
      const candidateData = candidates.candidates.find(c => c.symbol === symbol);
      if (!candidateData) {
        throw new Error(`${symbol} not found in candidates.json`);
      }
      if (atr5 === null || atr5 === undefined) {
        atr5 = candidateData.indicators.atr5;
        seriesSource = seriesSource ? `${seriesSource}+atr:candidates.json` : 'atr:candidates.json';
        console.log(`  ATR5 (fallback candidates.json): ${atr5}`);
      }

      // Calculate HV with auto-correction
      let hvResult;
      try {
        hvResult = autoEstimateHV(ohlcArray, 20, { autoCorrect: true });
        estimatorUsed[symbol] = hvResult.estimator;

        console.log(`  HV: ${(hvResult.hv * 100).toFixed(2)}% (${hvResult.estimator})`);

        if (hvResult.correctionCount > 0) {
          console.log(`  ⚠️  OHLC corrections: ${hvResult.correctionCount}`);
        }

        if (hvResult.degraded) {
          console.log(`  ⚠️  Data degraded (>20% corrections)`);
        }
      } catch (err) {
        console.log(`  ❌ HV calculation failed: ${err.message}`);
        probabilities.push(createNullEntry(symbol, close, atr5, 'HV计算失败'));
        continue;
      }

      // Calculate HV percentile (optional, requires 110+ bars)
      let percentile90d = null;
      if (ohlcArray.length >= 110) {
        try {
          const percentileResult = hvPercentile(ohlcArray, 20);
          percentile90d = percentileResult.percentile;
          console.log(`  HV Percentile: P${percentile90d}`);
        } catch (err) {
          console.log(`  ⚠️  HV percentile calculation skipped: ${err.message}`);
        }
      } else {
        console.log(`  ⚠️  HV percentile unavailable (need 110+ bars, got ${ohlcArray.length})`);
      }

      // Calculate probability cone
      const cone = probabilityCone(close, hvResult.hv, [3, 5], [1.0, 1.96]);
      console.log(`  3d 95% cone: [${cone['3d']['p95'][0]}, ${cone['3d']['p95'][1]}]`);
      console.log(`  5d 95% cone: [${cone['5d']['p95'][0]}, ${cone['5d']['p95'][1]}]`);

      // Compare ATR band vs HV cone
      const atrBand = [close - 2 * atr5, close + 2 * atr5];
      const hvBand3d = cone['3d']['p95'];
      const comparison = compareBands(atrBand, hvBand3d);

      console.log(`  ATR 2× band: [${atrBand[0].toFixed(1)}, ${atrBand[1].toFixed(1)}]`);
      console.log(`  Divergence: ${comparison.divergencePct}%`);
      console.log(`  ${comparison.interpretation}`);

      // Assemble probability entry
      probabilities.push({
        symbol,
        seriesSource,
        close,
        hv: {
          annual: Math.round(hvResult.hv * 1000) / 1000,
          periodDays: 20,
          percentile90d,
          estimator: hvResult.estimator,
          correctionCount: hvResult.correctionCount || 0,
          totalBars: ohlcArray.length,
          degraded: hvResult.degraded || false
        },
        cone,
        atrComparison: {
          atr5,
          atr2xBand: [Math.round(atrBand[0] * 10) / 10, Math.round(atrBand[1] * 10) / 10],
          hv95Band3d: hvBand3d,
          divergencePct: comparison.divergencePct,
          interpretation: comparison.interpretation
        }
      });

    } catch (err) {
      console.log(`  ❌ Unexpected error: ${err.message}`);
      console.error(err.stack);
      probabilities.push(createNullEntry(symbol, null, null, err.message));
    }
  }

  // Assemble output
  const output = {
    meta: {
      runId: filtered.meta.runId,
      calculatedAt: new Date().toISOString(),
      stage: '4.5',
      estimatorUsed
    },
    probabilities
  };

  // Write probability.json
  writeOutput(runDir, output);

  console.log(`\n✅ Stage 4.5 complete: ${probabilities.length} entries written to probability.json`);

  return output;
}

// ── CLI entry point ──────────────────────────────────────────
if (require.main === module) {
  const fs = require('fs');
  const path = require('path');
  const { runtimeRoot } = require('../lib/workspace.cjs');

  const args = process.argv.slice(2);
  const runIdIdx = args.indexOf('--runId');
  if (runIdIdx === -1) {
    console.error('ERROR: --runId required');
    process.exit(1);
  }

  const runId = args[runIdIdx + 1];
  const runDir = path.join(runtimeRoot, 'runs', runId);

  if (!fs.existsSync(runDir)) {
    console.error(`ERROR: run directory not found: ${runDir}`);
    process.exit(1);
  }

  // Load input artifacts
  const filtered = JSON.parse(fs.readFileSync(path.join(runDir, 'filtered.json'), 'utf8'));
  const candidates = JSON.parse(fs.readFileSync(path.join(runDir, 'candidates.json'), 'utf8'));
  const raw = JSON.parse(fs.readFileSync(path.join(runDir, 'raw.json'), 'utf8'));

  execute(runDir, { filtered, candidates, raw })
    .then(() => {
      console.log('\nStage 4.5 execution complete.');
      process.exit(0);
    })
    .catch(err => {
      console.error('\nFATAL: Stage 4.5 failed');
      console.error(err);
      process.exit(1);
    });
}

/**
 * Create null entry for failed calculations
 */
function createNullEntry(symbol, close, atr5, reason) {
  return {
    symbol,
    close,
    hv: null,
    cone: null,
    atrComparison: {
      atr5,
      atr2xBand: atr5 && close ? [close - 2 * atr5, close + 2 * atr5] : null,
      hv95Band3d: null,
      divergencePct: null,
      interpretation: `HV计算失败: ${reason}`
    }
  };
}

/**
 * Write probability.json to run directory
 */
function writeOutput(runDir, output) {
  const outputPath = path.join(runDir, 'probability.json');
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2), 'utf8');
}

module.exports = { execute, loadMainSeries, computeATRFromBars };
