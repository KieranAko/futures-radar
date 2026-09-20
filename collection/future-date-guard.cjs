/**
 * collector/future-date-guard.cjs — 日线未来日期防御守卫
 *
 * 冻结不变量 #1（2026-08-27）：日线接口只返回完整 bar，末 bar 日期 > 本地今日
 * 视为源行为异常（应永不触发）。守卫在数据进入缓存/raw.json 前剔除异常合约，
 * 避免污染数据被后续增量采集复用。
 *
 * 严格性（P1 修复，缅因猫复审 43427885b）：日期必须符合严格 YYYY-MM-DD 且为真实
 * 日历日期；带时间戳/junk/不存在日期一律拒绝（fail-closed），不得静默截断。
 * todayStr 由调用方传入（本地时区手动拼，不用 toISOString 避免 UTC 偏差），
 * 非法 todayStr 直接抛错（调用方 bug，fail-closed）。
 */

'use strict';

function isValidDateStr(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  // round-trip：Date 对不存在的日期会 rollover（如 2026-02-30 → 03-02），
  // 回读比对即可识别真实日历日期，无需手写闰年表
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function normalizeBarDate(d) {
  if (d == null || d === '') return null;
  const s = String(d).trim();
  return isValidDateStr(s) ? s : null;
}

function lastRawDate(contract) {
  const dates = contract && contract.ohlcv && contract.ohlcv.dates;
  if (!Array.isArray(dates) || dates.length === 0) return null;
  return dates[dates.length - 1];
}

/**
 * 逐合约校验末 bar 日期。rejected 条目含完整诊断：
 * { symbol, rawDate（原始值）, lastBarDate（解析后合法日期，非法为 null）, fetchedAt, reason }
 * @param {Object<string,Object>} contracts 采集到的合约原始数据
 * @param {string} todayStr 本地今日 YYYY-MM-DD
 * @returns {{ok: boolean, rejected: Array<object>, passed: string[]}}
 */
function guardFutureDates(contracts, todayStr) {
  if (!isValidDateStr(todayStr)) {
    throw new Error(`future-date-guard: invalid todayStr ${JSON.stringify(todayStr)} (expected strict YYYY-MM-DD real calendar date)`);
  }
  const rejected = [];
  const passed = [];
  for (const [symbol, contract] of Object.entries(contracts || {})) {
    if (!contract || !contract.ohlcv) {
      rejected.push({
        symbol,
        rawDate: null,
        lastBarDate: null,
        fetchedAt: contract && contract.fetchedAt,
        reason: 'missing ohlcv: cannot validate bar dates',
      });
      continue;
    }
    const raw = lastRawDate(contract);
    if (raw === null || raw === undefined || raw === '') {
      rejected.push({
        symbol,
        rawDate: raw === undefined ? null : String(raw),
        lastBarDate: null,
        fetchedAt: contract.fetchedAt,
        reason: 'no dates: empty ohlcv.dates sequence',
      });
      continue;
    }
    const last = normalizeBarDate(raw);
    if (last === null) {
      rejected.push({
        symbol,
        rawDate: String(raw),
        lastBarDate: null,
        fetchedAt: contract.fetchedAt,
        reason: `invalid date: ${JSON.stringify(String(raw))} is not a strict YYYY-MM-DD real calendar date`,
      });
      continue;
    }
    if (last > todayStr) {
      rejected.push({
        symbol,
        rawDate: last,
        lastBarDate: last,
        fetchedAt: contract.fetchedAt,
        reason: `future date: last bar ${last} > local today ${todayStr}`,
      });
      continue;
    }
    passed.push(symbol);
  }
  return { ok: rejected.length === 0, rejected, passed };
}

/**
 * collector 集成：就地剔除被拒合约（不进 raw.json），降级为 gaps。
 * 全拒时 contractsLeft === 0，collector 应 fatal 不落 artifacts。
 * @returns {{ok: boolean, rejected: Array<object>, contractsLeft: number}}
 */
function rejectFutureDateContracts(rawData, todayStr) {
  const { ok, rejected } = guardFutureDates(rawData.contracts, todayStr);
  for (const r of rejected) {
    delete rawData.contracts[r.symbol];
    const detail = `${r.reason}` +
      (r.rawDate != null ? ` (rawDate=${r.rawDate})` : '') +
      (r.fetchedAt ? ` (fetchedAt=${r.fetchedAt})` : '');
    rawData.gaps[r.symbol] = { symbol: r.symbol, reason: `future_date_rejected: ${detail}` };
  }
  return { ok, rejected, contractsLeft: Object.keys(rawData.contracts).length };
}

module.exports = { guardFutureDates, normalizeBarDate, isValidDateStr, rejectFutureDateContracts };
