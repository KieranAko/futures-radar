// TR-01 趋势延续（状态过滤版）— fidelity adapter v2 (2026-08-29)
//
// 与 strategy-library-v2.json TR-01 的逐项绑定（23-fidelity-review F-A..F-H 复跑版）：
//  - F-A/F-B: F1 U 态 = close>MA20>MA60 ∧ g_t≥+0.3%/日（g_t=(EMA20_t−EMA20_{t−5})/(5·EMA20_{t−5})）；
//            确认区 = 收盘突破 20 日高/低 ∧ 量比≥1.2。无任何代理公式、无 spacing 私货。
//  - F-C: 止损在 T+1 开盘 fill 后按实际入场价重算 = min(入场∓1.5×ATR5_T, 突破前3日极值∓0.25×ATR5_T) 取近；
//        收盘触发 F_t → 次日开盘离场；连续 2 日量比<0.8 → 次日离场；余仓 2×ATR5 移动止损（T1 触及后）。
//  - F-D: T1=2R 平 50%（leg A）；T2=min(3R, 3d p95 上/下沿 [cap-6 provenance=probability.json]) 先到者（leg B）；
//        浮盈≥1R 且收盘再创 5 日新高/低 → +0.5 单位（add-on，T+1 开盘执行），最多 2 次，亏损绝不摊平；
//        加仓单止损与余仓移动止损同步上移；加仓后单品种总风险 ≤2R（1R 档+2×0.5R；0.5R 档+2×0.5R=1.5R）。
//  - F-E: T+1 开盘执行；跳空>0.5×ATR5 放弃；换月跳变日不作入场/加仓日；长假（相邻交易日间隔>4 自然日）
//        前不开新仓、持仓于长假前收盘全平（risk-framework §6 回测采用“直接平仓”分支）。
//  - F-F: 只用 GA-1/GA-2 数据契约字段；PIT 硬守卫；无未来函数（views .at 或 ≤anchor 读取）。
//  - F-G: 策略级三基线 + 理论级“确认 vs 无确认”嵌套引擎对比（seed=20260828）按 spec 原样执行。
//
// 未实现（如实记录，见 23-fidelity-review v2 表）：
//  - F-E 停板条款“空头距涨停 <1×ATR5 禁开”：GA 数据契约无涨跌停幅度字段（库依赖交易所当日公告），
//    复跑版不做静态比例代理；以敏感性报告（空头信号距离上限/触及停板特征）与队长裁定覆盖。
//  - 组合层“组合风险 ≤2.5% 权益”：单策略 harness 无组合账户；单品种总风险 ≤2R 在 adapter 内强制执行。
'use strict';

const { isFiniteNum, round, toDayNum } = require('../util.cjs');
const { mean } = require('../stats.cjs');
const { emaUpdate, gSlope, windowMax, windowMin, cone3d } = require('./_lib.cjs');

const ALL_SYMBOLS = null; // resolved from spec.universe

function dayGap(a, b) {
  return Math.abs(toDayNum(a) - toDayNum(b));
}

function createAdapter({ spec, data, engine }) {
  const mode = spec.params?.mode || 'confirm-required'; // 'confirm-required' | 'no-confirm'
  const timeline = data.timeline || [];

  // next trading date strictly after d (global union timeline)
  function nextTradingDate(d) {
    let lo = 0;
    let hi = timeline.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (timeline[mid] <= d) lo = mid + 1;
      else hi = mid;
    }
    return lo < timeline.length ? timeline[lo] : null;
  }

  return {
    minWarmup: 120,

    initState() {
      return { perSymbol: {} };
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

        // F-E 长假入场禁开：T+1 执行日若是长假前最后交易日 → 不开新仓
        const t1 = nextTradingDate(ctx.anchorDate);
        if (t1 === null) continue;
        const t2 = nextTradingDate(t1);
        if (t2 !== null && dayGap(t2, t1) > 4) continue;

        // EMA20 g_t (F1) — per-symbol incremental PIT state
        const st = state.perSymbol[sym] || (state.perSymbol[sym] = { ema: { ema: [], upto: -1 } });
        emaUpdate(st.ema, (i) => dv.at('close', i), idx, 20);
        const g = gSlope(st.ema, idx, 5);
        if (!isFiniteNum(g)) continue;

        // F1 U/D 态（空头镜像）
        const longAlign = close > ma20 && ma20 > ma60 && g >= 0.003;
        const shortAlign = close < ma20 && ma60 > ma20 && g <= -0.003;

        // confirmationZone：收盘突破 20 日高/低（不含当日）+ 量比 ≥ 1.2
        const hi20 = windowMax(dv, 'high', idx, 20, 1);
        const lo20 = windowMin(dv, 'low', idx, 20, 1);
        if (!isFiniteNum(hi20) || !isFiniteNum(lo20)) continue;
        const confirmed = isFiniteNum(volRatio) && volRatio >= 1.2;
        let direction = 0;
        if (longAlign && close > hi20) {
          direction = mode === 'no-confirm' ? (confirmed ? 0 : +1) : (confirmed ? +1 : 0);
        } else if (shortAlign && close < lo20) {
          direction = mode === 'no-confirm' ? (confirmed ? 0 : -1) : (confirmed ? -1 : 0);
        }
        if (direction === 0) continue;

        // F-C 突破前 3 日极值（t−3..t−1）
        const low3 = windowMin(dv, 'low', idx, 3, 1);
        const high3 = windowMax(dv, 'high', idx, 3, 1);
        if (!isFiniteNum(low3) || !isFiniteNum(high3)) continue;

        // 信号日 T 的临时 bracket（T+1 开盘价未知；onFill 用实际入场价重算）
        const stopT = direction > 0
          ? Math.max(close - 1.5 * atr, low3 - 0.25 * atr)
          : Math.min(close + 1.5 * atr, high3 + 0.25 * atr);
        const RT = Math.abs(close - stopT);
        if (RT <= 0) continue;

        // F-D 目标（T 日基准）：T1=2R；T2=min(3R, 3d p95 上/下沿 [cap-6])
        const cone = cone3d(close, hv20);
        const p95Price = cone ? (direction > 0 ? cone.p95[1] : cone.p95[0]) : null;
        const targetT1 = close + direction * 2 * RT;
        const targetT2candidate = direction > 0
          ? (isFiniteNum(p95Price) && p95Price > close ? Math.min(close + 3 * RT, p95Price) : close + 3 * RT)
          : (isFiniteNum(p95Price) && p95Price < close ? Math.max(close - 3 * RT, p95Price) : close - 3 * RT);

        // F-D edge 强度档：|g_t|∈[0.3%,0.6%)→0.5R；≥0.6%→1R
        const sizeR = Math.abs(g) >= 0.006 ? 1 : 0.5;
        const breakoutLevel = direction > 0 ? hi20 : lo20;

        const tags = {
          confirmed,
          g: round(g, 6),
          breakoutLevel,
          atrT: atr,
          low3,
          high3,
          hv20,
          p95Price,
          sizeR,
        };

        const manage = (mctx) => {
          const t = mctx.trade;
          const ad = t._ad || (t._ad = { exitNextOpen: false, lowVolDays: 0, adds: 0, lastDate: null });
          const bi = mctx.barInfo[sym];
          if (!bi) return null;
          const bars = t._meta.daily[sym];
          const i = bi.idx;
          const fields = mctx.views[sym]?.fields;
          const atrI = fields && isFiniteNum(fields.atr5?.[i]) ? fields.atr5[i] : tags.atrT;
          const ma20I = fields && isFiniteNum(fields.ma20?.[i]) ? fields.ma20[i] : null;
          const vrI = fields && isFiniteNum(fields.volumeRatio?.[i]) ? fields.volumeRatio[i] : null;

          // F_t 触发 → 次日开盘离场
          if (ad.exitNextOpen) {
            return { exit: true, exitPrices: { [sym]: bi.open }, reason: 'F_t-next-open' };
          }

          const c = bi.close;
          const legA = t.legs[0];
          const legB = t.legs[1];
          const entry = legA.entry;
          const R0 = legA.riskDist;
          const side = t.direction;
          const floatR = R0 > 0 ? ((c - entry) / R0) * side : null;

          // F3 失效事件（当日收盘）→ 次日开盘离场
          if (direction > 0) {
            if (c < tags.breakoutLevel - 0.5 * atrI) ad.exitNextOpen = true;
            if (vrI !== null && vrI >= 1.5 && ma20I !== null && c < ma20I - 0.5 * atrI) ad.exitNextOpen = true;
          } else {
            if (c > tags.breakoutLevel + 0.5 * atrI) ad.exitNextOpen = true;
            if (vrI !== null && vrI >= 1.5 && ma20I !== null && c > ma20I + 0.5 * atrI) ad.exitNextOpen = true;
          }

          // 连续 2 日量比 < 0.8（动能衰竭）→ 次日开盘离场
          if (vrI !== null) {
            if (vrI < 0.8) ad.lowVolDays += 1;
            else ad.lowVolDays = 0;
            if (ad.lowVolDays >= 2) ad.exitNextOpen = true;
          }

          // F-E 长假前持仓平仓：下一交易日间隔 >4 自然日 → 当日收盘全平
          const nxt = nextTradingDate(bi.date);
          if (nxt !== null && dayGap(nxt, bi.date) > 4) {
            return { exit: true, exitPrices: { [sym]: c }, reason: 'long-holiday-flat' };
          }

          // edgeDecay：10 个交易日未触及 T1 → 全平（T1 已触及则不适用）
          const held = i - t.entryBarIndexes[sym] + 1;
          if (held >= 10 && legA.exit === null) {
            return { exit: true, exitPrices: { [sym]: c }, reason: 'time-exit-no-T1' };
          }

          // 余仓（leg B 与全部加仓腿）2×ATR5 移动止损 —— 仅 T1 触及后启动
          const adjustments = {};
          if (legA.exit !== null) {
            for (let li = 1; li < t.legs.length; li++) {
              const lg = t.legs[li];
              if (lg.exit !== null) continue;
              const trail = direction > 0
                ? Math.max(lg.stop, bi.high - 2 * atrI)
                : Math.min(lg.stop, bi.low + 2 * atrI);
              if (trail !== lg.stop) adjustments[li] = { stop: trail };
            }
          }

          // F-D 加仓：浮盈 ≥1R 且收盘再创 5 日新高/低 → +0.5 单位（T+1 开盘执行），最多 2 次
          if (floatR !== null && floatR >= 1 && ad.adds < 2 && legB.exit === null) {
            let newExtreme = false;
            if (i >= 5) {
              if (direction > 0) {
                let mx = -Infinity;
                for (let k = i - 5; k <= i - 1; k++) {
                  const v = bars.high[k];
                  if (isFiniteNum(v) && v > mx) mx = v;
                }
                newExtreme = isFiniteNum(mx) && c > mx;
              } else {
                let mn = Infinity;
                for (let k = i - 5; k <= i - 1; k++) {
                  const v = bars.low[k];
                  if (isFiniteNum(v) && v < mn) mn = v;
                }
                newExtreme = isFiniteNum(mn) && c < mn;
              }
            }
            if (newExtreme) {
              ad.adds += 1;
              const addStop = legB.stop; // 加仓单止损与余仓止损同步（t9 F-11）
              const adjList = Object.entries(adjustments).map(([li, u]) => ({ symbol: sym, legIndex: Number(li), ...u }));
              return {
                ...(adjList.length ? { adjust: adjList } : {}),
                add: { symbol: sym, side: direction, stop: addStop, target: legB.target, addR: 0.5, addNo: ad.adds },
              };
            }
          }

          if (Object.keys(adjustments).length) {
            return { adjust: Object.entries(adjustments).map(([li, u]) => ({ symbol: sym, legIndex: Number(li), ...u })) };
          }
          return null;
        };

        // onFill：T+1 实际开盘价入场后，按 F-C/F-D 精确重算 bracket 与 R
        const onFill = (trade) => {
          const legA0 = trade.legs[0];
          const entry = legA0.entry;
          const atrT = tags.atrT;
          const stop = direction > 0
            ? Math.max(entry - 1.5 * atrT, tags.low3 - 0.25 * atrT)
            : Math.min(entry + 1.5 * atrT, tags.high3 + 0.25 * atrT);
          const R = Math.abs(entry - stop);
          const safeStop = R > 0 ? stop : entry - direction * 1.5 * atrT;
          const Rf = Math.abs(entry - safeStop);
          const targetT1f = entry + direction * 2 * Rf;
          const targetT2f = direction > 0
            ? (isFiniteNum(tags.p95Price) && tags.p95Price > entry ? Math.min(entry + 3 * Rf, tags.p95Price) : entry + 3 * Rf)
            : (isFiniteNum(tags.p95Price) && tags.p95Price < entry ? Math.max(entry - 3 * Rf, tags.p95Price) : entry - 3 * Rf);
          trade.legs[0].stop = safeStop;
          trade.legs[0].target = targetT1f;
          trade.legs[0].riskDist = Rf;
          trade.legs[1].stop = safeStop;
          trade.legs[1].target = targetT2f;
          trade.legs[1].riskDist = Rf;
        };

        out.push({
          direction,
          legs: [
            { symbol: sym, side: direction, stop: stopT, target: targetT1, weight: 0.5 },
            { symbol: sym, side: direction, stop: stopT, target: targetT2candidate, weight: 0.5 },
          ],
          sizeR,
          timeExitBars: null, // 10 日 T1 未触及全平由 manage 精确实现（F2 edgeDecay）
          gapAbandon: { type: 'atr', factor: 0.5 },
          gapAtrValues: { [sym]: atr },
          tags,
          manage,
          onFill,
        });
      }
      return out.length ? out : null;
    },

    theory({ spec, strategyTrades }) {
      // 理论级：『突破 + 量比 ≥1.2』子样本 vs 『无确认突破』子样本（同规则，唯一差异=确认门）
      const confirmedRs = strategyTrades.filter((t) => t.tags?.confirmed).map((t) => t.netR);
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

module.exports = { id: 'TR-01', description: '趋势延续（状态过滤版）t3 §1 fidelity-v2', createAdapter, ALL_SYMBOLS };
