/**
 * Post-Processor Test
 * 验证从LLM输出中提取结构化结果的正确性（v1.2冻结Schema：11字段）
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { extractResult } from '../lib/post-processor.js';

describe('Post-Processor', () => {
  test('提取完整11字段Schema', () => {
    const rawOutput = `{
  "symbol": "RB2501",
  "signalDate": "2026-08-15",
  "strategy": "sp",
  "direction": "long",
  "confidence": "high",
  "pass_reason": null,
  "evidence_ids": ["price_data.close_60d", "volume_oi.avgVolume5d"],
  "opposing_ids": ["basis.basis_pct"],
  "reasoning_summary": "价格上穿MA20且成交量放大",
  "invalidate_if": ["若价格跌破MA20"],
  "branch_status": null
}`;

    const result = extractResult(rawOutput);

    assert.strictEqual(result.symbol, 'RB2501');
    assert.strictEqual(result.signalDate, '2026-08-15');
    assert.strictEqual(result.strategy, 'sp');
    assert.strictEqual(result.direction, 'long');
    assert.strictEqual(result.confidence, 'high');
    assert.deepStrictEqual(result.evidence_ids, ['price_data.close_60d', 'volume_oi.avgVolume5d']);
    assert.deepStrictEqual(result.opposing_ids, ['basis.basis_pct']);
    assert.strictEqual(result.reasoning_summary, '价格上穿MA20且成交量放大');
    assert.deepStrictEqual(result.invalidate_if, ['若价格跌破MA20']);
    assert.strictEqual(result.branch_status, null);
  });

  test('pass方向必须有pass_reason', () => {
    const rawOutput = `{
  "symbol": "RB2501",
  "signalDate": "2026-08-15",
  "strategy": "sp",
  "direction": "pass",
  "confidence": "low",
  "pass_reason": "data_insufficient",
  "evidence_ids": [],
  "opposing_ids": [],
  "reasoning_summary": "必填字段缺失",
  "invalidate_if": [],
  "branch_status": null
}`;

    const result = extractResult(rawOutput);

    assert.strictEqual(result.direction, 'pass');
    assert.strictEqual(result.pass_reason, 'data_insufficient');
  });

  test('pass方向缺少pass_reason应抛出错误', () => {
    const rawOutput = `{
  "symbol": "RB2501",
  "signalDate": "2026-08-15",
  "strategy": "sp",
  "direction": "pass",
  "confidence": "low",
  "evidence_ids": [],
  "opposing_ids": [],
  "reasoning_summary": "缺失pass_reason",
  "invalidate_if": [],
  "branch_status": null
}`;

    assert.throws(
      () => extractResult(rawOutput),
      /Pass direction requires valid pass_reason/
    );
  });

  test('confidence必须为high|medium|low', () => {
    const rawOutput = `{
  "symbol": "RB2501",
  "signalDate": "2026-08-15",
  "strategy": "sp",
  "direction": "long",
  "confidence": 0.8,
  "evidence_ids": ["price_data.close_60d"],
  "opposing_ids": [],
  "reasoning_summary": "测试",
  "invalidate_if": [],
  "branch_status": null
}`;

    assert.throws(
      () => extractResult(rawOutput),
      /Invalid confidence/
    );
  });

  test('reasoning_summary超过150字应抛出错误', () => {
    const longSummary = 'a'.repeat(151);
    const rawOutput = `{
  "symbol": "RB2501",
  "signalDate": "2026-08-15",
  "strategy": "sp",
  "direction": "long",
  "confidence": "high",
  "evidence_ids": ["price_data.close_60d"],
  "opposing_ids": [],
  "reasoning_summary": "${longSummary}",
  "invalidate_if": [],
  "branch_status": null
}`;

    assert.throws(
      () => extractResult(rawOutput),
      /reasoning_summary too long/
    );
  });

  test('FinCoT必须有branch_status', () => {
    const rawOutput = `{
  "symbol": "RB2501",
  "signalDate": "2026-08-15",
  "strategy": "fincot",
  "direction": "long",
  "confidence": "high",
  "evidence_ids": ["price_data.close_60d"],
  "opposing_ids": [],
  "reasoning_summary": "测试",
  "invalidate_if": [],
  "branch_status": {
    "regime": "available",
    "macro_fundamental": "available",
    "position_flow": "abstain"
  }
}`;

    const result = extractResult(rawOutput);

    assert.strictEqual(result.branch_status.regime, 'available');
    assert.strictEqual(result.branch_status.macro_fundamental, 'available');
    assert.strictEqual(result.branch_status.position_flow, 'abstain');
  });

  test('非FinCoT策略branch_status必须为null', () => {
    const rawOutput = `{
  "symbol": "RB2501",
  "signalDate": "2026-08-15",
  "strategy": "sp",
  "direction": "long",
  "confidence": "high",
  "evidence_ids": ["price_data.close_60d"],
  "opposing_ids": [],
  "reasoning_summary": "测试",
  "invalidate_if": [],
  "branch_status": {"regime": "available"}
}`;

    assert.throws(
      () => extractResult(rawOutput),
      /Non-FinCoT strategy must have branch_status=null/
    );
  });

  test('缺少symbol应抛出错误', () => {
    const rawOutput = `{
  "signalDate": "2026-08-15",
  "strategy": "sp",
  "direction": "long",
  "confidence": "high",
  "evidence_ids": ["price_data.close_60d"],
  "opposing_ids": [],
  "reasoning_summary": "测试",
  "invalidate_if": [],
  "branch_status": null
}`;

    assert.throws(
      () => extractResult(rawOutput),
      /Missing or invalid symbol/
    );
  });
});

describe('Post-Processor 输入一致性', () => {
  const FINCOT_LONG = `{
  "symbol": "RB0",
  "signalDate": "2026-08-24",
  "strategy": "fincot",
  "direction": "long",
  "confidence": "medium",
  "pass_reason": null,
  "evidence_ids": ["price_data.close_60d"],
  "opposing_ids": [],
  "reasoning_summary": "Regime趋势向上。",
  "invalidate_if": [],
  "branch_status": {
    "regime": "available",
    "macro_fundamental": "available",
    "position_flow": "abstain"
  }
}`;

  const expectedContext = {
    expectedSymbol: 'RB0',
    expectedSignalDate: '2026-08-24',
    expectedStrategy: 'fincot'
  };

  test('symbol 不一致时拒绝', () => {
    const rawOutput = FINCOT_LONG.replace('"symbol": "RB0"', '"symbol": "CU0"');
    assert.throws(
      () => extractResult(rawOutput, expectedContext),
      /expectedSymbol|symbol mismatch/i
    );
  });

  test('signalDate 不一致时拒绝', () => {
    const rawOutput = FINCOT_LONG.replace('"signalDate": "2026-08-24"', '"signalDate": "2026-08-23"');
    assert.throws(
      () => extractResult(rawOutput, expectedContext),
      /expectedSignalDate|signalDate mismatch/i
    );
  });

  test('strategy 不一致时拒绝', () => {
    const rawOutput = FINCOT_LONG.replace('"strategy": "fincot"', '"strategy": "sp"');
    assert.throws(
      () => extractResult(rawOutput, expectedContext),
      /expectedStrategy|strategy mismatch/i
    );
  });

  test('context 一致时正常解析', () => {
    const result = extractResult(FINCOT_LONG, expectedContext);
    assert.strictEqual(result.symbol, 'RB0');
    assert.strictEqual(result.direction, 'long');
  });

  test('旧调用 extractResult(rawOutput) 保持可用', () => {
    const result = extractResult(FINCOT_LONG);
    assert.strictEqual(result.strategy, 'fincot');
  });

  test('direction 非 pass 时携带 pass_reason 拒绝', () => {
    const rawOutput = FINCOT_LONG.replace('"pass_reason": null', '"pass_reason": "data_insufficient"');
    assert.throws(
      () => extractResult(rawOutput),
      /pass_reason/
    );
  });

  test('FinCoT branch_status 缺少键拒绝', () => {
    const rawOutput = FINCOT_LONG.replace(
      `"branch_status": {
    "regime": "available",
    "macro_fundamental": "available",
    "position_flow": "abstain"
  }`,
      `"branch_status": {
    "regime": "available",
    "macro_fundamental": "available"
  }`
    );
    assert.throws(
      () => extractResult(rawOutput),
      /branch_status/
    );
  });

  test('FinCoT branch_status 多余键拒绝', () => {
    const rawOutput = FINCOT_LONG.replace(
      '"position_flow": "abstain"',
      '"position_flow": "abstain",\n    "extra_branch": "available"'
    );
    assert.throws(
      () => extractResult(rawOutput),
      /branch_status/
    );
  });

  test('FinCoT regime 非 available 拒绝', () => {
    const rawOutput = FINCOT_LONG.replace('"regime": "available"', '"regime": "abstain"');
    assert.throws(
      () => extractResult(rawOutput),
      /regime/
    );
  });
});

describe('FinCoT 分支决策门禁', () => {
  function fincotOutput({ direction, passReason = null, macro = 'abstain', position = 'abstain' }) {
    return JSON.stringify({
      symbol: 'RB0',
      signalDate: '2026-08-24',
      strategy: 'fincot',
      direction,
      confidence: 'low',
      pass_reason: passReason,
      evidence_ids: ['price_data.close_60d'],
      opposing_ids: [],
      reasoning_summary: '测试',
      invalidate_if: [],
      branch_status: { regime: 'available', macro_fundamental: macro, position_flow: position }
    });
  }

  test('仅 1 个 available 分支 + long → 拒绝（必须 pass/data_insufficient）', () => {
    assert.throws(
      () => extractResult(fincotOutput({ direction: 'long' })),
      /available/
    );
  });

  test('仅 1 个 available 分支 + short → 拒绝', () => {
    assert.throws(
      () => extractResult(fincotOutput({ direction: 'short' })),
      /available/
    );
  });

  test('仅 1 个 available 分支 + pass(data_insufficient) → 接受', () => {
    const result = extractResult(
      fincotOutput({ direction: 'pass', passReason: 'data_insufficient' })
    );
    assert.strictEqual(result.direction, 'pass');
    assert.strictEqual(result.pass_reason, 'data_insufficient');
  });

  test('仅 1 个 available 分支 + pass(model_abstain) → 拒绝', () => {
    assert.throws(
      () => extractResult(fincotOutput({ direction: 'pass', passReason: 'model_abstain' })),
      /available/
    );
  });

  test('仅 1 个 available 分支 + pass(conflict_unresolved) → 拒绝', () => {
    assert.throws(
      () => extractResult(fincotOutput({ direction: 'pass', passReason: 'conflict_unresolved' })),
      /available/
    );
  });

  test('≥2 个 available 分支 + pass(data_insufficient) → 拒绝（口径锁定）', () => {
    assert.throws(
      () =>
        extractResult(
          fincotOutput({ direction: 'pass', passReason: 'data_insufficient', macro: 'available' })
        ),
      /data_insufficient|available/
    );
  });

  test('2 个 available 分支 + long → 接受（正向控制）', () => {
    const result = extractResult(fincotOutput({ direction: 'long', macro: 'available' }));
    assert.strictEqual(result.direction, 'long');
  });
});
