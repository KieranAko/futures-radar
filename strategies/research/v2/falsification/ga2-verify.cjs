#!/usr/bin/env node
/**
 * ga2-verify.cjs — GA-2 派生批量机器校验
 *
 * 校验项：
 *   V1 全品种覆盖：ga2-derived 文件数 = data/daily 品种数，series.dates 与 data/daily 逐 bar 一致
 *   V2 数值 finite：snapshot 六字段全 finite（全品种）；warm-up 期 null 计数符合预期
 *                   （atr5<5、ma20<20、ma60<60、volRatio<5、hv20<21、hvPct90<110）
 *   V3 asOf=T：asOfDate == 品种最后一根 bar 日期
 *   V4 独立复算对拍（RB0/SC0 全序列）：ATR5/MA20/MA60/量比/HV20(YZ 独立实现) 相对误差 <1e-6
 *   V5 HVpct90 数值域 0-100 且与 hvPercentile 同参数复算一致
 *   V6 换月跳变附注：rollJumpDates ⊆ ga1-roll-jumps.json
 */

const fs = require('fs');
const path = require('path');

const SKILL_ROOT = path.join(__dirname, '../../../..');
const DAILY_DIR = path.join(SKILL_ROOT, 'data', 'daily');
const DERIVED_DIR = path.join(__dirname, 'data', 'ga2-derived');
const INDEX_PATH = path.join(__dirname, 'data', 'ga2-derived-index.json');
const ROLL_JUMPS_PATH = path.join(__dirname, 'data', 'ga1-roll-jumps.json');

const { hvPercentile } = require(path.join(SKILL_ROOT, 'probability', 'hv-estimators.js'));

function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function yzIndependent(bars, window = 20) {
  // 独立 Yang-Zhang 实现（复算对拍用，非库实现）
  if (bars.length < window + 1) return null;
  const slice = bars.slice(-window - 1);
  const o = [], c = [], u = [], d = [];
  for (let i = 1; i < slice.length; i++) {
    const p = slice[i - 1], q = slice[i];
    o.push(Math.log(q.open / p.close));
    c.push(Math.log(q.close / q.open));
    u.push(Math.log(q.high / q.open));
    d.push(Math.log(q.low / q.open));
  }
  const n = window;
  const mo = mean(o), mc = mean(c);
  const so = o.reduce((s, v) => s + (v - mo) ** 2, 0) / (n - 1);
  const sc = c.reduce((s, v) => s + (v - mc) ** 2, 0) / (n - 1);
  const rs = u.map((ui, i) => ui * (ui - c[i]) + d[i] * (d[i] - c[i]));
  const sr = rs.reduce((a, b) => a + b, 0) / n;
  const k = 0.34 / (1.34 + (n + 1) / (n - 1));
  return Math.sqrt((so + k * sc + (1 - k) * sr) * 242);
}

const results = [];
const ok = (id, pass, detail) => results.push({ id, pass: !!pass, detail });

function main() {
  const dailyFiles = fs.readdirSync(DAILY_DIR).filter((f) => f.endsWith('.json') && !f.startsWith('_')).sort();
  const derivedFiles = fs.readdirSync(DERIVED_DIR).filter((f) => f.endsWith('.json')).sort();
  const rollJumps = JSON.parse(fs.readFileSync(ROLL_JUMPS_PATH, 'utf8')).bySymbol || {};

  // V1 coverage
  ok('V1-coverage', dailyFiles.length === derivedFiles.length,
    `data/daily=${dailyFiles.length}, ga2-derived=${derivedFiles.length}`);

  const expectedNullWarmup = { atr5: 4, hv20: 20, hvPct90: 109, ma20: 19, ma60: 59, volumeRatio: 4 };
  let v2Fail = [], v3Fail = [], v5Fail = [], v6Fail = [], v4Fail = [], nullWarmupFail = [];
  let allFinite = true;

  for (const f of dailyFiles) {
    const sym = f.slice(0, -5);
    const dp = path.join(DERIVED_DIR, `${sym}.json`);
    if (!fs.existsSync(dp)) { v2Fail.push(`${sym}: missing derived`); continue; }
    const dw = JSON.parse(fs.readFileSync(dp, 'utf8'));
    const raw = JSON.parse(fs.readFileSync(path.join(DAILY_DIR, f), 'utf8'));
    const o = raw.contract.ohlcv;
    const n = o.dates.length;

    // V1 dates identity
    const sd = dw.series.dates;
    if (sd.length !== n || !sd.every((d, i) => d === o.dates[i])) {
      v2Fail.push(`${sym}: series.dates mismatch (${sd.length} vs ${n})`);
      continue;
    }

    // V2 finite snapshot
    const s = dw.snapshot;
    for (const k of ['atr5', 'hv20', 'hvPct90', 'ma20', 'ma60', 'volumeRatio']) {
      if (s[k] == null || !Number.isFinite(s[k])) { v2Fail.push(`${sym}: snapshot.${k} null/non-finite`); allFinite = false; }
    }
    if (s.cones == null || !s.cones['3d'] || !s.cones['5d']) v2Fail.push(`${sym}: cones missing`);

    // V2 warm-up / 源零量窗口 null 计数（期望 null = 前 warm 根 + 源端 5 日量总和为 0 的窗口）
    const expectedNulls = {
      atr5: new Set(), hv20: new Set(), hvPct90: new Set(), ma20: new Set(), ma60: new Set(), volumeRatio: new Set()
    };
    for (let i = 0; i < n; i++) {
      if (i < 4) expectedNulls.atr5.add(i);
      if (i < 20) expectedNulls.hv20.add(i);
      if (i < 109) expectedNulls.hvPct90.add(i);
      if (i < 19) expectedNulls.ma20.add(i);
      if (i < 59) expectedNulls.ma60.add(i);
      if (i < 4) expectedNulls.volumeRatio.add(i);
      else if (i < n) {
        const win = o.volume.slice(i - 4, i + 1);
        if (win.reduce((a, b) => a + b, 0) === 0) expectedNulls.volumeRatio.add(i);
      }
    }
    for (const [k, warm] of Object.entries(expectedNullWarmup)) {
      const arr = dw.series[k];
      const exp = expectedNulls[k];
      let mismatch = [];
      for (let i = 0; i < n; i++) {
        const isNull = arr[i] == null || !Number.isFinite(arr[i]);
        if (isNull !== exp.has(i)) { mismatch.push(i); if (mismatch.length >= 3) break; }
      }
      if (mismatch.length > 0) nullWarmupFail.push(`${sym}: ${k} null-pattern mismatch at ${mismatch.map((i) => o.dates[i]).join(',')}`);
    }

    // V3 asOf
    if (s.asOfDate !== o.dates[n - 1]) v3Fail.push(`${sym}: asOf=${s.asOfDate} lastBar=${o.dates[n - 1]}`);

    // V5 hvPct90 domain
    for (const v of dw.series.hvPct90) {
      if (v != null && (v < 0 || v > 100)) { v5Fail.push(`${sym}: hvPct90 out of range ${v}`); break; }
    }
    // V5 recompute last bar
    const n2 = o.dates.length;
    if (n2 >= 110) {
      const bars = o.dates.map((dd, i) => ({ date: dd, open: o.open[i], high: o.high[i], low: o.low[i], close: o.close[i] }));
      const p = hvPercentile(bars, 20);
      if (Math.abs(p.percentile - s.hvPct90) > 0.11) v5Fail.push(`${sym}: hvPct90 recompute mismatch ${p.percentile} vs ${s.hvPct90}`);
    }

    // V6 roll jumps subset
    const rjSet = new Set((rollJumps[sym] || []).map((j) => j.date));
    for (const d of dw.rollJumpDates) if (!rjSet.has(d)) v6Fail.push(`${sym}: unknown roll date ${d}`);
  }

  ok('V2-finite', v2Fail.length === 0 && allFinite, v2Fail.slice(0, 5).join('; ') || 'all snapshot fields finite');
  ok('V2-warmup', nullWarmupFail.length === 0, nullWarmupFail.slice(0, 5).join('; ') || 'warm-up nulls as expected');
  ok('V3-asOf', v3Fail.length === 0, v3Fail.slice(0, 5).join('; ') || 'asOf == last bar for all symbols');
  ok('V5-hvPct90', v5Fail.length === 0, v5Fail.slice(0, 5).join('; ') || 'percentile domain & recompute ok');
  ok('V6-rollJumps', v6Fail.length === 0, v6Fail.slice(0, 5).join('; ') || 'roll jump dates consistent');

  // V4 independent recompute on RB0 / SC0 full series
  for (const sym of ['RB0', 'SC0']) {
    const dw = JSON.parse(fs.readFileSync(path.join(DERIVED_DIR, `${sym}.json`), 'utf8'));
    const raw = JSON.parse(fs.readFileSync(path.join(DAILY_DIR, `${sym}.json`), 'utf8'));
    const o = raw.contract.ohlcv;
    const n = o.dates.length;
    const bars = o.dates.map((dd, i) => ({ date: dd, open: o.open[i], high: o.high[i], low: o.low[i], close: o.close[i] }));
    // naive recompute
    const tr = new Array(n);
    let s5 = 0; const b5 = new Array(5).fill(0); let p5 = 0, c5 = 0;
    const s20 = [], s60 = [];
    let maxRel = 0;
    for (let i = 0; i < n; i++) {
      tr[i] = i === 0 ? o.high[i] - o.low[i] : Math.max(o.high[i] - o.low[i], Math.abs(o.high[i] - o.close[i - 1]), Math.abs(o.low[i] - o.close[i - 1]));
      if (c5 === 5) s5 -= b5[p5]; else c5++;
      b5[p5] = tr[i]; s5 += tr[i]; p5 = (p5 + 1) % 5;
      const atr5 = c5 === 5 ? s5 / 5 : null;
      if (atr5 != null && dw.series.atr5[i] != null && dw.series.atr5[i] !== 0) maxRel = Math.max(maxRel, Math.abs(atr5 / dw.series.atr5[i] - 1));

      s20.push(o.close[i]); s60.push(o.close[i]);
      if (i >= 19) { const m20 = mean(s20.slice(-20)); if (dw.series.ma20[i] != null && dw.series.ma20[i] !== 0) maxRel = Math.max(maxRel, Math.abs(m20 / dw.series.ma20[i] - 1)); }
      if (i >= 59) { const m60 = mean(s60.slice(-60)); if (dw.series.ma60[i] != null && dw.series.ma60[i] !== 0) maxRel = Math.max(maxRel, Math.abs(m60 / dw.series.ma60[i] - 1)); }
      if (i >= 4) {
        const mv = mean(o.volume.slice(i - 4, i + 1));
        const vr = mv > 0 ? o.volume[i] / mv : null;
        if (vr != null && dw.series.volumeRatio[i] != null && dw.series.volumeRatio[i] !== 0) maxRel = Math.max(maxRel, Math.abs(vr / dw.series.volumeRatio[i] - 1));
      }
      if (i >= 20) {
        const hv = yzIndependent(bars.slice(i - 20, i + 1), 20);
        if (hv != null && dw.series.hv20[i] != null && dw.series.hv20[i] !== 0) maxRel = Math.max(maxRel, Math.abs(hv / dw.series.hv20[i] - 1));
      }
    }
    ok(`V4-recompute-${sym}`, maxRel < 1e-6, `maxRel=${maxRel.toExponential(2)} (naive ATR5/MA20/MA60/量比 + 独立 YZ 实现)`);
  }

  // summary
  const pass = results.filter((r) => r.pass).length;
  console.log('=== GA-2 Verification ===');
  for (const r of results) console.log(`${r.pass ? '✅' : '❌'} ${r.id}: ${r.detail}`);
  console.log(`\nTOTAL: ${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
}

main();
