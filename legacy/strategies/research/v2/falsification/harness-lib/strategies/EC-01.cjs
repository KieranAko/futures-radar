// EC-01 能化成本传导误差修正（M4 ⊕ FS-08）— adapter（GA-7 paper-only 条款：仅 paper 验证）
// Library EC-01 verbatim. t8 records:
//  - 绑定水平口径 ECM（D2）；池资格 = M4 对数口径独立运行（β̂_log ≥ 0.2 且 R² ≥ 0.3）。
//  - γ 显著性门：滚动 250d ECM γ<0 且 p<0.05；残差 ADF p≤0.05（F1 模型级可证伪门）。
//  - e 反向扩 0.5σ̂_e 止损：入场冻结 α̂/β̂/μ̂_e/σ̂_e 重算（理论失效点）；产品 1.5×ATR5 波动失效（固定）。
//  - 事件日历联动暂停：2020 负油价 / 2022 俄乌窗口内不新开仓（ga7-en-2020oil / ga7-en-2022ru）。
//  - 仓位 ×0.75（回归策略折价）。paper-only：本 spec 仅作 walk-forward 纸面验证（activationGate 条款）。
'use strict';

const { isFiniteNum, round } = require('../util.cjs');
const S = require('../stats.cjs');
const { mean } = require('../stats.cjs');
const { egWindow, ecmWindow } = require('./_lib.cjs');

const SC = 'SC0';
const PRODUCTS = ['TA0', 'EG0', 'PP0', 'L0', 'EB0', 'BU0', 'FU0', 'PG0', 'PX0'];
const W = 250;

function createAdapter({ spec, data, engine }) {
  const barIdx = data.barIndexBySymbol;
  return {
    minWarmup: 300,

    initState() {
      this.gateStats = {}; // product -> {adfFail, gammaFail, qualFail, checked}
      return { lastEntryDate: {} };
    },

    evalBar(ctx, state, params) {
      const out = [];
      for (const prod of PRODUCTS) {
        if (!ctx.barToday[prod]) continue;
        const t = ctx.anchorIdxBySymbol[prod];
        if (t === null || t < this.minWarmup) continue;
        const scIdx = barIdx[SC].get(ctx.anchorDate);
        if (scIdx === undefined) continue;
        if (ctx.jumpDates[prod]?.has(ctx.anchorDate)) continue;
        // 事件日历联动暂停（2020 负油价/2022 俄乌）
        if (ctx.eventActive(prod).length || ctx.eventActive(SC).length) continue;
        const vp = ctx.daily[prod];
        const closeP = vp.at('close', t);
        const ma20 = ctx.derived[prod].at('ma20', t);
        const atr = ctx.derived[prod].at('atr5', t);
        if (![closeP, ma20, atr].every(isFiniteNum) || atr <= 0) continue;
        // 滚动 250d 协整（水平口径）+ 残差 ADF 门
        const dP = data.dailyBySymbol[prod];
        const dS = data.dailyBySymbol[SC];
        const xs = [];
        const ys = [];
        for (let k = Math.max(0, t - W + 1); k <= t; k++) {
          const dateK = dP.dates[k];
          const si = barIdx[SC].get(dateK);
          if (si === undefined) continue;
          xs.push(dS.close[si]);
          ys.push(dP.close[k]);
        }
        const gs = this.gateStats[prod] || (this.gateStats[prod] = { adfFail: 0, gammaFail: 0, qualFail: 0, checked: 0 });
        gs.checked += 1;
        if (xs.length < 30) continue;
        const fit = S.ols(xs, ys);
        const resid = ys.map((v, i) => v - fit.alpha - fit.beta * xs[i]);
        // R4（t9 复核）：协整残差 ADF 统一 EG2 临界值表（与 FS-05 断裂门/FS-04 F5 一致）
        const adf = S.adf(resid, { table: 'eg2' });
        if (!adf || adf.pApprox === null || adf.pApprox > 0.05) { gs.adfFail += 1; continue; } // F1 无协整 → 该对证伪剔除
        // 池资格（M4 对数口径独立运行）
        const lx = xs.map(Math.log);
        const ly = ys.map(Math.log);
        const lfit = S.ols(lx, ly);
        if (lfit.beta < 0.2 || lfit.r2 < 0.3) { gs.qualFail += 1; continue; } // 池资格剔除
        // ECM γ 显著性门（F2）
        const mu = mean(resid);
        const sd = S.std(resid, 1);
        if (!isFiniteNum(sd) || sd <= 0) continue;
        // ecmWindow needs views; rebuild residAt from the fitted arrays (aligned to dP bars)
        const ecm = this._ecmFor(dP, dS, fit, t, W);
        if (!ecm || ecm.gamma === null || ecm.gamma >= 0 || ecm.p === null || ecm.p >= 0.05) { gs.gammaFail += 1; continue; }
        const eT = resid[resid.length - 1];
        const z = (eT - mu) / sd;
        if (Math.abs(z) < 2) continue;
        let direction = 0;
        if (z <= -2 && closeP >= ma20) direction = +1;
        else if (z >= +2 && closeP <= ma20) direction = -1;
        if (direction === 0) continue;
        const stop = closeP - direction * 1.5 * atr;
        const target = fit.alpha + fit.beta * dS.close[scIdx] + mu; // F5: P_target（触发值冻结）
        const alpha = fit.alpha;
        const beta = fit.beta;
        const manage = (mctx) => {
          const bi = mctx.barInfo[prod];
          if (!bi) return null;
          const barIdx2 = mctx.sim._lastBarIndex;
          const si = barIdx2[SC].get(bi.date);
          if (si !== undefined) {
            const eBar = bi.close - alpha - beta * dS.close[si];
            const zBar = (eBar - mu) / sd;
            const adverse = direction > 0 ? zBar - z <= -0.5 : zBar - z >= 0.5;
            if (adverse) {
              return { exit: true, exitPrices: { [prod]: bi.close }, reason: 'e-adverse-0.5' };
            }
          }
          return null;
        };
        out.push({
          direction,
          legs: [{ symbol: prod, side: direction, stop, target, weight: 1 }],
          sizeR: 0.75, // 回归策略折价
          timeExitBars: 20,
          gapAbandon: { type: 'atr', factor: 1 },
          gapAtrValues: { [prod]: atr },
          tags: { product: prod, zEntry: round(z, 3), gamma: round(ecm.gamma, 4), gammaP: round(ecm.p, 4) },
          manage,
        });
      }
      return out.length ? out : null;
    },

    _ecmFor(dP, dS, fit, t, W) {
      const dy = [];
      const eLag = [];
      const dx = [];
      for (let k = Math.max(0, t - W + 1); k <= t - 1; k++) {
        const dk = dP.dates[k];
        const dk1 = dP.dates[k + 1];
        const s0 = barIdx[SC].get(dk);
        const s1 = barIdx[SC].get(dk1);
        if (s0 === undefined || s1 === undefined) continue;
        const e = dP.close[k] - fit.alpha - fit.beta * dS.close[s0];
        dy.push(dP.close[k + 1] - dP.close[k]);
        eLag.push(e);
        dx.push(dS.close[s1] - dS.close[s0]);
      }
      if (dy.length < 30) return null;
      const mx1 = mean(eLag); const mx2 = mean(dx); const my = mean(dy);
      let s11 = 0; let s22 = 0; let s12 = 0; let sy1 = 0; let sy2 = 0;
      for (let i = 0; i < dy.length; i++) {
        s11 += (eLag[i] - mx1) ** 2;
        s22 += (dx[i] - mx2) ** 2;
        s12 += (eLag[i] - mx1) * (dx[i] - mx2);
        sy1 += (dy[i] - my) * (eLag[i] - mx1);
        sy2 += (dy[i] - my) * (dx[i] - mx2);
      }
      const det = s11 * s22 - s12 * s12;
      if (det === 0) return null;
      const gamma = (sy1 * s22 - sy2 * s12) / det;
      const betaDx = (sy2 * s11 - sy1 * s12) / det;
      const alpha = my - gamma * mx1 - betaDx * mx2;
      let sse = 0;
      for (let i = 0; i < dy.length; i++) {
        const e = dy[i] - alpha - gamma * eLag[i] - betaDx * dx[i];
        sse += e * e;
      }
      const dof = dy.length - 3;
      const seGamma = dof > 0 ? Math.sqrt((sse / dof) * (s22 / det)) : null;
      const tStat = seGamma ? gamma / seGamma : null;
      const p = tStat === null ? null : 2 * (1 - S.tcdf(Math.abs(tStat), dof));
      return { gamma, seGamma, tStat, p, n: dy.length };
    },

    theory({ strategyTrades }) {
      const netRs = strategyTrades.map((t) => t.netR);
      const sharpe = S.sharpeTrade(netRs);
      const falsifiedB = netRs.length >= 30 && (sharpe === null || sharpe < 0.5);
      // (a) 对级证伪统计（ADF p>0.05 / γ≥0 / 池资格不达标 → 剔除出池）
      const pairFalsification = {};
      for (const [prod, g] of Object.entries(this.gateStats)) {
        pairFalsification[prod] = {
          checked: g.checked, adfFail: g.adfFail, gammaFail: g.gammaFail, qualFail: g.qualFail,
          excluded: g.checked > 0 && (g.adfFail + g.gammaFail + g.qualFail) / g.checked > 0.5,
        };
      }
      // (c) 隔夜跳空亏损占比
      const totalLoss = netRs.filter((v) => v < 0).reduce((a, b) => a + Math.abs(b), 0);
      const gapLoss = strategyTrades
        .filter((t) => t.netR < 0 && t.legs.some((l) => l.exitReason === 'stop-gap-through'))
        .reduce((a, t) => a + Math.abs(t.netR), 0);
      const gapLossShare = totalLoss > 0 ? gapLoss / totalLoss : 0;
      const falsifiedC = false; // 库语义：>30% → 先增加隔夜过滤修订，修订后仍 >30% 才停用（修订需 t9/队长裁定）
      // 2020 负油价 / 2022 俄乌窗口：入场被事件日历禁止 → 0 笔（结构性单列）
      const structTrades = strategyTrades.filter((t) => t.entryDate >= '2020-04-01' && t.entryDate <= '2020-12-31');
      return {
        hypothesis: 'F1 协整 + 误差修正（γ<0）+ F2 产品端回归',
        metrics: { sharpeTrade: sharpe, gapLossShare: round(gapLossShare, 4), allPairsExcluded: Object.values(pairFalsification).length > 0 && Object.values(pairFalsification).every((g) => g.excluded) },
        tests: [
          {
            id: 'ec01-pair-falsification',
            label: '(a) 无协整（ADF p>0.05）或 γ≥0 → 该品种对证伪剔除（对级）',
            falsified: false,
            evidence: pairFalsification,
          },
          {
            id: 'ec01-sharpe',
            label: '(b) 策略扣成本夏普 ≥ 0.5',
            falsified: falsifiedB,
            killState: 'suspended',
            evidence: { n: netRs.length, sharpe },
          },
          {
            id: 'ec01-overnight-gap',
            label: '(c) 隔夜跳空亏损占比 ≤ 30%（>30% → 增加隔夜过滤修订，修订后仍 >30% 才停用）',
            falsified: falsifiedC,
            revisionRequired: netRs.length >= 30 && gapLossShare > 0.3,
            evidence: { gapLoss: round(gapLoss, 4), totalLoss: round(totalLoss, 4), gapLossShare: round(gapLossShare, 4) },
          },
          {
            id: 'ec01-structural-windows',
            label: '2020 负油价/2022 俄乌冲击期单列（不参与参数估计，事件日历联动暂停）',
            falsified: false,
            evidence: { note: '事件窗口内入场被 ga7 日历禁止（0 笔）；2020 段样本仅作结构性对照', structural2020Trades: structTrades.length },
          },
        ],
        killOn: '(a) 该品种对证伪 → 剔除出池；(b) 触发 → suspended；(c) 修订后仍不达标 → 停用',
      };
    },
  };
}

module.exports = { id: 'EC-01', description: '能化成本传导误差修正 t1 §M4 ⊕ t2 §FS-08', createAdapter };
