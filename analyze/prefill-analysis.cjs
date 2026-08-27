#!/usr/bin/env node
/**
 * analyze/prefill-analysis.cjs — Stage 4 六问草稿预填充（v0.1.4，保守模式）
 *
 * 定位：只做确定性草稿，不做任何分析判断。
 *   - 从 candidates.json / raw.json 自动填充 Q2 量价仓结构、Q3 技术面多空证据、Q6 可计算风险项。
 *   - Q1 驱动、Q4 确认信号、Q5 失效条件仍必须由 LLM 完成。
 *   - 输出 analysis.draft.json，绝不覆盖 LLM 的 analysis.json。
 *
 * Usage:
 *   node analyze/prefill-analysis.cjs --runId <runId>
 */

const fs = require('fs');
const path = require('path');
const { runtimeRoot, skillRoot } = require('../lib/workspace.cjs');

const args = process.argv.slice(2);
const flagVal = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? null : args[i + 1];
};
const runId = flagVal('--runId');
const customRunDir = flagVal('--runDir');
if (!runId) {
  console.error('ERROR: --runId is required');
  process.exit(1);
}

const RUN_DIR = customRunDir || path.join(runtimeRoot, 'runs', runId);
const filteredPath = path.join(RUN_DIR, 'filtered.json');
const candidatesPath = path.join(RUN_DIR, 'candidates.json');
const rawPath = path.join(RUN_DIR, 'raw.json');

for (const p of [filteredPath, candidatesPath, rawPath]) {
  if (!fs.existsSync(p)) {
    console.error(`ERROR: missing input: ${p}`);
    process.exit(1);
  }
}

function mean(arr) {
  if (!arr || arr.length === 0) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function last(arr) {
  return Array.isArray(arr) && arr.length > 0 ? arr[arr.length - 1] : null;
}

function pct(cur, prev) {
  if (cur == null || prev == null || prev === 0) return null;
  return parseFloat((((cur - prev) / prev) * 100).toFixed(2));
}

function buildQ2(candidate, contract) {
  const o = contract && contract.ohlcv;
  const ind = candidate.indicators || {};
  const volMult = ind.volMultiplier;
  const change5d = ind.change5d;
  const trend = candidate.trend || {};
  const vsMA20 = trend.vsMA20;

  const oi = o && Array.isArray(o.openInterest) ? o.openInterest : [];
  const oiLast = last(oi);
  const oiAvg5 = mean(oi.slice(-5));
  const oiDelta = pct(oiLast, oiAvg5);
  const closeLast = last(o && o.close);

  let volumeConviction = 'mixed';
  if (volMult != null) {
    if (volMult >= 1.5) volumeConviction = 'volume_confirmed';
    else if (volMult < 0.8) volumeConviction = 'fading';
  }

  let oiStructure = 'mixed';
  if (oiDelta != null && change5d != null) {
    if (oiDelta > 1 && change5d > 0) oiStructure = 'long_building';
    else if (oiDelta > 1 && change5d < 0) oiStructure = 'short_building';
    else if (oiDelta < -1 && change5d < 0) oiStructure = 'longs_exiting';
    else if (oiDelta < -1 && change5d > 0) oiStructure = 'shorts_covering';
  }

  let priceAlignment = 'mixed';
  if (vsMA20 != null && change5d != null) {
    priceAlignment = (vsMA20 > 0 && change5d > 0) || (vsMA20 < 0 && change5d < 0)
      ? 'aligned'
      : 'opposed';
  }

  let judgment = 'mixed';
  if (volumeConviction === 'fading' || (volMult != null && volMult < 1.0)) judgment = 'impulse';
  else if (volumeConviction === 'volume_confirmed' && priceAlignment === 'aligned') judgment = 'trend';

  return {
    judgment,
    volumeConviction: {
      value: volMult != null ? parseFloat(volMult.toFixed(2)) : null,
      label: volumeConviction,
      note: volMult != null
        ? `volMultiplier=${volMult.toFixed(2)}（>=1.5 放量确认；<0.8 动能衰减）`
        : 'volMultiplier 缺失，待 LLM 确认'
    },
    oiStructure: {
      label: oiStructure,
      note: oiDelta != null
        ? `近5日持仓变化 ${oiDelta > 0 ? '+' : ''}${oiDelta}%`
        : '持仓数据不足，待 LLM 确认'
    },
    priceAlignment: {
      label: priceAlignment,
      note: vsMA20 != null && change5d != null
        ? `vsMA20=${vsMA20}%，5日变化=${change5d}%`
        : '价格结构数据不足，待 LLM 确认'
    },
    close: closeLast
  };
}

function buildQ3(candidate, contract) {
  const o = contract && contract.ohlcv;
  const ind = candidate.indicators || {};
  const trend = candidate.trend || {};
  const change5d = ind.change5d;
  const vsMA20 = trend.vsMA20;
  const vsMA60 = trend.vsMA60;
  const volMult = ind.volMultiplier;
  const oi = o && Array.isArray(o.openInterest) ? o.openInterest : [];
  const oiLast = last(oi);
  const oiAvg5 = mean(oi.slice(-5));
  const oiDelta = pct(oiLast, oiAvg5);

  const longCase = [];
  const shortCase = [];

  if (vsMA20 != null && vsMA20 > 0) longCase.push(`价格位于 MA20 上方 (+${vsMA20}%)，趋势支持多头`);
  if (vsMA60 != null && vsMA60 > 0) longCase.push(`价格位于 MA60 上方 (+${vsMA60}%)，中期结构偏多`);
  if (vsMA20 != null && vsMA20 < 0) shortCase.push(`价格位于 MA20 下方 (${vsMA20}%)，趋势支持空头`);
  if (vsMA60 != null && vsMA60 < 0) shortCase.push(`价格位于 MA60 下方 (${vsMA60}%)，中期结构偏空`);

  if (change5d != null) {
    if (change5d > 0) longCase.push(`近5日涨幅 ${change5d}%`);
    if (change5d < 0) shortCase.push(`近5日跌幅 ${change5d}%`);
  }

  if (volMult != null) {
    if (volMult >= 1.5 && change5d != null && change5d > 0) longCase.push(`放量 ${volMult.toFixed(2)}x 且价格上涨，资金流入迹象`);
    if (volMult >= 1.5 && change5d != null && change5d < 0) shortCase.push(`放量 ${volMult.toFixed(2)}x 且价格下跌，资金流出迹象`);
    if (volMult < 0.8) shortCase.push(`成交量收缩至 ${volMult.toFixed(2)}x，反弹动能不足`);
  }

  if (oiDelta != null) {
    if (oiDelta > 1 && change5d != null && change5d > 0) longCase.push(`持仓增加 ${oiDelta}% 且价格上涨，新多进场`);
    if (oiDelta > 1 && change5d != null && change5d < 0) shortCase.push(`持仓增加 ${oiDelta}% 且价格下跌，新空进场`);
    if (oiDelta < -1) shortCase.push(`持仓减少 ${Math.abs(oiDelta)}%，资金撤离`);
  }

  if (longCase.length === 0) longCase.push('技术面暂无明确多头证据，待 LLM 补充基本面/资金面');
  if (shortCase.length === 0) shortCase.push('技术面暂无明确空头证据，待 LLM 补充基本面/资金面');

  return {
    bias: (candidate.directionBias || 'neutral'),
    longCase,
    shortCase,
    summary: '技术面证据由 prefill 自动生成；LLM 必须补充驱动面证据并给出最终多空判断。'
  };
}

function buildQ6(candidate, contract) {
  const o = contract && contract.ohlcv;
  const close = last(o && o.close);
  const multiplier = contract && contract.multiplier ? contract.multiplier : 1;
  const exchange = (candidate.exchange || contract.exchange || '').toUpperCase();

  const nightSessionExchanges = new Set(['SHFE', 'INE', 'DCE']);
  const overnightGap = nightSessionExchanges.has(exchange)
    ? `${exchange} 有夜盘交易，存在隔夜跳空风险`
    : `${exchange || '未知交易所'} 夜盘信息待确认`;

  const contractValue = close != null ? Math.round(close * multiplier) : null;

  return {
    limitDistance: {
      note: '涨跌停距离需按品种实际涨跌停幅度计算，prefill 不填充，待 LLM 补充'
    },
    overnightGap,
    margin: contractValue != null
      ? `合约价值约 ${contractValue.toLocaleString()} 元/手，按 5%-15% 保证金估算`
      : '合约价值待 LLM 补充',
    eventRisk: '待 WebSearch 补充近期宏观/产业事件'
  };
}

function main() {
  const filtered = JSON.parse(fs.readFileSync(filteredPath, 'utf8'));
  const candidatesData = JSON.parse(fs.readFileSync(candidatesPath, 'utf8'));
  const raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'));

  const keeps = (filtered.candidates || []).filter((c) => c.decision === 'KEEP');
  const candidateMap = new Map(candidatesData.candidates.map((c) => [c.symbol, c]));

  const analyses = [];
  for (const keep of keeps) {
    const candidate = candidateMap.get(keep.symbol);
    const contract = raw.contracts && raw.contracts[keep.symbol];
    if (!candidate || !contract) continue;

    analyses.push({
      symbol: keep.symbol,
      name: keep.name,
      reasoningRef: {
        artifactId: 'reasoning-results-json',
        packetHash: null,
        arm: 'fincot'
      },
      direction: keep.directionBias || 'neutral',
      confidence: keep.confidence || 'low',
      override: null,
      q1_driver: {
        _pending: true,
        primary: null,
        secondary: null,
        evidence: null,
        source: null,
        note: '必须由 LLM 填写：识别主导驱动并引用 WebSearch/宏观快照证据'
      },
      q2_trendOrImpulse: buildQ2(candidate, contract),
      q3_odds: buildQ3(candidate, contract),
      q4_confirmation: {
        _pending: true,
        signals: [],
        note: '必须由 LLM 填写 2-3 个可证伪的具体触发条件'
      },
      q5_invalidation: {
        _pending: true,
        conditions: [],
        note: '必须由 LLM 填写 1-2 个可证伪的失效条件'
      },
      q6_risks: buildQ6(candidate, contract),
      enhancedData: {
        webSearchSources: [],
        correlationCheck: '待 LLM 补充'
      }
    });
  }

  const draft = {
    meta: {
      runId,
      prefillAt: new Date().toISOString(),
      prefillVersion: '0.1.0',
      mode: 'draft',
      candidateCount: analyses.length,
      note: 'DRAFT ONLY — Q1/Q4/Q5 与所有 pending 字段必须由 LLM 完成后才能作为 analysis.json'
    },
    analyses
  };

  const outPath = path.join(RUN_DIR, 'analysis.draft.json');
  fs.writeFileSync(outPath, JSON.stringify(draft, null, 2));
  console.log(`analysis.draft.json → ${outPath}`);
  console.log(`prefilled ${analyses.length} candidates (Q2/Q3/Q6 technical fields only)`);
}

main();
