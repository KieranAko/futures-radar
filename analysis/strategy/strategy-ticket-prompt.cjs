// analysis/strategy/strategy-ticket-prompt.cjs — 交易员角色提示词生成器
//
// 在机会六问分析之后，让 LLM 切换身份：不再是分析师，而是交易员（盘手）。
// 输入是分析团队冻结的六问结论与市场事实；输出是一张自然语言交易单
// （strategies/strategy-ticket.md），供录入员拆要素。
//
// 纪律：本模块不联网、不调用 LLM；只生成确定性的角色提示词。

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { runDir } = require('../../shared/workspace.cjs');
const { computeNearTermStructure } = require('./near-term-structure.cjs');

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
  const raw = readJSON(path.join(dir, 'raw.json'));
  const signalDate = (analysis.meta?.analyzedAt || rm.meta?.generatedAt || '').slice(0, 10);

  const L = [];
  L.push(`# 交易员（盘手）角色提示词（runId=${runId}）`);
  L.push('');
  L.push('## 身份切换');
  L.push('');
  L.push('你现在不是分析员。你是期货交易部一名有多年实盘经验的交易员（盘手）。');
  L.push('分析团队刚刚把下面这份机会六问结论放在你桌上，数据和价位都已冻结。');
  L.push('你的任务不是再分析一遍基本面，而是决定：这一单我敢不敢做、怎么做、错了怎么撤、对了怎么看。');
  L.push('');
  L.push('## 你手上的东西');
  L.push('');
  L.push('- 每个品种的六问结论（方向、置信度、驱动、确认信号、失效条件）');
  L.push('- 日线 OHLCV 与近端结构（PDH/PDL、价值区、3日高低、ATR5）');
  L.push('- 3日/5日概率区间');
  L.push('- 你只有日线数据，没有 15 分钟/30 分钟分时数据；不要编造没有的数据。');
  L.push('');
  L.push('## 你要交出的东西');
  L.push('');
  L.push('对每个值得做的品种，用你和下单员说话的方式写一张交易单，必须包含：');
  L.push('1. 做多还是做空，做哪个合约；');
  L.push('2. 价格走到什么情况，这笔交易才成立（必须给出具体价位和它来自哪个结构位）；');
  L.push('3. 成立后，什么时间、以什么方式确认；');
  L.push('4. 确认后怎么入场，什么情况放弃不入；');
  L.push('5. 错了在哪止损；');
  L.push('6. 对了看哪两个目标；');
  L.push('7. 最长持有：必须写成绝对交易日，例如“T+4 交易日收盘前未到目标则离场”，并在括号里注明入场后实际持有几个交易日（T+2 入场到 T+4 收盘 = 持有 3 个交易日）；');
  L.push('8. 什么情况直接作废这单。');
  L.push('');
  L.push('时间一律用交易日表述：T+1 是次一交易日，T+2 是次二交易日；不要用自然日，也不要用“分钟K线收盘”这类说法。');
  L.push('');
  L.push('用交易员自己的语言写，不要用“策略表达”“触发条件”这类模板腔。');
  L.push('觉得自己不该做这个品种，就写“不做”，并给一句理由。');
  L.push('');
  L.push('## 冻结资料');
  L.push('');

  for (const opp of rm.opportunities) {
    const t = opp.thesis || {};
    const a = (analysis.analyses || []).find((x) => x.symbol === opp.symbol) || {};
    const pr = (prob.probabilities || []).find((x) => x.symbol === opp.symbol) || {};
    L.push(`### ${opp.symbol} ${opp.name}`);
    L.push('');
    L.push(`- 方向：${t.finalDirection}；置信度：${t.finalConfidence}`);
    L.push(`- 驱动：${t.driver?.primary || '—'}${t.driver?.secondary ? ` / ${t.driver.secondary}` : ''}`);
    L.push(`- 趋势/脉冲：${t.trendOrImpulse?.assessment || '—'}`);
    L.push(`- 赔率：${t.odds?.bias || '—'}；${t.odds?.reasoning || t.odds?.summary || '—'}`);
    L.push(`- 确认信号：${(t.confirmations?.signals || []).join(' | ')}`);
    L.push(`- 失效条件：${(t.invalidations?.conditions || []).join(' | ')}`);
    const rawContract = raw?.contracts?.[opp.symbol];
    if (rawContract?.ohlcv) {
      const o = rawContract.ohlcv;
      const bars = o.dates.map((date, idx) => ({ date, open: o.open[idx], high: o.high[idx], low: o.low[idx], close: o.close[idx] }));
      const near = computeNearTermStructure(bars, signalDate);
      if (near) {
        L.push(`- 近端结构：PDH=${near.pdh} PDL=${near.pdl} 价值区=[${near.valueAreaLow}, ${near.valueAreaHigh}] ATR5=${near.atr5}`);
      }
    }
    L.push(`- 收盘：${opp.marketFacts?.close}`);
    const pr3 = opp.priceRanges?.[0] || {};
    L.push(`- 3日概率区间：p68=${JSON.stringify(pr3.hvCone?.p68)} p95=${JSON.stringify(pr3.hvCone?.p95)}`);
    const vr = opp.marketFacts?.volatilityRegime;
    if (vr) L.push(`- 波动环境：${vr.grade}/${vr.dynamic?.direction}`);
    if (a.q6_risks) L.push(`- 风险提示：涨跌停 ${a.q6_risks.limitDistance}；隔夜 ${a.q6_risks.overnightGap}；保证金 ${a.q6_risks.margin}`);
    L.push('');
  }

  L.push('## 输出');
  L.push('');
  L.push(`把交易单写进 ${path.join('strategies', 'strategy-ticket.md')}，一张单一个二级标题，先写品种和方向，再按上面的 1–8 条写清楚。`);

  const outDir = path.join(dir, 'strategies', 'prompts');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'strategy-ticket-prompt.md');
  fs.writeFileSync(outFile, L.join('\n'), 'utf8');
  console.log(`strategy-ticket prompt: ${outFile}`);
  return L.join('\n');
}

if (require.main === module) main();
module.exports = { main };
