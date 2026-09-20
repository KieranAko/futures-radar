// experiment-line/cost-anchor/library.cjs — 文件库读写与 run 快照投影
// 规则：run 快照只从 data-store 主档投影，主档是唯一事实源。
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = require('./root.cjs');
const dataStore = require(path.join(ROOT, 'data-store', 'index.cjs'));
const { runDir } = require(path.join(ROOT, 'lib', 'workspace.cjs'));

const SNAPSHOT_SCHEMA = 'futures-radar-cost-anchor-snapshot/1';

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function keepSymbols(runId) {
  const filtered = readJson(path.join(runDir(runId), 'filtered.json'));
  const keeps = (filtered && filtered.candidates || []).filter((c) => c.decision === 'KEEP');
  if (keeps.length === 0) throw new Error(`run ${runId}: no KEEP candidates in filtered.json`);
  if (keeps.length > 3) throw new Error(`run ${runId}: KEEP candidates exceed 3 (${keeps.length})`);
  return keeps;
}

function signalDateFromRaw(runId) {
  const raw = readJson(path.join(runDir(runId), 'raw.json'));
  const dates = [];
  for (const c of Object.values(raw.contracts || {})) {
    const o = c && c.ohlcv;
    if (o && Array.isArray(o.dates) && o.dates.length) dates.push(o.dates[o.dates.length - 1]);
  }
  const uniq = [...new Set(dates)].sort();
  return uniq[uniq.length - 1] || null;
}

function snapshotPath(runId) {
  return path.join(runDir(runId), 'cost-anchor.json');
}

// 检索任务与检索结果都落在文件库 data/cost-anchor/research/ 下，
// 不写、不读 output/runs/<runId>/analyze/ 目录（文件库是唯一事实源）。
const RESEARCH_DIR = path.join(ROOT, 'data', 'cost-anchor', 'research');
function researchBriefPath(runId) {
  return path.join(RESEARCH_DIR, `${runId}.brief.json`);
}
function researchResultsPath(runId) {
  return path.join(RESEARCH_DIR, `${runId}.results.json`);
}

/**
 * 从主档解析 KEEP 品种的成本锚（缓存命中时零检索）。
 */
function resolveFromLibrary(runId, freshnessFn) {
  const signalDate = signalDateFromRaw(runId);
  const symbols = keepSymbols(runId).map((c) => {
    const record = dataStore.getCostAnchor(c.symbol, signalDate);
    const check = freshnessFn ? freshnessFn(record, signalDate) : null;
    return {
      symbol: c.symbol,
      name: c.name,
      sector: c.sector || null,
      signalDate,
      record,
      fresh: check ? check.fresh : false,
      reasons: check ? check.reasons : [],
      reused: !!(record && check && check.fresh)
    };
  });
  return { runId, signalDate, symbols };
}

/**
 * 从主档投影当期快照（只写，不从快照回读）。
 */
function projectSnapshot(runId, signalDate) {
  const symbols = keepSymbols(runId).map((c) => {
    const record = dataStore.getCostAnchor(c.symbol, signalDate);
    if (!record) {
      return { symbol: c.symbol, status: 'unavailable', reason: '主档无可用记录' };
    }
    return {
      symbol: c.symbol,
      recordId: record.recordId,
      reused: true,
      anchorType: record.anchorType,
      indicator: record.indicator,
      structure: record.structure || (Array.isArray(record.routes) && record.routes.length > 0 ? 'route_curve' : 'single_range'),
      valueLow: record.valueLow,
      valueHigh: record.valueHigh,
      unit: record.unit,
      asOf: record.asOf,
      confidence: record.confidence,
      routes: Array.isArray(record.routes) ? record.routes : [],
      fallbackRange: record.fallbackRange || null,
      problems: Array.isArray(record.problems) ? record.problems : [],
      sources: record.sources || []
    };
  });
  const out = {
    schema: SNAPSHOT_SCHEMA,
    runId,
    signalDate,
    symbols,
    provenance: 'projected from data/cost-anchor/<symbol>.json'
  };
  writeJson(snapshotPath(runId), out);
  return out;
}

module.exports = {
  dataStore,
  keepSymbols,
  signalDateFromRaw,
  snapshotPath,
  researchBriefPath,
  researchResultsPath,
  resolveFromLibrary,
  projectSnapshot,
  readJson,
  writeJson
};
