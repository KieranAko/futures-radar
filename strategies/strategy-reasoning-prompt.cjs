// strategies/strategy-reasoning-prompt.cjs — 生成 Strategy-LLM 的推理输入 prompt（软理论参照）
//
// 用途：在生成 strategy-reasoning.json 之前，由本脚本冻结报告上下文与理论参照，
// 供 LLM 执行“交易表达决策”。本脚本不联网、不调用 LLM。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { runDir } = require('../lib/workspace.cjs');

function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--runId');
  const runId = i >= 0 ? args[i + 1] : null;
  if (!runId) throw new Error('--runId required');
  const dir = runDir(runId);
  const rm = readJSON(path.join(dir, 'report-model.json'));
  const analysis = readJSON(path.join(dir, 'analysis.json'));
  const prob = readJSON(path.join(dir, 'probability.json'));

  const L = [];
  L.push(`# Strategy-LLM 推理输入（runId=${runId}）`);
  L.push('');
  L.push('## 任务定位');
  L.push('');
  L.push('你是策略表达层，不是分析层。报告六问与概率区间已经冻结；你的唯一任务是把报告结论翻译成可执行的交易计划。');
  L.push('不得修改报告方向与置信度；不得引入新数据源；不得输出收益承诺。');
  L.push('');
  L.push('## 理论参照（软约束）');
  L.push('');
  L.push('- 时间序列动量：趋势突破/回踩表达、动量半衰期目标。');
  L.push('- 事件日漂移：事件日达标后的确认式入场。');
  L.push('- 条件波动区间：五模型区间用于止损/目标定价。');
  L.push('- 波动率目标与信号强度：仓位档位。');
  L.push('理论只需大致符合；无合适理论时 theoryFit=none，给出 theoryGapNote，并降级 strategyConfidence。');
  L.push('');
  L.push('## 推理要求');
  L.push('');
  L.push('1. 论点绑定：提取报告方向/置信度/驱动/确认/失效。');
  L.push('2. 可执行性评估：Q4 触发价是否可达？现价与触发价、p68/p95 的关系？');
  L.push('3. 表达选择：breakout / confirmation / pullback / event-confirmation / conditional-watch。');
  L.push('4. 止损/目标：止损来自 Q5 失效位或概率尾；目标来自 Q3 逻辑点或 p68/p95。');
  L.push('5. 仓位意图：confidence + 波动率目标 + 尾部风险。');
  L.push('6. 自检：每个参数可溯源到报告字段；theoryFit 与 strategyConfidence 自洽。');
  L.push('');
  for (const opp of rm.opportunities) {
    const t = opp.thesis || {};
    const a = (analysis.analyses || []).find((x) => x.symbol === opp.symbol) || {};
    const pr = (prob.probabilities || []).find((x) => x.symbol === opp.symbol) || {};
    L.push(`## ${opp.symbol} ${opp.name}`);
    L.push('');
    L.push(`- finalDirection=${t.finalDirection} finalConfidence=${t.finalConfidence}`);
    L.push(`- Q1 driver: ${t.driver?.primary || '—'} / ${t.driver?.secondary || '—'}`);
    L.push(`- Q2: ${t.trendOrImpulse?.assessment || '—'}`);
    L.push(`- Q3 bias: ${t.odds?.bias || '—'} summary=${t.odds?.reasoning || t.odds?.summary || '—'}`);
    L.push(`- Q4 confirmations: ${(t.confirmations?.signals || []).join(' | ')}`);
    L.push(`- Q5 invalidations: ${(t.invalidations?.conditions || []).join(' | ')}`);
    L.push(`- close=${opp.marketFacts?.close} hv.percentile90d=${opp.marketFacts?.hv?.percentile90d}`);
    const pr3 = opp.priceRanges?.[0] || {};
    L.push(`- 3d p68=${JSON.stringify(pr3.hvCone?.p68)} p95=${JSON.stringify(pr3.hvCone?.p95)} atr5=${pr3.atrBand?.atr5} divergence=${pr3.divergence?.pct}`);
    L.push(`- currentState=${JSON.stringify(opp.currentState || {})} referenceInterval=${opp.referenceInterval?.modelId}`);
    L.push(`- confidenceRationale: support=${(t.confidenceRationale?.supportingFactors || []).map((x) => x.note).join(' | ')}; opposing=${(t.confidenceRationale?.opposingFactors || []).map((x) => x.note).join(' | ')}; uncertainties=${(t.confidenceRationale?.uncertainties || []).join(' | ')}`);
    if (a.q6_risks) L.push(`- Q6 risks: limit=${a.q6_risks.limitDistance} overnight=${a.q6_risks.overnightGap} margin=${a.q6_risks.margin}`);
    L.push('');
  }
  L.push('## 输出 JSON 结构');
  L.push('```json');
  L.push('{"schema":"futures-radar-strategy-reasoning/1","runId":"...","strategies":[{"symbol":"SA0","direction":"neutral","strategyConfidence":"low","confidenceDowngradeReasons":["..."],"theoryFit":"none|approximate|aligned","theoryRefs":[],"theoryGapNote":"...","expression":{"type":"conditional-watch","reason":"..."},"entry":{"trigger":"...","triggerSource":"...","triggerLevel":1018,"triggerTiming":"...","execution":"..."},"stop":{"stopPrice":1018,"basis":"Q5 失效位/概率尾"},"targets":{"t1":"...","t2":"...","basis":"..."},"reasoningRef":{"artifactId":"strategy-reasoning-json"}}]}');
  L.push('```');
  L.push('');
  L.push('strategyConfidence 不得高于报告 finalConfidence。theoryFit=none|approximate 时必须给 confidenceDowngradeReasons 与 theoryGapNote。');

  const outDir = path.join(dir, 'strategies', 'prompts');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'strategy-reasoning.md');
  fs.writeFileSync(outFile, L.join('\n'), 'utf8');
  console.log(`strategy-reasoning prompt: ${outFile}`);
  return L.join('\n');
}

if (require.main === module) main();
module.exports = { main };
