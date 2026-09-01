#!/usr/bin/env node
/**
 * data-store/index.cjs — futures-radar 轻量文件库（v0.1.4）
 *
 * 定位：把采集层产出的可复用数据按固定规则落到 SKILL 内的 data/ 目录。
 * 纯 JSON + JSONL，无 SQL、无第三方依赖。raw.json 仍是每个 run 的冻结权威，
 * 本文件库是跨 run 的可维护数据层，供增量采集、回测、概率锥回退使用。
 *
 * 目录：
 *   data/daily/<SYMBOL>.json           当前最优日线序列（每品种一个文件）
 *   data/ledger/<SYMBOL>/<YYYY-MM>.jsonl append-only 入账流水（审计/重建）
 *   data/contract-bars/<CONTRACT>.json  具体合约 bars（按 run 保留）
 *   data/macro/<RUN_ID>.json            宏观快照（与 run 的 macro-snapshot.json 同构）
 *   data/export/historical-cache.json   回测兼容导出（可重建）
 *
 * CLI：
 *   node data-store/index.cjs --init
 *   node data-store/index.cjs --seed
 *   node data-store/index.cjs --verify
 *   node data-store/index.cjs --stats
 *   node data-store/index.cjs --export
 *   node data-store/index.cjs --compact [--symbol RB0]
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const { skillRoot, runtimeRoot } = require('../lib/workspace.cjs');

const DATA_ROOT = process.env.FUTURES_DATA_ROOT
  ? path.resolve(process.env.FUTURES_DATA_ROOT)
  : path.join(skillRoot, 'data');
const DAILY_DIR = path.join(DATA_ROOT, 'daily');
const LEDGER_DIR = path.join(DATA_ROOT, 'ledger');
const CONTRACT_BARS_DIR = path.join(DATA_ROOT, 'contract-bars');
const MACRO_DIR = path.join(DATA_ROOT, 'macro');
const SECTOR_DIR = path.join(DATA_ROOT, 'sector');
const COST_ANCHOR_DIR = path.join(DATA_ROOT, 'cost-anchor');
const EXPORT_DIR = path.join(DATA_ROOT, 'export');

const DAILY_SCHEMA = 'futures-radar-daily/1';
const CONTRACT_SCHEMA = 'futures-radar-contract-bars/1';
const MACRO_SCHEMA = 'futures-radar-macro-snapshot/1';
const SECTOR_SCHEMA = 'futures-radar-sector-snapshot/1';
const SECTOR_SERIES_SCHEMA = 'futures-radar-sector-series/1';
const COST_ANCHOR_SCHEMA = 'futures-radar-cost-anchor-history/1';

// 同日期多来源时的取舍：日线接口优先于收盘快照；具体合约序列只用于 contract-bars
const SOURCE_PRIORITY = {
  akshare_sina_dayline: 3,
  akshare_sina_contract: 3,
  sina_close_snapshot: 1,
  legacy: 0
};

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath, row) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(row) + '\n', 'utf8');
}

function ensureDirs() {
  for (const dir of [DATA_ROOT, DAILY_DIR, LEDGER_DIR, CONTRACT_BARS_DIR, MACRO_DIR, SECTOR_DIR, COST_ANCHOR_DIR, EXPORT_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ── 工具：数组按日期插入/替换（保持严格升序）───────────────────
function sortedIndex(dates, date) {
  let lo = 0;
  let hi = dates.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid] < date) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function buildSources(contract) {
  const o = contract && contract.ohlcv;
  if (!o || !Array.isArray(o.dates)) return [];
  const sources = new Array(o.dates.length).fill('akshare_sina_dayline');
  if (o.sources && Array.isArray(o.sources) && o.sources.length === o.dates.length) {
    return o.sources.slice();
  }
  const lastBarSource = String(contract.lastBarSource || '');
  const lastBarAsOf = contract.lastBarAsOf;
  if (lastBarSource.includes('snapshot') && lastBarAsOf && o.dates.length > 0 && o.dates[o.dates.length - 1] === lastBarAsOf) {
    sources[sources.length - 1] = 'sina_close_snapshot';
  }
  return sources;
}

function normalizeOhlcv(contract) {
  const o = contract && contract.ohlcv;
  if (!o || !Array.isArray(o.dates)) return null;
  const n = o.dates.length;
  const oi = o.openInterest !== undefined ? o.openInterest : o.open_interest;
  const settle = Array.isArray(o.settle) ? o.settle : new Array(n).fill(null);
  const turnover = Array.isArray(o.turnover)
    ? o.turnover
    : new Array(n).fill(null);
  return {
    dates: o.dates.slice(),
    open: o.open.slice(),
    high: o.high.slice(),
    low: o.low.slice(),
    close: o.close.slice(),
    volume: o.volume.slice(),
    turnover: turnover.slice(),
    openInterest: Array.isArray(oi) ? oi.slice() : new Array(n).fill(null),
    settle: settle.slice(),
    sources: buildSources(contract)
  };
}

/**
 * 将 incoming 合约合并进 existing 合约。
 * 规则：日期缺失 → 插入；已存在 → 来源优先级 + fetchedAt 新者胜。
 * @returns {{ contract: object, changed: Array<object> }}
 */
function mergeContractBars(existing, incoming) {
  const base = existing
    ? JSON.parse(JSON.stringify(existing))
    : {
        symbol: incoming.symbol,
        name: incoming.name || incoming.symbol,
        exchange: incoming.exchange || 'unknown',
        sector: incoming.sector || 'unknown',
        multiplier: incoming.multiplier || 1,
        unit: incoming.unit || '',
        status: 'ok',
        ohlcv: null
      };

  const baseOhlcv = normalizeOhlcv(base);
  const incOhlcv = normalizeOhlcv(incoming);
  if (!incOhlcv || incOhlcv.dates.length === 0) {
    return { contract: base, changed: [] };
  }

  const dates = baseOhlcv ? baseOhlcv.dates.slice() : [];
  const arrays = baseOhlcv || {
    dates: [],
    open: [], high: [], low: [], close: [], volume: [],
    turnover: [], openInterest: [], settle: [], sources: []
  };
  const indexMap = new Map(dates.map((d, i) => [d, i]));
  const changed = [];

  for (let i = 0; i < incOhlcv.dates.length; i++) {
    const date = incOhlcv.dates[i];
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const incSource = incOhlcv.sources[i] || 'akshare_sina_dayline';
    const incPriority = SOURCE_PRIORITY[incSource] ?? SOURCE_PRIORITY.legacy;
    const existingIdx = indexMap.get(date);

    if (existingIdx === undefined) {
      const at = sortedIndex(dates, date);
      for (const key of Object.keys(arrays)) {
        arrays[key].splice(at, 0, incOhlcv[key][i]);
      }
      dates.splice(at, 0, date);
      for (let j = 0; j < dates.length; j++) indexMap.set(dates[j], j);
      changed.push({ date, reason: 'added', source: incSource });
      continue;
    }

    const exSource = arrays.sources[existingIdx] || 'akshare_sina_dayline';
    const exPriority = SOURCE_PRIORITY[exSource] ?? SOURCE_PRIORITY.legacy;
    const incFetchedAt = incoming.fetchedAt || '';
    const exFetchedAt = base.fetchedAt || '';
    if (incPriority > exPriority || (incPriority === exPriority && incFetchedAt > exFetchedAt)) {
      for (const key of Object.keys(arrays)) {
        arrays[key][existingIdx] = incOhlcv[key][i];
      }
      changed.push({ date, reason: 'replaced', source: incSource, previousSource: exSource });
    }
  }

  const n = dates.length;
  if (n === 0) {
    base.ohlcv = null;
    return { contract: base, changed };
  }

  // 末 bar 元数据：仅当 incoming 覆盖合并后的最后一根 bar 时才采用其盖章
  const lastDate = dates[n - 1];
  const incCoversLast = incOhlcv.dates.includes(lastDate);
  base.ohlcv = arrays;
  base.fetchedAt = incoming.fetchedAt || base.fetchedAt || new Date().toISOString();
  base.totalBars = n;
  base.usedBars = n;
  base.dataStart = dates[0];
  base.dataEnd = lastDate;
  base.cacheReused = false;
  base.cacheOriginRunId = null;
  if (incCoversLast) {
    base.lastBarSource = incoming.lastBarSource || (String(arrays.sources[n - 1]).includes('snapshot') ? 'sina_close_snapshot' : 'akshare_sina_daily');
    base.lastBarAsOf = incoming.lastBarAsOf || lastDate;
    base.lastBarNote = incoming.lastBarNote || null;
    base.lastBarVerification = incoming.lastBarVerification || null;
  } else {
    base.lastBarSource = String(arrays.sources[n - 1]).includes('snapshot') ? 'sina_close_snapshot' : 'akshare_sina_daily';
    base.lastBarAsOf = base.lastBarAsOf || lastDate;
  }
  return { contract: base, changed };
}

function loadDailyWrapper(symbol) {
  return readJson(path.join(DAILY_DIR, `${symbol}.json`));
}

function writeDailyWrapper(symbol, wrapper) {
  writeJsonAtomic(path.join(DAILY_DIR, `${symbol}.json`), wrapper);
}

function ledgerRowFromBar(runId, symbol, incoming, date, source, reason, previousSource) {
  const o = incoming.ohlcv;
  const idx = o.dates.indexOf(date);
  if (idx < 0) return null;
  const isLast = idx === o.dates.length - 1;
  return {
    ingestedAt: new Date().toISOString(),
    runId,
    symbol,
    date,
    source,
    previousSource: previousSource || null,
    reason,
    fetchedAt: incoming.fetchedAt || null,
    open: o.open[idx],
    high: o.high[idx],
    low: o.low[idx],
    close: o.close[idx],
    settle: o.settle ? o.settle[idx] : null,
    volume: o.volume[idx],
    openInterest: o.openInterest ? o.openInterest[idx] : null,
    verification: isLast && incoming.lastBarVerification ? incoming.lastBarVerification : null
  };
}

function appendChangedLedger(runId, symbol, incoming, changed) {
  for (const ch of changed) {
    const row = ledgerRowFromBar(runId, symbol, incoming, ch.date, ch.source, ch.reason, ch.previousSource);
    if (!row) continue;
    const month = ch.date.slice(0, 7);
    appendJsonl(path.join(LEDGER_DIR, symbol, `${month}.jsonl`), row);
  }
}

function updateDailyIndex(wrapper) {
  const indexPath = path.join(DAILY_DIR, '_index.json');
  const index = readJson(indexPath, { schema: 'futures-radar-daily-index/1', updatedAt: null, symbols: {} });
  const c = wrapper.contract;
  const dates = c.ohlcv && Array.isArray(c.ohlcv.dates) ? c.ohlcv.dates : [];
  index.updatedAt = new Date().toISOString();
  index.symbols[wrapper.symbol] = {
    symbol: wrapper.symbol,
    updatedAt: wrapper.updatedAt,
    lastRunId: wrapper.lastRunId,
    lastDate: dates.length > 0 ? dates[dates.length - 1] : null,
    bars: dates.length
  };
  writeJsonAtomic(indexPath, index);
}

// ── 公共 API ────────────────────────────────────────────────

function init() {
  ensureDirs();
  for (const [dir, indexData] of [
    [DAILY_DIR, { schema: 'futures-radar-daily-index/1', updatedAt: null, symbols: {} }],
    [LEDGER_DIR, { schema: 'futures-radar-ledger-manifest/1', updatedAt: null, symbols: {} }],
    [CONTRACT_BARS_DIR, { schema: 'futures-radar-contract-index/1', updatedAt: null, contracts: {} }],
    [MACRO_DIR, { schema: 'futures-radar-macro-index/1', updatedAt: null, runs: {} }],
    [SECTOR_DIR, { schema: 'futures-radar-sector-index/1', updatedAt: null, sectors: {}, runs: {} }]
  ]) {
    const p = path.join(dir, dir === LEDGER_DIR ? '_manifest.json' : '_index.json');
    if (!fs.existsSync(p)) writeJsonAtomic(p, indexData);
  }
  return { ok: true, dataRoot: DATA_ROOT };
}

/**
 * 把一个 run 的 enriched raw.json 全部写入文件库。
 * raw.json 仍是 run 权威；这里失败只应由调用方决定是否阻断。
 */
function ingestRunBars({ runId, rawJson, provenance }) {
  ensureDirs();
  const contracts = (rawJson && rawJson.contracts) || {};
  const symbols = Object.keys(contracts);
  const result = { runId, symbols: symbols.length, written: 0, barsChanged: 0 };

  for (const symbol of symbols) {
    const incoming = contracts[symbol];
    const existingWrapper = loadDailyWrapper(symbol);
    const { contract, changed } = mergeContractBars(
      existingWrapper ? existingWrapper.contract : null,
      incoming
    );
    const wrapper = {
      schema: DAILY_SCHEMA,
      symbol,
      updatedAt: new Date().toISOString(),
      lastRunId: runId,
      contract
    };
    writeDailyWrapper(symbol, wrapper);
    updateDailyIndex(wrapper);
    if (changed.length > 0) {
      appendChangedLedger(runId, symbol, incoming, changed);
      result.barsChanged += changed.length;
    }
    result.written++;
  }

  updateLedgerManifest();
  return result;
}

function updateLedgerManifest() {
  const manifestPath = path.join(LEDGER_DIR, '_manifest.json');
  const manifest = readJson(manifestPath, { schema: 'futures-radar-ledger-manifest/1', updatedAt: null, symbols: {} });
  manifest.updatedAt = new Date().toISOString();
  if (fs.existsSync(LEDGER_DIR)) {
    for (const entry of fs.readdirSync(LEDGER_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const symbolDir = path.join(LEDGER_DIR, entry.name);
      const files = fs.readdirSync(symbolDir).filter((f) => f.endsWith('.jsonl')).sort();
      manifest.symbols[entry.name] = { files, lastFile: files[files.length - 1] || null };
    }
  }
  writeJsonAtomic(manifestPath, manifest);
}

/**
 * 组装出与原 historical-cache.json / raw.json 同构的缓存对象。
 * 每个 daily 文件只含原始合约字段，不含 derived（由消费方重算）。
 */
function loadHistoricalCache() {
  ensureDirs();
  const contracts = {};
  let latestUpdatedAt = null;
  let latestRunId = null;

  if (fs.existsSync(DAILY_DIR)) {
    for (const file of fs.readdirSync(DAILY_DIR).sort()) {
      if (file === '_index.json' || !file.endsWith('.json')) continue;
      const symbol = file.slice(0, -5);
      const wrapper = readJson(path.join(DAILY_DIR, file));
      if (!wrapper || wrapper.schema !== DAILY_SCHEMA || !wrapper.contract) continue;
      contracts[symbol] = wrapper.contract;
      if (!latestUpdatedAt || wrapper.updatedAt > latestUpdatedAt) {
        latestUpdatedAt = wrapper.updatedAt;
        latestRunId = wrapper.lastRunId;
      }
    }
  }

  return {
    meta: {
      runId: latestRunId || 'data-store',
      collectedAt: latestUpdatedAt || null,
      source: 'data-store',
      sourceVersion: DAILY_SCHEMA,
      totalSymbols: Object.keys(contracts).length,
      succeeded: Object.keys(contracts).length,
      failed: 0,
      dateRange: computeDateRange(contracts)
    },
    contracts,
    gaps: {}
  };
}

function computeDateRange(contracts) {
  let earliest = null;
  let latest = null;
  for (const c of Object.values(contracts)) {
    const dates = c.ohlcv && Array.isArray(c.ohlcv.dates) ? c.ohlcv.dates : [];
    if (dates.length === 0) continue;
    if (earliest === null || dates[0] < earliest) earliest = dates[0];
    if (latest === null || dates[dates.length - 1] > latest) latest = dates[dates.length - 1];
  }
  return { earliest, latest };
}

/**
 * 给 incremental-cache 用：返回 { runId, rawPath, raw } 或 null。
 * rawPath 为 null 表示数据来自文件库（调用方不会真的读文件）。
 */
function getLatestCache({ excludeRunId = null } = {}) {
  const raw = loadHistoricalCache();
  if (!raw.contracts || Object.keys(raw.contracts).length === 0) return null;
  const runId = raw.meta.runId || 'data-store';
  if (excludeRunId && runId === excludeRunId) return null;
  raw.meta.runId = runId;
  return { runId, rawPath: null, raw };
}

/**
 * 导出回测兼容缓存文件，返回导出路径。
 */
function exportHistoricalCache() {
  const cache = loadHistoricalCache();
  cache.meta.exportedAt = new Date().toISOString();
  cache.meta.source = 'data-store-export';
  const outPath = path.join(EXPORT_DIR, 'historical-cache.json');
  writeJsonAtomic(outPath, cache);
  return outPath;
}

// ── 具体合约 bars ──────────────────────────────────────────
function ingestContractBars({ runId, symbol, contract, bars }) {
  ensureDirs();
  if (!contract || !Array.isArray(bars) || bars.length === 0) {
    return { runId, symbol, contract, written: false, reason: 'empty' };
  }
  const filePath = path.join(CONTRACT_BARS_DIR, `${contract}.json`);
  const wrapper = readJson(filePath, {
    schema: CONTRACT_SCHEMA,
    contract,
    updatedAt: null,
    runs: {}
  });
  wrapper.updatedAt = new Date().toISOString();
  wrapper.runs[runId] = { symbol, fetchedAt: new Date().toISOString(), bars };
  writeJsonAtomic(filePath, wrapper);

  const index = readJson(path.join(CONTRACT_BARS_DIR, '_index.json'), {
    schema: 'futures-radar-contract-index/1', updatedAt: null, contracts: {}
  });
  index.updatedAt = new Date().toISOString();
  index.contracts[contract] = { contract, updatedAt: wrapper.updatedAt, runs: Object.keys(wrapper.runs) };
  writeJsonAtomic(path.join(CONTRACT_BARS_DIR, '_index.json'), index);
  return { runId, symbol, contract, written: true, bars: bars.length };
}

/**
 * probability 回退：取某 run 冻结的主导合约 bars。
 */
function getContractBarsForRun(runId, symbol) {
  const index = readJson(path.join(CONTRACT_BARS_DIR, '_index.json'), null);
  const contracts = index && index.contracts ? Object.keys(index.contracts) : [];
  for (const contract of contracts) {
    const wrapper = readJson(path.join(CONTRACT_BARS_DIR, `${contract}.json`));
    const runData = wrapper && wrapper.runs && wrapper.runs[runId];
    if (runData && runData.symbol === symbol && Array.isArray(runData.bars)) {
      return { contract, bars: runData.bars };
    }
  }
  return null;
}

// ── 宏观快照 ────────────────────────────────────────────────
function ingestMacro({ runId, snapshot }) {
  ensureDirs();
  if (!runId || !snapshot) return { runId, written: false, reason: 'missing runId/snapshot' };
  const filePath = path.join(MACRO_DIR, `${runId}.json`);
  writeJsonAtomic(filePath, { schema: MACRO_SCHEMA, snapshot });
  const index = readJson(path.join(MACRO_DIR, '_index.json'), {
    schema: 'futures-radar-macro-index/1', updatedAt: null, runs: {}
  });
  index.updatedAt = new Date().toISOString();
  index.runs[runId] = {
    runId,
    signalDate: snapshot.meta && snapshot.meta.signalDate,
    snapshotFrozenAt: snapshot.meta && snapshot.meta.snapshotFrozenAt,
    updatedAt: new Date().toISOString()
  };
  writeJsonAtomic(path.join(MACRO_DIR, '_index.json'), index);
  return { runId, written: true };
}

/**
 * report 回退：返回与 run 目录中 macro-snapshot.json 完全相同的快照对象。
 */
function getMacroSnapshot(runId) {
  const wrapper = readJson(path.join(MACRO_DIR, `${runId}.json`));
  return wrapper && wrapper.schema === MACRO_SCHEMA ? wrapper.snapshot : null;
}

// ── 板块数据 ────────────────────────────────────────────────
/**
 * 写入一个 run 的板块快照：
 *   data/sector/snapshots/<runId>.json  冻结快照（report/analyze 回退读取）
 *   data/sector/<sectorId>.json         每板块序列（跨 run 维护，供后续回测）
 */
function ingestSectorSnapshot({ runId, snapshot }) {
  ensureDirs();
  if (!runId || !snapshot || !snapshot.sectors) {
    return { runId, written: false, reason: 'missing runId/snapshot' };
  }

  const snapshotPath = path.join(SECTOR_DIR, 'snapshots', `${runId}.json`);
  writeJsonAtomic(snapshotPath, { schema: SECTOR_SCHEMA, snapshot });

  for (const [sectorId, sec] of Object.entries(snapshot.sectors)) {
    const seriesPath = path.join(SECTOR_DIR, `${sectorId}.json`);
    const series = readJson(seriesPath, {
      schema: SECTOR_SERIES_SCHEMA,
      sector: sectorId,
      label: sec.label,
      updatedAt: null,
      rows: []
    });
    const row = {
      date: sec.dataEnd,
      runId,
      direction: sec.direction,
      indexLevel: sec.indexLevel,
      ret1d: sec.ret1d,
      ret5d: sec.ret5d,
      ret20d: sec.ret20d,
      advanceRatio1d: sec.advanceRatio1d,
      advanceRatio5d: sec.advanceRatio5d,
      coherence1d: sec.coherence1d,
      volumeRatio20d: sec.volumeRatio20d,
      leaderSymbol: sec.leaderSymbol,
      leaderName: sec.leaderName,
      leaderRet5d: sec.leaderRet5d,
      members: sec.members
    };
    if (!row.date) continue;
    const existingIdx = series.rows.findIndex((r) => r.date === row.date);
    if (existingIdx >= 0) series.rows[existingIdx] = row;
    else {
      series.rows.push(row);
      series.rows.sort((a, b) => a.date.localeCompare(b.date));
    }
    series.label = sec.label;
    series.updatedAt = new Date().toISOString();
    writeJsonAtomic(seriesPath, series);
  }

  const index = readJson(path.join(SECTOR_DIR, '_index.json'), {
    schema: 'futures-radar-sector-index/1', updatedAt: null, sectors: {}, runs: {}
  });
  index.updatedAt = new Date().toISOString();
  index.runs[runId] = {
    runId,
    signalDate: snapshot.meta && snapshot.meta.signalDate,
    generatedAt: snapshot.meta && snapshot.meta.generatedAt,
    sectors: Object.keys(snapshot.sectors)
  };
  for (const [sectorId, sec] of Object.entries(snapshot.sectors)) {
    index.sectors[sectorId] = { sector: sectorId, label: sec.label, updatedAt: new Date().toISOString() };
  }
  writeJsonAtomic(path.join(SECTOR_DIR, '_index.json'), index);
  return { runId, written: true, sectors: Object.keys(snapshot.sectors).length };
}

function getSectorSnapshot(runId) {
  const wrapper = readJson(path.join(SECTOR_DIR, 'snapshots', `${runId}.json`));
  return wrapper && wrapper.schema === SECTOR_SCHEMA ? wrapper.snapshot : null;
}

function getSectorSeries(sectorId) {
  const wrapper = readJson(path.join(SECTOR_DIR, `${sectorId}.json`));
  return wrapper && wrapper.schema === SECTOR_SERIES_SCHEMA ? wrapper : null;
}

// ── 成本锚主档（theory-base/05；文件库唯一事实源）────────────
const COST_ANCHOR_REQUIRED = [
  'anchorType', 'indicator', 'valueLow', 'valueHigh', 'unit', 'asOf',
  'sourceDates', 'sourceTiers', 'confidence'
];

function normAsOf(asOf) {
  const s = String(asOf || '');
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[0] : s;
}

/**
 * 幂等写入一个品种的成本锚记录。run 快照只能从主档投影。
 */
function ingestCostAnchor({ runId, symbol, record }) {
  ensureDirs();
  if (!runId || !symbol || !record) return { runId, symbol, written: false, reason: 'missing runId/symbol/record' };
  const missing = COST_ANCHOR_REQUIRED.filter((k) => {
    if (record[k] === undefined) return true;
    if (record[k] === null && !(record.confidence === 'unknown' && (k === 'valueLow' || k === 'valueHigh'))) {
      if (Array.isArray(record.routes) && record.routes.length > 0 && (k === 'valueLow' || k === 'valueHigh')) return false;
      return true;
    }
    return false;
  });
  if (missing.length) return { runId, symbol, written: false, reason: `missing fields: ${missing.join(',')}` };

  const filePath = path.join(COST_ANCHOR_DIR, `${symbol}.json`);
  const wrapper = readJson(filePath, {
    schema: COST_ANCHOR_SCHEMA,
    symbol,
    updatedAt: null,
    runs: {}
  });
  const stored = {
    ...record,
    recordId: `${symbol}:${runId}:1`,
    signalDate: record.signalDate || runId.slice(0, 8).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3'),
    ingestedAt: new Date().toISOString()
  };
  wrapper.symbol = symbol;
  wrapper.updatedAt = stored.ingestedAt;
  wrapper.runs[runId] = stored;
  writeJsonAtomic(filePath, wrapper);
  return { runId, symbol, recordId: stored.recordId, written: true };
}

/**
 * 读取品种在 signalDate 可见的最新成本锚（asOf ≤ signalDate，防未来数据）。
 */
function getCostAnchor(symbol, signalDate) {
  const wrapper = readJson(path.join(COST_ANCHOR_DIR, `${symbol}.json`));
  if (!wrapper || wrapper.schema !== COST_ANCHOR_SCHEMA || !wrapper.runs) return null;
  const target = normAsOf(signalDate);
  const records = Object.values(wrapper.runs)
    .map((r) => ({ ...r, _asOfKey: normAsOf(r.asOf) }))
    .filter((r) => r._asOfKey <= target)
    .sort((a, b) => b._asOfKey.localeCompare(a._asOfKey) || b.ingestedAt.localeCompare(a.ingestedAt));
  if (records.length === 0) return null;
  const picked = records[0];
  const { _asOfKey, ...record } = picked;
  return record;
}

function getCostAnchorHistory(symbol) {
  const wrapper = readJson(path.join(COST_ANCHOR_DIR, `${symbol}.json`));
  return wrapper && wrapper.schema === COST_ANCHOR_SCHEMA ? wrapper : null;
}

function costAnchorStats() {
  ensureDirs();
  const symbols = [];
  let records = 0;
  if (fs.existsSync(COST_ANCHOR_DIR)) {
    for (const file of fs.readdirSync(COST_ANCHOR_DIR).sort()) {
      if (!file.endsWith('.json')) continue;
      const symbol = file.slice(0, -5);
      const wrapper = readJson(path.join(COST_ANCHOR_DIR, file));
      if (!wrapper || wrapper.schema !== COST_ANCHOR_SCHEMA) continue;
      const runIds = Object.keys(wrapper.runs || {});
      symbols.push({ symbol, records: runIds.length, latestRun: runIds.sort().pop() || null });
      records += (wrapper.runs ? Object.keys(wrapper.runs).length : 0);
    }
  }
  return { schema: COST_ANCHOR_SCHEMA, symbols: symbols.length, records };
}

function verifyCostAnchors() {
  ensureDirs();
  const errors = [];
  if (!fs.existsSync(COST_ANCHOR_DIR)) return { ok: true, errors };
  const CONFIG_FILES = new Set(['policy.json', 'golden-sources.json', 'query-templates.json', 'coverage.json']);
  for (const file of fs.readdirSync(COST_ANCHOR_DIR).sort()) {
    if (!file.endsWith('.json') || CONFIG_FILES.has(file)) continue;
    const symbol = file.slice(0, -5);
    const wrapper = readJson(path.join(COST_ANCHOR_DIR, file));
    if (!wrapper || wrapper.schema !== COST_ANCHOR_SCHEMA) {
      errors.push(`cost-anchor/${file}: bad schema`);
      continue;
    }
    for (const [runId, r] of Object.entries(wrapper.runs || {})) {
      for (const k of COST_ANCHOR_REQUIRED) {
        if (r[k] === undefined) errors.push(`cost-anchor/${symbol}:${runId}: missing ${k}`);
        if (r[k] === null && !(r.confidence === 'unknown' && (k === 'valueLow' || k === 'valueHigh'))) {
          if (!(Array.isArray(r.routes) && r.routes.length > 0 && (k === 'valueLow' || k === 'valueHigh'))) {
            errors.push(`cost-anchor/${symbol}:${runId}: null ${k}`);
          }
        }
      }
      if (!Array.isArray(r.sourceDates) || r.sourceDates.length === 0) {
        errors.push(`cost-anchor/${symbol}:${runId}: sourceDates must be non-empty array`);
      }
      if (!Array.isArray(r.sourceTiers) || r.sourceTiers.length === 0) {
        errors.push(`cost-anchor/${symbol}:${runId}: sourceTiers must be non-empty array`);
      }
      const hasRoutes = Array.isArray(r.routes) && r.routes.length > 0;
      if (r.confidence !== 'unknown' && !hasRoutes && (!Number.isFinite(r.valueLow) || !Number.isFinite(r.valueHigh) || r.valueLow > r.valueHigh)) {
        errors.push(`cost-anchor/${symbol}:${runId}: invalid value range`);
      }
      if (normAsOf(r.asOf) > todayStr()) {
        errors.push(`cost-anchor/${symbol}:${runId}: future asOf ${r.asOf}`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

// ── 校验 / 统计 / seed / compact ────────────────────────────
function verify() {
  ensureDirs();
  const errors = [];
  const warnings = [];
  const today = todayStr();
  let files = 0;
  let bars = 0;

  if (fs.existsSync(DAILY_DIR)) {
    for (const file of fs.readdirSync(DAILY_DIR).sort()) {
      if (file === '_index.json' || !file.endsWith('.json')) continue;
      files++;
      const symbol = file.slice(0, -5);
      const wrapper = readJson(path.join(DAILY_DIR, file));
      if (!wrapper || wrapper.schema !== DAILY_SCHEMA) {
        errors.push(`${file}: bad schema`);
        continue;
      }
      if (wrapper.symbol !== symbol) errors.push(`${file}: symbol mismatch ${wrapper.symbol}`);
      const c = wrapper.contract;
      const o = c && c.ohlcv;
      if (!o || !Array.isArray(o.dates)) {
        errors.push(`${file}: no ohlcv`);
        continue;
      }
      const n = o.dates.length;
      bars += n;
      for (const key of ['open', 'high', 'low', 'close', 'volume']) {
        if (!Array.isArray(o[key]) || o[key].length !== n) errors.push(`${file}: ${key} length != dates`);
      }
      for (let i = 0; i < n; i++) {
        const d = o.dates[i];
        if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`))) {
          errors.push(`${file}: bad date at ${i} (${d})`);
          break;
        }
        if (i > 0 && !(o.dates[i] > o.dates[i - 1])) {
          errors.push(`${file}: dates not strictly ascending at ${i}`);
          break;
        }
        if (d > today) {
          errors.push(`${file}: future date ${d}`);
          break;
        }
        if (!Number.isFinite(o.open[i]) || !Number.isFinite(o.high[i]) || !Number.isFinite(o.low[i]) || !Number.isFinite(o.close[i])) {
          errors.push(`${file}: non-finite OHLC at ${i} (${d})`);
          break;
        }
      }
      if (Array.isArray(o.sources) && o.sources.length !== n) errors.push(`${file}: sources length != dates`);
    }
  }

  if (fs.existsSync(LEDGER_DIR)) {
    for (const entry of fs.readdirSync(LEDGER_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      for (const f of fs.readdirSync(path.join(LEDGER_DIR, entry.name))) {
        if (!f.endsWith('.jsonl')) continue;
        const lines = fs.readFileSync(path.join(LEDGER_DIR, entry.name, f), 'utf8').split('\n').filter(Boolean);
        for (let i = 0; i < lines.length; i++) {
          try {
            const row = JSON.parse(lines[i]);
            if (!row.date || !row.symbol || !row.runId) throw new Error('missing key fields');
          } catch (e) {
            errors.push(`ledger/${entry.name}/${f}:${i + 1} bad row (${e.message})`);
          }
        }
      }
    }
  }

  // sector 快照/序列合法性
  if (fs.existsSync(SECTOR_DIR)) {
    for (const file of fs.readdirSync(SECTOR_DIR)) {
      if (file === '_index.json' || file === 'snapshots' || !file.endsWith('.json')) continue;
      const wrapper = readJson(path.join(SECTOR_DIR, file));
      if (!wrapper || wrapper.schema !== SECTOR_SERIES_SCHEMA) {
        errors.push(`sector/${file}: bad schema`);
        continue;
      }
      for (let i = 1; i < (wrapper.rows || []).length; i++) {
        if (!(wrapper.rows[i].date > wrapper.rows[i - 1].date)) {
          errors.push(`sector/${file}: rows not strictly ascending at ${i}`);
          break;
        }
      }
    }
  }

  const costAnchorCheck = verifyCostAnchors();
  for (const e of costAnchorCheck.errors) errors.push(e);

  return { ok: errors.length === 0, errors, warnings, files, bars };
}

function stats() {
  ensureDirs();
  const cache = loadHistoricalCache();
  const contracts = cache.contracts;
  const symbols = Object.keys(contracts).sort();
  const perSymbol = symbols.map((sym) => {
    const dates = contracts[sym].ohlcv.dates;
    const file = path.join(DAILY_DIR, `${sym}.json`);
    return {
      symbol: sym,
      bars: dates.length,
      first: dates[0],
      last: dates[dates.length - 1],
      bytes: fs.existsSync(file) ? fs.statSync(file).size : 0
    };
  });
  const macroIndex = readJson(path.join(MACRO_DIR, '_index.json'), null);
  const contractIndex = readJson(path.join(CONTRACT_BARS_DIR, '_index.json'), null);
  const sectorIndex = readJson(path.join(SECTOR_DIR, '_index.json'), null);
  return {
    source: 'data-store',
    dailyFiles: symbols.length,
    totalBars: perSymbol.reduce((a, b) => a + b.bars, 0),
    dateRange: cache.meta.dateRange,
    macroRuns: macroIndex && macroIndex.runs ? Object.keys(macroIndex.runs).length : 0,
    contracts: contractIndex && contractIndex.contracts ? Object.keys(contractIndex.contracts).length : 0,
    sectorRuns: sectorIndex && sectorIndex.runs ? Object.keys(sectorIndex.runs).length : 0,
    sectors: sectorIndex && sectorIndex.sectors ? Object.keys(sectorIndex.sectors).length : 0,
    costAnchors: costAnchorStats(),
    perSymbol
  };
}

function collectSeedRawPaths() {
  const dirs = new Set();
  const candidates = [path.join(runtimeRoot, 'runs')];
  candidates.push(path.join(skillRoot, 'data', 'futures-radar', 'runs'));
  candidates.push(path.join(skillRoot, 'data', 'runs'));
  for (const dir of candidates) {
    if (fs.existsSync(dir)) dirs.add(dir);
  }

  const rawPaths = [];
  for (const dir of dirs) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const rawPath = path.join(dir, entry.name, 'raw.json');
      if (fs.existsSync(rawPath)) rawPaths.push({ runId: entry.name, rawPath });
    }
  }
  rawPaths.sort((a, b) => a.runId.localeCompare(b.runId));
  return rawPaths;
}

function seed() {
  ensureDirs();
  const result = { runs: 0, symbols: new Set(), barsChanged: 0, skipped: [] };
  for (const { runId, rawPath } of collectSeedRawPaths()) {
    const raw = readJson(rawPath);
    if (!raw || !raw.contracts) {
      result.skipped.push({ runId, reason: 'unreadable raw.json' });
      continue;
    }
    raw.meta = raw.meta || {};
    raw.meta.runId = raw.meta.runId || runId;
    const r = ingestRunBars({ runId: raw.meta.runId, rawJson: raw, provenance: null });
    result.runs++;
    result.barsChanged += r.barsChanged;
    for (const s of Object.keys(raw.contracts)) result.symbols.add(s);
  }

  // 兼容旧 backtest 缓存（如果存在）
  const legacyCache = path.join(skillRoot, 'backtest', 'data', 'historical-cache.json');
  if (fs.existsSync(legacyCache)) {
    const cache = readJson(legacyCache);
    if (cache && cache.contracts) {
      const r = ingestRunBars({ runId: 'seed-legacy-historical', rawJson: cache, provenance: null });
      result.runs++;
      result.barsChanged += r.barsChanged;
      for (const s of Object.keys(cache.contracts)) result.symbols.add(s);
    }
  }

  result.symbols = [...result.symbols].sort();
  exportHistoricalCache();
  return result;
}

function compactSymbol(symbol) {
  const symbolLedgerDir = path.join(LEDGER_DIR, symbol);
  const files = fs.existsSync(symbolLedgerDir)
    ? fs.readdirSync(symbolLedgerDir).filter((f) => f.endsWith('.jsonl')).sort()
    : [];
  if (files.length === 0) return { symbol, ok: false, reason: 'no ledger' };

  // 从 ledger 按时间顺序重放，重建 daily 文件
  let wrapper = loadDailyWrapper(symbol);
  for (const f of files) {
    const rows = fs.readFileSync(path.join(symbolLedgerDir, f), 'utf8')
      .split('\n').filter(Boolean).map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean);
    for (const row of rows) {
      const incoming = wrapper ? wrapper.contract : {
        symbol: row.symbol,
        name: row.symbol,
        exchange: 'unknown',
        sector: 'unknown',
        multiplier: 1,
        unit: '',
        fetchedAt: row.fetchedAt,
        ohlcv: {
          dates: [row.date], open: [row.open], high: [row.high], low: [row.low],
          close: [row.close], volume: [row.volume], turnover: [null],
          openInterest: [row.openInterest], settle: [row.settle],
          sources: [row.source]
        },
        lastBarSource: row.source,
        lastBarAsOf: row.date,
        lastBarVerification: row.verification
      };
      const merged = mergeContractBars(wrapper ? wrapper.contract : null, incoming);
      wrapper = {
        schema: DAILY_SCHEMA,
        symbol,
        updatedAt: row.ingestedAt || new Date().toISOString(),
        lastRunId: row.runId,
        contract: merged.contract
      };
    }
  }
  if (!wrapper) return { symbol, ok: false, reason: 'no rows' };
  writeDailyWrapper(symbol, wrapper);
  updateDailyIndex(wrapper);

  // 12 个月前 ledger 压缩为 .jsonl.gz（保留原始内容）
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - 12);
  for (const f of files) {
    const month = f.slice(0, 7);
    const d = new Date(`${month}-01T00:00:00Z`);
    if (d < cutoff) {
      const p = path.join(symbolLedgerDir, f);
      fs.writeFileSync(`${p}.gz`, zlib.gzipSync(fs.readFileSync(p)));
      fs.unlinkSync(p);
    }
  }
  return { symbol, ok: true, files };
}

function compact(symbol) {
  ensureDirs();
  if (symbol) return compactSymbol(symbol);
  const results = [];
  if (fs.existsSync(LEDGER_DIR)) {
    for (const entry of fs.readdirSync(LEDGER_DIR, { withFileTypes: true })) {
      if (entry.isDirectory()) results.push(compactSymbol(entry.name));
    }
  }
  updateLedgerManifest();
  exportHistoricalCache();
  return { results };
}

// ── CLI ─────────────────────────────────────────────────────
function printUsage() {
  console.log('Usage: node data-store/index.cjs --init|--seed|--verify|--stats|--export|--compact [--symbol SYM]');
  console.log('       node data-store/index.cjs --cost-anchor-stats|--cost-anchor-verify');
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const knownCommands = ['--init', '--seed', '--verify', '--stats', '--export', '--compact', '--cost-anchor-stats', '--cost-anchor-verify'];
  const command = knownCommands.find((c) => args.includes(c))
    || args.find((a) => !a.startsWith('--'))
    || null;
  const flagVal = (f) => {
    const i = args.indexOf(f);
    return i === -1 ? null : args[i + 1];
  };

  if (args.includes('--help') || !command) {
    printUsage();
    process.exit(0);
  }

  const run = () => {
    switch (command) {
      case '--init':
        return init();
      case '--seed':
        return seed();
      case '--verify':
        return verify();
      case '--stats':
        return stats();
      case '--export':
        return { path: exportHistoricalCache() };
      case '--compact':
        return compact(flagVal('--symbol'));
      case '--cost-anchor-stats':
        return costAnchorStats();
      case '--cost-anchor-verify':
        return verifyCostAnchors();
      default:
        printUsage();
        process.exit(1);
    }
  };

  try {
    console.log(JSON.stringify(run(), null, 2));
    process.exit(0);
  } catch (err) {
    console.error(`FATAL: ${err && err.stack ? err.stack : err}`);
    process.exit(1);
  }
}

module.exports = {
  DATA_ROOT,
  DAILY_DIR,
  LEDGER_DIR,
  CONTRACT_BARS_DIR,
  MACRO_DIR,
  SECTOR_DIR,
  EXPORT_DIR,
  COST_ANCHOR_DIR,
  SOURCE_PRIORITY,
  init,
  seed,
  ingestRunBars,
  ingestMacro,
  getMacroSnapshot,
  ingestSectorSnapshot,
  getSectorSnapshot,
  getSectorSeries,
  ingestContractBars,
  getContractBarsForRun,
  ingestCostAnchor,
  getCostAnchor,
  getCostAnchorHistory,
  costAnchorStats,
  verifyCostAnchors,
  loadHistoricalCache,
  getLatestCache,
  exportHistoricalCache,
  verify,
  stats,
  compact,
  mergeContractBars
};
