#!/usr/bin/env node
/**
 * close-snapshot.cjs — futures-radar 收盘快照快速通道 (v0.1.2)
 *
 * 背景：sina 日线接口（futures_main_sina）在收盘后经常延迟数小时才发布当日 bar，
 * 而 sina 实时行情（hq.sinajs.cn nf_ 连续合约）在日盘收盘后即为完整交易日数据。
 * 2026-08-27 实测：收盘快照与监控中心官方日线（CFMMC）对 RB2701/CU2610 的
 * open/high/low/close/settle/pre_settle/volume/open_interest 完全一致。
 *
 * 通道契约（冻结不变量 #5）：
 *  - 仅在日线接口缺少当日 bar 时兜底补 bar（append-only，不覆盖历史）
 *  - 快照 date 必须 === 本地今日 且 time >= 15:00:00（日盘收盘），否则整条拒绝
 *  - bar 来源盖章 lastBarSource="sina_close_snapshot" + lastBarAsOf，provenance 透传
 *  - 仅追加到 raw.json 主力连续序列；不用于盘中（time 校验天然阻断）
 *
 * Usage:
 *   node collector/close-snapshot.cjs --runId 20260827-1529-auto   (standalone refresh)
 *   const { fetchCloseSnapshot, mergeSnapshotBars, parseSnapshotLine } = require('./close-snapshot.cjs')
 */

const fs = require('fs');
const path = require('path');
const { runtimeRoot, skillRoot } = require('../lib/workspace.cjs');
const { retryWithBackoff } = require('./backoff.cjs');

const SNAPSHOT_SOURCE = 'sina_close_snapshot';
const DAY_CLOSE_TIME = '150000'; // HHMMSS — 日盘收盘 15:00:00

// ── nf_ 行字段序（依据 akshare futures_zh_spot 列映射，收盘后为完整日线 bar）──
// 0 symbol名,1 time,2 open,3 high,4 low,5 last_close,6 bid,7 ask,8 close(最新),
// 9 settle(结算,收盘后=官方结算),10 last_settle,11 buy_vol,12 sell_vol,13 hold,14 volume,
// 15 交易所,16 品种名,17 date(YYYY-MM-DD)
const F = {
  name: 0, time: 1, open: 2, high: 3, low: 4, close: 8,
  settle: 9, preSettle: 10, hold: 13, volume: 14, date: 17
};

function isValidDateStr(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * 解析单行 nf_ 行情并校验为"完整收盘 bar"。
 * @returns {{ok:true, symbol:string, bar:object, asOf:string} | {ok:false, symbol:string|null, reason:string}}
 */
function parseSnapshotLine(line, opts = {}) {
  const localToday = opts.localToday || todayStr();
  const m = /var\s+hq_str_nf_([A-Z0-9]+)\s*=\s*"(.*)"/.exec(line || '');
  if (!m) return { ok: false, symbol: null, reason: 'line_format' };
  const symbol = m[1];
  const parts = m[2].split(',');
  if (parts.length < 18) return { ok: false, symbol, reason: 'fields_short' };

  const date = parts[F.date].trim();
  const time = parts[F.time].trim();
  const num = (i) => {
    const v = parseFloat(parts[i]);
    return isNaN(v) ? null : v;
  };

  const bar = {
    date,
    time,
    open: num(F.open), high: num(F.high), low: num(F.low),
    close: num(F.close), settle: num(F.settle), preSettle: num(F.preSettle),
    volume: num(F.volume), hold: num(F.hold)
  };

  // 校验 1：日期必须为本地今日且为真实日历日期
  if (date !== localToday) return { ok: false, symbol, reason: 'date_not_today', rawDate: date };
  if (!isValidDateStr(date)) return { ok: false, symbol, reason: 'date_invalid', rawDate: date };
  // 校验 2：日盘已收盘（15:00:00 起）；盘中/午休快照一律拒绝（时间戳为源行为）
  if (!/^\d{6}$/.test(time)) return { ok: false, symbol, reason: 'time_invalid', rawTime: time };
  if (time < DAY_CLOSE_TIME) return { ok: false, symbol, reason: 'before_day_close', rawTime: time };
  // 校验 3：价格完整性 + OHLC 结构自洽
  if ([bar.open, bar.high, bar.low, bar.close, bar.settle].some((v) => v === null || v <= 0)) {
    return { ok: false, symbol, reason: 'price_invalid' };
  }
  if (bar.high < Math.max(bar.open, bar.low, bar.close) || bar.low > Math.min(bar.open, bar.high, bar.close)) {
    return { ok: false, symbol, reason: 'ohlc_inconsistent' };
  }
  if (bar.volume === null || bar.volume < 0 || bar.hold === null || bar.hold < 0) {
    return { ok: false, symbol, reason: 'volume_oi_invalid' };
  }

  return {
    ok: true,
    symbol,
    bar: {
      open: bar.open, high: bar.high, low: bar.low, close: bar.close,
      settle: bar.settle, preSettle: bar.preSettle,
      volume: bar.volume, hold: bar.hold
    },
    asOf: date + ' ' + time
  };
}

/**
 * 拉取白名单主力连续合约的收盘快照（分块请求 hq.sinajs.cn）。
 * @returns {Promise<{fetchedAt:string, bars:Object<string,{open,high,low,close,settle,preSettle,volume,hold}>, asOf:Object<string,string>, errors:Object<string,string>}>}
 */
async function fetchCloseSnapshot(symbols, opts = {}) {
  const localToday = opts.localToday || todayStr();
  const chunkSize = opts.chunkSize || 20;
  const bars = {};
  const asOf = {};
  const errors = {};
  const fetchedAt = new Date().toISOString();

  for (let i = 0; i < symbols.length; i += chunkSize) {
    const chunk = symbols.slice(i, i + chunkSize);
    const list = chunk.map((s) => 'nf_' + s).join(',');
    let text;
    try {
      // P2: 单块拉取失败按指数退避重试 1 次（3s 基座），避免瞬时 456/连接抖动
      text = await retryWithBackoff(async () => {
        const res = await fetch('https://hq.sinajs.cn/list=' + list, {
          headers: { Referer: 'https://finance.sina.com.cn' }
        });
        if (!res.ok) throw new Error('http ' + res.status);
        const buf = await res.arrayBuffer();
        return new TextDecoder('gbk').decode(buf);
      }, { label: 'close-snapshot chunk', attempts: 2, baseMs: 3000 });
    } catch (err) {
      for (const s of chunk) errors[s] = 'fetch_failed: ' + err.message;
      continue;
    }
    for (const line of text.split(';')) {
      const t = line.trim();
      if (!t || !t.startsWith('var hq_str_nf_')) continue;
      const parsed = parseSnapshotLine(t, { localToday });
      if (!parsed.ok || !parsed.symbol) {
        errors[parsed.symbol || 'unknown'] = parsed.reason + (parsed.rawDate ? ' rawDate=' + parsed.rawDate : '') + (parsed.rawTime ? ' rawTime=' + parsed.rawTime : '');
        continue;
      }
      bars[parsed.symbol] = parsed.bar;
      asOf[parsed.symbol] = parsed.asOf;
    }
    // 未返回报价的品种标记 missing
    for (const s of chunk) {
      if (!(s in bars) && !(s in errors)) errors[s] = 'missing_from_response';
    }
  }

  return { fetchedAt, bars, asOf, errors, localToday };
}

/**
 * 将快照 bar 追加进 rawData.contracts（append-only）。
 * 仅当日线序列尚无 localToday 且快照通过校验时追加。
 * @returns {{appended:string[], skipped:string[], failed:string[]}}
 */
function mergeSnapshotBars(rawData, snapshot, opts = {}) {
  const localToday = opts.localToday || snapshot.localToday || todayStr();
  const appended = [];
  const skipped = [];
  const failed = [];

  const contracts = rawData.contracts || {};
  for (const [sym, contract] of Object.entries(contracts)) {
    const ohlcv = contract.ohlcv;
    if (!ohlcv || !Array.isArray(ohlcv.dates)) {
      failed.push(sym);
      continue;
    }
    if (ohlcv.dates.includes(localToday)) {
      skipped.push(sym); // 日线接口已含当日 bar，快照不覆盖
      continue;
    }
    if (!snapshot.bars[sym]) {
      failed.push(sym); // 快照缺失/被拒 → 保持原样（gap 语义，不伪造）
      continue;
    }
    const b = snapshot.bars[sym];
    // 防重：上一根 bar 日期必须 < 快照日期（append-only 单调性）
    const lastDate = ohlcv.dates[ohlcv.dates.length - 1];
    if (lastDate >= localToday) { skipped.push(sym); continue; }

    ohlcv.dates.push(localToday);
    ohlcv.open.push(b.open);
    ohlcv.high.push(b.high);
    ohlcv.low.push(b.low);
    ohlcv.close.push(b.close);
    ohlcv.volume.push(b.volume);
    ohlcv.open_interest.push(b.hold);
    ohlcv.settle.push(b.settle);

    contract.dataEnd = localToday;
    contract.usedBars = ohlcv.dates.length;
    contract.lastBarSource = SNAPSHOT_SOURCE;
    contract.lastBarAsOf = snapshot.asOf[sym] || (localToday + ' 150000');
    contract.lastBarNote = 'sina 收盘快照：日线接口尚未发布当日 bar，快照经 date==本地今日 + time>=15:00:00 + OHLC 自洽校验后补入';
    appended.push(sym);
  }

  return { appended, skipped, failed };
}

function todayStr(now = new Date()) {
  return now.getFullYear() + '-' +
    String(now.getMonth() + 1).padStart(2, '0') + '-' +
    String(now.getDate()).padStart(2, '0');
}

// ── CLI: 对既有 run 的 raw.json 做独立快照刷新 ──────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--runId');
  const runId = i >= 0 ? args[i + 1] : null;
  if (!runId) { console.error('ERROR: --runId is required'); process.exit(1); }

  const runDir = path.join(runtimeRoot, 'runs', runId);
  const rawPath = path.join(runDir, 'raw.json');
  if (!fs.existsSync(rawPath)) { console.error('ERROR: raw.json not found: ' + rawPath); process.exit(1); }

  const rawData = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
  const symbols = Object.keys(rawData.contracts || {});
  const localToday = todayStr();

  console.log('=== futures-radar close-snapshot ===');
  console.log('runId: ' + runId + '  localToday: ' + localToday + '  symbols: ' + symbols.length);

  const snapshot = await fetchCloseSnapshot(symbols, { localToday });
  const okCount = Object.keys(snapshot.bars).length;
  console.log('fetched: ' + okCount + ' ok / ' + Object.keys(snapshot.errors).length + ' errors');

  const merged = mergeSnapshotBars(rawData, snapshot, { localToday });
  console.log('appended: ' + merged.appended.length + '  skipped: ' + merged.skipped.length + '  failed: ' + merged.failed.length);
  if (merged.appended.length) console.log('appended symbols: ' + merged.appended.join(','));

  rawData.meta = rawData.meta || {};
  rawData.meta.fastClose = {
    used: merged.appended.length > 0,
    source: SNAPSHOT_SOURCE,
    fetchedAt: snapshot.fetchedAt,
    localToday,
    appended: merged.appended.length,
    skipped: merged.skipped.length,
    failed: merged.failed.length,
    errors: snapshot.errors
  };
  fs.writeFileSync(rawPath, JSON.stringify(rawData, null, 2));
  console.log('raw.json → ' + rawPath);
  process.exit(0);
}

module.exports = { fetchCloseSnapshot, mergeSnapshotBars, parseSnapshotLine, todayStr, SNAPSHOT_SOURCE, DAY_CLOSE_TIME };

if (require.main === module) {
  main().catch((err) => { console.error('FATAL: ' + err.message); process.exit(1); });
}
