import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const CHAIN_ID = 'CH-BLACK-20260918-01';

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function runCli(script, args, env) {
  const res = spawnSync('node', [path.join(ROOT, script), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 60000,
  });
  assert.equal(res.status, 0, `${script} failed:\n${res.stderr || res.stdout}`);
  return res.stdout;
}

describe('story-lineage V2 前向盖章（filtered → report → analysis）', () => {
  it('storyChainId 从 filtered 前向传播到 report-facts 与 report-model', () => {
    const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'story-lineage-'));
    const runDir = path.join(runtime, 'runs', 'r1');
    try {
      writeJson(path.join(runDir, 'candidates.json'), {
        meta: { runId: 'r1', scannedAt: '2026-09-17T00:00:00Z' },
        preFilter: { total: 1 },
        candidates: [{
          symbol: 'RB0', name: '螺纹钢', exchange: 'shfe', sector: 'black', rank: 1, score: 1,
          indicators: { atr5: 5, atrPct: 1, hv5: 20, hv20: 20, volPercentile: 50, volMultiplier: 1, change5d: 1 },
          trend: { close: 100, vsMA20: 1, vsMA60: 2, direction: 'up' },
          liquidity: { avgVolume5d: 100, avgTurnover5d: 1000, avgOI5d: 10 },
        }],
      });
      writeJson(path.join(runDir, 'filtered.json'), {
        meta: { runId: 'r1', filteredAt: '2026-09-17T00:00:00Z' },
        candidates: [{
          symbol: 'RB0', rank: 1, directionHint: 'bullish', directionBias: 'bullish',
          decision: 'KEEP', confidence: 'medium', reason: '故事席位', informationGap: '需深挖',
          storyChainId: CHAIN_ID, tracking: true, summary: 's', watchConditions: 'w', criteria: {},
        }],
        downgraded: [],
      });
      writeJson(path.join(runDir, 'probability.json'), {
        meta: { runId: 'r1', calculatedAt: '2026-09-17T00:00:00Z' },
        probabilities: [{
          symbol: 'RB0', close: 100,
          hv: { annual: 20, periodDays: 20, percentile90d: 50, estimator: 'yang_zhang', correctionCount: 0, totalBars: 100, degraded: false },
          volatilityRegime: null, intervalModels: null, currentState: null, referenceInterval: null,
          cone: {
            '3d': { p68: [98, 102], p95: [96, 104] },
            '5d': { p68: [96, 104], p95: [92, 108] },
          },
          atrComparison: { atr5: 5, atr2xBand: [90, 110], divergencePct: 1, interpretation: 'ok' },
        }],
      });
      writeJson(path.join(runDir, 'analysis.json'), {
        meta: { runId: 'r1', analyzedAt: '2026-09-17T00:00:00Z', candidateCount: 1 },
        analyses: [{
          symbol: 'RB0', storyChainId: CHAIN_ID, direction: 'bullish', confidence: 'medium',
          q1_driver: { primary: 'p', secondary: 's', evidence: 'e', source: 's' },
          q2_trendOrImpulse: { assessment: 'a' },
          q3_odds: { bias: 'bullish', reasoning: 'r' },
          q4_confirmation: { signals: ['x'] },
          q5_invalidation: { conditions: ['y'] },
          q6_risks: { items: ['z'] },
        }],
      });

      const env = { FUTURES_RUNTIME_ROOT: runtime };
      runCli('analysis/assembly/build-facts.cjs', ['--runId', 'r1'], env);
      const facts = JSON.parse(fs.readFileSync(path.join(runDir, 'report-facts.json'), 'utf8'));
      assert.equal(facts.opportunities[0].storyChainId, CHAIN_ID);

      runCli('analysis/assembly/build-model.cjs', ['--runId', 'r1'], env);
      const model = JSON.parse(fs.readFileSync(path.join(runDir, 'report-model.json'), 'utf8'));
      assert.equal(model.opportunities[0].storyChainId, CHAIN_ID);
    } finally {
      fs.rmSync(runtime, { recursive: true, force: true });
    }
  });

  it('strategy-plan schema 允许可选 storyChainId 前向盖章', () => {
    const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'analysis', 'strategy', 'strategy-plan.schema.json'), 'utf8'));
    assert.deepEqual(schema.definitions.plan.properties.storyChainId.type, ['string', 'null']);
  });
});
