// collector/macro-probe.cjs — Phase 3 阶段一：宏观锚点采集
//
// 数据流：config/macro-indicators.json + raw.json（SC0 复用）
//   → 每锚点取 <= signalDate 的最后一根已完成日线
//   → 写入 {runDir}/macro-snapshot.json
//
// 纪律（缅因猫精简版冻结）：
// - 单指标失败标 missing（带 reason），不伪造、不用近似源顶替
// - 单指标/整阶段失败均不阻断期货雷达（管道 failurePolicy=warn 兜底）
// - 报告阶段不联网：快照在采集阶段一次性冻结，后续阶段只读
//
// Usage: node collector/macro-probe.cjs --runId <id>

const fs = require('fs');
const path = require('path');
const { runtimeRoot, skillRoot } = require('../lib/workspace.cjs');
const akshareMacro = require('./akshare-macro.cjs');
const dataStore = require('../data-store/index.cjs');

const SCHEMA_VERSION = '1.0.0';

// ── Helpers ──────────────────────────────────────────────────
function readJSON(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function round2(x) {
  return Math.round(x * 100) / 100;
}

function round4(x) {
  return Math.round(x * 10000) / 10000;
}

// ── ISO 校验（fail-closed 用） ────────────────────────────────
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

function isValidIsoDate(s) {
  if (typeof s !== 'string' || !ISO_DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function isValidIsoTs(s) {
  return typeof s === 'string' && ISO_TS_RE.test(s) && !Number.isNaN(Date.parse(s));
}

// 锚点声明单源：config/macro-indicators.json（不硬编码第二份清单）
let _anchorDecls = null;
function loadAnchorDecls() {
  if (!_anchorDecls) {
    _anchorDecls = readJSON(path.join(skillRoot, 'config', 'macro-indicators.json')).indicators;
  }
  return _anchorDecls;
}

// ── 纯函数（可单测） ──────────────────────────────────────────

// change5d = (v_t / v_{t-5} - 1) * 100（相对百分比），t-5 为 asOf 前第 5 个交易日
function computeChange5d(values, asOfIndex) {
  const idx5 = asOfIndex - 5;
  if (idx5 < 0) return null;
  const vt = values[asOfIndex];
  const v5 = values[idx5];
  if (!Number.isFinite(vt) || !Number.isFinite(v5) || v5 === 0) return null;
  return round2((vt / v5 - 1) * 100);
}

// signalDate = raw.json 各合约最新日期的最大值
function determineSignalDate(raw) {
  let max = null;
  for (const contract of Object.values(raw.contracts || {})) {
    const dates = contract && contract.ohlcv && contract.ohlcv.dates;
    if (!Array.isArray(dates) || dates.length === 0) continue;
    const last = dates[dates.length - 1];
    if (max === null || last > max) max = last;
  }
  return max;
}

// 取 date <= signalDate 的最后一根（series 升序）；跳过盘中未完成 bar
function selectAsOfBar(series, signalDate) {
  let idx = -1;
  for (let i = 0; i < series.length; i++) {
    if (series[i].date <= signalDate) idx = i;
    else break;
  }
  return idx === -1 ? null : { index: idx, date: series[idx].date, value: series[idx].value };
}

// SC0 复用本 run raw.json 中 SC0 合约自身 close 序列，不重复抓取
function extractSc0FromRaw(raw, signalDate, fetchedAt, cfg) {
  const contract = raw.contracts && raw.contracts.SC0;
  const ohlcv = contract && contract.ohlcv;
  const base = { status: 'missing', source: 'raw.json', fetchedAt, _timestamp_origin: 'observed' };
  if (!ohlcv || !Array.isArray(ohlcv.dates) || ohlcv.dates.length === 0 || !Array.isArray(ohlcv.close)) {
    return { ...base, reason: 'SC0 contract not in raw.json' };
  }
  if (ohlcv.dates.length !== ohlcv.close.length) {
    return { ...base, reason: `SC0 dates(${ohlcv.dates.length})/close(${ohlcv.close.length}) length mismatch` };
  }
  for (let i = 1; i < ohlcv.dates.length; i++) {
    if (String(ohlcv.dates[i]) <= String(ohlcv.dates[i - 1])) {
      return { ...base, reason: `SC0 dates not strictly ascending at index ${i}` };
    }
  }
  const lastClose = ohlcv.close[ohlcv.close.length - 1];
  if (!Number.isFinite(lastClose)) {
    return { ...base, reason: 'SC0 last close not finite' };
  }
  const n = ohlcv.dates.length;
  const lastDate = ohlcv.dates[n - 1];
  if (lastDate > signalDate) {
    return {
      ...base,
      reason: `SC0 asOf ${lastDate} after market cutoff ${signalDate}`,
    };
  }
  const result = {
    status: lastDate === signalDate ? 'fresh' : 'stale',
    value: round4(lastClose),
    change5d: computeChange5d(ohlcv.close, n - 1),
    asOf: lastDate,
    fetchedAt,
    source: 'raw.json',
    _timestamp_origin: 'observed',
  };
  if (cfg && cfg.sourceNote) result.sourceNote = cfg.sourceNote;
  return result;
}

// 外部抓取序列 → 指标快照：bar 选择 + change5d + 新鲜度判定
function buildIndicatorFromSeries(id, cfg, seriesResult, signalDate, nowIso) {
  const base = {
    source: cfg.source,
    fetchedAt: (seriesResult && seriesResult.fetchedAt) || nowIso,
    _timestamp_origin: 'observed',
  };
  if (cfg.sourceNote) base.sourceNote = cfg.sourceNote;

  if (!seriesResult || !seriesResult.ok) {
    return {
      status: 'missing',
      reason: (seriesResult && seriesResult.error) || 'fetch failed',
      ...base,
    };
  }

  const series = (seriesResult.series || [])
    .map((p) => {
      if (Array.isArray(p)) return { date: String(p[0]), value: Number(p[1]) };
      return { date: String(p.date), value: Number(p.value) };
    })
    .filter((p) => p.date && p.date !== 'undefined' && Number.isFinite(p.value));

  for (let i = 1; i < series.length; i++) {
    if (series[i].date <= series[i - 1].date) {
      return {
        status: 'missing',
        reason: `series not strictly ascending at index ${i} (${series[i - 1].date} >= ${series[i].date})`,
        ...base,
      };
    }
  }

  const bar = selectAsOfBar(series, signalDate);
  if (!bar) {
    return { status: 'missing', reason: `no bar with date <= ${signalDate}`, ...base };
  }

  return {
    status: bar.date === signalDate ? 'fresh' : 'stale',
    value: round4(bar.value),
    change5d: computeChange5d(series.map((s) => s.value), bar.index),
    asOf: bar.date,
    ...base,
  };
}

function buildSnapshot({ runId, signalDate, nowIso, indicatorResults }) {
  const available = [];
  const missing = [];
  for (const [id, r] of Object.entries(indicatorResults)) {
    if (r.status === 'missing') missing.push(id);
    else available.push(id);
  }
  return {
    meta: {
      runId,
      signalDate,
      snapshotFrozenAt: nowIso,
      marketCutoffAt: signalDate,
      schemaVersion: SCHEMA_VERSION,
    },
    indicators: indicatorResults,
    quality: {
      available: available.length,
      missing: missing.length,
      eligible: available.length >= 1,
    },
  };
}

// 快照不变量校验（fail-closed 守卫，写盘前自检 + 测试复用）
function validateMacroSnapshot(snapshot, { anchorDecls = null } = {}) {
  const errors = [];
  const m = snapshot && snapshot.meta;
  if (!m) return { ok: false, errors: ['meta missing'] };

  for (const field of ['runId', 'signalDate', 'snapshotFrozenAt', 'marketCutoffAt']) {
    if (typeof m[field] !== 'string' || m[field].length === 0) {
      errors.push(`meta.${field} missing`);
    }
  }
  if (m.schemaVersion !== SCHEMA_VERSION) {
    errors.push(`schemaVersion mismatch: expected ${SCHEMA_VERSION}, got ${m.schemaVersion}`);
  }
  const hasMeta = (f) => typeof m[f] === 'string' && m[f].length > 0;
  if (hasMeta('signalDate') && !isValidIsoDate(m.signalDate)) {
    errors.push(`meta.signalDate not a valid ISO date: ${m.signalDate}`);
  }
  if (hasMeta('marketCutoffAt') && !isValidIsoDate(m.marketCutoffAt)) {
    errors.push(`meta.marketCutoffAt not a valid ISO date: ${m.marketCutoffAt}`);
  }
  if (hasMeta('snapshotFrozenAt') && !isValidIsoTs(m.snapshotFrozenAt)) {
    errors.push(`meta.snapshotFrozenAt not a valid ISO timestamp: ${m.snapshotFrozenAt}`);
  }

  const inds = snapshot.indicators || {};
  const decls = anchorDecls || loadAnchorDecls();
  const expectedIds = Object.keys(decls).sort();
  const actualIds = Object.keys(inds).sort();
  if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) {
    errors.push(`indicators must be exactly [${expectedIds.join(',')}], got [${actualIds.join(',')}]`);
  }

  let availableCount = 0;
  let missingCount = 0;
  for (const [id, r] of Object.entries(inds)) {
    if (!r || typeof r !== 'object') {
      errors.push(`${id}: indicator entry invalid`);
      continue;
    }
    if (!['fresh', 'stale', 'missing'].includes(r.status)) {
      errors.push(`${id}: invalid status ${r.status}`);
    }
    if (typeof r.source !== 'string' || r.source.length === 0) {
      errors.push(`${id}: source missing`);
    } else if (decls[id] && r.source !== decls[id].source) {
      errors.push(`${id}: source ${r.source} not declared (expected ${decls[id].source})`);
    }
    if (r._timestamp_origin !== 'observed') {
      errors.push(`${id}: _timestamp_origin must be 'observed', got ${r._timestamp_origin}`);
    }
    if (typeof r.fetchedAt !== 'string' || r.fetchedAt.length === 0) {
      errors.push(`${id}: fetchedAt missing`);
    } else if (!isValidIsoTs(r.fetchedAt)) {
      errors.push(`${id}: fetchedAt not a valid ISO timestamp: ${r.fetchedAt}`);
    } else if (m.snapshotFrozenAt && Date.parse(r.fetchedAt) > Date.parse(m.snapshotFrozenAt)) {
      errors.push(`${id}: fetchedAt ${r.fetchedAt} after snapshotFrozenAt ${m.snapshotFrozenAt}`);
    }

    if (r.status === 'missing') {
      missingCount++;
      if (typeof r.reason !== 'string' || r.reason.length === 0) {
        errors.push(`${id}: missing indicator lacks reason`);
      }
      if (r.value !== undefined) {
        errors.push(`${id}: missing indicator must not carry value`);
      }
    } else {
      availableCount++;
      if (typeof r.value !== 'number' || !Number.isFinite(r.value)) {
        errors.push(`${id}: value not finite`);
      }
      if (typeof r.asOf !== 'string' || r.asOf.length === 0) {
        errors.push(`${id}: asOf missing`);
      } else if (!isValidIsoDate(r.asOf)) {
        errors.push(`${id}: asOf not a valid ISO date: ${r.asOf}`);
      } else if (m.marketCutoffAt && r.asOf > m.marketCutoffAt) {
        errors.push(`${id}: asOf ${r.asOf} after marketCutoffAt ${m.marketCutoffAt}`);
      }
      if (r.change5d !== undefined && r.change5d !== null && !Number.isFinite(r.change5d)) {
        errors.push(`${id}: change5d not finite`);
      }
    }
  }

  const q = snapshot.quality;
  if (!q || typeof q !== 'object') {
    errors.push('quality missing');
  } else {
    if (q.available !== availableCount) {
      errors.push(`quality.available ${q.available} != actual ${availableCount}`);
    }
    if (q.missing !== missingCount) {
      errors.push(`quality.missing ${q.missing} != actual ${missingCount}`);
    }
    if (typeof q.eligible !== 'boolean') {
      errors.push('quality.eligible not boolean');
    } else if (q.eligible !== (availableCount >= 1)) {
      errors.push(`quality.eligible ${q.eligible} inconsistent with available=${availableCount}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

// ── 主流程 ──────────────────────────────────────────────────
async function runMacroProbe({ runId, fetchSeriesFn = null, nowIso = new Date().toISOString(), runtimeRootOverride = null, writeFile = true }) {
  const rt = runtimeRootOverride || runtimeRoot;
  const runDir = path.join(rt, 'runs', runId);
  const rawPath = path.join(runDir, 'raw.json');
  if (!fs.existsSync(rawPath)) {
    throw new Error(`raw.json not found: ${rawPath} (run collect first)`);
  }
  const raw = readJSON(rawPath);
  const indicatorCfg = readJSON(path.join(skillRoot, 'config', 'macro-indicators.json'));

  const signalDate = determineSignalDate(raw);
  if (!signalDate) {
    throw new Error('raw.json has no contract dates — cannot determine signalDate');
  }

  const results = {};
  for (const [id, cfg] of Object.entries(indicatorCfg.indicators)) {
    if (cfg.fetch.kind === 'raw_contract') {
      const fetchedAt = (raw.meta && raw.meta.collectedAt) || nowIso;
      results[id] = extractSc0FromRaw(raw, signalDate, fetchedAt, cfg);
    } else {
      let seriesResult;
      try {
        // P2：默认走带重试+备用通道的适配器（sina_fx 失败 → USDCNH 实时快照兜底）
        const fetchFn = fetchSeriesFn || akshareMacro.fetchSeriesWithBackup;
        seriesResult = await fetchFn(cfg.fetch, { signalDate });
      } catch (e) {
        seriesResult = { ok: false, error: (e && e.message) || String(e), fetchedAt: null };
      }
      results[id] = buildIndicatorFromSeries(id, cfg, seriesResult, signalDate, nowIso);
    }
  }

  // 冻结时刻必须在全部抓取完成之后，否则 fetchedAt（抓取时捕获）会晚于 snapshotFrozenAt
  const frozenAt = new Date().toISOString();
  const snapshot = buildSnapshot({ runId, signalDate, nowIso: frozenAt, indicatorResults: results });

  const v = validateMacroSnapshot(snapshot);
  if (!v.ok) {
    throw new Error(`macro snapshot failed validation: ${v.errors.join('; ')}`);
  }

  if (writeFile !== false) {
    writeJSON(path.join(runDir, 'macro-snapshot.json'), snapshot);
  }
  // 文件库镜像（v0.1.4）：report 阶段在 run 目录快照缺失时可按 runId 精确回退
  try {
    dataStore.ingestMacro({ runId, snapshot });
  } catch (err) {
    // 镜像失败不阻断宏观采集（macro-snapshot.json 仍是 run 权威）
    console.warn(`WARN: data-store macro ingest failed (non-blocking): ${err.message}`);
  }
  return snapshot;
}

// ── CLI ──────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--runId');
  const runId = i >= 0 ? args[i + 1] : null;
  if (!runId) {
    console.error('FATAL: --runId required');
    process.exit(1);
  }
  const nowIso = new Date().toISOString();
  console.log('=== macro-probe (Phase 3 阶段一) ===');
  console.log(`runId: ${runId}`);

  let snapshot;
  try {
    snapshot = await runMacroProbe({ runId, nowIso });
  } catch (e) {
    console.error(`FATAL: macro probe failed: ${e.message}`);
    process.exit(1);
  }

  console.log(`signalDate: ${snapshot.meta.signalDate}`);
  for (const [id, r] of Object.entries(snapshot.indicators)) {
    if (r.status === 'missing') {
      console.log(`  [missing] ${id}: ${r.reason}`);
    } else {
      const chg = r.change5d === null ? '—' : `${r.change5d > 0 ? '+' : ''}${r.change5d}%`;
      console.log(`  [${r.status}] ${id}: ${r.value} asOf ${r.asOf} (5d ${chg})`);
    }
  }
  const q = snapshot.quality;
  console.log(`quality: available=${q.available} missing=${q.missing} eligible=${q.eligible}`);
  console.log(`written: macro-snapshot.json`);
  process.exit(0);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`FATAL: macro probe failed: ${e.message}`);
    process.exit(1);
  });
}

module.exports = {
  SCHEMA_VERSION,
  computeChange5d,
  determineSignalDate,
  selectAsOfBar,
  extractSc0FromRaw,
  buildIndicatorFromSeries,
  buildSnapshot,
  validateMacroSnapshot,
  runMacroProbe,
};
