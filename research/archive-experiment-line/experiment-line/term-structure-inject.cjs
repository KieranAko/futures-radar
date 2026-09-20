// experiment-line/term-structure-inject.cjs — 期限结构注入（02-T1~T4 内容层补齐）
//
// 对实验线自产 run：从 GA-8 基差库取信号日可得的 br/domBasisRate（现货发布节奏滞后时
// 用 ≤信号日 的最新行并标注 asOf），注入 evidence-packets.term_structure 与 analysis Q3。
// 生产 freeze-packets 恢复后本步骤由它替代；本脚本只补实验线自产 run。
//
// 用法: node experiment-line/term-structure-inject.cjs --runId <runId>
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const EL = __dirname;
const basisLib = require(path.join(ROOT, 'strategies', 'research', 'v2', 'falsification', 'harness-lib', 'basis.cjs'));

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function normDate(d) {
  const s = String(d || '');
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s;
}

function latestBasisRow(libSymbol, signalDate) {
  const b = basisLib.loadBasisHistory(libSymbol);
  const target = normDate(signalDate);
  const rows = b.rows.filter((r) => normDate(r.date) <= target);
  return rows.length ? rows[rows.length - 1] : null;
}

function fmtPct(v, d = 3) {
  return v == null ? '—' : `${(v * 100).toFixed(d)}%`;
}

function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--runId');
  const runId = i >= 0 ? args[i + 1] : null;
  if (!runId) throw new Error('--runId required');

  const runPath = path.join(EL, 'runs', runId);
  const analysisFile = path.join(runPath, 'analysis.json');
  const packetFile = path.join(runPath, 'evidence-packets.json');
  if (!fs.existsSync(analysisFile)) throw new Error(`analysis.json missing: ${analysisFile}`);
  const analysis = readJson(analysisFile);
  const packets = fs.existsSync(packetFile) ? readJson(packetFile) : { packets: {} };
  const signalDate = analysis.meta?.signalDate || analysis.meta?.analyzedAt?.slice(0, 10);

  for (const a of analysis.analyses || []) {
    const row = latestBasisRow(a.symbol, signalDate);
    if (!row) continue;
    const ts = {
      br: row.br,
      domBasisRate: row.domBasisRate,
      asOf: row.date,
      note: 'GA-8 基差库 ≤信号日最新行；br=(S−F)/S，正值=现货升水(贴水结构)，负值=现货贴水(升水结构)',
    };
    if (packets.packets?.[a.symbol]) {
      packets.packets[a.symbol].fields = packets.packets[a.symbol].fields || {};
      packets.packets[a.symbol].fields.term_structure = ts;
    }
    const contango = row.br != null && row.br < 0;
    const backwardation = row.br != null && row.br > 0;
    const line = contango
      ? `期限结构 contango（br=${fmtPct(row.br)}，asOf ${row.date}）：期货升水，近端供应不算紧张，收敛方向对多头不利`
      : backwardation
        ? `期限结构 backwardation（br=${fmtPct(row.br)}，asOf ${row.date}）：现货升水，近端偏紧，支持多头/收敛逻辑`
        : `期限结构（br=${fmtPct(row.br)}，asOf ${row.date}）`;
    const q3 = a.q3_odds || {};
    // 幂等：移除既有期限结构条目后重新注入（防重复运行累积旧值）
    q3.shortCase = (q3.shortCase || []).filter((x) => !/期限结构/.test(x));
    q3.longCase = (q3.longCase || []).filter((x) => !/期限结构/.test(x));
    if (contango) q3.shortCase = [...(q3.shortCase || []), line];
    else q3.longCase = [...(q3.longCase || []), line];
    a.q3_odds = q3;
    a.termStructure = ts;
    // Q3 总结追加期限结构（渲染只显示 summary，须写入才能进报告正文）
    const baseSummary = (q3.summary || '').replace(/；?期限结构[^；]*/g, '');
    q3.summary = `${baseSummary}；期限结构 ${contango ? 'contango' : backwardation ? 'backwardation' : '中性'}（br=${fmtPct(row.br)}，asOf ${normDate(row.date)}）`;
  }

  if (packets.packets) packets.meta = { ...(packets.meta || {}), termStructureInjectedAt: new Date().toISOString(), termStructureSource: 'GA-8 basis-history (≤signalDate latest row)' };
  writeJson(packetFile, packets);
  writeJson(analysisFile, analysis);
  for (const a of analysis.analyses || []) {
    console.log(`${a.symbol}: ${a.termStructure ? `br=${fmtPct(a.termStructure.br)} asOf=${a.termStructure.asOf}` : 'no basis row'}`);
  }
  console.log('injected');
  return analysis;
}

if (require.main === module) main();
module.exports = { main };
