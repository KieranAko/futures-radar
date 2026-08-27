/**
 * momentum-change5d-relaxed.cjs — 最简单的动量策略（放宽阈值版）
 *
 * 入场条件：
 * 1. 中高波动率（HV5/HV20 > 1.1, ATR% > 2%）← 放宽
 * 2. 方向：change5d的符号（正 = bullish, 负 = bearish）
 * 3. 强度阈值：|change5d| > 2% ← 放宽
 *
 * 目标：扩大样本量，与 EMA20-relaxed 对比
 */

function generateSignals(raw, { candidates }, signalDate) {
  const signals = [];

  for (const c of candidates) {
    // 机会层：波动率过滤（放宽阈值）
    if (c.hvRatio === null || c.hvRatio < 1.1) continue;  // 1.3 → 1.1
    if (c.atrPct < 2.0) continue;  // 3.0 → 2.0

    // 方向层：change5d动量（放宽阈值）
    if (c.change5d === null) continue;
    if (Math.abs(c.change5d) < 2.0) continue;  // 3.0 → 2.0

    const direction = c.change5d > 0 ? 'bullish' : 'bearish';

    signals.push({
      symbol: c.symbol,
      direction,
      confidence: Math.abs(c.change5d) / 100,
      reason: `Change5d ${c.change5d.toFixed(2)}%, HV ratio ${c.hvRatio.toFixed(2)}`
    });
  }

  return signals;
}

module.exports = { generateSignals };
