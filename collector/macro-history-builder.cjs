// collector/macro-history-builder.cjs — 宏观历史序列入库（文件库唯一事实源）
//
// 数据来源（均为真实已抓取数据，不读 output/runs）：
//   1. 冻结宏观历史 strategies/signal-backtest/recordings/v4/macro-history.json
//      （akshare/sina：DXY 1985+ / USDCNH 2014+ / US10Y 1990+ / DR007 2015+）
//   2. 文件库 data/macro/<RUN_ID>.json 的生产宏观快照（08-27 以来逐日，含最新值）
//
// 合并规则：按 asOf 日期升序；同日多条取 fetchedAt 最新的一条；只收 value 有限的观测。
// 输出：data/macro-history/<ANCHOR>.json + _index.json（append 式重建，确定性）。
//
// 用法: node collector/macro-history-builder.cjs [--build]
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { skillRoot } = require('../lib/workspace.cjs');

const ANCHORS = ['DXY', 'USDCNH', 'US10Y', 'DR007'];
const BASE_FILE = path.join(skillRoot, 'strategies', 'signal-backtest', 'recordings', 'v4', 'macro-history.json');
const MACRO_DIR = path.join(skillRoot, 'data', 'macro');
const OUT_DIR = path.join(skillRoot, 'data', 'macro-history');
const SCHEMA = 'futures-radar-macro-history/1';

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * 纯函数：合并基础序列与快照序列。
 * @param {Array<[string, number]>} base 冻结历史 [[date, value], ...]
 * @param {Array<{date:string, value:number, fetchedAt:string}>} snapshots 生产快照
 * @returns {Array<[string, number]>} 按日期升序去重
 */
function mergeSeries(base, snapshots) {
  const byDate = new Map();
  for (const [date, value] of base || []) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(value)) {
      byDate.set(date, { value, fetchedAt: '' });
    }
  }
  for (const s of snapshots || []) {
    if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s.date) || !Number.isFinite(s.value)) continue;
    const old = byDate.get(s.date);
    if (!old || String(s.fetchedAt || '') > String(old.fetchedAt)) {
      byDate.set(s.date, { value: s.value, fetchedAt: s.fetchedAt || '' });
    }
  }
  return [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, row]) => [date, row.value]);
}

function buildMacroHistory() {
  const base = readJson(BASE_FILE);
  const baseIndicators = base && base.indicators ? base.indicators : {};

  // 生产快照（文件库）
  const snapshotsByAnchor = {};
  for (const a of ANCHORS) snapshotsByAnchor[a] = [];
  if (fs.existsSync(MACRO_DIR)) {
    for (const f of fs.readdirSync(MACRO_DIR).filter((x) => x.endsWith('.json'))) {
      const doc = readJson(path.join(MACRO_DIR, f));
      const snap = doc && doc.snapshot ? doc.snapshot : doc;
      const indicators = snap && snap.indicators ? snap.indicators : {};
      for (const a of ANCHORS) {
        const ind = indicators[a];
        if (ind && Number.isFinite(ind.value) && /^\d{4}-\d{2}-\d{2}$/.test(ind.asOf || '')) {
          snapshotsByAnchor[a].push({ date: ind.asOf, value: ind.value, fetchedAt: ind.fetchedAt || '' });
        }
      }
    }
  }

  const index = { schema: SCHEMA, updatedAt: new Date().toISOString(), anchors: {} };
  let maxLast = null;
  for (const a of ANCHORS) {
    const baseSeries = baseIndicators[a] && baseIndicators[a].ok ? (baseIndicators[a].series || []) : [];
    const merged = mergeSeries(baseSeries, snapshotsByAnchor[a]);
    const last = merged.length ? merged[merged.length - 1] : null;
    if (last && (!maxLast || last[0] > maxLast)) maxLast = last[0];
    writeJsonAtomic(path.join(OUT_DIR, `${a}.json`), {
      schema: SCHEMA,
      anchor: a,
      updatedAt: new Date().toISOString(),
      source: 'strategies/signal-backtest/recordings/v4/macro-history.json + data/macro/<RUN_ID>.json',
      rows: merged.length,
      range: merged.length ? [merged[0][0], last[0]] : null,
      series: merged,
    });
    index.anchors[a] = { rows: merged.length, range: merged.length ? [merged[0][0], last[0]] : null };
  }
  index.lastDate = maxLast;
  writeJsonAtomic(path.join(OUT_DIR, '_index.json'), index);
  return index;
}

function loadMacroHistory(anchor) {
  const f = path.join(OUT_DIR, `${anchor}.json`);
  const doc = readJson(f, null);
  if (!doc || !Array.isArray(doc.series)) return null;
  return doc.series;
}

function isMacroHistoryFresh() {
  const idx = readJson(path.join(OUT_DIR, '_index.json'), null);
  if (!idx || !idx.updatedAt) return false;
  const idxTime = Date.parse(idx.updatedAt);
  if (!fs.existsSync(MACRO_DIR)) return true;
  // 任一生产宏观快照 mtime 比索引新 → 需要重建
  for (const f of fs.readdirSync(MACRO_DIR).filter((x) => x.endsWith('.json'))) {
    const st = fs.statSync(path.join(MACRO_DIR, f));
    if (st.mtimeMs > idxTime) return false;
  }
  return true;
}

function ensureMacroHistory() {
  if (!isMacroHistoryFresh()) buildMacroHistory();
  return readJson(path.join(OUT_DIR, '_index.json'), null);
}

function main() {
  const out = buildMacroHistory();
  console.log(`macro-history built: ${Object.entries(out.anchors).map(([k, v]) => `${k}(${v.rows}, ${v.range ? v.range.join('..') : '—'})`).join(' ')}`);
  console.log(`lastDate: ${out.lastDate}`);
}

if (require.main === module) main();
module.exports = { buildMacroHistory, ensureMacroHistory, loadMacroHistory, isMacroHistoryFresh, mergeSeries, ANCHORS };
