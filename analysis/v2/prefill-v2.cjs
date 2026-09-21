// analysis/v2/prefill-v2.cjs — O4：确定性预填
//
// 权威错位修复（AUTH-01）：
//   - Q2 趋势/脉冲判断是推理内容，不再由引擎预填，交给 LLM（outputs-v2.json）。
//   - Q6 只预填可计算数值事实，并带 provenance 标记 deterministic-facts，
//     不再伪装成 LLM 判断。
// Q4/Q5 不预填：由 LLM 基于 Q1–Q3 逻辑与 packet.near_term 近端结构生成。
//
// 用法: node analysis/v2/prefill-v2.cjs --runId <runId>
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const EL = path.join(ROOT, 'research', 'archive-experiment-line', 'experiment-line'); // V2：归档保留，仅供历史工具兼容
const { runDir } = require(path.join(ROOT, 'shared', 'workspace.cjs'));

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function round(v, d = 2) {
  return v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d;
}

function prefillOne(sym, packet, probability) {
  const p = packet;
  const close = p.price_data.close;

  // Q2 判断交给 LLM，不再确定性预填。
  // Q6 可计算项：只输出数值/事实字段，并显式标记 provenance。
  const mult = p.multiplier || 10;
  const contractValue = close * mult;
  const margin = { low: round(contractValue * 0.05), high: round(contractValue * 0.15) };
  const cone = probability?.probabilities?.find((x) => x.symbol === sym);
  const p95 = cone?.cone?.['3d']?.p95 || null;
  const tail = p95
    ? round((Math.min(p95[0] - close, close - p95[1]) / close) * 100, 2)
    : null;

  return {
    symbol: sym,
    q2: null, // 推理字段，由 LLM 产出；此处仅为契约占位
    q4: null,
    q5: null,
    q6: {
      contractValue: round(contractValue, 0),
      marginRange: margin,
      overnightGap: /shfe|dce|czce/i.test(p.exchange) ? `${p.exchange.toUpperCase()} 有夜盘，存在隔夜跳空风险` : '无夜盘（以交易所公告为准）',
      tail3dP95ReversePct: tail,
      limitDistance: p.price_data && Number.isFinite(Number(p.price_data.limitPct))
        ? `涨跌停幅度 ${Number(p.price_data.limitPct)}%（交易所公告为准）`
        : '涨跌停幅度以交易所当日公告为准',
      provenance: { artifactId: 'prefill-v2', kind: 'deterministic-facts' },
    },
  };
}

function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--runId');
  const runId = i >= 0 ? args[i + 1] : null;
  if (!runId) throw new Error('--runId required');
  const runPath = runDir(runId);
  const packets = readJson(path.join(runPath, 'analyze', 'packets-v2.json'));
  const probFile = path.join(runPath, 'probability.json');
  const probability = fs.existsSync(probFile) ? readJson(probFile) : null;
  const out = {};
  for (const [sym, packet] of Object.entries(packets.packets || {})) {
    out[sym] = prefillOne(sym, packet, probability);
  }
  const outFile = path.join(runPath, 'analyze', 'prefill-v2.json');
  writeJson(outFile, { schema: 'futures-radar-analyze-v2-prefill/1', runId, generatedAt: new Date().toISOString(), prefill: out });
  console.log(`prefill-v2: ${outFile}`);
  return out;
}

if (require.main === module) main();
module.exports = { main, prefillOne };
