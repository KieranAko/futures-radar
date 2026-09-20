/**
 * Analysis Mapping
 * FinCoT 方向 → 六问 analysis 方向的确定性映射（含 override 预留契约）
 */

const DIRECTION_MAP = {
  long: 'bullish',
  short: 'bearish',
  pass: 'neutral'
};

/**
 * 确定性映射：long→bullish, short→bearish, pass→neutral
 * @param {string} direction - fincot 方向
 * @returns {string}
 */
export function mapReasoningDirection(direction) {
  const mapped = DIRECTION_MAP[direction];
  if (!mapped) {
    throw new Error(`Unknown reasoning direction: ${direction}`);
  }
  return mapped;
}

/**
 * 解析 analysis 方向：无 override 时人工方向必须与映射一致，否则 fail closed
 * @param {string} reasoningDirection - fincot long|short|pass
 * @param {string} manualDirection - 六问 bullish|bearish|neutral
 * @param {{from: string, to: string, reason: string}|null} [override] - 预留契约
 * @returns {string}
 */
export function resolveAnalysisDirection(reasoningDirection, manualDirection, override = null) {
  const mapped = mapReasoningDirection(reasoningDirection);

  if (override) {
    if (typeof override.from !== 'string' || typeof override.to !== 'string') {
      throw new Error('override requires from and to');
    }
    if (!override.reason || typeof override.reason !== 'string') {
      throw new Error('override requires an auditable reason');
    }
    return override.to;
  }

  if (manualDirection !== mapped) {
    throw new Error(
      `Direction mismatch: reasoning ${reasoningDirection} maps to ${mapped}, but analysis says ${manualDirection}. ` +
      'An auditable override {from, to, reason} is required to diverge.'
    );
  }

  return mapped;
}
