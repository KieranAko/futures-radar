/**
 * Mini Pipeline Reasoning Test
 * 验证 runMiniPipeline 可选 LLM replay 路径：
 * - 默认 off 完全保持旧行为
 * - 无 point-in-time packet → 工程诊断全 non_point_in_time，不标记 scored
 * - fixture packet + recorded provider → reasoning-replay.jsonl + llm-scorecard.json
 * - 不自动继续 LLM soft filter；不写 forward manifest/current.md
 */

const { describe, test, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { runMiniPipeline } = require('../mini-pipeline.cjs');
const { runtimeRoot } = require('../../../lib/workspace.cjs');

const BACKTEST_DIR = path.join(__dirname, '..');
const AS_OF_DATE = '2026-07-01';
const RUN_ID = `bt-${AS_OF_DATE.replace(/-/g, '')}`;
const RUN_DIR = path.join(BACKTEST_DIR, 'runs', RUN_ID);
const FIXTURES_DIR = path.join(BACKTEST_DIR, 'fixtures');
const FORWARD_MANIFEST = path.join(runtimeRoot, 'forward', 'manifest.json');
const CURRENT_MD = path.join(runtimeRoot, 'current.md');

// 20 个交易日：2026-06-22(周一) 起，'2026-07-01' 在 index 7
// T+1 open[8]=3000 入场，T+11 close[18]=3100 出场（无跳空，非涨跌停形态）
function makeWindowData() {
  const dates = [];
  const d = new Date('2026-06-22T00:00:00Z');
  while (dates.length < 20) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) dates.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  const n = dates.length;
  const close = Array.from({ length: n }, (_, i) => (i >= 18 ? 3100 : 3000));
  const open = [...close];
  const high = close.map((c) => +(c * 1.005).toFixed(2));
  const low = close.map((c) => +(c * 0.995).toFixed(2));
  const volume = Array.from({ length: n }, () => 500000);
  const openInterest = [...volume];

  return {
    meta: {
      slicedAt: '2026-07-01T16:00:00+08:00',
      symbolCount: 1,
      succeeded: 1,
      failed: 0,
      windowDays: n
    },
    contracts: {
      RB0: {
        symbol: 'RB0',
        name: '螺纹钢',
        exchange: 'SHFE',
        sector: 'black',
        multiplier: 10,
        ohlcv: { dates, open, high, low, close, settle: [...close], volume, openInterest }
      }
    }
  };
}

// Stage 3b/4 为 manual 边界：测试直接提供固定 fixture，避免网络与交互
function writeStageFixtures() {
  fs.rmSync(RUN_DIR, { recursive: true, force: true });
  fs.mkdirSync(RUN_DIR, { recursive: true });
  fs.writeFileSync(path.join(RUN_DIR, 'filtered.json'), JSON.stringify({ symbols: ['RB0'] }));
  fs.writeFileSync(path.join(RUN_DIR, 'analysis.json'), JSON.stringify({ runId: RUN_ID, analyses: [] }));
}

beforeEach(writeStageFixtures);

after(() => {
  fs.rmSync(RUN_DIR, { recursive: true, force: true });
});

describe('runMiniPipeline reasoningMode', () => {
  test('默认 off：旧行为不变，不产出 replay/scorecard 文件', async () => {
    const prediction = await runMiniPipeline(AS_OF_DATE, makeWindowData());

    assert.strictEqual(prediction.runId, RUN_ID);
    assert.strictEqual(prediction.asOfDate, AS_OF_DATE);
    assert.ok(Array.isArray(prediction.predictions));
    assert.ok(fs.existsSync(path.join(RUN_DIR, 'backtest-prediction.json')));
    assert.ok(!fs.existsSync(path.join(RUN_DIR, 'reasoning-replay.jsonl')));
    assert.ok(!fs.existsSync(path.join(RUN_DIR, 'llm-scorecard.json')));
  });

  test('reasoningMode 开启但无 point-in-time packet → 全 non_point_in_time，不标记 scored', async () => {
    await runMiniPipeline(AS_OF_DATE, makeWindowData(), { reasoningMode: 'recorded' });

    const replayPath = path.join(RUN_DIR, 'reasoning-replay.jsonl');
    assert.ok(fs.existsSync(replayPath), '工程诊断应产出 replay 文件');
    const rows = fs
      .readFileSync(replayPath, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    assert.ok(rows.length >= 1);
    for (const row of rows) {
      assert.strictEqual(row.scoringStatus, 'non_point_in_time');
      assert.strictEqual(row.outcome, null);
    }

    const scorecard = JSON.parse(
      fs.readFileSync(path.join(RUN_DIR, 'llm-scorecard.json'), 'utf8')
    );
    const s = scorecard.arms.fincot;
    assert.strictEqual(s.candidateCount, 0);
    assert.strictEqual(s.directional.n, 0);
    assert.strictEqual(s.returns.n, 0);
    assert.strictEqual(s.excluded.non_point_in_time, rows.length);
  });

  test('fixture packet + recorded provider → scored replay + scorecard；不写 forward', async () => {
    const fixturePacket = JSON.parse(
      fs.readFileSync(path.join(FIXTURES_DIR, 'point-in-time-packet.json'), 'utf8')
    );
    const recordedSource = JSON.parse(
      fs.readFileSync(path.join(FIXTURES_DIR, 'recorded-results.json'), 'utf8')
    );
    const manifestBefore = fs.existsSync(FORWARD_MANIFEST)
      ? fs.readFileSync(FORWARD_MANIFEST, 'utf8')
      : null;
    const currentBefore = fs.existsSync(CURRENT_MD) ? fs.readFileSync(CURRENT_MD, 'utf8') : null;

    await runMiniPipeline(AS_OF_DATE, makeWindowData(), {
      reasoningMode: 'recorded',
      recordedSource,
      pointInTimePackets: [fixturePacket]
    });

    const rows = fs
      .readFileSync(path.join(RUN_DIR, 'reasoning-replay.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].scoringStatus, 'scored');
    assert.strictEqual(rows[0].packetHash, recordedSource[0].packetHash);
    assert.ok(rows[0].outcome.grossReturn > 0);
    assert.ok(Number.isFinite(rows[0].outcome.netReturn));

    const scorecard = JSON.parse(
      fs.readFileSync(path.join(RUN_DIR, 'llm-scorecard.json'), 'utf8')
    );
    const s = scorecard.arms.fincot;
    assert.strictEqual(s.candidateCount, 1);
    assert.strictEqual(s.long, 1);
    assert.strictEqual(s.directional.n, 1);
    assert.strictEqual(s.directional.correct, 1);
    assert.strictEqual(s.coverage, 1);

    // 不自动继续 LLM soft filter：filtered.json fixture 原样保留
    assert.deepStrictEqual(
      JSON.parse(fs.readFileSync(path.join(RUN_DIR, 'filtered.json'), 'utf8')),
      { symbols: ['RB0'] }
    );

    // 不写 forward manifest/current.md
    const manifestAfter = fs.existsSync(FORWARD_MANIFEST)
      ? fs.readFileSync(FORWARD_MANIFEST, 'utf8')
      : null;
    const currentAfter = fs.existsSync(CURRENT_MD) ? fs.readFileSync(CURRENT_MD, 'utf8') : null;
    assert.strictEqual(manifestAfter, manifestBefore, 'forward manifest must not change');
    assert.strictEqual(currentAfter, currentBefore, 'current.md must not change');
    const forwardFiles = fs.readdirSync(RUN_DIR).filter((f) => /forward|current|report/i.test(f));
    assert.deepStrictEqual(forwardFiles, []);
  });
});
