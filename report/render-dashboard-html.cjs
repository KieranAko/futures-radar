// report/render-dashboard-html.cjs — 三 Tab 看板（自包含单文件 HTML）
//
// 用法:
//   node report/render-dashboard-html.cjs --runId <runId>
//
// Tab1 机会分析看板：图形化机会卡片（价格趋势图 + 区间条 + 多空面板 + chips）。
// Tab2 信号池看板：复用 render-signal-pool-html.cjs 的卡片函数。
// Tab3 历史报告索引：分页，每页 10 份，点击打开 report.html。
//
// 纪律：确定性、不联网、不调用 LLM、无外部 CSS/JS 依赖；所有字段转义。

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { runtimeRoot, runDir } = require('../lib/workspace.cjs');
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

function readJSON(p, fallback = null) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function fmt(x, d = 1) {
  if (x === null || x === undefined || Number.isNaN(Number(x))) return '—';
  return Number(x).toFixed(d);
}

// ── 机会分析图形组件 ──────────────────────────────────────────
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

function renderPriceChart(fullBars, { signalDate = null, window = 60 } = {}) {
  if (!fullBars || fullBars.length < 2) return '<p class="muted">暂无价格序列。</p>';
  const bars = fullBars.slice(-window);
  const closes = fullBars.map((b) => b.close);
  const ma20 = sma(closes, 20).slice(-window);
  const ma60 = sma(closes, 60).slice(-window);

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
  // 网格线
  for (let i = 0; i <= 4; i++) {
    const gy = padY + (i / 4) * (H - padY * 2);
    const gv = max - (i / 4) * (max - min);
    parts.push(`<line x1="${padX}" y1="${gy}" x2="${W - padX}" y2="${gy}" stroke="#eef0f3" stroke-width="1"/>`);
    parts.push(`<text x="${padX - 6}" y="${gy + 4}" text-anchor="end" class="chart-label">${fmt(gv, 0)}</text>`);
  }
  // 蜡烛
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
    parts.push(`<rect x="${(x - bodyW / 2).toFixed(1)}" y="${bodyTop.toFixed(1)}" width="${bodyW.toFixed(1)}" height="${bodyH.toFixed(1)}" fill="${color}"><title>${escapeHtml(b.date)} O:${fmt(b.open)} H:${fmt(b.high)} L:${fmt(b.low)} C:${fmt(b.close)}</title></rect>`);
  }
  // MA 线
  const maLine = (arr, color) => {
    const pts = [];
    for (let i = 0; i < n; i++) {
      if (arr[i] != null) pts.push(`${(padX + i * step + step / 2).toFixed(1)},${y(arr[i]).toFixed(1)}`);
    }
    if (pts.length >= 2) parts.push(`<polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="1.6"/>`);
  };
  maLine(ma20, '#2563eb');
  maLine(ma60, '#d97706');
  // 信号日竖线
  if (signalDate) {
    const idx = bars.findIndex((b) => b.date === signalDate);
    if (idx >= 0) {
      const x = padX + idx * step + step / 2;
      parts.push(`<line x1="${x}" y1="${padY}" x2="${x}" y2="${H - padY}" stroke="#6b7280" stroke-dasharray="4 4" stroke-width="1"/>`);
      parts.push(`<text x="${x}" y="${H - 4}" text-anchor="middle" class="chart-label">信号 ${escapeHtml(signalDate.slice(5))}</text>`);
    }
  }
  // 日期轴
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
  const lo = Math.min(p95[0], close);
  const hi = Math.max(p95[1], close);
  if (hi === lo) return '';
  const pct = (v) => ((v - lo) / (hi - lo)) * 100;
  const p68Left = Math.min(pct(p68[0]), pct(p68[1]));
  const p68W = Math.abs(pct(p68[1]) - pct(p68[0]));
  const p95Left = Math.min(pct(p95[0]), pct(p95[1]));
  const p95W = Math.abs(pct(p95[1]) - pct(p95[0]));
  const closePct = pct(close);
  const out = [];
  out.push(`<div class="rangebar"><div class="rangebar-head"><span>${escapeHtml(period)}</span><span class="muted">p95 ${fmt(p95[0])} ~ ${fmt(p95[1])}</span></div>`);
  out.push(`<div class="range-track"><span class="range-p95" style="left:${p95Left.toFixed(1)}%;width:${p95W.toFixed(1)}%"></span><span class="range-p68" style="left:${p68Left.toFixed(1)}%;width:${p68W.toFixed(1)}%"></span><span class="range-close" style="left:${closePct.toFixed(1)}%" title="收盘 ${fmt(close)}"></span></div>`);
  out.push(`<div class="rangebar-foot"><span>${fmt(lo)}</span><span class="muted">收盘 ${fmt(close)}</span><span>${fmt(hi)}</span></div></div>`);
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

function oppNavItem(opp, active) {
  const t = opp.thesis || {};
  const dir = t.finalDirection || 'neutral';
  const dirEmoji = dir === 'bullish' ? '🔴' : dir === 'bearish' ? '🟢' : '⚪';
  const close = opp.marketFacts && opp.marketFacts.close != null ? fmt(opp.marketFacts.close) : '—';
  const conf = confidenceLabel(t.finalConfidence);
  return `<button class="opp-nav-item ${active ? 'active' : ''}" data-opp="${escapeHtml(opp.symbol)}"><span class="opp-nav-main">${dirEmoji} ${escapeHtml(opp.name || opp.symbol)}</span><span class="opp-nav-sub">${directionLabel(dir)} · ${conf}置信 · ${close}</span></button>`;
}

function oppPane(opp, raw, signalDate, active) {
  const t = opp.thesis || {};
  const driver = t.driver || {};
  const odds = t.odds || {};
  const dir = t.finalDirection || 'neutral';
  const dirEmoji = dir === 'bullish' ? '🔴' : dir === 'bearish' ? '🟢' : '⚪';
  const close = opp.marketFacts && opp.marketFacts.close != null ? fmt(opp.marketFacts.close) : '—';

  const bars = raw ? extractBars(raw, opp.symbol) : null;
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

  return `<article class="opp-pane ${active ? 'active' : ''}" data-opp="${escapeHtml(opp.symbol)}">
    <div class="opp-head"><span>${dirEmoji} ${escapeHtml(opp.name || opp.symbol)}（${escapeHtml(opp.contract || opp.symbol)}）· ${directionLabel(dir)} · 收盘 ${close}</span><span class="opp-badges">${confidenceMeter(t.finalConfidence)}${regimePill(opp.marketFacts && opp.marketFacts.volatilityRegime)}</span></div>
    ${chart}
    ${odds.reasoning ? `<p class="core-logic">${escapeHtml(odds.reasoning)}</p>` : ''}
    ${ranges ? `<div class="rangebars">${ranges}</div>` : ''}
    ${supportPanel || opposePanel ? `<div class="factors">${supportPanel}${opposePanel}</div>` : ''}
    ${chipList('✅ 确认', confirmations, 'green')}
    ${chipList('❌ 失效', invalidations, 'red')}
    ${chipList('⚠️ 风险', risks, 'gray')}
    ${detail.length ? `<details class="detail"><summary>完整六问详情</summary>${detail.join('')}</details>` : ''}
  </article>`;
}

function oppLayout(opps, raw, signalDate) {
  const nav = opps.map((o, i) => oppNavItem(o, i === 0)).join('\n');
  const panes = opps.map((o, i) => oppPane(o, raw, signalDate, i === 0)).join('\n');
  return `<div class="opp-layout"><nav class="opp-nav">${nav}</nav><div class="opp-content">${panes}</div></div>`;
}

// ── 历史报告分页 ─────────────────────────────────────────────
function historyTable(entries) {
  const rows = entries.map((h) => `<tr><td>${escapeHtml(h.runId)}</td><td>${escapeHtml(h.date)}</td><td>${escapeHtml(h.oppSymbols || '—')}</td><td><a href="${escapeHtml(h.href)}">打开 →</a></td></tr>`).join('');
  return rows;
}

function paginationControl(total, pageSize) {
  if (total <= pageSize) return '';
  const pages = Math.ceil(total / pageSize);
  let btns = '';
  for (let p = 1; p <= pages; p++) btns += `<button class="page-btn" data-page="${p}">${p}</button>`;
  return `<div class="pagination"><button class="page-btn nav" data-page="prev">◀ 上一页</button>${btns}<button class="page-btn nav" data-page="next">下一页 ▶</button><div class="page-info">共 ${total} 份 · 第 <b id="page-cur">1</b>/${pages} 页</div></div>`;
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
    const date = model && model.meta && model.meta.generatedAt ? String(model.meta.generatedAt).slice(0, 10) : name.slice(0, 8);
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
function renderDashboardHtml({ runId, reportModel, signalPoolView, history, raw, signalDate }) {
  const opps = reportModel && Array.isArray(reportModel.opportunities) ? reportModel.opportunities : [];
  const pool = signalPoolView && Array.isArray(signalPoolView.pool) ? signalPoolView.pool : [];
  const recentClosed = signalPoolView && Array.isArray(signalPoolView.recentClosed) ? signalPoolView.recentClosed : [];
  const stats = signalPoolView && signalPoolView.historyStats ? signalPoolView.historyStats : {};
  const details = signalPoolView && signalPoolView.details ? signalPoolView.details : {};

  const oppHtml = opps.length ? oppLayout(opps, raw, signalDate) : '<p class="muted">本期无机会分析。</p>';
  const poolCards = pool.map((s) => {
    const d = details[s.signalId] || {};
    return signalCard({ ...s, versions: d.versions || [] });
  }).join('\n');
  const closedCards = recentClosed.map((s) => {
    const d = details[s.signalId] || {};
    return signalCard({ ...s, versions: d.versions || [] }, { closed: true });
  }).join('\n');

  const histRows = historyTable(history);
  const pagination = paginationControl(history.length, 10);

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Futures Radar · 看板</title>
<style>
  :root { --bg:#f7f8fa; --card:#ffffff; --border:#e5e7eb; --text:#1f2328; --muted:#6b7280; --accent:#2563eb; --up:#b91c1c; --down:#047857; --radius:10px; }
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
  .summary-bar .stat { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); padding: 10px 16px; min-width: 110px; }
  .summary-bar .stat b { display: block; font-size: 20px; }
  .summary-bar .stat span { color: var(--muted); font-size: 12px; }
  section h2 { font-size: 15px; margin: 22px 0 10px; padding-left: 8px; border-left: 3px solid var(--accent); }

  /* 卡片通用 */
  .card { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); margin: 10px 0; box-shadow: 0 1px 2px rgba(0,0,0,.03); }
  .card > summary { cursor: pointer; padding: 12px 16px; font-weight: 600; list-style: none; display: flex; align-items: center; gap: 8px; }
  .card > summary::-webkit-details-marker { display: none; }
  .card > summary::before { content: "▸"; color: var(--muted); transition: transform .15s; }
  .card[open] > summary::before { transform: rotate(90deg); }
  .card-body { padding: 4px 16px 14px; border-top: 1px solid var(--border); }

  /* 机会卡片 */
  .opp-layout { display: flex; gap: 14px; align-items: flex-start; }
  .opp-nav { width: 240px; flex: 0 0 240px; display: flex; flex-direction: column; gap: 6px; position: sticky; top: 70px; }
  .opp-nav-item { text-align: left; border: 1px solid var(--border); background: var(--card); border-radius: 8px; padding: 8px 12px; cursor: pointer; display: flex; flex-direction: column; gap: 2px; }
  .opp-nav-item.active { border-color: var(--accent); background: #eef4ff; }
  .opp-nav-main { font-weight: 600; }
  .opp-nav-sub { font-size: 12px; color: var(--muted); }
  .opp-content { flex: 1; min-width: 0; }
  .opp-pane { display: none; background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px 16px; }
  .opp-pane.active { display: block; }
  .opp-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 6px; font-weight: 600; }
  .opp-badges { display: inline-flex; align-items: center; gap: 8px; }
  @media (max-width: 760px) {
    .opp-layout { flex-direction: column; }
    .opp-nav { width: 100%; flex-direction: row; flex-wrap: wrap; position: static; }
    .opp-nav-item { flex-direction: row; align-items: center; gap: 8px; }
  }
  .confidence { display: inline-flex; gap: 3px; }
  .confidence .cm { width: 14px; height: 6px; border-radius: 2px; background: #e5e7eb; }
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
  .rangebars { display: flex; flex-direction: column; gap: 8px; margin: 10px 0; }
  .rangebar { border: 1px solid var(--border); border-radius: 8px; padding: 8px 12px; background: #fcfcfd; }
  .rangebar-head, .rangebar-foot { display: flex; justify-content: space-between; font-size: 12px; color: var(--muted); margin: 3px 0; }
  .range-track { position: relative; height: 12px; background: #f1f3f5; border-radius: 6px; }
  .range-p95 { position: absolute; top: 2px; bottom: 2px; background: #dbe4f0; border-radius: 4px; }
  .range-p68 { position: absolute; top: 2px; bottom: 2px; background: #9db8e8; border-radius: 4px; }
  .range-close { position: absolute; top: -2px; bottom: -2px; width: 3px; background: #1f2328; border-radius: 2px; }
  .factors { display: flex; gap: 10px; margin: 10px 0; flex-wrap: wrap; }
  .factor-panel { flex: 1; min-width: 260px; border-radius: 8px; padding: 8px 12px; border: 1px solid var(--border); }
  .factor-panel.support { background: #f5faf6; border-left: 3px solid #047857; }
  .factor-panel.oppose { background: #fdf6f5; border-left: 3px solid #b91c1c; }
  .factor-panel h4 { margin: 2px 0 6px; font-size: 13px; }
  .factor-panel ul { margin: 0; padding-left: 16px; font-size: 13px; }
  .chip-row { display: flex; gap: 8px; margin: 8px 0; align-items: flex-start; }
  .chip-label { font-size: 12px; color: var(--muted); white-space: nowrap; padding-top: 2px; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip { font-size: 12px; padding: 2px 8px; border-radius: 6px; border: 1px solid var(--border); }
  .chip.green { background: #f0f9f2; border-color: #cdebd4; color: #047857; }
  .chip.red { background: #fdf1f0; border-color: #f5cfcc; color: #b91c1c; }
  .chip.gray { background: #f7f8fa; color: #4b5563; }
  details.detail { margin-top: 10px; border: 1px dashed var(--border); border-radius: 8px; padding: 4px 10px; }
  details.detail summary { cursor: pointer; color: var(--muted); font-size: 13px; }
  .muted { color: var(--muted); font-size: 12px; }

  /* 信号池卡片复用样式 */
  table.fields { width: 100%; border-collapse: collapse; table-layout: fixed; margin: 6px 0; }
  table.fields th { width: 88px; text-align: left; vertical-align: top; color: var(--muted); font-weight: 500; padding: 5px 10px 5px 0; white-space: nowrap; }
  table.fields td { vertical-align: top; padding: 5px 0; word-break: break-word; }
  .card h4 { margin: 12px 0 6px; font-size: 13px; color: var(--muted); }
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

  /* 历史索引分页 */
  .table-wrap { overflow-x: auto; }
  table.index { width: 100%; border-collapse: collapse; background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
  table.index th, table.index td { padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--border); }
  table.index tr:last-child th, table.index tr:last-child td { border-bottom: none; }
  table.index th { background: #f7f8fa; font-weight: 600; }
  table.index a { color: var(--accent); text-decoration: none; }
  table.index tr.hidden { display: none; }
  .pagination { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin: 12px 0; }
  .page-btn { border: 1px solid var(--border); background: var(--card); color: var(--text); padding: 4px 10px; border-radius: 6px; cursor: pointer; font-size: 13px; }
  .page-btn.active { background: var(--accent); border-color: var(--accent); color: #fff; }
  .page-btn.nav { font-size: 12px; }
  .page-info { margin-left: auto; font-size: 12px; color: var(--muted); }
  @media print { header { position: static; } .tab { display: none; } .tab-panel { display: block !important; } .pagination { display: none; } }
</style>
</head>
<body>
<header>
  <h1>Futures Radar · 看板</h1>
  <nav class="tabs">
    <button class="tab active" data-tab="opportunities">📈 机会分析</button>
    <button class="tab" data-tab="pool">📊 信号池</button>
    <button class="tab" data-tab="history">🗂 历史报告</button>
  </nav>
</header>
<main>
  <section id="tab-opportunities" class="tab-panel active">
    <div class="summary-bar">
      <div class="stat"><b>${opps.length}</b><span>本期机会</span></div>
      <div class="stat"><b>${opps.filter((o) => o.thesis && o.thesis.finalDirection === 'bullish').length}</b><span>看多</span></div>
      <div class="stat"><b>${opps.filter((o) => o.thesis && o.thesis.finalDirection === 'bearish').length}</b><span>看空</span></div>
    </div>
    <section>
      <h2>机会分析</h2>
      ${oppHtml}
    </section>
  </section>

  <section id="tab-pool" class="tab-panel">
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

  <section id="tab-history" class="tab-panel">
    <section>
      <h2>历史报告索引</h2>
      ${pagination}
      ${histRows ? `<div class="table-wrap"><table class="index"><thead><tr><th>runId</th><th>日期</th><th>机会品种</th><th></th></tr></thead><tbody id="history-rows">${histRows}</tbody></table></div>` : '<p class="muted">暂无历史报告。</p>'}
    </section>
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
  if (tbody) {
    const rows = Array.from(tbody.rows);
    const pageBtns = document.querySelectorAll('.page-btn');
    const pageCur = document.getElementById('page-cur');
    function showPage(p) {
      const pages = Math.max(1, Math.ceil(rows.length / pageSize));
      if (p < 1) p = 1;
      if (p > pages) p = pages;
      rows.forEach((tr, i) => {
        const start = (p - 1) * pageSize;
        tr.classList.toggle('hidden', i < start || i >= start + pageSize);
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
        const pages = Math.max(1, Math.ceil(rows.length / pageSize));
        let p = Number(window._page) || 1;
        if (bp === 'prev') p = p - 1;
        else if (bp === 'next') p = p + 1;
        else p = Number(bp);
        showPage(p);
      });
    });
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
  const signalDate = raw && raw.meta && raw.meta.cacheInfo ? raw.meta.cacheInfo.latestBarDate : null;
  const history = historyIndex(runId, path.join(runtimeRoot, 'runs'));
  const html = renderDashboardHtml({ runId, reportModel, signalPoolView, history, raw, signalDate });
  const outPath = path.join(runtimeRoot, 'dashboard.html');
  fs.writeFileSync(outPath, html, 'utf8');
  console.log(`dashboard.html: ${outPath}`);
  console.log(`  opportunities=${reportModel && reportModel.opportunities ? reportModel.opportunities.length : 0}, pool=${signalPoolView && signalPoolView.pool ? signalPoolView.pool.length : 0}, history=${history.length}`);
}

module.exports = { renderDashboardHtml, historyIndex, main };

if (require.main === module) main();
