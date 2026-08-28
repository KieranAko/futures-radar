// TR-01 趋势延续（状态过滤版）— adapter for the falsification harness
// Formulas verbatim from strategy-library-v2.json TR-01 marketModel/pricingModel/strategy.
// Implementation notes (t8 record):
//  - EMA20 g_t: GA-2 did not ship EMA20 → computed PIT in-adapter from GA-1 closes (library F1).
//  - T2 cone: probability-cone.js (cap-6) recomputed PIT at T from close_T + hv20_T (F8 延伸).
//  - stop0 reference: entry price unknown at signal time → stop computed on T close; gap-abandon
//    cap (0.5×ATR5) bounds the T+1 open error. (recorded approximation)
//  - Add-on rules (+0.5 单位 ×2) not implemented (single-entry v0; needs-clarify note).
'use strict';

const { isFiniteNum, round } = require('../util.cjs');
const { mean } = require('../stats.cjs');
const { emaUpdate, emaAt, gSlope, windowMax, windowMin, cone3d } = require('./_lib.cjs');

const ALL_SYMBOLS = null; // resolved from spec.universe

function createAdapter({ spec, data, engine }) {
  const mode = spec.params?.mode || 'confirm-required'; // 'confirm-required' | 'no-confirm'
  return {
    minWarmup: 120,

    initState() {
      return { perSymbol: {}, lastEntryIdx: -Infinity };
    },

    evalBar(ctx, state, params) {
      const out = [];
      for (const sym of spec.universe.symbols) {
        if (!ctx.barToday[sym]) continue;
        const idx = ctx.anchorIdxBySymbol[sym];
        if (idx === null || idx < this.minWarmup) continue;
        const dv = ctx.daily[sym];
        const gv = ctx.derived[sym];
        const close = dv.at('close', idx);
        const ma20 = gv.at('ma20', idx);
        const ma60 = gv.at('ma60', idx);
        const atr = gv.at('atr5', idx);
        const volRatio = gv.at('volumeRatio', idx);
        const hv20 = gv.at('hv20', idx);
        if (![close, ma20, ma60, atr, volRatio].every(isFiniteNum) || atr <= 0) continue;
        if (ctx.jumpDates[sym]?.has(ctx.anchorDate)) continue;
        // EMA20 slope g_t (F1) — per-symbol incremental state
        const st = state.perSymbol[sym] || (state.perSymbol[sym] = { ema: { ema: [], upto: -1 }, lastEntryIdx: -Infinity });
        if (idx - st.lastEntryIdx < 2) continue; // spacing guard (same-symbol)
        emaUpdate(st.ema, (i) => dv.at('close', i), idx, 20);
        const g = gSlope(st.ema, idx, 5);
        if (!isFiniteNum(g)) continue;
        // U state (F1)
        const longAlign = close > ma20 && ma20 > ma60 && g >= 0.003;
        const shortAlign = close < ma20 && ma60 > ma20 && g <= -0.003;
        // breakout (20d, excluding today)
        const hi20 = windowMax(dv, 'high', idx, 20, 1);
        const lo20 = windowMin(dv, 'low', idx, 20, 1);
        if (!isFiniteNum(hi20) || !isFiniteNum(lo20)) continue;
        let direction = 0;
        const confirmed = isFiniteNum(volRatio) && volRatio >= 1.2;
        if (longAlign && close > hi20) {
          direction = mode === 'no-confirm' ? (confirmed ? 0 : +1) : (confirmed ? +1 : 0);
        } else if (shortAlign && close < lo20) {
          direction = mode === 'no-confirm' ? (confirmed ? 0 : -1) : (confirmed ? -1 : 0);
        }
        if (direction === 0) continue;
        // stop0 = min(entryRef ∓ 1.5×ATR5, 突破前 3 日极值 ∓ 0.25×ATR5) 取近 (F3)
        const low3 = windowMin(dv, 'low', idx, 3, 1);   // 突破前 3 日（t−3..t−1）
        const high3 = windowMax(dv, 'high', idx, 3, 1);
        let stop;
        if (direction > 0) {
          const s1 = close - 1.5 * atr;
          const s2 = low3 - 0.25 * atr;
          stop = Math.max(s1, s2); // 取近（closer to price）
        } else {
          const s1 = close + 1.5 * atr;
          const s2 = high3 + 0.25 * atr;
          stop = Math.min(s1, s2);
        }
        const R = Math.abs(close - stop);
        if (R <= 0) continue;
        // targets: T1 = 2R 平 50%；T2 = 3R 或 3d p95 先到者
        const cone = cone3d(close, hv20);
        const coneBand = cone ? (direction > 0 ? cone.p95[1] - close : close - cone.p95[0]) : null;
        const t2Dist = Math.min(3 * R, isFiniteNum(coneBand) && coneBand > 0 ? coneBand : 3 * R);
        const sizeR = Math.abs(g) >= 0.006 ? 1 : 0.5;
        st.lastEntryIdx = idx;
        const breakoutLevel = direction > 0 ? hi20 : lo20;
        const manage = (mctx) => {
          const t = mctx.trade;
          const ad = t._ad || (t._ad = { exitNextOpen: false, lowVolDays: 0 });
          const bi = mctx.barInfo[sym];
          if (!bi) return null;
          if (ad.exitNextOpen) {
            return { exit: true, exitPrices: { [sym]: bi.open }, reason: 'F_t-next-open' };
          }
          const fields = mctx.views[sym]?.fields;
          const i = bi.idx;
          if (!fields || !isFiniteNum(fields.atr5?.[i]) || !isFiniteNum(fields.ma20?.[i]) || !isFiniteNum(fields.volumeRatio?.[i])) return null;
          const c = bi.close;
          const atrI = fields.atr5[i];
          const ma20I = fields.ma20[i];
          const vrI = fields.volumeRatio[i];
          // F_t (F3): 收盘回破突破位 0.5×ATR5 ∨ (量比≥1.5 ∧ 收盘<MA20−0.5×ATR5)
          if (direction > 0) {
            if (c < breakoutLevel - 0.5 * atrI) ad.exitNextOpen = true;
            if (vrI >= 1.5 && c < ma20I - 0.5 * atrI) ad.exitNextOpen = true;
          } else {
            if (c > breakoutLevel + 0.5 * atrI) ad.exitNextOpen = true;
            if (vrI >= 1.5 && c > ma20I + 0.5 * atrI) ad.exitNextOpen = true;
          }
          // 连续 2 日量比 < 0.8 → 次日离场
          if (vrI < 0.8) ad.lowVolDays += 1; else ad.lowVolDays = 0;
          if (ad.lowVolDays >= 2) ad.exitNextOpen = true;
          // 余仓（leg B）2×ATR5 移动止损
          const trail = direction > 0
            ? Math.max(t.legs[1].stop, bi.high - 2 * atrI)
            : Math.min(t.legs[1].stop, bi.low + 2 * atrI);
          if (trail !== t.legs[1].stop) {
            return { adjust: { [sym]: { stop: trail, legIndex: 1 } } };
          }
          return null;
        };
        out.push({
          direction,
          legs: [
            { symbol: sym, side: direction, stop, target: close + direction * 2 * R, weight: 0.5 },
            { symbol: sym, side: direction, stop, target: close + direction * t2Dist, weight: 0.5 },
          ],
          sizeR,
          timeExitBars: 10,
          gapAbandon: { type: 'atr', factor: 0.5 },
          gapAtrValues: { [sym]: atr },
          tags: { confirmed, g: round(g, 6), breakoutLevel, mode },
          manage,
        });
      }
      return out.length ? out : null;
    },

    theory({ spec, strategyTrades }) {
      // 理论级：『突破 + 量比 ≥1.2』子样本 vs 『无确认突破』子样本
      const confirmedRs = strategyTrades.filter((t) => t.tags?.confirmed).map((t) => t.netR);
      // nested engine run for the no-confirm subsample
      let noConfirmMean = null;
      let noConfirmN = 0;
      try {
        const { Engine } = require('../engine.cjs');
        const mod = { ...spec, params: { ...spec.params, mode: 'no-confirm' }, theoryLevel: { engine: 'none' } };
        const nested = new Engine(mod, { adapters: { 'TR-01': module.exports }, seed: 20260828 });
        const res = nested.run();
        const nc = res.trades.map((t) => t.netR);
        noConfirmMean = mean(nc);
        noConfirmN = nc.length;
      } catch (e) {
        noConfirmMean = null;
      }
      const confirmedMean = mean(confirmedRs);
      const falsified = confirmedMean !== null && noConfirmMean !== null && confirmedMean <= noConfirmMean;
      return {
        hypothesis: '信息确认机制有效（确认子样本扣成本收益 > 无确认子样本）',
        metrics: { confirmedMeanR: confirmedMean, noConfirmMeanR: noConfirmMean },
        tests: [
          {
            id: 'tr01-info-confirmation',
            label: '『突破+量比≥1.2』收益 > 『无确认突破』收益',
            falsified,
            killState: 'retired',
            evidence: {
              confirmedN: confirmedRs.length, confirmedMeanR: confirmedMean,
              noConfirmN, noConfirmMeanR: noConfirmMean,
              note: '无确认子样本 = 同规则但量比 < 1.2 的突破（嵌套 engine run，seed=20260828）',
            },
          },
        ],
        killOn: '理论级证伪成立即 retired',
      };
    },
  };
}

module.exports = { id: 'TR-01', description: '趋势延续（状态过滤版）t3 §1', createAdapter, ALL_SYMBOLS };
