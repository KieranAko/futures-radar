/**
 * momentum-donchian.cjs — Donchian通道突破策略
 *
 * 入场条件：
 * 1. 高波动率（HV5/HV20 > 1.3, ATR% > 3%）
 * 2. 方向：20日Donchian突破
 *    - 当前价格 > 20日最高价 → bullish
 *    - 当前价格 < 20日最低价 → bearish
 * 3. 突破幅度 > 0.5%（避免假突破）
 *
 * Donchian通道是经典的趋势跟踪指标，突破新高/新低表示趋势建立。
 */

function calculateDonchian(high, low, period) {
  if (high.length < period || low.length < period) {
    return { upper: null, lower: null };
  }

  const recentHigh = high.slice(-period);
  const recentLow = low.slice(-period);

  return {
    upper: Math.max(...recentHigh),
    lower: Math.min(...recentLow)
  };
}

function generateSignals(raw, { candidates }, signalDate) {
  const signals = [];

  for (const c of candidates) {
    // 机会层：波动率过滤
    if (c.hvRatio === null || c.hvRatio < 1.3) continue;
    if (c.atrPct < 3.0) continue;

    // 获取完整OHLC序列到signalDate
    const contract = raw.contracts[c.symbol];
    if (!contract || !contract.ohlcv) continue;

    const { dates, high, low, close } = contract.ohlcv;
    const signalIdx = dates.indexOf(signalDate);
    if (signalIdx < 0 || signalIdx < 20) continue;

    const truncHigh = high.slice(0, signalIdx + 1);
    const truncLow = low.slice(0, signalIdx + 1);
    const currentPrice = close[signalIdx];

    // 方向层：Donchian 20日突破或接近边缘
    const donchian = calculateDonchian(truncHigh, truncLow, 20);
    if (donchian.upper === null || donchian.lower === null) continue;

    const range = donchian.upper - donchian.lower;
    const distanceToUpper = (donchian.upper - currentPrice) / range;
    const distanceToLower = (currentPrice - donchian.lower) / range;

    let direction = null;
    let strength = 0;

    // 接近上轨（在最高20%区域）→ bullish
    if (distanceToUpper < 0.2) {
      direction = 'bullish';
      strength = (1 - distanceToUpper / 0.2) * 100;  // 0-100
    }
    // 接近下轨（在最低20%区域）→ bearish
    else if (distanceToLower < 0.2) {
      direction = 'bearish';
      strength = (1 - distanceToLower / 0.2) * 100;
    }

    if (!direction) continue;

    signals.push({
      symbol: c.symbol,
      direction,
      confidence: Math.min(strength / 100, 1.0),
      reason: `Donchian ${direction === 'bullish' ? 'near upper' : 'near lower'} band (strength ${strength.toFixed(1)}), HV ratio ${c.hvRatio.toFixed(2)}`
    });
  }

  return signals;
}

module.exports = { generateSignals };
