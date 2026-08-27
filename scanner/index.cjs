#!/usr/bin/env node
/**
 * scanner/index.cjs — futures-radar Phase 4
 * Reads raw.json, computes volatility indicators, ranks candidates, outputs candidates.json.
 *
 * Usage:
 *   node scanner/index.cjs --runId 20260730-1701-auto
 */

const fs = require('fs');
const path = require('path');
const { runtimeRoot, skillRoot } = require('../lib/workspace.cjs');

// ── CLI ──────────────────────────────────────────────────────
const args = process.argv.slice(2);
const runIdIdx = args.indexOf('--runId');
const runId = runIdIdx >= 0 ? args[runIdIdx + 1] : null;
const runDirIdx = args.indexOf('--runDir');
const customRunDir = runDirIdx >= 0 ? args[runDirIdx + 1] : null;

if (!runId) {
  console.error('ERROR: --runId is required');
  process.exit(1);
}

const RUN_DIR = customRunDir || path.join(runtimeRoot, 'runs', runId);
const RAW_PATH = path.join(RUN_DIR, 'raw.json');
const RULES_PATH = path.join(skillRoot, 'filter', 'rules.json');

// ── Constants ─────────────────────────────────────────────────
const TRADING_DAYS = 242;

// ── Stats helpers ─────────────────────────────────────────────
function mean(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function std(arr, avg) {
  if (arr.length < 2) return 0;
  const m = avg ?? mean(arr);
  const variance = arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (idx - lo) * (sorted[hi] - sorted[lo]);
}

// ── Indicators ────────────────────────────────────────────────
function computeATR(high, low, close, period = 5) {
  const tr = [];
  for (let i = 1; i < close.length; i++) {
    tr.push(Math.max(
      high[i] - low[i],
      Math.abs(high[i] - close[i - 1]),
      Math.abs(low[i] - close[i - 1])
    ));
  }
  if (tr.length < period) return null;
  const recent = tr.slice(-period);
  return mean(recent);
}

function computeHV(close, period = 5) {
  // Annualized historical volatility from log returns
  const logRets = [];
  for (let i = 1; i < close.length; i++) {
    if (close[i - 1] <= 0 || close[i] <= 0) continue;
    logRets.push(Math.log(close[i] / close[i - 1]));
  }
  if (logRets.length < period) return null;
  const recent = logRets.slice(-period);
  return std(recent) * Math.sqrt(TRADING_DAYS);
}

function computeVolPercentile(close, currentHV5) {
  // Where does current HV(5) rank in 90-day rolling HV(5) windows?
  // For each 5-day window, compute HV, then find percentile
  if (close.length < 12 || currentHV5 == null) return null;
  const rollingHVs = [];
  // 6-day windows → 5 log returns needed for HV(5)
  for (let i = 6; i <= close.length; i++) {
    const slice = close.slice(i - 6, i);
    const hv = computeHV(slice, 5);
    if (hv != null && hv > 0) rollingHVs.push(hv);
  }
  if (rollingHVs.length < 10) return null;
  // Percentile: fraction of values <= current
  const count = rollingHVs.filter(hv => hv <= currentHV5).length;
  return (count / rollingHVs.length) * 100;
}

function computeVolMultiplier(volume, period = 5, basePeriod = 20) {
  if (volume.length < basePeriod) return null;
  const recent = volume.slice(-period);
  const base = volume.slice(-basePeriod - period, -period); // period before recent
  const avgRecent = mean(recent);
  const avgBase = mean(base.length >= period ? base : volume.slice(-basePeriod));
  if (avgBase === 0) return null;
  return avgRecent / avgBase;
}

function sma(arr, period) {
  if (arr.length < period) return null;
  return mean(arr.slice(-period));
}

// ── Main ──────────────────────────────────────────────────────
function main() {
  console.log(`=== futures-radar scan ===`);
  console.log(`runId: ${runId}`);

  if (!fs.existsSync(RAW_PATH)) {
    console.error(`ERROR: raw.json not found: ${RAW_PATH}`);
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(RAW_PATH, 'utf8'));
  const contracts = raw.contracts;
  const scannedAt = new Date().toISOString();

  // ── Pre-filter: turnover + OI thresholds (from rules.json) ──
  const RULES_PATH = path.join(skillRoot, 'filter', 'rules.json');
  if (!fs.existsSync(RULES_PATH)) {
    console.error(`ERROR: rules.json not found: ${RULES_PATH}`);
    process.exit(1);
  }
  const rulesConfig = JSON.parse(fs.readFileSync(RULES_PATH, 'utf8'));
  const turnoverRule = rulesConfig.rules.find(r => r.id === 'min_avg_turnover' && r.active);
  const oiRule = rulesConfig.rules.find(r => r.id === 'min_avg_oi' && r.active);

  if (!turnoverRule || !oiRule) {
    console.error('ERROR: min_avg_turnover or min_avg_oi rule missing/inactive in rules.json');
    process.exit(1);
  }

  const MIN_TURNOVER = turnoverRule.value;
  const MIN_OI = oiRule.value;

  const preFiltered = [];
  const preFilterRejects = [];

  for (const [sym, c] of Object.entries(contracts)) {
    const d = c.derived;
    if (d.avgTurnover5d != null && d.avgTurnover5d < MIN_TURNOVER) {
      preFilterRejects.push({ symbol: sym, name: c.name, reason: `avgTurnover5d=${(d.avgTurnover5d / 1e8).toFixed(2)}亿 < 1亿` });
      continue;
    }
    if (d.avgOI5d != null && d.avgOI5d < MIN_OI) {
      preFilterRejects.push({ symbol: sym, name: c.name, reason: `avgOI5d=${Math.round(d.avgOI5d).toLocaleString()}手 < 1万手` });
      continue;
    }
    preFiltered.push(c);
  }

  console.log(`Pre-filter: ${preFiltered.length}/${Object.keys(contracts).length} pass (${preFilterRejects.length} rejected)`);
  for (const r of preFilterRejects) {
    console.log(`  ✗ ${r.name} (${r.symbol}): ${r.reason}`);
  }

  // ── Compute indicators ─────────────────────────────────────
  const scored = [];

  for (const c of preFiltered) {
    const o = c.ohlcv;
    const d = c.derived;

    const atr5 = computeATR(o.high, o.low, o.close, 5);
    const atrPct = atr5 != null && o.close.length > 0 ? (atr5 / o.close[o.close.length - 1]) * 100 : null;
    const hv5 = computeHV(o.close, 5);
    const hv20 = computeHV(o.close, 20);
    const volPct = computeVolPercentile(o.close, hv5);
    const volMult = computeVolMultiplier(o.volume, 5, 20);

    // Trend position (relative to 20/60 MA)
    const ma20 = sma(o.close, 20);
    const ma60 = sma(o.close, 60);
    const lastClose = o.close[o.close.length - 1];
    const vsMA20 = ma20 != null && ma20 !== 0 ? ((lastClose / ma20 - 1) * 100) : null;
    const vsMA60 = ma60 != null && ma60 !== 0 ? ((lastClose / ma60 - 1) * 100) : null;

    // Direction from 5d return
    const change5d = d.change5d;

    scored.push({
      symbol: c.symbol,
      name: c.name,
      exchange: c.exchange,
      sector: c.sector,
      indicators: {
        atr5: atr5 != null ? parseFloat(atr5.toFixed(4)) : null,
        atrPct: atrPct != null ? parseFloat(atrPct.toFixed(4)) : null,
        hv5: hv5 != null ? parseFloat(hv5.toFixed(4)) : null,
        hv20: hv20 != null ? parseFloat(hv20.toFixed(4)) : null,
        volPercentile: volPct != null ? parseFloat(volPct.toFixed(2)) : null,
        volMultiplier: volMult != null ? parseFloat(volMult.toFixed(4)) : null,
        change5d: change5d
      },
      trend: {
        close: lastClose,
        vsMA20: vsMA20 != null ? parseFloat(vsMA20.toFixed(2)) : null,
        vsMA60: vsMA60 != null ? parseFloat(vsMA60.toFixed(2)) : null,
        direction: change5d != null ? (change5d > 0 ? 'up' : change5d < 0 ? 'down' : 'flat') : 'unknown'
      },
      liquidity: {
        avgVolume5d: d.avgVolume5d,
        avgTurnover5d: d.avgTurnover5d,
        avgOI5d: d.avgOI5d
      },
      score: null // computed below
    });
  }

  console.log(`Indicators computed: ${scored.length} contracts`);

  // ── Scoring: 趋势中段筛选（非极值） ───────────────────────

  /**
   * 波动率质量分 (0-1)
   * 甜蜜区：P60-P85 (满分)
   * 惩罚：P<50 (低波动) 和 P>90 (极值反转风险)
   */
  function scoreVolatilityQuality(volPct) {
    if (volPct == null) return 0;
    if (volPct < 50) return volPct / 100;  // 低波动线性递增
    if (volPct >= 60 && volPct <= 85) return 1.0;  // 甜蜜区满分
    if (volPct > 85) return Math.max(0, 1.0 - (volPct - 85) / 15);  // P>85线性衰减
    return volPct / 100;  // P50-60过渡
  }

  /**
   * 趋势稳定分 (0-1)
   * 甜蜜区：MA偏离3-8% (温和趋势)
   * 惩罚：<3% (趋势太弱) 和 >8% (超买超卖)
   */
  function scoreTrendStability(vsMA20) {
    if (vsMA20 == null) return 0.3;
    const maDev = Math.abs(vsMA20);
    if (maDev < 3) return 0.3;  // 趋势太弱
    if (maDev >= 3 && maDev <= 8) return 1.0;  // 甜蜜区
    if (maDev > 8) return Math.max(0, 1.0 - (maDev - 8) / 10);  // 偏离过大线性扣分
    return 0.5;
  }

  /**
   * 动量持续分 (0-1.3)
   * 甜蜜区：5日涨幅3-6% (温和加速)
   * 惩罚：<2% (动量不足) 和 >8% (末端加速)
   * 加分：成交量确认 (+0.3)
   */
  function scoreMomentumContinuity(change5d, volMult) {
    if (change5d == null) return 0.2;
    const absChange = Math.abs(change5d);
    let score = 0;

    if (absChange < 2) score = 0.2;  // 动量不足
    else if (absChange >= 3 && absChange <= 6) score = 1.0;  // 甜蜜区
    else if (absChange > 8) score = 0.3;  // 加速末端
    else score = 0.6;  // 2-3% 或 6-8% 过渡

    // 成交量确认加分
    if (volMult != null && volMult > 1.5) score += 0.3;

    return Math.min(1.3, score);
  }

  /**
   * 流动性分 (0-1)
   * 基于成交额和持仓量
   */
  function scoreLiquidity(avgTurnover5d, avgOI5d) {
    let score = 0;

    // 成交额评分 (0-0.5)
    if (avgTurnover5d != null) {
      if (avgTurnover5d >= 50e8) score += 0.5;
      else if (avgTurnover5d >= 20e8) score += 0.4;
      else if (avgTurnover5d >= 10e8) score += 0.3;
      else if (avgTurnover5d >= 5e8) score += 0.2;
      else score += 0.1;
    }

    // 持仓量评分 (0-0.5)
    if (avgOI5d != null) {
      if (avgOI5d >= 200000) score += 0.5;
      else if (avgOI5d >= 100000) score += 0.4;
      else if (avgOI5d >= 50000) score += 0.3;
      else if (avgOI5d >= 20000) score += 0.2;
      else score += 0.1;
    }

    return score;
  }

  // ── 为每个品种计算分数 ─────────────────────────────────────
  for (const s of scored) {
    const volScore = scoreVolatilityQuality(s.indicators.volPercentile);
    const trendScore = scoreTrendStability(s.trend.vsMA20);
    const momentumScore = scoreMomentumContinuity(s.indicators.change5d, s.indicators.volMultiplier);
    const liqScore = scoreLiquidity(s.liquidity.avgTurnover5d, s.liquidity.avgOI5d);

    // 综合评分 = 波动率质量35% + 趋势稳定30% + 动量持续20% + 流动性15%
    s.score = parseFloat((
      volScore * 0.35 +
      trendScore * 0.30 +
      momentumScore * 0.20 +
      liqScore * 0.15
    ).toFixed(4));

    s.scoreBreakdown = {
      volatilityQuality: parseFloat(volScore.toFixed(4)),
      trendStability: parseFloat(trendScore.toFixed(4)),
      momentumContinuity: parseFloat(momentumScore.toFixed(4)),
      liquidity: parseFloat(liqScore.toFixed(4))
    };
  }

  // ── Rank ───────────────────────────────────────────────────
  scored.sort((a, b) => b.score - a.score);
  const top10 = scored.slice(0, 10);

  // Assign ranks
  top10.forEach((s, i) => { s.rank = i + 1; });

  // ── Output candidates.json ─────────────────────────────────
  const output = {
    meta: {
      runId,
      scannedAt,
      pipelineVersion: '0.1.0',
      preFilter: {
        total: Object.keys(contracts).length,
        passed: preFiltered.length,
        rejected: preFilterRejects.length,
        criteria: {
          minAvgTurnover: turnoverRule.displayValue,
          minAvgOI: oiRule.displayValue
        }
      },
      scoring: {
        formula: 'volatilityQuality×0.35 + trendStability×0.30 + momentumContinuity×0.20 + liquidity×0.15',
        sweetSpots: {
          volatility: 'P60-P85 (punish P>90 extremes)',
          trend: 'MA deviation 3-8% (punish >8% overbought/oversold)',
          momentum: '5d return 3-6% (punish >8% acceleration)'
        },
        tradingDaysPerYear: TRADING_DAYS
      }
    },
    candidates: top10,
    preFilterRejects,
    allScored: scored.map(s => ({
      rank: null, // only top 10 get ranks
      symbol: s.symbol,
      name: s.name,
      sector: s.sector,
      score: s.score,
      indicators: s.indicators,
      trend: s.trend
    })).sort((a, b) => b.score - a.score)
  };

  const outPath = path.join(RUN_DIR, 'candidates.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`candidates.json → ${outPath}`);

  // ── Summary ────────────────────────────────────────────────
  console.log(`\n=== SCAN COMPLETE ===`);
  console.log(`${preFiltered.length} qualified → Top ${top10.length} candidates`);
  console.log(`\nTop 10:`);
  for (const c of top10) {
    const dir = c.trend.direction === 'up' ? '↑' : c.trend.direction === 'down' ? '↓' : '→';
    const ch5 = c.indicators.change5d != null ? `${c.indicators.change5d > 0 ? '+' : ''}${c.indicators.change5d}%` : '-';
    const volP = c.indicators.volPercentile != null ? `${c.indicators.volPercentile}%ile` : '-';
    console.log(`  #${c.rank} ${c.name} (${c.symbol}) score=${(c.score * 100).toFixed(1)} ${dir} ch5d=${ch5} vol=${volP}`);
  }

  process.exit(0);
}

main();
