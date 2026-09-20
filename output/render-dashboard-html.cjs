// report/render-dashboard-html.cjs — 四 Tab 看板（自包含单文件 HTML）
//
// 用法:
//   node report/render-dashboard-html.cjs --runId <runId>
//
// Tab1 机会分析看板：主从布局（左侧品种导航 + 右侧图形化机会面板）。
// Tab2 信号池看板：双栏布局（左侧卡片流 + 右侧历史统计/口径说明）。
// Tab3 故事池看板：传导链卡片（节点进度/可信度/事件/回链信号）+ 统计。
// Tab4 历史报告索引：数据表 + 底部分页（每页 10 份），点击打开 report.html。
//
// 纪律：确定性、不联网、不调用 LLM、无外部 CSS/JS 依赖；所有字段转义。

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { skillRoot, runtimeRoot, runDir } = require('../shared/workspace.cjs');
const {
  statusBadge,
  directionLabel,
  confidenceLabel
} = require('./render-strategy-section.cjs');
const {
  signalCard,
  statsTable,
  escapeHtml
} = require('./render-signal-pool-html.cjs');
const { storyPoolHtml } = require('./render-story-pool-html.cjs');
const storyChain = require('../stories/lib/story-chain.cjs');
const { planStateOf, eventLabel } = require('../shared/strategy-state.cjs');

function readJSON(p, fallback = null) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function fmt(x, d = 1) {
  if (x === null || x === undefined || Number.isNaN(Number(x))) return '—';
  return Number(x).toFixed(d);
}

// ── 图形组件 ──────────────────────────────────────────────────
function confidenceMeter(level) {
  const n = level === 'high' ? 3 : level === 'medium' ? 2 : 1;
  let blocks = '';
  for (let i = 0; i < 3; i++) blocks += `<span class="cm ${i < n ? 'on' : ''}"></span>`;
  return `<span class="confidence" title="置信度 ${confidenceLabel(level)}">${blocks}</span>`;
}

function regimePill(regime) {
  const grade = regime && regime.grade ? regime.grade : 'normal';
  const dir = regime && regime.dynamic && regime.dynamic.direction ? regime.dynamic.direction : 'stable';
  const arrow = dir === 'rising' ? '↑' : dir === 'falling' ? '↓' : '→';
  return `<span class="pill ${escapeHtml(grade)}">波动 ${escapeHtml(grade)} ${arrow}</span>`;
}

function statCard(icon, label, value, tone = 'blue') {
  return `<div class="stat"><span class="stat-icon ${tone}">${icon}</span><div class="stat-meta"><b>${value}</b><span>${label}</span></div></div>`;
}

function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function extractBars(raw, symbol, maxFull = 400) {
  const c = raw && raw.contracts && raw.contracts[symbol];
  const o = c && c.ohlcv;
  if (!o || !Array.isArray(o.dates) || o.dates.length < 2) return null;
  const n = Math.min(o.dates.length, maxFull);
  const bars = [];
  for (let i = o.dates.length - n; i < o.dates.length; i++) {
    bars.push({
      date: o.dates[i],
      open: o.open[i],
      high: o.high[i],
      low: o.low[i],
      close: o.close[i]
    });
  }
  return bars;
}

function loadContractBarsLibrary(contract) {
  if (!contract) return null;
  const file = path.join(skillRoot, 'data', 'contract-bars', `${contract}.json`);
  if (!fs.existsSync(file)) return null;
  const wrapper = readJSON(file);
  const map = new Map();
  if (wrapper && wrapper.runs) {
    for (const rid of Object.keys(wrapper.runs)) {
      const bars = wrapper.runs[rid] && wrapper.runs[rid].bars;
      if (!Array.isArray(bars)) continue;
      for (const b of bars) {
        if (b && b.date) map.set(b.date, b);
      }
    }
  }
  const bars = [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
  return bars.length >= 2 ? bars : null;
}

function latestDateFromSeries(mainSeries) {
  let latest = null;
  for (const ms of Object.values(mainSeries || {})) {
    const bars = ms && ms.bars;
    if (!Array.isArray(bars) || bars.length === 0) continue;
    const d = bars[bars.length - 1].date;
    if (!latest || d > latest) latest = d;
  }
  return latest;
}

function seriesBars(mainSeries, raw, symbol, contract) {
  const lib = loadContractBarsLibrary(contract);
  if (lib) return lib;
  const ms = mainSeries && mainSeries[symbol];
  if (ms && Array.isArray(ms.bars) && ms.bars.length >= 2) return ms.bars;
  return extractBars(raw, symbol);
}

function change5dPct(bars) {
  if (!bars || bars.length < 6) return null;
  const last = bars[bars.length - 1].close;
  const prev = bars[bars.length - 6].close;
  if (!prev) return null;
  return ((last / prev) - 1) * 100;
}

function renderPriceChart(fullBars, { signalDate = null, window = 60 } = {}) {
  if (!fullBars || fullBars.length < 2) return '<p class="muted">暂无价格序列。</p>';
  const bars = fullBars.slice(-window);
  const closes = fullBars.map((b) => b.close);
  const ma20 = sma(closes, 20).slice(-window);
  const ma60 = sma(closes, 60).slice(-window);
  const chg5 = closes.map((c, i) => (i >= 5 ? ((c / closes[i - 5]) - 1) * 100 : null)).slice(-window);

  const W = 900;
  const H = 220;
  const padX = 44;
  const padY = 18;
  const n = bars.length;
  const step = (W - padX * 2) / n;
  const bodyW = Math.max(2, Math.min(8, step * 0.55));

  let min = Infinity;
  let max = -Infinity;
  for (const b of bars) {
    min = Math.min(min, b.low);
    max = Math.max(max, b.high);
  }
  for (const v of [...ma20, ...ma60]) {
    if (v != null) {
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || max === min) max = min + 1;
  const pad = (max - min) * 0.06;
  min -= pad;
  max += pad;
  const y = (p) => padY + ((max - p) / (max - min)) * (H - padY * 2);

  const parts = [];
  parts.push(`<svg class="price-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="价格趋势图">`);
  for (let i = 0; i <= 4; i++) {
    const gy = padY + (i / 4) * (H - padY * 2);
    const gv = max - (i / 4) * (max - min);
    parts.push(`<line x1="${padX}" y1="${gy}" x2="${W - padX}" y2="${gy}" stroke="#eef0f3" stroke-width="1"/>`);
    parts.push(`<text x="${padX - 6}" y="${gy + 4}" text-anchor="end" class="chart-label">${fmt(gv, 0)}</text>`);
  }
  for (let i = 0; i < n; i++) {
    const b = bars[i];
    const x = padX + i * step + step / 2;
    const up = b.close >= b.open;
    const color = up ? '#b91c1c' : '#047857';
    const yHigh = y(b.high);
    const yLow = y(b.low);
    const yOpen = y(b.open);
    const yClose = y(b.close);
    parts.push(`<line x1="${x}" y1="${yHigh}" x2="${x}" y2="${yLow}" stroke="${color}" stroke-width="1"/>`);
    const bodyTop = Math.min(yOpen, yClose);
    const bodyH = Math.max(1, Math.abs(yClose - yOpen));
    const prevClose = i > 0 ? bars[i - 1].close : null;
    const chg = prevClose != null ? b.close - prevClose : null;
    const chgPct = prevClose != null ? ((b.close / prevClose) - 1) * 100 : null;
    const chgText = chg == null ? '—' : `${chg >= 0 ? '+' : ''}${fmt(chg)}（${chgPct >= 0 ? '+' : ''}${chgPct.toFixed(1)}%）`;
    const chg5Text = chg5[i] == null ? '—' : `${chg5[i] >= 0 ? '+' : ''}${chg5[i].toFixed(1)}%`;
    const tip = `${escapeHtml(b.date)}&#10;开盘：${fmt(b.open)}&#10;最高：${fmt(b.high)}&#10;最低：${fmt(b.low)}&#10;收盘：${fmt(b.close)}&#10;当日涨跌：${chgText}&#10;5日涨跌：${chg5Text}`;
    parts.push(`<rect x="${(x - bodyW / 2).toFixed(1)}" y="${bodyTop.toFixed(1)}" width="${bodyW.toFixed(1)}" height="${bodyH.toFixed(1)}" fill="${color}"><title>${tip}</title></rect>`);
  }
  const maLine = (arr, color) => {
    const pts = [];
    for (let i = 0; i < n; i++) {
      if (arr[i] != null) pts.push(`${(padX + i * step + step / 2).toFixed(1)},${y(arr[i]).toFixed(1)}`);
    }
    if (pts.length >= 2) parts.push(`<polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="1.6"/>`);
  };
  maLine(ma20, '#2563eb');
  maLine(ma60, '#d97706');
  if (signalDate) {
    const idx = bars.findIndex((b) => b.date === signalDate);
    if (idx >= 0) {
      const x = padX + idx * step + step / 2;
      parts.push(`<line x1="${x}" y1="${padY}" x2="${x}" y2="${H - padY}" stroke="#6b7280" stroke-dasharray="4 4" stroke-width="1"/>`);
      parts.push(`<text x="${x}" y="${H - 14}" text-anchor="middle" class="chart-label">信号 ${escapeHtml(signalDate.slice(5))}</text>`);
    }
  }
  const xDate = (idx, anchor) => parts.push(`<text x="${padX + idx * step + step / 2}" y="${H - 4}" text-anchor="${anchor}" class="chart-label">${escapeHtml(bars[idx].date.slice(5))}</text>`);
  xDate(0, 'middle');
  if (n > 2) xDate(Math.floor((n - 1) / 2), 'middle');
  xDate(n - 1, 'middle');
  parts.push('</svg>');
  parts.push('<div class="legend"><span class="legend-item"><i style="background:#b91c1c"></i>涨</span><span class="legend-item"><i style="background:#047857"></i>跌</span><span class="legend-item"><i style="background:#2563eb"></i>MA20</span><span class="legend-item"><i style="background:#d97706"></i>MA60</span></div>');
  return parts.join('');
}

function rangeBar(period, p68, p95, close) {
  if (!p68 || !p95 || close == null) return '';
  const label = period === '3d' ? '未来 3 日' : period === '5d' ? '未来 5 日' : escapeHtml(period);
  const lo = Math.min(p95[0], close);
  const hi = Math.max(p95[1], close);
  if (hi === lo) return '';
  const pct = (v) => ((v - lo) / (hi - lo)) * 100;
  const p68Left = Math.min(pct(p68[0]), pct(p68[1]));
  const p68W = Math.abs(pct(p68[1]) - pct(p68[0]));
  const p95Left = Math.min(pct(p95[0]), pct(p95[1]));
  const p95W = Math.abs(pct(p95[1]) - pct(p95[0]));
  const closePct = pct(close);
  const labelLeft = Math.max(12, Math.min(88, closePct));
  const out = [];
  out.push(`<div class="rangebar"><div class="rangebar-head"><span>${label}</span><span class="rangebar-pos">现价处于区间 ${closePct.toFixed(0)}% 位置</span></div>`);
  out.push(`<div class="range-track"><span class="range-p95" style="left:${p95Left.toFixed(1)}%;width:${p95W.toFixed(1)}%"></span><span class="range-p68" style="left:${p68Left.toFixed(1)}%;width:${p68W.toFixed(1)}%"></span><span class="range-close" style="left:${closePct.toFixed(1)}%"></span><span class="range-close-label" style="left:${labelLeft.toFixed(1)}%">↑ 现价 ${fmt(close)}</span></div>`);
  out.push(`<div class="rangebar-foot"><span>${fmt(lo)}</span><span class="rangebar-stats">68%区间 ${fmt(p68[0])} ~ ${fmt(p68[1])} · 95%区间 ${fmt(p95[0])} ~ ${fmt(p95[1])}</span><span>${fmt(hi)}</span></div></div>`);
  return out.join('');
}

function factorPanel(side, items) {
  if (!items || items.length === 0) return '';
  const cls = side === 'support' ? 'support' : 'oppose';
  const title = side === 'support' ? '▲ 支持因素' : '▼ 反向因素';
  const icon = side === 'support' ? '▲' : '▼';
  const lis = items.map((it) => `<li>${icon} ${escapeHtml(it.note || it)}</li>`).join('');
  return `<div class="factor-panel ${cls}"><h4>${title}</h4><ul>${lis}</ul></div>`;
}

function chipList(label, items, tone) {
  if (!items || items.length === 0) return '';
  const chips = items.map((s) => `<span class="chip ${tone}">${escapeHtml(s)}</span>`).join('');
  return `<div class="chip-row"><span class="chip-label">${label}</span><div class="chips">${chips}</div></div>`;
}

// ── 交易策略卡 ────────────────────────────────────────────────
function strategyStatusClass(state) {
  if (state === 'armed') return 'st-executable';
  if (state === 'watching') return 'st-watch';
  return 'st-skip';
}

function strategyCard(plan) {
  if (!plan) return '';
  const state = planStateOf(plan);
  const cls = strategyStatusClass(state);
  const conf = plan.strategyConfidence ? confidenceLabel(plan.strategyConfidence) : '—';
  const strat = plan.matchedStrategies && plan.matchedStrategies[0]
    ? `${plan.matchedStrategies[0].strategyId} ${plan.matchedStrategies[0].name || ''}`
    : '—';
  const playbook = plan.playbook ? `${plan.playbook.playbookId}${plan.playbook.gateStatus ? ` · ${plan.playbook.gateStatus}` : ''}` : '—';
  const rows = [];
  const row = (label, value) => `<tr><th>${escapeHtml(label)}</th><td>${value}</td></tr>`;
  rows.push(row('入场机会点', `${escapeHtml(plan.entry && plan.entry.trigger || '—')}${plan.entry && plan.entry.triggerLevel != null ? `<br><span class="muted">触发价 ${fmt(plan.entry.triggerLevel)}</span>` : ''}`));
  rows.push(row('触发/执行', `${escapeHtml(plan.entry && plan.entry.triggerTiming || '—')}<br><span class="muted">${escapeHtml(plan.entry && plan.entry.execution || '')}</span>`));
  rows.push(row('执行口径', escapeHtml(plan.entry && plan.entry.execution || plan.playbook && plan.playbook.executionConvention || '—')));
  rows.push(row('止损', plan.stop && plan.stop.stopPrice != null ? `${fmt(plan.stop.stopPrice)} <span class="muted">${escapeHtml(plan.stop.basis || '')}</span>` : '—'));
  rows.push(row('目标', plan.targets ? `${escapeHtml(plan.targets.t1 || '—')}${plan.targets.t2 ? `<br><span class="muted">${escapeHtml(plan.targets.t2)}</span>` : ''}` : '—'));
  rows.push(row('仓位', `${plan.position && plan.position.lots != null ? `${plan.position.lots} 手` : '—'} <span class="muted">${escapeHtml(plan.position && plan.position.lotsBasis || '')}</span>`));
  rows.push(row('证伪/失效', escapeHtml([...(plan.invalidation && plan.invalidation.hard ? plan.invalidation.hard : []), plan.invalidation && plan.invalidation.timeStop ? plan.invalidation.timeStop : ''].filter(Boolean).join('；'))));
  if (state === 'watching' && plan.entry && plan.entry.trigger) {
    rows.push(row('转执行触发', `<span class="watch-trigger">${escapeHtml(plan.entry.trigger)}</span>`));
  }
  const ra = plan.riskAssessment || {};
  const riskLine = [
    ra.unitRiskCny != null ? `每手风险 ${Math.round(ra.unitRiskCny)} CNY` : null,
    ra.marginPerLotCny != null ? `保证金/手 ${Math.round(ra.marginPerLotCny)} CNY` : null,
    ra.tailGapPct3d != null ? `尾部边距 ${fmt(ra.tailGapPct3d)}%` : null
  ].filter(Boolean).join(' · ');
  const reasons = Array.isArray(plan.stateReasons) && plan.stateReasons.length
    ? plan.stateReasons.join('；')
    : (Array.isArray(plan.statusReasons) && plan.statusReasons.length ? plan.statusReasons.join('；') : '');
  return `<div class="strategy-card ${cls}">
    <div class="strategy-head"><span class="strategy-title">📌 交易策略</span><span class="strategy-badges">${statusBadge(state)} · 策略${conf}置信 · ${escapeHtml(strat)}</span></div>
    <div class="strategy-sub">${escapeHtml(strat)} + ${escapeHtml(playbook)}</div>
    <table class="fields strategy-fields">${rows.join('')}</table>
    ${riskLine || reasons ? `<div class="strategy-risk">${escapeHtml(riskLine)}${riskLine && reasons ? ' · ' : ''}<span class="muted">${escapeHtml(reasons)}</span></div>` : ''}
  </div>`;
}

// ── 机会分析：导航 + 面板 ────────────────────────────────────
function oppNavItem(opp, raw, mainSeries, active) {
  const t = opp.thesis || {};
  const dir = t.finalDirection || 'neutral';
  const close = opp.marketFacts && opp.marketFacts.close != null ? fmt(opp.marketFacts.close) : '—';
  const conf = confidenceLabel(t.finalConfidence);
  const bars = seriesBars(mainSeries, raw, opp.symbol, opp.contract);
  const chg = change5dPct(bars);
  const chgHtml = chg == null ? '' : ` · <span class="${chg >= 0 ? 'up' : 'down'}">${chg >= 0 ? '+' : ''}${chg.toFixed(1)}%</span>`;
  return `<button class="opp-nav-item ${active ? 'active' : ''}" data-opp="${escapeHtml(opp.symbol)}"><span class="nav-dot ${escapeHtml(dir)}"></span><span class="nav-text"><span class="nav-main"><b>${escapeHtml(opp.name || opp.symbol)}</b><span class="nav-badge ${escapeHtml(dir)}">${directionLabel(dir)}</span></span><span class="nav-sub">${conf}置信 · ${close}${chgHtml}</span></span></button>`;
}

function oppPane(opp, raw, mainSeries, signalDate, active, plan, storyMap = {}) {
  const t = opp.thesis || {};
  const driver = t.driver || {};
  const odds = t.odds || {};
  const dir = t.finalDirection || 'neutral';
  const close = opp.marketFacts && opp.marketFacts.close != null ? fmt(opp.marketFacts.close) : '—';

  const bars = seriesBars(mainSeries, raw, opp.symbol, opp.contract);
  const chart = renderPriceChart(bars, { signalDate });

  const ranges = (opp.priceRanges || []).map((r) => rangeBar(r.period, r.hvCone && r.hvCone.p68, r.hvCone && r.hvCone.p95, opp.marketFacts && opp.marketFacts.close)).join('');

  const cr = t.confidenceRationale || {};
  const supportPanel = factorPanel('support', cr.supportingFactors);
  const opposePanel = factorPanel('oppose', cr.opposingFactors);

  const confirmations = t.confirmations && Array.isArray(t.confirmations.signals) ? t.confirmations.signals : [];
  const invalidations = t.invalidations && Array.isArray(t.invalidations.conditions) ? t.invalidations.conditions : [];
  const risks = t.risks && Array.isArray(t.risks.items) ? t.risks.items : [];

  const detail = [];
  if (driver.primary || driver.secondary) {
    detail.push(`<h4>Q1 驱动</h4><p>${escapeHtml(driver.primary || '')}${driver.secondary ? `<br><span class="muted">${escapeHtml(driver.secondary)}</span>` : ''}</p>`);
    if (driver.evidence) detail.push(`<p class="muted">证据：${escapeHtml(driver.evidence)}</p>`);
    if (driver.source) detail.push(`<p class="muted">来源：${escapeHtml(driver.source)}</p>`);
  }
  if (t.trendOrImpulse && t.trendOrImpulse.assessment) detail.push(`<h4>Q2 趋势/脉冲</h4><p>${escapeHtml(t.trendOrImpulse.assessment)}</p>`);
  if (odds.bias || odds.reasoning) detail.push(`<h4>Q3 赔率</h4><p>${escapeHtml(odds.bias || '')} · ${escapeHtml(odds.reasoning || '')}</p>`);
  if (cr.uncertainties && cr.uncertainties.length) detail.push(`<h4>不确定项</h4><ul>${cr.uncertainties.map((u) => `<li>${escapeHtml(u)}</li>`).join('')}</ul>`);

  const story = opp.storyChainId ? (storyMap[opp.storyChainId] || null) : null;
  return `<article class="opp-pane ${active ? 'active' : ''}" data-opp="${escapeHtml(opp.symbol)}">
    <div class="instr-head">
      <div class="instr-title">
        <div class="instr-name">${escapeHtml(opp.name || opp.symbol)} <span class="muted">（${escapeHtml(opp.contract || opp.symbol)}）</span></div>
        <div class="instr-sub">${directionLabel(dir)} · ${confidenceLabel(t.finalConfidence)}置信 · 收盘 ${close}</div>
        ${story ? `<div class="story-origin">🔗 故事：${escapeHtml(story.theme || story.chainId)} <span class="muted">（${escapeHtml(story.chainId)} · ${story.confirmedNodes}/${story.totalNodes} 节点）</span></div>` : ''}
      </div>
      <div class="instr-badges">${confidenceMeter(t.finalConfidence)}${regimePill(opp.marketFacts && opp.marketFacts.volatilityRegime)}</div>
    </div>
    ${chart}
    ${odds.reasoning ? `<p class="core-logic">${escapeHtml(odds.reasoning)}</p>` : ''}
    <div class="opp-grid">
      <div class="opp-grid-main">
        ${ranges ? `<div class="rangebars">${ranges}</div><div class="range-legend"><span>概率区间 · 未来价格可能波动的范围（EWMA 条件波动率）</span><span class="muted">深蓝 = 68% 大概率区间 · 浅蓝 = 95% 较宽区间 · 竖线 = 现价</span></div>` : ''}
        ${chipList('✅ 确认', confirmations, 'green')}
        ${chipList('❌ 失效', invalidations, 'red')}
        ${chipList('⚠️ 风险', risks, 'gray')}
      </div>
      <div class="opp-grid-side">${supportPanel || opposePanel ? `<div class="factors">${supportPanel}${opposePanel}</div>` : ''}</div>
    </div>
    ${strategyCard(plan)}
    ${detail.length ? `<details class="detail"><summary>完整六问详情</summary>${detail.join('')}</details>` : ''}
  </article>`;
}

function oppLayout(opps, raw, mainSeries, signalDate, planMap, storyMap = {}) {
  const nav = opps.map((o, i) => oppNavItem(o, raw, mainSeries, i === 0)).join('\n');
  const panes = opps.map((o, i) => oppPane(o, raw, mainSeries, signalDate, i === 0, planMap ? planMap[o.symbol] : null, storyMap)).join('\n');
  return `<div class="opp-layout"><nav class="opp-nav">${nav}</nav><div class="opp-content">${panes}</div></div>`;
}

// ── 历史报告分页 ─────────────────────────────────────────────
function historyTable(entries) {
  const rows = entries.map((h) => `<tr><td>${escapeHtml(h.runId)}</td><td>${escapeHtml(h.date)}</td><td>${escapeHtml(h.oppSymbols || '—')}</td><td class="row-action"><a href="${escapeHtml(h.href)}">打开 →</a></td></tr>`).join('');
  return rows;
}

function paginationControl(total, pageSize) {
  if (total <= pageSize) return '';
  const pages = Math.ceil(total / pageSize);
  let btns = '';
  for (let p = 1; p <= pages; p++) btns += `<button class="page-btn" data-page="${p}">${p}</button>`;
  return `<div class="pagination"><div class="page-btns"><button class="page-btn nav" data-page="prev">◀ 上一页</button>${btns}<button class="page-btn nav" data-page="next">下一页 ▶</button></div><div class="page-info">共 ${total} 份 · 第 <b id="page-cur">1</b>/${pages} 页</div></div>`;
}

function historyIndex(runId, runsRoot) {
  const entries = [];
  if (!fs.existsSync(runsRoot)) return entries;
  for (const name of fs.readdirSync(runsRoot)) {
    if (!/^\d{8}-\d{4}-auto$/.test(name)) continue;
    const dir = path.join(runsRoot, name);
    const reportHtml = path.join(dir, 'report.html');
    const reportMd = path.join(dir, 'report.md');
    if (!fs.existsSync(reportHtml) && !fs.existsSync(reportMd)) continue;
    const model = readJSON(path.join(dir, 'report-model.json'));
    const oppSymbols = model && Array.isArray(model.opportunities) ? model.opportunities.map((o) => `${o.symbol} ${o.name}`).join('、') : '';
    // 信号日以 main-series 最新 bar 日期为准（文件库/run 产物），generatedAt 只作回退
    const seriesDate = latestDateFromSeries(readJSON(path.join(dir, 'analyze', 'main-series.json')));
    const date = seriesDate || (model && model.meta && model.meta.generatedAt ? String(model.meta.generatedAt).slice(0, 10) : name.slice(0, 8));
    entries.push({
      runId: name,
      date,
      oppSymbols,
      href: fs.existsSync(reportHtml) ? `runs/${name}/report.html` : `runs/${name}/report.md`
    });
  }
  entries.sort((a, b) => (a.runId < b.runId ? 1 : -1));
  return entries;
}

// ── 主渲染 ───────────────────────────────────────────────────
function macroStrip(reportModel) {
  const inds = reportModel && reportModel.macro && reportModel.macro.indicators ? reportModel.macro.indicators : {};
  const labels = {
    DXY: '美元指数', USDCNH: '美元/离岸人民币', US10Y: '美债10年', DR007: 'DR007', SC0: '原油主力'
  };
  const order = ['SC0', 'DXY', 'US10Y', 'DR007', 'USDCNH'];
  const parts = [];
  for (const key of order) {
    const v = inds[key];
    if (!v || v.status === 'missing') continue;
    const chg = v.change5d == null ? '' : `（${v.change5d >= 0 ? '+' : ''}${v.change5d.toFixed(2)}%）`;
    parts.push(`${escapeHtml(labels[key] || key)} ${v.value != null ? fmt(v.value) : '—'}${chg}`);
  }
  if (parts.length === 0) return '<span class="muted">宏观数据不可用</span>';
  return parts.join(' · ');
}

function sectorBadges(reportModel) {
  const sectors = reportModel && reportModel.sector && reportModel.sector.sectors ? reportModel.sector.sectors : {};
  const order = ['black', 'nonferrous', 'precious', 'energy_chemical', 'agriculture', 'new_materials', 'shipping'];
  const parts = [];
  for (const key of order) {
    const s = sectors[key];
    if (!s) continue;
    const dir = s.direction === 'up' ? '↑' : s.direction === 'down' ? '↓' : '→';
    const breadth = s.breadth1d != null ? `${Math.round(s.breadth1d)}%` : '—';
    parts.push(`<span class="sector-badge ${escapeHtml(s.direction || 'flat')}">${escapeHtml(s.label || key)} ${dir} ${breadth}</span>`);
  }
  if (parts.length === 0) return '<span class="muted">板块数据不可用</span>';
  return parts.join('');
}

function freshnessLine(reportModel) {
  const f = reportModel && reportModel.freshness;
  if (!f) return '';
  const date = f.latestBarDate || '—';
  const total = f.totalSymbols != null ? f.totalSymbols : '—';
  const withLatest = f.withLatestBar != null ? f.withLatestBar : '—';
  return `数据 ${escapeHtml(date)} 收盘 · ${withLatest}/${total} 品种已更新`;
}

function actionStrip(strategyPlan, signalPoolView) {
  const plans = strategyPlan && Array.isArray(strategyPlan.plans) ? strategyPlan.plans : [];
  const armed = plans.filter((p) => planStateOf(p) === 'armed').length;
  const watching = plans.filter((p) => planStateOf(p) === 'watching').length;
  const suspended = plans.filter((p) => planStateOf(p) === 'suspended').length;
  const pool = signalPoolView && Array.isArray(signalPoolView.pool) ? signalPoolView.pool : [];
  const poolTxt = pool.map((p) => `${escapeHtml(p.name || p.symbol)}·${escapeHtml(p.signalStatus ? eventLabel(p.signalStatus === 'ready' ? 'triggered' : p.signalStatus, 'execution') : (p.poolStatus === 'active' ? '追踪中' : '降级'))}`).join(' ｜ ') || '空';
  return `今日动作：🔔 生效观察 ${armed} · 👀 观察确认 ${watching} · ⛔ 暂停 ${suspended} ｜ 信号池：${poolTxt}`;
}

function dataBadges(strategyPlan, signalPoolView, costAnchorAvailable) {
  const badges = [];
  const n = strategyPlan && Array.isArray(strategyPlan.plans) ? strategyPlan.plans.length : 0;
  badges.push(n > 0 ? `策略 ${n}` : '策略 缺失');
  const poolN = signalPoolView && Array.isArray(signalPoolView.pool) ? signalPoolView.pool.length : 0;
  badges.push(signalPoolView ? `信号池 ${poolN}` : '信号池 缺失');
  badges.push(costAnchorAvailable ? '成本锚 ✓' : '成本锚 —');
  return badges.map((b) => `<span class="data-badge">${escapeHtml(b)}</span>`).join('');
}

function storyWatchHtml(storyView) {
  const chains = storyView && Array.isArray(storyView.active) ? storyView.active : [];
  if (chains.length === 0) return '<div class="empty-panel"><h3>空仓观察</h3><p class="muted">故事池为空：没有可监测的传导故事，本期不深挖、不下注。</p></div>';
  const rows = chains.map((c) => {
    const activeNode = c.activeNode || '—';
    return `<div class="watch-row">
      <div class="watch-main"><b>${escapeHtml(c.theme || '（未命名主题）')}</b>
        <span class="muted">${escapeHtml(c.chainId)} · ${escapeHtml(c.sector)} · ${escapeHtml(c.representative)} · ${c.direction === -1 ? '🔻 空' : '🔺 多'}</span>
      </div>
      <div class="watch-meta"><span class="story-status st-run">${escapeHtml(c.status)}</span>
        <span>${c.confirmedNodes}/${c.totalNodes} 节点 · 观察节点 ${escapeHtml(activeNode)}</span>
        ${c.seats && c.seats.length ? `<span class="story-seats">席位：${c.seats.map((s) => `${escapeHtml(s.runId)}→${escapeHtml(s.symbol)}`).join('、')}</span>` : ''}
      </div>
    </div>`;
  }).join('');
  return `<div class="watch-list"><h3>故事池观察清单（无 proven 席位，本期不深挖）</h3>${rows}</div>`;
}

function renderDashboardHtml({ runId, reportModel, signalPoolView, storyView = null, history, raw, mainSeries, signalDate, strategyPlan, costAnchorAvailable = false }) {
  const opps = reportModel && Array.isArray(reportModel.opportunities) ? reportModel.opportunities : [];
  const pool = signalPoolView && Array.isArray(signalPoolView.pool) ? signalPoolView.pool : [];
  const recentClosed = signalPoolView && Array.isArray(signalPoolView.recentClosed) ? signalPoolView.recentClosed : [];
  const stats = signalPoolView && signalPoolView.historyStats ? signalPoolView.historyStats : {};
  const details = signalPoolView && signalPoolView.details ? signalPoolView.details : {};

  const planMap = new Map((strategyPlan && Array.isArray(strategyPlan.plans) ? strategyPlan.plans : []).map((p) => [p.symbol, p]));
  const storyMap = {};
  for (const c of [...((storyView && storyView.active) || []), ...((storyView && storyView.recentClosed) || [])]) {
    if (c && c.chainId) storyMap[c.chainId] = c;
  }
  const oppHtml = opps.length ? oppLayout(opps, raw, mainSeries, signalDate, Object.fromEntries(planMap), storyMap) : storyWatchHtml(storyView);
  const poolCards = pool.map((s) => {
    const d = details[s.signalId] || {};
    return signalCard({ ...s, versions: d.versions || [] }, { bars: seriesBars(mainSeries, raw, s.symbol, s.contract) });
  }).join('\n');
  const closedCards = recentClosed.map((s) => {
    const d = details[s.signalId] || {};
    return signalCard({ ...s, versions: d.versions || [] }, { closed: true, bars: seriesBars(mainSeries, raw, s.symbol, s.contract) });
  }).join('\n');

  const downgradedCount = pool.filter((s) => s.poolStatus === 'downgraded').length;
  const activeCount = pool.length - downgradedCount;

  const histRows = historyTable(history);
  const pagination = paginationControl(history.length, 10);
  const storyHtml = storyPoolHtml(storyView || { stats: {}, active: [], recentClosed: [] });

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Futures Radar · 看板</title>
<style>
  :root { --bg:#f7f8fa; --card:#ffffff; --border:#e5e7eb; --text:#1f2328; --muted:#6b7280; --accent:#2563eb; --up:#b91c1c; --down:#047857; --radius:10px; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 13px/1.7 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }

  /* App shell */
  header { background: var(--card); border-bottom: 1px solid var(--border); }
  .header-inner { max-width: 1320px; margin: 0 auto; padding: 0 22px; display: flex; align-items: center; gap: 20px; height: 56px; }
  .brand { font-size: 15px; font-weight: 700; white-space: nowrap; }
  .tabs { display: flex; gap: 4px; flex: 1; }
  .tab { border: none; background: transparent; color: var(--muted); padding: 8px 14px; border-radius: 8px; cursor: pointer; font-size: 14px; }
  .tab.active { background: #eef4ff; color: var(--accent); font-weight: 600; }
  .run-meta { font-size: 12px; color: var(--muted); white-space: nowrap; }

  main { max-width: 1320px; margin: 0 auto; padding: 18px 22px 48px; }
  .tab-panel { display: none; }
  .tab-panel.active { display: block; }

  /* 市场环境条 / 今日速览 */
  .market-strip { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); padding: 10px 14px; display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px; }
  .market-row { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; font-size: 13px; }
  .market-label { font-weight: 600; color: var(--muted); min-width: 36px; }
  .sector-badge { font-size: 12px; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--border); background: #f7f8fa; }
  .sector-badge.up { background: #fdeaea; color: #b91c1c; }
  .sector-badge.down { background: #e7f6ec; color: #047857; }
  .sector-badge.flat { background: #f1f3f5; color: #6b7280; }
  .market-fresh { font-size: 12px; color: var(--muted); }
  .action-strip { font-size: 13px; background: #eef4ff; border: 1px solid #dbeafe; border-radius: 8px; padding: 8px 14px; margin-bottom: 10px; }
  .data-badge { font-size: 11px; padding: 1px 6px; border-radius: 999px; background: #f1f3f5; color: var(--muted); margin-left: 4px; }
  .screening { border: 1px solid var(--border); border-radius: var(--radius); background: var(--card); margin-top: 14px; }
  .screening > summary { cursor: pointer; padding: 10px 16px; font-weight: 600; list-style: none; }
  .screening > summary::-webkit-details-marker { display: none; }
  .screening > summary::before { content: "▸"; color: var(--muted); margin-right: 6px; }
  .screening[open] > summary::before { content: "▾"; }
  .screening-body { padding: 4px 16px 14px; border-top: 1px solid var(--border); }
  .screening-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  @media (max-width: 900px) { .screening-grid { grid-template-columns: 1fr; } }
  table.mini { width: 100%; border-collapse: collapse; font-size: 12px; }
  table.mini th, table.mini td { padding: 5px 8px; border-bottom: 1px solid var(--border); text-align: left; }
  table.mini th { color: var(--muted); font-weight: 500; background: #f7f8fa; }
  #history-search { padding: 5px 10px; border: 1px solid var(--border); border-radius: 6px; font-size: 13px; width: 240px; }

  /* KPI 统计卡 */
  .summary-bar { display: flex; gap: 12px; flex-wrap: wrap; margin: 4px 0 18px; }
  .stat { display: flex; align-items: center; gap: 12px; background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); padding: 12px 16px; min-width: 160px; }
  .stat-icon { width: 34px; height: 34px; border-radius: 8px; display: inline-flex; align-items: center; justify-content: center; font-size: 16px; }
  .stat-icon.blue { background: #eef4ff; }
  .stat-icon.green { background: #e7f6ec; }
  .stat-icon.red { background: #fdeaea; }
  .stat-icon.gray { background: #f1f3f5; }
  .stat-meta b { display: block; font-size: 19px; line-height: 1.3; font-variant-numeric: tabular-nums; }
  .stat-meta span { font-size: 12px; color: var(--muted); white-space: nowrap; }

  section h2 { font-size: 15px; margin: 20px 0 10px; padding-left: 8px; border-left: 3px solid var(--accent); }

  /* 卡片通用 */
  .card { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); margin: 10px 0; box-shadow: 0 1px 2px rgba(0,0,0,.03); }
  .card > summary { cursor: pointer; padding: 12px 16px; font-weight: 600; list-style: none; display: flex; align-items: center; gap: 8px; }
  .card > summary::-webkit-details-marker { display: none; }
  .card > summary::before { content: "▸"; color: var(--muted); transition: transform .15s; }
  .card[open] > summary::before { transform: rotate(90deg); }
  .card-body { padding: 4px 16px 16px; border-top: 1px solid var(--border); }

  /* 机会分析：主从布局 */
  .opp-layout { display: flex; gap: 16px; align-items: flex-start; }
  .opp-nav { width: 250px; flex: 0 0 250px; display: flex; flex-direction: column; gap: 6px; position: sticky; top: 70px; }
  .opp-nav-item { display: flex; align-items: flex-start; gap: 10px; text-align: left; border: 1px solid var(--border); background: var(--card); border-radius: 8px; padding: 10px 12px; cursor: pointer; }
  .opp-nav-item.active { border-color: var(--accent); background: #eef4ff; }
  .nav-dot { width: 8px; height: 8px; border-radius: 50%; margin-top: 5px; flex: 0 0 8px; }
  .nav-dot.bullish { background: var(--up); }
  .nav-dot.bearish { background: var(--down); }
  .nav-dot.neutral { background: #9ca3af; }
  .nav-text { display: flex; flex-direction: column; min-width: 0; gap: 3px; }
  .nav-main { display: flex; align-items: center; gap: 6px; font-size: 13px; white-space: nowrap; }
  .nav-badge { font-size: 11px; padding: 1px 6px; border-radius: 4px; }
  .nav-badge.bullish { background: #fdeaea; color: var(--up); }
  .nav-badge.bearish { background: #e7f6ec; color: var(--down); }
  .nav-badge.neutral { background: #f1f3f5; color: var(--muted); }
  .nav-sub { display: block; font-size: 12px; color: var(--muted); line-height: 1.5; }
  .opp-content { flex: 1; min-width: 0; }
  .opp-pane { display: none; background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); padding: 18px 20px; }
  .opp-pane.active { display: block; }

  .instr-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 14px; flex-wrap: wrap; margin-bottom: 12px; }
  .instr-name { font-size: 17px; font-weight: 700; }
  .instr-sub { font-size: 12px; color: var(--muted); margin-top: 4px; }
  .story-origin { font-size: 12px; margin-top: 4px; }
  .instr-badges { display: inline-flex; align-items: center; gap: 10px; }
  .confidence { display: inline-flex; gap: 3px; }
  .confidence .cm { width: 16px; height: 7px; border-radius: 3px; background: #e5e7eb; }
  .confidence .cm.on { background: var(--accent); }
  .pill { font-size: 12px; padding: 2px 8px; border-radius: 999px; font-weight: 600; }
  .pill.normal { background: #e7f6ec; color: #047857; }
  .pill.elevated { background: #fdf3e0; color: #b45309; }
  .pill.extreme { background: #fdeaea; color: #b91c1c; }

  .price-chart { width: 100%; height: auto; display: block; background: #fcfcfd; border: 1px solid var(--border); border-radius: 8px; }
  .chart-label { font-size: 10px; fill: var(--muted); }
  .legend { display: flex; gap: 12px; margin: 6px 0 2px; font-size: 12px; color: var(--muted); }
  .legend-item { display: inline-flex; align-items: center; gap: 4px; }
  .legend-item i { width: 10px; height: 4px; display: inline-block; border-radius: 2px; }
  .core-logic { margin: 10px 0 4px; font-weight: 500; }

  .opp-grid { display: grid; grid-template-columns: 1fr 320px; gap: 14px; margin-top: 10px; }
  .opp-grid-main { min-width: 0; }
  .opp-grid-side { min-width: 0; }
  @media (max-width: 1100px) { .opp-grid { grid-template-columns: 1fr; } }

  .strategy-card { border: 1px solid var(--border); border-left: 3px solid var(--muted); border-radius: 8px; padding: 10px 14px; margin: 12px 0 0; background: #fcfcfd; }
  .strategy-card.st-executable { border-left-color: #047857; }
  .strategy-card.st-watch { border-left-color: #b45309; }
  .strategy-card.st-skip { border-left-color: #b91c1c; }
  .strategy-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; }
  .strategy-title { font-weight: 700; }
  .strategy-badges { font-size: 12px; color: var(--muted); }
  .strategy-sub { font-size: 12px; color: var(--muted); margin: 2px 0 6px; }
  table.strategy-fields th { width: 96px; }
  .strategy-risk { margin-top: 8px; font-size: 12px; color: var(--muted); border-top: 1px dashed var(--border); padding-top: 8px; }
  .watch-trigger { color: #047857; font-weight: 600; }

  .range-legend { display: flex; flex-direction: column; gap: 2px; margin: 8px 0 0; font-size: 12px; color: var(--muted); }
  .rangebars { display: flex; flex-direction: column; gap: 10px; margin: 8px 0; }
  .rangebar { border: 1px solid var(--border); border-radius: 8px; padding: 10px 14px 8px; background: #fcfcfd; }
  .rangebar-head { display: flex; justify-content: space-between; align-items: baseline; font-size: 12px; margin: 0 0 4px; }
  .rangebar-head > span:first-child { font-weight: 600; color: var(--text); }
  .rangebar-pos { color: var(--muted); }
  .range-track { position: relative; height: 12px; background: #f1f3f5; border-radius: 6px; margin-top: 18px; }
  .range-p95 { position: absolute; top: 2px; bottom: 2px; background: #dbe4f0; border-radius: 4px; }
  .range-p68 { position: absolute; top: 2px; bottom: 2px; background: #9db8e8; border-radius: 4px; }
  .range-close { position: absolute; top: -2px; bottom: -2px; width: 3px; background: #1f2328; border-radius: 2px; }
  .range-close-label { position: absolute; top: -18px; transform: translateX(-50%); font-size: 11px; color: var(--text); white-space: nowrap; }
  .rangebar-foot { display: flex; align-items: baseline; gap: 10px; font-size: 12px; color: var(--muted); margin-top: 6px; }
  .rangebar-foot > span:first-child, .rangebar-foot > span:last-child { white-space: nowrap; }
  .rangebar-stats { flex: 1; text-align: center; color: var(--muted); }

  .factors { display: flex; flex-direction: column; gap: 8px; }
  .factor-panel { border-radius: 8px; padding: 10px 14px; border: 1px solid var(--border); }
  .factor-panel.support { background: #f5faf6; border-left: 3px solid #047857; }
  .factor-panel.oppose { background: #fdf6f5; border-left: 3px solid #b91c1c; }
  .factor-panel h4 { margin: 2px 0 6px; font-size: 13px; }
  .factor-panel ul { margin: 0; padding-left: 18px; font-size: 13px; line-height: 1.7; }

  .chip-row { display: flex; gap: 10px; margin: 10px 0; align-items: flex-start; }
  .chip-label { font-size: 12px; color: var(--muted); white-space: nowrap; padding-top: 2px; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip { font-size: 12px; padding: 2px 8px; border-radius: 6px; border: 1px solid var(--border); }
  .chip.green { background: #f0f9f2; border-color: #cdebd4; color: #047857; }
  .chip.red { background: #fdf1f0; border-color: #f5cfcc; color: #b91c1c; }
  .chip.gray { background: #f7f8fa; color: #4b5563; }
  details.detail { margin-top: 10px; border: 1px dashed var(--border); border-radius: 8px; padding: 4px 10px; }
  details.detail summary { cursor: pointer; color: var(--muted); font-size: 13px; }
  .up { color: var(--up); font-weight: 600; }
  .down { color: var(--down); font-weight: 600; }
  .muted { color: var(--muted); font-size: 12px; }

  /* 信号池：双栏布局 */
  .pool-layout { display: grid; grid-template-columns: 1fr 320px; gap: 16px; align-items: start; }
  .pool-main { min-width: 0; }
  .pool-side { position: sticky; top: 70px; display: flex; flex-direction: column; gap: 12px; }
  .side-card { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px 16px; }
  .side-card h3 { margin: 0 0 8px; font-size: 13px; }
  .side-notes { margin: 0; padding-left: 18px; font-size: 12px; color: var(--muted); line-height: 1.8; }
  @media (max-width: 1080px) { .pool-layout { grid-template-columns: 1fr; } .pool-side { position: static; } }

  /* 故事池：最近出池 20 条——表头固定在滚动区外，滚动区初始约可见 5 行 */
  .closed-table { border: 1px solid var(--border); border-radius: 8px; overflow-x: auto; background: var(--card); }
  .closed-head-wrap { scrollbar-gutter: stable; overflow-y: hidden; border-bottom: 1px solid var(--border); }
  .closed-scroll { max-height: 300px; overflow-y: auto; scrollbar-gutter: stable; }
  .closed-table table { width: 100%; min-width: 860px; table-layout: fixed; border-collapse: collapse; }
  .closed-head-wrap, .closed-scroll { min-width: 860px; }
  .closed-head th { border-bottom: none; }
  @media (max-width: 1080px) { .closed-scroll { max-height: 260px; } }

  .anchor-panel { background: #f0f6ff; border: 1px solid #dbeafe; border-radius: 8px; padding: 10px 12px; margin: 8px 0; }
  .anchor-head { font-weight: 600; font-size: 13px; margin-bottom: 4px; }
  .anchor-sub { font-size: 12px; color: var(--muted); margin-bottom: 6px; }
  .anchor-sub.pos-holding { color: #047857; font-weight: 600; }
  .anchor-sub.pos-triggered { color: #b45309; font-weight: 600; }
  .anchor-grid { display: grid; grid-template-columns: repeat(5, minmax(0,1fr)); gap: 10px; }
  .anchor-item span { display: block; font-size: 12px; color: var(--muted); }
  .anchor-item b { font-size: 14px; font-variant-numeric: tabular-nums; }
  @media (max-width: 900px) { .anchor-grid { grid-template-columns: repeat(2, minmax(0,1fr)); } }

  .progress { display: inline-flex; align-items: center; gap: 6px; vertical-align: middle; }
  .progress-fill { display: inline-block; height: 8px; border-radius: 4px; background: linear-gradient(90deg,#9db8e8,#2563eb); }
  .progress-text { font-size: 12px; font-variant-numeric: tabular-nums; }
  table.timeline { width: 100%; border-collapse: collapse; margin: 6px 0; font-size: 12px; }
  table.timeline th, table.timeline td { padding: 4px 8px; border-bottom: 1px solid var(--border); text-align: left; }
  table.timeline th { color: var(--muted); font-weight: 500; }

  table.fields { width: 100%; border-collapse: collapse; table-layout: fixed; margin: 6px 0; }
  table.fields th { width: 88px; text-align: left; vertical-align: top; color: var(--muted); font-weight: 500; padding: 5px 10px 5px 0; white-space: nowrap; }
  table.fields td { vertical-align: top; padding: 5px 0; word-break: break-word; }
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
  table.stats { width: 100%; border-collapse: collapse; }
  table.stats th, table.stats td { padding: 6px 8px; text-align: left; border-bottom: 1px solid var(--border); font-size: 13px; }
  table.stats tr:last-child th, table.stats tr:last-child td { border-bottom: none; }
  table.stats th { color: var(--muted); font-weight: 500; }
  table.stats tr.sub th, table.stats tr.sub td { padding-top: 0; }
  table.stats tr.sub td { color: var(--muted); font-size: 12px; line-height: 1.7; }
  table.stats tr.sub + tr th, table.stats tr.sub + tr td { padding-top: 6px; }

  /* 故事池 */
  .story-card { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); padding: 0; margin-bottom: 12px; overflow: hidden; }
  .story-card > summary { list-style: none; cursor: pointer; padding: 12px 16px; display: block; }
  .story-card > summary::-webkit-details-marker { display: none; }
  .story-card > summary::before { content: '▸'; color: var(--muted); margin-right: 8px; font-size: 12px; display: inline-block; vertical-align: middle; }
  .story-card[open] > summary::before { content: '▾'; }
  .story-summary { display: block; }
  .story-theme { font-size: 15px; font-weight: 700; display: inline; vertical-align: middle; }
  .story-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; margin-top: 6px; }
  .story-body { border-top: 1px solid var(--border); padding: 12px 16px; }
  .story-subtitle { font-size: 13px; color: var(--muted); line-height: 1.6; margin-bottom: 10px; }
  .story-graph { position: relative; margin: 4px 0 10px; padding: 8px; border: 1px solid var(--border); border-radius: 8px; background: #fbfcfd; overflow-x: auto; }
  .sg-svg { display: block; min-width: 320px; }
  .sg-node { transition: opacity .15s ease; }
  .sg-edge { transition: opacity .15s ease; cursor: pointer; }
  .sg-dim { opacity: 0.18; }
  .sg-detail { position: absolute; top: 10px; right: 10px; max-width: 280px; z-index: 5; }
  .sg-detail-card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; box-shadow: 0 8px 24px rgba(15,23,42,.12); padding: 10px 12px; font-size: 12px; }
  .sg-detail-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 6px; font-size: 13px; }
  .sg-detail-close { border: none; background: transparent; font-size: 16px; line-height: 1; cursor: pointer; color: var(--muted); }
  .sg-detail-row { display: flex; justify-content: space-between; gap: 12px; padding: 2px 0; color: var(--muted); }
  .sg-detail-row b { color: var(--text); font-weight: 600; text-align: right; }
  .sg-detail-note { margin-top: 6px; color: var(--muted); font-size: 11px; }
  .sg-hint { margin: 2px 0 4px; font-size: 11px; color: var(--muted); }
  .sg-legend { display: flex; flex-wrap: wrap; gap: 10px; font-size: 11px; color: var(--muted); margin: 2px 0 6px; }
  .sg-legend span { display: inline-flex; align-items: center; gap: 4px; }
  .lg-dot { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
  .lg-source { background: #1f2937; }
  .lg-mid { background: #f8fafc; border: 1px solid #cbd5e1; }
  .lg-primary { background: #eef2ff; border: 1px solid #6366f1; }
  .lg-secondary { background: #f3f4f6; border: 1px solid #9ca3af; }
  .lg-confirmed { background: #ecfdf5; border: 1px solid #047857; }
  .lg-broken { background: #fef2f2; border: 1px solid #b91c1c; }
  .node-table { width: 100%; border-collapse: collapse; margin: 6px 0 10px; }
  .node-table th, .node-table td { padding: 6px 8px; text-align: left; border-bottom: 1px solid var(--border); font-size: 12px; vertical-align: top; }
  .node-table th { color: var(--muted); font-weight: 500; white-space: nowrap; }
  .node-table .muted { font-size: 11px; margin-top: 2px; }
  .branch-table { width: 100%; border-collapse: collapse; margin: 6px 0 10px; }
  .branch-table th, .branch-table td { padding: 6px 8px; text-align: left; border-bottom: 1px solid var(--border); font-size: 12px; }
  .branch-table th { color: var(--muted); font-weight: 500; }
  .story-sub-detail { margin-top: 8px; border-top: 1px dashed var(--border); padding-top: 6px; }
  .story-sub-detail summary { cursor: pointer; color: var(--muted); font-size: 12px; font-weight: 600; }
  .branch-table-wide { min-width: 960px; }
  .branch-row { cursor: pointer; }
  .branch-row:hover td { background: #f6f8fb; }
  .story-detail-btn, .closed-detail-btn { border: 1px solid var(--border); background: var(--card); border-radius: 6px; padding: 3px 8px; font-size: 12px; cursor: pointer; color: var(--text); }
  .closed-detail-btn { border: none; background: transparent; padding: 0; font-weight: 600; cursor: pointer; color: var(--text); font-size: 13px; text-align: left; }
  .story-modal { display: none; position: fixed; inset: 0; z-index: 50; }
  .story-modal.open { display: block; }
  .story-modal-backdrop { position: absolute; inset: 0; background: rgba(15,23,42,.45); }
  .story-modal-body { position: absolute; inset: 24px 24px 24px 24px; max-width: 960px; margin: 0 auto; background: var(--card); border-radius: 12px; overflow: auto; padding: 18px 20px; box-shadow: 0 20px 60px rgba(0,0,0,.25); }
  .story-modal-close { position: absolute; top: 10px; right: 12px; border: none; background: transparent; font-size: 24px; line-height: 1; cursor: pointer; color: var(--muted); z-index: 2; }
  .story-modal-body-sm { max-width: 900px; max-height: 62vh; inset: 36px 18px 36px 18px; margin: 0 auto; }
  .story-branches { display: flex; flex-direction: column; gap: 6px; margin-bottom: 10px; }
  .story-branch { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 13px; padding: 6px 8px; border: 1px solid var(--border); border-radius: 6px; background: #fafbfc; }
  .branch-priority { font-size: 11px; padding: 1px 6px; border-radius: 4px; }
  .branch-priority.bp-primary { background: #eef2ff; color: #3730a3; }
  .branch-priority.bp-secondary { background: #f3f4f6; color: #4b5563; }
  .branch-symbol { font-weight: 600; }
  .branch-dir, .branch-status, .branch-proof { color: var(--muted); font-size: 12px; }
  .story-status { font-size: 12px; padding: 2px 8px; border-radius: 999px; font-weight: 600; }
  .story-status.st-ok { background: #ecfdf5; color: #047857; }
  .story-status.st-bad { background: #fef2f2; color: #b91c1c; }
  .story-status.st-watch { background: #fffbeb; color: #b45309; }
  .story-status.st-run { background: #eef4ff; color: #2563eb; }
  .story-dir { font-weight: 700; }
  .story-chain-id { color: var(--muted); font-size: 11px; }
  .story-sector, .story-rep, .story-proof { color: var(--muted); }
  .story-seats { color: var(--accent); }
  .story-link { color: var(--accent); }
  .story-progress { height: 6px; background: #f0f1f3; border-radius: 4px; margin: 10px 0; overflow: hidden; }
  .story-progress-fill { height: 100%; background: var(--accent); border-radius: 4px; }
  .story-nodes { display: flex; flex-direction: column; gap: 6px; margin: 10px 0; }
  .story-node { display: flex; flex-direction: column; gap: 4px; font-size: 13px; padding: 8px 10px; border-radius: 6px; background: #fafbfc; }
  .node-line { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .node-line.node-values, .node-line.node-meta-line { padding-left: 24px; }
  .story-node .node-state { width: 16px; text-align: center; }
  .story-node.node-confirmed { background: #f0fdf4; }
  .story-node.node-confirmed .node-state { color: #047857; }
  .story-node.node-broken { background: #fef2f2; }
  .story-node.node-broken .node-state { color: #b91c1c; }
  .story-node .node-label { font-weight: 600; }
  .story-node .node-status { font-size: 12px; color: var(--muted); }
  .story-node .node-dir { font-size: 12px; color: var(--muted); }
  .story-node .node-value { font-size: 12px; color: #374151; background: #fff; border: 1px solid var(--border); border-radius: 6px; padding: 2px 6px; }
  .story-node .mom-up { color: var(--up); }
  .story-node .mom-down { color: var(--down); }
  .story-node .node-window { font-size: 12px; color: var(--muted); }
  .story-node .node-confirm-at { font-size: 12px; color: #047857; }
  .story-node .node-meta { color: var(--muted); font-size: 11px; }
  .story-node .node-path { font-size: 11px; color: #2563eb; background: #eef4ff; border-radius: 4px; padding: 1px 5px; }
  .story-node .node-broken-reason { color: #b91c1c; font-size: 12px; }
  .cred { font-size: 11px; border-radius: 4px; padding: 1px 5px; }
  .cred-high { background: #ecfdf5; color: #047857; }
  .cred-medium { background: #fffbeb; color: #b45309; }
  .cred-low { background: #fef3c7; color: #92400e; }
  .cred-unknown { background: #f3f4f6; color: #6b7280; }
  .story-events { margin-top: 10px; font-size: 12px; color: var(--muted); }
  .story-event { padding: 2px 0; }
  .story-event .event-date { color: var(--text); }
  td.closed-theme { max-width: 260px; }

  .empty-panel, .watch-list { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; }
  .watch-row { border-bottom: 1px solid var(--border); padding: 8px 0; }
  .watch-row:last-child { border-bottom: none; }
  .watch-main { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 14px; }
  .watch-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; color: var(--muted); margin-top: 4px; }

  /* 历史报告索引 */
  .history-toolbar { display: flex; justify-content: space-between; align-items: center; margin: 4px 0 10px; font-size: 12px; color: var(--muted); }
  .table-wrap { overflow-x: auto; }
  table.index { width: 100%; border-collapse: collapse; background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
  table.index th, table.index td { padding: 10px 14px; text-align: left; border-bottom: 1px solid var(--border); }
  table.index tr:last-child th, table.index tr:last-child td { border-bottom: none; }
  table.index th { background: #f7f8fa; font-weight: 600; white-space: nowrap; }
  table.index tbody tr:hover { background: #fafbfc; }
  table.index td.row-action { text-align: right; white-space: nowrap; }
  table.index a { color: var(--accent); text-decoration: none; }
  table.index tr.hidden { display: none; }
  .pagination { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; margin: 12px 0 0; }
  .page-btns { display: flex; gap: 6px; }
  .page-btn { border: 1px solid var(--border); background: var(--card); color: var(--text); padding: 5px 12px; border-radius: 6px; cursor: pointer; font-size: 13px; }
  .page-btn.active { background: var(--accent); border-color: var(--accent); color: #fff; }
  .page-btn.nav { font-size: 12px; }
  .page-info { font-size: 12px; color: var(--muted); }

  @media (max-width: 900px) {
    .opp-layout { flex-direction: column; }
    .opp-nav { width: 100%; flex-direction: row; flex-wrap: wrap; position: static; }
    .opp-nav-item { flex-direction: row; align-items: center; }
  }
  @media print { header { position: static; } .tab { display: none; } .tab-panel { display: block !important; } .pagination { display: none; } details:not([open]) > *:not(summary) { display: block !important; } details > summary::before { content: ""; } }
</style>
</head>
<body>
<header>
  <div class="header-inner">
    <div class="brand">Futures Radar 看板</div>
    <nav class="tabs">
      <button class="tab active" data-tab="stories">🔗 故事池</button>
      <button class="tab" data-tab="opportunities">📈 机会分析</button>
      <button class="tab" data-tab="pool">📊 信号池</button>
      <button class="tab" data-tab="history">🗂 历史报告</button>
    </nav>
    <div class="run-meta">${escapeHtml(runId)}${signalDate ? ` · 信号日 ${escapeHtml(signalDate)}` : ''} · ${dataBadges(strategyPlan, signalPoolView, costAnchorAvailable)}</div>
  </div>
</header>
<main>
  <section id="tab-stories" class="tab-panel active">
    ${storyHtml}
  </section>

  <section id="tab-opportunities" class="tab-panel">
    <div class="market-strip"><div class="market-row"><span class="market-label">宏观</span>${macroStrip(reportModel)}</div><div class="market-row"><span class="market-label">板块</span>${sectorBadges(reportModel)}</div><div class="market-row market-fresh">${freshnessLine(reportModel)}</div></div>
    <div class="action-strip">${actionStrip(strategyPlan, signalPoolView)}</div>
    <div class="summary-bar">
      ${statCard('📈', '本期机会', opps.length, 'blue')}
      ${statCard('↑', '看多', opps.filter((o) => o.thesis && o.thesis.finalDirection === 'bullish').length, 'red')}
      ${statCard('↓', '看空', opps.filter((o) => o.thesis && o.thesis.finalDirection === 'bearish').length, 'green')}
      ${statCard('⚠️', '信号池内', pool.length, 'gray')}
    </div>
    ${oppHtml}
  </section>

  <section id="tab-pool" class="tab-panel">
    <div class="summary-bar">
      ${statCard('📊', '池内信号', pool.length, 'blue')}
      ${statCard('🟢', '追踪中', activeCount, 'green')}
      ${statCard('🟡', '非生效观察', downgradedCount, 'gray')}
      ${statCard('📦', '历史已出池', stats.totalClosed == null ? 0 : stats.totalClosed, 'red')}
    </div>
    <div class="pool-layout">
      <div class="pool-main">
        <h2>池内信号（全量追踪）</h2>
        ${poolCards || '<p class="muted">当前池内无信号。</p>'}
        <h2>最近出池信号（最新 5 个）</h2>
        ${closedCards || '<p class="muted">暂无出池信号。</p>'}
      </div>
      <aside class="pool-side">
        <div class="side-card"><h3>历史统计</h3>${statsTable(stats)}</div>
        <div class="side-card"><h3>口径说明</h3><ul class="side-notes"><li>入池：armed（生效观察）策略诞生信号</li><li>追踪：每期完整分析席位 + 版本追加</li><li>事件即状态：armed → triggered → holding → 终态</li><li>出池：方向层 + 执行层两层归因，出池方式只做附注</li></ul></div>
      </aside>
    </div>
  </section>

  <section id="tab-history" class="tab-panel">
    <h2>历史报告索引</h2>
    <div class="history-toolbar"><span>共 ${history.length} 份</span><input id="history-search" type="search" placeholder="搜索 runId / 日期 / 品种"></div>
    ${histRows ? `<div class="table-wrap"><table class="index"><thead><tr><th>runId</th><th>日期</th><th>机会品种</th><th></th></tr></thead><tbody id="history-rows">${histRows}</tbody></table></div>` : '<p class="muted">暂无历史报告。</p>'}
    ${pagination}
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

  // 机会分析左侧导航切换
  const oppNavItems = document.querySelectorAll('.opp-nav-item');
  const oppPanes = document.querySelectorAll('.opp-pane');
  oppNavItems.forEach((item) => {
    item.addEventListener('click', () => {
      oppNavItems.forEach((n) => n.classList.remove('active'));
      oppPanes.forEach((p) => p.classList.remove('active'));
      item.classList.add('active');
      const pane = document.querySelector('.opp-pane[data-opp="' + item.dataset.opp + '"]');
      if (pane) pane.classList.add('active');
    });
  });

  // 历史报告分页：每页 10 份
  const pageSize = 10;
  const tbody = document.getElementById('history-rows');
  const searchInput = document.getElementById('history-search');
  if (tbody) {
    const allRows = Array.from(tbody.rows);
    const pageBtns = document.querySelectorAll('.page-btn');
    const pageCur = document.getElementById('page-cur');
    function filteredRows() {
      const q = (searchInput && searchInput.value ? searchInput.value : '').trim().toLowerCase();
      if (!q) return allRows;
      return allRows.filter((tr) => tr.textContent.toLowerCase().includes(q));
    }
    function showPage(p) {
      const rows = filteredRows();
      const pages = Math.max(1, Math.ceil(rows.length / pageSize));
      if (p < 1) p = 1;
      if (p > pages) p = pages;
      allRows.forEach((tr) => { tr.classList.add('hidden'); });
      rows.forEach((tr, i) => {
        const start = (p - 1) * pageSize;
        if (i >= start && i < start + pageSize) tr.classList.remove('hidden');
      });
      pageBtns.forEach((b) => {
        const bp = b.dataset.page;
        if (bp === 'prev') b.classList.toggle('active', p === 1);
        else if (bp === 'next') b.classList.toggle('active', p === pages);
        else b.classList.toggle('active', Number(bp) === p);
      });
      if (pageCur) pageCur.textContent = p;
      window._page = p;
    }
    pageBtns.forEach((b) => {
      b.addEventListener('click', () => {
        const bp = b.dataset.page;
        const pages = Math.max(1, Math.ceil(filteredRows().length / pageSize));
        let p = Number(window._page) || 1;
        if (bp === 'prev') p = p - 1;
        else if (bp === 'next') p = p + 1;
        else p = Number(bp);
        showPage(p);
      });
    });
    if (searchInput) searchInput.addEventListener('input', () => showPage(1));
    showPage(1);
  }
</script>
</body>
</html>
`;
}

function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--runId');
  const runId = i === -1 ? null : args[i + 1];
  if (!runId) {
    console.error('FATAL: --runId required');
    process.exit(1);
  }
  const dir = runDir(runId);
  const reportModel = readJSON(path.join(dir, 'report-model.json'));
  const signalPoolView = readJSON(path.join(dir, 'signal-pool.json'));
  if (!reportModel && !signalPoolView) {
    console.error('FATAL: report-model.json and signal-pool.json both missing');
    process.exit(1);
  }
  const raw = readJSON(path.join(dir, 'raw.json'));
  const strategyPlan = readJSON(path.join(dir, 'strategy-plan.json'));
  const mainSeries = readJSON(path.join(dir, 'analyze', 'main-series.json'));
  const costAnchorAvailable = fs.existsSync(path.join(dir, 'cost-anchor.json'));
  const signalDate = (raw && raw.meta && raw.meta.cacheInfo && raw.meta.cacheInfo.latestBarDate) || latestDateFromSeries(mainSeries) || null;
  const history = historyIndex(runId, path.join(runtimeRoot, 'runs'));
  const storyView = storyChain.buildView();
  const html = renderDashboardHtml({ runId, reportModel, signalPoolView, storyView, history, raw, mainSeries, signalDate, strategyPlan, costAnchorAvailable });
  const outPath = path.join(runtimeRoot, 'dashboard.html');
  fs.writeFileSync(outPath, html, 'utf8');
  console.log(`dashboard.html: ${outPath}`);
  console.log(`  opportunities=${reportModel && reportModel.opportunities ? reportModel.opportunities.length : 0}, pool=${signalPoolView && signalPoolView.pool ? signalPoolView.pool.length : 0}, stories=${storyView.activeCount}, history=${history.length}`);
}

module.exports = { renderDashboardHtml, historyIndex, main };

if (require.main === module) main();
