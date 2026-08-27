#!/usr/bin/env node
/**
 * filter/quantitative-filter.cjs — Stage 3b 量化筛选
 *
 * 功能：
 * - 读取 filtered-hard.json（≤10个候选）
 * - 读取 candidates.json（完整指标数据）
 * - 4维量化评分：波动率质量、趋势确认、流动性深度、板块联动
 * - 输出 filtered.json（≤3个KEEP + 降级列表）
 *
 * 设计原则：
 * - 纯技术指标，不依赖外部数据（宏观新闻/基本面）
 * - 可回测验证，参数可调优
 * - 避免主观判断，每个分数有明确计算公式
 *
 * Usage:
 *   node filter/quantitative-filter.cjs --runId 20260730-1701-auto
 *   node filter/quantitative-filter.cjs --runId bt-20250117 --runDir backtest/runs/bt-20250117
 *   node filter/quantitative-filter.cjs --runId 20260730-1701-auto --shadow
 *     # shadow 模式：写 filtered.quant.json，绝不覆盖 LLM 的 filtered.json
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
const shadow = args.includes('--shadow');

if (!runId) {
  console.error('ERROR: --runId is required');
  process.exit(1);
}

const RUN_DIR = customRunDir || path.join(runtimeRoot, 'runs', runId);
const FILTERED_HARD_PATH = path.join(RUN_DIR, 'filtered-hard.json');
const CANDIDATES_PATH = path.join(RUN_DIR, 'candidates.json');

// ── 评分函数 ────────────────────────────────────────────────

/**
 * A. 波动率质量评分 (0-10)
 */
function scoreVolatilityQuality(indicators) {
  const volPct = indicators.volPercentile;
  if (volPct == null) return 0;

  let score = volPct / 10; // 基础分：85% → 8.5

  // 调整项
  if (volPct >= 60 && volPct <= 90) {
    score += 1; // 高但不极端
  }
  if (volPct > 95) {
    score -= 2; // 极端波动难预测
  }

  // HV加速（近期波动>长期波动）
  const hvRatio = indicators.hv5 && indicators.hv20 ? indicators.hv5 / indicators.hv20 : 1;
  if (hvRatio > 1.2) {
    score += 0.5;
  }

  return Math.max(0, Math.min(10, score));
}

/**
 * B. 趋势确认评分 (0-10)
 */
function scoreTrendConfirmation(indicators, trend) {
  let score = 0;

  // 均线排列
  const ma20 = trend.vsMA20;
  const ma60 = trend.vsMA60;

  if (ma20 != null && ma60 != null) {
    if ((ma20 > 0 && ma60 > 0) || (ma20 < 0 && ma60 < 0)) {
      score += 6; // 同向=趋势
    } else {
      score += 2; // 反向=震荡
    }
  }

  // 动量加分
  const change5d = indicators.change5d;
  if (change5d != null && Math.abs(change5d) > 3) {
    score += 2; // 明确方向
  }

  const volMult = indicators.volMultiplier;
  if (volMult != null && volMult > 1.5) {
    score += 2; // 成交量确认
  }

  // 风险扣分：偏离均线过远
  if (ma20 != null && Math.abs(ma20) > 15) {
    score -= 3;
  }

  return Math.max(0, Math.min(10, score));
}

/**
 * C. 流动性深度评分 (0-10)
 */
function scoreLiquidityDepth(liquidity) {
  let score = 0;

  // 成交额评分 (0-5)
  const turnover = liquidity.avgTurnover5d;
  if (turnover != null) {
    if (turnover >= 10e8) score += 5;
    else if (turnover >= 5e8) score += 4;
    else if (turnover >= 2e8) score += 3;
    else score += 1;
  }

  // 持仓量评分 (0-5)
  const oi = liquidity.avgOI5d;
  if (oi != null) {
    if (oi >= 100000) score += 5;
    else if (oi >= 50000) score += 4;
    else if (oi >= 30000) score += 3;
    else score += 1;
  }

  return Math.max(0, Math.min(10, score));
}

/**
 * D. 板块联动评分 (0-10)
 * 检查同板块Top 10中同向移动的品种数量
 */
function scoreSectorMomentum(candidate, allCandidates) {
  const sector = candidate.sector;
  const direction = candidate.trend.direction;

  if (!sector || direction === 'flat' || direction === 'unknown') {
    return 2; // 方向不明确或无板块信息
  }

  // 统计同板块同向移动的品种
  const sectorSymbols = allCandidates.filter(c =>
    c.sector === sector &&
    c.symbol !== candidate.symbol &&
    c.trend.direction === direction
  );

  const count = sectorSymbols.length;

  if (count >= 3) return 8; // 板块行情
  if (count === 2) return 5; // 部分联动
  if (count === 1) return 2; // 孤立波动
  return 2; // 完全孤立
}

/**
 * 综合评分
 */
function calculateOverallScore(candidate, allCandidates) {
  const scoreA = scoreVolatilityQuality(candidate.indicators);
  const scoreB = scoreTrendConfirmation(candidate.indicators, candidate.trend);
  const scoreC = scoreLiquidityDepth(candidate.liquidity);
  const scoreD = scoreSectorMomentum(candidate, allCandidates);

  const overall = scoreA * 0.30 + scoreB * 0.35 + scoreC * 0.15 + scoreD * 0.20;

  return {
    overall: parseFloat(overall.toFixed(2)),
    breakdown: {
      volatilityQuality: parseFloat(scoreA.toFixed(2)),
      trendConfirmation: parseFloat(scoreB.toFixed(2)),
      liquidityDepth: parseFloat(scoreC.toFixed(2)),
      sectorMomentum: parseFloat(scoreD.toFixed(2))
    }
  };
}

/**
 * 方向判定（纯技术）
 */
function determineDirection(indicators, trend) {
  const change5d = indicators.change5d || 0;
  const ma20 = trend.vsMA20 || 0;
  const ma60 = trend.vsMA60 || 0;
  const volMult = indicators.volMultiplier || 1;

  let direction = 'neutral';
  let confidenceBoost = 0;

  // 多头/空头排列
  if (change5d > 0 && ma20 > 0 && ma60 > 0) {
    direction = 'bullish';
    confidenceBoost = 0.5;
  } else if (change5d < 0 && ma20 < 0 && ma60 < 0) {
    direction = 'bearish';
    confidenceBoost = 0.5;
  }
  // 强势突破（无均线确认）
  else if (Math.abs(change5d) > 5 && volMult > 2.0) {
    direction = change5d > 0 ? 'bullish' : 'bearish';
    confidenceBoost = 0;
  }
  // 方向不明确
  else {
    direction = 'neutral';
    confidenceBoost = -1.0;
  }

  return { direction, confidenceBoost };
}

/**
 * 置信度判定
 */
function determineConfidence(overallScore, confidenceBoost) {
  let adjustedScore = overallScore + confidenceBoost;

  if (adjustedScore >= 7.5) return 'high';
  if (adjustedScore >= 6.0) return 'medium';
  if (adjustedScore >= 5.0) return 'low';
  return 'very_low';
}

// ── Main ──────────────────────────────────────────────────────
function main() {
  console.log(`=== futures-radar quantitative filter ===`);
  console.log(`runId: ${runId}`);

  // Load inputs
  if (!fs.existsSync(FILTERED_HARD_PATH)) {
    console.error(`ERROR: filtered-hard.json not found: ${FILTERED_HARD_PATH}`);
    process.exit(1);
  }
  if (!fs.existsSync(CANDIDATES_PATH)) {
    console.error(`ERROR: candidates.json not found: ${CANDIDATES_PATH}`);
    process.exit(1);
  }

  const filteredHard = JSON.parse(fs.readFileSync(FILTERED_HARD_PATH, 'utf8'));
  const candidatesData = JSON.parse(fs.readFileSync(CANDIDATES_PATH, 'utf8'));

  const passedSymbols = filteredHard.passed.map(p => p.symbol);

  // 只评估通过硬过滤的候选（Iron Rule）
  const candidates = candidatesData.candidates.filter(c => passedSymbols.includes(c.symbol));

  console.log(`Evaluating ${candidates.length} candidates\n`);

  const evaluated = [];

  for (const c of candidates) {
    const scores = calculateOverallScore(c, candidates);
    const { direction, confidenceBoost } = determineDirection(c.indicators, c.trend);
    const confidence = determineConfidence(scores.overall, confidenceBoost);

    console.log(`  ${c.symbol} ${c.name} (rank=${c.rank}, scoreRaw=${(c.score * 100).toFixed(1)})`);
    console.log(`    Overall: ${scores.overall.toFixed(2)} | Vol:${scores.breakdown.volatilityQuality} Trend:${scores.breakdown.trendConfirmation} Liq:${scores.breakdown.liquidityDepth} Sector:${scores.breakdown.sectorMomentum}`);
    console.log(`    Direction: ${direction} | Confidence: ${confidence}`);

    evaluated.push({
      symbol: c.symbol,
      name: c.name,
      rank: c.rank,
      scoreRaw: c.score,
      scoreQuant: scores.overall,
      scoreBreakdown: scores.breakdown,
      direction,
      confidence,
      confidenceBoost,
      indicators: c.indicators,
      trend: c.trend,
      liquidity: c.liquidity
    });
  }

  // 按量化得分排序
  evaluated.sort((a, b) => b.scoreQuant - a.scoreQuant);

  // 决策：KEEP vs DOWNGRADE
  const kept = [];
  const downgraded = [];

  for (const e of evaluated) {
    if (e.scoreQuant >= 5.0 && e.confidence !== 'very_low') {
      kept.push({
        symbol: e.symbol,
        name: e.name,
        rank: e.rank,
        decision: 'KEEP',
        confidence: e.confidence,
        directionBias: e.direction,
        scoreQuant: e.scoreQuant,
        scoreBreakdown: e.scoreBreakdown,
        summary: `量化得分${e.scoreQuant.toFixed(1)}，方向${e.direction}，置信度${e.confidence}`
      });
    } else {
      downgraded.push({
        symbol: e.symbol,
        name: e.name,
        reason: e.scoreQuant < 5.0 ? '量化得分过低(<5.0)' : '置信度过低(very_low)',
        scoreQuant: e.scoreQuant,
        note: `Vol:${e.scoreBreakdown.volatilityQuality} Trend:${e.scoreBreakdown.trendConfirmation} Liq:${e.scoreBreakdown.liquidityDepth} Sector:${e.scoreBreakdown.sectorMomentum}`
      });
    }
  }

  // 限制KEEP数量≤3
  const finalKept = kept.slice(0, 3);
  const extraDowngraded = kept.slice(3).map(k => ({
    symbol: k.symbol,
    name: k.name,
    reason: '超出Top 3限制',
    scoreQuant: k.scoreQuant,
    note: k.summary
  }));

  // ── Output ─────────────────────────────────────────────────
  const output = {
    meta: {
      runId,
      filteredAt: new Date().toISOString(),
      pipelineVersion: '0.1.0',
      filterType: shadow ? 'quantitative-shadow' : 'quantitative',
      mode: shadow ? 'shadow' : 'default',
      inputCount: candidates.length,
      outputCount: finalKept.length,
      hardFilterRejectsImmutable: true
    },
    candidates: finalKept,
    downgraded: [...downgraded, ...extraDowngraded]
  };

  // shadow 模式只写 filtered.quant.json，绝对不碰 filtered.json（LLM 边界保持权威）
  const outPath = path.join(RUN_DIR, shadow ? 'filtered.quant.json' : 'filtered.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\n${path.basename(outPath)} → ${outPath}`);

  // ── Summary ────────────────────────────────────────────────
  console.log(`\n=== FILTER COMPLETE${shadow ? ' (SHADOW)' : ''} ===`);
  console.log(`${finalKept.length} KEEP / ${downgraded.length + extraDowngraded.length} downgraded (from ${candidates.length} candidates)`);

  if (finalKept.length > 0) {
    console.log(`\nKEEP:`);
    for (const k of finalKept) {
      const dir = k.directionBias === 'bullish' ? '↑' : k.directionBias === 'bearish' ? '↓' : '→';
      console.log(`  ✓ #${k.rank} ${k.name} (${k.symbol}) ${dir} score=${k.scoreQuant.toFixed(1)} conf=${k.confidence}`);
    }
  }

  if (downgraded.length + extraDowngraded.length > 0) {
    console.log(`\nDowngraded:`);
    for (const d of [...downgraded, ...extraDowngraded]) {
      console.log(`  ✗ ${d.name} (${d.symbol}): ${d.reason}`);
    }
  }

  process.exit(0);
}

main();
