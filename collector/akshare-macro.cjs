// collector/akshare-macro.cjs — Phase 3 阶段一宏观锚点数据源适配器
//
// 职责：按指标 fetch spec 调用 Python 采集脚本（macro_collector.py），
// 返回原始日频序列。bar 选择（<= signalDate）与 change5d 计算在
// macro-probe.cjs 完成，本模块不做数值派生。
//
// 可注入 pythonCmd/scriptPath 供测试替换假采集器。

const path = require('path');
const cp = require('child_process');
const { skillRoot } = require('../lib/workspace.cjs');
const { retryWithBackoff } = require('./backoff.cjs');

const DEFAULT_SCRIPT = path.join(skillRoot, 'collector', 'macro_collector.py');

function fetchSeries(fetchSpec, { pythonCmd = 'python', scriptPath = null, timeoutMs = 90000, signalDate = null } = {}) {
  const script = scriptPath || DEFAULT_SCRIPT;
  // akshare 源需要 signalDate 推算起始日期，合并进 spec；sina_fx 不需要
  const spec = signalDate ? { ...fetchSpec, signalDate } : fetchSpec;
  const args = [script, '--spec', JSON.stringify(spec)];
  const res = cp.spawnSync(pythonCmd, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });

  if (res.error) {
    return { ok: false, error: `spawn failed: ${res.error.message}`, fetchedAt: null };
  }

  const stdout = (res.stdout || '').trim();
  const line = stdout.split(/\r?\n/).filter((l) => l.trim().startsWith('{')).pop();
  if (!line) {
    return {
      ok: false,
      error: `no JSON output (exit ${res.status}): ${(res.stderr || '').slice(0, 200)}`,
      fetchedAt: null,
    };
  }

  try {
    return JSON.parse(line);
  } catch (e) {
    return { ok: false, error: `bad JSON output: ${line.slice(0, 200)}`, fetchedAt: null };
  }
}

// ── P2：重试（456 指数退避）+ sina_fx 实时快照备用通道 ──────────────────

// sina 实时外汇快照（hq.sinajs.cn fx_s 码）：USDCNH 有实时码，DXY(DINIW) 无 → 失败。
// 字段：0=时间, 3=昨收, 8=现价, 17=日期（2026-08-27 实测 3=6.7216 与日线昨收一致）
async function fetchSinaFxSnapshot(symbol, opts = {}) {
  const code = 'fx_s' + String(symbol).toLowerCase();
  const url = 'https://hq.sinajs.cn/list=' + code;
  const res = await fetch(url, { headers: { Referer: 'https://finance.sina.com.cn' } });
  if (!res.ok) throw new Error('http ' + res.status);
  const buf = await res.arrayBuffer();
  const text = new TextDecoder('gbk').decode(buf);
  const m = /"(.*)"/.exec(text || '');
  if (!m || !m[1]) throw new Error('empty snapshot for ' + code);
  const parts = m[1].split(',');
  if (parts.length < 18) throw new Error('fields_short');
  const price = Number(parts[8]);
  const date = parts[17].trim();
  if (!Number.isFinite(price) || price <= 0) throw new Error('bad price');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('bad date: ' + date);
  return {
    ok: true,
    kind: 'sina_fx_snapshot',
    series: [[date, price]],
    fetchedAt: new Date().toISOString(),
    snapshotTime: parts[0].trim(),
    note: 'sina 实时快照兜底（日线通道失败后启用；观测值非日线 bar，change5d 不可用）'
  };
}

// 重试包装：fetchSeries 失败（ok=false）时按指数退避重试；opts.fetchSeriesFn 可注入（测试）
async function fetchSeriesWithRetry(fetchSpec, opts = {}) {
  const fn = opts.fetchSeriesFn || fetchSeries;
  return retryWithBackoff(async () => {
    const r = await fn(fetchSpec, opts);
    if (!r.ok) throw new Error(r.error || 'fetch failed');
    return r;
  }, {
    label: 'macro ' + (fetchSpec.kind || 'unknown'),
    attempts: opts.attempts || 2,
    baseMs: 5000
  });
}

// 备用通道：sina_fx 主通道失败后，USDCNH 尝试实时快照（同族真实数据，非近似顶替）；
// DXY 无实时码 → 保持 missing（按数据纪律，不伪造）。
async function fetchSeriesWithBackup(fetchSpec, opts = {}) {
  let primary;
  try {
    primary = await fetchSeriesWithRetry(fetchSpec, opts);
  } catch (e) {
    // 重试耗尽 → 转 ok:false 以便备用通道/调用方统一处理
    primary = { ok: false, error: e.message, fetchedAt: null, retryExhausted: true };
  }
  if (primary.ok) return primary;
  if (fetchSpec.kind === 'sina_fx' && fetchSpec.symbol === 'USDCNH') {
    try {
      const snapFn = opts.fetchSnapshotFn || fetchSinaFxSnapshot;
      const snap = await snapFn(fetchSpec.symbol, opts);
      const today = opts.today || new Date().toISOString().slice(0, 10);
      const snapDate = String(snap.series[0][0]);
      if (snapDate !== today) {
        return { ...primary, backupTried: 'sina_fx_snapshot', backupNote: 'snapshot date ' + snapDate + ' != today ' + today };
      }
      return { ...snap, primaryError: primary.error };
    } catch (e) {
      return { ...primary, backupTried: 'sina_fx_snapshot', backupNote: e.message };
    }
  }
  return primary;
}

module.exports = { fetchSeries, fetchSinaFxSnapshot, fetchSeriesWithRetry, fetchSeriesWithBackup };
