// strategies/lib/near-term-structure.cjs — 近端价格结构（v1）
//
// 目的：为分析 Q4/Q5 与策略定价提供“近端、可达、市场自身画出来的”结构位，
// 替代 MA20 / 概率锥等远端统计定价。
//
// 字段：
//   pdh/pdl       前一日高/低
//   h3/l3         近 3 日高/低（不含信号日）
//   valueAreaHigh/valueAreaLow  近 3 日重叠价值区近似（min highs / max lows）
//   atr5
//   close
//   distances     各结构位相对 close 的点数与 ATR 倍数
'use strict';

function round(v, d = 2) {
  return v == null || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 10 ** d) / 10 ** d;
}

function atr5FromBars(bars, idx) {
  const trs = [];
  for (let i = Math.max(1, idx - 4); i <= idx; i++) {
    const b = bars[i];
    const p = bars[i - 1];
    trs.push(Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close)));
  }
  return trs.length ? trs.reduce((a, b) => a + b, 0) / trs.length : null;
}

/**
 * @param bars [{date, open, high, low, close, volume?}] 升序
 * @param signalDate 信号日
 */
function computeNearTermStructure(bars, signalDate) {
  const idx = bars.findIndex((b) => b.date === signalDate);
  if (idx < 1) return null;
  const bar = bars[idx];
  const prev = bars[idx - 1];
  const close = bar.close;
  const atr5 = atr5FromBars(bars, idx);
  const pdh = prev.high;
  const pdl = prev.low;

  const prior = bars.slice(Math.max(0, idx - 3), idx);
  const h3 = prior.length ? Math.max(...prior.map((b) => b.high)) : pdh;
  const l3 = prior.length ? Math.min(...prior.map((b) => b.low)) : pdl;

  const recent = bars.slice(Math.max(0, idx - 2), idx + 1); // 含信号日，用于重叠区
  const valueAreaHigh = Math.min(...recent.map((b) => b.high));
  const valueAreaLow = Math.max(...recent.map((b) => b.low));

  function dist(level) {
    if (level == null || atr5 == null || atr5 <= 0) return { pts: null, atr: null };
    const pts = round(level - close, 2);
    return { pts, atr: round(pts / atr5, 2) };
  }

  return {
    signalDate,
    close,
    atr5: round(atr5, 2),
    pdh,
    pdl,
    h3,
    l3,
    valueAreaHigh,
    valueAreaLow,
    distances: {
      pdh: dist(pdh),
      pdl: dist(pdl),
      h3: dist(h3),
      l3: dist(l3),
      valueAreaHigh: dist(valueAreaHigh),
      valueAreaLow: dist(valueAreaLow)
    }
  };
}

module.exports = { computeNearTermStructure, atr5FromBars };
