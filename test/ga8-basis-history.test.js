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
});
