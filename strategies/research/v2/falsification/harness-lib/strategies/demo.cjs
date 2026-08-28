// falsification harness — demo adapter (reference implementation of the adapter contract)
// 20-bar Donchian breakout momentum with volume confirmation. Used by the selftest
// and as the canonical example for t8 strategy adapters. NOT one of the 8 library strategies.
'use strict';

const { isFiniteNum } = require('../util.cjs');
const { binomialTest, hitRateNet } = require('../stats.cjs');

module.exports = {
  id: 'demo',
  description: 'demo momentum (Donchian20 + volumeRatio>=1.2 confirm), stop 1xATR5, target 2xATR5, timeExit 10 bars',

  createAdapter({ spec, data, engine }) {
    const sym = spec.universe.symbols[0];
    return {
      minWarmup: 60,

      initState() {
        return { lastEntryBar: -Infinity };
      },

      // no calibration hook → pre-registered initial params (documented provenance)
      evalBar(ctx, state, params, meta) {
        const idx = ctx.anchorIdxBySymbol[sym];
        if (idx === null || idx < this.minWarmup) return null;
        const view = ctx.daily[sym];
        const dv = ctx.derived[sym];
        const close = view.at('close', idx);
        const atr = dv.at('atr5', idx);
        const volRatio = dv.at('volumeRatio', idx);
        if (!isFiniteNum(close) || !isFiniteNum(atr) || atr <= 0) return null;
        // no new entries on jump bars (F5) — engine also enforces at fill time
        if (ctx.jumpDates[sym] && ctx.jumpDates[sym].has(ctx.anchorDate)) return null;
        // single-position spacing: skip if a signal fired within the last 5 bars
        if (idx - state.lastEntryBar < 5) return null;

        const donchian = params.donchian ?? 20;
        const lookback = params.donchianLookback ?? 1; // compare close vs prior window (excludes today)
        let hi = -Infinity;
        let lo = Infinity;
        for (let i = idx - donchian; i <= idx - lookback; i++) {
          const h = view.at('high', i);
          const l = view.at('low', i);
          if (isFiniteNum(h) && h > hi) hi = h;
          if (isFiniteNum(l) && l < lo) lo = l;
        }
        if (!isFiniteNum(hi) || !isFiniteNum(lo)) return null;

        const confirmed = isFiniteNum(volRatio) && volRatio >= (params.volConfirm ?? 1.2);
        let direction = 0;
        if (close > hi && confirmed) direction = +1;
        else if (close < lo && confirmed) direction = -1;
        if (direction === 0) return null;

        const stopMult = params.atrMultStop ?? 1;
        const targetMult = params.atrMultTarget ?? 2;
        const stop = close - direction * stopMult * atr;
        const target = close + direction * targetMult * atr;

        state.lastEntryBar = idx;
        return {
          direction,
          legs: [{ symbol: sym, side: direction, stop, target, weight: 1 }],
          sizeR: 1,
          timeExitBars: params.timeExitBars ?? 10,
          gapAbandon: { type: 'atr', factor: params.gapAbandonFactor ?? 0.5 },
          gapAtrValues: { [sym]: atr },
          tags: { confirmed, volRatio: volRatio ?? null, donchian: params.donchian ?? 20 },
        };
      },

      theory({ strategyTrades }) {
        const netRs = strategyTrades.map((t) => t.netR).filter(isFiniteNum);
        const hr = hitRateNet(netRs);
        const k = netRs.filter((v) => v > 0).length;
        const bp = netRs.length >= 5 ? binomialTest(k, netRs.length, 0.5, 'greater').p : null;
        const falsified = netRs.length >= 30 && (hr === null || hr <= 0.5 || bp === null || bp >= 0.05);
        return {
          hypothesis: 'demo: 扣成本后 20 日突破动量仍有方向优势（命中率显著 > 50%）',
          metrics: { demoHitRate: hr ?? null },
          tests: [
            {
              id: 'demo-direction-edge',
              label: '扣成本命中率 > 50% 且二项检验 p < 0.05',
              falsified,
              evidence: { n: netRs.length, hitRateNet: hr, binomialP: bp },
            },
          ],
          killOn: 'demo-direction-edge 证伪 → retired（示例）',
        };
      },
    };
  },
};
