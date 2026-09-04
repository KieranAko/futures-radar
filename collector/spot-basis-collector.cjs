// collector/spot-basis-collector.cjs — 期现基差采集（v1）
//
// 源路由：
//   mysteel  → 解析公开行情页的“现货折盘面价”（可交割口径）
//   100ppi   → 经 akshare futures_spot_price_daily 获取生意社市场现货价（仅参考）
//
// 输出：output/runs/<runId>/spot-basis.json（当期 KEEP 品种快照）
//        data/spot-basis/<SYMBOL>.jsonl（append-only 主档）
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { runDir } = require('../lib/workspace.cjs');

const SOURCES_PATH = path.join(__dirname, '..', 'config', 'spot-basis-sources.json');
const DATA_ROOT = path.join(__dirname, '..', 'data', 'spot-basis');

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function symbolToAk(symbol) {
  return String(symbol).endsWith('0') ? String(symbol).slice(0, -1) : String(symbol);
}

function latestDate(raw) {
  let latest = null;
  for (const c of Object.values(raw?.contracts || {})) {
    const dates = c?.ohlcv?.dates;
    if (Array.isArray(dates) && dates.length) {
      const last = dates[dates.length - 1];
      if (!latest || last > latest) latest = last;
    }
  }
  return latest;
}

function parseMysteelPrice(html, spec) {
  const text = html.replace(/<[^>]+>/g, ' ');
  const re = new RegExp(String(spec).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*([0-9]{2,4}(?:\\.[0-9]+)?)', 'u');
  const m = text.match(re);
  if (!m) {
    const m2 = text.match(/([0-9]{2,4}(?:\.[0-9]+)?)\s*[-+]\s*[0-9]+/u);
    return m2 ? parseFloat(m2[1]) : null;
  }
  return parseFloat(m[1]);
}

async function fetchMysteel(cfg, futuresPrice, signalDate) {
  const res = await fetch(cfg.articleUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    signal: AbortSignal.timeout(20000)
  });
  if (!res.ok) throw new Error(`mysteel fetch ${res.status} ${cfg.articleUrl}`);
  const html = await res.text();
  const spot = parseMysteelPrice(html, cfg.spec || '重质纯碱');
  if (spot == null) throw new Error(`mysteel price not parsed: ${cfg.symbol}`);
  const basis = Math.round((spot - futuresPrice) * 100) / 100;
  const basisRate = futuresPrice ? Math.round((basis / futuresPrice) * 10000) / 10000 : null;
  return {
    symbol: cfg.symbol, date: signalDate, source: 'mysteel', articleUrl: cfg.articleUrl,
    market: cfg.market || null, spec: cfg.spec || null,
    spotPrice: spot, spotAdjustedPrice: spot, futuresPrice,
    basis, basisRate, status: 'fresh'
  };
}

function fetch100ppi(cfg, futuresPrice, signalDate) {
  const py = [
    'import json,sys',
    'import akshare as ak',
    `df=ak.futures_spot_price_daily(start_day='${signalDate}', end_day='${signalDate}', vars_list=['${symbolToAk(cfg.symbol)}'])`,
    'row=df.iloc[-1].to_dict() if len(df)>0 else {}',
    'print(json.dumps(row, ensure_ascii=False))'
  ].join(';');
  const res = cp.spawnSync('python', ['-c', py], { encoding: 'utf8', timeout: 60000, windowsHide: true });
  if (res.status !== 0) throw new Error(`100ppi python failed: ${res.stderr || res.stdout}`);
  const row = JSON.parse(res.stdout.trim());
  const spot = Number(row.spot_price);
  if (!Number.isFinite(spot)) throw new Error(`100ppi spot missing: ${cfg.symbol}`);
  const basis = Math.round((spot - futuresPrice) * 100) / 100;
  const basisRate = futuresPrice ? Math.round((basis / futuresPrice) * 10000) / 10000 : null;
  return {
    symbol: cfg.symbol, date: signalDate, source: '100ppi',
    spotPrice: spot, spotAdjustedPrice: null, futuresPrice,
    basis, basisRate, status: 'reference'
  };
}

async function collect(runId) {
  const dir = runDir(runId);
  const filtered = readJson(path.join(dir, 'filtered.json'));
  const raw = readJson(path.join(dir, 'raw.json'));
  const sources = readJson(SOURCES_PATH);
  const sourceMap = new Map((sources?.sources || []).map((s) => [s.symbol, s]));
  const signalDate = latestDate(raw);
  const keep = (filtered?.candidates || []).filter((c) => c.decision === 'KEEP');
  const rows = [];

  for (const k of keep) {
    const cfg = sourceMap.get(k.symbol);
    const contract = raw.contracts?.[k.symbol];
    const o = contract?.ohlcv;
    const futuresPrice = o?.close?.[o.close.length - 1];
    if (cfg == null || futuresPrice == null) {
      rows.push({ symbol: k.symbol, status: 'unavailable', reason: '缺少源配置或期货价格' });
      continue;
    }
    try {
      const row = cfg.source === 'mysteel'
        ? await fetchMysteel(cfg, futuresPrice, signalDate)
        : fetch100ppi(cfg, futuresPrice, signalDate);
      rows.push(row);
      appendMain(row);
    } catch (err) {
      rows.push({ symbol: k.symbol, status: 'unavailable', reason: String(err.message || err) });
    }
  }

  const out = {
    schema: 'futures-radar-spot-basis-snapshot/1',
    runId,
    signalDate,
    fetchedAt: new Date().toISOString(),
    symbols: rows
  };
  const outFile = path.join(dir, 'spot-basis.json');
  writeJson(outFile, out);
  console.log(`spot-basis: ${rows.filter((r) => r.status !== 'unavailable').length}/${rows.length} available → ${outFile}`);
  for (const r of rows) console.log(`  ${r.symbol} ${r.status === 'unavailable' ? 'unavailable' : `${r.source} spot=${r.spotPrice} basis=${r.basis} rate=${r.basisRate}`}`);
  return out;
}

function appendMain(row) {
  if (!row || row.status === 'unavailable') return;
  const file = path.join(DATA_ROOT, `${row.symbol}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify({ ...row, fetchedAt: new Date().toISOString() }) + '\n', 'utf8');
}

async function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--runId');
  const runId = i >= 0 ? args[i + 1] : null;
  if (!runId) throw new Error('--runId required');
  await collect(runId);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { collect, parseMysteelPrice, fetchMysteel };
