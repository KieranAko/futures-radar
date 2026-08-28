import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const FALS = path.join(ROOT, 'strategies', 'research', 'v2', 'falsification');
const COLLECTOR = path.join(FALS, 'ga8-basis-history-collector.py');
const STORE = path.join(FALS, 'data', 'basis-history');

describe('GA-8 FS-02 PIT basis-history collector', () => {
  it('collector exists and encodes the FS-02 rate convention and weekly slices', () => {
    assert.ok(fs.existsSync(COLLECTOR));
    const src = fs.readFileSync(COLLECTOR, 'utf8');
    assert.match(src, /br = \(S - F\) \/ S/);
    assert.match(src, /-dom_basis_rate/);
    assert.match(src, /SLICE_DAYS\s*=\s*7/);
    assert.match(src, /fetchedAt/);
    assert.match(src, /revisions\.jsonl/);
  });

  it('manifest documents the universe and PIT discipline', () => {
    const p = path.join(STORE, 'manifest.json');
    if (!fs.existsSync(p)) return;
    const m = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.equal(m.schema, 'futures-radar-basis-history-manifest/1');
    assert.ok(m.universe.length > 0);
    assert.match(m.rateConvention, /br = \(S - F\) \/ S/);
    assert.match(m.pitDiscipline, /fetchedAt/);
  });

  it('basis rows satisfy br = -dom_basis_rate and ascend strictly', () => {
    const p = path.join(STORE, 'RB.jsonl');
    if (!fs.existsSync(p)) return;
    const rows = fs.readFileSync(p, 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
    assert.ok(rows.length > 0);
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      assert.equal(r.libSymbol, 'RB0');
      assert.ok(r.date >= '2011-01-01');
      if (r.br !== null && r.domBasisRate !== null) {
        assert.ok(Math.abs(r.br - Math.round(-r.domBasisRate * 1e12) / 1e12) < 1e-9, `${r.date} br mismatch`);
      }
      if (i > 0) assert.ok(rows[i - 1].date < r.date, `${r.date} not ascending`);
    }
  });

  it('harness loader can read the GA-8 store when present', () => {
    const p = path.join(STORE, 'manifest.json');
    if (!fs.existsSync(p)) return;
    const basis = require(path.join(FALS, 'harness-lib', 'basis.cjs'));
    const rb = basis.loadBasisHistory('RB0');
    assert.equal(rb.libSymbol, 'RB0');
    assert.ok(Array.isArray(rb.rows));
    assert.ok(rb.rows.every((r) => r.symbol === 'RB'));
  });

  it('FS-02 F2 rolling z anchor is PIT (excludes signal day) and F3 signal is bound', () => {
    const basis = require(path.join(FALS, 'harness-lib', 'basis.cjs'));
    const rows = [];
    for (let i = 0; i < 220; i++) {
      rows.push({ date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`, br: 0.01 + ((i % 7) - 3) * 0.0005, libSymbol: 'RB0' });
    }
    rows[219].br = 0.04; // 信号日极端值不进入自身锚
    const zs = basis.basisZSeries(rows, { window: 180, minObs: 180 });
    // 前 180 个观测进入第 181 个 anchor（t=180）
    assert.equal(zs[179].z, null);
    assert.ok(zs[180].z !== null);
    // t=219 的锚 = rows[39..218]（不含 219 的 0.04）
    const windowRows = rows.slice(39, 219).map((r) => r.br);
    const mu = windowRows.reduce((a, b) => a + b, 0) / windowRows.length;
    const sigma = Math.sqrt(windowRows.reduce((a, b) => a + (b - mu) ** 2, 0) / windowRows.length);
    assert.equal(zs[219].mu, Math.round(mu * 1e12) / 1e12);
    assert.equal(zs[219].sigma, Math.round(sigma * 1e12) / 1e12);
    assert.equal(zs[219].z, Math.round((0.04 - mu) / sigma * 1e9) / 1e9);
    const sig = basis.basisSignal(zs, { threshold: 1.5 });
    assert.equal(sig[219].signal, -1); // z >= +1.5 → 空（比值偏高）
    assert.equal(sig[219].accelerating, false);
  });
});
