// FS-04 黑色产业链利润分位 — adapter
// Library FS-04 verbatim. t8 records:
//  - π = P_RB − α̂ − β̂1·P_I − β̂2·P_J（滚动 250d 多元 OLS，F1/F8）；μ̂/σ̂ 250d；z 阈值 ±2。
//  - F5 平稳性门：250d 残差 ADF p > 0.05 → 暂停该品种组信号（计次报告）。
//  - 政策日历前提开关：eventActive 生效期不新开仓（ga7 黑色窗口）。
//  - 单边 RB 腿（库 direction：z≤−2 多 RB / z≥+2 空 RB）；焦化对称（πJ=P_J−1.33·P_JM，J0 腿）。
//  - 双腿变体未启用（库标注『容量允许时』，v0 单边，记录）。
//  - z 反向扩 0.5 止损：以入场冻结的 α̂/β̂/μ̂/σ̂ 重算 π（理论失效点口径）。
'use strict';

const { isFiniteNum, round } = require('../util.cjs');
const { mean } = require('../stats.cjs');
const S = require('../stats.cjs');

// multivariate OLS y ~ [1, x1, x2]
function ols2(x1, x2, y) {
  const n = Math.min(x1.length, x2.length, y.length);
  const m1 = mean(x1.slice(0, n));
  const m2 = mean(x2.slice(0, n));
  const my = mean(y.slice(0, n));
  let s11 = 0; let s22 = 0; let s12 = 0; let sy1 = 0; let sy2 = 0;
  for (let i = 0; i < n; i++) {
    s11 += (x1[i] - m1) ** 2;
    s22 += (x2[i] - m2) ** 2;
    s12 += (x1[i] - m1) * (x2[i] - m2);
    sy1 += (y[i] - my) * (x1[i] - m1);
    sy2 += (y[i] - my) * (x2[i] - m2);
  }
  const det = s11 * s22 - s12 * s12;
  if (det === 0) return null;
  const b1 = (sy1 * s22 - sy2 * s12) / det;
  const b2 = (sy2 * s11 - sy1 * s12) / det;
  const a = my - b1 * m1 - b2 * m2;
  let sse = 0;
  for (let i = 0; i < n; i++) {
    const e = y[i] - a - b1 * x1[i] - b2 * x2[i];
    sse += e * e;
  }
  return { alpha: a, b1, b2, r2: 1 - sse / (n * (S.std(y.slice(0, n), 1) ** 2 || 1)), n };
}

function createAdapter({ spec, data, engine }) {
  const W = 250;
  const syms = { RB: 'RB0', I: 'I0', J: 'J0', JM: 'JM0' };
  const barIdx = data.barIndexBySymbol;
  return {
    minWarmup: 300,

    initState() {
      this.signalLog = [];
      this.adfPauses = 0;
      this.adfChecks = 0;
      return {};
    },

    evalBar(ctx, state, params) {
      const out = [];
      // primary: RB 利润分位（RB0 bar）
      this._evalGroup(ctx, state, params, out, {
        leg: 'RB0', kind: 'RB', idxOf: barIdx, daily: data.dailyBySymbol,
      });
      // 焦化对称: πJ = P_J − 1.33×P_JM → J0 腿
      this._evalJ(ctx, state, params, out);
      return out.length ? out : null;
    },

    _evalGroup(ctx, state, params, out, g) {
      const rb = ctx.daily[syms.RB];
      if (!ctx.barToday[syms.RB]) return;
      const t = ctx.anchorIdxBySymbol[syms.RB];
      if (t === null || t < this.minWarmup) return;
      const closeRB = rb.at('close', t);
      const ma20RB = ctx.derived[syms.RB].at('ma20', t);
      const atrRB = ctx.derived[syms.RB].at('atr5', t);
      if (![closeRB, ma20RB, atrRB].every(isFiniteNum) || atrRB <= 0) return;
      if (ctx.jumpDates[syms.RB]?.has(ctx.anchorDate)) return;
      // policy gate: 政策日历生效期暂停新开仓（前提开关）
      if (ctx.eventActive(syms.RB).length) return;
      const rI = data.dailyBySymbol[syms.I];
      const rJ = data.dailyBySymbol[syms.J];
      // rolling 250d OLS（F1/F8）：按日期对齐 RB/I/J 收盘
      const arrI = []; const arrJ = []; const arrR = [];
      for (let k = Math.max(0, t - W + 1); k <= t; k++) {
        const dateK = data.dailyBySymbol[syms.RB].dates[k];
        const ii = barIdx[syms.I].get(dateK);
        const jj = barIdx[syms.J].get(dateK);
        if (ii === undefined || jj === undefined) continue;
        arrI.push(rI.close[ii]);
        arrJ.push(rJ.close[jj]);
        arrR.push(data.dailyBySymbol[syms.RB].close[k]);
      }
      if (arrI.length < 30) return;
      const fit = ols2(arrI, arrJ, arrR);
      if (!fit) return;
      // resid π over the window (aligned to arrR indexes)
      const piSeries = arrR.map((v, k) => v - fit.alpha - fit.b1 * arrI[k] - fit.b2 * arrJ[k]);
      const n = piSeries.length;
      const mu = mean(piSeries);
      const sd = S.std(piSeries, 1);
      if (!isFiniteNum(sd) || sd <= 0) return;
      const piT = piSeries[n - 1];
      const z = (piT - mu) / sd;
      // F5 平稳性门: 250d 残差 ADF p > 0.05 → 暂停
      this.adfChecks += 1;
      // R4（t9 复核）：三类残差平稳性门统一 EG2 表（与 FS-05 断裂门/EC-01 (a) 一致）
      const adf = S.adf(piSeries, { table: 'eg2' });
      if (adf.pApprox === null || adf.pApprox > 0.05) {
        this.adfPauses += 1;
        return;
      }
      let direction = 0;
      if (z <= -2 && closeRB >= ma20RB) direction = +1;
      else if (z >= +2 && closeRB <= ma20RB) direction = -1;
      if (direction === 0) return;
      const sizeR = Math.abs(z) >= 3 ? 1 : 0.5;
      const stop = closeRB - direction * 1.5 * atrRB;
      const R = Math.abs(closeRB - stop);
      if (R <= 0) return;
      const target = closeRB - z * sd; // F3: P_RB,target = P_RB,t − z_t·σ̂_250
      this.signalLog.push({
        date: ctx.anchorDate, kind: 'RB', direction, z: round(z, 4), piT: round(piT, 4), mu: round(mu, 4), sd: round(sd, 4),
        alpha: round(fit.alpha, 4), b1: round(fit.b1, 4), b2: round(fit.b2, 4), closeRB,
      });
      const manage = (mctx) => {
        const t2 = mctx.trade;
        const bi = mctx.barInfo[syms.RB];
        if (!bi) return null;
        const barIdx2 = mctx.sim._lastBarIndex;
        // z 反向扩 0.5（入场冻结 α̂/β̂/μ̂/σ̂）
        const ii = barIdx2[syms.I].get(bi.date);
        const jj = barIdx2[syms.J].get(bi.date);
        if (ii !== undefined && jj !== undefined) {
          const pI = data.dailyBySymbol[syms.I].close[ii];
          const pJ = data.dailyBySymbol[syms.J].close[jj];
          const piNow = bi.close - fit.alpha - fit.b1 * pI - fit.b2 * pJ;
          const zNow = (piNow - mu) / sd;
          const adverse = direction > 0 ? zNow - z <= -0.5 : zNow - z >= 0.5;
          if (adverse) {
            return { exit: true, exitPrices: { [syms.RB]: bi.close }, reason: 'z-adverse-0.5' };
          }
        }
        return null;
      };
      out.push({
        direction,
        legs: [{ symbol: syms.RB, side: direction, stop, target, weight: 1 }],
        sizeR,
        timeExitBars: 40,
        gapAbandon: { type: 'atr', factor: 1 },
        gapAtrValues: { [syms.RB]: atrRB },
        tags: { kind: 'RB', zEntry: round(z, 3), policyBlocked: false },
        manage,
      });
    },

    _evalJ(ctx, state, params, out) {
      const j = ctx.daily[syms.J];
      if (!ctx.barToday[syms.J]) return;
      const t = ctx.anchorIdxBySymbol[syms.J];
      if (t === null || t < this.minWarmup) return;
      const closeJ = j.at('close', t);
      const ma20J = ctx.derived[syms.J].at('ma20', t);
      const atrJ = ctx.derived[syms.J].at('atr5', t);
      if (![closeJ, ma20J, atrJ].every(isFiniteNum) || atrJ <= 0) return;
      if (ctx.jumpDates[syms.J]?.has(ctx.anchorDate)) return;
      if (ctx.eventActive(syms.J).length) return;
      const jmIdx = barIdx[syms.JM].get(ctx.anchorDate);
      if (jmIdx === undefined) return;
      // πJ = P_J − 1.33×P_JM（F4）
      const piSeries = [];
      for (let k = t - W + 1; k <= t; k++) {
        const dateK = data.dailyBySymbol[syms.J].dates[k];
        const jmK = barIdx[syms.JM].get(dateK);
        if (jmK === undefined) continue;
        piSeries.push(data.dailyBySymbol[syms.J].close[k] - 1.33 * data.dailyBySymbol[syms.JM].close[jmK]);
      }
      if (piSeries.length < 30) return;
      const mu = mean(piSeries);
      const sd = S.std(piSeries, 1);
      if (!isFiniteNum(sd) || sd <= 0) return;
      const z = (piSeries[piSeries.length - 1] - mu) / sd;
      let direction = 0;
      if (z <= -2 && closeJ >= ma20J) direction = +1;
      else if (z >= +2 && closeJ <= ma20J) direction = -1;
      if (direction === 0) return;
      const sizeR = Math.abs(z) >= 3 ? 1 : 0.5;
      const stop = closeJ - direction * 1.5 * atrJ;
      const R = Math.abs(closeJ - stop);
      if (R <= 0) return;
      const target = closeJ - z * sd;
      this.signalLog.push({ date: ctx.anchorDate, kind: 'J', direction, z: round(z, 4), piT: round(piSeries[piSeries.length - 1], 4), mu: round(mu, 4), sd: round(sd, 4) });
      const manage = (mctx) => {
        const bi = mctx.barInfo[syms.J];
        if (!bi) return null;
        const barIdx2 = mctx.sim._lastBarIndex;
        const jmK = barIdx2[syms.JM].get(bi.date);
        if (jmK !== undefined) {
          const piNow = bi.close - 1.33 * data.dailyBySymbol[syms.JM].close[jmK];
          const zNow = (piNow - mu) / sd;
          const adverse = direction > 0 ? zNow - z <= -0.5 : zNow - z >= 0.5;
          if (adverse) return { exit: true, exitPrices: { [syms.J]: bi.close }, reason: 'z-adverse-0.5' };
        }
        return null;
      };
      out.push({
        direction,
        legs: [{ symbol: syms.J, side: direction, stop, target, weight: 1 }],
        sizeR,
        timeExitBars: 40,
        gapAbandon: { type: 'atr', factor: 1 },
        gapAtrValues: { [syms.J]: atrJ },
        tags: { kind: 'J', zEntry: round(z, 3) },
        manage,
      });
    },

    theory({ strategyTrades }) {
      const netRs = strategyTrades.map((t) => t.netR);
      const wins = netRs.filter((v) => v > 0).reduce((a, b) => a + b, 0);
      const losses = netRs.filter((v) => v < 0).reduce((a, b) => a + Math.abs(b), 0);
      const sharpe = S.sharpeTrade(netRs);
      // (a) 40 日 π 回归概率（RB 腿）
      const rbSignals = (this.signalLog || []).filter((s) => s.kind === 'RB');
      const rbTrades = strategyTrades.filter((t) => t.tags?.kind === 'RB');
      let hits = 0;
      let total = 0;
      for (const sig of rbSignals) {
        const tIdx = data.barIndexBySymbol[syms.RB].get(sig.date);
        if (tIdx === undefined) continue;
        const t40 = tIdx + 40;
        const dates = data.dailyBySymbol[syms.RB].dates;
        if (t40 >= dates.length) continue;
        const date40 = dates[t40];
        const i40 = barIdx[syms.I].get(date40);
        const j40 = barIdx[syms.J].get(date40);
        if (i40 === undefined || j40 === undefined) continue;
        const pI = data.dailyBySymbol[syms.I].close[i40];
        const pJ = data.dailyBySymbol[syms.J].close[j40];
        const pRB = data.dailyBySymbol[syms.RB].close[t40];
        const pi40 = pRB - sig.alpha - sig.b1 * pI - sig.b2 * pJ;
        if (Math.abs(pi40 - sig.mu) < Math.abs(sig.piT - sig.mu) / 2) hits += 1;
        total += 1;
      }
      const regressRate = total ? hits / total : null;
      const falsifiedA = regressRate !== null && total >= 30 && regressRate <= 0.55;
      // (b) 组合夏普 < 0.5 → 停用
      const falsifiedB = netRs.length >= 30 && (sharpe === null || sharpe < 0.5);
      // (c) 归因：RB 亏损而 I/J 上涨的样本占比 > 40% → 单边改双腿
      let attr = 0;
      let attrN = 0;
      for (const t of rbTrades) {
        if (t.netR >= 0) continue;
        const eIdx = data.barIndexBySymbol[syms.RB].get(t.entryDate);
        const xIdx = data.barIndexBySymbol[syms.RB].get(t.exitDate);
        if (eIdx === undefined || xIdx === undefined) continue;
        const iE = barIdx[syms.I].get(t.entryDate);
        const iX = barIdx[syms.I].get(t.exitDate);
        const jE = barIdx[syms.J].get(t.entryDate);
        const jX = barIdx[syms.J].get(t.exitDate);
        if ([iE, iX, jE, jX].some((v) => v === undefined)) continue;
        const iUp = data.dailyBySymbol[syms.I].close[iX] > data.dailyBySymbol[syms.I].close[iE];
        const jUp = data.dailyBySymbol[syms.J].close[jX] > data.dailyBySymbol[syms.J].close[jE];
        attrN += 1;
        if (iUp && jUp) attr += 1;
      }
      const attrShare = attrN ? attr / attrN : null;
      const falsifiedC = attrShare !== null && attrN >= 20 && attrShare > 0.4;
      // (d) 政策窗口：入场被前提开关禁止 → 0 笔 → 过滤层 by-construction 安装
      const policyTrades = strategyTrades.filter((t) => t.tags?.policyBlocked === true);
      return {
        hypothesis: 'F1/F2 利润均值回归 + 产品端弹性驱动 + 政策前提',
        metrics: {
          sharpeTrade: sharpe, regressRate40d: regressRate, attrShare,
          adfPauseShare: this.adfChecks > 0 ? this.adfPauses / this.adfChecks : null,
        },
        tests: [
          {
            id: 'fs04-profit-regression',
            label: '(a) z 极端后 40 日 π 回归概率 > 55%',
            falsified: falsifiedA,
            killState: 'retired',
            evidence: { hits, total, regressRate: regressRate },
          },
          {
            id: 'fs04-sharpe',
            label: '(b) 多 RB 单边扣成本夏普 ≥ 0.5',
            falsified: falsifiedB,
            killState: 'suspended',
            evidence: { n: netRs.length, sharpe },
          },
          {
            id: 'fs04-attribution',
            label: '(c) 回归由原料腿驱动的样本占比 ≤ 40%',
            falsified: falsifiedC,
            evidence: { attr, attrN, attrShare, note: '>40% → 单边改双腿结构（模型修订建议，非证伪门槛变更）' },
          },
          {
            id: 'fs04-policy-gate',
            label: '(d) 政策窗口表现劣于全样本 → 政策过滤层必装',
            falsified: false,
            evidence: { policyTrades: policyTrades.length, note: '政策窗口内入场被事件日历前提开关禁止（by-construction 0 笔），过滤层已为必装组件；无窗口内样本可比较' },
          },
        ],
        killOn: '(a) 证伪 F1/F2 → retired；(b) 触发 → suspended',
      };
    },
  };
}

module.exports = { id: 'FS-04', description: '黑色产业链利润分位 t2 §FS-04', createAdapter };
