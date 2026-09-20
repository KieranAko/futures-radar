/**
 * test/story-filtered-candidates.test.js — V2 故事席位 candidates.json 创建/修补
 *
 * 背景：V2 中波动率扫描退役，candidates.json 不再来自 scanner。
 * 故事池重写 filtered.json 时，若 run 目录还没有 candidates.json，
 * 必须由故事席位创建（否则 build-facts 的 symbol join 会失败）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { patchCandidatesFile } = require('../stories/seats/build-filtered-from-story-pool.cjs');

describe('story-filtered candidates.json 创建/修补', () => {
  it('candidates.json 不存在时，用故事席位创建候选文件', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'story-filtered-'));
    try {
      const p = path.join(tmp, 'candidates.json');
      const entries = [{
        symbol: 'RB0',
        storyChainId: 'CH-TEST-01',
        signalId: null,
      }];
      patchCandidatesFile(p, entries, {}, 'r-test');
      assert.ok(fs.existsSync(p));
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      assert.equal(j.meta.runId, 'r-test');
      assert.equal(j.candidates.length, 1);
      assert.equal(j.candidates[0].symbol, 'RB0');
      assert.equal(j.candidates[0].storyChainId, 'CH-TEST-01');
      assert.equal(j.candidates[0].tracking, true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('candidates.json 已存在时，补齐席位并保留既有 meta.runId', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'story-filtered-'));
    try {
      const p = path.join(tmp, 'candidates.json');
      fs.writeFileSync(p, JSON.stringify({ meta: { runId: 'r-old' }, candidates: [] }), 'utf8');
      patchCandidatesFile(p, [{ symbol: 'RB0', storyChainId: 'CH-TEST-01', signalId: null }], {}, 'r-new');
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      assert.equal(j.meta.runId, 'r-old');
      assert.equal(j.candidates.length, 1);
      assert.equal(j.candidates[0].symbol, 'RB0');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
