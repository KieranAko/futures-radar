// probability/prediction-intervals.cjs — 五模型预测区间（有行情品种专用）
//
// 只用于本报告筛选出的"有行情"候选：全部采用条件型/自适应模型，
// 不用长窗平稳模型（GBM-HV 仅作为历史基线，不参与当前适配）。
//
// 模型与理论依据：
//   1. ewma     RiskMetrics (1996) 条件波动率
//   2. garch    Engle (1982) / Bollerslev (1986) GARCH(1,1)
//   3. fhs      Barone-Adesi, Giannopoulos & Vosper (1999)
//   4. evt_pot  McNeil & Frey (2000) / Embrechts et al. (1997)
//   5. aci      Gibbs & Candès (2021) 自适应共形预测（轻量近似）
'use strict';

const Z = { p68: 1.0, p95: 1.96 };
const PERIODS = [3, 5];

function logReturns(closes) {
  const out = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0 && closes[i] > 0) out.push(Math.log(closes[i] / closes[i - 1]));
  }
  return out;
}

function mean(xs) {
  if (!xs.length) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function variance(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return xs.reduce((a, x) => a + (x - m) * (x - m), 0) / (xs.length - 1);
}

function std(xs) {
  return Math.sqrt(variance(xs));
}

function quantile(xs, q) {
  if (!xs.length) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function bandFromDailySigma(close, sigmaDaily, period, z) {
  const move = z * sigmaDaily * Math.sqrt(period);
  return [round1(close * Math.exp(-move)), round1(close * Math.exp(move))];
}

function round1(x) {
  return Math.round(x * 10) / 10;
}

function round4(x) {
  return Math.round(x * 10000) / 10000;
}

// ── 1. EWMA ──────────────────────────────────────────────────
function ewmaSigmaDaily(returns, lambda = 0.94) {
  if (returns.length < 5) return null;
  let v = variance(returns) || 0.0001;
  for (const r of returns) v = lambda * v + (1 - lambda) * r * r;
  return Math.sqrt(Math.max(v, 1e-12));
}

// ── 2. GARCH(1,1)：Nelder-Mead 高斯准极大似然 ────────────────
function garchVarianceSeries(returns, p) {
  const n = returns.length;
  const sigma2 = new Array(n).fill(0);
  let v = variance(returns) || 0.0001;
  for (let t = 0; t < n; t++) {
    sigma2[t] = Math.max(p.omega + p.alpha * (t > 0 ? returns[t - 1] * returns[t - 1] : v) + p.beta * (t > 0 ? sigma2[t - 1] : v), 1e-10);
  }
  return sigma2;
}

function garchNegLogLik(p, returns) {
  if (p.omega <= 0 || p.alpha < 0 || p.beta < 0 || p.alpha + p.beta >= 0.999) return 1e9;
  const s2 = garchVarianceSeries(returns, p);
  let ll = 0;
  for (let t = 0; t < returns.length; t++) {
    ll += Math.log(s2[t]) + (returns[t] * returns[t]) / s2[t];
  }
  return 0.5 * ll + (Number.isFinite(ll) ? 0 : 1e9);
}

function nelderMead(f, x0, opts = {}) {
  const alpha = 1, gamma = 2, rho = 0.5, sigma = 0.5;
  const maxIter = opts.maxIter || 600;
  const tol = opts.tol || 1e-7;
  let simplex = [x0];
  const n = x0.length;
  for (let i = 0; i < n; i++) {
    const p = [...x0];
    p[i] = p[i] === 0 ? 1e-4 : p[i] * 1.05;
    simplex.push(p);
  }
  const score = (p) => f(p);
  for (let iter = 0; iter < maxIter; iter++) {
    simplex.sort((a, b) => score(a) - score(b));
    const best = simplex[0];
    const worst = simplex[n];
    if (Math.abs(score(best) - score(worst)) < tol) break;
    const centroid = new Array(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) centroid[j] += simplex[i][j] / n;
    const reflect = centroid.map((c, i) => c + alpha * (c - worst[i]));
    if (score(reflect) < score(best)) {
      const expand = centroid.map((c, i) => c + gamma * (reflect[i] - c));
      simplex[n] = score(expand) < score(reflect) ? expand : reflect;
    } else if (score(reflect) < score(simplex[n - 1])) {
      simplex[n] = reflect;
    } else {
      const contract = centroid.map((c, i) => c + rho * (worst[i] - c));
      if (score(contract) < score(worst)) {
        simplex[n] = contract;
      } else {
        for (let i = 1; i <= n; i++) simplex[i] = simplex[i].map((x, j) => best[j] + sigma * (x - best[j]));
      }
    }
  }
  simplex.sort((a, b) => score(a) - score(b));
  return { params: simplex[0], value: score(simplex[0]) };
}

function garchSigmaDaily(returns) {
  if (returns.length < 30) return null;
  const initVariance = variance(returns) || 0.0001;
  const f = (p) => garchNegLogLik({ omega: p[0], alpha: p[1], beta: p[2] }, returns);
  try {
    const r = nelderMead(f, [initVariance * 0.05, 0.06, 0.88], { maxIter: 400 });
    const p = { omega: Math.abs(r.params[0]), alpha: Math.min(Math.abs(r.params[1]), 0.3), beta: Math.min(Math.abs(r.params[2]), 0.9) };
    if (p.alpha + p.beta >= 0.999) return null;
    const s2 = garchVarianceSeries(returns, p);
    return { sigma: Math.sqrt(s2[s2.length - 1]), params: p, series: s2 };
  } catch {
    return null;
  }
}

function garchHorizonSigma(g, h) {
  const sigma2 = g.sigma * g.sigma;
  const uncond = g.params.omega / Math.max(1 - g.params.alpha - g.params.beta, 1e-9);
  const persistence = g.params.alpha + g.params.beta;
  let sum = 0;
  for (let k = 1; k <= h; k++) {
    sum += uncond + Math.pow(persistence, k) * (sigma2 - uncond);
  }
  return Math.sqrt(Math.max(sum, 1e-10));
}

// ── 3. FHS：条件波动 × 历史标准化 h 日残差 ──────────────────
function fhsInterval(returns, close, sigmaDaily, h, z) {
  if (returns.length < h + 20) return null;
  const sigma = sigmaDaily || ewmaSigmaDaily(returns);
  const wins = [];
  for (let i = 0; i + h < returns.length; i++) {
    const cum = returns.slice(i + 1, i + h + 1).reduce((a, b) => a + b, 0);
    const sd = sigma * Math.sqrt(h);
    wins.push(cum / sd);
  }
  const lo = quantile(wins, (1 - z95ToProb(z)) / 2);
  const hi = quantile(wins, 1 - (1 - z95ToProb(z)) / 2);
  const move = sigma * Math.sqrt(h);
  return [round1(close * Math.exp(lo * move)), round1(close * Math.exp(hi * move))];
}

function z95ToProb(z) {
  return z >= 1.9 ? 0.95 : 0.68;
}

// ── 4. EVT-POT：广义帕累托尾部 ───────────────────────────────
function fitGpd(excess) {
  if (excess.length < 20) return null;
  const n = excess.length;
  const m = mean(excess);
  const f = (p) => {
    const sigma = Math.abs(p[0]) + 1e-9;
    const xi = p[1];
    let ll = 0;
    for (const x of excess) {
      if (xi < -1e-8 && x >= -sigma / xi) return 1e9;
      const t = 1 + (xi * x) / sigma;
      if (t <= 0) return 1e9;
      ll += Math.log(sigma) + (1 + 1 / xi) * Math.log(t);
    }
    return Number.isFinite(ll) ? ll : 1e9;
  };
  const r = nelderMead(f, [m, 0.1], { maxIter: 400 });
  return { sigma: Math.abs(r.params[0]) + 1e-9, xi: r.params[1], n, excessCount: n };
}

function evtPotQuantile(g, p) {
  if (!g) return null;
  if (Math.abs(g.xi) < 1e-6) return g.sigma * Math.log(1 / (1 - p));
  return (g.sigma / g.xi) * (Math.pow(1 / (1 - p), g.xi) - 1);
}

function evtInterval(returns, close, h, z) {
  const losses = returns.map((r) => -r);
  const gains = returns.slice();
  const nTail = Math.max(10, Math.floor(returns.length * 0.1));
  const uLoss = quantile(losses, 0.9);
  const uGain = quantile(gains, 0.9);
  const excessLoss = losses.filter((x) => x > uLoss).map((x) => x - uLoss);
  const excessGain = gains.filter((x) => x > uGain).map((x) => x - uGain);
  const gLoss = fitGpd(excessLoss);
  const gGain = fitGpd(excessGain);
  if (!gLoss || !gGain) return null;
  const q = z >= 1.9 ? 0.95 : 0.68;
  const qLoss = evtPotQuantile(gLoss, q) * Math.sqrt(h);
  const qGain = evtPotQuantile(gGain, q) * Math.sqrt(h);
  return [round1(close * Math.exp(-qLoss)), round1(close * Math.exp(qGain))];
}

// ── 5. ACI 轻量近似：滚动标准化残差分位 + 覆盖率反馈 ────────
function aciInterval(returns, close, sigmaDaily, h, z) {
  if (returns.length < h + 30) return null;
  const sigma = sigmaDaily || ewmaSigmaDaily(returns);
  const wins = [];
  const window = Math.min(60, returns.length - h);
  for (let i = returns.length - window - h; i + h < returns.length; i++) {
    const cum = returns.slice(i + 1, i + h + 1).reduce((a, b) => a + b, 0);
    wins.push(cum / (sigma * Math.sqrt(h)));
  }
  let alpha = z >= 1.9 ? 0.05 : 0.32;
  const sorted = [...wins].sort((a, b) => a - b);
  const missRate = sorted.filter((x) => x < quantile(wins, alpha / 2) || x > quantile(wins, 1 - alpha / 2)).length / wins.length;
  alpha = Math.min(0.2, Math.max(0.01, alpha + 0.02 * (missRate - alpha)));
  const lo = quantile(wins, alpha / 2);
  const hi = quantile(wins, 1 - alpha / 2);
  const move = sigma * Math.sqrt(h);
  return [round1(close * Math.exp(lo * move)), round1(close * Math.exp(hi * move))];
}

// ── 当前状态与模型适配 ───────────────────────────────────────
function currentState(returns, close, hvAnnual, atr5, hvPercentile) {
  const hvDaily = hvAnnual / Math.sqrt(242);
  const atrDaily = atr5 / close;
  const volShiftRatio = hvDaily > 0 ? atrDaily / hvDaily : null;
  const last5 = returns.slice(-5);
  const maxAbs = last5.length ? Math.max(...last5.map(Math.abs)) : 0;
  const tailFlag = hvDaily > 0 && maxAbs > 2.2 * hvDaily;
  const kurt = returns.length >= 30 ? kurtosis(returns.slice(-60)) : null;
  return {
    volShiftRatio: volShiftRatio == null ? null : round4(volShiftRatio),
    hvPercentile: hvPercentile == null ? null : round4(hvPercentile),
    tailFlag,
    kurtosis: kurt == null ? null : round4(kurt)
  };
}

function kurtosis(xs) {
  const m = mean(xs);
  const s = std(xs);
  if (!s) return null;
  const n = xs.length;
  return (xs.reduce((a, x) => a + Math.pow((x - m) / s, 4), 0) / n) - 3;
}

function pickAdopted(state, modelAvailability) {
  const has = (id) => Boolean(modelAvailability[id]);
  let id = 'garch';
  let reason = '当前为有行情品种，GARCH 条件波动率默认适配';
  if (state.tailFlag && has('evt_pot')) { id = 'evt_pot'; reason = '近期出现异常极端单日，极值尾部模型更适配'; }
  else if (state.volShiftRatio != null && state.volShiftRatio >= 1.25 && has('ewma')) { id = 'ewma'; reason = `波动切换比 ${state.volShiftRatio}，近5日波动明显放大，EWMA 反应更快`; }
  else if (state.volShiftRatio != null && state.volShiftRatio <= 0.8 && has('ewma')) { id = 'ewma'; reason = `波动切换比 ${state.volShiftRatio}，近5日波动明显收缩，EWMA 反应更快`; }
  else if (state.hvPercentile != null && state.hvPercentile >= 85 && has('fhs')) { id = 'fhs'; reason = `HV 分位 ${state.hvPercentile}，持续高波动下 FHS 兼顾当前波动与历史肥尾`; }
  else if (state.kurtosis != null && state.kurtosis > 4 && has('fhs')) { id = 'fhs'; reason = `收益峰度 ${state.kurtosis}，分布肥尾，FHS 不假设正态`; }
  else if (has('garch')) { id = 'garch'; reason = '当前为有行情品种，GARCH 条件波动率默认适配'; }
  else if (has('aci')) { id = 'aci'; reason = '其他模型数据不足，ACI 自适应区间兜底'; }
  return { id, reason };
}

// ── 主入口 ──────────────────────────────────────────────────
function computePredictionIntervals({ bars, close, hvAnnual, atr5, hvPercentile, tailReturns = null }) {
  const closes = bars.map((b) => b.close);
  const returns = logReturns(closes);
  const tail = Array.isArray(tailReturns) && tailReturns.length >= 60 ? tailReturns : returns;
  const sigmaEwma = ewmaSigmaDaily(returns);
  const garch = garchSigmaDaily(returns);
  const sigmaGarch = garch ? garch.sigma : null;
  const state = currentState(returns, close, hvAnnual, atr5, hvPercentile);
  const models = [];
  const availability = {};

  const pushModel = (id, name, principle, p95ByPeriod) => {
    if (!p95ByPeriod) return;
    availability[id] = true;
    models.push({ id, name, principle, intervals: PERIODS.map((h) => ({ period: h, p95: p95ByPeriod[h] })) });
  };

  pushModel('ewma', 'EWMA 条件波动率', '近期波动指数加权，对波动突变反应快（RiskMetrics 1996）',
    intervalMap(sigmaEwma, (h, z) => bandFromDailySigma(close, sigmaEwma, h, z)));
  pushModel('garch', 'GARCH(1,1)', '波动率聚集建模：大波动后往往仍是大波动（Bollerslev 1986）',
    sigmaGarch ? intervalMapForGarch(close, garch) : null);
  pushModel('fhs', 'Filtered Historical Simulation', '当前条件波动 × 历史标准化残差，保留肥尾（Barone-Adesi 1999）',
    intervalMap(sigmaGarch || sigmaEwma, (h, z) => fhsInterval(returns, close, sigmaGarch || sigmaEwma, h, z)));
  pushModel('evt_pot', 'EVT-POT', '只用极端收益拟合广义帕累托分布，尾部外沿更稳（McNeil & Frey 2000）',
    intervalMapForFn((h, z) => evtInterval(tail, close, h, z)));
  pushModel('aci', 'ACI 自适应共形', '分布无关，按最近覆盖率反馈自动校准（Gibbs & Candès 2021，轻量近似）',
    intervalMap(sigmaGarch || sigmaEwma, (h, z) => aciInterval(returns, close, sigmaGarch || sigmaEwma, h, z)));

  const adopted = pickAdopted(state, availability);
  const winner = models.find((m) => m.id === adopted.id);
  if (!winner) return null;

  // 参考区间 = 胜出模型的 p68/p95（供 cone/策略层使用）
  const referenceCone = {};
  for (const h of PERIODS) {
    const p95 = winner.intervals.find((x) => x.period === h).p95;
    const sigmaSel = winner.id === 'garch' ? garchHorizonSigma(garch, h) : null;
    // 用胜出模型自己的 p95 反推 p68：对数对称区间内按 z=1/1.96 比例缩放
    const move95 = Math.log(p95[1] / close);
    const move68 = move95 / 1.96;
    referenceCone[`${h}d`] = {
      p68: [round1(close * Math.exp(-move68)), round1(close * Math.exp(move68))],
      p95
    };
  }

  return {
    currentState: state,
    intervalModels: models,
    adoptedModel: adopted.id,
    referenceInterval: {
      modelId: adopted.id,
      modelName: winner.name,
      reason: adopted.reason,
      cone: referenceCone
    }
  };
}

function intervalMap(sigma, fn) {
  if (sigma == null) return null;
  const out = {};
  for (const h of PERIODS) {
    const p95 = fn(h, 1.96);
    if (p95) out[h] = p95;
  }
  return Object.keys(out).length === PERIODS.length ? out : null;
}

function intervalMapForFn(fn) {
  const out = {};
  for (const h of PERIODS) {
    const p95 = fn(h, 1.96);
    if (p95) out[h] = p95;
  }
  return Object.keys(out).length === PERIODS.length ? out : null;
}

function intervalMapForGarch(close, g) {
  const out = {};
  for (const h of PERIODS) {
    const sigmaH = garchHorizonSigma(g, h);
    out[h] = bandFromDailySigma(close, sigmaH, h, 1.96);
  }
  return out;
}

module.exports = { computePredictionIntervals, ewmaSigmaDaily, garchSigmaDaily, logReturns, quantile, fitGpd, evtInterval, Z };
