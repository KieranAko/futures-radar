// TR-03 趋势回踩续势（趋势 + OU 噪声分解）— adapter
// Library TR-03 marketModel/pricingModel/strategy verbatim. t8 records:
//  - T1 = 前期波段高/低 (max/min high/low over prior 20 bars) 或 3d p68 先到者（cone PIT 重算）。
//  - T2 区间 2R–3R → 取 2R（保守下界；库未冻结初值，记录 needs-clarify）。
//  - 回踩极值 = 近 5 bar 极值（[t−4..t]）；止损距离门 ≤1.5×ATR5（R=ATR5 口径）。
//  - 加仓（+0.5 单位 ×1）未实现（v0 单笔，记录）。
'use strict';

const { isFiniteNum, round } = require('../util.cjs');
const { mean } = require('../stats.cjs');
const { windowMax, windowMin, cone3d } = require('./_lib.cjs');

function createAdapter({ spec, data, engine }) {
  const mode = spec.params?.mode || 'confirm-required'; // 'confirm-required' | 'no-confirm' | 'tightened'（R2 队长终裁：收紧距离门槛重验，门槛=params.tightenedGateAtr，默认 1.0×ATR5）
  return {
    minWarmup: 120,

    initState() {
      return { perSymbol: {}, signalLog: [] };
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
        if (![close, ma20, ma60, atr].every(isFiniteNum) || atr <= 0) continue;
        if (ctx.jumpDates[sym]?.has(ctx.anchorDate)) continue;
        const st = state.perSymbol[sym] || (state.perSymbol[sym] = { lastEntryIdx: -Infinity });
        if (idx - st.lastEntryIdx < 2) continue;
        // U 态（本条独立计算）: close>MA20>MA60（多）镜像（空）
        const longAlign = close > ma20 && ma20 > ma60;
        const shortAlign = close < ma20 && ma60 > ma20;
        const band = 0.25 * atr;
        const low = dv.at('low', idx);
        const high = dv.at('high', idx);
        const prevHigh = dv.at('high', idx - 1);
        const prevLow = dv.at('low', idx - 1);
        const vrOk = isFiniteNum(volRatio) && volRatio >= 0.8 && volRatio <= 1.5;
        let direction = 0;
        if (longAlign && isFiniteNum(low) && low <= ma20 + band) {
          const kConfirm = isFiniteNum(prevHigh) && close > prevHigh;
          direction = mode === 'no-confirm' ? (vrOk ? +1 : 0) : (vrOk && kConfirm ? +1 : 0);
        } else if (shortAlign && isFiniteNum(high) && high >= ma20 - band) {
          const kConfirm = isFiniteNum(prevLow) && close < prevLow;
          direction = mode === 'no-confirm' ? (vrOk ? -1 : 0) : (vrOk && kConfirm ? -1 : 0);
        }
        if (direction === 0) continue;
        // 回踩极值∓0.25×ATR5；距离门 ≤1.5R（R=ATR5）
        const swingLo5 = windowMin(dv, 'low', idx, 5);
        const swingHi5 = windowMax(dv, 'high', idx, 5);
        let stop;
        if (direction > 0) stop = swingLo5 - band;
        else stop = swingHi5 + band;
        if (!isFiniteNum(stop)) continue;
        const dist = Math.abs(close - stop);
        const distGate = mode === 'tightened' ? (params.tightenedGateAtr ?? 1.0) : 1.5;
        if (dist > distGate * atr) continue; // 止损距离 > 门槛(R=ATR5 口径) → 放弃该笔（收紧后重验用 tightenedGateAtr）
        if (dist <= 0) continue;
        // T1 = 前期波段高/低 or 3d p68 先到者；T2 = 2R
        const swing = direction > 0 ? windowMax(dv, 'high', idx, 20, 1) : windowMin(dv, 'low', idx, 20, 1);
        const cone = cone3d(close, hv20);
        const p68Dist = cone ? (direction > 0 ? cone.p68[1] - close : close - cone.p68[0]) : null;
        const t1Dist = Math.min(isFiniteNum(swing) && swing * direction > close * direction ? Math.abs(swing - close) : Infinity,
          isFiniteNum(p68Dist) && p68Dist > 0 ? p68Dist : Infinity);
        if (!isFiniteNum(t1Dist) || t1Dist <= 0) continue;
        const t2Dist = 2 * dist;
        const depth = direction > 0 ? Math.max(0, ma20 - low) : Math.max(0, high - ma20);
        const sizeR = depth / atr >= 1 ? 1 : 0.5;
        st.lastEntryIdx = idx;
        state.signalLog.push({ date: ctx.anchorDate, sym, direction, depth, atr, dist });
        const manage = (mctx) => {
          const t = mctx.trade;
          const ad = t._ad || (t._ad = { exitNextOpen: false });
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
          // F_t (F3): 放量（≥1.5）跌破 MA20−0.5×ATR5
          if (direction > 0 && vrI >= 1.5 && c < ma20I - 0.5 * atrI) ad.exitNextOpen = true;
          if (direction < 0 && vrI >= 1.5 && c > ma20I + 0.5 * atrI) ad.exitNextOpen = true;
          // 余仓 1×ATR5 移动止损（leg B）
          const trail = direction > 0
            ? Math.max(t.legs[1].stop, bi.high - atrI)
            : Math.min(t.legs[1].stop, bi.low + atrI);
          if (trail !== t.legs[1].stop) {
            return { adjust: { [sym]: { stop: trail, legIndex: 1 } } };
          }
          return null;
        };
        out.push({
          direction,
          legs: [
            { symbol: sym, side: direction, stop, target: close + direction * t1Dist, weight: 0.5 },
            { symbol: sym, side: direction, stop, target: close + direction * t2Dist, weight: 0.5 },
          ],
          sizeR,
          timeExitBars: 8,
          gapAbandon: { type: 'atr', factor: 0.75 },
          gapAtrValues: { [sym]: atr },
          tags: { confirmed: mode !== 'no-confirm', mode, depthRatio: round(depth / atr, 4) },
          manage,
        });
      }
      return out.length ? out : null;
    },

    theory({ spec, strategyTrades, foldResults }) {
      const confirmedRs = strategyTrades.filter((t) => t.tags?.confirmed).map((t) => t.netR);
      let noConfirmMean = null;
      let noConfirmN = 0;
      try {
        const { Engine } = require('../engine.cjs');
        const mod = { ...spec, params: { ...spec.params, mode: 'no-confirm' }, theoryLevel: { engine: 'none' } };
        const nested = new Engine(mod, { adapters: { 'TR-03': module.exports }, seed: 20260828 });
        const res = nested.run();
        const nc = res.trades.map((t) => t.netR);
        noConfirmMean = mean(nc);
        noConfirmN = nc.length;
      } catch (e) {
        noConfirmMean = null;
      }
      const confirmedMean = mean(confirmedRs);
      // ① 确认子样本 ≤ 无确认子样本 → 噪声耗尽确认无效
      const falsified1 = confirmedMean !== null && noConfirmMean !== null && confirmedMean <= noConfirmMean;
      // ②（R2，t9 复核修订）：库原文『止损距离>1.5R 的子样本 PF<1 → 收紧距离门槛后重验』；
      //    该子样本按规则（>1.5R 即放弃）恒为空 → 第一步 vacuous（如实记录）；第二步按库原文
      //    执行『收紧距离门槛后重验』：嵌套 run 以 1.0×ATR5 门槛重跑（R2 队长终裁）。
      const wins = confirmedRs.filter((v) => v > 0).reduce((a, b) => a + b, 0);
      const losses = confirmedRs.filter((v) => v < 0).reduce((a, b) => a + Math.abs(b), 0);
      const pf = losses > 0 ? wins / losses : wins > 0 ? Infinity : 0;
      const falsified2 = confirmedRs.length >= 30 && pf < 1;
      // R2 队长终裁：收紧后重验（库第二步）——1.0×ATR5 门槛子样本
      let tightenedN = 0;
      let tightenedPF = null;
      try {
        const { Engine } = require('../engine.cjs');
        const modT = { ...spec, params: { ...spec.params, mode: 'tightened', tightenedGateAtr: 1.0 }, theoryLevel: { engine: 'none' } };
        const nestedT = new Engine(modT, { adapters: { 'TR-03': module.exports }, seed: 20260828 });
        const resT = nestedT.run();
        const rsT = resT.trades.map((t) => t.netR);
        const wT = rsT.filter((v) => v > 0).reduce((a, b) => a + b, 0);
        const lT = rsT.filter((v) => v < 0).reduce((a, b) => a + Math.abs(b), 0);
        tightenedN = rsT.length;
        tightenedPF = lT > 0 ? wT / lT : wT > 0 ? Infinity : 0;
      } catch (e) {
        tightenedPF = null;
      }
      const falsified2Final = falsified2 || (tightenedN >= 30 && tightenedPF !== null && tightenedPF < 1);
      // kill: 连续 2 个滚动窗口命中率 < 50%
      let consecFail = 0;
      let maxConsecFail = 0;
      for (const f of foldResults || []) {
        const trades = strategyTrades.filter((t) => t.foldId === f.fold);
        if (trades.length === 0) continue;
        const hit = trades.filter((t) => t.netR > 0).length / trades.length;
        if (hit < 0.5) { consecFail += 1; maxConsecFail = Math.max(maxConsecFail, consecFail); }
        else consecFail = 0;
      }
      return {
        hypothesis: '噪声耗尽确认有效（θ 定价正确）',
        metrics: {
          confirmedMeanR: confirmedMean, noConfirmMeanR: noConfirmMean,
          pfExecuted: pf === Infinity ? 'Inf' : round(pf, 4),
          maxConsecFoldHitFail: maxConsecFail,
        },
        tests: [
          {
            id: 'tr03-confirm-gain',
            label: '①『回踩+反转确认』收益 > 『回踩无确认』收益',
            falsified: falsified1,
            killState: 'retired',
            evidence: { confirmedN: confirmedRs.length, confirmedMeanR: confirmedMean, noConfirmN, noConfirmMeanR: noConfirmMean },
          },
          {
            id: 'tr03-stop-distance-pricing',
            label: '② 止损距离>1.5R 子样本（按规则为空，第一步 vacuous）+ 收紧 1.0×ATR5 门槛重验 PF ≥ 1',
            falsified: falsified2Final,
            killState: 'retired',
            evidence: {
              step1: { note: '>1.5R 子样本按执行规则在入场前即被放弃，恒为空，第一步 vacuous', vacuous: true },
              step2: { note: '收紧距离门槛至 1.0×ATR5 重验（嵌套 run，seed=20260828，R2 队长终裁按库原文执行）', tightenedN, tightenedPF },
              executedSetPF: pf,
              executedSetN: confirmedRs.length,
              conclusion: falsified2Final ? '收紧后重验 PF<1 → 仍不达标 → retired' : '收紧后重验达标 → 不触发 retired',
            },
          },
        ],
        killOn: '任一理论级证伪成立即 retired；连续 2 个滚动窗口命中率 < 50% → suspended（killRules）',
      };
    },
  };
}

module.exports = { id: 'TR-03', description: '趋势回踩续势 t3 §3', createAdapter };
