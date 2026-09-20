// falsification harness — result rendering (JSON bundle + Markdown report)
'use strict';

const { round, stableHash } = require('./util.cjs');

function renderMarkdown({ result, strategyGate, theoryEval, killVerdicts, suggestion, baselineComparisons, library }) {
  const L = [];
  const s = result.spec;
  L.push(`# 证伪测试运行报告 — ${s.strategyId} (${s.specId})`);
  L.push('');
  L.push(`- 生成: ${result.meta.generatedAt} · seed=${result.meta.seed} · folds=${result.meta.foldsMode}`);
  L.push(`- 数据: ${result.data.symbols.join(', ')} · ${result.data.timelineStart}..${result.data.timelineEnd} (${result.data.nBars} bars)`);
  if (library && library.entryId) L.push(`- 库条目: ${library.entryId} (${library.sourceFile})`);
  L.push('');

  L.push('## 1. 策略级结果（G3 门禁）');
  L.push('');
  const st = strategyGate.stats;
  L.push(`| 指标 | 值 |`);
  L.push(`|---|---|`);
  L.push(`| trades | ${st.n} |`);
  L.push(`| meanR | ${st.meanR} |`);
  L.push(`| sharpeTrade | ${st.sharpeTrade} |`);
  L.push(`| PF | ${st.pf} |`);
  L.push(`| t (H0: mean=0) | ${st.t} (p=${st.p}) |`);
  L.push(`| 95% CI (bootstrap) | [${st.ci95[0]}, ${st.ci95[1]}] |`);
  L.push('');
  L.push('### 门禁检查');
  L.push('');
  L.push('| check | passed | detail |');
  L.push('|---|---|---|');
  for (const c of strategyGate.checks) L.push(`| ${c.id} | ${c.passed ? 'PASS' : 'FAIL'} | ${c.detail} |`);
  L.push('');
  L.push(`### 年度（fold）统计`);
  L.push('');
  L.push('| fold | n | meanR | hitRateNet |');
  L.push('|---|---|---|---|');
  for (const r of strategyGate.foldStats.rows) {
    L.push(`| ${r.fold} | ${r.n} | ${round(r.meanR)} | ${round(r.hitRateNet)} |`);
  }
  L.push('');
  if (strategyGate.windowGate) {
    L.push(`### 窗口门禁（M1 口径）`);
    L.push('');
    L.push(`达标窗口占比 = ${round(strategyGate.windowGate.share * 100, 1)}% (${strategyGate.windowGate.passed ? 'PASS' : 'FAIL'})`);
    L.push('');
  }

  L.push('## 2. 三基线对照');
  L.push('');
  for (const [name, b] of Object.entries(result.baselines)) {
    if (name === 'random') {
      const pooled = b.pooledNetRs;
      L.push(`- **random** (${b.mode}, ${b.runs} run(s)): pooled n=${pooled.length}, meanR=${round(pooled.length ? pooled.reduce((a, x) => a + x, 0) / pooled.length : null)}`);
    } else {
      L.push(`- **${name}**: n=${b.stats.n}, meanRetBps=${round(b.stats.meanRetBps, 2)} (${b.convention.split(';')[0]})`);
    }
    const cmp = baselineComparisons[name];
    if (cmp && cmp.diffCI) {
      L.push(`  - strategy − baseline meanR = ${round(cmp.diffMeanR)} · diff 95% CI=[${round(cmp.diffCI[0])}, ${round(cmp.diffCI[1])}] · beatsBaseline=${cmp.beatsBaseline}`);
    } else if (cmp) {
      L.push(`  - strategy meanR=${round(cmp.strategyMeanR)} · baseline meanBps=${round(cmp.baselineMeanBps, 2)} · baseline meanPseudoR=${round(cmp.baselineMeanPseudoR)}`);
    }
  }
  L.push('');

  L.push('## 3. 理论级证伪');
  L.push('');
  if (!theoryEval || !theoryEval.present) {
    L.push('（本 spec 未实现理论级测试 hook）');
  } else {
    L.push(`- 假设: ${theoryEval.hypothesis || '-'}`);
    L.push('');
    L.push('| test | falsified | evidence |');
    L.push('|---|---|---|');
    for (const t of theoryEval.tests) {
      L.push(`| ${t.id} (${t.label || '-'}) | ${t.falsified === true ? '是' : t.falsified === false ? '否' : '待定'} | ${JSON.stringify(t.evidence).slice(0, 200)} |`);
    }
    if (theoryEval.killOn) L.push(`- killOn: ${theoryEval.killOn}`);
  }
  L.push('');

  L.push('## 4. killRules 判定');
  L.push('');
  L.push('| rule | metric | op | value | observed | triggered | onTrigger |');
  L.push('|---|---|---|---|---|---|---|');
  for (const v of killVerdicts) {
    L.push(`| ${v.rule} | ${v.metric} | ${v.op} | ${v.value} | ${v.observed} | ${v.triggered === null ? 'n/a' : v.triggered} | ${v.onTrigger} |`);
  }
  L.push('');

  L.push('## 5. 建议状态');
  L.push('');
  L.push(`**${suggestion.suggestedState}**`);
  for (const r of suggestion.reasons) L.push(`- ${r}`);
  L.push(`- ${suggestion.note}`);
  L.push('');

  L.push('## 6. 机器检查');
  L.push('');
  if (!result.violations.length) {
    L.push('- lookahead violations: 0（PIT 视图硬约束 + F5/F9 门禁全部通过）');
  } else {
    for (const v of result.violations) L.push(`- VIOLATION: ${v.fold} ${v.date} ${v.error}`);
  }
  L.push('');
  L.push(`- resultsHash: ${stableHash({ trades: result.trades.map((t) => [t.entryDate, t.exitDate, t.netR, t.exitReason]), baselines: result.baselines })}`);
  L.push('');
  return L.join('\n');
}

function buildBundle({ result, strategyGate, theoryEval, killVerdicts, suggestion, baselineComparisons, library, specFile }) {
  return {
    schema: 'falsification-harness-result/1',
    specId: result.spec.specId,
    strategyId: result.spec.strategyId,
    specFile,
    libraryRef: library || null,
    meta: result.meta,
    data: result.data,
    folds: result.folds,
    paramsHistory: result.paramsHistory,
    strategyLevel: {
      gate: strategyGate,
      baselines: result.baselines,
      baselineComparisons,
    },
    theoryLevel: theoryEval,
    killVerdicts,
    suggestion,
    violations: result.violations,
    trades: result.trades.map((t) => ({
      id: t.id,
      signalDate: t.signalDate,
      entryDate: t.entryDate,
      exitDate: t.exitDate,
      exitReason: t.exitReason,
      direction: t.direction,
      sizeR: t.sizeR,
      legs: t.legs.map((lg) => ({
        symbol: lg.symbol, side: lg.side, entry: lg.entry, stop: lg.stop, target: lg.target,
        exit: lg.exit, rawR: lg.rawR, costR: lg.costR, netR: lg.netR, exitReason: lg.exitReason,
      })),
      netR: t.netR,
      grossR: t.grossR,
      tags: t.tags,
      foldId: t.foldId,
    })),
    abandons: result.folds.reduce((a, f) => a + f.abandons, 0),
    intents: result.intentsLog.length,
    resultsHash: stableHash({ trades: result.trades.map((t) => [t.entryDate, t.exitDate, t.netR, t.exitReason]), baselines: result.baselines }),
  };
}

module.exports = { renderMarkdown, buildBundle };
