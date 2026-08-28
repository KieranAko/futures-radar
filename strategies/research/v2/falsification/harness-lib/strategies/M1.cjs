// M1 DR007 流动性冲击（信用渠道 → 国内需求型板块）— adapter
// Library M1 verbatim. t8 records:
//  - 只用 FDR007 段（≥2017-05-31；walk-forward 2019-01 起，拼接纪律 t7-D 自动满足）。
//  - β̂_i 滚动标定：r_{t+1:t+10} ~ s_t 的 250 观测滚动 OLS，只用 fwd 窗口已封闭的观测（t+10 ≤ T，F8）。
//  - 篮子：黑色(RB0/HC0/J0) 与 建材(SA0/FG0) 各取 |β̂| 最强 1 个，合成 1 个双腿 intent（篮子豁免 t9 F-03）。
//  - 冲击消化 |s_t|<0.3pp 为 edge 衰减点（manage：DR007 序列按 date ≤ 当前 bar 取 PIT）。
'use strict';

const { isFiniteNum, round } = require('../util.cjs');
const S = require('../stats.cjs');
const { mean } = require('../stats.cjs');

const BLACK = ['RB0', 'HC0', 'J0'];
const BUILD = ['SA0', 'FG0'];
const BETA_W = 250;

function createAdapter({ spec, data, engine }) {
  const barIdx = data.barIndexBySymbol;
  const dr = data.macro.DR007; // {dates, values} full series; PIT filter by date ≤ anchor
  return {
    minWarmup: 300,

    initState() {
      return { lastEntryDate: null };
    },

    _sAt(date, offsetBars = 0) {
      // Δ5d DR007 as of `date` (offsetBars back within DR007 series; loader shape: series=[{date,value}])
      const ser = dr.series;
      let i = ser.length - 1;
      while (i >= 0 && ser[i].date > date) i--;
      const idx = i - offsetBars;
      if (idx < 5) return null;
      const v0 = ser[idx].value;
      const v5 = ser[idx - 5].value;
      if (!isFiniteNum(v0) || !isFiniteNum(v5)) return null;
      return v0 - v5;
    },

    _betaOf(sym, Tdate, Tidx) {
      // rolling OLS: fwd10ret_t ~ s_t, t+10 ≤ Tidx（对齐 DR007 交易日）
      const d = data.dailyBySymbol[sym];
      const xs = [];
      const ys = [];
      for (let t = Math.max(this.minWarmup, Tidx - BETA_W - 10); t + 10 <= Tidx && t <= Tidx - 10; t++) {
        if (t >= d.dates.length) break;
        const s = this._sAt(d.dates[t]);
        if (s === null) continue;
        const p0 = d.close[t];
        const p1 = d.close[t + 10];
        if (!isFiniteNum(p0) || !isFiniteNum(p1) || p0 <= 0) continue;
        xs.push(s);
        ys.push(p1 / p0 - 1);
      }
      if (xs.length < 30) return null;
      const r = S.ols(xs, ys);
      return r; // {beta, ...}
    },

    evalBar(ctx, state, params) {
      const out = [];
      const date = ctx.anchorDate;
      const s = this._sAt(date);
      if (s === null || Math.abs(s) < 0.5) return null;
      if (state.lastEntryDate && state.lastEntryDate === date) return null;
      const direction = s >= 0.5 ? -1 : +1; // 急升 → 空；急降 → 多
      const pick = (pool) => {
        let best = null;
        for (const sym of pool) {
          if (!ctx.barToday[sym]) continue;
          const idx = ctx.anchorIdxBySymbol[sym];
          if (idx === null || idx < this.minWarmup) continue;
          const dv = ctx.daily[sym];
          const gv = ctx.derived[sym];
          const close = dv.at('close', idx);
          const ma20 = gv.at('ma20', idx);
          const ma60 = gv.at('ma60', idx);
          const atr = gv.at('atr5', idx);
          if (![close, ma20, ma60, atr].every(isFiniteNum) || atr <= 0) continue;
          // F3 方向门禁：信号与价格确认同向
          if (direction < 0 && !(close <= ma20 && close <= ma60)) continue;
          if (direction > 0 && !(close >= ma20 && close >= ma60)) continue;
          if (ctx.jumpDates[sym]?.has(date)) continue;
          const beta = this._betaOf(sym, date, idx);
          if (!beta || !isFiniteNum(beta.beta)) continue;
          // R8 队长终裁（2026-08-28）：入池门 β̂<0——方向与理论一致（信用渠道传导）才交易；
          // β̂≥0 的品种不入池（修正库 F2 预期 β_i<0 与 direction『|β̂| 最强』的矛盾，非调参）
          if (beta.beta >= 0) continue;
          const score = Math.abs(beta.beta);
          if (!best || score > best.score) {
            best = { sym, idx, close, atr, hv: gv.at('hv20', idx), beta: beta.beta, score };
          }
        }
        return best;
      };
      const legA = pick(BLACK);
      const legB = pick(BUILD);
      if (!legA || !legB) return null;
      const legs = [];
      const addLeg = (l) => {
        const stop = l.close - direction * 1.5 * l.atr;
        const target = l.close + direction * 2.0 * l.atr;
        legs.push({ symbol: l.sym, side: direction, stop, target, weight: 0.5 });
      };
      addLeg(legA);
      addLeg(legB);
      // scale = clamp(σ_target/max(hv,0.05), 0.2, 1.0) × min(1, |s|/1.0)（F 内置波动缩放）
      const hvAvg = (legA.hv + legB.hv) / 2;
      const scale = Math.min(1, Math.max(0.2, 0.15 / Math.max(isFiniteNum(hvAvg) && hvAvg > 0 ? hvAvg : 0.05, 0.05))) * Math.min(1, Math.abs(s) / 1.0);
      state.lastEntryDate = date;
      const manage = (mctx) => {
        const t = mctx.trade;
        const bi = mctx.barInfo[legA.sym];
        if (!bi) return null;
        // 冲击消化：|s_t| < 0.3pp → 全平（PIT：date ≤ bi.date）
        const sNow = this._sAt(bi.date);
        if (sNow !== null && Math.abs(sNow) < 0.3) {
          const exitPrices = {};
          for (const lg of t.legs) {
            const b = mctx.barInfo[lg.symbol];
            if (b) exitPrices[lg.symbol] = b.close;
          }
          return { exit: true, exitPrices, reason: 'shock-digested' };
        }
        return null;
      };
      out.push({
        direction,
        legs,
        sizeR: round(scale, 4),
        timeExitBars: 10,
        gapAbandon: { type: 'atr', factor: 1 },
        gapAtrValues: { [legA.sym]: legA.atr, [legB.sym]: legB.atr },
        tags: { s: round(s, 4), betaA: round(legA.beta, 5), betaB: round(legB.beta, 5), symbols: [legA.sym, legB.sym] },
        manage,
      });
      return out.length ? out : null;
    },

    theory({ strategyTrades, foldResults }) {
      // per-symbol per-fold hit rate; 连续 2 个滚动窗口 < 50% → 冻结该品种方向映射
      const folds = (foldResults || []).map((f) => f.fold);
      const bySymFold = {};
      for (const t of strategyTrades) {
        for (const sym of t.tags?.symbols || []) {
          const key = `${sym}|${t.foldId}`;
          const rec = bySymFold[key] || (bySymFold[key] = []);
          rec.push(t.netR);
        }
      }
      const symConsec = {};
      const rows = [];
      for (const fold of folds) {
        for (const sym of [...BLACK, ...BUILD]) {
          const rec = bySymFold[`${sym}|${fold}`] || [];
          if (rec.length === 0) continue;
          const hit = rec.filter((v) => v > 0).length / rec.length;
          rows.push({ fold, sym, n: rec.length, hitRate: round(hit, 4) });
          symConsec[sym] = symConsec[sym] || { cur: 0, max: 0 };
          if (hit < 0.5) { symConsec[sym].cur += 1; symConsec[sym].max = Math.max(symConsec[sym].max, symConsec[sym].cur); }
          else symConsec[sym].cur = 0;
        }
      }
      const maxConsecFail = Math.max(0, ...Object.values(symConsec).map((v) => v.max));
      const symbolsToFreeze = Object.entries(symConsec).filter(([, v]) => v.cur >= 2 || v.max >= 2).map(([k]) => k);
      const poolHit = strategyTrades.length ? strategyTrades.filter((t) => t.netR > 0).length / strategyTrades.length : null;
      // 全池连续 2 个滚动窗口命中率 < 50%（killOn：策略整体停用）
      let poolConsec = 0;
      let poolConsec2 = false;
      const poolByFold = {};
      for (const t of strategyTrades) {
        const rec = poolByFold[t.foldId] || (poolByFold[t.foldId] = []);
        rec.push(t.netR);
      }
      for (const fold of folds) {
        const rec = poolByFold[fold] || [];
        if (rec.length === 0) continue;
        const hit = rec.filter((v) => v > 0).length / rec.length;
        if (hit < 0.5) { poolConsec += 1; if (poolConsec >= 2) poolConsec2 = true; }
        else poolConsec = 0;
      }
      const falsified = poolConsec2;
      // 2023 前后分段报告（结构性风险）
      const pre2024 = strategyTrades.filter((t) => t.entryDate < '2024-01-01');
      const post2024 = strategyTrades.filter((t) => t.entryDate >= '2024-01-01');
      const hr = (ts) => ts.length ? ts.filter((t) => t.netR > 0).length / ts.length : null;
      return {
        hypothesis: '信用渠道传导 β_i < 0（冲击后 10 日方向命中率显著 > 50%）',
        metrics: { poolHitRate: poolHit, maxConsecFoldHitFail: maxConsecFail, symbolsToFreeze, poolConsecFoldFail2: poolConsec2, pre2024HitRate: hr(pre2024), post2024HitRate: hr(post2024) },
        tests: [
          {
            id: 'm1-credit-channel',
            label: '全池方向命中率 ≥ 50%（<50% → 整体停用并回炉 β 标定）',
            falsified,
            killState: 'suspended',
            evidence: { n: strategyTrades.length, poolHitRate: poolHit },
          },
          {
            id: 'm1-structural-2023',
            label: '2023 前后分段报告（β_i 衰减结构性风险）',
            falsified: false,
            evidence: { pre2024N: pre2024.length, pre2024HitRate: hr(pre2024), post2024N: post2024.length, post2024HitRate: hr(post2024) },
          },
        ],
        killOn: '全池连续 2 个滚动窗口命中率 < 50% → 策略整体停用；单品种连续 2 窗口 < 50% → 冻结该品种方向映射',
      };
    },
  };
}

module.exports = { id: 'M1', description: 'DR007 流动性冲击 t1 §M1', createAdapter };
