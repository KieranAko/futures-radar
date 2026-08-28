// falsification harness — validation gates (G3), kill-rules engine, state suggestion
// Mirrors library validationGates G3/G4 + per-strategy killRules/killOn (machine-readable form).
'use strict';

const {
  mean, std, sharpeTrade, profitFactor, hitRateNet, hitRateDirection,
  tTestOneSample, binomialTest, bootstrapMeanCI,
} = require('./stats.cjs');
const { round, isFiniteNum } = require('./util.cjs');

// returns stats bundle over trade-level netR series
function tradeStats(netRs, { ciSeed = 20260828 } = {}) {
  const n = netRs.length;
  const m = mean(netRs);
  const s = std(netRs, 1);
  const t = tTestOneSample(netRs, 0);
  const ci = bootstrapMeanCI(netRs, { seed: ciSeed });
  return {
    n,
    meanR: round(m),
    stdR: round(s),
    sharpeTrade: round(sharpeTrade(netRs)),
    pf: profitFactor(netRs) === Infinity ? 'Inf' : round(profitFactor(netRs)),
    t: round(t.t),
    p: t.p === null ? null : round(t.p, 4),
    ci95: ci.lo === null ? [null, null] : [round(ci.lo), round(ci.hi)],
    ciExcludesZero: ci.lo !== null && ci.hi !== null && (ci.lo > 0 || ci.hi < 0),
    ciPositive: ci.lo !== null && ci.hi !== null && ci.lo > 0,
  };
}

// per-fold (year) mean netR and per-fold hit rate — for "多数年份为正" & window gates
function foldStats(foldIds, trades, { windowMetric = 'meanR' } = {}) {
  const byFold = {};
  for (const f of foldIds) byFold[f] = [];
  for (const t of trades) {
    if (byFold[t.foldId]) byFold[t.foldId].push(t);
  }
  const rows = [];
  for (const f of foldIds) {
    const ts = byFold[f] || [];
    const rs = ts.map((t) => t.netR);
    const dirCorrect = ts.filter((t) => isFiniteNum(t.direction) && isFiniteNum(t.netR) && ((t.direction > 0 && t.netR > 0) || (t.direction < 0 && t.netR < 0))).length;
    rows.push({
      fold: f,
      n: rs.length,
      meanR: mean(rs),
      hitRateNet: hitRateNet(rs),
      hitRateDirection: rs.length ? dirCorrect / rs.length : null,
      binomialP: rs.length >= 5 ? binomialTest(rs.filter((v) => v > 0).length, rs.length, 0.5, 'greater').p : null,
    });
  }
  const yearsWithTrades = rows.filter((r) => r.n > 0);
  const positiveYears = yearsWithTrades.filter((r) => r.meanR !== null && r.meanR > 0).length;
  return {
    rows,
    majorityYearsPositive: yearsWithTrades.length > 0 && positiveYears / yearsWithTrades.length > 0.5,
    positiveYears, yearsWithTrades: yearsWithTrades.length,
  };
}

// strategy-level gate (library G3 + per-strategy strategyLevel falsificationTests)
function evaluateStrategyGate(result, spec) {
  const cfg = spec.strategyLevel;
  const netRs = result.trades.map((t) => t.netR).filter(isFiniteNum);
  const stats = tradeStats(netRs, { ciSeed: result.meta.seed + 1 });
  const folds = result.folds.map((f) => f.fold);
  const fstat = foldStats(folds, result.trades);
  const checks = [];
  const push = (id, passed, detail) => checks.push({ id, passed, detail });

  const minTrades = cfg.minTrades ?? 200;
  push('minTrades', netRs.length >= minTrades, `n=${netRs.length} >= ${minTrades}`);
  push('pfThreshold', stats.pf === 'Inf' ? true : stats.pf >= (cfg.pfThreshold ?? 1.2),
    `PF=${stats.pf} vs ${cfg.pfThreshold ?? 1.2}`);
  push('ciExcludesZero', stats.ciExcludesZero, `95% CI=[${stats.ci95[0]},${stats.ci95[1]}]`);
  if (cfg.majorityYearsPositive !== false) {
    push('majorityYearsPositive', fstat.majorityYearsPositive,
      `${fstat.positiveYears}/${fstat.yearsWithTrades} years positive`);
  }
  // optional window gate (M1 口径: per-window metric threshold + pass share)
  let windowGate = null;
  if (cfg.windowGate) {
    const wg = cfg.windowGate; // {metric:'hitRateNet'|'meanR'|'sharpeTrade', minHit, pThreshold, minShare}
    const perWindow = [];
    for (const r of fstat.rows) {
      if (r.n === 0) continue;
      let met = false;
      if (wg.metric === 'hitRateNet' || wg.metric === 'hitRateDirection') {
        const hr = wg.metric === 'hitRateNet' ? r.hitRateNet : r.hitRateDirection;
        const k = Math.round(hr * r.n);
        const binomP = r.n >= 5 ? binomialTest(k, r.n, 0.5, 'greater').p : null;
        met = hr !== null && hr >= wg.minHit &&
          (wg.pThreshold === undefined || (binomP !== null && binomP < wg.pThreshold));
        perWindow.push({ fold: r.fold, n: r.n, [wg.metric]: round(hr), binomialP: round(binomP), met });
      } else if (wg.metric === 'meanR') {
        met = r.meanR !== null && r.meanR > (wg.minMean ?? 0);
        perWindow.push({ fold: r.fold, n: r.n, meanR: round(r.meanR), met });
      }
    }
    const share = perWindow.length ? perWindow.filter((w) => w.met).length / perWindow.length : 0;
    windowGate = {
      config: wg, perWindow, share: round(share),
      passed: share >= (wg.minShare ?? 0.6),
    };
    push('windowGate', windowGate.passed, `达标窗口占比=${round(share * 100, 1)}% vs ${(wg.minShare ?? 0.6) * 100}%`);
  }

  const passed = checks.every((c) => c.passed);
  return { passed, checks, stats, foldStats: fstat, windowGate };
}

// theory-level: adapter-provided structured tests + killOn mapping
function evaluateTheory(theory) {
  if (!theory) return { present: false };
  const tests = theory.tests || [];
  const falsified = tests.filter((t) => t.falsified === true);
  const inconclusive = tests.filter((t) => t.falsified !== true && t.falsified !== false);
  return {
    present: true,
    hypothesis: theory.hypothesis || null,
    tests,
    anyFalsified: falsified.length > 0,
    falsified,
    inconclusive,
    killOn: theory.killOn || null,
    metrics: theory.metrics || null,
  };
}

// machine kill-rules: {id, metric, op, value, onTrigger, note}
// metrics: n, pf, sharpeTrade, hitRateNet, hitRateDirection, ciExcludesZero, majorityYearsPositive,
//          windowShare, theoryFalsified, custom.<name> (from theory.metrics)
function evaluateKillRules(result, spec, theoryEval) {
  const cfg = spec.strategyLevel;
  const netRs = result.trades.map((t) => t.netR).filter(isFiniteNum);
  const stats = tradeStats(netRs, { ciSeed: result.meta.seed + 1 });
  const folds = result.folds.map((f) => f.fold);
  const fstat = foldStats(folds, result.trades);
  const hitDir = hitRateDirection(result.trades);
  const custom = (theoryEval && theoryEval.metrics) || {};

  const metrics = {
    n: netRs.length,
    pf: stats.pf === 'Inf' ? Infinity : stats.pf,
    sharpeTrade: stats.sharpeTrade,
    hitRateNet: hitRateNet(netRs),
    hitRateDirection: hitDir,
    ciExcludesZero: stats.ciExcludesZero,
    majorityYearsPositive: fstat.majorityYearsPositive,
    theoryFalsified: theoryEval ? theoryEval.anyFalsified : null,
  };
  const rules = spec.machineKillRules || [];
  const verdicts = [];
  for (const r of rules) {
    const m = r.metric.startsWith('custom.') ? custom[r.metric.slice(7)] : metrics[r.metric];
    if (m === null || m === undefined) {
      verdicts.push({ rule: r.id, triggered: null, note: `metric ${r.metric} unavailable`, evidence: null });
      continue;
    }
    let triggered = false;
    switch (r.op) {
      case 'lt': triggered = m < r.value; break;
      case 'lte': triggered = m <= r.value; break;
      case 'gt': triggered = m > r.value; break;
      case 'gte': triggered = m >= r.value; break;
      case 'eq': triggered = m === r.value; break;
      case 'isFalse': triggered = m === false; break;
      case 'isTrue': triggered = m === true; break;
      default: throw new Error(`unknown kill op: ${r.op}`);
    }
    verdicts.push({ rule: r.id, metric: r.metric, op: r.op, value: r.value, observed: round(m), triggered, onTrigger: r.onTrigger, note: r.note || null });
  }
  return verdicts;
}

// suggested state per library statusMachine (retired/suspended/designed …)
function suggestState({ spec, strategyGate, theoryEval, killVerdicts }) {
  const reasons = [];
  const events = [];
  // theory-level falsification → retired (G4: 任何一条理论级证伪成立 → retired)
  if (theoryEval && theoryEval.anyFalsified) {
    events.push('theory-falsified');
    reasons.push(`理论级证伪成立: ${theoryEval.falsified.map((t) => `${t.id} → ${t.killState || 'retired'}`).join('; ')}`);
  }
  for (const v of killVerdicts) {
    if (v.triggered === true) {
      events.push(`kill:${v.rule}`);
      reasons.push(`killRule ${v.rule} 触发 (${v.metric} ${v.op} ${v.value}, observed=${v.observed}) → ${v.onTrigger}`);
    }
  }
  if (strategyGate && !strategyGate.passed) {
    const fails = strategyGate.checks.filter((c) => !c.passed).map((c) => c.id);
    events.push('strategy-gate-fail');
    reasons.push(`策略级门禁未通过: ${fails.join(', ')}`);
  }
  const theoryState = spec.strategyLevel?.theoryFalsifiedState || 'retired';
  let state = 'designed';
  // R7（队长终裁）：symbol-freeze 只记录冻结清单，不改变策略状态
  const freezeVerdicts = killVerdicts.filter((v) => v.triggered === true && v.onTrigger === 'symbol-freeze');
  if (freezeVerdicts.length) {
    const freezeList = (theoryEval?.metrics?.symbolsToFreeze) || [];
    events.push('symbol-freeze');
    reasons.push(`symbol-freeze（R7 队长终裁语义）：冻结触发品种方向映射 ${freezeList.length ? freezeList.join(', ') : '（清单见 theory metrics）'}；策略状态不受此规则影响`);
  }
  const onTriggers = killVerdicts.filter((v) => v.triggered && v.onTrigger !== 'symbol-freeze').map((v) => v.onTrigger);
  const gateFails = strategyGate && !strategyGate.passed
    ? strategyGate.checks.filter((c) => !c.passed).map((c) => c.id)
    : [];
  const onlySampleInsufficiency = gateFails.length > 0 && gateFails.every((f) => f === 'minTrades');
  const theoryStates = (theoryEval && theoryEval.anyFalsified)
    ? theoryEval.falsified.map((t) => t.killState || theoryState)
    : [];
  if (theoryEval && theoryEval.anyFalsified) {
    state = (theoryStates.includes('retired') || onTriggers.includes('retired')) ? 'retired'
      : theoryStates.includes('suspended') ? 'suspended'
      : theoryState;
  }
  else if (onTriggers.includes('retired')) state = 'retired';
  else if (onTriggers.includes('pair-removed')) state = 'pair-removed';
  else if (onTriggers.includes('suspended')) state = 'suspended';
  else if (strategyGate && !strategyGate.passed && !onlySampleInsufficiency) state = 'suspended';
  else if (strategyGate && !strategyGate.passed && onlySampleInsufficiency) state = 'designed'; // 样本不足 → 停留 designed（非失效）
  else if (strategyGate && strategyGate.passed && theoryEval && !theoryEval.anyFalsified) state = 'validated-eligible';
  return { suggestedState: state, reasons, events, note: '最终状态由 t8 执行结论 + t9 复核 + 队长裁定决定；本引擎仅输出判定依据' };
}

module.exports = {
  tradeStats, foldStats,
  evaluateStrategyGate, evaluateTheory, evaluateKillRules, suggestState,
};
