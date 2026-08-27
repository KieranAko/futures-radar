/**
 * analyze/freeze-packets.mjs — Analyze 阶段步骤 1（自动）
 * 冻结 evidence-packets.json：raw.json 字段 + term_structure（akshare 近远月报价）注入
 * 品种串行 + 品种间间隔（pacing）；失败退避在 fetchNearFarCloses / Python 内处理
 * 同时渲染 FinCoT prompts 到 {runDir}/analyze/prompts/ 供 LLM 推理
 *
 * Usage:
 *   node analyze/freeze-packets.mjs --runId 20260825-1020-auto
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { buildPacketFromRawJson } from '../reasoning/lib/raw-adapter.js';
import { buildPacket } from '../reasoning/lib/packet-builder.js';
import { buildPacketBundle } from '../reasoning/lib/packet-bundle.js';
import { extractTermStructure } from '../reasoning/lib/term-structure.js';
import { fetchContractHistory, overrideWithCleanSeries } from '../reasoning/lib/specific-contract.js';
import { renderFourArmPrompts } from '../reasoning/lib/prompt-renderer.js';
import { buildMacroContext } from '../reasoning/lib/macro-context.js';

const require = createRequire(import.meta.url);
const { runDir } = require('../lib/workspace.cjs');
const { validateMacroSnapshot } = require('../collector/macro-probe.cjs');
const { relevantAnchorsFor } = require('../report/build-facts.cjs');

const SYMBOL_GAP_MS = 2000; // 品种间 pacing（配合 Python 内 0.5s/合约，压低 sina 请求速率）
const OBSERVED_FIELDS = ['price_data', 'volume_oi'];

const args = process.argv.slice(2);
const flagVal = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? null : args[i + 1];
};
const runId = flagVal('--runId');
if (!runId) {
  console.error('FATAL: --runId required');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dir = runDir(runId);
const rawJsonPath = path.join(dir, 'raw.json');
const filteredPath = path.join(dir, 'filtered.json');
for (const p of [rawJsonPath, filteredPath]) {
  if (!fs.existsSync(p)) {
    console.error(`FATAL: missing input: ${p}`);
    process.exit(1);
  }
}

const rawData = JSON.parse(fs.readFileSync(rawJsonPath, 'utf-8'));
const filtered = JSON.parse(fs.readFileSync(filteredPath, 'utf-8'));
const keeps = (filtered.candidates || []).filter((c) => c.decision === 'KEEP');
if (keeps.length === 0) {
  console.error('FATAL: no KEEP candidates in filtered.json');
  process.exit(1);
}

// signalDate = KEEP 合约各自的最后 bar 日期，必须全部一致（bundle 契约）
const lastDates = keeps.map((c) => {
  const dates = rawData.contracts?.[c.symbol]?.ohlcv?.dates;
  return dates?.[dates.length - 1] ?? null;
});
if (lastDates.some((d) => d !== lastDates[0] || d === null)) {
  console.error(`FATAL: inconsistent last-bar dates across KEEP symbols: ${JSON.stringify(lastDates)}`);
  process.exit(1);
}
const signalDate = lastDates[0];

console.log(`runId=${runId} signalDate=${signalDate} KEEP=${keeps.map((c) => c.symbol).join(',')}`);

// 阶段二：读冻结 macro-snapshot.json（Stage 1 产物），每品种 packet 注入顶层 macro_context（fail-closed）
const macroSnapshotPath = path.join(dir, 'macro-snapshot.json');
let macroSnapshot = null;
let macroValidation = null;
let macroReadError = null;
if (fs.existsSync(macroSnapshotPath)) {
  try {
    macroSnapshot = JSON.parse(fs.readFileSync(macroSnapshotPath, 'utf-8'));
  } catch (err) {
    macroReadError = err.message;
  }
} else {
  macroReadError = 'macro-snapshot.json not found';
}
if (macroSnapshot) {
  try {
    macroValidation = validateMacroSnapshot(macroSnapshot);
  } catch (err) {
    macroValidation = { ok: false, errors: [`validateMacroSnapshot threw: ${err.message}`] };
  }
}

const packets = [];
const mainSeries = {}; // { [symbol]: { contract, bars } } 供 probability 阶段使用干净序列
for (let i = 0; i < keeps.length; i++) {
  const symbol = keeps[i].symbol;
  console.log(`[${i + 1}/${keeps.length}] ${symbol}: building packet...`);

  const raw = buildPacketFromRawJson(rawJsonPath, symbol, signalDate);
  raw.packetFrozenAt = new Date().toISOString();
  for (const name of OBSERVED_FIELDS) {
    if (raw.fields[name] && raw.fields[name].gap === null) {
      raw.fields[name]._timestamp_origin = 'observed';
    }
  }

  const { field: tsField, dominantContract, contractsResult } = await extractTermStructure(rawJsonPath, symbol, signalDate);
  if (tsField.gap === null) {
    raw.fields.term_structure = tsField;
    raw.packetFrozenAt = tsField.fetchedAt;
    console.log(
      `  term_structure: ${tsField.shape} spread=${tsField.spread_pct}% ` +
      `(${tsField.near_contract} ${tsField.near_price} / ${tsField.main_contract} ${tsField.main_price} / ${tsField.far_contract} ${tsField.far_price})`
    );
  } else {
    console.log(`  term_structure: gap=missing (near/far 报价不可用)`);
  }

  // 阶段二：macro_context 注入（三态由 buildMacroContext 决定；证据仅观察值，relation 不写入）
  raw.macro_context = buildMacroContext({
    snapshot: macroSnapshot,
    validation: macroValidation,
    readError: macroReadError,
    runId,
    signalDate,
    symbol,
    relevantAnchors: relevantAnchorsFor(symbol)
  });
  const mc = raw.macro_context;
  console.log(
    mc.status === 'available'
      ? `  macro_context: available evidence=${mc.evidence.map((e) => e.id).join(',')} gaps=${mc.gaps.map((g) => g.id).join(',') || 'none'}`
      : `  macro_context: ${mc.status}${mc.reason ? ` (${mc.reason})` : ''}`
  );

  // P0：主导合约干净序列覆盖 price_data / volume_oi（架构裁定：主力连续是筛选指数，不是价格水平数据源）
  // P1：主导合约复用 extractTermStructure 的单一解析点（term_structure.main 与 price_data 同源，杜绝口径分叉）
  // v0.1.3：主导合约历史已随 term-structure 同进程抓取（--contracts 模式附带 bars），
  // 免去第二次 spawn 重复下载同一合约全量历史；payload 缺失/异常时回退原 fetchContractHistory。
  if (dominantContract) {
    const tsBars = contractsResult && contractsResult[dominantContract] && Array.isArray(contractsResult[dominantContract].bars)
      ? contractsResult[dominantContract].bars
      : null;
    // 120 bar：probability 阶段 HV percentile（需 ≥110 bar）用同一干净序列
    let historyBars;
    let historySource;
    if (tsBars && tsBars.length > 0) {
      historyBars = tsBars;
      historySource = 'term-structure payload (single spawn)';
    } else {
      historyBars = await fetchContractHistory(dominantContract, signalDate, { bars: 120 });
      historySource = 'history spawn (fallback)';
    }
    const historyFetchedAt = new Date().toISOString();
    const override = overrideWithCleanSeries(raw, dominantContract, historyBars, historyFetchedAt);
    if (override.ok) {
      // 封存时刻必须晚于历史抓取完成时刻（约束：fetchedAt ≤ packetFrozenAt）
      raw.packetFrozenAt = new Date().toISOString();
      mainSeries[symbol] = { contract: dominantContract, bars: historyBars };
      const pd = raw.fields.price_data;
      const maNote = pd.ma60 === null ? ' (ma60=null: 历史不足60bar)' : '';
      console.log(
        `  clean series: ${dominantContract} ${historyBars.length} bars (${historySource}) → ma20=${pd.ma20?.toFixed?.(2) ?? pd.ma20}` +
        ` ma60=${pd.ma60?.toFixed?.(2) ?? pd.ma60}${maNote}`
      );
    } else {
      console.log(`  clean series: FAILED (${override.error}) → fallback 主力连续（price_data 保持原口径）`);
    }
  } else {
    console.log(`  clean series: dominant 未解析（候选合约均不可用）→ fallback 主力连续（price_data 保持原口径）`);
  }

  const { packet, validation } = buildPacket(raw);
  if (!validation.schema.valid) {
    console.warn(`  WARN: schema invalid — ${JSON.stringify(validation.schema.errors ?? [])}`);
  }
  if (!validation.timeBoundary.valid) {
    console.warn(`  WARN: time boundary invalid — ${JSON.stringify(validation.timeBoundary.violations ?? [])}`);
  }
  // P1 复审修复：macro_context 非法（快照/路由上游异常）→ FATAL，拒绝封存非法 packet（fail-closed）
  if (validation.macroContext && !validation.macroContext.valid) {
    console.error(`FATAL: ${symbol} macro_context invalid — ${JSON.stringify(validation.macroContext.errors ?? [])}`);
    console.error('macro_context 非法说明 macro-snapshot 或传导路由异常；修复上游后重跑 freeze-packets');
    process.exit(1);
  }
  packets.push(packet);

  if (i < keeps.length - 1) {
    console.log(`  pacing: waiting ${SYMBOL_GAP_MS / 1000}s before next symbol`);
    await sleep(SYMBOL_GAP_MS);
  }
}

if (Object.keys(mainSeries).length > 0) {
  const mainSeriesPath = path.join(dir, 'analyze', 'main-series.json');
  fs.mkdirSync(path.dirname(mainSeriesPath), { recursive: true });
  fs.writeFileSync(mainSeriesPath, JSON.stringify(mainSeries, null, 2));
  console.log(`Wrote analyze/main-series.json (${Object.keys(mainSeries).length} symbols)`);
}

const bundle = buildPacketBundle({ runId, signalDate, packets });
fs.writeFileSync(path.join(dir, 'evidence-packets.json'), JSON.stringify(bundle, null, 2));
console.log(`Wrote evidence-packets.json (${bundle.packets.length} packets)`);

const promptsDir = path.join(dir, 'analyze', 'prompts');
fs.mkdirSync(promptsDir, { recursive: true });
for (const packet of bundle.packets) {
  const prompts = renderFourArmPrompts(packet);
  fs.writeFileSync(path.join(promptsDir, `${packet.symbol}-fincot.md`), prompts.finCot);
}
console.log(`Wrote FinCoT prompts to ${promptsDir}`);
