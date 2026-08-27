/**
 * LLM Scorecard Test
 * 验证透明评分卡：coverage 口径、方向准确率、收益分离、排除计数、置信度校准、fairSet
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');
const { buildLlmScorecard } = require('../llm-scorecard.cjs');

let rowSeq = 0;
function row({
  arm = 'fincot',
  symbol = 'RB0',
  status = null,
  direction = 'long',
  gross = 0.01,
  net = 0.009,
  confidence = 'medium',
  passReason = 'data_insufficient',
  eligible = true
} = {}) {
  if (status === null) {
    status = direction === 'pass' ? 'pass' : 'scored';
  }
  rowSeq += 1;
  const result =
    direction === 'pass'
      ? { direction: 'pass', pass_reason: passReason, confidence }
      : { direction, confidence };
  return {
    replayId: `r-${rowSeq}`,
    signalDate: '2026-07-01',
    symbol,
    arm,
    pointInTimeEligible: eligible,
    scoringStatus: status,
    result,
    outcome: status === 'scored' ? { grossReturn: gross, netReturn: net } : null
  };
}

describe('buildLlmScorecard 单臂口径', () => {
  test('coverage 分母 = point-in-time 可评价候选，pass 保留在分母', () => {
    const rows = [
      row({ direction: 'long', gross: 0.02, net: 0.019 }),
      row({ direction: 'long', gross: -0.01, net: -0.011 }),
      row({ direction: 'short', gross: 0.01, net: 0.009 }),
      row({ direction: 'pass', passReason: 'data_insufficient' }),
      row({ direction: 'pass', passReason: 'model_abstain' }),
      row({ status: 'non_point_in_time', eligible: false, direction: 'long' }),
      row({ status: 'parse_failed', direction: 'long' })
    ];
    const { arms } = buildLlmScorecard(rows);
    const s = arms.fincot;

    assert.strictEqual(s.candidateCount, 5, '分母不含 non_point_in_time / parse_failed');
    assert.strictEqual(s.long, 2);
    assert.strictEqual(s.short, 1);
    assert.strictEqual(s.pass, 2);
    assert.ok(Math.abs(s.coverage - 3 / 5) < 1e-12);
  });

  test('directional 分母仅 long/short 且 outcome 成熟，correct 按 gross>0', () => {
    const rows = [
      row({ direction: 'long', gross: 0.02 }),
      row({ direction: 'long', gross: -0.01 }),
      row({ direction: 'short', gross: 0.01 }),
      row({ direction: 'pass' }),
      row({ status: 'entry_unavailable', direction: 'long' }),
      row({ status: 'outcome_immature', direction: 'long' })
    ];
    const s = buildLlmScorecard(rows).arms.fincot;

    assert.strictEqual(s.directional.n, 3);
    assert.strictEqual(s.directional.correct, 2);
    assert.ok(Math.abs(s.directional.accuracy - 2 / 3) < 1e-12);
  });

  test('pass 不进入 returns.n，不以 0 收益稀释均值', () => {
    const rows = [
      row({ direction: 'long', gross: 0.02, net: 0.019 }),
      row({ direction: 'short', gross: 0.01, net: 0.009 }),
      row({ direction: 'pass' }),
      row({ direction: 'pass', passReason: 'conflict_unresolved' })
    ];
    const s = buildLlmScorecard(rows).arms.fincot;

    assert.strictEqual(s.returns.n, 2, 'pass 不进入 returns.n');
    assert.ok(Math.abs(s.returns.netMean - (0.019 + 0.009) / 2) < 1e-12);
    assert.ok(Math.abs(s.returns.longNetMean - 0.019) < 1e-12);
    assert.ok(Math.abs(s.returns.shortNetMean - 0.009) < 1e-12);
  });

  test('passReasons 分类计数', () => {
    const rows = [
      row({ direction: 'pass', passReason: 'data_insufficient' }),
      row({ direction: 'pass', passReason: 'data_insufficient' }),
      row({ direction: 'pass', passReason: 'model_abstain' }),
      row({ direction: 'pass', passReason: 'conflict_unresolved' })
    ];
    const s = buildLlmScorecard(rows).arms.fincot;

    assert.deepStrictEqual(s.passReasons, {
      data_insufficient: 2,
      model_abstain: 1,
      conflict_unresolved: 1
    });
  });

  test('excluded 各状态完整计数，不静默删除', () => {
    const rows = [
      row({ status: 'scored', direction: 'long' }),
      row({ status: 'non_point_in_time', eligible: false, direction: 'long' }),
      row({ status: 'non_point_in_time', eligible: false, direction: 'long' }),
      row({ status: 'packet_ineligible', direction: 'long' }),
      row({ status: 'parse_failed', direction: 'long' }),
      row({ status: 'grounding_failed', direction: 'long' }),
      row({ status: 'grounding_failed', direction: 'long' }),
      row({ status: 'grounding_degraded', direction: 'pass' }),
      row({ status: 'entry_unavailable', direction: 'long' }),
      row({ status: 'outcome_immature', direction: 'long' })
    ];
    const s = buildLlmScorecard(rows).arms.fincot;

    assert.deepStrictEqual(s.excluded, {
      non_point_in_time: 2,
      packet_ineligible: 1,
      parse_failed: 1,
      grounding_failed: 2,
      grounding_degraded: 1,
      entry_unavailable: 1,
      outcome_immature: 1
    });
  });

  test('confidence calibration 按 high/medium/low 输出 n/accuracy/netMean', () => {
    const rows = [
      row({ direction: 'long', gross: 0.02, net: 0.019, confidence: 'high' }),
      row({ direction: 'long', gross: -0.01, net: -0.011, confidence: 'high' }),
      row({ direction: 'short', gross: 0.01, net: 0.009, confidence: 'low' }),
      row({ direction: 'pass', confidence: 'low' })
    ];
    const s = buildLlmScorecard(rows).arms.fincot;

    assert.strictEqual(s.confidence.high.n, 2);
    assert.strictEqual(s.confidence.high.correct, 1);
    assert.ok(Math.abs(s.confidence.high.accuracy - 0.5) < 1e-12);
    assert.ok(Math.abs(s.confidence.high.netMean - (0.019 - 0.011) / 2) < 1e-12);
    assert.strictEqual(s.confidence.low.n, 1, 'pass 不进入 confidence calibration');
    assert.strictEqual(s.confidence.medium.n, 0);
  });
});

describe('buildLlmScorecard fairSet', () => {
  test('四臂 fairSet 仅取 (signalDate,symbol) 上四臂全部 long/short 可评分交集', () => {
    const rows = [];
    for (const arm of ['sp', 'ust-cot', 'st-cot', 'fincot']) {
      // symbol A: 四臂全部可评分 → 进入 fairSet
      rows.push(row({ arm, symbol: 'A', direction: 'long', gross: 0.01, net: 0.009 }));
      // symbol B: fincot 是 pass → 整个 B 排除
      if (arm === 'fincot') {
        rows.push(row({ arm, symbol: 'B', direction: 'pass' }));
      } else {
        rows.push(row({ arm, symbol: 'B', direction: 'long', gross: 0.01, net: 0.009 }));
      }
      // symbol C: sp 是 entry_unavailable → 整个 C 排除
      if (arm === 'sp') {
        rows.push(row({ arm, symbol: 'C', status: 'entry_unavailable', direction: 'long' }));
      } else {
        rows.push(row({ arm, symbol: 'C', direction: 'short', gross: 0.02, net: 0.019 }));
      }
    }

    const { arms, fairSet } = buildLlmScorecard(rows);

    assert.ok(fairSet, '四臂模式必须输出 fairSet');
    assert.strictEqual(fairSet.fairSetSize, 1, '仅 symbol A 一组公共样本');
    assert.strictEqual(fairSet.directional.n, 4);
    assert.strictEqual(fairSet.directional.correct, 4);
    assert.strictEqual(fairSet.returns.n, 4);
    for (const arm of ['sp', 'ust-cot', 'st-cot', 'fincot']) {
      assert.strictEqual(fairSet.arms[arm].n, 1, `per-arm ${arm}.n`);
      assert.strictEqual(fairSet.arms[arm].correct, 1);
      assert.ok(Math.abs(fairSet.arms[arm].accuracy - 1) < 1e-12);
    }
  });

  test('单臂模式不伪造 fair-set 对比', () => {
    const rows = [
      row({ arm: 'fincot', direction: 'long' }),
      row({ arm: 'fincot', direction: 'short' })
    ];
    const { fairSet } = buildLlmScorecard(rows);
    assert.strictEqual(fairSet, null);
  });

  test('同臂重复行 → 抛错（fail closed，不静默去重）', () => {
    const rows = [];
    for (const arm of ['sp', 'ust-cot', 'st-cot', 'fincot']) {
      rows.push(row({ arm, symbol: 'A', direction: 'long', gross: 0.01, net: 0.009 }));
      rows.push(row({ arm, symbol: 'A', direction: 'long', gross: 0.01, net: 0.009 }));
    }
    assert.throws(() => buildLlmScorecard(rows), /exactly 4|duplicate/i);
  });

  test('未知臂 → 抛错（fail closed，不进入公平对比）', () => {
    const rows = [
      row({ arm: 'sp', symbol: 'A', direction: 'long' }),
      row({ arm: 'ust-cot', symbol: 'A', direction: 'long' }),
      row({ arm: 'st-cot', symbol: 'A', direction: 'long' }),
      row({ arm: 'unknown-arm', symbol: 'A', direction: 'long' })
    ];
    assert.throws(() => buildLlmScorecard(rows), /arm/i);
  });

  test('fairSetSize=公共样本组数，per-arm 指标按组聚合', () => {
    const rows = [];
    for (const symbol of ['A', 'B']) {
      for (const arm of ['sp', 'ust-cot', 'st-cot', 'fincot']) {
        const gross = arm === 'fincot' ? 0.02 : -0.01;
        const net = arm === 'fincot' ? 0.019 : -0.011;
        rows.push(row({ arm, symbol, direction: 'long', gross, net }));
      }
    }
    const { fairSet } = buildLlmScorecard(rows);

    assert.strictEqual(fairSet.fairSetSize, 2, '公共样本组数，非行数');
    assert.strictEqual(fairSet.directional.n, 8);
    assert.strictEqual(fairSet.directional.correct, 2, '仅 fincot 两行 gross>0');
    assert.strictEqual(fairSet.arms.sp.n, 2);
    assert.strictEqual(fairSet.arms.sp.correct, 0);
    assert.ok(Math.abs(fairSet.arms.sp.accuracy - 0) < 1e-12);
    assert.ok(Math.abs(fairSet.arms.sp.netMean - -0.011) < 1e-12);
    assert.strictEqual(fairSet.arms.fincot.n, 2);
    assert.strictEqual(fairSet.arms.fincot.correct, 2);
    assert.ok(Math.abs(fairSet.arms.fincot.accuracy - 1) < 1e-12);
    assert.ok(Math.abs(fairSet.arms.fincot.netMean - 0.019) < 1e-12);
  });
});
