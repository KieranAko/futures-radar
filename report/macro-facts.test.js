/**
 * report/macro-facts.test.js — Stage 5A 宏观集成测试
 *
 * 验收口径：
 * 6. 报告数值与 macro-snapshot.json 一致（原样透传，不重算）
 * 7. 旧 run 没有宏观快照时仍可读取，显示宏观数据不可用
 * 8. 原有扫描和报告结果除新增展示外不发生变化
 *
 * 通过子进程运行 build-facts.cjs（与管道同路径），环境变量
 * FUTURES_RUNTIME_ROOT 指向临时目录。
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
const buildFactsPath = path.join(skillRoot, 'report', 'build-facts.cjs');
const buildFacts = require(buildFactsPath); // 有 require.main 守卫，require 不执行 main

const RUN_ID = 'MACRO-FACTS-RUN';

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'macro-facts-test-'));
}

function writeRunArtifacts(runDir, { withMacro } = {}) {
  fs.mkdirSync(runDir, { recursive: true });

  const candidates = {
    meta: { runId: RUN_ID, scannedAt: '2026-08-26T06:00:00Z', preFilter: { total: 59 } },
    candidates: [
      {
        rank: 1, symbol: 'AU0', name: '黄金', exchange: 'SHFE', sector: 'precious', score: 85.5,
        indicators: { atr5: 12.3, atrPct: 2.1, hv5: 20.1, hv20: 15.2, volPercentile: 88, volMultiplier: 1.5, change5d: 1.8 },
        trend: { close: 1045, vsMA20: 2.1, vsMA60: 4.5, direction: 'up' },
        liquidity: { avgVolume5d: 300000, avgTurnover5d: 3.1e10, avgOI5d: 200000 },
      },
    ],
  };

  const filtered = {
    meta: { runId: RUN_ID, filteredAt: '2026-08-26T06:30:00Z' },
    candidates: [
      {
        symbol: 'AU0', confidence: 'high', directionBias: 'bullish',
        criteria: { hv: true }, summary: '高波动', watchConditions: ['量能'],
      },
    ],
    downgraded: [{ symbol: 'MA0', reason: '低置信', note: '' }],
  };

  const probability = {
    meta: { runId: RUN_ID, calculatedAt: '2026-08-26T06:45:00Z' },
    probabilities: [
      {
        symbol: 'AU0', close: 1045,
        hv: { annual: 0.21, periodDays: 20, percentile90d: 90, estimator: 'yang-zhang', correctionCount: 0, totalBars: 20, degraded: false },
        cone: {
          '3d': { p68: [1020, 1070], p95: [1000, 1090] },
          '5d': { p68: [1010, 1080], p95: [990, 1100] },
        },
        atrComparison: { atr5: 12.3, atr2xBand: [1020.4, 1069.6], divergencePct: 5.2, interpretation: '一致' },
      },
    ],
  };

  fs.writeFileSync(path.join(runDir, 'candidates.json'), JSON.stringify(candidates, null, 2));
  fs.writeFileSync(path.join(runDir, 'filtered.json'), JSON.stringify(filtered, null, 2));
  fs.writeFileSync(path.join(runDir, 'probability.json'), JSON.stringify(probability, null, 2));

  if (withMacro) {
    const snapshot = {
      meta: {
        runId: RUN_ID, signalDate: '2026-08-25',
        snapshotFrozenAt: '2026-08-26T06:00:00Z', marketCutoffAt: '2026-08-25',
        schemaVersion: '1.0.0',
      },
      indicators: {
        DXY: { value: 98.9172, change5d: -0.1, asOf: '2026-08-25', fetchedAt: '2026-08-26T05:59:00Z', source: 'sina', status: 'fresh', _timestamp_origin: 'observed' },
        USDCNH: { value: 6.7167, change5d: 0.05, asOf: '2026-08-25', fetchedAt: '2026-08-26T05:59:00Z', source: 'sina', status: 'fresh', _timestamp_origin: 'observed' },
        US10Y: { value: 4.64, change5d: 0.43, asOf: '2026-08-25', fetchedAt: '2026-08-26T05:59:00Z', source: 'akshare', status: 'fresh', _timestamp_origin: 'observed' },
        DR007: { status: 'missing', reason: 'chinamoney timeout', fetchedAt: '2026-08-26T05:59:00Z', source: 'akshare', _timestamp_origin: 'observed' },
        SC0: { value: 584.1, change5d: -0.12, asOf: '2026-08-25', fetchedAt: '2026-08-26T05:41:57Z', source: 'raw.json', status: 'fresh', _timestamp_origin: 'observed' },
      },
      quality: { available: 4, missing: 1, eligible: true },
    };
    fs.writeFileSync(path.join(runDir, 'macro-snapshot.json'), JSON.stringify(snapshot, null, 2));
  }
}

function runBuildFacts(tmpRoot) {
  return spawnSync(process.execPath, [buildFactsPath, '--runId', RUN_ID], {
    encoding: 'utf8',
    env: { ...process.env, FUTURES_RUNTIME_ROOT: tmpRoot },
    timeout: 30000,
    windowsHide: true,
  });
}

describe('relevantAnchorsFor（传导路由）', () => {
  it('AU0 → DXY/US10Y；MA0 → SC0/DXY/USDCNH；RB0 → DR007', () => {
    assert.deepStrictEqual(buildFacts.relevantAnchorsFor('AU0'), ['DXY', 'US10Y']);
    assert.deepStrictEqual(buildFacts.relevantAnchorsFor('MA0'), ['SC0', 'DXY', 'USDCNH']);
    assert.deepStrictEqual(buildFacts.relevantAnchorsFor('RB0'), ['DR007']);
  });

  it('未命中前缀 → 空集（苹果/生猪/碳酸锂/集运/金融）', () => {
    for (const sym of ['AP0', 'LH0', 'LC0', 'EC0', 'IF0', 'SS0']) {
      assert.deepStrictEqual(buildFacts.relevantAnchorsFor(sym), [], `${sym} 应为空集`);
    }
  });

  it('首个命中生效（SA0 命中 DR007 规则而非能化规则）', () => {
    assert.deepStrictEqual(buildFacts.relevantAnchorsFor('SA0'), ['DR007']);
  });
});

describe('Stage 5A 宏观集成（子进程，与管道同路径）', () => {
  it('有 macro-snapshot.json：macro.available=true，数值原样透传，候选带相关锚点', () => {
    const tmp = makeTempRoot();
    writeRunArtifacts(path.join(tmp, 'runs', RUN_ID), { withMacro: true });
    const res = runBuildFacts(tmp);
    assert.strictEqual(res.status, 0, `build-facts exit ${res.status}: ${res.stderr}`);

    const facts = JSON.parse(fs.readFileSync(path.join(tmp, 'runs', RUN_ID, 'report-facts.json'), 'utf8'));
    assert.strictEqual(facts.macro.available, true);
    // 验收 6：报告数值与 macro-snapshot.json 一致（原样透传）
    assert.strictEqual(facts.macro.indicators.DXY.value, 98.9172);
    assert.strictEqual(facts.macro.indicators.US10Y.value, 4.64);
    assert.strictEqual(facts.macro.indicators.SC0.value, 584.1);
    assert.strictEqual(facts.macro.indicators.DR007.status, 'missing');
    assert.strictEqual(facts.macro.quality.available, 4);
    // 每个候选只显示自己相关的锚点
    assert.deepStrictEqual(facts.macro.relevance['AU0'], ['DXY', 'US10Y']);
    // 展示层信息（label/unit/decimals）由 5A 一次性注入，5C 不读配置
    assert.strictEqual(facts.macro.display.DXY.label, '美元指数');
    assert.strictEqual(typeof facts.macro.display.DXY.decimals, 'number');
    // 回归：机会层数值不受宏观段影响
    assert.strictEqual(facts.opportunities[0].marketFacts.close, 1045);
    assert.strictEqual(facts.opportunities.length, 1);
    assert.strictEqual(facts.rejected.length, 1);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('无 macro-snapshot.json（旧 run）：macro.available=false，其余结果不变', () => {
    const tmp = makeTempRoot();
    writeRunArtifacts(path.join(tmp, 'runs', RUN_ID), { withMacro: false });
    const res = runBuildFacts(tmp);
    assert.strictEqual(res.status, 0, `build-facts exit ${res.status}: ${res.stderr}`);

    const facts = JSON.parse(fs.readFileSync(path.join(tmp, 'runs', RUN_ID, 'report-facts.json'), 'utf8'));
    assert.strictEqual(facts.macro.available, false);
    assert.strictEqual(facts.opportunities[0].marketFacts.close, 1045);
    assert.strictEqual(facts.screening.top10.length, 1);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('有快照但 runId 与管道不一致：仍透传指标但标记不可用（不阻断报告）', () => {
    const tmp = makeTempRoot();
    writeRunArtifacts(path.join(tmp, 'runs', RUN_ID), { withMacro: true });
    const snapPath = path.join(tmp, 'runs', RUN_ID, 'macro-snapshot.json');
    const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
    snap.meta.runId = 'OTHER-RUN';
    fs.writeFileSync(snapPath, JSON.stringify(snap, null, 2));

    const res = runBuildFacts(tmp);
    assert.strictEqual(res.status, 0);
    const facts = JSON.parse(fs.readFileSync(path.join(tmp, 'runs', RUN_ID, 'report-facts.json'), 'utf8'));
    assert.strictEqual(facts.macro.available, false);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('可解析但 schema 损坏的快照（缺锚点）：fail closed，available=false，机会层不变', () => {
    const tmp = makeTempRoot();
    writeRunArtifacts(path.join(tmp, 'runs', RUN_ID), { withMacro: true });
    const snapPath = path.join(tmp, 'runs', RUN_ID, 'macro-snapshot.json');
    const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
    delete snap.indicators.DXY;
    snap.quality = { available: 3, missing: 1, eligible: true };
    fs.writeFileSync(snapPath, JSON.stringify(snap, null, 2));

    const res = runBuildFacts(tmp);
    assert.strictEqual(res.status, 0);
    const facts = JSON.parse(fs.readFileSync(path.join(tmp, 'runs', RUN_ID, 'report-facts.json'), 'utf8'));
    assert.strictEqual(facts.macro.available, false);
    assert.ok(facts.macro.reason.includes('validation'), facts.macro.reason);
    assert.strictEqual(facts.opportunities[0].marketFacts.close, 1045);
    assert.strictEqual(facts.opportunities.length, 1);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
