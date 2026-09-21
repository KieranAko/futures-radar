// stories/lib/news-snapshot.cjs — 新闻/政策快照文件库
//
// 定位（用户裁定）：每次跑期货雷达，由 agent 用 WebSearch 现搜现写“少而精”的
// 宏观政策/产业新闻快照，作为传导链 LLM、六问 LLM、审计 LLM 的共同事实底座。
// 本模块是确定性工具：只负责 schema 校验、文件库落盘与跨期索引，不做任何方向判断。
//
// 目录约定：
//   data/news/<RUN_ID>.json   每期冻结快照（唯一事实源，与 data/macro/<RUN_ID>.json 同构思路）
//   data/news/_index.json     跨期索引（runId → 条目数与板块覆盖）
//
// 写入流程：
//   1. agent 现搜现写 output/runs/<runId>/news-snapshot.json（候选稿）
//   2. node stories/cli/news-snapshot-cli.cjs install --runId <runId>
//      校验通过后写入 data/news/<runId>.json 并更新 _index.json
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { skillRoot, runtimeRoot } = require('../../shared/workspace.cjs');

const NEWS_SCHEMA = 'futures-radar-news-snapshot/1';
const NEWS_INDEX_SCHEMA = 'futures-radar-news-index/1';
const NEWS_TYPES = ['policy', 'industry', 'macro', 'data_release'];
const VALID_TIERS = ['S', 'A', 'B', 'C'];
const MAX_ITEMS = 20;
const EXPECTED_SECTORS = [
  'black', 'nonferrous', 'precious', 'energy_chemical',
  'agriculture', 'new_materials', 'shipping',
];

function newsRoot(rootOverride = null) {
  return rootOverride || path.join(skillRoot, 'data', 'news');
}

function newsFile(runId, root = null) {
  return path.join(newsRoot(root), `${runId}.json`);
}

function newsIndexPath(root = null) {
  return path.join(newsRoot(root), '_index.json');
}

function candidateFile(runId) {
  return path.join(runtimeRoot, 'runs', runId, 'news-snapshot.json');
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function isDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
}

function isHttpUrl(s) {
  return /^https?:\/\/\S+$/i.test(String(s || ''));
}

function normSector(s) {
  if (s === 'macro') return 'macro';
  const t = String(s || '').trim();
  if (!t) return null;
  if (t === 'energy') return 'energy_chemical'; // 容错：常见别名
  return t;
}

/**
 * 纯函数：校验新闻快照文档（只校验结构与数值事实，不判断方向/语义）。
 * @param {object} doc 快照文档
 * @returns {{ok:boolean, errors:string[], warnings:string[], coverage:object}}
 */
function validateNewsSnapshot(doc) {
  const errors = [];
  const warnings = [];
  let coverage = {};
  if (!doc || doc.schema !== NEWS_SCHEMA) {
    errors.push(`schema 必须为 ${NEWS_SCHEMA}`);
    return { ok: false, errors, warnings, coverage };
  }
  if (!doc.runId || String(doc.runId).trim().length === 0) errors.push('runId 缺失');
  if (!Array.isArray(doc.items)) {
    errors.push('items 必须为数组');
    return { ok: false, errors, warnings, coverage };
  }
  if (doc.items.length > MAX_ITEMS) {
    errors.push(`items 超过上限 ${MAX_ITEMS} 条（少而精原则），当前 ${doc.items.length}`);
  }
  if (doc.items.length === 0) warnings.push('空快照合法，但本期传导链将没有新闻/政策事实底座');

  const seenIds = new Set();
  const perSector = {};
  for (const [i, it] of doc.items.entries()) {
    const tag = `items[${i}]`;
    if (!it || typeof it !== 'object') { errors.push(`${tag} 非对象`); continue; }
    const id = String(it.id || '').trim();
    if (!id) errors.push(`${tag}.id 缺失`);
    else if (seenIds.has(id)) errors.push(`${tag}.id 重复: ${id}`);
    else seenIds.add(id);

    if (!isDate(it.date)) errors.push(`${tag}.date 必须为 YYYY-MM-DD`);
    if (!NEWS_TYPES.includes(it.type)) errors.push(`${tag}.type 必须为 ${NEWS_TYPES.join('|')}`);
    if (!it.title || String(it.title).trim().length < 4) errors.push(`${tag}.title 缺失或过短`);
    if (!it.summary || String(it.summary).trim().length < 10) errors.push(`${tag}.summary 缺失或过短（应为 2–3 句中性摘录）`);

    const sectors = Array.isArray(it.sectors) ? it.sectors.map(normSector).filter(Boolean) : [];
    if (sectors.length === 0) errors.push(`${tag}.sectors 缺失（至少覆盖一个板块或 macro）`);
    for (const s of sectors) {
      perSector[s] = (perSector[s] || 0) + 1;
    }

    const sources = Array.isArray(it.sources) ? it.sources : [];
    if (sources.length === 0) errors.push(`${tag}.sources 缺失（至少 1 个来源）`);
    for (const [j, s] of sources.entries()) {
      const st = `sources[${j}]`;
      if (!s || !isHttpUrl(s.url)) errors.push(`${tag}.${st}.url 必须为 http(s) URL`);
      if (!VALID_TIERS.includes(s.tier)) errors.push(`${tag}.${st}.tier 必须为 ${VALID_TIERS.join('|')}`);
      if (s.publishedAt != null && !isDate(s.publishedAt)) errors.push(`${tag}.${st}.publishedAt 必须为 YYYY-MM-DD`);
    }
    if (sources.length === 1 && it.singleSource !== true) {
      errors.push(`${tag}: 单来源条目必须显式 singleSource=true（少而精允许单源，但必须可识别）`);
    }
    if (sources.length > 1 && it.singleSource === true) {
      warnings.push(`${tag}: 已有多来源，singleSource=true 建议去掉`);
    }
    if (typeof it.verified !== 'boolean') errors.push(`${tag}.verified 必须为 boolean`);
  }

  // 覆盖度只告警不拒收：每期应尽量覆盖 7 板块 + macro，但真实世界不是每天每板块都有值得记的事。
  const sectorCounts = {};
  for (const s of EXPECTED_SECTORS) {
    sectorCounts[s] = perSector[s] || 0;
    if (sectorCounts[s] === 0) warnings.push(`板块 ${s} 本期无快照条目`);
  }
  sectorCounts.macro = perSector.macro || 0;
  coverage = { ...sectorCounts, total: doc.items.length };

  return { ok: errors.length === 0, errors, warnings, coverage };
}

function loadNewsSnapshot(runId, root = null) {
  return readJson(newsFile(runId, root), null);
}

function defaultIndex() {
  return { schema: NEWS_INDEX_SCHEMA, updatedAt: null, runs: [], bySector: {} };
}

function loadNewsIndex(root = null) {
  const doc = readJson(newsIndexPath(root), defaultIndex());
  if (!doc || doc.schema !== NEWS_INDEX_SCHEMA) return defaultIndex();
  if (!Array.isArray(doc.runs)) doc.runs = [];
  if (!doc.bySector || typeof doc.bySector !== 'object') doc.bySector = {};
  return doc;
}

function saveNewsIndex(index, root = null) {
  index.schema = NEWS_INDEX_SCHEMA;
  index.updatedAt = new Date().toISOString();
  writeJsonAtomic(newsIndexPath(root), index);
  return index;
}

/**
 * 写入已校验过的快照并重建索引。
 */
function writeNewsSnapshot(doc, root = null) {
  const check = validateNewsSnapshot(doc);
  if (!check.ok) return { ok: false, errors: check.errors, warnings: check.warnings };
  writeJsonAtomic(newsFile(doc.runId, root), doc);
  updateNewsIndex(doc.runId, root);
  return { ok: true, file: newsFile(doc.runId, root), warnings: check.warnings, coverage: check.coverage };
}

/**
 * 按 data/news/<runId>.json 重建跨期索引。
 */
function updateNewsIndex(runId, root = null) {
  const doc = loadNewsSnapshot(runId, root);
  if (!doc) return { ok: false, errors: [`新闻快照不存在: ${runId}`] };
  const check = validateNewsSnapshot(doc);
  if (!check.ok) return { ok: false, errors: check.errors, warnings: check.warnings };

  const index = loadNewsIndex(root);
  const entry = {
    runId,
    generatedAt: doc.generatedAt || null,
    itemCount: doc.items.length,
    sectorCounts: check.coverage,
  };
  const runPos = index.runs.findIndex((r) => r && r.runId === runId);
  if (runPos >= 0) index.runs[runPos] = entry; else index.runs.push(entry);
  index.runs.sort((a, b) => String(a.runId).localeCompare(String(b.runId)));

  const bySector = {};
  for (const it of doc.items) {
    for (const rawSector of it.sectors || []) {
      const s = normSector(rawSector);
      if (!s) continue;
      if (!bySector[s]) bySector[s] = [];
      bySector[s].push({ runId, itemId: it.id, date: it.date, type: it.type });
    }
  }
  index.bySector = bySector;
  saveNewsIndex(index, root);
  return { ok: true, index, coverage: check.coverage };
}

/**
 * 最近一期快照（runId 字典序最大，生产 runId 为 YYYYMMDD-HHMM 格式，字典序即时间序）。
 */
function latestNewsSnapshot(root = null) {
  const index = loadNewsIndex(root);
  if (!index.runs.length) return null;
  const latest = index.runs[index.runs.length - 1];
  return loadNewsSnapshot(latest.runId, root);
}

/**
 * 把快照渲染成给 LLM 读的中性简报（每条一行摘要 + 来源数，不含方向判断）。
 */
function digestLines(doc) {
  if (!doc || !Array.isArray(doc.items)) return [];
  return doc.items.map((it) => ({
    id: it.id,
    date: it.date,
    type: it.type,
    sectors: it.sectors || [],
    title: it.title,
    summary: it.summary,
    sourceCount: (it.sources || []).length,
    singleSource: !!it.singleSource,
  }));
}

module.exports = {
  NEWS_SCHEMA,
  NEWS_INDEX_SCHEMA,
  NEWS_TYPES,
  VALID_TIERS,
  MAX_ITEMS,
  EXPECTED_SECTORS,
  newsRoot,
  newsFile,
  newsIndexPath,
  candidateFile,
  validateNewsSnapshot,
  loadNewsSnapshot,
  loadNewsIndex,
  saveNewsIndex,
  writeNewsSnapshot,
  updateNewsIndex,
  latestNewsSnapshot,
  digestLines,
};
