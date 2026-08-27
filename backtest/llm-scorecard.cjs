/**
 * LLM Scorecard
 * 透明评分卡：纯聚合，不做验收阈值判断或统计显著性推断
 *
 * 口径：
 * - coverage 分母 = point-in-time 可评价候选（scored + pass），pass 保留在分母
 * - directional 分母 = long/short 且 outcome 成熟（scored），correct 按 grossReturn > 0
 * - returns 只含 long/short scored，pass 不以 0 收益稀释均值
 * - excluded 各状态完整计数，不静默删除
 * - fairSet 仅四臂模式输出：(signalDate,symbol) 上四臂全部 long/short 可评分的交集；
 *   每组必须恰 4 行且臂集为冻结四臂（重复/未知臂 fail closed），fairSetSize=组数，附 per-arm 指标
 */

const EXCLUDED_STATUSES = [
  'non_point_in_time',
  'packet_ineligible',
  'parse_failed',
  'grounding_failed',
  'grounding_degraded',
  'entry_unavailable',
  'outcome_immature'
];

const FROZEN_FOUR_ARMS = ['sp', 'ust-cot', 'st-cot', 'fincot'];

const CONFIDENCE_LEVELS = ['high', 'medium', 'low'];

function mean(values) {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function buildCalibration(rows) {
  const calibration = {};
  for (const level of CONFIDENCE_LEVELS) {
    const subset = rows.filter((r) => r.result?.confidence === level);
    const n = subset.length;
    const correct = subset.filter((r) => r.outcome.grossReturn > 0).length;
    calibration[level] = {
      n,
      correct,
      accuracy: n > 0 ? correct / n : 0,
      netMean: mean(subset.map((r) => r.outcome.netReturn))
    };
  }
  return calibration;
}

function buildArmScore(rows) {
  const scored = rows.filter((r) => r.scoringStatus === 'scored');
  const passRows = rows.filter((r) => r.scoringStatus === 'pass');
  const longRows = scored.filter((r) => r.result?.direction === 'long');
  const shortRows = scored.filter((r) => r.result?.direction === 'short');
  const directionalRows = [...longRows, ...shortRows];

  const candidateCount = scored.length + passRows.length;
  const coverage = candidateCount > 0 ? directionalRows.length / candidateCount : 0;

  const passReasons = { data_insufficient: 0, model_abstain: 0, conflict_unresolved: 0 };
  for (const r of passRows) {
    const reason = r.result?.pass_reason;
    if (reason in passReasons) passReasons[reason] += 1;
  }

  const correct = directionalRows.filter((r) => r.outcome.grossReturn > 0).length;
  const directional = {
    n: directionalRows.length,
    correct,
    accuracy: directionalRows.length > 0 ? correct / directionalRows.length : 0
  };

  const returns = {
    n: directionalRows.length,
    netMean: mean(directionalRows.map((r) => r.outcome.netReturn)),
    longNetMean: mean(longRows.map((r) => r.outcome.netReturn)),
    shortNetMean: mean(shortRows.map((r) => r.outcome.netReturn))
  };

  const excluded = {};
  for (const status of EXCLUDED_STATUSES) {
    excluded[status] = rows.filter((r) => r.scoringStatus === status).length;
  }
  const unscored = rows.filter((r) => r.scoringStatus === null).length;
  if (unscored > 0) excluded.unscored = unscored;

  return {
    candidateCount,
    long: longRows.length,
    short: shortRows.length,
    pass: passRows.length,
    passReasons,
    coverage,
    directional,
    returns,
    excluded,
    confidence: buildCalibration(directionalRows)
  };
}

function buildFairSet(rows) {
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.signalDate}|${r.symbol}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const fairRows = [];
  for (const group of groups.values()) {
    // 结构门禁：每组必须恰 4 行、臂集恰为冻结四臂；重复/未知臂直接抛错，不静默去重
    if (group.length !== FROZEN_FOUR_ARMS.length) {
      throw new Error(
        `fairSet group must have exactly ${FROZEN_FOUR_ARMS.length} rows (one per arm), got ${group.length}: duplicates are not silently deduped`
      );
    }
    const groupArms = group.map((r) => r.arm).sort();
    const frozenSorted = [...FROZEN_FOUR_ARMS].sort();
    if (JSON.stringify(groupArms) !== JSON.stringify(frozenSorted)) {
      throw new Error(
        `fairSet group arms must be exactly the frozen four arms (${frozenSorted.join(', ')}), got (${groupArms.join(', ')})`
      );
    }
    const allScorable = group.every(
      (r) =>
        r.scoringStatus === 'scored' &&
        (r.result?.direction === 'long' || r.result?.direction === 'short')
    );
    if (allScorable) fairRows.push(...group);
  }

  const correct = fairRows.filter((r) => r.outcome.grossReturn > 0).length;

  const arms = {};
  for (const arm of FROZEN_FOUR_ARMS) {
    const armRows = fairRows.filter((r) => r.arm === arm);
    const armCorrect = armRows.filter((r) => r.outcome.grossReturn > 0).length;
    arms[arm] = {
      n: armRows.length,
      correct: armCorrect,
      accuracy: armRows.length > 0 ? armCorrect / armRows.length : 0,
      netMean: mean(armRows.map((r) => r.outcome.netReturn))
    };
  }

  return {
    fairSetSize: fairRows.length / FROZEN_FOUR_ARMS.length,
    directional: {
      n: fairRows.length,
      correct,
      accuracy: fairRows.length > 0 ? correct / fairRows.length : 0
    },
    returns: {
      n: fairRows.length,
      netMean: mean(fairRows.map((r) => r.outcome.netReturn))
    },
    arms
  };
}

/**
 * 构建透明评分卡
 * @param {object[]} replayRows - 已 outcome 评分的 replay rows
 * @returns {{arms: object, fairSet: object|null}}
 */
function buildLlmScorecard(replayRows) {
  const armIds = [...new Set(replayRows.map((r) => r.arm))];

  const arms = {};
  for (const arm of armIds) {
    arms[arm] = buildArmScore(replayRows.filter((r) => r.arm === arm));
  }

  const fairSet = armIds.length === 4 ? buildFairSet(replayRows) : null;

  return { arms, fairSet };
}

module.exports = { buildLlmScorecard };
