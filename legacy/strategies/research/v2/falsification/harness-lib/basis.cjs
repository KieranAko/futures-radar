// falsification harness — FS-02 PIT basis-history loader (GA-8 output)
// Reads only local files under falsification/data/basis-history (no network).
// Rate convention: br = (S - F) / S = -dom_basis_rate (source dom_basis_rate = (F-S)/S).
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { FALS_DATA_DIR, assert } = require('./util.cjs');

const BASIS_DIR = path.join(FALS_DATA_DIR, 'basis-history');

function manifestPath() {
  return path.join(BASIS_DIR, 'manifest.json');
}

function loadManifest() {
  if (!fs.existsSync(manifestPath())) return null;
  return JSON.parse(fs.readFileSync(manifestPath(), 'utf8'));
}

// libSymbol like 'RB0' -> source symbol 'RB'; returns sorted rows for that symbol
function loadBasisHistory(libSymbol, { validate = true } = {}) {
  const manifest = loadManifest();
  if (!manifest) throw new Error('basis-history manifest not found; run ga8-basis-history-collector.py init/backfill first');
  const sourceSymbol = String(libSymbol).endsWith('0') ? String(libSymbol).slice(0, -1) : String(libSymbol);
  const file = path.join(BASIS_DIR, `${sourceSymbol}.jsonl`);
  if (!fs.existsSync(file)) return { symbol: sourceSymbol, libSymbol, manifest, rows: [] };
  const rows = fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line))
    .filter((r) => r.symbol === sourceSymbol)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (validate) {
    let prev = null;
    for (const r of rows) {
      assert(r.libSymbol === libSymbol, `${file}: libSymbol mismatch ${r.libSymbol} != ${libSymbol}`);
      assert(prev === null || r.date > prev, `${file}: dates not strictly ascending at ${r.date}`);
      if (r.br !== null && r.br !== undefined && r.domBasisRate !== null && r.domBasisRate !== undefined) {
        const expected = Math.round(-r.domBasisRate * 1e12) / 1e12;
        assert(Math.abs(r.br - expected) < 1e-9, `${file} ${r.date}: br != -domBasisRate`);
      }
      prev = r.date;
    }
  }
  return { symbol: sourceSymbol, libSymbol, manifest, rows };
}

function loadBasisSummary() {
  const p = path.join(BASIS_DIR, 'summary.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// FS-02 F2 滚动锚（PIT）：窗口 [t-window, t-1]，不含当日；返回与 rows 对齐的序列。
// rows 须为 loadBasisHistory 的输出（升序）。
function basisZSeries(rows, { window = 180, minObs = 180 } = {}) {
  const n = rows.length;
  const out = new Array(n);
  let sum = 0;
  let sumsq = 0;
  let count = 0;
  for (let t = 0; t < n; t++) {
    if (t > 0) {
      const prev = rows[t - 1].br;
      if (prev !== null && prev !== undefined && Number.isFinite(Number(prev))) {
        sum += Number(prev);
        sumsq += Number(prev) ** 2;
        count += 1;
      }
      if (count > window) {
        const drop = rows[t - 1 - window];
        const dropV = drop && drop.br !== null && drop.br !== undefined ? Number(drop.br) : null;
        if (dropV !== null && Number.isFinite(dropV)) {
          sum -= dropV;
          sumsq -= dropV ** 2;
          count -= 1;
        }
      }
    }
    const mu = count >= minObs ? sum / count : null;
    const varPop = count >= minObs && count > 0 ? Math.max(0, sumsq / count - mu * mu) : null;
    const sigma = varPop === null || varPop === 0 ? null : Math.sqrt(varPop);
    const z = mu === null || sigma === null ? null : (Number(rows[t].br) - mu) / sigma;
    out[t] = {
      date: rows[t].date,
      br: rows[t].br,
      mu: mu === null ? null : Math.round(mu * 1e12) / 1e12,
      sigma: sigma === null ? null : Math.round(sigma * 1e12) / 1e12,
      z: z === null ? null : Math.round(z * 1e9) / 1e9,
    };
  }
  return out;
}

// FS-02 F3 信号 + F2 确认门（连续 3 日 |z| 递增 = 加速走扩，放弃信号）
function basisSignal(zSeries, { threshold = 1.5 } = {}) {
  return zSeries.map((row, t) => {
    if (row.z === null) return { ...row, signal: 0, accelerating: false };
    const signal = row.z <= -threshold ? 1 : row.z >= threshold ? -1 : 0;
    const accelerating =
      t >= 2 &&
      zSeries[t - 2].z !== null &&
      Math.abs(row.z) > Math.abs(zSeries[t - 1].z) &&
      Math.abs(zSeries[t - 1].z) > Math.abs(zSeries[t - 2].z);
    return { ...row, signal, accelerating };
  });
}

module.exports = { BASIS_DIR, loadManifest, loadBasisHistory, loadBasisSummary, basisZSeries, basisSignal };
