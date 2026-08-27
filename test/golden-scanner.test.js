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
const GOLDEN = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'golden', 'scanner-rb0.json'), 'utf8')
);

/**
 * P0 golden 基线：scanner 对同一份冻结 raw 夹具的输出必须逐字段一致。
 * 该测试用于保护后续 data-store / 指标库 / 目录重构不改变扫描结果。
 */
describe('golden scanner baseline (RB0 fixture)', () => {
  let runDir;

  before(() => {
    runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'futures-radar-golden-'));
    fs.copyFileSync(RAW_FIXTURE, path.join(runDir, 'raw.json'));
  });

  after(() => {
    fs.rmSync(runDir, { recursive: true, force: true });
  });

  it('scanner output matches frozen golden artifact', () => {
    const res = spawnSync(
      process.execPath,
      [path.join(SKILL_ROOT, 'scanner', 'index.cjs'), '--runId', 'golden', '--runDir', runDir],
      { encoding: 'utf8', timeout: 30000 }
    );

    assert.equal(res.status, 0, `scanner failed:\n${res.stdout}\n${res.stderr}`);

    const candidatesPath = path.join(runDir, 'candidates.json');
    assert.ok(fs.existsSync(candidatesPath), 'candidates.json missing');

    const actual = JSON.parse(fs.readFileSync(candidatesPath, 'utf8'));

    // meta.scannedAt 天然不可复现，其余全部字段必须一致
    assert.deepEqual(actual.meta.pipelineVersion, GOLDEN.pipelineVersion);
    assert.deepEqual(actual.meta.preFilter, GOLDEN.preFilter);
    assert.deepEqual(actual.meta.scoring, GOLDEN.scoring);
    assert.deepEqual(actual.candidates, GOLDEN.candidates);
  });
});
