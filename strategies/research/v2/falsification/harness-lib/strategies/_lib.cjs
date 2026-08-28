// falsification harness — shared helpers for strategy adapters
// All computations are PIT: views are anchored at the signal bar; lookups use .at() only.
'use strict';

const path = require('node:path');
const { REPO_ROOT, isFiniteNum } = require('../util.cjs');
const S = require('../stats.cjs');
const { probabilityCone } = require(path.join(REPO_ROOT, 'probability', 'probability-cone.js'));

// ---------- incremental EMA ----------
function emaUpdate(state, value, targetIdx, n = 20) {
  // state: {ema: [..], upto: idx} — extends the EMA series to targetIdx using value[idx]
  if (!state.ema) {
    state.ema = [];
    state.upto = -1;
  }
  const k = 2 / (n + 1);
  while (state.upto < targetIdx) {
    const v = value(state.upto + 1);
    if (v === null || !isFiniteNum(v)) break; // stop at nulls (won't progress past data gaps)
    if (state.ema.length === 0) state.ema.push(v);
    else state.ema.push(k * v + (1 - k) * state.ema[state.ema.length - 1]);
    state.upto += 1;
  }
  return state;
}

function emaAt(state, i) {
  if (!state.ema || i < 0 || i >= state.ema.length) return null;
  return state.ema[i];
}

// g_t = (EMA_t − EMA_{t−5}) / (5 × EMA_{t−5})
function gSlope(state, i, span = 5) {
  const a = emaAt(state, i);
  const b = emaAt(state, i - span);
  if (!isFiniteNum(a) || !isFiniteNum(b) || b === 0) return null;
  return (a - b) / (span * b);
}

// ---------- PIT window statistics over views ----------
function windowMean(view, field, idx, window) {
  let s = 0;
  let n = 0;
  for (let i = idx - window + 1; i <= idx; i++) {
    const v = view.at(field, i);
    if (isFiniteNum(v)) { s += v; n += 1; }
  }
  return n ? s / n : null;
}

function windowStd(view, field, idx, window, mu = null) {
  const m = mu !== null ? mu : windowMean(view, field, idx, window);
  if (m === null) return null;
  let s = 0;
  let n = 0;
  for (let i = idx - window + 1; i <= idx; i++) {
    const v = view.at(field, i);
    if (isFiniteNum(v)) { s += (v - m) ** 2; n += 1; }
  }
  return n > 1 ? Math.sqrt(s / (n - 1)) : null;
}

function windowMin(view, field, idx, window, startOffset = 0) {
  let m = Infinity;
  for (let i = idx - window + 1; i <= idx - startOffset; i++) {
    const v = view.at(field, i);
    if (isFiniteNum(v) && v < m) m = v;
  }
  return isFiniteNum(m) ? m : null;
}

function windowMax(view, field, idx, window, startOffset = 0) {
  let m = -Infinity;
  for (let i = idx - window + 1; i <= idx - startOffset; i++) {
    const v = view.at(field, i);
    if (isFiniteNum(v) && v > m) m = v;
  }
  return isFiniteNum(m) ? m : null;
}

// OLS y ~ x over window ending at idx (aligned views); returns null if insufficient data
function olsWindow(xView, yView, fieldX, fieldY, idx, window, minObs = 30) {
  const xs = [];
  const ys = [];
  for (let i = idx - window + 1; i <= idx; i++) {
    const x = xView.at(fieldX, i);
    const y = yView.at(fieldY, i);
    if (isFiniteNum(x) && isFiniteNum(y)) { xs.push(x); ys.push(y); }
  }
  if (xs.length < minObs) return null;
  return S.ols(xs, ys);
}

// residual series of the rolling OLS (aligned with view indexes)
function olsResidualsAt(xView, yView, fieldX, fieldY, idx, window) {
  const r = olsWindow(xView, yView, fieldX, fieldY, idx, window);
  if (!r) return null;
  const resid = [];
  for (let i = idx - window + 1; i <= idx; i++) {
    const x = xView.at(fieldX, i);
    const y = yView.at(fieldY, i);
    if (isFiniteNum(x) && isFiniteNum(y)) resid.push(y - r.alpha - r.beta * x);
    else resid.push(null);
  }
  return { ...r, resid };
}

function adfOn(residValues, table = 'df-const') {
  const y = residValues.filter(isFiniteNum);
  if (y.length < 30) return null;
  return S.adf(y, { table });
}

// Engle-Granger on rolling window (P1 ~ P2)
function egWindow(view1, view2, idx, window) {
  const r = olsResidualsAt(view2, view1, 'close', 'close', idx, window);
  if (!r) return null;
  const resid = r.resid.filter(isFiniteNum);
  if (resid.length < 30) return null;
  const adf = S.adf(resid, { table: 'eg2' });
  return { alpha: r.alpha, beta: r.beta, seBeta: r.seBeta, r2: r.r2, adf, resid: r.resid };
}

// ECM γ: Δy = α + γ·e_{t−1} + β·Δx (rolling window)
function ecmWindow(viewY, viewX, residAt, idx, window) {
  // residAt(i): residual e_i from the cointegrating regression (aligned with view index)
  const n = Math.min(window, idx + 1);
  const dy = [];
  const eLag = [];
  const dx = [];
  for (let i = idx - n + 1; i <= idx - 1; i++) {
    const y0 = viewY.at('close', i);
    const y1 = viewY.at('close', i + 1);
    const x0 = viewX.at('close', i);
    const x1 = viewX.at('close', i + 1);
    const e = residAt(i);
    if (isFiniteNum(y0) && isFiniteNum(y1) && isFiniteNum(x0) && isFiniteNum(x1) && isFiniteNum(e)) {
      dy.push(y1 - y0);
      eLag.push(e);
      dx.push(x1 - x0);
    }
  }
  if (dy.length < 30) return null;
  // multiple regression via normal equations
  const mx1 = S.mean(eLag); const mx2 = S.mean(dx); const my = S.mean(dy);
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
  // two-sided p from t with dof
  const p = tStat === null ? null : 2 * (1 - S.tcdf(Math.abs(tStat), dof));
  return { gamma, seGamma, tStat, p, alpha, betaDx, n: dy.length };
}

// 3d cone at signal bar (cap-6: PIT recompute from close_T + hv20_T)
function cone3d(close, hv20) {
  if (!isFiniteNum(close) || !isFiniteNum(hv20) || hv20 <= 0 || close <= 0) return null;
  return probabilityCone(close, hv20, [3], [1.0, 1.96])['3d'];
}

module.exports = {
  emaUpdate, emaAt, gSlope,
  windowMean, windowStd, windowMin, windowMax,
  olsWindow, olsResidualsAt, adfOn, egWindow, ecmWindow,
  cone3d,
};
