import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

describe('V9 experiment integrity reclassification', () => {
  it('library strategies carry evidence tiers and adapter fidelity blocking flags', () => {
    const j = require(path.join(ROOT, 'strategies', 'strategy-library-v2.json'));
    const count = {};
    for (const s of j.strategies) {
      count[s.evidenceTier] = (count[s.evidenceTier] || 0) + 1;
      assert.ok(s.fidelityAudit && typeof s.fidelityAudit.blockingForFalsification === 'boolean', s.id);
      if (s.fidelityAudit.status === 'closed_no_rerun') {
        // 实验线关闭：不产生新证伪结论，也不需要保真复跑
        assert.equal(s.fidelityAudit.blockingForFalsification, false, s.id);
      } else if (s.fidelityAudit.status === 'needs_rework') {
        // 保真度前置未过：继续阻塞新 retired/suspended 结论
        assert.equal(s.fidelityAudit.blockingForFalsification, true, s.id);
      }
    }
    assert.equal(count.falsified, 2);
    assert.equal(count.not_evaluable, 4);
    assert.equal(count.untested, 1);
    assert.equal(count.insufficient_sample, 1);
    assert.equal(j.experimentIntegrity.rule.length > 0, true);
  });

  it('V9 theory-source probes are voided and cannot drive V10', () => {
    const p = path.join(ROOT, 'strategies', 'research', 'v2', 'falsification', '22-v9-theory-source-probes.json');
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.equal(j.voided, true);
    assert.match(j.voidedReason, /未与 strategy-library-v2/);
  });

  it('fidelity and pre-registration protocol documents exist', () => {
    assert.ok(fs.existsSync(path.join(ROOT, 'strategies', 'research', 'v2', 'falsification', '23-fidelity-review.md')));
    assert.ok(fs.existsSync(path.join(ROOT, 'strategies', 'research', 'v2', 'falsification', '24-preregistration-protocol.md')));
  });
});
