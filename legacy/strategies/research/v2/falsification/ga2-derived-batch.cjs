#!/usr/bin/env node
/**
 * ga2-derived-batch.cjs — GA-2 全品种派生指标批量计算
 *
 * 对 data/daily 全品种日线批量派生（滚动序列 + T 日快照），PIT/F8：只用 ≤T 数据。
 * 派生字段（口径与库内既有组件一致）：
 *   - ATR5       TR[i]=max(H-L,|H-C[i-1]|,|L-C[i-1]|)（i=0 用 H-L），ATR5=近 5 根 TR 均值
 *                （与 stage-4-5.cjs computeATRFromBars / scanner 同口径）
 *   - HV20       Yang-Zhang 20d 年化（242 交易日），probability/hv-estimators.js
 *   - HVpct90    90 日 HV 百分位（0-100），hvPercentile（需 ≥110 bars）
 *   - MA20/MA60  简单均线
 *   - volumeRatio 量比 = vol[i]/mean(vol[i-4..i])（5 日均量，与 strategy-matcher 同口径）
 *   - cones      3d/5d p68/p95（probability-cone.js，cap-6：provenance=probability.json 口径）
 *
 * 输出：strategies/research/v2/falsification/data/ga2-derived/<SYM>.json
 *      + strategies/research/v2/falsification/data/ga2-derived-index.json
 *
 * Usage:
 *   node strategies/research/v2/falsification/ga2-derived-batch.cjs [--symbols RB0,M0]
 */

const fs = require('fs');
const path = require('path');

const SKILL_ROOT = path.join(__dirname, '../../../..');
const DAILY_DIR = path.join(SKILL_ROOT, 'data', 'daily');
const OUT_DIR = path.join(__dirname, 'data', 'ga2-derived');
const INDEX_PATH = path.join(__dirname, 'data', 'ga2-derived-index.json');
const ROLL_JUMPS_PATH = path.join(__dirname, 'data', 'ga1-roll-jumps.json');

const { autoEstimateHV, hvPercentile } = require(path.join(SKILL_ROOT, 'probability', 'hv-estimators.js'));
const { probabilityCone } = require(path.join(SKILL_ROOT, 'probability', 'probability-cone.js'));

const SCHEMA = 'falsification-ga2-derived/1';
const PROVENANCE = {
  atr5: { formula: 'TR=max(H-L,|H-Cprev|,|L-Cprev|); ATR5=mean(last 5 TR)', window: 5, source: 'data/daily ohlcv' },
  hv20: { estimator: 'yang_zhang', window: 20, annualized: true, annualizeFactor: 242, lib: 'probability/hv-estimators.js' },
  hvPct90: { definition: '当前 HV20 在近 90 个滚动 HV20 中的百分位 (0-100)', window: 90, needsBars: 110, lib: 'probability/hv-estimators.js hvPercentile' },
  ma20: { formula: 'SMA(close,20)' },
  ma60: { formula: 'SMA(close,60)' },
  volumeRatio: { formula: 'vol[i]/mean(vol[i-4..i])', window: 5, source: 'strategy-matcher.cjs 量比口径' },
  cones: { lib: 'probability/probability-cone.js', horizons: [3, 5], zScores: { p68: 1.0, p95: 1.96 }, provenance: 'probability.json 派生管线（cap-6 目标定价口径）' }
};

function mean(arr) {
  if (!arr.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}
const r4 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10000) / 10000);
const r2 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);

function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--symbols');
  const only = i >= 0 ? new Set(args[i + 1].split(',').map((s) => s.trim()).filter(Boolean)) : null;
  const t0 = Date.now();

  fs.mkdirSync(OUT_DIR, { recursive: true });

  let rollJumps = {};
  try {
    const rj = JSON.parse(fs.readFileSync(ROLL_JUMPS_PATH, 'utf8'));
    rollJumps = rj.bySymbol || {};
  } catch (e) {
    console.warn(`⚠️ ga1-roll-jumps.json 不可读（跳过 roll-jump 附注）: ${e.message}`);
  }

  const files = fs.readdirSync(DAILY_DIR).filter((f) => f.endsWith('.json') && !f.startsWith('_')).sort();
  const index = { schema: 'falsification-ga2-derived-index/1', computedAt: new Date().toISOString(), symbols: {} };
  let processed = 0;

  for (const file of files) {
    const symbol = file.slice(0, -5);
    if (only && !only.has(symbol)) continue;

    const wrapper = JSON.parse(fs.readFileSync(path.join(DAILY_DIR, file), 'utf8'));
    const o = wrapper.contract && wrapper.contract.ohlcv;
    if (!o || !Array.isArray(o.dates) || o.dates.length === 0) {
      console.warn(`⚠️ ${symbol}: empty daily series, skipped`);
      continue;
    }
    const n = o.dates.length;
    const dates = o.dates;
    const open = o.open, high = o.high, low = o.low, close = o.close, volume = o.volume;

    // bar 对象数组（HV 组件输入格式）
    const bars = new Array(n);
    for (let k = 0; k < n; k++) {
      bars[k] = { date: dates[k], open: open[k], high: high[k], low: low[k], close: close[k] };
    }

    const atr5 = new Array(n).fill(null);
    const ma20 = new Array(n).fill(null);
    const ma60 = new Array(n).fill(null);
    const volRatio = new Array(n).fill(null);
    const hv20 = new Array(n).fill(null);
    const hvPct90 = new Array(n).fill(null);

    let sumTR5 = 0;
    const tr5buf = new Array(5).fill(0);
    let tr5pos = 0, tr5cnt = 0;
    let sum20 = 0, sum60 = 0, sumV5 = 0;
    const v5buf = new Array(5).fill(0);
    let v5pos = 0, v5cnt = 0;

    for (let k = 0; k < n; k++) {
      // TR（i=0：H-L）
      const tr = k === 0
        ? high[k] - low[k]
        : Math.max(high[k] - low[k], Math.abs(high[k] - close[k - 1]), Math.abs(low[k] - close[k - 1]));

      // ATR5 环形窗口（不四舍五入：小 ATR 品种 4 位小数会引入 >1e-6 相对误差）
      if (tr5cnt === 5) { sumTR5 -= tr5buf[tr5pos]; } else { tr5cnt++; }
      tr5buf[tr5pos] = tr; sumTR5 += tr; tr5pos = (tr5pos + 1) % 5;
      if (tr5cnt === 5) atr5[k] = sumTR5 / 5;

      // MA20/MA60（增量）
      sum20 += close[k]; sum60 += close[k];
      if (k >= 20) sum20 -= close[k - 20];
      if (k >= 60) sum60 -= close[k - 60];
      if (k >= 19) ma20[k] = r4(sum20 / 20);
      if (k >= 59) ma60[k] = r4(sum60 / 60);

      // 量比（5 日均量；不四舍五入——比值可为 1e-6 量级，舍入会引入 >1e-6 相对误差）
      if (v5cnt === 5) { sumV5 -= v5buf[v5pos]; } else { v5cnt++; }
      v5buf[v5pos] = volume[k]; sumV5 += volume[k]; v5pos = (v5pos + 1) % 5;
      if (v5cnt === 5 && sumV5 > 0) volRatio[k] = volume[k] / (sumV5 / 5);

      // HV20（Yang-Zhang，需 21 bars；不四舍五入保持全精度）
      if (k >= 20) {
        const res = autoEstimateHV(bars.slice(k - 20, k + 1), 20);
        hv20[k] = res.hv;
      }

      // HVpct90（需 110 bars）
      if (k >= 109) {
        try {
          const p = hvPercentile(bars.slice(0, k + 1), 20);
          hvPct90[k] = r2(p.percentile);
        } catch (e) {
          hvPct90[k] = null; // 数据不足或校验失败
        }
      }
    }

    const last = n - 1;
    const snapHv = hv20[last];
    const cones = snapHv != null && close[last] > 0
      ? probabilityCone(close[last], snapHv, [3, 5], [1.0, 1.96])
      : null;

    const snapshot = {
      asOfDate: dates[last],
      close: r2(close[last]),
      atr5: atr5[last],
      hv20: hv20[last],
      hvPct90: hvPct90[last],
      ma20: ma20[last],
      ma60: ma60[last],
      volumeRatio: volRatio[last],
      cones
    };

    const out = {
      schema: SCHEMA,
      symbol,
      computedAt: new Date().toISOString(),
      sourceSeries: 'data/daily/' + file,
      sourceRunId: wrapper.lastRunId || null,
      provenance: PROVENANCE,
      note: 'F8/滚动估计：每个 bar 的派生值只用 ≤该 bar 的数据计算（PIT）。换月跳变 bar（F5,|r|≥9.5%）未剔除，消费者按 ga1-roll-jumps.json 剔除。',
      bars: n,
      rollJumpDates: (rollJumps[symbol] || []).map((j) => j.date),
      snapshot,
      series: { dates, atr5, hv20, hvPct90, ma20, ma60, volumeRatio: volRatio }
    };
    fs.writeFileSync(path.join(OUT_DIR, `${symbol}.json`), JSON.stringify(out));

    index.symbols[symbol] = {
      symbol,
      asOfDate: snapshot.asOfDate,
      bars: n,
      atr5: snapshot.atr5,
      hv20: snapshot.hv20,
      hvPct90: snapshot.hvPct90,
      ma20: snapshot.ma20,
      ma60: snapshot.ma60,
      volumeRatio: snapshot.volumeRatio,
      cones: snapshot.cones
    };
    processed++;
  }

  fs.writeFileSync(INDEX_PATH, JSON.stringify(index));
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`=== GA-2 Derived Batch Summary ===`);
  console.log(`processed=${processed} files outDir=${OUT_DIR} elapsed=${elapsed}s`);
  const missing = Object.values(index.symbols).filter((s) => s.hvPct90 == null || s.hv20 == null || s.atr5 == null).map((s) => s.symbol);
  console.log(`symbols with any null snapshot field: ${missing.length > 0 ? missing.join(',') : 'none'}`);
}

main();
