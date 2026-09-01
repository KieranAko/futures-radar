// experiment-line/analyze-v2/prompt-builder-v2.cjs — O1/O2/O3/O5：单轮合并 prompt 构建
//
// 输出两块 prompt（2 次逻辑 LLM 调用，目标 ≤3）：
//   P1 板块批量：全部相关板块一次判定（O2）
//   P2 品种批量：三品种一次输出六问 + mechanismRef + selfCheck（O1/O3/O5）
//
// 用法: node experiment-line/analyze-v2/prompt-builder-v2.cjs --runId <runId>
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const EL = path.join(ROOT, 'experiment-line');
const { runDir } = require(path.join(ROOT, 'lib', 'workspace.cjs'));

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--runId');
  const runId = i >= 0 ? args[i + 1] : null;
  if (!runId) throw new Error('--runId required');
  const runPath = runDir(runId);
  const packets = readJson(path.join(runPath, 'analyze', 'packets-v2.json'));
  const prefill = readJson(path.join(runPath, 'analyze', 'prefill-v2.json')).prefill;
  const sectorSnap = readJson(path.join(runPath, 'sector-snapshot.json'));

  const syms = Object.keys(packets.packets || {});
  const sectors = [...new Set(syms.map((s) => packets.packets[s].sector))];

  const L = [];
  L.push(`# Analyze-v2 单轮合并推理输入（runId=${runId}）`);
  L.push('');
  L.push('## P1 板块批量（O2，1 次调用）');
  L.push('');
  L.push('只对以下板块输出判定；其他板块 abstain。只解释板块整体，不得引用个股 Q1。');
  for (const sec of sectors) {
    const snap = sectorSnap.sectors?.[sec] || {};
    L.push(`- ${sec}: direction=${snap.direction} ret1d=${snap.ret1d} ret5d=${snap.ret5d} advance=${snap.advanceRatio1d}`);
  }
  L.push('');
  L.push('输出 JSON：');
  L.push('```json');
  L.push('{"sectors":{"<name>":{"direction":"up|down|flat","driver":{"primary":"板块级驱动一句话","confidence":"high|medium|low"},"reason":"只解释板块整体","relation_to_individual":"context_only"}}}');
  L.push('```');
  L.push('找不到板块级证据 → driver.primary="unknown"，禁止编造。');
  L.push('');
  L.push('## P2 品种批量（O1/O3/O5，1 次调用，三品种一次输出）');
  L.push('');
  for (const sym of syms) {
    const p = packets.packets[sym];
    const pf = prefill[sym];
    L.push(`### ${sym} ${p.name}（${p.sector}）`);
    L.push(`- price: close=${p.price_data.close} ma20=${p.price_data.ma20} ma60=${p.price_data.ma60} atr5=${p.price_data.atr5} chg5=${p.price_data.change5dPct}% volMult=${p.price_data.volMultiplier} hi20=${p.price_data.high20d} lo20=${p.price_data.low20d}`);
    L.push(`- oi: last=${p.volume_oi.openInterestLast} chg5=${p.volume_oi.oiChange5dPct}%`);
    L.push(`- term_structure: ${p.term_structure ? `br=${p.term_structure.br} asOf=${p.term_structure.asOf}` : '缺失'}`);
    L.push(`- sector: ${JSON.stringify(p.sector_context)}`);
    L.push(`- macro: ${JSON.stringify(p.macro_context?.indicators ? Object.keys(p.macro_context.indicators) : [])}`);
    const cand = Object.entries(p.mechanism_candidates || {}).map(([f, ms]) => `${f}=[${ms.map((m) => `${m.id}(${m.status})`).join(',')}]`).join('; ');
    L.push(`- mechanism_candidates: ${cand || '无'}`);
    L.push(`- prevAnalysis: ${p.prevAnalysisCache ? `${p.prevAnalysisCache.direction}/${p.prevAnalysisCache.confidence}（${p.prevAnalysisCache.q1}）` : '无'}`);
    L.push(`- cost_anchor: ${p.cost_anchor ? (() => {
      const a = p.cost_anchor;
      if (Array.isArray(a.routes) && a.routes.length > 0) {
        const parts = a.routes.map((r) => r.status === 'unknown' ? `${r.route}=unknown` : `${r.route}=${r.valueLow}-${r.valueHigh}${a.unit || ''}`);
        const problems = (a.problems || []).map((x) => x.code).join(',');
        return `${a.indicator} routes[${parts.join('; ')}] (asOf ${a.asOf}, ${a.confidence})${problems ? ` problems[${problems}]` : ''}`;
      }
      const problems = (a.problems || []).map((x) => x.code).join(',');
      return `${a.indicator}=${a.valueLow}-${a.valueHigh}${a.unit} (asOf ${a.asOf}, ${a.confidence})${problems ? ` problems[${problems}]` : ''}`;
    })() : '不可用'}`);
    L.push(`- prefill q2: ${pf.q2.judgment}/${pf.q2.priceAlignment}; q4long=${JSON.stringify(pf.q4.long)}; q5long=${JSON.stringify(pf.q5.long)}; q6=${JSON.stringify(pf.q6)}`);
    L.push('');
  }
  L.push('输出 JSON（数组，每品种一条）：');
  L.push('```json');
  L.push(`[{"symbol":"...","direction":"long|short|pass","confidence":"high|medium|low","q1_driver":{"primary":"...","secondary":"...","evidence":"引用 packet 数值或前日同源线索","source":"..."},"q3_odds":{"bias":"bullish|bearish|neutral","longCase":["..."],"shortCase":["..."],"summary":"..."},"q4_confirmations":{"selected":"long|short","signals":["..."]},"q5_invalidation":{"conditions":["..."]},"mechanismRef":{"family":"carry|value|event|momentum|none","mechanismId":"候选机制或 null","matchStatus":"matched|unknown"},"selfCheck":{"unitCheck":{"pass":true,"note":"..."},"evidenceCheck":{"pass":true,"evidenceIds":["price_data.close_60d","term_structure.br"]},"opposingCheck":{"pass":true,"opposing":["..."]}}}]`);
  L.push('```');
  L.push('约束：evidenceCheck.evidenceIds 只能引用 packet 字段；方向必须与 prefill 结构一致或显式说明 override；pass 时给出 data_insufficient/model_abstain/conflict_unresolved 原因。cost_anchor 是成本上下文证据，只可进入 q1_driver.evidence/q3_odds 的推理，不得单独决定方向。');

  const outFile = path.join(runPath, 'analyze', 'prompts-v2.md');
  fs.writeFileSync(outFile, L.join('\n'), 'utf8');
  console.log(`prompts-v2: ${outFile}`);
  return L.join('\n');
}

if (require.main === module) main();
module.exports = { main };
