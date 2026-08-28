/**
 * Forward test fixtures — 共享的 backtest raw 平移/截断与 sealed manifest 工厂
 *
 * minimumSignalDate 被 FORWARD_FREEZE 锁定为 2026-08-14，
 * 历史 backtest raw 的 2024 年日期会被边界拒绝——
 * fixture 从保留的 historical-cache 取 2024 年窗口并整体平移，
 * 使 12-05 → 2026-08-14（首个可登记日），保留其历史窗口与 T+11 未来 bars。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FORWARD_CONFIGS,
  FORWARD_FREEZE,
  saveManifestAtomic
} from '../../lib/forward-manifest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const BASE_FORWARD_DATE = '2026-08-14';
const ORIG_MAIN_DATE = '2024-12-05';
export const DATE_MAIN = '2026-08-14';      // historical cache shifted: 4 candidates, 1 d0 signal
export const DATE_ZERO = '2026-09-03';      // historical 2024-12-25 shifted: 0 candidates

export function loadHistoricalCache() {
  // 优先完整缓存（clowder 开发环境）；缺失时回退内置冻结切片（独立安装/CI）
  const candidates = [
    path.join(__dirname, '../fixtures/historical-cache-forward-slice.json'),
    path.join(__dirname, '../../../backtest/data/historical-cache.json')
  ];
  const file = candidates.find((f) => fs.existsSync(f));
  if (!file) {
    throw new Error('historical cache missing — run backtest/full-history-collector.cjs or provide fixtures');
  }
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.meta = { ...raw.meta, runId: 'historical-cache-forward-fixture' };
  for (const contract of Object.values(raw.contracts)) {
    contract.ohlcv.openInterest ??= contract.ohlcv.open_interest;
  }
  return raw;
}

/** 将 raw 的 dates 整体平移，使 origDate 落在 baseDate（bar 结构不变） */
export function shiftDates(raw, baseDate, origDate) {
  const baseMs = Date.parse(`${baseDate}T00:00:00Z`);
  const originMs = Date.parse(`${origDate}T00:00:00Z`);
  const contracts = {};
  for (const [sym, c] of Object.entries(raw.contracts)) {
    contracts[sym] = {
      ...c,
      ohlcv: {
        ...c.ohlcv,
        dates: c.ohlcv.dates.map((date) => {
          const offset = Date.parse(`${date}T00:00:00Z`) - originMs;
          return new Date(baseMs + offset).toISOString().slice(0, 10);
        })
      }
    };
  }
  return { ...raw, contracts };
}

/** 截断到 signalDate（含 T），模拟登记时点的运行时快照 */
export function truncateRaw(raw, signalDate) {
  const contracts = {};
  for (const [sym, c] of Object.entries(raw.contracts)) {
    const T = c.ohlcv.dates.indexOf(signalDate);
    if (T < 0) { contracts[sym] = c; continue; }
    const ohlcv = {};
    for (const [k, v] of Object.entries(c.ohlcv)) {
      ohlcv[k] = Array.isArray(v) ? v.slice(0, T + 1) : v;
    }
    contracts[sym] = { ...c, ohlcv };
  }
  return { ...raw, contracts };
}

const HISTORICAL_CACHE = loadHistoricalCache();
export const RAW_MAIN = shiftDates(HISTORICAL_CACHE, BASE_FORWARD_DATE, ORIG_MAIN_DATE);
export const RAW_ZERO = structuredClone(RAW_MAIN);
export const TRUNC_MAIN = truncateRaw(RAW_MAIN, DATE_MAIN);
export const TRUNC_ZERO = truncateRaw(RAW_ZERO, DATE_ZERO);

/** 新建 sealed manifest（经 saveManifestAtomic 封存内容哈希），返回其路径 */
export function createFreshManifest() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forward-rec-'));
  const manifestPath = path.join(tmpDir, 'manifest.json');
  saveManifestAtomic(manifestPath, {
    version: 1,
    ...structuredClone(FORWARD_FREEZE),
    frozenConfigs: structuredClone(FORWARD_CONFIGS),
    dates: {}
  });
  return { tmpDir, manifestPath };
}
