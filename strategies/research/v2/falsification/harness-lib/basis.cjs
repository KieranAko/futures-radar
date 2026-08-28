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

module.exports = { BASIS_DIR, loadManifest, loadBasisHistory, loadBasisSummary };
