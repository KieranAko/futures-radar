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
const { computePredictionIntervals, logReturns } = require('./prediction-intervals.cjs');
const dataStore = require('../data-store/index.cjs');

/**
 * P0（主力连续污染修复）：优先使用主导合约干净序列（analyze/main-series.json）。
 * 架构原则：主力连续是筛选指数，不是价格水平数据源 —— HV/ATR/现价
 * 必须用当日主导合约自身序列。旧 run（无 main-series.json）回退 raw.json。
 */

const CLEAN_MIN_BARS = 21; // 20 日 HV 窗口最低 bar 数

/**
 * 读取 analyze/main-series.json（freeze-packets 产出）。
 * v0.1.4：main-series.json 缺失/损坏时，回退 data-store contract-bars（同 runId 冻结值），
 * 再不行才回退 raw.json 主力连续（旧 run 口径）。
 * @param {string} runDir - Run directory path
 * @param {string} [runId] - 用于文件库回退
 * @param {string[]} [symbols] - 需要回退的 KEEP 品种
 * @returns {Object} { [symbol]: { contract, bars } }（缺失/损坏时 {}）
 */
function loadMainSeries(runDir, runId = null, symbols = []) {
  const p = path.join(runDir, 'analyze', 'main-series.json');
  const out = {};
  let needFallback = false;

  if (!fs.existsSync(p)) {
    needFallback = true;
  } else {
    try {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
      Object.assign(out, parsed);
      for (const sym of symbols) {
        if (!out[sym]) needFallback = true;
      }
    } catch (err) {
      console.log(`  ⚠️  main-series.json 解析失败（${err.message}）`);
      needFallback = true;
    }
  }

  if (needFallback && runId && symbols.length > 0) {
    for (const sym of symbols) {
      if (out[sym]) continue;
      try {
        const stored = dataStore.getContractBarsForRun(runId, sym);
        if (stored) {
          out[sym] = stored;
          console.log(`  main-series.json 缺失 → data-store contract-bars 回退: ${sym} (${stored.contract})`);
        }
      } catch (err) {
        console.log(`  ⚠️  data-store contract-bars 回退失败: ${sym} (${err.message})`);
      }
    }
  }
  return out;
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

// ATR5 结束于指定 idx（与 computeATRFromBars 同口径，仅窗口位置不同）
function atr5At(bars, idx, period = 5) {
  if (idx < period) return null;
  const tr = [];
  for (let i = idx - period + 1; i <= idx; i++) {
    if (i < 1) continue;
    const b = bars[i];
    const p = bars[i - 1];
    tr.push(Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close)));
  }
  if (tr.length < period) return null;
  return tr.reduce((a, b) => a + b, 0) / tr.length;
}

function round4(v) {
  return v == null || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 10000) / 10000;
}

/**
 * 波动率 regime 契约（唯一生产者：probability stage-4.5）。
 * grade: normal | elevated | extreme
 * dynamic.direction: rising | falling | stable（volShiftRatio 5 日变化）
 * 规则见 strategies/report-strategy-section.md 与 risk-framework §10 口径。
 */
function computeVolatilityRegime({ close, atr5, hvAnnual, currentState, bars }) {
  const hvDaily = hvAnnual && Number.isFinite(hvAnnual) ? hvAnnual / Math.sqrt(242) : null;
  const vsrNow = currentState && Number.isFinite(currentState.volShiftRatio) ? currentState.volShiftRatio : null;
  const tailFlag = !!(currentState && currentState.tailFlag);
  const kurtosis = currentState && Number.isFinite(currentState.kurtosis) ? currentState.kurtosis : null;
  const percentile = currentState && Number.isFinite(currentState.hvPercentile) ? currentState.hvPercentile : null;
  const atrPct = close && Number.isFinite(close) && atr5 ? round4((atr5 / close) * 100) : null;

  // volShiftRatio 5 日前（动态适应输入）
  let vsr5dAgo = null;
  if (bars && Array.isArray(bars) && hvDaily && hvDaily > 0) {
    const idx5Ago = bars.length - 6;
    if (idx5Ago >= 4) {
      const a5 = atr5At(bars, idx5Ago);
      if (a5 != null && bars[idx5Ago].close) {
        vsr5dAgo = round4((a5 / bars[idx5Ago].close) / hvDaily);
      }
    }
  }

  const direction = vsrNow != null && vsr5dAgo != null
    ? (vsrNow < vsr5dAgo - 0.15 ? 'falling' : vsrNow > vsr5dAgo + 0.15 ? 'rising' : 'stable')
    : 'stable';

  // regimeAgeDays：连续多少个交易日处于 elevated/extreme（用 volShiftRatio≥1.3 或 tailFlag 近似）
  let regimeAgeDays = 0;
  if (bars && Array.isArray(bars) && hvDaily && hvDaily > 0) {
    const start = Math.max(4, bars.length - 10);
    for (let i = bars.length - 1; i >= start; i--) {
      const a5 = atr5At(bars, i);
      const c = bars[i].close;
      const vsr = a5 != null && c ? (a5 / c) / hvDaily : null;
      if (vsr != null && vsr >= 1.3) regimeAgeDays++;
      else break;
    }
  }

  const isExtreme = percentile != null && percentile >= 95 && (vsrNow != null && vsrNow >= 1.5 || tailFlag);
  const isElevated = !isExtreme && ((percentile != null && percentile >= 85) || (vsrNow != null && vsrNow >= 1.3) || tailFlag);
  const grade = isExtreme ? 'extreme' : isElevated ? 'elevated' : 'normal';

  const rationale = [
    `hvPercentile ${percentile ?? '—'}`,
    `volShiftRatio ${vsrNow ?? '—'}${vsr5dAgo != null ? `（5日前 ${vsr5dAgo}）` : ''}`,
    `tailFlag ${tailFlag}`,
    `grade=${grade}`,
    `direction=${direction}`
  ].join('；');

  return {
    grade,
    basis: {
      hvPercentile90d: percentile,
      volShiftRatio: vsrNow,
      tailFlag,
      kurtosis,
      atrPct
    },
    dynamic: {
      direction,
      regimeAgeDays: regimeAgeDays || null
    },
    asOf: bars && bars.length ? bars[bars.length - 1].date : null,
    rationale
  };
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

  const mainSeries = loadMainSeries(
    runDir,
    filtered.meta && filtered.meta.runId ? filtered.meta.runId : null,
    keepCandidates.map((c) => c.symbol)
  );
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

      // 五模型预测区间（有行情品种专用：条件型/自适应模型）
      let finalCone = cone;
      let intervalModels = null;
      let currentState = null;
      let referenceInterval = null;
      let tailReturns = null;
      try {
        const historical = dataStore.loadHistoricalCache();
        const hc = historical && historical.contracts && historical.contracts[symbol];
        if (hc && hc.ohlcv && Array.isArray(hc.ohlcv.close) && hc.ohlcv.close.length >= 60) {
          tailReturns = logReturns(hc.ohlcv.close);
        }
      } catch {
        tailReturns = null;
      }
      try {
        const pi = computePredictionIntervals({
          bars: ohlcArray,
          close,
          hvAnnual: hvResult.hv,
          atr5,
          hvPercentile: percentile90d,
          tailReturns
        });
        if (pi && pi.referenceInterval && pi.referenceInterval.cone) {
          finalCone = pi.referenceInterval.cone;
          intervalModels = pi.intervalModels;
          currentState = pi.currentState;
          referenceInterval = {
            modelId: pi.referenceInterval.modelId,
            modelName: pi.referenceInterval.modelName,
            reason: pi.referenceInterval.reason
          };
          console.log(`  reference interval: ${referenceInterval.modelName} (${referenceInterval.modelId}) — ${referenceInterval.reason}`);
        } else {
          console.log('  ⚠️  prediction intervals unavailable → fallback GBM-HV cone');
        }
      } catch (err) {
        console.log(`  ⚠️  prediction intervals failed (${err.message}) → fallback GBM-HV cone`);
      }

      // Compare ATR band vs reference interval
      const atrBand = [close - 2 * atr5, close + 2 * atr5];
      const hvBand3d = finalCone['3d']['p95'];
      const comparison = compareBands(atrBand, hvBand3d);

      console.log(`  ATR 2× band: [${atrBand[0].toFixed(1)}, ${atrBand[1].toFixed(1)}]`);
      console.log(`  Reference divergence: ${comparison.divergencePct}%`);

      // 波动率 regime 契约（唯一生产者）
      const volatilityRegime = computeVolatilityRegime({
        close,
        atr5,
        hvAnnual: hvResult.hv,
        currentState,
        bars: ohlcArray
      });
      console.log(`  Volatility regime: ${volatilityRegime.grade} (${volatilityRegime.dynamic.direction})`);

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
        volatilityRegime,
        cone: finalCone,
        intervalModels,
        currentState,
        referenceInterval,
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
