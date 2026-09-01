import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

describe('filter triage（三问分诊）', () => {
  let tmp;
  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-filter-triage-'));
    process.env.FUTURES_RUNTIME_ROOT = tmp;
  });
  after(() => {
    delete process.env.FUTURES_RUNTIME_ROOT;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function makeRun(id, filtered) {
    const dir = path.join(tmp, 'runs', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'filtered-hard.json'), JSON.stringify({
      meta: { runId: id },
      passed: [{ symbol: 'RM0' }, { symbol: 'SF0' }, { symbol: 'FG0' }, { symbol: 'RB0' }],
      rejected: [{ symbol: 'T0', reason: 'tombstone' }]
    }));
    fs.writeFileSync(path.join(dir, 'filtered.json'), JSON.stringify(filtered));
  }

  it('合法初筛输出通过四条硬约束', () => {
    const { validate } = require('../filter/filter-validate.cjs');
    makeRun('ok-run', {
      meta: { runId: 'ok-run' },
      candidates: [
        { symbol: 'RM0', directionHint: 'bullish', decision: 'KEEP', confidence: 'medium', reason: '行情+线索', informationGap: '待查' }
      ],
      downgraded: [
        { symbol: 'SF0', reason: '无', informationGap: '无' },
        { symbol: 'FG0', reason: '无', informationGap: '无' },
        { symbol: 'RB0', reason: '无', informationGap: '无' }
      ]
    });
    const r = validate('ok-run');
    assert.equal(r.ok, true);
    assert.equal(r.keepCount, 1);
  });

  it('墓碑复活 / KEEP超3 / 缺reason或gap / 赔率字段 → 失败', () => {
    const { validate } = require('../filter/filter-validate.cjs');
    makeRun('bad-tomb', {
      meta: { runId: 'bad-tomb' },
      candidates: [{ symbol: 'T0', directionHint: 'bearish', decision: 'KEEP', confidence: 'low', reason: 'x', informationGap: 'y' }],
      downgraded: []
    });
    assert.equal(validate('bad-tomb').ok, false);

    makeRun('bad-many', {
      meta: { runId: 'bad-many' },
      candidates: ['RM0', 'SF0', 'FG0', 'RB0'].map((s) => ({ symbol: s, directionHint: 'bullish', decision: 'KEEP', confidence: 'medium', reason: 'x', informationGap: 'y' })),
      downgraded: []
    });
    assert.match(validate('bad-many').errors.join('|'), /KEEP 数量/);

    makeRun('bad-fields', {
      meta: { runId: 'bad-fields' },
      candidates: [{ symbol: 'RM0', directionHint: 'bullish', decision: 'KEEP', confidence: 'medium' }],
      downgraded: []
    });
    assert.equal(validate('bad-fields').ok, false);

    makeRun('bad-odds', {
      meta: { runId: 'bad-odds' },
      candidates: [{ symbol: 'RM0', directionHint: 'bullish', decision: 'KEEP', confidence: 'medium', reason: 'x', informationGap: 'y', odds: { longCase: ['x'] } }],
      downgraded: []
    });
    assert.match(validate('bad-odds').errors.join('|'), /禁止输出赔率/);
  });
});
