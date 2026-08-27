/**
 * momentum-ema20.cjs — EMA20斜率趋势策略
 *
 * 入场条件：
 * 1. 高波动率（HV5/HV20 > 1.3, ATR% > 3%）
 * 2. 方向：EMA20斜率（最近5日）
 * 3. 强度阈值：EMA斜率 > 阈值
 *
 * 比change5d更平滑，过滤短期噪声。
 */

/**
 * 计算EMA
 */
function calculateEMA(values, period) {
  if (values.length < period) return null;

  const k = 2 / (period + 1);
  let ema = values[0];

  for (let i = 1; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }

  return ema;
}

/**
 * 计算EMA斜率（最近N日的线性回归斜率）
 */
function calculateEMASlope(values, period, slopeDays = 5) {
  if (values.length < period + slopeDays) return null;

  const emaValues = [];
  for (let i = period - 1; i < values.length; i++) {
    const slice = values.slice(0, i + 1);
    const ema = calculateEMA(slice, period);
    emaValues.push(ema);
  }

  // 取最后slopeDays个EMA值，计算斜率
  const recentEMA = emaValues.slice(-slopeDays);
  const n = recentEMA.length;

  // 简单线性回归：slope = (n*Σxy - Σx*Σy) / (n*Σx² - (Σx)²)
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += recentEMA[i];
    sumXY += i * recentEMA[i];
    sumX2 += i * i;
  }

  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  const avgPrice = recentEMA[n - 1];
  const slopePercent = (slope / avgPrice) * 100;  // 转为百分比

  return slopePercent;
}

function generateSignals(raw, { candidates }, signalDate) {
  const signals = [];

  for (const c of candidates) {
    // 机会层：波动率过滤
    if (c.hvRatio === null || c.hvRatio < 1.3) continue;
    if (c.atrPct < 3.0) continue;

    // 获取完整价格序列到signalDate
    const contract = raw.contracts[c.symbol];
    if (!contract || !contract.ohlcv) continue;

    const { dates, close } = contract.ohlcv;
    const signalIdx = dates.indexOf(signalDate);
    if (signalIdx < 0 || signalIdx < 25) continue;  // 需要至少25天数据

    const truncClose = close.slice(0, signalIdx + 1);

    // 方向层：EMA20斜率
    const emaSlope = calculateEMASlope(truncClose, 20, 5);
    if (emaSlope === null) continue;
    if (Math.abs(emaSlope) < 0.5) continue;  // 至少0.5%/日的斜率

    const direction = emaSlope > 0 ? 'bullish' : 'bearish';

    signals.push({
      symbol: c.symbol,
      direction,
      confidence: Math.min(Math.abs(emaSlope) / 2, 1.0),  // 斜率越大，置信度越高
      reason: `EMA20 slope ${emaSlope.toFixed(3)}%/day, HV ratio ${c.hvRatio.toFixed(2)}`
    });
  }

  return signals;
}

module.exports = { generateSignals };
