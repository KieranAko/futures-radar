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
  signalStatusOf,
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
  const a = sig.anchor || null;
  const fullBars = Array.isArray(bars) ? bars : [];
  const createdIdx = fullBars.findIndex((b) => b.date === sig.createdDate);
  const startIdx = createdIdx === -1
    ? Math.max(0, fullBars.length - 60)
    : Math.max(0, createdIdx - 60);
  const win = fullBars.slice(startIdx);
  if (win.length < 2) return '';

  const anchorVersionId = a ? a.versionId : (sig.currentVersionId || (versions[versions.length - 1] && versions[versions.length - 1].versionId) || null);
  const av = versions.find((v) => v.versionId === anchorVersionId) || versions[versions.length - 1] || null;
  const lastR = av && av.verification && av.verification.lastResult;
  const skipped = !!a && a.status === 'skipped_gap';
  const triggerLevel = a && a.triggerLevel != null ? Number(a.triggerLevel) : (av && av.entry && av.entry.triggerLevel != null ? Number(av.entry.triggerLevel) : null);
  const stopPrice = av && av.stop && av.stop.stopPrice != null ? Number(av.stop.stopPrice) : null;
  const entryPrice = a && a.entryPrice != null ? Number(a.entryPrice) : (skipped && lastR && lastR.entryPrice != null ? Number(lastR.entryPrice) : null);
  const entryDate = a && a.entryDate || (skipped && lastR && lastR.entryDate ? lastR.entryDate : null);
  const exitPrice = a && a.exitPrice != null ? Number(a.exitPrice) : null;
  const exitDate = a && a.exitDate || null;
  const parseLevel = (text) => {
    const m = String(text == null ? '' : text).match(/-?\d+(?:\.\d+)?/);
    return m ? Number(m[0]) : null;
  };
  const t1Level = parseLevel(av && av.targets && av.targets.t1);
  const t2Level = parseLevel(av && av.targets && av.targets.t2);

  const W = 960;
  const H = 360;
  const padL = 46;
  const padR = 64;
  const padT = 20;
  const padB = 26;
  const n = win.length;
  const step = (W - padL - padR) / n;
  const bodyW = Math.max(2, Math.min(8, step * 0.55));
  const x = (i) => padL + i * step + step / 2;

  const fullCloses = fullBars.map((b) => b.close);
  const fullChg5 = fullCloses.map((c, i) => (i >= 5 && fullCloses[i - 5] ? ((c / fullCloses[i - 5]) - 1) * 100 : null));
  const chg5 = fullChg5.slice(startIdx);
  const prevBeforeFirst = startIdx > 0 ? fullBars[startIdx - 1].close : null;
  let min = Infinity;
  let max = -Infinity;
  for (const b of win) {
    min = Math.min(min, b.low);
    max = Math.max(max, b.high);
  }
  for (const v of [triggerLevel, stopPrice, entryPrice, exitPrice, t1Level, t2Level]) {
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
  parts.push(`<svg class="lifecycle-chart" viewBox="0 0 ${W} ${H}" role="img">`);
  parts.push(`<defs>
    <pattern id="zp-plan" width="6" height="6" patternTransform="rotate(45)" patternUnits="userSpaceOnUse"><line x1="0" y1="0" x2="0" y2="6" stroke="#d97706" stroke-width="1.6" opacity="0.5"/></pattern>
    <pattern id="zp-target" width="6" height="6" patternTransform="rotate(-45)" patternUnits="userSpaceOnUse"><line x1="0" y1="0" x2="0" y2="6" stroke="#2563eb" stroke-width="1.6" opacity="0.5"/></pattern>
    <pattern id="zp-invalid" width="7" height="7" patternTransform="rotate(-45)" patternUnits="userSpaceOnUse"><line x1="0" y1="0" x2="0" y2="7" stroke="#ef4444" stroke-width="1.2" opacity="0.28"/></pattern>
  </defs>`);
  for (let i = 0; i <= 4; i++) {
    const gy = padT + (i / 4) * (H - padT - padB);
    const gv = max - (i / 4) * (max - min);
    parts.push(`<line x1="${padL}" y1="${gy.toFixed(1)}" x2="${(W - padR).toFixed(1)}" y2="${gy.toFixed(1)}" stroke="#eef0f3" stroke-width="1"/>`);
    parts.push(`<text x="${padL - 6}" y="${(gy + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="#6b7280">${fmt(gv, 0)}</text>`);
  }
  const textStyle = 'paint-order:stroke;stroke:#ffffff;stroke-width:3px;';
  const zoneGap = (max - min) * 0.008;
  const ZONE_BASE = { 'zp-plan': '#d97706', 'zp-target': '#2563eb', 'zp-invalid': '#ef4444' };
  const zone = (v1, v2, pattern, label, color, tooltip) => {
    const y1 = y(v1);
    const y2 = y(v2);
    const top = Math.min(y1, y2);
    const h = Math.abs(y2 - y1);
    if (h < 4) return '';
    const base = ZONE_BASE[pattern] || color;
    let out = `<g class="zp-zone" data-label="${escapeHtml(tooltip || label)}"><rect class="zp-base" x="${padL}" y="${top.toFixed(1)}" width="${(W - padL - padR).toFixed(1)}" height="${h.toFixed(1)}" fill="${base}" opacity="0.1"/><rect class="zp-hatch" x="${padL}" y="${top.toFixed(1)}" width="${(W - padL - padR).toFixed(1)}" height="${h.toFixed(1)}" fill="url(#${pattern})"/>`;
    if (label && h >= 16) {
      out += `<text x="${(padL + 8).toFixed(1)}" y="${(top + h / 2 + 4).toFixed(1)}" font-size="11" font-weight="700" fill="${color}" style="${textStyle}">${escapeHtml(label)}</text>`;
    }
    out += '</g>';
    return out;
  };
  // 背景区间块：失效区 / 计划区间（触发↔止损）/ 目标区间（目标1↔目标2）
  if (stopPrice != null) {
    if (sig.direction === 'bullish') parts.push(zone(stopPrice, min + (max - min) * 0.02, 'zp-invalid', '失效区', '#b91c1c', `失效区：价格跌破止损 ${fmt(stopPrice, 0)} 后逻辑失效`));
    else parts.push(zone(stopPrice, max - (max - min) * 0.02, 'zp-invalid', '失效区', '#b91c1c', `失效区：价格站上止损 ${fmt(stopPrice, 0)} 后逻辑失效`));
  }
  if (triggerLevel != null && stopPrice != null && Math.abs(triggerLevel - stopPrice) > zoneGap) parts.push(zone(triggerLevel, stopPrice, 'zp-plan', '计划区间', '#b45309', `计划区间：触发 ${fmt(triggerLevel, 0)} ~ 止损 ${fmt(stopPrice, 0)}`));
  if (t1Level != null && t2Level != null && Math.abs(t1Level - t2Level) > zoneGap) parts.push(zone(t1Level, t2Level, 'zp-target', '目标区间', '#2563eb', `目标区间：目标1 ${fmt(t1Level, 0)} ~ 目标2 ${fmt(t2Level, 0)}`));
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
    parts.push(`<rect x="${(cx - bodyW / 2).toFixed(1)}" y="${bodyTop.toFixed(1)}" width="${bodyW.toFixed(1)}" height="${bodyH.toFixed(1)}" fill="${color}"/>`);
  }
  const dirBadge = sig.direction === 'bearish' ? '空' : sig.direction === 'bullish' ? '多' : '';
  if (dirBadge) {
    const dirColor = sig.direction === 'bearish' ? '#047857' : '#b91c1c';
    parts.push(`<text x="${padL}" y="${padT + 4}" font-size="11" font-weight="700" fill="${dirColor}" style="${textStyle}">计划 ${dirBadge}</text>`);
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

  const signalDayIdx = win.findIndex((b) => b.date === sig.createdDate);
  if (signalDayIdx > 0 && signalDayIdx < n - 1) {
    const sx = x(signalDayIdx);
    parts.push(`<line x1="${sx.toFixed(1)}" y1="${padT}" x2="${sx.toFixed(1)}" y2="${(H - padB).toFixed(1)}" stroke="#6b7280" stroke-width="1" stroke-dasharray="2 3" opacity="0.55"/>`);
    parts.push(`<text x="${sx.toFixed(1)}" y="${(padT + 10).toFixed(1)}" font-size="10" fill="#6b7280" text-anchor="middle" style="${textStyle}">信号日 ${escapeHtml(win[signalDayIdx].date.slice(5))}</text>`);
  }

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
  if (a && a.triggerDate && triggerLevel != null) addMarker(xOfDate(a.triggerDate), triggerLevel, '#d97706', `触发 ${a.triggerDate} @ ${fmt(triggerLevel, 0)}`, 'end');
  if (entryDate && entryPrice != null) addMarker(xOfDate(entryDate), entryPrice, skipped ? '#b91c1c' : '#047857', `${skipped ? '放弃执行' : '入场'} ${entryDate} @ ${fmt(entryPrice, 0)}`, skipped ? 'start' : 'end');
  if (exitDate && exitPrice != null) addMarker(xOfDate(exitDate), exitPrice, '#b91c1c', `离场 ${exitDate} @ ${fmt(exitPrice, 0)}`, 'start');

  const avoidOverlap = (items, minGap) => {
    const sorted = [...items].sort((a, b) => a.y - b.y);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].y - sorted[i - 1].y < minGap) sorted[i].y = sorted[i - 1].y + minGap;
    }
    return sorted;
  };

  const levels = [
    { level: triggerLevel, color: '#d97706', label: '触发' },
    { level: stopPrice, color: '#b91c1c', label: '止损' },
    { level: entryPrice, color: skipped ? '#b91c1c' : '#047857', label: skipped ? '放弃' : '入场' },
    { level: exitPrice, color: '#b91c1c', label: '离场' },
    { level: t1Level, color: '#2563eb', label: '目标1' },
    { level: t2Level, color: '#7c3aed', label: '目标2' }
  ].filter((l) => l.level != null);
  // 去重：价格几乎相同的价位只保留优先级更高的一条
  const dedupThreshold = (max - min) * 0.008;
  const uniqueLevels = [];
  for (const l of levels) {
    if (!uniqueLevels.some((u) => Math.abs(u.level - l.level) < dedupThreshold)) uniqueLevels.push(l);
  }
  const solidLevels = new Set(['止损', '入场', '放弃', '离场']);
  for (const l of uniqueLevels) {
    const yy = y(l.level);
    const isSolid = l.dash === undefined && solidLevels.has(l.label);
    const isTarget = l.label === '目标1' || l.label === '目标2';
    let dash = l.dash !== undefined ? l.dash : (l.label === '触发' ? '10 5' : isSolid ? null : '6 3');
    let opacity = l.opacity != null ? l.opacity : 0.95;
    let strokeWidth = 1;
    if (isSolid) {
      dash = null;
      opacity = 1;
      strokeWidth = 2;
    } else if (l.label === '触发') {
      strokeWidth = 1.6;
    } else if (isTarget) {
      strokeWidth = 1.6;
      opacity = 0.9;
    } else if (l.dash === '1 4') {
      opacity = 0.6;
      strokeWidth = 1.1;
    }
    parts.push(`<line x1="${padL}" y1="${yy.toFixed(1)}" x2="${(W - padR).toFixed(1)}" y2="${yy.toFixed(1)}" stroke="${l.color}" stroke-width="${strokeWidth}"${dash ? ` stroke-dasharray="${dash}"` : ''} opacity="${opacity}"/>`);
  }
  // 右侧标签放在图内右端：相邻价位合并成一行，避免互相压字。
  // 信息密度控制：已有事件圆点标注的触发/入场/离场不再重复。
  const hasTriggerMarker = !!a && !!a.triggerDate;
  const hasEntryMarker = !!entryDate && entryPrice != null;
  const hasExitMarker = !!exitDate && exitPrice != null;
  const majorCount = uniqueLevels.filter((l) => !l.dash).length;
  const labelLevels = uniqueLevels.filter((l) => {
    if (l.dash && majorCount >= 4) return false;
    if (hasTriggerMarker && l.label === '触发') return false;
    if (hasEntryMarker && (l.label === '入场' || l.label === '放弃')) return false;
    if (hasExitMarker && l.label === '离场') return false;
    return true;
  });
  const levelTexts = labelLevels.map((l) => ({
    y: y(l.level),
    text: `${l.label} ${l.labelValue != null ? `${l.labelValue >= 0 ? '+' : ''}${fmt(l.labelValue, 0)}` : fmt(l.level, 0)}`,
    color: l.color
  })).sort((a, b) => a.y - b.y);
  const groups = [];
  for (const t of levelTexts) {
    const last = groups[groups.length - 1];
    if (last && t.y - last.y < 18 && last.texts.length < 4) {
      last.texts.push(t.text);
      last.y = (last.y + t.y) / 2;
      last.color = '#475569';
    } else {
      groups.push({ y: t.y, texts: [t.text], color: t.color });
    }
  }
  // 右侧不再写价位文字：关键价位统一放到图下图例，避免遮挡蜡烛。

  const markerLabels = avoidOverlap(markers.map((m) => ({
    y: m.anchor === 'start' ? m.cy - 8 : m.cy + 16,
    x: m.cx,
    cy: m.cy,
    text: m.label,
    color: m.color,
    anchor: m.cx > padL + 150 ? 'end' : 'start'
  })), 14);
  for (const m of markerLabels) {
    const tx = m.anchor === 'end' ? m.x - 6 : m.x + 6;
    let ty = Math.max(padT + 4, Math.min(H - 8, m.y));
    for (const g of groups) {
      const gy = g.y + 4;
      if (Math.abs(ty - gy) < 13) ty = ty >= gy ? ty + 14 : ty - 14;
    }
    ty = Math.max(padT + 4, Math.min(H - 8, ty));
    parts.push(`<circle cx="${m.x.toFixed(1)}" cy="${m.cy.toFixed(1)}" r="4" fill="${m.color}" stroke="#fff" stroke-width="1.5"/>`);
    parts.push(`<text x="${tx.toFixed(1)}" y="${ty.toFixed(1)}" font-size="11" font-weight="600" fill="${m.color}" text-anchor="${m.anchor}" style="${textStyle}">${escapeHtml(m.text)}</text>`);
  }

  const xDate = (idx, anchor) => {
    if (idx < 0 || idx >= n) return;
    parts.push(`<text x="${x(idx).toFixed(1)}" y="${(H - 8).toFixed(1)}" font-size="10" fill="#6b7280" text-anchor="${anchor}" style="${textStyle}">${escapeHtml(win[idx].date.slice(5))}</text>`);
  };
  xDate(0, 'start');
  if (n > 6) {
    xDate(Math.floor((n - 1) * 0.25), 'middle');
    xDate(Math.floor((n - 1) * 0.5), 'middle');
    xDate(Math.floor((n - 1) * 0.75), 'middle');
  } else if (n > 4) {
    xDate(Math.floor((n - 1) / 2), 'middle');
  }
  xDate(n - 1, 'end');

  const lastBar = win[win.length - 1];
  const lastUp = lastBar.close >= lastBar.open;
  const lastColor = lastUp ? '#b91c1c' : '#047857';
  parts.push(`<circle cx="${x(n - 1).toFixed(1)}" cy="${y(lastBar.close).toFixed(1)}" r="3.2" fill="${lastColor}" stroke="#ffffff" stroke-width="1.4"/>`);
  parts.push(`<text x="${(W - padR - 8).toFixed(1)}" y="${(padT + 4).toFixed(1)}" font-size="11" font-weight="700" fill="${lastColor}" text-anchor="end" style="${textStyle}">最新收盘 ${fmt(lastBar.close)} · ${escapeHtml(lastBar.date.slice(5))}</text>`);
  parts.push(`<line class="chart-crosshair" x1="${x(n - 1).toFixed(1)}" y1="${padT}" x2="${x(n - 1).toFixed(1)}" y2="${(H - padB).toFixed(1)}" stroke="#1f2328" stroke-width="1" stroke-dasharray="3 3" opacity="0.7"/>`);

  parts.push('</svg>');

  const legendSwatch = (color, dash) => `<i style="width:16px;height:0;border-top:3px ${dash || 'solid'} ${color};display:inline-block;vertical-align:middle;"></i>`;
  const legendValue = (l) => l.labelValue != null ? `${l.labelValue >= 0 ? '+' : ''}${fmt(l.labelValue, 0)}` : fmt(l.level, 0);
  const levelLegend = uniqueLevels.map((l) => {
    const dash = l.dash !== undefined ? 'dashed' : solidLevels.has(l.label) ? 'solid' : l.label === '触发' ? 'dashed' : 'dashed';
    return `<span style="display:inline-flex;align-items:center;gap:5px;white-space:nowrap;">${legendSwatch(l.color, dash)}<b style="font-weight:600;color:#1f2328;">${escapeHtml(l.label)}</b> ${legendValue(l)}</span>`;
  });
  const zoneLegend = [];
  if (stopPrice != null) zoneLegend.push(`<span style="display:inline-flex;align-items:center;gap:5px;white-space:nowrap;"><i style="width:14px;height:14px;border-radius:3px;background:rgba(239,68,68,.18);outline:1px solid rgba(239,68,68,.5);display:inline-block;vertical-align:middle;"></i><b style="font-weight:600;color:#1f2328;">失效区</b></span>`);
  if (triggerLevel != null && stopPrice != null && Math.abs(triggerLevel - stopPrice) > zoneGap) zoneLegend.push(`<span style="display:inline-flex;align-items:center;gap:5px;white-space:nowrap;"><i style="width:14px;height:14px;border-radius:3px;background:rgba(217,119,6,.2);outline:1px solid rgba(217,119,6,.55);display:inline-block;vertical-align:middle;"></i><b style="font-weight:600;color:#1f2328;">计划区间</b></span>`);
  if (t1Level != null && t2Level != null && Math.abs(t1Level - t2Level) > zoneGap) zoneLegend.push(`<span style="display:inline-flex;align-items:center;gap:5px;white-space:nowrap;"><i style="width:14px;height:14px;border-radius:3px;background:rgba(37,99,235,.2);outline:1px solid rgba(37,99,235,.55);display:inline-block;vertical-align:middle;"></i><b style="font-weight:600;color:#1f2328;">目标区间</b></span>`);
  const legendHtml = `<div class="chart-legend" style="display:flex;flex-wrap:wrap;gap:6px 16px;margin-top:6px;font-size:12px;color:#6b7280;">${[...levelLegend, ...zoneLegend].join('')}</div>`;
  const lastPrev = win.length > 1 ? win[win.length - 2].close : null;
  const lastChg = lastPrev != null ? lastBar.close - lastPrev : null;
  const lastChgPct = lastPrev != null && Number(lastPrev) !== 0 ? (lastBar.close / lastPrev - 1) * 100 : null;
  const lastChg5 = chg5[n - 1];
  const lastInfoColor = lastChg == null || lastChg >= 0 ? '#b91c1c' : '#047857';
  const lb = (name) => `<b style="color:#1f2328;font-weight:700">${name}</b>`;
  const cell = (label, valueHtml) => `<span>${lb(label)}<span>${valueHtml}</span></span>`;
  const chgSpan = lastChg != null ? cell('涨跌', `<b style="color:${lastInfoColor}">${lastChg >= 0 ? '+' : ''}${fmt(lastChg)}（${lastChgPct >= 0 ? '+' : ''}${lastChgPct.toFixed(1)}%）</b>`) : cell('涨跌', '—');
  const chg5Span = lastChg5 != null ? cell('5日涨跌', `<b style="color:${lastChg5 >= 0 ? '#b91c1c' : '#047857'}">${lastChg5 >= 0 ? '+' : ''}${lastChg5.toFixed(1)}%</b>`) : cell('5日涨跌', '—');
  const lastInfoHtml = `<span><b style="color:#1f2328;font-weight:700">${escapeHtml(lastBar.date)}</b></span>${cell('开盘', fmt(lastBar.open))}${cell('最高', fmt(lastBar.high))}${cell('最低', fmt(lastBar.low))}${cell('收盘', `<b style="color:${lastInfoColor}">${fmt(lastBar.close)}</b>`)}${chgSpan}${chg5Span}`;
  const barsAttr = JSON.stringify(win.map((b) => ({ d: b.date, o: b.open, h: b.high, l: b.low, c: b.close }))).replace(/'/g, '&#39;');

  return `<div class="lifecycle" data-bars='${barsAttr}' data-prev='${prevBeforeFirst != null ? prevBeforeFirst : ''}' data-chg5='${JSON.stringify(chg5)}' data-pad='${padL},${padR},${padT},${padB}'><div class="chart-day-info">${lastInfoHtml}</div>${parts.join('')}${legendHtml}<div class="chart-hover-tip"></div></div>`;
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

// ── 信号池 · 故事池式面板（版本时间线列表） ─────────────────────
// 结构对齐故事池：每个信号 = 一个面板；版本按时间轴纵向排布（Ant 时间线风格）。
// 时间线圆点颜色 = 版本终态（盈利绿 / 亏损红 / 未执行灰），当前版本蓝框 + 当前版本标记。
// 面板头 = 人类可读主题（品种名）+ 状态 + 方向 + 故事来源；每个版本一整行富文本，无需二次点击。
const SIGNAL_STATE_CLASS = {
  target_hit: 'tl-ok',
  time_exit_profit: 'tl-ok',
  stopped_out: 'tl-bad',
  time_exit_loss: 'tl-bad',
  gap_skipped: 'tl-skip',
  trigger_missed: 'tl-skip',
  confirmed: 'tl-skip',
  watch_missed: 'tl-skip',
  suspended: 'tl-skip',
  unverifiable: 'tl-skip'
};
const SIGNAL_TERMINAL_EXEC = new Set(['target_hit', 'time_exit_profit', 'stopped_out', 'time_exit_loss']);
const SIGNAL_NOEXEC = new Set(['gap_skipped', 'trigger_missed', 'confirmed', 'watch_missed', 'suspended', 'unverifiable']);

function versionNum(v) {
  const s = String((v && v.versionId) || '');
  const i = s.indexOf(':V');
  if (i >= 0) return s.slice(i + 2) || '?';
  return s || '?';
}

function dirText(dir) {
  return dir === 'bullish' ? '多' : dir === 'bearish' ? '空' : '—';
}

function dirClass(dir) {
  return dir === 'bullish' ? 'up' : dir === 'bearish' ? 'down' : '';
}

function regimeGradeLabel(grade) {
  return grade === 'extreme' ? '波动极端' : grade === 'elevated' ? '波动抬升' : grade === 'normal' ? '波动正常' : '—';
}

function regimeDirLabel(dir) {
  return dir === 'rising' ? '上行' : dir === 'falling' ? '下行' : dir === 'stable' ? '平稳' : '—';
}

function signalVersionData(sig, v, isCurrent) {
  const state = versionStateOf(v);
  const r = v.verification && v.verification.lastResult;
  const entry = v.entry || {};
  const stop = v.stop || {};
  const targets = v.targets || {};
  const invalidation = v.invalidation || {};
  const regime = v.regime || {};
  const triggerLevel = entry.triggerLevel != null ? Number(entry.triggerLevel) : null;
  const stopPrice = stop.stopPrice != null ? Number(stop.stopPrice) : null;
  const entryPrice = r && r.entryPrice != null ? Number(r.entryPrice) : null;
  const exitPrice = r && r.exitPrice != null ? Number(r.exitPrice) : null;
  const pnlPts = entryPrice != null && exitPrice != null ? exitPrice - entryPrice : null;
  return {
    id: `V${versionNum(v)}`,
    kind: 'signal-version',
    label: `V${versionNum(v)}`,
    versionId: v.versionId || '',
    state,
    stateLabel: eventLabel(state, 'execution'),
    statusClass: SIGNAL_STATE_CLASS[state] || 'tl-pending',
    terminalExec: SIGNAL_TERMINAL_EXEC.has(state),
    noexec: SIGNAL_NOEXEC.has(state),
    current: !!isCurrent,
    direction: sig.direction,
    signalDate: v.signalDate || '',
    trigger: entry.trigger || '',
    triggerLevel,
    stopPrice,
    stopBasis: stop.basis || '',
    t1: targets.t1 || '',
    t2: targets.t2 || '',
    targetsBasis: targets.basis || '',
    execution: entry.execution || entry.triggerTiming || '',
    hardInvalidations: Array.isArray(invalidation.hard) ? invalidation.hard : [],
    timeStop: invalidation.timeStop || '',
    regimeGrade: regime.grade || '',
    regimeDirection: regime.direction || '',
    verificationStatus: v.verification && v.verification.status ? v.verification.status : '',
    verificationLabel: signalVersionVerificationLabel(v),
    entryPrice,
    exitPrice,
    pnlPts,
    exitType: r && r.exitType ? r.exitType : null,
    exitDate: r && r.exitDate ? r.exitDate : null,
    attribution: r && Array.isArray(r.attribution) ? r.attribution.map((a) => (a && a.detail) || '').filter(Boolean) : []
  };
}

function signalTimelineItem(sig, v, isCurrent) {
  const d = signalVersionData(sig, v, isCurrent);
  const rows = [];
  if (d.trigger) {
    rows.push(`<div class="tl-row"><span class="tl-label">触发条件</span><span class="tl-text">${escapeHtml(d.trigger)}</span></div>`);
  }
  if (d.execution) rows.push(`<div class="tl-row"><span class="tl-label">执行方式</span><span class="tl-text">${escapeHtml(d.execution)}</span></div>`);
  if (d.triggerLevel != null || d.stopPrice != null || d.t1) {
    const parts = [];
    if (d.triggerLevel != null) parts.push(`触发 <b>${fmt(d.triggerLevel, 0)}</b>`);
    if (d.stopPrice != null) parts.push(`止损 <b>${fmt(d.stopPrice, 0)}</b>${d.stopBasis ? ` <span class="muted">${escapeHtml(d.stopBasis)}</span>` : ''}`);
    if (d.t1) parts.push(`目标 <b>${escapeHtml(d.t1)}</b>${d.t2 ? ` / <b>${escapeHtml(d.t2)}</b>` : ''}${d.targetsBasis ? ` <span class="muted">${escapeHtml(d.targetsBasis)}</span>` : ''}`);
    rows.push(`<div class="tl-row"><span class="tl-label">价位计划</span><span class="tl-text">${parts.join(' · ')}</span></div>`);
  }
  if (d.hardInvalidations.length || d.timeStop) {
    const inv = [...d.hardInvalidations, ...(d.timeStop ? [d.timeStop] : [])].map((x) => escapeHtml(x)).join('；');
    rows.push(`<div class="tl-row"><span class="tl-label">失效条件</span><span class="tl-text">${inv}</span></div>`);
  }
  if (d.regimeGrade) rows.push(`<div class="tl-row"><span class="tl-label">市场环境</span><span class="tl-text">${escapeHtml(regimeGradeLabel(d.regimeGrade))} · ${escapeHtml(regimeDirLabel(d.regimeDirection))}</span></div>`);
  const verificationText = d.verificationStatus === 'pending_data' ? '待数据验证'
    : d.verificationStatus === 'pending_verification' ? '待验证'
    : d.verificationLabel && d.verificationLabel !== d.stateLabel ? d.verificationLabel
    : '';
  if (verificationText) rows.push(`<div class="tl-row"><span class="tl-label">验证状态</span><span class="tl-text">${escapeHtml(verificationText)}</span></div>`);
  if (d.terminalExec && d.entryPrice != null && d.exitPrice != null) {
    const sign = d.pnlPts >= 0 ? '+' : '';
    rows.push(`<div class="tl-row tl-result"><span class="tl-label">交易结果</span><span class="tl-text"><b>入场 ${fmt(d.entryPrice, 0)} → 离场 ${fmt(d.exitPrice, 0)}</b> · <span class="${d.pnlPts >= 0 ? 'up' : 'down'}">${sign}${fmt(d.pnlPts, 0)} 点</span>${d.exitDate ? ` · ${escapeHtml(d.exitDate)}` : ''}</span></div>`);
  } else if (d.noexec) {
    const exit = versionExitDetail(v);
    if (exit) rows.push(`<div class="tl-row tl-result"><span class="tl-label">交易结果</span><span class="tl-text">${escapeHtml(exit)}</span></div>`);
  }
  if (d.attribution.length) {
    rows.push(`<div class="tl-row"><span class="tl-label">结果归因</span><span class="tl-text">${escapeHtml(d.attribution.join('；'))}</span></div>`);
  }
  const chipCls = d.statusClass === 'tl-ok' ? 'vc-ok' : d.statusClass === 'tl-bad' ? 'vc-bad' : d.statusClass === 'tl-skip' ? 'vc-skip' : 'vc-pending';
  return `<div class="tl-item ${d.statusClass}${isCurrent ? ' current' : ''}">
    <span class="tl-dot"></span>
    <div class="tl-card">
      <details class="tl-details"${isCurrent ? ' open' : ''}>
        <summary class="tl-head">
          <span class="tl-chevron">▸</span>
          <span class="ver-chip ${chipCls}">${escapeHtml(d.id)}</span>
          <span class="tl-date">${escapeHtml(d.signalDate || '—')}</span>
          <span class="tl-state">${escapeHtml(d.stateLabel)}</span>
          <span class="tl-dir ${dirClass(sig.direction)}">${escapeHtml(dirText(sig.direction))}</span>
          ${isCurrent ? '<span class="tl-current-tag">当前版本</span>' : ''}
        </summary>
        <div class="tl-body">${rows.join('')}</div>
      </details>
    </div>
  </div>`;
}

function signalTimelineHtml(sig, versions, { closed = false } = {}) {
  if (!Array.isArray(versions) || versions.length === 0) return '<p class="muted">暂无版本记录。</p>';
  const sorted = [...versions].sort((a, b) => {
    const na = Number(versionNum(a));
    const nb = Number(versionNum(b));
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
    return String(a.signalDate || '').localeCompare(String(b.signalDate || ''));
  });
  const currentId = sig.currentVersionId || (sig.currentVersion && sig.currentVersion.versionId) || null;
  const items = sorted.map((v, i) => {
    const isCurrent = !closed && (currentId ? currentId === v.versionId : i === sorted.length - 1);
    return signalTimelineItem(sig, v, isCurrent);
  });
  return `<div class="sig-timeline">${items.join('')}</div>`;
}

function anchorStateLabel(a) {
  const st = a && a.status;
  if (st === 'holding') return '持仓中';
  if (st === 'triggered_pending_entry') return '待入场';
  if (st === 'verified') return a.exitType === 'stopped_out' ? '止损离场' : a.exitType === 'target1_hit' ? '目标兑现' : '时间离场';
  if (st === 'skipped_gap') return '跳空放弃';
  if (st === 'invalidated_not_triggered') return '未触发';
  const code = a.executionStatus === 'executable' ? 'armed' : a.executionStatus === 'skip' ? 'suspended' : a.executionStatus === 'watch' ? 'watching' : null;
  return code ? eventLabel(code, 'execution') : '—';
}

function signalAnchorGrid(sig, { closed = false } = {}) {
  const p = sig.priceTracking || {};
  const versions = Array.isArray(sig.versions) ? sig.versions : [];
  const curVersion = versions.find((v) => v.versionId === sig.currentVersionId) || versions[versions.length - 1] || null;
  const a = sig.anchor || (curVersion ? {
    versionId: curVersion.versionId,
    signalDate: curVersion.signalDate,
    executionStatus: curVersion.executionStatus,
    status: (curVersion.verification && curVersion.verification.status) || 'pending_verification'
  } : null);
  if (!a && (!p || (p.startClose == null && p.latestClose == null))) return '';
  const entryCell = a && a.entryPrice != null ? `${fmt(a.entryPrice)}` : (a && a.status === 'skipped_gap' ? '—（执行偏离放弃）' : a && a.status === 'invalidated_not_triggered' ? '—（未触发）' : a && a.status === 'triggered_pending_entry' ? 'T+2 待定' : '—');
  const latest = p.latestClose != null ? fmt(p.latestClose) : '—';
  let pnlCell = '—';
  if (closed && a && a.entryPrice != null && a.exitPrice != null && a.realizedPnlPts != null) {
    const sign = a.realizedPnlPts >= 0 ? '+' : '';
    const cls = a.realizedPnlPts >= 0 ? 'up' : 'down';
    const exitLabel = a.exitType === 'time_exit' ? `时间离场${a.exitDate ? ' ' + a.exitDate : ''}` : a.exitType === 'stopped_out' ? `止损离场${a.exitDate ? ' ' + a.exitDate : ''}` : a.exitType === 'target1_hit' ? `目标1兑现${a.exitDate ? ' ' + a.exitDate : ''}` : '已离场';
    pnlCell = `<span class="${cls}">${sign}${fmt(a.realizedPnlPts)} 点（${a.realizedPnlPct >= 0 ? '+' : ''}${a.realizedPnlPct}%）</span> · ${exitLabel}`;
  } else if (a && a.status === 'holding' && a.floatingPnlPts != null) {
    const sign = a.floatingPnlPts >= 0 ? '+' : '';
    const cls = a.floatingPnlPts >= 0 ? 'up' : 'down';
    pnlCell = `<span class="${cls}">${sign}${fmt(a.floatingPnlPts)} 点（${a.floatingPnlPct >= 0 ? '+' : ''}${a.floatingPnlPct}%）</span> · 持仓中`;
  } else if (a && a.status === 'holding') {
    pnlCell = '持仓中';
  }
  const prog = progressBar(sig.fulfillProgress);
  const dist = sig.invalidationDistance != null ? `${fmt(sig.invalidationDistance)} ATR` : '—';
  return `<div class="anchor-panel">
    <div class="anchor-head">当前锚定：V${a ? versionNum(a) : '—'} · ${a ? anchorStateLabel(a) : '—'}${a && a.signalDate ? ` · ${escapeHtml(a.signalDate.slice(5))}` : ''}</div>
    <div class="anchor-grid">
      <div class="anchor-item"><span>入场</span><b>${entryCell}</b></div>
      <div class="anchor-item"><span>最新</span><b>${latest}</b></div>
      <div class="anchor-item"><span>盈亏</span><b>${pnlCell}</b></div>
      <div class="anchor-item"><span>兑现</span>${prog}</div>
      <div class="anchor-item"><span>距失效</span><b>${dist}</b></div>
    </div>
  </div>`;
}

function signalObservationLine(sig) {
  const obs = Array.isArray(sig.observations) ? sig.observations.slice(-1)[0] : null;
  if (!obs) return '';
  const labels = [];
  const seen = new Set();
  for (const e of Array.isArray(obs.events) ? obs.events : []) {
    const label = typeof e === 'string' ? e : (e && e.label) || (e && e.code) || null;
    if (!label || seen.has(label)) continue;
    seen.add(label);
    labels.push(label);
  }
  const ev = labels.length ? labels.join(' · ') : '—';
  return `<div class="signal-obs">最近观察：${escapeHtml(obs.date ? obs.date.slice(5) : '—')} · ${escapeHtml(ev)}</div>`;
}

function signalPanelHtml(s, detail = {}, { closed = false, bars = null, storyTheme = null, storyChainId = null } = {}) {
  const sig = { ...(detail || {}), ...s, versions: (detail && Array.isArray(detail.versions) ? detail.versions : []) };
  const versions = sig.versions;
  const isClosed = closed || sig.poolStatus === 'closed';
  const st = signalStatusOf(sig);
  const statusText = poolStatusLabel(sig);
  const badgeCls = isClosed ? 'sig-closed' : (st === 'holding' || st === 'ready' || st === 'armed') ? 'st-run' : 'st-watch';
  const currentId = sig.currentVersionId || (sig.currentVersion && sig.currentVersion.versionId) || null;
  const currentNum = !isClosed && currentId ? `V${String(currentId).includes(':V') ? String(currentId).split(':V')[1] : '?'}` : null;
  const dirHtml = `<span class="sig-dir ${dirClass(sig.direction)}">${escapeHtml(dirText(sig.direction))}</span>`;
  const storyHtml = storyTheme && storyChainId ? `<button type="button" class="story-jump" data-story-jump="${escapeHtml(storyChainId)}">🔗 故事：${escapeHtml(storyTheme)}</button>` : '';
  const p = sig.priceTracking || {};
  let priceLine = '';
  if (p.startClose != null || p.latestClose != null) {
    const chgNum = p.startClose != null && p.latestClose != null && Number(p.startClose) !== 0
      ? (Number(p.latestClose) - Number(p.startClose)) / Number(p.startClose) * 100
      : null;
    const chgText = chgNum == null ? '' : Math.abs(chgNum) < 0.05 ? ' <span class="muted">（持平）</span>' : ` <span class="${chgNum >= 0 ? 'up' : 'down'}">（${chgNum >= 0 ? '+' : ''}${chgNum.toFixed(1)}%）</span>`;
    const fav = p.maxFavorablePts == null ? '—' : `${p.maxFavorablePts >= 0 ? '+' : ''}${fmt(p.maxFavorablePts)}`;
    const adv = p.maxAdversePts == null ? '—' : `${p.maxAdversePts <= 0 ? '' : '+'}${fmt(p.maxAdversePts)}`;
    priceLine = `<div class="sig-price-line">价格：入池 ${fmt(p.startClose)} → 最新 <b>${fmt(p.latestClose)}</b>${chgText} · <span class="up">最大有利 ${fav}</span> · <span class="down">最大不利 ${adv}</span></div>`;
  }
  const timeline = signalTimelineHtml(sig, versions, { closed: isClosed });
  const chart = lifecycleChart(sig, versions, bars);
  const chartHtml = chart || '<div class="sig-chart-missing muted">暂无价格序列，无法绘制价格轨迹。</div>';
  const headHtml = `<span class="story-theme">${escapeHtml(sig.name || sig.symbol || '—')} <span class="muted">${escapeHtml(sig.symbol || '')}</span></span>
      <span class="story-status ${badgeCls}">${escapeHtml(statusText)}</span>
      ${dirHtml}
      ${storyHtml}
      <span class="story-proof">${versions.length} 版本${currentNum ? ` · 当前 ${escapeHtml(currentNum)}` : ''}${sig.createdDate ? ` · 入池 ${escapeHtml(sig.createdDate)}` : ''}</span>`;
  const bodyHtml = `${sig.thesis ? `<div class="story-subtitle">${escapeHtml(typeof sig.thesis === 'string' ? sig.thesis : (sig.thesis.summary || ''))}</div>` : ''}
    ${priceLine}
    <div class="sig-chart-block"><div class="sig-chart-head">📈 价格轨迹</div>${chartHtml}</div>
    ${!isClosed ? signalObservationLine(sig) : ''}
    ${signalAnchorGrid(sig, { closed: isClosed })}
    ${timeline}`;
  if (isClosed) {
    return `<details class="story-panel signal-panel is-closed">
    <summary class="story-panel-head">${headHtml}</summary>
    <div class="sig-panel-body">${bodyHtml}</div>
  </details>`;
  }
  return `<div class="story-panel signal-panel">
    <div class="story-panel-head">${headHtml}</div>
    ${bodyHtml}
  </div>`;
}

function signalPoolPanelsHtml(view, opts = {}) {
  const pool = view && Array.isArray(view.pool) ? view.pool : [];
  const details = view && view.details ? view.details : {};
  const storyThemes = opts.storyThemes || {};
  const barsOf = typeof opts.barsOf === 'function' ? opts.barsOf : () => null;
  if (pool.length === 0) return '<p class="muted">当前池内无信号。</p>';
  return pool.map((s) => signalPanelHtml(s, details[s.signalId] || {}, {
    storyTheme: storyThemes[s.storyChainId] || null,
    storyChainId: s.storyChainId || null,
    bars: barsOf(s)
  })).join('\n');
}

function signalClosedPanelsHtml(view, opts = {}) {
  const closed = view && Array.isArray(view.recentClosed) ? view.recentClosed : [];
  const details = view && view.details ? view.details : {};
  const storyThemes = opts.storyThemes || {};
  const barsOf = typeof opts.barsOf === 'function' ? opts.barsOf : () => null;
  if (closed.length === 0) return '<p class="muted">暂无出池信号。</p>';
  return closed.map((s) => signalPanelHtml(s, details[s.signalId] || {}, {
    closed: true,
    storyTheme: storyThemes[s.storyChainId] || null,
    storyChainId: s.storyChainId || null,
    bars: barsOf(s)
  })).join('\n');
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
  signalPanelHtml,
  signalPoolPanelsHtml,
  signalClosedPanelsHtml,
  signalAnchorGrid,
  main
};

if (require.main === module) main();
