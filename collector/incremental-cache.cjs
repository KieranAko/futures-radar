#!/usr/bin/env node
/**
 * collector/incremental-cache.cjs — P1 增量缓存（v0.1.2）
 *
 * 职责：复用"最近一个已完成 run"的 raw.json 历史序列，避免每次全量拉取
 * 60 根日线（实测全量 ~14s，59 次 sina 调用）。
 *
 * 增量契约（已批准 P1 方案）：
 *   - 缓存源：runtimeRoot/runs/ 下 runId 最大的非当前 run 的 raw.json
 *   - 先探测一次 sina 最新 bar 日期（probeLatestSinaBarDate，1 次调用），
 *     缓存序列末 bar 日期 == 该日期 → 直接复用；缺失/落后/日期异常 → 全量重拉
 *   - 复用校验：日期严格递增、末 bar <= 本地今日（future-date-guard 仍会在
 *     合并后兜底再跑一次）
 *   - 校准：缓存采集时间超过 maxCacheAgeDays（默认 5 天）→ 全量重拉防静默漂移
 *   - FUTURES_FULL_PULL=1 强制全量（关闭增量）
 */

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

// 校验缓存序列可用：非空、严格递增、末 bar <= today
function validateCachedSeries(contract, today) {
  const dates = contract && contract.ohlcv && Array.isArray(contract.ohlcv.dates)
    ? contract.ohlcv.dates
    : [];
  if (dates.length === 0) return { ok: false, reason: 'empty_series' };
  for (let i = 1; i < dates.length; i++) {
    if (!(dates[i] > dates[i - 1])) {
      return { ok: false, reason: 'non_monotonic_dates' };
    }
  }
  const last = dates[dates.length - 1];
  if (typeof last !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(last)) {
    return { ok: false, reason: 'bad_last_date' };
  }
  if (last > today) return { ok: false, reason: 'future_date' };
  return { ok: true, last };
}

// 查找最新缓存 run（runId 字典序即时间序，排除当前 run）
function findLatestCacheRaw(runtimeRoot, currentRunId) {
  const runsDir = path.join(runtimeRoot, 'runs');
  if (!fs.existsSync(runsDir)) return null;
  let entries;
  try {
    entries = fs.readdirSync(runsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const candidates = entries
    .filter((d) => d.isDirectory() && d.name !== currentRunId)
    .map((d) => d.name)
    .sort()
    .reverse();
  for (const runId of candidates) {
    const rawPath = path.join(runsDir, runId, 'raw.json');
    if (!fs.existsSync(rawPath)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
      if (raw && raw.contracts && typeof raw.contracts === 'object') {
        return { runId, rawPath, raw };
      }
    } catch {
      // 损坏缓存跳过，继续找更旧的
    }
  }
  return null;
}

// 缓存超过 maxCacheAgeDays 天 → 全量校准
function isCacheStale(cacheRaw, opts = {}) {
  const maxAgeDays = opts.maxCacheAgeDays || 5;
  const collectedAt = cacheRaw && cacheRaw.meta && cacheRaw.meta.collectedAt;
  if (!collectedAt) return true;
  const t = new Date(collectedAt);
  if (isNaN(t.getTime())) return true;
  const ageDays = (Date.now() - t.getTime()) / 86400000;
  return ageDays > maxAgeDays;
}

// 计算增量计划：fetch（需重拉）/ reuse（可复用缓存）
function planIncremental(symbols, cacheRaw, opts) {
  const { latestBarDate, today } = opts;
  const contracts = (cacheRaw && cacheRaw.contracts) || {};
  const fetch = [];
  const reuse = [];
  const validationFailures = [];

  for (const sym of symbols) {
    const c = contracts[sym];
    if (!c) { fetch.push(sym); continue; }
    const v = validateCachedSeries(c, today);
    if (!v.ok) { validationFailures.push({ symbol: sym, reason: v.reason }); fetch.push(sym); continue; }
    if (v.last !== latestBarDate) { fetch.push(sym); continue; }
    reuse.push({ symbol: sym, dataEnd: v.last });
  }
  return { fetch, reuse, validationFailures };
}

// 缓存为 enrich 后的 raw.json 形状（ohlcv.openInterest 驼峰 + turnover），
// 采集器 merge 前使用 snake_case open_interest → 归一化回采集器形状
function normalizeCachedContract(c) {
  const o = (c && c.ohlcv) || {};
  const oi = o.open_interest !== undefined ? o.open_interest : o.openInterest;
  return {
    ...c,
    ohlcv: {
      dates: o.dates, open: o.open, high: o.high, low: o.low,
      close: o.close, volume: o.volume, open_interest: oi, settle: o.settle
    }
  };
}

// 深拷贝可复用的合约对象（避免后续 merge 时互相引用）
function cloneContractsForReuse(cacheRaw, reuseSymbols) {
  const out = {};
  const contracts = (cacheRaw && cacheRaw.contracts) || {};
  for (const { symbol } of reuseSymbols) {
    const c = contracts[symbol];
    if (!c) continue;
    const clone = JSON.parse(JSON.stringify(normalizeCachedContract(c)));
    clone.cacheReused = true;
    clone.cacheOriginRunId = (cacheRaw.meta && cacheRaw.meta.runId) || null;
    out[symbol] = clone;
  }
  return out;
}

// 一次探测调用：sina 最新 bar 日期（失败返回 null → 调用方回退全量）
function probeLatestSinaBarDate(pythonScript, symbol, opts = {}) {
  const timeoutMs = opts.timeoutMs || 30000;
  return new Promise((resolve) => {
    const child = cp.execFile(
      'python', [pythonScript, '--probe-latest', symbol || 'RB0'],
      { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve(null);
        const m = /LAST=(\d{4}-\d{2}-\d{2})/.exec(stdout || '');
        resolve(m ? m[1] : null);
      }
    );
    child.on('error', () => resolve(null));
  });
}

// 一次探测调用：返回最后两根日线日期 {latest, prev}（PREV 供快照优先增量判定
// "缓存仅落后一根 bar"）；失败返回 null → 调用方回退全量
function probeLatestSinaBarDates(pythonScript, symbol, opts = {}) {
  const timeoutMs = opts.timeoutMs || 30000;
  return new Promise((resolve) => {
    const child = cp.execFile(
      'python', [pythonScript, '--probe-latest', symbol || 'RB0'],
      { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve(null);
        const mLast = /LAST=(\d{4}-\d{2}-\d{2})/.exec(stdout || '');
        if (!mLast) return resolve(null);
        const mPrev = /PREV=(\d{4}-\d{2}-\d{2})/.exec(stdout || '');
        resolve({
          latest: mLast[1],
          prev: mPrev ? mPrev[1] : mLast[1] // 旧脚本无 PREV 行 → 退化为 latest（快照优先自动不启用）
        });
      }
    );
    child.on('error', () => resolve(null));
  });
}

// 快照优先增量（snapshot-first）资格判定（v0.1.3）：
// 日常场景：日线接口已发布今日 bar（latest === today），而缓存序列恰好落后一根
// （每品种缓存末 bar === prev，即上一交易日）。此时全量重拉 ~59 品种只为补一根
// 新 bar（实测 ~13s），可用收盘快照通道（1 次 HTTP 调用，date==今日 && time>=15:00
// 校验 + CFMMC 交叉验证）直接补当日 bar，跳过日线重拉。
// 契约：任一品种缓存缺失/非法/落后超过一根 → 不启用（eligible=false，调用方走原路径）。
function planSnapshotFirst(cacheRaw, symbols, opts) {
  const { latest, prev, today } = opts;
  const contracts = (cacheRaw && cacheRaw.contracts) || {};
  const reasons = [];

  if (!latest || !prev || !today) {
    return { eligible: false, reason: `missing dates (latest=${latest} prev=${prev} today=${today})` };
  }
  if (latest !== today) {
    // 日线接口尚未发布今日 bar：走原 fast-close 兜底路径即可（缓存与源端同日期时全部复用）
    return { eligible: false, reason: `day-line latest ${latest} != today ${today} (fast-close path handles this)` };
  }
  if (!Array.isArray(symbols) || symbols.length === 0) {
    return { eligible: false, reason: 'no symbols' };
  }
  if (prev >= today) {
    return { eligible: false, reason: `prev ${prev} not before today ${today}` };
  }

  const notOneBarBehind = [];
  for (const sym of symbols) {
    const c = contracts[sym];
    if (!c) { notOneBarBehind.push(sym); continue; }
    const v = validateCachedSeries(c, today);
    if (!v.ok) { notOneBarBehind.push(sym); continue; }
    if (v.last !== prev) { notOneBarBehind.push(sym); continue; }
  }

  if (notOneBarBehind.length > 0) {
    return {
      eligible: false,
      reason: `${notOneBarBehind.length} symbol(s) not exactly one bar behind: ${notOneBarBehind.slice(0, 8).join(',')}`
    };
  }
  return { eligible: true, reason: null };
}

module.exports = { findLatestCacheRaw, isCacheStale, planIncremental, cloneContractsForReuse, probeLatestSinaBarDate, probeLatestSinaBarDates, planSnapshotFirst, validateCachedSeries };
