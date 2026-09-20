// FS-05 农产品压榨/替代价差回归（协整 OU）— adapter
// Library FS-05 verbatim. t8 records:
//  - 双腿 z 止损为价差空间管理：入场后以冻结 α̂/β̂/μ̂_e/σ̂_e 重算 e/z（provisional 价格止损在首根
//    manage 即禁用，仅用于 R 归一：riskDist = σ̂_e（腿1）与 σ̂_e/|β̂|（腿2））。
//  - 断裂门 F3：60d 残差 ADF p>0.10 或 |Δβ̂|>2σ̂_β（对 20 bar 前）→ 该对暂停。
//  - 事件前提开关（F9）：任一腿 eventActive → 不新开仓。
//  - 两腿按日期对齐（各自日线日历对齐后 OLS，F8 PIT）。
'use strict';

const { isFiniteNum, round } = require('../util.cjs');
const S = require('../stats.cjs');
const { mean } = require('../stats.cjs');

const PAIRS = [['M0', 'RM0'], ['Y0', 'M0'], ['Y0', 'P0'], ['OI0', 'Y0'], ['C0', 'CS0']];
const W = 250;

function egOnAligned(xs, ys) {
  if (xs.length < 30) return null;
  const fit = S.ols(xs, ys);
  const resid = ys.map((v, i) => v - fit.alpha - fit.beta * xs[i]);
  const adf = S.adf(resid, { table: 'eg2' });
  return { ...fit, resid, adf };
}

function createAdapter({ spec, data, engine }) {
  const barIdx = data.barIndexBySymbol;
  return {
    minWarmup: 300,

    initState() {
      this.cointCounts = {}; // pair -> {pass, total}
      this.breakGatePauses = {};
      return { lastEntryDate: {} };
    },

    _alignedWindow(s1, s2, i1) {
      const d1 = data.dailyBySymbol[s1];
      const d2 = data.dailyBySymbol[s2];
      const xs = [];
      const ys = [];
      for (let k = i1; k >= Math.max(0, i1 - W + 1); k--) {
        const j = barIdx[s2].get(d1.dates[k]);
        if (j === undefined) continue;
        xs.push(d2.close[j]);
        ys.push(d1.close[k]);
      }
      xs.reverse();
      ys.reverse();
      if (xs.length < 30) return null;
      return { xs, ys, eg: egOnAligned(xs, ys) };
    },

    evalBar(ctx, state, params) {
      const out = [];
      for (const [s1, s2] of PAIRS) {
        if (!ctx.barToday[s1] || !ctx.barToday[s2]) continue;
        const i1 = ctx.anchorIdxBySymbol[s1];
        const i2 = ctx.anchorIdxBySymbol[s2];
        if (i1 === null || i2 === null || i1 < this.minWarmup || i2 < this.minWarmup) continue;
        if (ctx.jumpDates[s1]?.has(ctx.anchorDate) || ctx.jumpDates[s2]?.has(ctx.anchorDate)) continue;
        if (ctx.eventActive(s1).length || ctx.eventActive(s2).length) continue;
        const close1 = ctx.daily[s1].at('close', i1);
        const close2 = ctx.daily[s2].at('close', i2);
        const atr1 = ctx.derived[s1].at('atr5', i1);
        const atr2 = ctx.derived[s2].at('atr5', i2);
        if (![close1, close2, atr1, atr2].every(isFiniteNum) || atr1 <= 0 || atr2 <= 0) continue;
        const pair = `${s1}-${s2}`;
        const win = this._alignedWindow(s1, s2, i1);
        if (!win || !win.eg) continue;
        const eg = win.eg;
        const cc = this.cointCounts[pair] || (this.cointCounts[pair] = { pass: 0, total: 0 });
        cc.total += 1;
        if (eg.adf.reject05) cc.pass += 1;
        // 断裂门 F3：60d 残差 ADF p>0.10 或 β̂ 漂移 >2σ̂_β
        const resid60 = eg.resid.slice(-60);
        const adf60 = resid60.length >= 30 ? S.adf(resid60, { table: 'eg2' }) : null;
        const win20 = this._alignedWindow(s1, s2, Math.max(this.minWarmup, i1 - 20));
        const betaDrift = win20 && win20.eg && isFiniteNum(eg.seBeta) && eg.seBeta > 0
          ? Math.abs(eg.beta - win20.eg.beta) > 2 * eg.seBeta
          : false;
        if ((adf60 && adf60.pApprox > 0.10) || betaDrift) {
          this.breakGatePauses[pair] = (this.breakGatePauses[pair] || 0) + 1;
          continue;
        }
        const mu = mean(eg.resid);
        const sd = S.std(eg.resid, 1);
        if (!isFiniteNum(sd) || sd <= 0) continue;
        const eT = eg.resid[eg.resid.length - 1];
        const z = (eT - mu) / sd;
        if (Math.abs(z) < 2) continue;
        const dirZ = z > 0 ? -1 : +1;
        const side1 = z > 0 ? -1 : +1; // e>0: 腿1高估 → 空腿1/多腿2
        const side2 = -side1;
        const sizeR = Math.abs(z) >= 2.5 ? 1 : 0.5;
        const riskDist1 = sd;
        const riskDist2 = Math.abs(eg.beta) > 1e-9 ? sd / Math.abs(eg.beta) : sd;
        const stop1 = close1 - side1 * riskDist1;
        const stop2 = close2 - side2 * riskDist2;
        const alpha = eg.alpha;
        const beta = eg.beta;
        const manage = (mctx) => {
          const t = mctx.trade;
          const bi1 = mctx.barInfo[s1];
          const bi2 = mctx.barInfo[s2];
          if (!bi1 || !bi2) return null;
          if (t._ad?.stopsDisabled) {
            const eBar = bi1.close - alpha - beta * bi2.close;
            const zBar = (eBar - mu) / sd;
            t._eExit = eBar;
            if (Math.abs(zBar) >= 3) {
              return { exit: true, exitPrices: { [s1]: bi1.close, [s2]: bi2.close }, reason: 'z-stop-3sigma' };
            }
            if (z * zBar <= 0) {
              return { exit: true, exitPrices: { [s1]: bi1.close, [s2]: bi2.close }, reason: 'z-target-zero' };
            }
            if ((zBar - z) * dirZ <= -0.5) {
              return { exit: true, exitPrices: { [s1]: bi1.close, [s2]: bi2.close }, reason: 'z-adverse-0.5' };
            }
            return null;
          }
          t._ad = { stopsDisabled: true };
          t._eEntry = eT;
          return { adjust: { [s1]: { stop: 'disable', legIndex: 0 }, [s2]: { stop: 'disable', legIndex: 1 } } };
        };
        out.push({
          direction: side1,
          legs: [
            { symbol: s1, side: side1, stop: stop1, target: null, weight: 0.5 },
            { symbol: s2, side: side2, stop: stop2, target: null, weight: 0.5 },
          ],
          sizeR,
          timeExitBars: 20,
          gapAbandon: { type: 'atr', factor: 0.5 },
          gapAtrValues: { [s1]: atr1, [s2]: atr2 },
          tags: { pair, zEntry: round(z, 3), eEntry: round(eT, 4), mu: round(mu, 4), sd: round(sd, 4), side1 },
          manage,
        });
      }
      return out.length ? out : null;
    },

    theory({ strategyTrades }) {
      const netRs = strategyTrades.map((t) => t.netR);
      const sharpe = S.sharpeTrade(netRs);
      let convHits = 0;
      let convN = 0;
      for (const t of strategyTrades) {
        if (isFiniteNum(t._eEntry) && isFiniteNum(t._eExit) && isFiniteNum(t.tags?.mu)) {
          convN += 1;
          if (Math.abs(t._eExit - t.tags.mu) < Math.abs(t._eEntry - t.tags.mu)) convHits += 1;
        }
      }
      const convRate = convN ? convHits / convN : null;
      const falsifiedB = (netRs.length >= 30 && (sharpe === null || sharpe < 0.5)) ||
        (convRate !== null && convN >= 30 && convRate < 0.55);
      const pairRates = {};
      for (const [p, c] of Object.entries(this.cointCounts)) {
        pairRates[p] = { pass: c.pass, total: c.total, rate: c.total ? round(c.pass / c.total, 4) : null, remove: c.total >= 30 && c.pass / c.total < 0.7 };
      }
      // N6（t9 复核）：窗口从 GA-7 日历读取（ga7-ag-2019 / ga7-ag-2024ad），非硬编码
      const cal = data.calendar?.events || [];
      const ev2019 = cal.find((e) => e.id === 'ga7-ag-2019');
      const ev2024 = cal.find((e) => e.id === 'ga7-ag-2024ad');
      const windows = [
        [ev2019?.date || '2019-03-01', ev2019?.end || '2019-12-31'],
        [ev2024?.date || '2024-09-09', ev2024?.end || '2025-12-31'],
      ];
      const rmSpecial = windows.map(([a, b]) => {
        const stops = strategyTrades.filter((t) => t.tags?.pair === 'M0-RM0' && t.entryDate >= a && t.entryDate <= b && t.exitReason === 'z-stop-3sigma').length;
        return { window: `${a}..${b}`, zStop3Sigma: stops, gateMissed: stops > 2 };
      });
      const needsRevision = rmSpecial.some((w) => w.gateMissed);
      return {
        hypothesis: 'F1 协整回归 + F2 结构断裂门有效性',
        metrics: { sharpeTrade: sharpe, convergenceHitRate: convRate, cointPassRates: pairRates },
        tests: [
          {
            id: 'fs05-coint-pass-rate',
            label: '(a) 滚动协整通过率 < 70% 的品种对剔除（对级）',
            falsified: false,
            evidence: pairRates,
          },
          {
            id: 'fs05-portfolio',
            label: '(b) 组合夏普 ≥ 0.5 且回归命中 ≥ 55%',
            falsified: falsifiedB,
            killState: 'suspended',
            evidence: { n: netRs.length, sharpe, convHits, convN, convRate },
          },
          {
            id: 'fs05-rm-break-gate',
            label: '(c) M−RM 两段结构断裂被断裂门捕捉（各窗口 >2 次 3σ 止损即未捕捉 → 断裂门参数修订）',
            falsified: false,
            revisionRequired: needsRevision,
            evidence: rmSpecial,
          },
        ],
        killOn: '(b) 触发 → suspended；(c) 修订后仍不达标 → 该对永久停用',
      };
    },
  };
}

module.exports = { id: 'FS-05', description: '农产品压榨/替代价差回归 t2 §FS-05', createAdapter };
