// falsification harness — statistics library (pure, deterministic)
// All functions are pure; randomness only via injected Rng for bootstrap.
'use strict';

const { Rng, assert, isFiniteNum, round } = require('./util.cjs');

// ---------- basic moments ----------
function mean(xs) {
  const a = xs.filter(isFiniteNum);
  if (a.length === 0) return null;
  return a.reduce((s, v) => s + v, 0) / a.length;
}

function std(xs, ddof = 1) {
  const a = xs.filter(isFiniteNum);
  const n = a.length;
  if (n < 2) return null;
  const m = mean(a);
  const v = a.reduce((s, v) => s + (v - m) ** 2, 0) / (n - ddof);
  return Math.sqrt(v);
}

// Sharpe on a trade-level R series = mean/std (per-trade convention, documented in 16-harness.md)
function sharpeTrade(xs) {
  const m = mean(xs);
  const s = std(xs, 1);
  if (m === null || s === null || s === 0) return null;
  return m / s;
}

function profitFactor(xs) {
  const a = xs.filter(isFiniteNum);
  const wins = a.filter((v) => v > 0).reduce((s, v) => s + v, 0);
  const losses = a.filter((v) => v < 0).reduce((s, v) => s + Math.abs(v), 0);
  if (losses === 0) return wins > 0 ? Infinity : 0;
  return wins / losses;
}

function hitRateNet(xs) {
  const a = xs.filter(isFiniteNum);
  if (a.length === 0) return null;
  return a.filter((v) => v > 0).length / a.length;
}

function hitRateDirection(trades) {
  // share of trades whose directional bet was correct (direction sign matches netR sign)
  if (!trades || trades.length === 0) return null;
  const ok = trades.filter((t) => isFiniteNum(t.netR) && isFiniteNum(t.direction));
  if (ok.length === 0) return null;
  const correct = ok.filter((t) => (t.direction > 0 && t.netR > 0) || (t.direction < 0 && t.netR < 0));
  return correct.length / ok.length;
}

// ---------- distributions ----------
// Abramowitz & Stegun 7.1.26 erf approximation (|err| < 1.5e-7)
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t *
      Math.exp(-ax * ax);
  return sign * y;
}

function normalCdf(x) {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

// regularized incomplete beta via continued fraction (Lentz), for Student-t CDF
function betacf(a, b, x) {
  const MAXIT = 200;
  const EPS = 3e-14;
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

function regIncompleteBeta(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(
    lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x)
  );
  if (x < (a + 1) / (a + b + 2)) return (bt * betacf(a, b, x)) / a;
  return 1 - (bt * betacf(b, a, 1 - x)) / b;
}

function lgamma(x) {
  // Lanczos approximation (g=7, n=9)
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (x < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  }
  x -= 1;
  let a = c[0];
  const t = x + g + 0.5;
  for (let i = 1; i < c.length; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

function tcdf(t, df) {
  if (df <= 0) return normalCdf(t);
  const x = df / (df + t * t);
  const ib = regIncompleteBeta(df / 2, 0.5, x);
  if (t >= 0) return 1 - 0.5 * ib;
  return 0.5 * ib;
}

function tTestOneSample(xs, mu0 = 0) {
  const a = xs.filter(isFiniteNum);
  const n = a.length;
  if (n < 2) return { n, t: null, p: null, mean: mean(a) ?? null };
  const m = mean(a);
  const s = std(a, 1);
  if (s === 0) return { n, t: m === mu0 ? 0 : (m > mu0 ? Infinity : -Infinity), p: m === mu0 ? 1 : 0, mean: m };
  const t = ((m - mu0) / s) * Math.sqrt(n);
  const p = 2 * (1 - tcdf(Math.abs(t), n - 1));
  return { n, t, p, mean: m };
}

function welchTTest(xs, ys) {
  const a = xs.filter(isFiniteNum);
  const b = ys.filter(isFiniteNum);
  if (a.length < 2 || b.length < 2) return { n1: a.length, n2: b.length, t: null, p: null };
  const m1 = mean(a); const m2 = mean(b);
  const v1 = std(a, 1) ** 2 / a.length;
  const v2 = std(b, 1) ** 2 / b.length;
  const se = Math.sqrt(v1 + v2);
  if (se === 0) return { n1: a.length, n2: b.length, t: m1 === m2 ? 0 : (m1 > m2 ? Infinity : -Infinity), p: m1 === m2 ? 1 : 0 };
  const t = (m1 - m2) / se;
  const df = (v1 + v2) ** 2 / (v1 ** 2 / (a.length - 1) + v2 ** 2 / (b.length - 1));
  const p = 2 * (1 - tcdf(Math.abs(t), df));
  return { n1: a.length, n2: b.length, t, p, mean1: m1, mean2: m2 };
}

function binomialTest(k, n, p0 = 0.5, side = 'two') {
  // exact binomial p-value
  if (n <= 0) return { k, n, p: null };
  const logP = (j) =>
    lgamma(n + 1) - lgamma(j + 1) - lgamma(n - j + 1) + j * Math.log(p0) + (n - j) * Math.log(1 - p0);
  const obsP = Math.exp(logP(k));
  let p = 0;
  for (let j = 0; j <= n; j++) {
    const pj = Math.exp(logP(j));
    if (side === 'two' && pj <= obsP * (1 + 1e-12)) p += pj;
    if (side === 'greater' && j >= k) p += pj;
    if (side === 'less' && j <= k) p += pj;
  }
  if (side === 'two') p = Math.min(1, p);
  return { k, n, p };
}

// ---------- bootstrap (seeded, percentile) ----------
function bootstrapMeanCI(xs, { level = 0.95, B = 10000, seed = 20260828 } = {}) {
  const a = xs.filter(isFiniteNum);
  const n = a.length;
  const obs = mean(a);
  if (n < 5) return { lo: null, hi: null, obs, n, B: 0, method: 'bootstrap-percentile' };
  const rng = new Rng(seed);
  const means = new Array(B);
  for (let b = 0; b < B; b++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += a[rng.int(n)];
    means[b] = s / n;
  }
  means.sort((x, y) => x - y);
  const alpha = 1 - level;
  const lo = means[Math.max(0, Math.floor((alpha / 2) * B))];
  const hi = means[Math.min(B - 1, Math.floor((1 - alpha / 2) * B))];
  return { lo, hi, obs, n, B, method: 'bootstrap-percentile', seed };
}

// paired bootstrap: resample indices jointly from two aligned series; CI of mean(x-y)
function bootstrapPairedDiffCI(xs, ys, { level = 0.95, B = 10000, seed = 20260828 } = {}) {
  const a = xs.filter(isFiniteNum);
  const b = ys.filter(isFiniteNum);
  const n = Math.min(a.length, b.length);
  if (n < 5) return { lo: null, hi: null, obsDiff: null, n, B: 0, method: 'bootstrap-paired-diff' };
  const x = a.slice(0, n);
  const y = b.slice(0, n);
  const diffs = x.map((v, i) => v - y[i]);
  const obsDiff = mean(diffs);
  const rng = new Rng(seed);
  const means = new Array(B);
  for (let b = 0; b < B; b++) {
    let s = 0;
    for (let i = 0; i < n; i++) {
      const j = rng.int(n);
      s += diffs[j];
    }
    means[b] = s / n;
  }
  means.sort((p, q) => p - q);
  const alpha = 1 - level;
  return {
    lo: means[Math.max(0, Math.floor((alpha / 2) * B))],
    hi: means[Math.min(B - 1, Math.floor((1 - alpha / 2) * B))],
    obsDiff,
    n,
    B,
    method: 'bootstrap-paired-diff',
    seed,
  };
}

// ---------- regressions ----------
function ols(xs, ys) {
  // y = alpha + beta*x + e
  const n = Math.min(xs.length, ys.length);
  assert(n >= 3, 'ols needs >=3 aligned points');
  const x = xs.slice(0, n);
  const y = ys.slice(0, n);
  const mx = mean(x); const my = mean(y);
  let sxx = 0; let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (x[i] - mx) ** 2;
    sxy += (x[i] - mx) * (y[i] - my);
  }
  if (sxx === 0) return { n, alpha: my, beta: 0, seBeta: null, r2: null, tStat: null, resid: y.map((v) => v - my) };
  const beta = sxy / sxx;
  const alpha = my - beta * mx;
  const resid = y.map((v, i) => v - alpha - beta * x[i]);
  const sse = resid.reduce((s, v) => s + v * v, 0);
  const sst = y.reduce((s, v) => s + (v - my) ** 2, 0);
  const r2 = sst === 0 ? 1 : 1 - sse / sst;
  const dof = n - 2;
  const seBeta = dof > 0 ? Math.sqrt(sse / dof / sxx) : null;
  const tStat = seBeta ? beta / seBeta : null;
  return { n, alpha, beta, seBeta, r2, tStat, resid };
}

// ---------- unit root / cointegration ----------
const DF_CV_CONST = { 0.01: -3.4336, 0.05: -2.8621, 0.10: -2.5671 }; // asymptotic, constant case (Hamilton)
const EG2_CV = { 0.01: -4.07, 0.05: -3.37, 0.10: -3.03 }; // Engle-Yoo residual ADF, N=2, approximate

function _adfStat(y) {
  const n = y.length;
  const dy = new Array(n - 1);
  const lag = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    dy[i] = y[i + 1] - y[i];
    lag[i] = y[i];
  }
  const r = ols(lag, dy);
  // t-stat on rho = beta (coefficient on lagged level)
  return { tStat: r.seBeta === null || r.seBeta === 0 ? null : r.beta / r.seBeta, beta: r.beta, resid: r.resid, n };
}

// interpolate p-approx from CV table; returns {pApprox, reject05, reject10}
function _pFromTable(tStat, cvTable) {
  if (tStat === null || !isFiniteNum(tStat)) return { pApprox: null, reject05: null, reject10: null };
  if (tStat <= cvTable[0.01]) return { pApprox: 0.01, reject05: true, reject10: true };
  if (tStat >= cvTable[0.10]) return { pApprox: 0.10, reject05: false, reject10: false };
  if (tStat <= cvTable[0.05]) {
    // linear interp between 1% and 5%
    const frac = (cvTable[0.01] - tStat) / (cvTable[0.01] - cvTable[0.05]);
    const p = 0.01 + frac * 0.04;
    return { pApprox: p, reject05: true, reject10: true };
  }
  // between 5% and 10%
  const frac = (cvTable[0.05] - tStat) / (cvTable[0.05] - cvTable[0.10]);
  const p = 0.05 + frac * 0.05;
  return { pApprox: p, reject05: false, reject10: true };
}

function adf(y, { table = 'df-const' } = {}) {
  const cvTable = table === 'eg2' ? EG2_CV : DF_CV_CONST;
  const { tStat, beta, resid, n } = _adfStat(y);
  const pv = _pFromTable(tStat, cvTable);
  return { tStat, beta, n, pApprox: pv.pApprox, reject05: pv.reject05, reject10: pv.reject10, table, resid };
}

// Engle-Granger two-step for pair (y on x with constant) → residual series + residual ADF
function engleGranger(y, x) {
  const r = ols(x, y);
  const resid = r.resid;
  const a = adf(resid, { table: 'eg2' });
  return { alpha: r.alpha, beta: r.beta, seBeta: r.seBeta, r2: r.r2, resid, adf: a };
}

// ECM error-correction: Δy_t = α + γ * e_{t-1} + β*Δx_t (no lags) → γ estimate
function ecmGamma(y, x, residSeries) {
  const n = Math.min(y.length, x.length, residSeries.length) - 1;
  assert(n >= 3, 'ecm needs >=4 aligned points');
  // regress dy on [e_lag, dx]
  const dy = new Array(n);
  const eLag = new Array(n);
  const dx = new Array(n);
  for (let i = 0; i < n; i++) {
    dy[i] = y[i + 1] - y[i];
    eLag[i] = residSeries[i];
    dx[i] = x[i + 1] - x[i];
  }
  // two-step partial: full multiple regression via normal equations
  const mx1 = mean(eLag); const mx2 = mean(dx); const my = mean(dy);
  let s11 = 0; let s22 = 0; let s12 = 0; let sy1 = 0; let sy2 = 0;
  for (let i = 0; i < n; i++) {
    s11 += (eLag[i] - mx1) ** 2;
    s22 += (dx[i] - mx2) ** 2;
    s12 += (eLag[i] - mx1) * (dx[i] - mx2);
    sy1 += (dy[i] - my) * (eLag[i] - mx1);
    sy2 += (dy[i] - my) * (dx[i] - mx2);
  }
  const det = s11 * s22 - s12 * s12;
  if (det === 0) return { n, gamma: null, betaDx: null, alpha: null, seGamma: null, tStat: null };
  const gamma = (sy1 * s22 - sy2 * s12) / det;
  const betaDx = (sy2 * s11 - sy1 * s12) / det;
  const alpha = my - gamma * mx1 - betaDx * mx2;
  const resid = dy.map((v, i) => v - alpha - gamma * eLag[i] - betaDx * dx[i]);
  const sse = resid.reduce((s, v) => s + v * v, 0);
  const dof = n - 3;
  const varGamma = dof > 0 ? (sse / dof) * (s22 / det) : null;
  const seGamma = varGamma ? Math.sqrt(varGamma) : null;
  return { n, gamma, betaDx, alpha, seGamma, tStat: seGamma ? gamma / seGamma : null, resid };
}

// rolling OLS on PIT slices: x/y arrays are aligned, window ends at anchorIdx (inclusive)
function rollingOls(x, y, window, anchorIdx, minObs = 30) {
  const start = Math.max(0, anchorIdx - window + 1);
  const xs = x.slice(start, anchorIdx + 1);
  const ys = y.slice(start, anchorIdx + 1);
  if (xs.length < minObs) return null;
  return ols(xs, ys);
}

module.exports = {
  mean, std, sharpeTrade, profitFactor, hitRateNet, hitRateDirection,
  erf, normalCdf, tcdf, lgamma,
  tTestOneSample, welchTTest, binomialTest,
  bootstrapMeanCI, bootstrapPairedDiffCI,
  ols, adf, engleGranger, ecmGamma, rollingOls,
  DF_CV_CONST, EG2_CV,
  round,
};
