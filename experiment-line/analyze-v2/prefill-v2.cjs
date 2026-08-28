// experiment-line/analyze-v2/prefill-v2.cjs — O4：确定性预填最大化
//
// 预填：Q2 全部 / Q4-Q5 结构位条款 / Q6 全部可计算项。
// LLM 只写：Q1 驱动、Q3 判断、Q4/Q5 的驱动类条款、以及覆盖结构预填的最终取舍。
//
// 用法: node experiment-line/analyze-v2/prefill-v2.cjs --runId <runId>
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const EL = path.resolve(__dirname, '..');

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
  const ma20 = p.price_data.ma20;
  const ma60 = p.price_data.ma60;
  const chg5 = p.price_data.change5dPct;
  const volMult = p.price_data.volMultiplier;
  const oiChg = p.volume_oi.oiChange5dPct;
  const alignedUp = close > ma20 && ma20 > ma60;
  const alignedDown = close < ma20 && ma20 < ma60;
  const judgment = alignedUp ? 'trend' : alignedDown ? 'trend' : Math.abs(chg5) >= 2 ? 'impulse' : 'chop';
  const trendSide = alignedUp ? '向上' : alignedDown ? '向下' : '结构冲突';

  // Q4/Q5 结构位（方向无关的两套模板，LLM 按最终方向取舍）
  const q4Long = [
    `收盘站稳 MA20(${round(ma20)}) 上方且量能维持 ${volMult == null ? 1.2 : Math.max(1.2, Math.round(volMult * 10) / 10)}x 以上→多头延续`,
    `放量突破今日高点`,
  ];
  const q4Short = [
    `收盘跌破 MA20(${round(ma20)}) 且量能放大→空头延续`,
    `放量跌破今日低点`,
  ];
  const q5Long = [`收盘跌破 MA20(${round(ma20)}) 且成交量放大→多头逻辑失效`];
  const q5Short = [`收盘站回 MA20(${round(ma20)}) 且成交量放大→空头逻辑失效`];

  // Q6 可计算项
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
    q2: {
      judgment,
      trendSide,
      volumeConviction: `volMult ${volMult}x（${volMult != null && volMult >= 1.2 ? '量能确认' : '量能不足'}`,
      oiStructure: oiChg == null ? 'OI 数据不可得' : `OI 5日 ${oiChg >= 0 ? '+' : ''}${oiChg}%`,
      priceAlignment: `close ${close} vs MA20(${round(ma20)})/MA60(${round(ma60)})，5日 ${chg5 >= 0 ? '+' : ''}${chg5}%，${trendSide}`,
    },
    q4: { long: q4Long, short: q4Short },
    q5: { long: q5Long, short: q5Short },
    q6: {
      contractValue: round(contractValue, 0),
      marginRange: margin,
      overnightGap: /shfe|dce|czce/i.test(p.exchange) ? `${p.exchange.toUpperCase()} 有夜盘，存在隔夜跳空风险` : '无夜盘（以交易所公告为准）',
      tail3dP95ReversePct: tail,
      limitDistance: '涨跌停幅度以交易所当日公告为准',
    },
  };
}

function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--runId');
  const runId = i >= 0 ? args[i + 1] : null;
  if (!runId) throw new Error('--runId required');
  const runPath = path.join(EL, 'runs', runId);
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
