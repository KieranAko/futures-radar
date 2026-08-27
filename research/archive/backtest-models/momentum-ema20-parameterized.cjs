/**
 * momentum-ema20-parameterized.cjs — 参数化 EMA20 斜率策略
 *
 * 接受阈值覆盖，用于单变量消融实验。
 * 未指定的参数使用当前 observed 默认值。
 *
 * createModel({ hvThreshold, atrThreshold, emaSlopeThreshold })
 *   hvThreshold:        HV5/HV20 最小比值 (default: 1.1)
 *   atrThreshold:       ATR% 最小百分比 (default: 2.0)
 *   emaSlopeThreshold:  EMA 斜率最小绝对值 %/日 (default: 0.3)
 *
 * 返回 { generateSignals } — 与原 model 接口相同。
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

function calculateEMASlope(values, period, slopeDays = 5) {
  if (values.length < period + slopeDays) return null;
  const emaValues = [];
  for (let i = period - 1; i < values.length; i++) {
    const slice = values.slice(0, i + 1);
    const ema = calculateEMA(slice, period);
    emaValues.push(ema);
  }
  const recentEMA = emaValues.slice(-slopeDays);
  const n = recentEMA.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += recentEMA[i];
    sumXY += i * recentEMA[i];
    sumX2 += i * i;
  }
  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  const avgPrice = recentEMA[n - 1];
  return (slope / avgPrice) * 100;
}

/**
 * @param {Object} thresholds
 * @param {number} [thresholds.hvThreshold=1.1]
 * @param {number} [thresholds.atrThreshold=2.0]
 * @param {number} [thresholds.emaSlopeThreshold=0.3]
 */
function createModel(thresholds = {}) {
  const hvThreshold = thresholds.hvThreshold ?? 1.1;
  const atrThreshold = thresholds.atrThreshold ?? 2.0;
  const emaSlopeThreshold = thresholds.emaSlopeThreshold ?? 0.3;

  function generateSignals(raw, { candidates }, signalDate) {
    const signals = [];

    for (const c of candidates) {
      if (c.hvRatio === null || c.hvRatio < hvThreshold) continue;
      if (c.atrPct < atrThreshold) continue;

      const contract = raw.contracts[c.symbol];
      if (!contract || !contract.ohlcv) continue;

      const { dates, close } = contract.ohlcv;
      const signalIdx = dates.indexOf(signalDate);
      if (signalIdx < 0 || signalIdx < 25) continue;

      const truncClose = close.slice(0, signalIdx + 1);
      const emaSlope = calculateEMASlope(truncClose, 20, 5);
      if (emaSlope === null) continue;
      if (Math.abs(emaSlope) < emaSlopeThreshold) continue;

      const direction = emaSlope > 0 ? 'bullish' : 'bearish';

      signals.push({
        symbol: c.symbol,
        direction,
        confidence: Math.min(Math.abs(emaSlope) / 2, 1.0),
        reason: `EMA20 slope ${emaSlope.toFixed(3)}%/day, HV ratio ${c.hvRatio.toFixed(2)}`,
        _modelInputLastDate: dates[signalIdx]
      });
    }

    return signals;
  }

  return { generateSignals };
}

module.exports = { createModel };
