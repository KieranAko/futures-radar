/**
 * Specific-Contract Series (P0: 主力连续污染修复)
 *
 * 架构原则（HANDOFF_MAIN_CONTINUOUS_FIX.md）：
 * 主力连续是"筛选指数"，不是"价格水平数据源"。任何涉及具体价格水平的
 * 推理（MA 距离、支撑阻力、触发价）必须用当日主导合约自身序列。
 *
 * 本模块提供：
 * - buildCleanSeriesFields（纯函数）：主导合约历史 → price_data / volume_oi 字段
 * - fetchContractHistory：主导合约完整 OHLCV 历史（复用 term-structure.py）
 * - overrideWithCleanSeries：用干净序列覆盖 packet 字段（freeze-packets 集成点）
 *
 * 降级纪律：历史不足时显式标注，不得静默用短序列冒充完整字段。
 */

import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(__dirname, '..', '..');
const TERM_STRUCTURE_PY = path.join(SKILL_ROOT, 'collector', 'futures-term-structure.py');

const MIN_BARS_PRICE = 20; // ma20 最低窗口
const MIN_BARS_MA60 = 60; // ma60 最低窗口
const WINDOW_BARS = 60; // close_60d 窗口

/**
 * 锚定 signalDate 截断 bars（丢弃 signalDate 之后的 bar，防未来数据泄漏）
 * @param {Array<object>} bars - [{date, open, high, low, close, volume, hold}]
 * @param {string} signalDate - YYYY-MM-DD
 * @returns {Array<object>} 截断后的 bars
 */
export function anchorToSignalDate(bars, signalDate) {
  const cutoff = new Date(`${signalDate}T23:59:59`);
  const kept = [];
  for (const bar of bars) {
    const barDate = new Date(`${bar.date}T00:00:00`);
    if (barDate <= cutoff) kept.push(bar);
  }
  return kept;
}

function sma(values, period) {
  if (values.length < period) return null;
  return values.slice(-period).reduce((acc, v) => acc + v, 0) / period;
}

/**
 * 主导合约历史 → price_data / volume_oi 字段（纯函数，可单测）
 * @param {object} args
 * @param {string} args.contract - 主导合约代码（如 SA2701）
 * @param {Array<object>} args.bars - 合约历史 [{date, open, high, low, close, volume, hold}]
 * @param {string} args.signalDate - YYYY-MM-DD
 * @param {string} args.fetchedAt - 抓取时间 ISO8601
 * @returns {{price_data: object, volume_oi: object}}
 */
export function buildCleanSeriesFields({ contract, bars, signalDate, fetchedAt }) {
  const anchored = anchorToSignalDate(bars, signalDate);
  const closes = anchored.map((b) => b.close);
  const volumes = anchored.map((b) => b.volume);
  const holds = anchored.map((b) => b.hold);

  const base = {
    source: 'akshare',
    asOf: `${signalDate}T15:00:00+08:00`,
    fetchedAt,
    series_contract: contract,
    series_source: 'specific_contract'
  };

  let priceData;
  if (closes.length < MIN_BARS_PRICE) {
    priceData = {
      ...base,
      gap: 'missing',
      series_note: `specific-contract history ${closes.length} bars < ${MIN_BARS_PRICE}, insufficient for ma20`
    };
  } else {
    const ma20 = sma(closes, 20);
    const ma60 = sma(closes, MIN_BARS_MA60);
    priceData = {
      ...base,
      close_60d: closes.slice(-WINDOW_BARS),
      ma20,
      ma60,
      freshness: 'same_day',
      gap: null,
      _timestamp_origin: 'observed'
    };
    if (ma60 === null) {
      priceData.series_note = `specific-contract history ${closes.length} bars < ${MIN_BARS_MA60}, ma60 unavailable (null)`;
    }
  }

  let volumeOi;
  if (volumes.length < MIN_BARS_PRICE) {
    volumeOi = {
      ...base,
      gap: 'missing',
      series_note: `specific-contract history ${volumes.length} bars < ${MIN_BARS_PRICE}`
    };
  } else {
    const recent = volumes.slice(-5);
    volumeOi = {
      ...base,
      volume_60d: volumes.slice(-WINDOW_BARS),
      avgVolume5d: recent.reduce((acc, v) => acc + v, 0) / recent.length,
      freshness: 'same_day',
      gap: null,
      _timestamp_origin: 'observed'
    };
    if (holds.length >= MIN_BARS_PRICE) {
      volumeOi.openInterest_60d = holds.slice(-WINDOW_BARS);
    }
  }

  return { price_data: priceData, volume_oi: volumeOi };
}

function spawnPython(args, { python = 'python', timeout = 180000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(python, [TERM_STRUCTURE_PY, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout,
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      reject(new Error(`Python spawn failed: ${err.message}`));
    });
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Python exited with code ${code}: ${stderr.slice(0, 300)}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        if (parsed.error) {
          reject(new Error(`Python error: ${parsed.detail || parsed.error}`));
          return;
        }
        resolve(parsed);
      } catch (err) {
        reject(new Error(`Failed to parse Python output: ${err.message}`));
      }
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 主导合约完整历史（截至 signalDate）
 * @param {string} contract - 合约代码（如 SA2701）
 * @param {string} signalDate - YYYY-MM-DD
 * @param {object} options
 * @param {string} options.python - python 可执行名
 * @param {number} options.timeout - 子进程超时 ms
 * @param {number} options.retries - 失败后额外重试次数（默认 2）
 * @param {number} options.backoffBaseMs - 首次退避等待 ms
 * @param {number} options.bars - 返回的最大 bar 数（默认 80，覆盖 60 窗口 + 余量）
 * @returns {Promise<Array<object>>} [{date, open, high, low, close, volume, hold}]
 */
export async function fetchContractHistory(contract, signalDate, {
  python = 'python',
  timeout = 180000,
  retries = 2,
  backoffBaseMs = 20000,
  bars = 80
} = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const parsed = await spawnPython(
        ['--history', contract, '--date', signalDate, '--bars', String(bars)],
        { python, timeout }
      );
      return parsed.bars || [];
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await sleep(backoffBaseMs * 2 ** attempt);
      }
    }
  }
  throw lastErr;
}

/**
 * 用主导合约干净序列覆盖 packet 的 price_data / volume_oi（freeze-packets 集成点）
 * 失败/降级路径：返回 { ok, dominant, historyBars, error } 诊断信息，
 * 覆盖失败时保持原主力连续字段不动（调用方据此标注 fallback）。
 * @param {object} raw - buildPacketFromRawJson 输出的 raw packet
 * @param {string} dominant - 主导合约代码（如 SA2701）
 * @param {Array<object>} historyBars - 主导合约历史 [{date, open, high, low, close, volume, hold}]
 * @param {string|null} [fetchedAt] - 历史抓取完成时刻（须晚于 packetFrozenAt 的场景由调用方同步封存时刻）
 * @returns {{ok: boolean, dominant: string, historyBars: number, error: string|null}}
 */
export function overrideWithCleanSeries(raw, dominant, historyBars, fetchedAt = null) {
  if (!dominant || !Array.isArray(historyBars) || historyBars.length === 0) {
    return { ok: false, dominant: dominant ?? null, historyBars: historyBars?.length ?? 0, error: 'no_history' };
  }
  const { price_data, volume_oi } = buildCleanSeriesFields({
    contract: dominant,
    bars: historyBars,
    signalDate: raw.signalDate,
    fetchedAt: fetchedAt ?? raw.packetFrozenAt
  });
  raw.fields.price_data = price_data;
  raw.fields.volume_oi = volume_oi;
  return { ok: true, dominant, historyBars: historyBars.length, error: null };
}
