// report/render-signal-pool-html.cjs — 信号池看板渲染库（供 dashboard 复用）
//
// 注意：独立的 signal-pool.html 已废弃，信号池看板统一在 dashboard.html（Tab2）展示。
// 本模块保留 signalCard / statsTable / escapeHtml 等纯渲染函数，由 render-dashboard-html.cjs 引用。
//
// Tab1 信号池看板：池内信号全量卡片 + 最近出池 5 个 + 历史统计；
//                  信号与策略版本均可展开（原生 <details>）。
// Tab2 完整报告：仅放当前 run 的 report.md 索引链接。
//
// 纪律：确定性、不联网、不调用 LLM、无外部 CSS/JS 依赖；所有字段转义。

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { skillRoot, runtimeRoot, runDir } = require('../shared/workspace.cjs');
const {
  statusBadge,
  directionLabel,
  confidenceLabel,
  poolStatusLabel,
  closeReasonLabel,
  closeClassLabel,
  verdictLabel,
  signalVerificationLabel,
  signalVersionVerificationLabel,
  versionExitDetail,
  stateEmoji
} = require('./render-strategy-section.cjs');
const {
  versionStateOf,
  eventLabel,
  directionResultLabel,
  executionResultLabel
} = require('../shared/strategy-state.cjs');

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmt(x, d = 1) {
  if (x === null || x === undefined || Number.isNaN(Number(x))) return '—';
  return Number(x).toFixed(d);
}

function pctChange(start, latest) {
  if (start == null || latest == null || Number(start) === 0) return null;
  const pct = (Number(latest) - Number(start)) / Number(start) * 100;
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

function readJSON(p, fallback = null) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function extractBarsLocal(raw, symbol) {
  const c = raw && raw.contracts && raw.contracts[symbol];
  const o = c && c.ohlcv;
  if (!o || !Array.isArray(o.dates) || o.dates.length < 2) return null;
  const bars = [];
  for (let i = 0; i < o.dates.length; i++) {
    bars.push({ date: o.dates[i], open: o.open[i], high: o.high[i], low: o.low[i], close: o.close[i] });
  }
  return bars;
}

function contractBarsLocal(contract) {
  if (!contract) return null;
  const file = path.join(skillRoot, 'data', 'contract-bars', `${contract}.json`);
  const wrapper = readJSON(file);
  const map = new Map();
  if (wrapper && wrapper.runs) {
    for (const rid of Object.keys(wrapper.runs)) {
      const bars = wrapper.runs[rid] && wrapper.runs[rid].bars;
      if (!Array.isArray(bars)) continue;
      for (const b of bars) if (b && b.date) map.set(b.date, b);
    }
  }
  const bars = [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
  return bars.length >= 2 ? bars : null;
}

function barsForSignal(sig, raw) {
  let bars = extractBarsLocal(raw, sig.symbol);
  if (!bars) bars = contractBarsLocal(sig.contract);
  return bars || [];
}

function signalTitle(sig) {
  const status = poolStatusLabel(sig);
  const emoji = sig.poolStatus === 'closed' ? '⚫' : sig.poolStatus === 'downgraded' ? '🟡' : '🟢';
  const name = `${sig.name || sig.symbol}（${sig.contract || sig.symbol}）`;
  return `${emoji} ${sig.signalId} · ${name} · ${directionLabel(sig.direction)} · ${status}`;
}

function fieldRow(label, value) {
  return `<tr><th>${escapeHtml(label)}</th><td>${value}</td></tr>`;
}

function versionBody(v) {
  const e = v.entry || {};
  const stop = v.stop || {};
  const t = v.targets || {};
  const inv = v.invalidation || {};
  const reg = v.regime || {};
  const rows = [
    fieldRow('触发', `${escapeHtml(e.trigger || '—')}${e.triggerLevel != null ? `<br><span class="muted">触发价 ${fmt(e.triggerLevel)}</span>` : ''}`),
    fieldRow('执行', `${escapeHtml(e.triggerTiming || '—')}<br><span class="muted">${escapeHtml(e.execution || '')}</span>`),
    fieldRow('止损', stop.stopPrice != null ? `${fmt(stop.stopPrice)} <span class="muted">${escapeHtml(stop.basis || '')}</span>` : '—'),
    fieldRow('目标', `${escapeHtml(t.t1 || '—')}<br><span class="muted">${escapeHtml(t.t2 || '')}</span>`),
    fieldRow('失效', escapeHtml((inv.hard || []).join('；') || '—')),
    fieldRow('计划离场', escapeHtml(inv.timeStop || '—')),
    fieldRow('验证', signalVersionVerificationLabel(v)),
    ...(versionExitDetail(v) ? [fieldRow('实际离场', escapeHtml(versionExitDetail(v)))] : []),
    fieldRow('regime', `${escapeHtml(reg.grade || '—')} / ${escapeHtml(reg.direction || '—')}`)
  ];
  return `<table class="fields">${rows.join('')}</table>`;
}

function versionSummary(v) {
  const num = String(v.versionId).includes(':V') ? String(v.versionId).split(':V')[1] : v.versionId;
  const state = versionStateOf(v);
  const trig = v.entry && v.entry.triggerLevel != null ? ` · 触发 ${fmt(v.entry.triggerLevel, 0)}` : '';
  const exitDetail = versionExitDetail(v);
  const reason = exitDetail ? ` · <span class="muted">${escapeHtml(exitDetail)}</span>` : '';
  return `V${num} · ${stateEmoji(state)} ${signalVersionVerificationLabel(v)} · ${v.signalDate}${trig}${reason}`;
}

function progressBar(progress) {
  if (progress == null) return '—';
  const pct = Math.max(0, Math.min(100, progress * 100));
  return `<span class="progress"><span class="progress-fill" style="width:${pct.toFixed(0)}%"></span></span><span class="progress-text">${Math.round(pct)}%</span>`;
}

function timelineBlock(sig) {
  const obs = Array.isArray(sig.observations) ? sig.observations.slice(-8) : [];
  if (obs.length === 0) return '';
  const posLabel = (p) => p === 'holding' ? '持仓中' : p === 'triggered' ? '待入场' : p === 'pending' ? '待验证' : p === 'exited' ? '已离场' : '—';
  const rows = obs.map((o) => {
    const ev = Array.isArray(o.events) && o.events.length
      ? o.events.map((e) => (typeof e === 'string' ? e : (e && e.label) || (e && e.code) || '—')).join(' · ')
      : '—';
    const prog = o.fulfillProgress == null ? '—' : `${Math.round(o.fulfillProgress * 100)}%`;
    const dist = o.invalidationDistance == null ? '—' : `${fmt(o.invalidationDistance)} ATR`;
    return `<tr><td>${escapeHtml(o.date)}</td><td>${escapeHtml(ev)}</td><td>${posLabel(o.positionStatus)}</td><td>${prog}</td><td>${dist}</td></tr>`;
  }).join('');
  return `<h4>时间线</h4><table class="timeline"><tr><th>日期</th><th>事件</th><th>持仓</th><th>兑现进度</th><th>失效距离</th></tr>${rows}</table>`;
}

function anchorPanel(sig) {
  const a = sig.anchor;
  if (!a) return '';
  const entryCell = a.entryPrice != null ? `${fmt(a.entryPrice)}` : (a.status === 'skipped_gap' ? '—（执行偏离放弃）' : a.status === 'invalidated_not_triggered' ? '—（未触发）' : a.status === 'triggered_pending_entry' ? 'T+2 待定' : '—');
  const latest = sig.priceTracking && sig.priceTracking.latestClose != null ? fmt(sig.priceTracking.latestClose) : '—';
  let pnlCell = '—';
  if (a.status === 'holding' && a.entryPrice != null) {
    if (a.floatingPnlPts != null) {
      const sign = a.floatingPnlPts >= 0 ? '+' : '';
      const cls = a.floatingPnlPts >= 0 ? 'up' : 'down';
      pnlCell = `<span class="${cls}">${sign}${fmt(a.floatingPnlPts)} 点（${a.floatingPnlPct >= 0 ? '+' : ''}${a.floatingPnlPct}%）</span> · 持仓中`;
    } else {
      pnlCell = '持仓中';
    }
  } else if (a.entryPrice != null && a.exitPrice != null && a.realizedPnlPts != null) {
    const sign = a.realizedPnlPts >= 0 ? '+' : '';
    const cls = a.realizedPnlPts >= 0 ? 'up' : 'down';
    const exitLabel = a.exitType === 'time_exit' ? `时间离场${a.exitDate ? ' ' + a.exitDate : ''}` : a.exitType === 'stopped_out' ? `止损离场${a.exitDate ? ' ' + a.exitDate : ''}` : a.exitType === 'target1_hit' ? `目标1兑现${a.exitDate ? ' ' + a.exitDate : ''}` : '已离场';
    pnlCell = `<span class="${cls}">${sign}${fmt(a.realizedPnlPts)} 点（${a.realizedPnlPct >= 0 ? '+' : ''}${a.realizedPnlPct}%）</span> · ${exitLabel}`;
  } else if (a.status === 'verified') {
    pnlCell = '—';
  }
  const prog = progressBar(sig.fulfillProgress);
  const dist = sig.invalidationDistance != null ? `${fmt(sig.invalidationDistance)} ATR` : '—';
  const posNote = a.positionStatus === 'holding'
    ? '<div class="anchor-sub pos-holding">持仓中 · 降级计数暂停生效</div>'
    : a.positionStatus === 'triggered'
      ? '<div class="anchor-sub pos-triggered">已触发，待 T+2 入场 · 降级计数暂停生效</div>'
      : '';
  return `<div class="anchor-panel">
    <div class="anchor-head">锚定策略：${escapeHtml(a.versionId)} · ${escapeHtml(eventLabel(a.executionStatus === 'executable' ? 'armed' : a.executionStatus === 'skip' ? 'suspended' : a.executionStatus === 'watch' ? 'watching' : (a.executionStatus || '—'), 'execution'))} · ${escapeHtml(a.signalDate)}</div>
    ${posNote}
    ${a.timeStop ? `<div class="anchor-sub">计划离场：${escapeHtml(a.timeStop)}</div>` : ''}
    <div class="anchor-grid">
      <div class="anchor-item"><span>入场价格</span><b>${entryCell}</b></div>
      <div class="anchor-item"><span>最新价格</span><b>${latest}</b></div>
      <div class="anchor-item"><span>盈亏</span><b>${pnlCell}</b></div>
      <div class="anchor-item"><span>兑现进度</span>${prog}</div>
      <div class="anchor-item"><span>失效距离</span><b>${dist}</b></div>
    </div>
  </div>`;
}

function lifecycleChart(sig, versions, bars) {
  const a = sig.anchor;
  if (!a) return '';
  const fullBars = Array.isArray(bars) ? bars : [];
  let startIdx = fullBars.findIndex((b) => b.date === sig.createdDate);
  if (startIdx === -1) startIdx = Math.max(0, fullBars.length - 40);
  const win = fullBars.slice(startIdx);
  if (win.length < 2) return '';

  const av = versions.find((v) => v.versionId === a.versionId) || null;
  const lastR = av && av.verification && av.verification.lastResult;
  const skipped = a.status === 'skipped_gap';
  const triggerLevel = a.triggerLevel != null ? Number(a.triggerLevel) : (av && av.entry && av.entry.triggerLevel != null ? Number(av.entry.triggerLevel) : null);
  const stopPrice = av && av.stop && av.stop.stopPrice != null ? Number(av.stop.stopPrice) : null;
  const entryPrice = a.entryPrice != null ? Number(a.entryPrice) : (skipped && lastR && lastR.entryPrice != null ? Number(lastR.entryPrice) : null);
  const entryDate = a.entryDate || (skipped && lastR && lastR.entryDate ? lastR.entryDate : null);
  const exitPrice = a.exitPrice != null ? Number(a.exitPrice) : null;
  const exitDate = a.exitDate || null;

  const W = 780;
  const H = 240;
  const padL = 46;
  const padR = 84;
  const padT = 20;
  const padB = 26;
  const n = win.length;
  const step = (W - padL - padR) / n;
  const bodyW = Math.max(2, Math.min(8, step * 0.55));
  const x = (i) => padL + i * step + step / 2;

  let min = Infinity;
  let max = -Infinity;
  for (const b of win) {
    min = Math.min(min, b.low);
    max = Math.max(max, b.high);
  }
  for (const v of [triggerLevel, stopPrice, entryPrice, exitPrice]) {
    if (v != null) {
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || max === min) max = min + 1;
  const pad = (max - min) * 0.07;
  min -= pad;
  max += pad;
  const y = (v) => padT + ((max - v) / (max - min)) * (H - padT - padB);

  const parts = [];
  parts.push(`<svg class="lifecycle-chart" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img">`);
  for (let i = 0; i <= 4; i++) {
    const gy = padT + (i / 4) * (H - padT - padB);
    const gv = max - (i / 4) * (max - min);
    parts.push(`<line x1="${padL}" y1="${gy.toFixed(1)}" x2="${(W - padR).toFixed(1)}" y2="${gy.toFixed(1)}" stroke="#eef0f3" stroke-width="1"/>`);
    parts.push(`<text x="${padL - 6}" y="${(gy + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="#6b7280">${fmt(gv, 0)}</text>`);
  }
  for (let i = 0; i < n; i++) {
    const b = win[i];
    const cx = x(i);
    const up = b.close >= b.open;
    const color = up ? '#b91c1c' : '#047857';
    const yHigh = y(b.high);
    const yLow = y(b.low);
    const yOpen = y(b.open);
    const yClose = y(b.close);
    parts.push(`<line x1="${cx.toFixed(1)}" y1="${yHigh.toFixed(1)}" x2="${cx.toFixed(1)}" y2="${yLow.toFixed(1)}" stroke="${color}" stroke-width="1"/>`);
    const bodyTop = Math.min(yOpen, yClose);
    const bodyH = Math.max(1, Math.abs(yClose - yOpen));
    const chg = i > 0 ? b.close - win[i - 1].close : null;
    const chgPct = i > 0 && win[i - 1].close ? ((b.close / win[i - 1].close) - 1) * 100 : null;
    const tip = `${escapeHtml(b.date)}&#10;开 ${fmt(b.open)} 高 ${fmt(b.high)} 低 ${fmt(b.low)} 收 ${fmt(b.close)}${chg != null ? `&#10;涨跌 ${chg >= 0 ? '+' : ''}${fmt(chg)}（${chgPct >= 0 ? '+' : ''}${chgPct.toFixed(1)}%）` : ''}`;
    parts.push(`<rect x="${(cx - bodyW / 2).toFixed(1)}" y="${bodyTop.toFixed(1)}" width="${bodyW.toFixed(1)}" height="${bodyH.toFixed(1)}" fill="${color}"><title>${tip}</title></rect>`);
  }

  const xOfDate = (date) => {
    if (!date) return null;
    const idx = win.findIndex((b) => b.date === date);
    if (idx >= 0) return x(idx);
    if (date < win[0].date) return x(0);
    if (date > win[win.length - 1].date) return x(n - 1);
    for (let i = 0; i < n - 1; i++) {
      if (date > win[i].date && date < win[i + 1].date) return x(i) + step * 0.5;
    }
    return null;
  };

  const dashedLevel = (level, color, label) => {
    if (level == null) return '';
    const yy = y(level);
    return `<line x1="${padL}" y1="${yy.toFixed(1)}" x2="${(W - padR).toFixed(1)}" y2="${yy.toFixed(1)}" stroke="${color}" stroke-width="1" stroke-dasharray="4 4" opacity="0.6"/><text x="${(W - padR + 4).toFixed(1)}" y="${(yy + 4).toFixed(1)}" font-size="10" fill="${color}">${escapeHtml(label)} ${fmt(level, 0)}</text>`;
  };

  const markers = [];
  const addMarker = (cx, price, color, label, anchor) => {
    if (cx == null || price == null) return;
    markers.push({ cx, cy: y(Number(price)), color, label, anchor });
  };
  if (a.triggerDate && triggerLevel != null) addMarker(xOfDate(a.triggerDate), triggerLevel, '#b45309', `触发 ${a.triggerDate} @ ${fmt(triggerLevel, 0)}`, 'end');
  if (entryDate && entryPrice != null) addMarker(xOfDate(entryDate), entryPrice, skipped ? '#b91c1c' : '#047857', `${skipped ? '放弃执行' : '入场'} ${entryDate} @ ${fmt(entryPrice, 0)}`, skipped ? 'start' : 'end');
  if (exitDate && exitPrice != null) addMarker(xOfDate(exitDate), exitPrice, '#b91c1c', `离场 ${exitDate} @ ${fmt(exitPrice, 0)}`, 'start');

  const avoidOverlap = (items, minGap) => {
    const sorted = [...items].sort((a, b) => a.y - b.y);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].y - sorted[i - 1].y < minGap) sorted[i].y = sorted[i - 1].y + minGap;
    }
    return sorted;
  };
  const textStyle = 'paint-order:stroke;stroke:#ffffff;stroke-width:3px;';

  const levels = [
    { level: triggerLevel, color: '#b45309', label: '触发' },
    { level: stopPrice, color: '#b91c1c', label: '止损' },
    { level: entryPrice, color: skipped ? '#b91c1c' : '#047857', label: skipped ? '放弃' : '入场' },
    { level: exitPrice, color: '#b91c1c', label: '离场' }
  ].filter((l) => l.level != null);
  for (const l of levels) {
    const yy = y(l.level);
    parts.push(`<line x1="${padL}" y1="${yy.toFixed(1)}" x2="${(W - padR).toFixed(1)}" y2="${yy.toFixed(1)}" stroke="${l.color}" stroke-width="1" stroke-dasharray="4 4" opacity="0.6"/>`);
  }
  const levelLabels = avoidOverlap(levels.map((l) => ({ y: y(l.level) + 4, text: `${l.label} ${fmt(l.level, 0)}`, color: l.color })), 13);
  for (const t of levelLabels) {
    const ty = Math.max(padT + 4, Math.min(H - 8, t.y));
    parts.push(`<text x="${(W - padR + 4).toFixed(1)}" y="${ty.toFixed(1)}" font-size="10" fill="${t.color}" style="${textStyle}">${escapeHtml(t.text)}</text>`);
  }

  const markerLabels = avoidOverlap(markers.map((m) => ({
    y: m.anchor === 'start' ? m.cy - 8 : m.cy + 16,
    x: m.cx,
    cy: m.cy,
    text: m.label,
    color: m.color,
    anchor: m.cx > W - padR - 110 ? 'end' : 'start'
  })), 14);
  for (const m of markerLabels) {
    const tx = m.anchor === 'end' ? m.x - 6 : m.x + 6;
    const ty = Math.max(padT + 4, Math.min(H - 8, m.y));
    parts.push(`<circle cx="${m.x.toFixed(1)}" cy="${m.cy.toFixed(1)}" r="4" fill="${m.color}" stroke="#fff" stroke-width="1.5"/>`);
    parts.push(`<text x="${tx.toFixed(1)}" y="${ty.toFixed(1)}" font-size="11" font-weight="600" fill="${m.color}" text-anchor="${m.anchor}" style="${textStyle}">${escapeHtml(m.text)}</text>`);
  }

  const xDate = (idx, anchor) => {
    if (idx < 0 || idx >= n) return;
    parts.push(`<text x="${x(idx).toFixed(1)}" y="${(H - 8).toFixed(1)}" font-size="10" fill="#6b7280" text-anchor="${anchor}" style="${textStyle}">${escapeHtml(win[idx].date.slice(5))}</text>`);
  };
  xDate(0, 'start');
  if (n > 4) xDate(Math.floor((n - 1) / 2), 'middle');
  xDate(n - 1, 'end');

  parts.push('</svg>');
  parts.push('<div class="muted" style="font-size:12px">蜡烛图：信号生命周期价格走势；虚线：触发/止损/入场/离场价位；圆点：关键执行事件</div>');

  return `<div class="lifecycle"><h4>生命周期（蜡烛图 + 执行标记）</h4>${parts.join('')}</div>`;
}

function signalCard(sig, { closed = false, bars = null } = {}) {
  const body = [];
  const rows = [];
  if (closed) {
    const closedDate = sig.closedAt ? String(sig.closedAt).slice(0, 10) : '—';
    rows.push(fieldRow('入池', `${sig.createdDate} <span class="muted">${escapeHtml(sig.createdRunId)}</span>`));
    const dirAttribution = sig.directionResult ? directionResultLabel(sig.directionResult, sig.directionEvidence) : (sig.closeClass ? closeClassLabel(sig.closeClass) : '—');
    const execAttribution = sig.executionResult ? executionResultLabel(sig.executionResult, sig.executionEvent) : '—';
    rows.push(fieldRow('出池', `${closedDate} · ${escapeHtml(dirAttribution)} · ${escapeHtml(execAttribution)}`));
    rows.push(fieldRow('出池方式', escapeHtml(closeReasonLabel(sig.closeReason))));
  } else {
    rows.push(fieldRow('入池', `${sig.createdDate} <span class="muted">${escapeHtml(sig.createdRunId)}</span>`));
    rows.push(fieldRow('最近更新', `${sig.lastSeenDate} <span class="muted">${escapeHtml(sig.lastSeenRunId)}</span>`));
  }
  if (sig.storyChainId) rows.push(fieldRow('故事来源', `<span class="muted">${escapeHtml(sig.storyChainId)}</span>`));
  const cur = sig.currentVersion || {};
  const curExpr = cur.state
    ? `${escapeHtml(eventLabel(cur.state, 'execution'))}${cur.entryTrigger ? ` — ${escapeHtml(cur.entryTrigger)}` : ''}`
    : '—';
  rows.push(fieldRow('当前表达', curExpr));
  if (!closed) rows.push(fieldRow('最新验证', signalVerificationLabel(sig)));
  const p = sig.priceTracking || {};
  if (p.startClose != null || p.latestClose != null) {
    const chg = pctChange(p.startClose, p.latestClose);
    const fav = p.maxFavorablePts == null ? '—' : `${p.maxFavorablePts >= 0 ? '+' : ''}${fmt(p.maxFavorablePts)}`;
    const adv = p.maxAdversePts == null ? '—' : `${p.maxAdversePts <= 0 ? '' : '+'}${fmt(p.maxAdversePts)}`;
    rows.push(fieldRow('价格追踪', `入池 ${fmt(p.startClose)} → 最新 ${fmt(p.latestClose)}${chg ? ` <span class="${pctChange(p.startClose, p.latestClose) && pctChange(p.startClose, p.latestClose).startsWith('+') ? 'up' : 'down'}">（${chg}）</span>` : ''}<br><span class="muted">最大有利 ${fav} · 最大不利 ${adv}</span>`));
  }

  const versions = Array.isArray(sig.versions) ? sig.versions : [];

  if (!closed) body.push(anchorPanel(sig));
  body.push(`<table class="fields">${rows.join('')}</table>`);
  body.push(lifecycleChart(sig, versions, bars));
  body.push(timelineBlock(sig));

  if (versions.length > 0) {
    body.push(`<h4>策略版本（${versions.length}）</h4>`);
    for (const v of versions) {
      body.push(`<details class="version"><summary>${versionSummary(v)}</summary><div class="version-body">${versionBody(v)}</div></details>`);
    }
  }

  return `<details class="card ${closed ? 'closed' : ''}"><summary>${signalTitle(sig)}</summary><div class="card-body">${body.join('')}</div></details>`;
}

function statsTable(stats) {
  const dirLayer = stats.directionLayer || {};
  const dirBy = dirLayer.byEvent || {};
  const execLayer = stats.executionLayer || {};
  const execBy = execLayer.byEvent || {};
  const total = stats.totalClosed == null ? 0 : stats.totalClosed;

  const row = (label, value, isMain = true, isLast = false) =>
    `<div class="sig-stats-row ${isMain ? 'sig-main' : 'sig-sub'}${isLast ? ' is-last' : ''}"><span>${escapeHtml(label)}</span><b>${value}</b></div>`;

  const subRows = (pairs) => pairs.filter(([, v]) => v > 0).map(([k, v]) => row(k, v, false)).join('');

  const dirHitSubs = subRows([
    ['终值顺向', dirBy.close_favorable || 0],
    ['顺向 1 ATR', dirBy.favorable_1atr || 0]
  ]);
  const dirMissSubs = subRows([
    ['逆向 1 ATR', dirBy.adverse_1atr || 0],
    ['双向未出', dirBy.none || 0]
  ]);
  const execProfitSubs = subRows([
    ['目标兑现', execBy.target_hit || 0],
    ['时间离场盈利', execBy.time_exit_profit || 0]
  ]);
  const execLossSubs = subRows([
    ['止损离场', execBy.stopped_out || 0],
    ['时间离场亏损', execBy.time_exit_loss || 0]
  ]);
  const execNoexecSubs = subRows([
    ['跳空放弃', execBy.gap_skipped || 0],
    ['触发未成', execBy.trigger_missed || 0],
    ['观察确认', execBy.confirmed || 0],
    ['观察未确认', execBy.watch_missed || 0],
    ['暂停', execBy.suspended || 0]
  ]);

  const dirBody = [
    row('方向正确', dirLayer.hit || 0),
    dirHitSubs,
    row('方向错误', dirLayer.miss || 0),
    dirMissSubs
  ].filter(Boolean).join('');

  const execBody = [
    row('盈利', execLayer.profit || 0),
    execProfitSubs,
    row('亏损', execLayer.loss || 0),
    execLossSubs,
    row('未执行', execLayer.noexec || 0),
    execNoexecSubs
  ].filter(Boolean).join('');

  return `<div class="sig-stats">
    <div class="sig-stats-head">历史已出池信号 ${total}</div>
    <div class="sig-stats-head">方向层面</div>
    ${dirBody}
    <div class="sig-stats-head">交易执行层面</div>
    ${execBody}
  </div>`;
}

function renderSignalPoolHtml(view, opts = {}) {
  const runId = opts.runId || (view.meta && view.meta.runId) || '';
  const pool = Array.isArray(view.pool) ? view.pool : [];
  const recentClosed = Array.isArray(view.recentClosed) ? view.recentClosed : [];
  const stats = view.historyStats || {};
  const details = view.details || {};
  const raw = opts.raw || null;

  const poolCards = pool.map((s) => {
    const detail = details[s.signalId] || {};
    return signalCard({ ...s, versions: detail.versions || [] }, { bars: barsForSignal(s, raw) });
  }).join('\n');

  const closedCards = recentClosed.map((s) => {
    const detail = details[s.signalId] || {};
    return signalCard({ ...s, versions: detail.versions || [] }, { closed: true, bars: barsForSignal(s, raw) });
  }).join('\n');

  const reportHref = `runs/${runId}/report.md`;

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Futures Radar · 信号池看板</title>
<style>
  :root {
    --bg: #f7f8fa;
    --card: #ffffff;
    --border: #e5e7eb;
    --text: #1f2328;
    --muted: #6b7280;
    --accent: #2563eb;
    --up: #b91c1c;
    --down: #047857;
    --radius: 10px;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
  header { background: var(--card); border-bottom: 1px solid var(--border); padding: 14px 22px 0; position: sticky; top: 0; z-index: 10; }
  header h1 { font-size: 17px; margin: 0 0 10px; }
  .tabs { display: flex; gap: 6px; }
  .tab { border: 1px solid var(--border); border-bottom: none; background: #f1f3f5; color: var(--muted); padding: 8px 16px; border-radius: 8px 8px 0 0; cursor: pointer; font-size: 14px; }
  .tab.active { background: var(--bg); color: var(--text); font-weight: 600; position: relative; top: 1px; }
  main { max-width: 1440px; margin: 0; padding: 18px 22px 48px; }
  .tab-panel { display: none; }
  .tab-panel.active { display: block; }
  .summary-bar { display: flex; gap: 10px; flex-wrap: wrap; margin: 6px 0 16px; }
  .summary-bar .stat { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); padding: 10px 16px; min-width: 120px; }
  .summary-bar .stat b { display: block; font-size: 20px; }
  .summary-bar .stat span { color: var(--muted); font-size: 12px; }
  section h2 { font-size: 15px; margin: 22px 0 10px; padding-left: 8px; border-left: 3px solid var(--accent); }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); margin: 10px 0; box-shadow: 0 1px 2px rgba(0,0,0,.03); }
  .card > summary { cursor: pointer; padding: 12px 16px; font-weight: 600; list-style: none; display: flex; align-items: center; gap: 8px; }
  .card > summary::-webkit-details-marker { display: none; }
  .card > summary::before { content: "▸"; color: var(--muted); transition: transform .15s; }
  .card[open] > summary::before { transform: rotate(90deg); }
  .card.closed > summary { opacity: .75; }
  .card-body { padding: 4px 16px 14px; border-top: 1px solid var(--border); }
  .anchor-panel { background: #f0f6ff; border: 1px solid #dbeafe; border-radius: 8px; padding: 10px 12px; margin: 8px 0; }
  .anchor-head { font-weight: 600; font-size: 13px; margin-bottom: 4px; }
  .anchor-sub { font-size: 12px; color: var(--muted); margin-bottom: 6px; }
  .anchor-sub.pos-holding { color: #047857; font-weight: 600; }
  .anchor-sub.pos-triggered { color: #b45309; font-weight: 600; }
  .anchor-grid { display: grid; grid-template-columns: repeat(5, minmax(0,1fr)); gap: 10px; }
  .anchor-item span { display: block; font-size: 12px; color: var(--muted); }
  .anchor-item b { font-size: 14px; font-variant-numeric: tabular-nums; }
  @media (max-width: 900px) { .anchor-grid { grid-template-columns: repeat(2, minmax(0,1fr)); } }

  table.fields { width: 100%; border-collapse: collapse; table-layout: fixed; margin: 6px 0; }
  table.fields th { width: 88px; text-align: left; vertical-align: top; color: var(--muted); font-weight: 500; padding: 5px 10px 5px 0; white-space: nowrap; }
  table.fields td { vertical-align: top; padding: 5px 0; word-break: break-word; }
  .muted { color: var(--muted); font-size: 12px; }
  .up { color: var(--up); font-weight: 600; }
  .down { color: var(--down); font-weight: 600; }
  .card h4 { margin: 12px 0 6px; font-size: 13px; color: var(--muted); }
  .lifecycle { margin: 10px 0; }
  .lifecycle svg { width: 100%; height: auto; background: #fbfdff; border: 1px solid var(--border); border-radius: 8px; }
  details.version { border: 1px solid var(--border); border-radius: 8px; margin: 8px 0; background: #fbfcfd; }
  details.version > summary { cursor: pointer; padding: 8px 12px; font-size: 13px; list-style: none; }
  details.version > summary::-webkit-details-marker { display: none; }
  details.version > summary::before { content: "▸"; color: var(--muted); margin-right: 6px; }
  details.version[open] > summary::before { content: "▾"; }
  .version-body { padding: 2px 12px 10px; }
  .version-body table.fields th { width: 64px; font-size: 12px; }
  .version-body table.fields td { font-size: 13px; }
  table.stats { width: 100%; max-width: 420px; border-collapse: collapse; background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
  table.stats th, table.stats td { padding: 7px 12px; text-align: left; border-bottom: 1px solid var(--border); }
  table.stats tr:last-child th, table.stats tr:last-child td { border-bottom: none; }
  table.stats th { color: var(--muted); font-weight: 500; }
  table.stats tr.sub th, table.stats tr.sub td { border-bottom: 1px solid var(--border); padding-top: 0; }
  table.stats tr.sub td { color: var(--muted); font-size: 12px; line-height: 1.6; }
  table.stats tr.sub + tr th, table.stats tr.sub + tr td { padding-top: 6px; }
  .link-card { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); padding: 28px; text-align: center; }
  .link-card a { color: var(--accent); font-size: 16px; text-decoration: none; }
  .link-card p { color: var(--muted); margin-top: 8px; }
  @media print { header { position: static; } .tab { display: none; } .tab-panel { display: block !important; } }
</style>
</head>
<body>
<header>
  <h1>Futures Radar · 信号池看板</h1>
  <nav class="tabs">
    <button class="tab active" data-tab="dashboard">📊 信号池看板</button>
    <button class="tab" data-tab="report">📄 完整报告</button>
  </nav>
</header>
<main>
  <section id="tab-dashboard" class="tab-panel active">
    <div class="summary-bar">
      <div class="stat"><b>${pool.length}</b><span>池内信号</span></div>
      <div class="stat"><b>${recentClosed.length}</b><span>最近出池展示</span></div>
      <div class="stat"><b>${stats.totalClosed == null ? 0 : stats.totalClosed}</b><span>历史已出池</span></div>
    </div>

    <section>
      <h2>池内信号（全量追踪）</h2>
      ${poolCards || '<p class="muted">当前池内无信号。</p>'}
    </section>

    <section>
      <h2>最近出池信号（最新 5 个）</h2>
      ${closedCards || '<p class="muted">暂无出池信号。</p>'}
    </section>

    <section>
      <h2>历史统计</h2>
      ${statsTable(stats)}
    </section>
  </section>

  <section id="tab-report" class="tab-panel">
    <div class="link-card">
      <a href="${escapeHtml(reportHref)}">打开完整分析报告 →</a>
      <p>${escapeHtml(runId)} / report.md</p>
    </div>
  </section>
</main>
<script>
  const tabs = document.querySelectorAll('.tab');
  const panels = document.querySelectorAll('.tab-panel');
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.remove('active'));
      panels.forEach((p) => p.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
    });
  });
</script>
</body>
</html>
`;
}

function main() {
  // 已废弃独立 signal-pool.html：信号池看板统一并入 dashboard.html（render-markdown.cjs）。
  // 本模块仅作为渲染库被 render-dashboard-html.cjs 复用（signalCard/statsTable/escapeHtml）。
  console.log('signal-pool.html 已废弃，信号池看板统一在 dashboard.html 中展示。');
}

module.exports = {
  renderSignalPoolHtml,
  escapeHtml,
  fmt,
  pctChange,
  signalTitle,
  signalCard,
  statsTable,
  fieldRow,
  main
};

if (require.main === module) main();
