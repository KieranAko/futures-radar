// TR-06 事件冲击确认 — adapter (历史验证限 RB0/M0/SC0，D7)
// Library TR-06 verbatim. t8 records:
//  - 事件判定 F1 三条件中的『Q1 存在可识别驱动』：仓库无多年度 Q1 历史归档（仅 2026-08-27 两个 run），
//    F6 禁未来重跑 → 历史 walk-forward 只能按价格+量能两条件判定事件；Q1 项 needs-clarify（如实声明）。
//  - T1 3d p95（cap-6 cone PIT 重算）作为 50% 腿；T2 = min(2×事件区间投影, 3R) 先到者。
//  - 回踩变体入场窗取 D+1..D+6（库未写明上限，记录口径）；加仓未实现（v0 单笔，记录）。
'use strict';

const { isFiniteNum, round } = require('../util.cjs');
const { mean } = require('../stats.cjs');
const { windowMax, windowMin, cone3d } = require('./_lib.cjs');

function createAdapter({ spec, data, engine }) {
  const mode = spec.params?.mode || 'delayed'; // 'delayed' | 'chase'
  return {
    minWarmup: 60,

    initState() {
      this.eventLog = [];
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
        const prevClose = dv.at('close', idx - 1);
        const atr = gv.at('atr5', idx);
        const volRatio = gv.at('volumeRatio', idx);
        const hv20 = gv.at('hv20', idx);
        if (![close, prevClose, atr, volRatio].every(isFiniteNum) || prevClose <= 0 || atr <= 0) continue;
        if (ctx.jumpDates[sym]?.has(ctx.anchorDate)) continue;
        const st = state.perSymbol[sym] || (state.perSymbol[sym] = { events: [] });

        // 1) event detection (F1: |r_D| ≥ max(2×ATR5, 3%) ∧ 量比 ≥ 2; Q1 项历史不可评估 → needs-clarify)
        const rD = close / prevClose - 1;
        const rDInAtr = Math.abs(rD) / (atr / prevClose);
        const isEvent = Math.abs(rD) >= Math.max(2 * atr / prevClose, 0.03) && volRatio >= 2;
        if (isEvent) {
          const dir = rD > 0 ? +1 : -1;
          const highD = dv.at('high', idx);
          const lowD = dv.at('low', idx);
          const ev = {
            D: idx, date: ctx.anchorDate, dir, highD, lowD, atrD: atr,
            preLow: windowMin(dv, 'low', idx - 1, 5),
            preHigh: windowMax(dv, 'high', idx - 1, 5),
            range: highD - lowD, mid: (highD + lowD) / 2,
            rDInAtr,
          };
          st.events.push(ev);
          this.eventLog.push({ date: ctx.anchorDate, sym, dir, rD: round(rD, 6) });
        }
        st.events = st.events.filter((e) => idx - e.D <= 8);

        // 2) entries
        if (mode === 'chase') {
          // theory baseline: 当日追入 — signal at D close, fill D+1 open
          const ev = st.events[st.events.length - 1];
          if (ev && ev.D === idx) {
            const intent = this._buildIntent(ev, sym, close, hv20, 'chase');
            if (intent) { out.push(intent); st.events = []; }
          }
          continue;
        }
        for (const ev of st.events.slice()) {
          if (ev.D === idx) continue;
          const k = idx - ev.D;
          const volR = gv.at('volumeRatio', idx);
          let variant = null;
          // 确认式 (a): D+1..D+2 close > high_D ∧ 量比持续 ≥1.2
          if (k >= 1 && k <= 2 && isFiniteNum(volR) && volR >= 1.2) {
            if (ev.dir > 0 && close > ev.highD) variant = 'confirm';
            if (ev.dir < 0 && close < ev.lowD) variant = 'confirm';
          }
          // 回踩式 (b): 回撤 ≤50%（low ≥ mid）∧ 连续 2 日收盘站稳中点上方 → 第 3 日开盘
          if (!variant && k >= 2 && k <= 6) {
            const closeY = dv.at('close', idx - 1);
            if (ev.dir > 0 && windowMin(dv, 'low', idx, k) >= ev.mid && close > ev.mid && closeY > ev.mid) variant = 'pullback';
            if (ev.dir < 0 && windowMax(dv, 'high', idx, k) <= ev.mid && close < ev.mid && closeY < ev.mid) variant = 'pullback';
          }
          if (!variant) continue;
          const intent = this._buildIntent(ev, sym, close, hv20, variant);
          if (intent) {
            out.push(intent);
            st.events = []; // one entry per event
          }
        }
      }
      return out.length ? out : null;
    },

    _buildIntent(ev, sym, closeRef, hv20, variant) {
      const direction = ev.dir;
      const stopRef = variant === 'confirm' ? (direction > 0 ? ev.lowD : ev.highD) : ev.mid;
      const stop = stopRef - direction * 0.25 * ev.atrD;
      const R = Math.abs(closeRef - stop);
      if (R <= 0) return null;
      // T1 = 3d p95 平 50%（cap-6 cone PIT 重算）；T2 = min(2×事件区间投影, 3R)
      const cone = cone3d(closeRef, hv20);
      const t1Dist = cone ? (direction > 0 ? cone.p95[1] - closeRef : closeRef - cone.p95[0]) : null;
      const t2Dist = Math.min(2 * ev.range, 3 * R);
      const hasT1 = isFiniteNum(t1Dist) && t1Dist > 0;
      const legs = [];
      if (hasT1) legs.push({ symbol: sym, side: direction, stop, target: closeRef + direction * t1Dist, weight: 0.5 });
      legs.push({ symbol: sym, side: direction, stop, target: closeRef + direction * t2Dist, weight: hasT1 ? 0.5 : 1 });
      const sizeR = ev.rDInAtr >= 3 ? 1 : 0.5;
      const preLow = ev.preLow;
      const preHigh = ev.preHigh;
      const manage = (mctx) => {
        const t = mctx.trade;
        const ad = t._ad || (t._ad = { exitNextOpen: false });
        const bi = mctx.barInfo[sym];
        if (!bi) return null;
        if (ad.exitNextOpen) {
          return { exit: true, exitPrices: { [sym]: bi.open }, reason: 'F4-next-open' };
        }
        // F4: 收盘回到事件前 5 日区间内（A=0）→ 次日离场
        if (direction > 0 && bi.close < preHigh) ad.exitNextOpen = true;
        if (direction < 0 && bi.close > preLow) ad.exitNextOpen = true;
        return null;
      };
      return {
        direction,
        legs,
        sizeR,
        timeExitBars: 8,
        gapAbandon: { type: 'atr', factor: 0.75 },
        gapAtrValues: { [sym]: ev.atrD },
        tags: { variant, chase: variant === 'chase', eventDate: ev.date, rDInAtr: round(ev.rDInAtr, 3) },
        manage,
      };
    },

    theory({ spec, strategyTrades }) {
      const delayedRs = strategyTrades.filter((t) => !t.tags?.chase).map((t) => t.netR);
      let chaseMean = null;
      let chaseN = 0;
      try {
        const { Engine } = require('../engine.cjs');
        const mod = { ...spec, params: { ...spec.params, mode: 'chase' }, theoryLevel: { engine: 'none' } };
        const nested = new Engine(mod, { adapters: { 'TR-06': module.exports }, seed: 20260828 });
        const res = nested.run();
        const ch = res.trades.map((t) => t.netR);
        chaseMean = mean(ch);
        chaseN = ch.length;
      } catch (e) {
        chaseMean = null;
      }
      const delayedMean = mean(delayedRs);
      const diff = delayedMean !== null && chaseMean !== null ? delayedMean - chaseMean : null;
      const falsified = diff !== null && diff < 0.5;
      // 滚动 24 个月事件样本充分性门禁（killRules）
      const months = new Map();
      for (const e of this.eventLog) {
        const m = e.date.slice(0, 7);
        months.set(m, (months.get(m) || 0) + 1);
      }
      const monthKeys = Array.from(months.keys()).sort();
      let rolling24mMin = monthKeys.length === 0 ? 0 : null;
      for (let i = 0; i < monthKeys.length; i++) {
        const endM = new Date(Date.UTC(Number(monthKeys[i].slice(0, 4)), Number(monthKeys[i].slice(5, 7)) - 1, 1));
        let cnt = 0;
        for (const mk of monthKeys) {
          const d = new Date(Date.UTC(Number(mk.slice(0, 4)), Number(mk.slice(5, 7)) - 1, 1));
          if (d <= endM && d > new Date(endM.getTime() - 24 * 31 * 86400000)) cnt += months.get(mk);
        }
        if (rolling24mMin === null || cnt < rolling24mMin) rolling24mMin = cnt;
      }
      return {
        hypothesis: '冲击分解模型 λ/γ 区分有效（确认等待有增益 ≥ 0.5R）',
        metrics: { delayedMeanR: delayedMean, chaseMeanR: chaseMean, diffR: diff, rolling24mEventsMin: rolling24mMin },
        tests: [
          {
            id: 'tr06-confirm-wait-gain',
            label: '延迟入场（确认/回踩）− 当日追入 ≥ 0.5R',
            falsified,
            killState: 'retired',
            evidence: { delayedN: delayedRs.length, delayedMeanR: delayedMean, chaseN, chaseMeanR: chaseMean, diffR: diff },
          },
        ],
        killOn: '理论级证伪成立即 retired',
      };
    },
  };
}

module.exports = { id: 'TR-06', description: '事件冲击确认 t3 §6', createAdapter };
