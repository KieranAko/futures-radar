#!/usr/bin/env node
/**
 * filter/hard-filter.cjs — futures-radar Phase 5 (Stage 3a)
 * Reads candidates.json + raw.json + filter/rules.json, applies deterministic hard filters,
 * outputs filtered-hard.json.
 *
 * Usage:
 *   node filter/hard-filter.cjs --runId 20260730-1701-auto
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
const CANDIDATES_PATH = path.join(RUN_DIR, 'candidates.json');
const RAW_PATH = path.join(RUN_DIR, 'raw.json');
const RULES_PATH = path.join(skillRoot, 'filter', 'rules.json');

// ── Rule evaluators ────────────────────────────────────────────

function evaluateMinTurnover(candidate, rule) {
  const val = candidate.liquidity?.avgTurnover5d;
  if (val == null) return { pass: false, reason: 'avgTurnover5d missing (data gap)' };
  if (val < rule.value) {
    const actual = val >= 1e8 ? `${(val / 1e8).toFixed(2)}亿` : `${Math.round(val).toLocaleString()}元`;
    return { pass: false, reason: `日均成交额 ${actual} 低于 ${rule.displayValue}` };
  }
  return { pass: true };
}

function evaluateMinOI(candidate, rule) {
  const val = candidate.liquidity?.avgOI5d;
  if (val == null) return { pass: false, reason: 'avgOI5d missing (data gap)' };
  if (val < rule.value) {
    return { pass: false, reason: `日均持仓 ${Math.round(val).toLocaleString()}手 低于 ${rule.displayValue}` };
  }
  return { pass: true };
}

function isLimitLockDay(ohlcv, dayIdx, limitRatioThreshold, amplitudeMax) {
  // A day is "likely limit-locked" if amplitude ≈ 0 AND |change| is large
  if (dayIdx < 1) return false;
  const high = ohlcv.high[dayIdx];
  const low = ohlcv.low[dayIdx];
  const settle = ohlcv.settle[dayIdx] || ohlcv.close[dayIdx];
  const prevSettle = ohlcv.settle[dayIdx - 1] || ohlcv.close[dayIdx - 1];

  if (!settle || !prevSettle || settle === 0 || prevSettle === 0) return false;

  const amplitude = (high - low) / settle;
  const change = (settle - prevSettle) / prevSettle;

  // Flag if amplitude is near zero but price moved significantly
  return amplitude < amplitudeMax && Math.abs(change) > limitRatioThreshold;
}

function evaluateNotAtLimit(candidate, ohlcv, rule) {
  // Check the most recent day for limit lock
  const n = ohlcv.close.length;
  if (n < 2) return { pass: false, reason: 'insufficient data for limit lock check' };

  const lastIdx = n - 1;
  if (isLimitLockDay(ohlcv, lastIdx, rule.limit_ratio_threshold, rule.amplitude_max)) {
    const chg = candidate.indicators.change5d ?? '?';
    const high = ohlcv.high[lastIdx];
    const low = ohlcv.low[lastIdx];
    const settle = ohlcv.settle[lastIdx] || ohlcv.close[lastIdx];
    const amp = settle > 0 ? ((high - low) / settle * 100).toFixed(2) : '?';
    return { pass: false, reason: `疑似涨跌停封板：涨跌幅=${chg}%，振幅=${amp}%` };
  }
  return { pass: true };
}

function evaluateNoConsecutiveLimit(candidate, ohlcv, rule, limitLockRule) {
  const n = ohlcv.close.length;
  const days = rule.consecutive_days;
  if (n < days + 1) return { pass: true }; // insufficient data, let it through

  // Use limit_ratio_threshold and amplitude_max from not_at_limit_lock rule
  const limitRatio = limitLockRule?.limit_ratio_threshold ?? 0.03;
  const ampMax = limitLockRule?.amplitude_max ?? 0.01;

  let consecutiveCount = 0;
  for (let i = n - days; i < n; i++) {
    if (isLimitLockDay(ohlcv, i, limitRatio, ampMax)) {
      consecutiveCount++;
    } else {
      consecutiveCount = 0;
    }
  }

  if (consecutiveCount >= 2) {
    return { pass: false, reason: `近${days}日存在连续涨跌停封板 (${consecutiveCount}天)` };
  }
  return { pass: true };
}

// ── Main ──────────────────────────────────────────────────────
function main() {
  console.log(`=== futures-radar hard filter ===`);
  console.log(`runId: ${runId}`);

  // Load inputs
  if (!fs.existsSync(CANDIDATES_PATH)) {
    console.error(`ERROR: candidates.json not found: ${CANDIDATES_PATH}`);
    process.exit(1);
  }
  if (!fs.existsSync(RAW_PATH)) {
    console.error(`ERROR: raw.json not found: ${RAW_PATH}`);
    process.exit(1);
  }
  if (!fs.existsSync(RULES_PATH)) {
    console.error(`ERROR: rules.json not found: ${RULES_PATH}`);
    process.exit(1);
  }

  const candidates = JSON.parse(fs.readFileSync(CANDIDATES_PATH, 'utf8'));
  const raw = JSON.parse(fs.readFileSync(RAW_PATH, 'utf8'));
  const rulesConfig = JSON.parse(fs.readFileSync(RULES_PATH, 'utf8'));

  const activeRules = rulesConfig.rules.filter(r => r.active);
  const inactiveRules = rulesConfig.rules.filter(r => !r.active);

  // Find limit lock rule for threshold sharing
  const limitLockRule = rulesConfig.rules.find(r => r.id === 'not_at_limit_lock');

  console.log(`Active rules: ${activeRules.map(r => r.id).join(', ')}`);
  console.log(`Deferred rules: ${inactiveRules.map(r => r.id).join(', ')}`);
  console.log(`Candidates: ${candidates.candidates.length}\n`);

  const filteredAt = new Date().toISOString();
  const passed = [];
  const rejected = [];

  for (const c of candidates.candidates) {
    const contract = raw.contracts[c.symbol];
    const ohlcv = contract?.ohlcv;
    const reasons = [];

    console.log(`  ${c.symbol} ${c.name} (score=${(c.score * 100).toFixed(1)})`);

    let allPassed = true;

    for (const rule of activeRules) {
      let result;
      switch (rule.id) {
        case 'min_avg_turnover':
          result = evaluateMinTurnover(c, rule);
          break;
        case 'min_avg_oi':
          result = evaluateMinOI(c, rule);
          break;
        case 'not_at_limit_lock':
          if (!ohlcv) {
            result = { pass: false, reason: 'OHLCV data missing for limit lock check' };
          } else {
            result = evaluateNotAtLimit(c, ohlcv, rule);
          }
          break;
        case 'no_consecutive_limit_lock':
          if (!ohlcv) {
            result = { pass: false, reason: 'OHLCV data missing for consecutive limit check' };
          } else {
            result = evaluateNoConsecutiveLimit(c, ohlcv, rule, limitLockRule);
          }
          break;
        default:
          console.warn(`    WARN: unknown rule ${rule.id}, skipping`);
          result = { pass: true };
      }

      const status = result.pass ? '✓' : '✗';
      console.log(`    ${status} ${rule.id}: ${result.pass ? 'PASS' : result.reason}`);

      if (!result.pass) {
        allPassed = false;
        reasons.push({ ruleId: rule.id, reason: result.reason });
      }
    }

    if (allPassed) {
      passed.push(c);
    } else {
      rejected.push({
        symbol: c.symbol,
        name: c.name,
        rank: c.rank,
        score: c.score,
        reasons
      });
    }
  }

  // ── Output filtered-hard.json ──────────────────────────────
  const output = {
    meta: {
      runId,
      filteredAt,
      pipelineVersion: '0.1.0',
      rulesVersion: '0.1.0',
      activeRuleIds: activeRules.map(r => r.id),
      deferredRuleIds: inactiveRules.map(r => r.id),
      inputCandidates: candidates.candidates.length,
      passed: passed.length,
      rejected: rejected.length
    },
    passed,
    rejected
  };

  const outPath = path.join(RUN_DIR, 'filtered-hard.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\nfiltered-hard.json → ${outPath}`);

  // ── Summary ────────────────────────────────────────────────
  console.log(`\n=== FILTER COMPLETE ===`);
  console.log(`${passed.length} passed / ${rejected.length} rejected (from ${candidates.candidates.length} candidates)`);

  if (passed.length > 0) {
    console.log(`\nPassed:`);
    for (const c of passed) {
      console.log(`  ✓ #${c.rank} ${c.name} (${c.symbol}) score=${(c.score * 100).toFixed(1)}`);
    }
  }
  if (rejected.length > 0) {
    console.log(`\nRejected (IRREVERSIBLE — LLM must not resurrect):`);
    for (const r of rejected) {
      console.log(`  ✗ #${r.rank} ${r.name} (${r.symbol}): ${r.reasons.map(x => x.reason).join('; ')}`);
    }
  }

  process.exit(0);
}

main();
