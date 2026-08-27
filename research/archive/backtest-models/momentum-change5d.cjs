/**
 * momentum-change5d.cjs — 最简单的动量策略
 *
 * 入场条件：
 * 1. 高波动率（HV5/HV20 > 1.3, ATR% > 3%）
 * 2. 方向：change5d的符号（正 = bullish, 负 = bearish）
 * 3. 强度阈值：|change5d| > 3%
 *
 * 这是最简单的方向预测器，用作基准。
 */

function generateSignals(raw, { candidates }, signalDate) {
  const signals = [];

  for (const c of candidates) {
    // 机会层：波动率过滤
    if (c.hvRatio === null || c.hvRatio < 1.3) continue;
    if (c.atrPct < 3.0) continue;

    // 方向层：change5d动量
    if (c.change5d === null) continue;
    if (Math.abs(c.change5d) < 3.0) continue;  // 至少3%的动量

    const direction = c.change5d > 0 ? 'bullish' : 'bearish';

    signals.push({
      symbol: c.symbol,
      direction,
      confidence: Math.abs(c.change5d) / 100,  // 简单的置信度
      reason: `Change5d ${c.change5d.toFixed(2)}%, HV ratio ${c.hvRatio.toFixed(2)}`
    });
  }

  return signals;
}

module.exports = { generateSignals };
