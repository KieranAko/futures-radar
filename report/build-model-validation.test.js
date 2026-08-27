/**
 * report/build-model-validation.test.js — Stage 5B 方向字段契约校验（P2）
 *
 * P2 背景：analysis.json 由 LLM 按 analyze/blueprint.md 手写六问，
 * direction/q3_odds.bias 契约值为 bullish|bearish|neutral；filtered.json
 * 的 directionBias 同口径（经 report-facts screening.initialDirection
 * 进入 5B）。20260826-0908/1341 两轮均出现六问写入 FinCoT 原始词汇
 * （long/short/pass）→ build-model 透传 → render-markdown 静默渲染 '—'。
 *
 * 验收：5B 边界对三字段做 canonical 校验，非 canonical 值响亮报错
 * （FATAL + exit 1），不进入透传；null（无方向合法态）放行。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { skillRoot } = require('../lib/workspace.cjs');
const buildModelPath = path.join(skillRoot, 'report', 'build-model.cjs');

const RUN_ID = 'BUILD-MODEL-VALIDATION-RUN';

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'build-model-validation-'));
}

function writeRunArtifacts(runDir, { direction, bias, initialDirection }) {
  fs.mkdirSync(runDir, { recursive: true });

  const reportFacts = {
    meta: { runId: RUN_ID, signalDate: '2026-08-25' },
    screening: { top10: [], decisions: [] },
    rejected: [],
    macro: { available: false },
    opportunities: [
      {
        symbol: 'AU0', name: '黄金', rank: 1,
        marketFacts: {}, priceRanges: {},
        screening: { initialDirection, initialConfidence: 'medium' },
      },
    ],
  };

  const analysis = {
    meta: { runId: RUN_ID },
    analyses: [
      {
        symbol: 'AU0',
        q1_driver: { primary: '宏观', secondary: '', evidence: 'e', source: 's' },
        q2_trendOrImpulse: { assessment: 'a' },
        q3_odds: { bias, reasoning: 'r', longCase: [], shortCase: [] },
        q4_confirmation: { signals: [] },
        q5_invalidation: { conditions: [] },
        q6_risks: { items: [] },
        direction,
        confidence: 'medium',
      },
    ],
  };

  fs.writeFileSync(path.join(runDir, 'report-facts.json'), JSON.stringify(reportFacts, null, 2));
  fs.writeFileSync(path.join(runDir, 'analysis.json'), JSON.stringify(analysis, null, 2));
}

function runBuildModel(tmpRoot) {
  return spawnSync(process.execPath, [buildModelPath, '--runId', RUN_ID], {
    encoding: 'utf8',
    env: { ...process.env, FUTURES_RUNTIME_ROOT: tmpRoot },
    timeout: 30000,
    windowsHide: true,
  });
}

describe('Stage 5B 方向字段 canonical 校验（P2 fail loud）', () => {
  it('canonical 值（bullish/bearish/neutral）全部放行并产出 report-model.json', () => {
    const tmp = makeTempRoot();
    writeRunArtifacts(path.join(tmp, 'runs', RUN_ID), {
      direction: 'bullish', bias: 'neutral', initialDirection: 'bearish',
    });
    const res = runBuildModel(tmp);
    assert.strictEqual(res.status, 0, `build-model exit ${res.status}: ${res.stderr}`);
    const model = JSON.parse(fs.readFileSync(path.join(tmp, 'runs', RUN_ID, 'report-model.json'), 'utf8'));
    assert.strictEqual(model.opportunities[0].thesis.finalDirection, 'bullish');
    assert.strictEqual(model.opportunities[0].thesis.odds.bias, 'neutral');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('screening.initialDirection 为 null（无方向合法态）放行', () => {
    const tmp = makeTempRoot();
    writeRunArtifacts(path.join(tmp, 'runs', RUN_ID), {
      direction: 'neutral', bias: 'neutral', initialDirection: null,
    });
    const res = runBuildModel(tmp);
    assert.strictEqual(res.status, 0, `build-model exit ${res.status}: ${res.stderr}`);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('analysis.json direction 为 FinCoT 原始词汇（long）→ FATAL，不透传', () => {
    const tmp = makeTempRoot();
    writeRunArtifacts(path.join(tmp, 'runs', RUN_ID), {
      direction: 'long', bias: 'neutral', initialDirection: 'bullish',
    });
    const res = runBuildModel(tmp);
    assert.strictEqual(res.status, 1, `expected FATAL exit 1, got ${res.status}`);
    assert.match(res.stderr, /AU0/, 'stderr 应指明出错品种');
    assert.match(res.stderr, /direction/, 'stderr 应指明字段');
    assert.ok(!fs.existsSync(path.join(tmp, 'runs', RUN_ID, 'report-model.json')), '不应产出 report-model.json');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('analysis.json direction 为 pass → FATAL', () => {
    const tmp = makeTempRoot();
    writeRunArtifacts(path.join(tmp, 'runs', RUN_ID), {
      direction: 'pass', bias: 'neutral', initialDirection: 'bullish',
    });
    const res = runBuildModel(tmp);
    assert.strictEqual(res.status, 1, `expected FATAL exit 1, got ${res.status}`);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('analysis.json q3_odds.bias 为 short → FATAL', () => {
    const tmp = makeTempRoot();
    writeRunArtifacts(path.join(tmp, 'runs', RUN_ID), {
      direction: 'bullish', bias: 'short', initialDirection: 'bullish',
    });
    const res = runBuildModel(tmp);
    assert.strictEqual(res.status, 1, `expected FATAL exit 1, got ${res.status}`);
    assert.match(res.stderr, /bias/, 'stderr 应指明 bias 字段');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('screening.initialDirection 为非 canonical 字符串 → FATAL', () => {
    const tmp = makeTempRoot();
    writeRunArtifacts(path.join(tmp, 'runs', RUN_ID), {
      direction: 'bullish', bias: 'neutral', initialDirection: 'long',
    });
    const res = runBuildModel(tmp);
    assert.strictEqual(res.status, 1, `expected FATAL exit 1, got ${res.status}`);
    assert.match(res.stderr, /initialDirection/, 'stderr 应指明字段');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('空字符串/大小写变体等任意非 canonical → FATAL', () => {
    for (const bad of ['', 'UP', 'Bullish']) {
      const tmp = makeTempRoot();
      writeRunArtifacts(path.join(tmp, 'runs', RUN_ID), {
        direction: bad, bias: 'neutral', initialDirection: 'bullish',
      });
      const res = runBuildModel(tmp);
      assert.strictEqual(res.status, 1, `direction=${JSON.stringify(bad)} 应 FATAL, got ${res.status}`);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
