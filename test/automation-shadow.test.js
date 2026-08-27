import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(__dirname, '..');
const RAW_FIXTURE = path.join(SKILL_ROOT, 'reasoning', 'test', 'fixtures', 'raw-rb0-20260805.json');

describe('P2 conservative automation (shadow / prefill)', () => {
  let runDir;

  before(() => {
    runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'futures-radar-p2-'));
    fs.copyFileSync(RAW_FIXTURE, path.join(runDir, 'raw.json'));
    const scan = spawnSync(process.execPath, [path.join(SKILL_ROOT, 'scanner', 'index.cjs'), '--runId', 'p2-golden', '--runDir', runDir], { encoding: 'utf8', timeout: 30000 });
    assert.equal(scan.status, 0);
    const hard = spawnSync(process.execPath, [path.join(SKILL_ROOT, 'filter', 'hard-filter.cjs'), '--runId', 'p2-golden', '--runDir', runDir], { encoding: 'utf8', timeout: 30000 });
    assert.equal(hard.status, 0);

    // 模拟 LLM 已经产出的 filtered.json，shadow 绝不能覆盖它
    const llmFiltered = {
      meta: { runId: 'p2-golden', filteredAt: '2026-08-27T00:00:00.000Z', inputCount: 1, outputCount: 1, hardFilterRejectsImmutable: true },
      candidates: [{ symbol: 'RB0', name: '螺纹钢', rank: 1, score: 0.69, decision: 'KEEP', confidence: 'low', directionBias: 'neutral', criteria: {}, summary: 'LLM marker' }],
      downgraded: []
    };
    fs.writeFileSync(path.join(runDir, 'filtered.json'), JSON.stringify(llmFiltered));
  });

  after(() => {
    fs.rmSync(runDir, { recursive: true, force: true });
  });

  it('quantitative-filter --shadow 只写 filtered.quant.json，不覆盖 LLM filtered.json', () => {
    const beforeContent = fs.readFileSync(path.join(runDir, 'filtered.json'), 'utf8');
    const res = spawnSync(process.execPath, [path.join(SKILL_ROOT, 'filter', 'quantitative-filter.cjs'), '--runId', 'p2-golden', '--runDir', runDir, '--shadow'], { encoding: 'utf8', timeout: 30000 });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.ok(fs.existsSync(path.join(runDir, 'filtered.quant.json')));
    assert.equal(fs.readFileSync(path.join(runDir, 'filtered.json'), 'utf8'), beforeContent);
    const quant = JSON.parse(fs.readFileSync(path.join(runDir, 'filtered.quant.json'), 'utf8'));
    assert.equal(quant.meta.mode, 'shadow');
  });

  it('prefill-analysis 只生成 analysis.draft.json，且 Q1/Q4/Q5 保持 pending', () => {
    const res = spawnSync(process.execPath, [path.join(SKILL_ROOT, 'analyze', 'prefill-analysis.cjs'), '--runId', 'p2-golden', '--runDir', runDir], { encoding: 'utf8', timeout: 30000 });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.ok(fs.existsSync(path.join(runDir, 'analysis.draft.json')));
    assert.equal(fs.existsSync(path.join(runDir, 'analysis.json')), false);
    const draft = JSON.parse(fs.readFileSync(path.join(runDir, 'analysis.draft.json'), 'utf8'));
    assert.equal(draft.meta.mode, 'draft');
    assert.equal(draft.analyses.length, 1);
    assert.equal(draft.analyses[0].q1_driver._pending, true);
    assert.equal(draft.analyses[0].q4_confirmation._pending, true);
    assert.equal(draft.analyses[0].q5_invalidation._pending, true);
  });
});
