/**
 * Analyze Replay E2E Test
 * 端到端验证分析层四臂离线回放：
 * fixture packet × 4 arms → recorded provider → replay rows → outcome 评分 → scorecard
 * 断言：同包同 packetHash、每包 4 个 distinct 稳定 promptHash、long/short/pass 统计、
 * fairSet 交集口径（仅四臂全部 long/short 可评分的组）、无隐藏 CoT 落盘
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { hashPacket } from '../lib/reasoning-artifact.js';

const require = createRequire(import.meta.url);
const { replayReasoning } = require('../../backtest/llm-replay.cjs');
const { scoreReasoningOutcome } = require('../../backtest/llm-outcome.cjs');
const { buildLlmScorecard } = require('../../backtest/llm-scorecard.cjs');

const SIGNAL_DATE = '2026-07-01';

// 20 个交易日：2026-06-22(周一) 起，'2026-07-01' 在 index 7
// T+1 open[8]=3000 入场，T+11 close[18]=3100 出场（long 正收益 / short 负收益）
function makeOhlcv() {
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
  return {
    dates,
    open,
    high: close.map((c) => +(c * 1.005).toFixed(2)),
    low: close.map((c) => +(c * 0.995).toFixed(2)),
    close,
    volume: Array.from({ length: n }, () => 500000),
    openInterest: Array.from({ length: n }, () => 500000)
  };
}

function makeRaw() {
  const ohlcv = makeOhlcv();
  return {
    contracts: {
      RB0: { symbol: 'RB0', name: '螺纹钢', multiplier: 10, ohlcv },
      CU0: { symbol: 'CU0', name: '沪铜', multiplier: 5, ohlcv }
    }
  };
}

function makePacket(symbol, closeSeed) {
  return {
    symbol,
    signalDate: SIGNAL_DATE,
    marketCutoffAt: '2026-07-01T15:00:00+08:00',
    packetFrozenAt: '2026-07-01T16:30:00+08:00',
    generatedAt: '2026-07-01T16:20:00+08:00',
    frozenCommit: 'bt-20260701',
    quality_check: {
      executable: true,
      required_available: ['price_data', 'volume_oi'],
      optional_available: [],
      missing: ['inventory'],
      max_staleness: '3d'
    },
    fields: {
      price_data: {
        source: 'akshare',
        asOf: '2026-07-01T15:00:00+08:00',
        fetchedAt: '2026-07-01T15:03:00+08:00',
        _timestamp_origin: 'observed',
        freshness: 'same_day',
        gap: null,
        close_60d: [closeSeed, closeSeed + 50, closeSeed + 100],
        ma20: closeSeed + 50,
        ma60: closeSeed - 100
      },
      volume_oi: {
        source: 'akshare',
        asOf: '2026-07-01T15:00:00+08:00',
        fetchedAt: '2026-07-01T15:03:00+08:00',
        _timestamp_origin: 'observed',
        freshness: 'same_day',
        gap: null,
        volume_60d: [100, 200, 300],
        avgVolume5d: 150
      }
    },
    point_in_time: { eligible: true, reasons: [] }
  };
}

function resultText({ symbol, arm, direction, confidence, passReason = null }) {
  const isPass = direction === 'pass';
  return JSON.stringify({
    symbol,
    signalDate: SIGNAL_DATE,
    strategy: arm,
    direction,
    confidence,
    pass_reason: passReason,
    evidence_ids: isPass ? [] : ['price_data.close_60d', 'volume_oi.avgVolume5d'],
    opposing_ids: [],
    reasoning_summary: isPass ? '数据不足以判断方向' : `${arm} 方向判断`,
    invalidate_if: [],
    branch_status:
      arm === 'fincot'
        ? { regime: 'available', macro_fundamental: 'available', position_flow: 'abstain' }
        : null
  });
}

// 方向编排：RB0 四臂全 long/short（进 fairSet）；CU0 st-cot=pass（整组出 fairSet）
const PLAN = [
  { symbol: 'RB0', arm: 'sp', direction: 'long', confidence: 'high' },
  { symbol: 'RB0', arm: 'ust-cot', direction: 'short', confidence: 'medium' },
  { symbol: 'RB0', arm: 'st-cot', direction: 'short', confidence: 'medium' },
  { symbol: 'RB0', arm: 'fincot', direction: 'long', confidence: 'medium' },
  { symbol: 'CU0', arm: 'sp', direction: 'long', confidence: 'high' },
  { symbol: 'CU0', arm: 'ust-cot', direction: 'long', confidence: 'medium' },
  { symbol: 'CU0', arm: 'st-cot', direction: 'pass', confidence: 'low', passReason: 'data_insufficient' },
  { symbol: 'CU0', arm: 'fincot', direction: 'short', confidence: 'medium' }
];

function buildRecordedSource(packets) {
  const bySymbol = Object.fromEntries(packets.map((p) => [p.symbol, p]));
  return PLAN.map(({ symbol, arm, direction, confidence, passReason }) => ({
    packetHash: hashPacket(bySymbol[symbol]),
    arm,
    text: resultText({ symbol, arm, direction, confidence, passReason })
  }));
}

async function runFullReplay() {
  const raw = makeRaw();
  const packets = [makePacket('RB0', 3000), makePacket('CU0', 68000)];
  const rows = await replayReasoning({
    replayId: 'analyze-replay-e2e',
    packets,
    arms: 'four',
    providerMode: 'recorded',
    recordedSource: buildRecordedSource(packets)
  });
  for (const row of rows) {
    if (row.scoringStatus === null) {
      const scored = scoreReasoningOutcome({
        result: row.result,
        symbol: row.symbol,
        signalDate: row.signalDate,
        raw
      });
      row.outcome = scored.outcome;
      row.scoringStatus = scored.scoringStatus;
    }
  }
  return { rows, scorecard: buildLlmScorecard(rows), packets };
}

describe('Analyze Replay E2E', () => {
  test('四臂 × 2 packets → 8 rows；同包同 packetHash、4 个 distinct promptHash', async () => {
    const { rows, packets } = await runFullReplay();

    assert.strictEqual(rows.length, 8);
    for (const row of rows) {
      assert.strictEqual(row.pointInTimeEligible, true);
      assert.ok(row.packetHash, 'eligible packet 应有 packetHash');
    }

    for (const packet of packets) {
      const group = rows.filter((r) => r.symbol === packet.symbol);
      assert.strictEqual(group.length, 4);
      const expected = hashPacket(packet);
      for (const row of group) assert.strictEqual(row.packetHash, expected);
      const promptHashes = new Set(group.map((r) => r.promptHash));
      assert.strictEqual(promptHashes.size, 4, '四臂 prompt 互不相同');
      assert.ok(!promptHashes.has(null));
    }
  });

  test('promptHash/packetHash 跨两次运行稳定（可复现）', async () => {
    const first = await runFullReplay();
    const second = await runFullReplay();
    const sig = (rows) => rows.map((r) => `${r.arm}|${r.packetHash}|${r.promptHash}`).sort();
    assert.deepStrictEqual(sig(first.rows), sig(second.rows));
  });

  test('scorecard 四臂 long/short/pass 统计与 coverage 口径', async () => {
    const { rows, scorecard } = await runFullReplay();
    assert.strictEqual(rows.filter((r) => r.scoringStatus === 'scored').length, 7);
    assert.strictEqual(rows.filter((r) => r.scoringStatus === 'pass').length, 1);

    const sp = scorecard.arms.sp;
    assert.strictEqual(sp.candidateCount, 2);
    assert.strictEqual(sp.long, 2);
    assert.strictEqual(sp.short, 0);
    assert.strictEqual(sp.coverage, 1);
    assert.deepStrictEqual(sp.directional, { n: 2, correct: 2, accuracy: 1 });

    const ust = scorecard.arms['ust-cot'];
    assert.strictEqual(ust.long, 1);
    assert.strictEqual(ust.short, 1);
    assert.deepStrictEqual(ust.directional, { n: 2, correct: 1, accuracy: 0.5 });

    const st = scorecard.arms['st-cot'];
    assert.strictEqual(st.candidateCount, 2);
    assert.strictEqual(st.long, 0);
    assert.strictEqual(st.short, 1);
    assert.strictEqual(st.pass, 1);
    assert.strictEqual(st.coverage, 0.5);
    assert.strictEqual(st.passReasons.data_insufficient, 1);
    assert.deepStrictEqual(st.directional, { n: 1, correct: 0, accuracy: 0 });

    const fincot = scorecard.arms.fincot;
    assert.strictEqual(fincot.long, 1);
    assert.strictEqual(fincot.short, 1);
    assert.deepStrictEqual(fincot.directional, { n: 2, correct: 1, accuracy: 0.5 });

    // 净收益含成本：long ≈ +3.26%（entry 3000 → exit 3100，cost 0.0705%）
    assert.ok(Math.abs(sp.returns.netMean - 0.032628) < 1e-6);
    assert.ok(ust.returns.shortNetMean < ust.returns.longNetMean);
  });

  test('fairSet 仅含四臂全部 long/short 可评分的 (signalDate, symbol) 组', async () => {
    const { scorecard } = await runFullReplay();
    const fairSet = scorecard.fairSet;
    assert.ok(fairSet, '四臂模式输出 fairSet');
    // RB0 四臂全 long/short → 1 组公共样本；CU0 st-cot=pass → 整组排除
    assert.strictEqual(fairSet.fairSetSize, 1, '公共样本组数，非行数');
    assert.strictEqual(fairSet.directional.n, 4);
    assert.strictEqual(fairSet.directional.correct, 2); // sp long ✓ / fincot long ✓
    assert.strictEqual(fairSet.directional.accuracy, 0.5);
    // 2 long (+3.26%) + 2 short (−3.40%) 均值 = −成本 ≈ −0.000705
    assert.ok(Math.abs(fairSet.returns.netMean + 0.000705) < 1e-9);
    // per-arm 公共集指标
    assert.strictEqual(fairSet.arms.sp.n, 1);
    assert.strictEqual(fairSet.arms.sp.correct, 1); // sp long ✓
    assert.strictEqual(fairSet.arms['ust-cot'].n, 1);
    assert.strictEqual(fairSet.arms['ust-cot'].correct, 0); // short ✗
    assert.strictEqual(fairSet.arms['st-cot'].correct, 0); // short ✗
    assert.strictEqual(fairSet.arms.fincot.n, 1);
    assert.strictEqual(fairSet.arms.fincot.correct, 1); // long ✓
  });

  test('replay 行与 scorecard 不含完整 prompt 与隐藏 CoT', async () => {
    const { rows, scorecard } = await runFullReplay();
    const serialized = JSON.stringify({ rows, scorecard });
    assert.ok(!serialized.includes('raw_thinking'));
    assert.ok(!serialized.includes('chain_of_thought'));
    for (const row of rows) {
      assert.ok(!('prompt' in row), '行不携带完整 prompt 文本');
      const resultJson = JSON.stringify(row.result ?? null);
      assert.ok(!resultJson.includes('raw_thinking'));
    }
  });
});
