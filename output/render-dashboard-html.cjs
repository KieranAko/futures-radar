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
  statsTable,
  escapeHtml,
  signalPoolPanelsHtml,
  signalClosedPanelsHtml
} = require('./render-signal-pool-html.cjs');
const { storyPoolHtml } = require('./render-story-pool-html.cjs');
const { ticketViewHtml } = require('./render-ticket-html.cjs');
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
  if (!level) return '<span class="confidence" title="置信度缺失">—</span>';
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

const AUDIT_IMPACT_LABEL = {
  none: '无修订',
  revised_driver: '修订驱动',
  revised_direction: '修订方向',
  kept_with_reasons: '维持原判',
};
const SOURCE_CLASS_LABEL = { macro: '宏观源', event: '事件源', flow: '供需源', behavior: '行为源' };

function auditBadge(opp) {
  const a = opp && opp.audit;
  if (!a) return '<span class="pill audit-unavailable">链审计 未运行</span>';
  if (a.verdict === 'aligned') return '<span class="pill audit-aligned">链审计 对齐</span>';
  return `<span class="pill audit-conflict">链审计 ${escapeHtml(String(a.conflictCount || 0))} 冲突 · ${escapeHtml(AUDIT_IMPACT_LABEL[a.impact] || a.impact || '—')}</span>`;
}

function auditPanelHtml(opp) {
  const a = opp && opp.audit;
  if (!a) {
    return `<details class="audit-panel"><summary>链审计详情（点击展开）</summary><div class="muted">本期未运行链审计，无审计详情。</div></details>`;
  }
  const dimLabel = {
    direction: '方向', driver: '驱动', mechanism: '机制',
    timing: '时滞', confidence: '置信度', evidence: '证据使用',
  };
  const conflictBlocks = (a.conflicts || []).map((c, i) => `
    <div class="audit-conflict">
      <div class="audit-conflict-head">冲突 ${i + 1} · ${escapeHtml(dimLabel[c.dimension] || c.dimension)}</div>
      <div class="audit-line"><b>链主张</b>：${escapeHtml(c.chainClaim || '—')}</div>
      <div class="audit-line"><b>六问原话</b>：${escapeHtml(c.analysisClaim || '—')}</div>
      <div class="audit-line"><b>审计追问</b>：${escapeHtml(c.question || '—')}</div>
      ${(c.factIds || []).length ? `<div class="audit-line muted"><b>事实引用</b>：${escapeHtml(c.factIds.join('、'))}</div>` : ''}
    </div>`).join('');
  const content = a.verdict === 'aligned'
    ? '<div class="muted">六问与传导链的语义主张一致，没有需要追问的冲突。</div>'
    : `${conflictBlocks}
      <div class="audit-response"><b>六问最终综合</b>：${escapeHtml(AUDIT_IMPACT_LABEL[a.impact] || a.impact || '—')}${a.response ? ` — ${escapeHtml(a.response)}` : ''}</div>`;
  return `<details class="audit-panel"><summary>链审计详情（点击展开）· ${escapeHtml(AUDIT_IMPACT_LABEL[a.impact] || (a.verdict === 'aligned' ? '对齐' : '—'))}</summary>${content}</details>`;
}

function nodeProgressShort(n) {
  if (!n) return '—';
  if (n.status === 'confirmed') return '已证明';
  if (n.status === 'broken') return '已证伪';
  if (n.sameStreak > 0) return `同向 ${n.sameStreak}/3`;
  if (n.oppStreak > 0) return `反向 ${n.oppStreak}/2`;
  return '观察中';
}

function chainEvidenceHtml(story, opp) {
  if (!story) return '';
  const source = story.nodes && story.nodes[0];
  const terminal = story.nodes && story.nodes[story.nodes.length - 1];
  const rows = [
    ['链', `${story.chainId} · ${SOURCE_CLASS_LABEL[story.sourceClass] || story.sourceClass || '—'} · ${story.status || '—'}${story.provisional ? ' · provisional' : ''}`],
    ['源节点', `${(source && source.label) || '—'}：${nodeProgressShort(source)}`],
    ['终点节点', `${(terminal && terminal.label) || '—'}：${nodeProgressShort(terminal)}（预期 ${terminal && terminal.expectation === 1 ? '↑' : terminal && terminal.expectation === -1 ? '↓' : '—'}）`],
    ['六问审计', auditBadge(opp)],
  ];
  return `<div class="story-evidence"><h4>传导链证据对照</h4><table class="fields">${rows.map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${v}</td></tr>`).join('')}</table><div class="muted">链是证据，不是结论；最终判断由六问综合、信号池验证与人类分析师完成。</div></div>`;
}

function statCard(icon, label, value, tone = 'blue', delta = null) {
  const d = delta === null || delta === undefined ? '' : `<em class="stat-delta ${delta > 0 ? 'up' : delta < 0 ? 'down' : ''}">${delta > 0 ? '+' : ''}${delta}</em>`;
  return `<div class="stat"><span class="stat-icon ${tone}">${icon}</span><div class="stat-meta"><b>${value}</b><span>${label}${d}</span></div></div>`;
}

function kpiSnapshotDir() { return path.join(skillRoot, 'data', 'dashboard-kpi'); }
function kpiSnapshotPath(date) { return path.join(kpiSnapshotDir(), `${date}.json`); }
function loadKpiSnapshot(date) {
  if (!date) return null;
  return readJSON(kpiSnapshotPath(date), null);
}
function previousKpiSnapshot(date) {
  const dir = kpiSnapshotDir();
  if (!date || !fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  for (let i = files.length - 1; i >= 0; i--) {
    const d = files[i].replace(/\.json$/, '');
    if (d < date) return readJSON(path.join(dir, files[i]), null);
  }
  return null;
}
function writeKpiSnapshot(date, snapshot) {
  if (!date) return;
  fs.mkdirSync(kpiSnapshotDir(), { recursive: true });
  fs.writeFileSync(kpiSnapshotPath(date), JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
}
function deltaOf(cur, prev, key) {
  const c = cur == null ? 0 : Number(cur) || 0;
  const p = prev == null ? null : Number(prev);
  if (p == null || !Number.isFinite(p)) return null;
  return Math.round((c - p) * 100) / 100;
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
  // 优先本 run 冻结的最新序列（main-series → raw），contract-bars 只作为最后回退；
  // 修复：旧实现优先 contract-bars，导致本期图表停在历史 library 的最后日期。
  const ms = mainSeries && mainSeries[symbol];
  if (ms && Array.isArray(ms.bars) && ms.bars.length >= 2) return ms.bars;
  const rawBars = extractBars(raw, symbol);
  if (rawBars && rawBars.length >= 2) return rawBars;
  return loadContractBarsLibrary(contract);
}

function contractMapFromBarsLibrary() {
  const map = {};
  const dir = path.join(skillRoot, 'data', 'contract-bars');
  if (!fs.existsSync(dir)) return map;
  for (const name of fs.readdirSync(dir)) {
    const m = /^([A-Za-z]+)\d+\.json$/.exec(name);
    if (!m) continue;
    const prefix = m[1].toUpperCase();
    const code = name.replace(/\.json$/, '');
    if (!map[prefix] || code > map[prefix]) map[prefix] = code;
  }
  return map;
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
    parts.push(`<rect x="${(x - bodyW / 2).toFixed(1)}" y="${bodyTop.toFixed(1)}" width="${bodyW.toFixed(1)}" height="${bodyH.toFixed(1)}" fill="${color}"/>`);
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
  const signalIdx = signalDate ? bars.findIndex((b) => b.date === signalDate) : -1;
  const labelIdxs = new Set([0, n - 1]);
  if (n > 6) {
    labelIdxs.add(Math.floor((n - 1) * 0.25));
    labelIdxs.add(Math.floor((n - 1) * 0.5));
    labelIdxs.add(Math.floor((n - 1) * 0.75));
  } else if (n > 2) {
    labelIdxs.add(Math.floor((n - 1) / 2));
  }
  if (signalIdx >= 0) labelIdxs.add(signalIdx);
  const xDate = (idx, anchor, highlight = false) => parts.push(`<text x="${padX + idx * step + step / 2}" y="${H - 4}" text-anchor="${anchor}" class="chart-label"${highlight ? ' fill="#2563eb" font-weight="700" style="paint-order:stroke;stroke:#ffffff;stroke-width:3px;"' : ''}>${escapeHtml(bars[idx].date.slice(5))}</text>`);
  for (const idx of [...labelIdxs].sort((a, b) => a - b)) xDate(idx, 'middle', idx === signalIdx);
  parts.push(`<line class="chart-crosshair" x1="${(padX + (n - 1) * step + step / 2).toFixed(1)}" y1="${padY}" x2="${(padX + (n - 1) * step + step / 2).toFixed(1)}" y2="${(H - padY).toFixed(1)}" stroke="#1f2328" stroke-width="1" stroke-dasharray="3 3" opacity="0.7"/>`);
  parts.push('</svg>');
  parts.push('<div class="legend"><span class="legend-item"><i style="background:#b91c1c"></i>涨</span><span class="legend-item"><i style="background:#047857"></i>跌</span><span class="legend-item"><i style="background:#2563eb"></i>MA20</span><span class="legend-item"><i style="background:#d97706"></i>MA60</span></div>');

  const lastB = bars[n - 1];
  const lastPrev = n > 1 ? bars[n - 2].close : null;
  const lastChg = lastPrev != null ? lastB.close - lastPrev : null;
  const lastChgPct = lastPrev != null && Number(lastPrev) !== 0 ? (lastB.close / lastPrev - 1) * 100 : null;
  const lastChg5 = chg5[n - 1];
  const infoColor = lastChg == null || lastChg >= 0 ? '#b91c1c' : '#047857';
  const lb = (name) => `<b style="color:#1f2328;font-weight:700">${name}</b>`;
  const cell = (label, valueHtml) => `<span>${lb(label)}<span>${valueHtml}</span></span>`;
  const chgSpan = lastChg != null ? cell('涨跌', `<b style="color:${infoColor}">${lastChg >= 0 ? '+' : ''}${fmt(lastChg, 2)}</b>`) : cell('涨跌', '—');
  const chgPctSpan = lastChgPct != null ? cell('涨幅', `<b style="color:${infoColor}">${lastChgPct >= 0 ? '+' : ''}${lastChgPct.toFixed(2)}%</b>`) : cell('涨幅', '—');
  const chg5Span = lastChg5 != null ? cell('5日涨跌', `<b style="color:${lastChg5 >= 0 ? '#b91c1c' : '#047857'}">${lastChg5 >= 0 ? '+' : ''}${lastChg5.toFixed(2)}%</b>`) : cell('5日涨跌', '—');
  const infoHtml = `<span><b style="color:#1f2328;font-weight:700">${escapeHtml(lastB.date)}</b></span>${cell('开盘', fmt(lastB.open, 2))}${cell('最高', fmt(lastB.high, 2))}${cell('最低', fmt(lastB.low, 2))}${cell('收盘', `<b style="color:${infoColor}">${fmt(lastB.close, 2)}</b>`)}${chgSpan}${chgPctSpan}${chg5Span}${cell('MA20', `<b style="color:#2563eb">${ma20[n - 1] != null ? fmt(ma20[n - 1], 2) : '—'}</b>`)}${cell('MA60', `<b style="color:#d97706">${ma60[n - 1] != null ? fmt(ma60[n - 1], 2) : '—'}</b>`)}`;
  const barsAttr = JSON.stringify(bars.map((b) => ({ d: b.date, o: b.open, h: b.high, l: b.low, c: b.close }))).replace(/'/g, '&#39;');
  const ma20Attr = JSON.stringify(ma20);
  const ma60Attr = JSON.stringify(ma60);
  const chg5Attr = JSON.stringify(chg5);
  const prevBeforeFirst = fullBars.length > window ? fullBars[fullBars.length - window - 1].close : null;
  return `<div class="price-chart-wrap" data-bars='${barsAttr}' data-prev='${prevBeforeFirst != null ? prevBeforeFirst : ''}' data-chg5='${chg5Attr}' data-ma20='${ma20Attr}' data-ma60='${ma60Attr}' data-pad='${padX},${padX},${padY},${padY}'><div class="chart-day-info">${infoHtml}</div>${parts.join('')}</div>`;
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

// ── 交易策略卡 ────────────────────────────────────────────────
function strategyStatusClass(state) {
  if (state === 'armed') return 'st-executable';
  if (state === 'watching') return 'st-watch';
  return 'st-skip';
}

function ticketStrategyCard(plan) {
  const t = plan.ticket || {};
  const state = planStateOf(plan);
  const cls = strategyStatusClass(state);
  const conf = plan.strategyConfidence ? confidenceLabel(plan.strategyConfidence) : (plan.reportBaseline && plan.reportBaseline.confidence ? confidenceLabel(plan.reportBaseline.confidence) : '—');
  const reasons = Array.isArray(plan.stateReasons) && plan.stateReasons.length ? plan.stateReasons.join('；') : '';
  const view = ticketViewHtml({
    direction: plan.reportBaseline && plan.reportBaseline.direction,
    contract: plan.contract,
    state: '',
    activation: t.activation,
    activationLevel: t.activationLevel,
    confirmation: t.confirmation,
    entry: t.entry,
    abandon: t.abandon,
    stopPrice: plan.stop && plan.stop.stopPrice,
    stopBasis: plan.stop && plan.stop.basis,
    t1: plan.targets && plan.targets.t1,
    t2: plan.targets && plan.targets.t2,
    targetsBasis: plan.targets && plan.targets.basis,
    maxHold: t.maxHold || (plan.invalidation && plan.invalidation.timeStop),
    invalidation: Array.isArray(t.invalidation) && t.invalidation.length ? t.invalidation : (plan.invalidation && plan.invalidation.hard) || []
  });
  return `<div class="strategy-card ticket-card ${cls}">
    <div class="strategy-head"><span class="strategy-title">📌 交易单</span><span class="strategy-badges">${statusBadge(state)} · ${conf}置信</span></div>
    ${view}
    ${reasons ? `<div class="strategy-risk">${escapeHtml(reasons)}</div>` : ''}
  </div>`;
}

function strategyCard(plan) {
  if (!plan) return '';
  if (plan.ticket) return ticketStrategyCard(plan);
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
function oppNavItem(opp, raw, mainSeries, active, contractOverride = null) {
  const t = opp.thesis || {};
  // REND-03：缺失 finalDirection 显示 '—'，不用 neutral 顶替 LLM 判断。
  const dir = t.finalDirection || '';
  const close = opp.marketFacts && opp.marketFacts.close != null ? fmt(opp.marketFacts.close) : '—';
  const conf = confidenceLabel(t.finalConfidence);
  const resolvedContract = contractOverride || opp.contract;
  const bars = seriesBars(mainSeries, raw, opp.symbol, resolvedContract);
  const chg = change5dPct(bars);
  const chgHtml = chg == null ? '' : ` · <span class="${chg >= 0 ? 'up' : 'down'}">${chg >= 0 ? '+' : ''}${chg.toFixed(1)}%</span>`;
  return `<button class="opp-nav-item ${active ? 'active' : ''}" data-opp="${escapeHtml(opp.symbol)}"><span class="nav-dot ${escapeHtml(dir)}"></span><span class="nav-text"><span class="nav-main"><b>${escapeHtml(opp.name || opp.symbol)}</b><span class="nav-badge ${escapeHtml(dir)}">${directionLabel(dir)}</span></span><span class="nav-sub">${conf}置信 · ${close}${chgHtml}</span></span></button>`;
}

function oppPane(opp, raw, mainSeries, signalDate, active, plan, storyMap = {}, contractOverride = null) {
  const t = opp.thesis || {};
  const driver = t.driver || {};
  const odds = t.odds || {};
  const dir = t.finalDirection || '';
  const close = opp.marketFacts && opp.marketFacts.close != null ? fmt(opp.marketFacts.close) : '—';
  const resolvedContract = contractOverride || opp.contract;

  const bars = seriesBars(mainSeries, raw, opp.symbol, resolvedContract);
  const chart = renderPriceChart(bars, { signalDate });

  const ranges = (opp.priceRanges || []).map((r) => rangeBar(r.period, r.hvCone && r.hvCone.p68, r.hvCone && r.hvCone.p95, opp.marketFacts && opp.marketFacts.close)).join('');

  const cr = t.confidenceRationale || {};
  const supportPanel = factorPanel('support', cr.supportingFactors);
  const opposePanel = factorPanel('oppose', cr.opposingFactors);

  const detail = [];
  if (driver.primary || driver.secondary) {
    detail.push(`<div class="q-item"><h4>Q1 驱动</h4><div>${escapeHtml(driver.primary || '')}${driver.secondary ? `<br><span class="muted">${escapeHtml(driver.secondary)}</span>` : ''}${driver.evidence ? `<br><span class="muted">证据：${escapeHtml(driver.evidence)}</span>` : ''}${driver.source ? `<br><span class="muted">来源：${escapeHtml(driver.source)}</span>` : ''}</div></div>`);
  }
  if (t.trendOrImpulse && t.trendOrImpulse.assessment) detail.push(`<div class="q-item"><h4>Q2 趋势/脉冲</h4><div>${escapeHtml(t.trendOrImpulse.assessment)}</div></div>`);
  if (odds.bias || odds.reasoning) detail.push(`<div class="q-item"><h4>Q3 赔率</h4><div>${escapeHtml(odds.bias || '')} · ${escapeHtml(odds.reasoning || '')}</div></div>`);
  if (cr.uncertainties && cr.uncertainties.length) detail.push(`<div class="q-item"><h4>不确定项</h4><ul>${cr.uncertainties.map((u) => `<li>${escapeHtml(u)}</li>`).join('')}</ul></div>`);

  const story = opp.storyChainId ? (storyMap[opp.storyChainId] || null) : null;
  return `<article class="opp-pane ${active ? 'active' : ''} dir-${escapeHtml(dir)}" data-opp="${escapeHtml(opp.symbol)}">
    <div class="instr-head">
      <div class="instr-title">
        <div class="instr-name">${escapeHtml(opp.name || opp.symbol)} <span class="muted">（${escapeHtml(resolvedContract || opp.symbol)}）</span></div>
        <div class="instr-sub">${directionLabel(dir)} · ${confidenceLabel(t.finalConfidence)}置信 · 收盘 ${close}</div>
        ${story ? `<button type="button" class="story-jump" data-story-jump="${escapeHtml(story.chainId)}">🔗 故事：${escapeHtml(story.theme || '')}</button>` : ''}
      </div>
      <div class="instr-badges">${confidenceMeter(t.finalConfidence)}${regimePill(opp.marketFacts && opp.marketFacts.volatilityRegime)}${auditBadge(opp)}</div>
    </div>
    ${chart}
    ${odds.reasoning ? `<p class="core-logic">${escapeHtml(odds.reasoning)}</p>` : ''}
    <div class="opp-grid">
      <div class="opp-grid-main">
        ${ranges ? `<div class="rangebars">${ranges}</div><div class="range-legend"><span>概率区间 · 未来价格可能波动的范围（EWMA 条件波动率）</span><span class="muted">深蓝 = 68% 大概率区间 · 浅蓝 = 95% 较宽区间 · 竖线 = 现价</span></div>` : ''}
      </div>
      <div class="opp-grid-side">${supportPanel || opposePanel ? `<div class="factors">${supportPanel}${opposePanel}</div>` : ''}</div>
    </div>
    ${strategyCard(plan)}
    ${chainEvidenceHtml(story, opp)}
    ${auditPanelHtml(opp)}
    ${detail.length ? `<details class="detail"><summary>完整六问详情</summary>${detail.join('')}</details>` : ''}
  </article>`;
}

function oppLayout(opps, raw, mainSeries, signalDate, planMap, storyMap = {}, contractMap = {}) {
  const nav = opps.map((o, i) => oppNavItem(o, raw, mainSeries, i === 0, contractMap[o.symbol] || null)).join('\n');
  const panes = opps.map((o, i) => oppPane(o, raw, mainSeries, signalDate, i === 0, planMap ? planMap[o.symbol] : null, storyMap, contractMap[o.symbol] || null)).join('\n');
  return `<div class="opp-layout"><nav class="opp-nav">${nav}</nav><div class="opp-content">${panes}</div></div>`;
}

// ── 历史报告分页 ─────────────────────────────────────────────
function historyTable(entries) {
  const rows = entries.map((h, i) => `<tr class="${i === 0 ? 'current' : ''}"><td>${escapeHtml(h.runId)}${i === 0 ? ' <span class="badge-current">当前</span>' : ''}</td><td>${escapeHtml(h.date)}</td><td>${escapeHtml(h.oppSymbols || '—')}</td><td class="row-action"><a href="${escapeHtml(h.href)}">打开 →</a></td></tr>`).join('');
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

function signalChartHoverScript() {
  return `<script>
(function () {
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function nf(v) { return v == null || isNaN(Number(v)) ? '—' : Number(v).toFixed(2); }
  function nf2(v) { return v == null || isNaN(Number(v)) ? '—' : Number(v).toFixed(2); }
  document.querySelectorAll('.lifecycle, .price-chart-wrap').forEach(function (lc) {
    var tip = lc.querySelector('.chart-hover-tip');
    var svg = lc.querySelector('svg.lifecycle-chart, svg.price-chart');
    var cross = lc.querySelector('.chart-crosshair');
    var info = lc.querySelector('.chart-day-info');
    var bars = [];
    try { bars = JSON.parse(lc.getAttribute('data-bars') || '[]'); } catch (e) { bars = []; }
    var pads = (lc.getAttribute('data-pad') || '46,64,20,26').split(',').map(Number);
    var padL = pads[0] || 46, padR = pads[1] || 64, padT = pads[2] || 20, padB = pads[3] || 26;
    function smaArr(values, period) {
      var out = new Array(values.length).fill(null);
      var sum = 0;
      for (var i = 0; i < values.length; i++) {
        sum += values[i];
        if (i >= period) sum -= values[i - period];
        if (i >= period - 1) out[i] = sum / period;
      }
      return out;
    }
    var closes = bars.map(function (b) { return b.c; });
    var ma20 = smaArr(closes, 20);
    var ma60 = smaArr(closes, 60);
    var chg5 = closes.map(function (c, i) { return i >= 5 && closes[i - 5] ? (c / closes[i - 5] - 1) * 100 : null; });
    var prevBefore = null;
    try {
      if (lc.hasAttribute('data-prev') && lc.getAttribute('data-prev') !== '') prevBefore = Number(lc.getAttribute('data-prev'));
      if (lc.hasAttribute('data-chg5')) chg5 = JSON.parse(lc.getAttribute('data-chg5') || '[]');
      if (lc.hasAttribute('data-ma20')) ma20 = JSON.parse(lc.getAttribute('data-ma20') || '[]');
      if (lc.hasAttribute('data-ma60')) ma60 = JSON.parse(lc.getAttribute('data-ma60') || '[]');
    } catch (e) {}
    var isLifecycle = lc.classList.contains('lifecycle');
    function dayHtml(i) {
      var b = bars[i];
      if (!b) return '';
      var prev = i > 0 ? bars[i - 1].c : prevBefore;
      var chg = prev != null ? b.c - prev : null;
      var chgPct = prev != null && Number(prev) !== 0 ? (b.c / prev - 1) * 100 : null;
      var color = chg == null || chg >= 0 ? '#b91c1c' : '#047857';
      var c5 = chg5[i];
      var c5Color = c5 == null || c5 >= 0 ? '#b91c1c' : '#047857';
      var html;
      if (isLifecycle) {
        var sigCell = function (label, valueHtml) { return '<span><b style="color:#1f2328;font-weight:700">' + label + '</b><span>' + valueHtml + '</span></span>'; };
        html = '<span><b style="color:#1f2328;font-weight:700">' + esc(b.d) + '</b></span>'
          + sigCell('开盘', nf(b.o))
          + sigCell('最高', nf(b.h))
          + sigCell('最低', nf(b.l))
          + sigCell('收盘', '<b style="color:' + color + '">' + nf(b.c) + '</b>')
          + sigCell('涨跌', chg != null ? '<b style="color:' + color + '">' + (chg >= 0 ? '+' : '') + nf2(chg) + '</b>' : '—')
          + sigCell('涨幅', chgPct != null ? '<b style="color:' + color + '">' + (chgPct >= 0 ? '+' : '') + chgPct.toFixed(2) + '%</b>' : '—')
          + sigCell('5日涨跌', c5 != null ? '<b style="color:' + c5Color + '">' + (c5 >= 0 ? '+' : '') + c5.toFixed(2) + '%</b>' : '—');
      } else {
        var cell = function (label, valueHtml) { return '<span><b style="color:#1f2328;font-weight:700">' + label + '</b><span>' + valueHtml + '</span></span>'; };
        html = '<span><b style="color:#1f2328;font-weight:700">' + esc(b.d) + '</b></span>'
          + cell('开盘', nf(b.o))
          + cell('最高', nf(b.h))
          + cell('最低', nf(b.l))
          + cell('收盘', '<b style="color:' + color + '">' + nf(b.c) + '</b>')
          + cell('涨跌', chg != null ? '<b style="color:' + color + '">' + (chg >= 0 ? '+' : '') + nf2(chg) + '</b>' : '—')
          + cell('涨幅', chgPct != null ? '<b style="color:' + color + '">' + (chgPct >= 0 ? '+' : '') + chgPct.toFixed(2) + '%</b>' : '—')
          + cell('5日涨跌', c5 != null ? '<b style="color:' + c5Color + '">' + (c5 >= 0 ? '+' : '') + c5.toFixed(2) + '%</b>' : '—')
          + cell('MA20', '<b style="color:#2563eb">' + (ma20[i] != null ? nf(ma20[i]) : '—') + '</b>')
          + cell('MA60', '<b style="color:#d97706">' + (ma60[i] != null ? nf(ma60[i]) : '—') + '</b>');
      }
      return html;
    }
    function nearestIndex(ev) {
      if (!svg || !bars.length) return -1;
      var rect = svg.getBoundingClientRect();
      var vb = svg.viewBox && svg.viewBox.baseVal ? svg.viewBox.baseVal : { width: 960, height: 360 };
      var W = vb.width || 960;
      var n = bars.length;
      var step = (W - padL - padR) / n;
      var vx = (ev.clientX - rect.left) / rect.width * W;
      var i = Math.round((vx - padL - step / 2) / step);
      return Math.max(0, Math.min(n - 1, i));
    }
    function showDay(ev) {
      var i = nearestIndex(ev);
      if (i < 0 || !cross || !info) return;
      var rect = svg.getBoundingClientRect();
      var vb = svg.viewBox && svg.viewBox.baseVal ? svg.viewBox.baseVal : { width: 960, height: 360 };
      var W = vb.width || 960, H = vb.height || 360;
      var n = bars.length;
      var step = (W - padL - padR) / n;
      var cx = padL + i * step + step / 2;
      cross.setAttribute('x1', cx.toFixed(1));
      cross.setAttribute('x2', cx.toFixed(1));
      cross.setAttribute('y1', padT);
      cross.setAttribute('y2', (H - padB).toFixed(1));
      cross.style.display = 'block';
      info.innerHTML = dayHtml(i);
    }
    if (svg && cross && info && bars.length) {
      svg.addEventListener('mousemove', showDay);
      svg.addEventListener('mouseleave', function () {
        if (cross) cross.style.display = 'none';
        if (info && bars.length) info.innerHTML = dayHtml(bars.length - 1);
      });
    }
    if (!tip) return;
    function moveTip(ev) {
      var r = lc.getBoundingClientRect();
      var x = ev.clientX - r.left;
      var y = ev.clientY - r.top;
      var w = tip.offsetWidth || 160;
      tip.style.left = Math.min(Math.max(6, x + 12), Math.max(6, r.width - w - 6)) + 'px';
      tip.style.top = Math.max(6, y - 10) + 'px';
    }
    lc.querySelectorAll('.zp-zone').forEach(function (el) {
      el.addEventListener('mouseenter', function (ev) {
        el.classList.add('hover');
        tip.textContent = el.getAttribute('data-label') || '';
        tip.style.display = 'block';
        moveTip(ev);
      });
      el.addEventListener('mousemove', moveTip);
      el.addEventListener('mouseleave', function () {
        el.classList.remove('hover');
        tip.style.display = 'none';
      });
    });
  });
})();
</script>`;
}

function renderDashboardHtml({ runId, reportModel, signalPoolView, storyView = null, history, raw, mainSeries, signalDate, strategyPlan, costAnchorAvailable = false }) {
  const opps = reportModel && Array.isArray(reportModel.opportunities) ? reportModel.opportunities : [];
  const pool = signalPoolView && Array.isArray(signalPoolView.pool) ? signalPoolView.pool : [];
  const stats = signalPoolView && signalPoolView.historyStats ? signalPoolView.historyStats : {};

  const planMap = new Map((strategyPlan && Array.isArray(strategyPlan.plans) ? strategyPlan.plans : []).map((p) => [p.symbol, p]));
  const storyMap = {};
  const storyThemeMap = {};
  for (const c of [...((storyView && storyView.active) || []), ...((storyView && storyView.recentClosed) || [])]) {
    if (c && c.chainId) {
      storyMap[c.chainId] = c;
      storyThemeMap[c.chainId] = c.theme || c.sourceId || '';
    }
  }
  const contractLibrary = contractMapFromBarsLibrary();
  const contractMap = {};
  for (const o of opps) {
    if (o && o.contract) contractMap[o.symbol] = o.contract;
  }
  for (const p of planMap.values()) {
    if (p && p.contract) contractMap[p.symbol] = p.contract;
  }
  const contractOf = (symbol) => {
    const explicit = contractMap[symbol] || null;
    if (explicit && fs.existsSync(path.join(skillRoot, 'data', 'contract-bars', `${explicit}.json`))) return explicit;
    const prefix = String(symbol || '').replace(/\d+$/, '').toUpperCase();
    if (contractLibrary[prefix]) return contractLibrary[prefix];
    return explicit;
  };
  const downgradedCount = pool.filter((s) => s.poolStatus === 'downgraded').length;
  const activeCount = pool.length - downgradedCount;
  const storyStats = (storyView && storyView.stats) || {};
  const kpiCurrent = {
    signalDate: signalDate || null,
    stories: {
      totalChains: storyStats.totalChains || 0,
      resolvingChains: storyStats.resolvingChains || 0,
      provenChains: storyStats.provenChains || 0,
      falsifiedChains: storyStats.falsifiedChains || 0,
      nodeHitRate: storyStats.nodeHitRate != null ? Math.round(storyStats.nodeHitRate * 100) : null,
    },
    opportunities: {
      total: opps.length,
      bullish: opps.filter((o) => o.thesis && o.thesis.finalDirection === 'bullish').length,
      bearish: opps.filter((o) => o.thesis && o.thesis.finalDirection === 'bearish').length,
      signalPoolCount: pool.length,
    },
    signals: {
      pool: pool.length,
      active: activeCount,
      downgraded: downgradedCount,
      totalClosed: stats.totalClosed == null ? 0 : stats.totalClosed,
    },
  };
  const kpiPrev = previousKpiSnapshot(signalDate);
  const kpiDeltas = {
    stories: kpiPrev ? {
      totalChains: deltaOf(kpiCurrent.stories.totalChains, kpiPrev.stories && kpiPrev.stories.totalChains),
      resolvingChains: deltaOf(kpiCurrent.stories.resolvingChains, kpiPrev.stories && kpiPrev.stories.resolvingChains),
      provenChains: deltaOf(kpiCurrent.stories.provenChains, kpiPrev.stories && kpiPrev.stories.provenChains),
      falsifiedChains: deltaOf(kpiCurrent.stories.falsifiedChains, kpiPrev.stories && kpiPrev.stories.falsifiedChains),
      nodeHitRate: deltaOf(kpiCurrent.stories.nodeHitRate, kpiPrev.stories && kpiPrev.stories.nodeHitRate),
    } : null,
    opportunities: kpiPrev ? {
      total: deltaOf(kpiCurrent.opportunities.total, kpiPrev.opportunities && kpiPrev.opportunities.total),
      bullish: deltaOf(kpiCurrent.opportunities.bullish, kpiPrev.opportunities && kpiPrev.opportunities.bullish),
      bearish: deltaOf(kpiCurrent.opportunities.bearish, kpiPrev.opportunities && kpiPrev.opportunities.bearish),
      signalPoolCount: deltaOf(kpiCurrent.opportunities.signalPoolCount, kpiPrev.opportunities && kpiPrev.opportunities.signalPoolCount),
    } : null,
    signals: kpiPrev ? {
      pool: deltaOf(kpiCurrent.signals.pool, kpiPrev.signals && kpiPrev.signals.pool),
      active: deltaOf(kpiCurrent.signals.active, kpiPrev.signals && kpiPrev.signals.active),
      downgraded: deltaOf(kpiCurrent.signals.downgraded, kpiPrev.signals && kpiPrev.signals.downgraded),
      totalClosed: deltaOf(kpiCurrent.signals.totalClosed, kpiPrev.signals && kpiPrev.signals.totalClosed),
    } : null,
  };
  if (signalDate) writeKpiSnapshot(signalDate, kpiCurrent);

  const signalContractMap = {};
  for (const s of [...pool, ...(signalPoolView && Array.isArray(signalPoolView.recentClosed) ? signalPoolView.recentClosed : [])]) {
    if (s && s.symbol) signalContractMap[s.symbol] = contractOf(s.symbol);
  }
  const oppContractMap = {};
  for (const o of opps) if (o && o.symbol) oppContractMap[o.symbol] = contractOf(o.symbol);

  const oppHtml = opps.length ? oppLayout(opps, raw, mainSeries, signalDate, Object.fromEntries(planMap), storyMap, oppContractMap) : storyWatchHtml(storyView);
  const barsOf = (s) => seriesBars(mainSeries, raw, s.symbol, contractOf(s.symbol));
  const poolPanels = signalPoolPanelsHtml(signalPoolView || {}, { storyThemes: storyThemeMap, contracts: signalContractMap, barsOf });
  const sigClosedPanels = signalClosedPanelsHtml(signalPoolView || {}, { storyThemes: storyThemeMap, contracts: signalContractMap, barsOf });

  const histRows = historyTable(history);
  const pagination = paginationControl(history.length, 10);
  const storyHtml = storyPoolHtml(storyView || { stats: {}, active: [], recentClosed: [] }, kpiDeltas.stories);

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Futures Radar · 看板</title>
<style>
  :root { --bg:#f5f6f8; --card:#ffffff; --border:#e5e7eb; --text:#1f2328; --muted:#6b7280; --accent:#2563eb; --up:#b91c1c; --down:#047857; --radius:8px; --header-bg:#fafafa; --row-hover:#f5f7fa; --zebra:#fafafa; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 13px/1.7 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }

  /* App shell */
  header { background: var(--card); border-bottom: 1px solid var(--border); }
  .header-inner { max-width: 1480px; margin: 0 auto; padding: 0 22px; display: flex; align-items: center; gap: 20px; height: 56px; }
  .brand { font-size: 15px; font-weight: 700; white-space: nowrap; }
  .tabs { display: flex; gap: 4px; flex: 1; }
  .tab { border: none; background: transparent; color: var(--muted); padding: 8px 14px; border-radius: 8px; cursor: pointer; font-size: 14px; }
  .tab.active { background: #eef4ff; color: var(--accent); font-weight: 600; }
  .run-meta { font-size: 12px; color: var(--muted); white-space: nowrap; }

  main { max-width: 1480px; margin: 0 auto; padding: 18px 22px 48px; }
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
  .summary-bar { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin: 4px 0 18px; }
  .stat { display: flex; align-items: center; gap: 12px; background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px 16px; min-width: 0; }
  .stat-icon { width: 34px; height: 34px; border-radius: 8px; display: inline-flex; align-items: center; justify-content: center; font-size: 16px; }
  .stat-icon.blue { background: #eef4ff; }
  .stat-icon.green { background: #e7f6ec; }
  .stat-icon.red { background: #fdeaea; }
  .stat-icon.gray { background: #f1f3f5; }
  .stat-meta b { display: block; font-size: 19px; line-height: 1.3; font-variant-numeric: tabular-nums; }
  .stat-meta span { font-size: 12px; color: var(--muted); white-space: nowrap; }
  .stat-delta { display: inline-block; margin-left: 6px; font-style: normal; font-size: 11px; color: var(--muted); }
  .stat-delta.up { color: var(--up); }
  .stat-delta.down { color: var(--down); }

  section h2 { font-size: 15px; margin: 20px 0 10px; padding: 8px 12px; border: 1px solid var(--border); border-left: 3px solid var(--accent); background: var(--card); border-radius: 6px; box-shadow: 0 1px 2px rgba(0,0,0,.03); }

  /* 卡片通用 */
  .card { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); margin: 10px 0; box-shadow: 0 1px 2px rgba(0,0,0,.03); }
  .card > summary { cursor: pointer; padding: 12px 16px; font-weight: 600; list-style: none; display: flex; align-items: center; gap: 8px; }
  .card.closed { border-left: 3px solid #94a3b8; }
  .card.closed > summary { color: var(--muted); }
  .card > summary::-webkit-details-marker { display: none; }
  .card > summary::before { content: "▸"; color: var(--muted); transition: transform .15s; }
  .card[open] > summary::before { transform: rotate(90deg); }
  .card-body { padding: 12px 16px 16px; border-top: 1px solid var(--border); }

  /* 机会分析：主从布局（与信号池/故事池保持左右对称：主内容左、侧栏右） */
  .opp-layout { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 20px; align-items: start; }
  .opp-nav { order: 2; display: flex; flex-direction: column; gap: 6px; position: sticky; top: 70px; }
  .opp-content { order: 1; min-width: 0; }
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
  .opp-pane { display: none; background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); padding: 18px 20px; }
  .opp-pane.active { display: block; }
  .opp-pane.dir-bullish { border-left: 3px solid var(--up); }
  .opp-pane.dir-bearish { border-left: 3px solid var(--down); }
  .opp-pane.dir-neutral { border-left: 3px solid #9ca3af; }

  .instr-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 14px; flex-wrap: wrap; margin-bottom: 12px; }
  .instr-name { font-size: 17px; font-weight: 700; }
  .instr-sub { font-size: 12px; color: var(--muted); margin-top: 4px; }
  .story-jump { font-size: 12px; margin-top: 4px; padding: 2px 8px; border: 1px solid #dbeafe; border-radius: 6px; background: #eef4ff; color: #2563eb; cursor: pointer; font-family: inherit; }
  .story-jump:hover { background: #dbeafe; }
  .story-flash { animation: story-flash 1.8s linear; }
  @keyframes story-flash {
    0% { box-shadow: 0 0 0 4px rgba(37,99,235,.65); background: #eef4ff; }
    12%, 24% { box-shadow: 0 0 0 0 rgba(37,99,235,0); }
    36% { box-shadow: 0 0 0 4px rgba(37,99,235,.65); background: #eef4ff; }
    48%, 60% { box-shadow: 0 0 0 0 rgba(37,99,235,0); }
    72% { box-shadow: 0 0 0 4px rgba(37,99,235,.65); background: #eef4ff; }
    84%, 100% { box-shadow: 0 0 0 0 rgba(37,99,235,0); }
  }
  .instr-badges { display: inline-flex; align-items: center; gap: 10px; }
  .confidence { display: inline-flex; gap: 3px; }
  .confidence .cm { width: 16px; height: 7px; border-radius: 3px; background: #e5e7eb; }
  .confidence .cm.on { background: var(--accent); }
  .pill { font-size: 12px; padding: 2px 8px; border-radius: 999px; font-weight: 600; }
  .pill.normal { background: #e7f6ec; color: #047857; }
  .pill.elevated { background: #fdf3e0; color: #b45309; }
  .pill.extreme { background: #fdeaea; color: #b91c1c; }
  .pill.audit-aligned { background: #eef7ff; color: #1d4ed8; }
  .pill.audit-conflict { background: #fff7e6; color: #b45309; }
  .pill.audit-unavailable { background: #f1f5f9; color: #64748b; }
  .story-evidence { margin: 10px 0; border: 1px solid #e2e8f0; border-radius: 8px; padding: 8px 10px; background: #f8fafc; }
  .story-evidence h4 { margin: 0 0 6px; font-size: 13px; }
  .story-evidence .fields { width: 100%; border-collapse: collapse; }
  .story-evidence .fields th { text-align: left; color: #64748b; font-weight: 600; padding: 3px 6px 3px 0; width: 90px; vertical-align: top; }
  .story-evidence .fields td { padding: 3px 0; }
  .audit-panel { margin: 10px 0; border: 1px solid #e2e8f0; border-radius: 8px; padding: 8px 10px; background: #fff; }
  .audit-panel summary { cursor: pointer; font-size: 13px; font-weight: 600; color: #1e293b; }
  .audit-panel .audit-conflict { margin: 8px 0; padding: 8px 10px; border-left: 3px solid #f59e0b; background: #fffbeb; border-radius: 6px; }
  .audit-panel .audit-conflict-head { font-weight: 700; color: #92400e; margin-bottom: 4px; }
  .audit-panel .audit-line { font-size: 13px; line-height: 1.6; }
  .audit-panel .audit-response { margin-top: 8px; padding-top: 8px; border-top: 1px dashed #e2e8f0; font-size: 13px; line-height: 1.6; }

  .price-chart { width: 100%; height: auto; display: block; background: #fcfcfd; border: 1px solid var(--border); border-radius: 8px; }
  .price-chart-wrap { position: relative; }
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
  .ticket-card { background: #fff; }
  .ticket-view { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }
  .ticket-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .ticket-dir { font-size: 14px; font-weight: 800; }
  .ticket-dir.up { color: var(--up); }
  .ticket-dir.down { color: var(--down); }
  .ticket-contract { font-size: 14px; font-weight: 700; }
  .ticket-state { font-size: 12px; color: var(--muted); }
  .ticket-sections { display: flex; flex-direction: column; gap: 8px; }
  .ticket-section { border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
  .ticket-section-head { padding: 4px 10px; background: #fafafa; border-bottom: 1px solid var(--border); font-size: 12px; color: #374151; font-weight: 600; }
  .ticket-rows { padding: 0 10px; }
  .ticket-row { display: grid; grid-template-columns: 76px minmax(0, 1fr); gap: 12px; padding: 5px 0; border-bottom: 1px solid #f1f3f5; line-height: 1.6; }
  .ticket-row:last-child { border-bottom: none; }
  .ticket-label { color: var(--muted); font-weight: 600; font-size: 12px; }
  .ticket-value { color: var(--text); font-size: 13px; min-width: 0; word-break: break-word; }
  .ticket-value b { font-weight: 700; }
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
  .q-item { padding: 8px 0; border-bottom: 1px solid var(--border); }
  .q-item:last-child { border-bottom: none; }
  .q-item h4 { margin: 0 0 4px; font-size: 13px; color: var(--muted); }
  .q-item div, .q-item ul { font-size: 13px; line-height: 1.7; }
  .q-item ul { margin: 0; padding-left: 18px; }
  .up { color: var(--up); font-weight: 600; }
  .down { color: var(--down); font-weight: 600; }
  .muted { color: var(--muted); font-size: 12px; }

  /* 信号池：双栏布局 */
  .pool-layout { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 20px; align-items: start; }
  .pool-main { min-width: 0; }
  .pool-main > h2:first-child { margin-top: 0; }
  .pool-side { position: sticky; top: 70px; display: flex; flex-direction: column; gap: 12px; }
  .side-card { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px 16px; }
  .side-card h3 { margin: 0 0 8px; font-size: 13px; }
  .sig-stats { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; font-size: 13px; line-height: 1.6; }
  .sig-stats-head { padding: 7px 12px; font-weight: 600; color: #374151; background: #f7f8fa; border-bottom: 1px solid var(--border); }
  .sig-stats-row { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; padding: 5px 12px; border-bottom: 1px solid #f1f3f5; }
  .sig-stats-row.is-last { border-bottom: none; }
  .sig-stats-row.sig-main { font-weight: 600; color: var(--text); }
  .sig-stats-row.sig-sub { padding-left: 26px; color: var(--muted); font-size: 12px; }
  .sig-stats-row b { font-variant-numeric: tabular-nums; font-weight: 600; }
  .signal-table-wrap { border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; background: var(--card); margin: 6px 0 12px; }
  .signal-table { width: 100%; border-collapse: collapse; }
  .signal-table th, .signal-table td { padding: 8px 10px; text-align: left; border-bottom: 1px solid var(--border); font-size: 12px; line-height: 1.6; white-space: nowrap; }
  .signal-table th { background: var(--header-bg); color: #374151; font-weight: 600; }
  .signal-table tbody tr:nth-child(even) td { background: var(--zebra); }
  .signal-table tbody tr:hover td { background: var(--row-hover); }
  .signal-table tbody tr:last-child td { border-bottom: none; }
  .signal-table td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .signal-row { cursor: pointer; }
  .signal-row:hover td { background: #f6f8fb; }
  .signal-row.open td { background: #f1f5f9; }
  .signal-row.closed { opacity: .72; }
  .signal-row.open .row-chevron { transform: rotate(90deg); }
  .signal-detail-row td { padding: 12px 14px; background: #fbfcfd; }
  .signal-detail-row.open td { animation: story-detail-in .18s ease; }
  .side-notes { margin: 0; padding-left: 18px; font-size: 12px; color: var(--muted); line-height: 1.8; }

  /* 信号池 · 故事池式面板 */
  .signal-panel.is-closed { border-left: 3px solid #94a3b8; }
  details.signal-panel > summary { list-style: none; cursor: pointer; }
  details.signal-panel > summary::-webkit-details-marker { display: none; }
  details.signal-panel > summary::before { content: "▸"; color: var(--muted); margin-right: 8px; font-size: 12px; transition: transform .15s ease; display: inline-block; vertical-align: middle; }
  details.signal-panel[open] > summary::before { transform: rotate(90deg); }
  .sig-panel-body { padding-top: 10px; border-top: 1px solid var(--border); margin-top: 4px; }
  .sig-dir { font-size: 13px; font-weight: 700; padding: 1px 6px; border-radius: 4px; }
  .sig-dir.up { background: #fdeaea; color: var(--up); }
  .sig-dir.down { background: #e7f6ec; color: var(--down); }
  .story-status.sig-closed { background: #f1f3f5; color: #6b7280; }
  .sig-price-line { font-size: 12px; color: var(--muted); background: #f7f8fa; border: 1px solid var(--border); border-radius: 6px; padding: 5px 10px; margin: 8px 0 2px; }
  .quote-pending-badge { font-size: 11px; padding: 1px 8px; border-radius: 999px; background: #fef3c7; color: #92400e; border: 1px solid #fde68a; }
  .quote-count-badge { font-size: 11px; padding: 1px 8px; border-radius: 999px; background: #f1f3f5; color: #475569; border: 1px solid var(--border); }
  .quote-compare { margin: 10px 0; border: 1px solid #fde68a; border-radius: 8px; background: #fffbeb; padding: 10px 12px; }
  .quote-compare-head { font-size: 13px; margin-bottom: 6px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .rel { font-size: 11px; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--border); background: #fff; }
  .rel-conflicted { color: #b91c1c; border-color: #fca5a5; background: #fef2f2; }
  .rel-refined { color: #b45309; border-color: #fcd34d; background: #fffbeb; }
  .rel-aligned { color: #047857; border-color: #a7f3d0; background: #ecfdf5; }
  .quote-diff-notes { font-size: 12px; margin: 6px 0; }
  .quote-diff-notes ul, .quote-conflicts { margin: 4px 0 4px 18px; padding: 0; }
  .diff-old-val { color: #b91c1c; font-weight: 600; text-decoration: line-through; }
  .diff-new-val { color: #047857; font-weight: 700; }
  .quote-compare-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; align-items: start; }
  @media (max-width: 900px) { .quote-compare-grid { grid-template-columns: 1fr; } }
  .quote-col { border: 1px solid var(--border); border-radius: 6px; background: #fff; overflow: hidden; }
  .quote-col-head { font-weight: 700; padding: 5px 10px; background: #f7f8fa; border-bottom: 1px solid var(--border); font-size: 12px; }
  .ticket-fields { width: 100%; border-collapse: collapse; font-size: 12px; }
  .ticket-fields th, .ticket-fields td { padding: 4px 8px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }
  .ticket-fields th { color: var(--muted); font-weight: 500; width: 90px; background: #fafafa; }
  .ticket-fields tr:last-child th, .ticket-fields tr:last-child td { border-bottom: none; }
  .ticket-fields tr.tk-diff th { color: #92400e; }
  .ticket-fields tr.tk-diff td { background: #fef3c7; }
  .quote-recon { margin: 8px 0; padding: 8px 10px; background: #eef4ff; border: 1px solid #dbeafe; border-radius: 6px; font-size: 12px; }
  .quote-decision { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 8px; }
  .quote-reason { flex: 1 1 260px; min-width: 180px; padding: 5px 10px; border: 1px solid var(--border); border-radius: 6px; font-size: 12px; }
  .quote-decide { border: 1px solid var(--border); background: #fff; color: var(--text); border-radius: 6px; padding: 5px 10px; font-size: 12px; cursor: pointer; }
  .quote-decide:hover { border-color: var(--accent); color: var(--accent); }
  .quote-decide.danger { color: #b91c1c; border-color: #fca5a5; }
  .quote-decide.danger:hover { background: #fef2f2; }
  .decision-records { margin: 8px 0; }
  .decision-records h4 { margin: 0 0 4px; font-size: 12px; color: var(--muted); }
  .decision-record { border: 1px solid var(--border); border-radius: 6px; background: #fff; padding: 4px 10px; margin: 4px 0; font-size: 12px; }
  .decision-record > summary { list-style: none; cursor: pointer; }
  .decision-record > summary::-webkit-details-marker { display: none; }
  .decision-record > summary::before { content: "▸"; color: var(--muted); margin-right: 6px; font-size: 11px; display: inline-block; }
  .decision-record[open] > summary::before { transform: rotate(90deg); }
  .decision-record.is-local { border-style: dashed; border-color: #fcd34d; background: #fffbeb; }
  .dr-badge { font-size: 10px; padding: 0 6px; border-radius: 999px; background: #fef3c7; color: #92400e; margin-left: 4px; }
  .dr-badge.applied { background: #ecfdf5; color: #047857; }
  .decision-record-body { padding: 4px 0 6px; color: var(--muted); }
  .dr-row { display: flex; gap: 8px; padding: 1px 0; }
  .dr-row span:first-child { min-width: 42px; color: var(--muted); }
  .dr-row span:last-child { color: var(--text); }
  .decision-record-edit { margin-top: 4px; border: 1px solid var(--border); background: #fff; border-radius: 5px; padding: 2px 8px; font-size: 11px; cursor: pointer; }
  .quote-decision-state { font-size: 11px; margin-top: 4px; }
  .decision-export-bar { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; font-size: 12px; color: var(--muted); }
  .decision-export-btn { border: 1px solid var(--border); background: #fff; border-radius: 6px; padding: 4px 10px; font-size: 12px; cursor: pointer; }
  .sig-timeline { position: relative; margin: 10px 0 6px; }
  .tl-item { position: relative; padding: 0 0 14px 34px; }
  .tl-item::before { content: ""; position: absolute; left: 12px; top: 26px; bottom: -4px; width: 2px; background: #e5e7eb; }
  .tl-item:last-child::before { display: none; }
  .tl-dot { position: absolute; left: 6px; top: 7px; width: 14px; height: 14px; border-radius: 50%; background: #9ca3af; border: 2px solid #fff; box-shadow: 0 0 0 2px rgba(156,163,175,.35); }
  .tl-item.tl-ok .tl-dot { background: #047857; box-shadow: 0 0 0 2px rgba(4,120,87,.22); }
  .tl-item.tl-bad .tl-dot { background: #b91c1c; box-shadow: 0 0 0 2px rgba(185,28,28,.2); }
  .tl-item.tl-pending .tl-dot { background: #2563eb; box-shadow: 0 0 0 2px rgba(37,99,235,.18); }
  .tl-item.tl-skip .tl-dot { background: #cbd5e1; box-shadow: 0 0 0 2px rgba(203,213,225,.5); }
  .tl-card { background: #fff; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
  .tl-item.tl-ok .tl-card { border-left: 3px solid #047857; }
  .tl-item.tl-bad .tl-card { border-left: 3px solid #b91c1c; }
  .tl-item.tl-skip .tl-card { background: #fbfcfd; }
  .tl-item.current .tl-card { border-color: #2563eb; background: #eef4ff; box-shadow: 0 0 0 2px rgba(37,99,235,.12); }
  .tl-details > summary { list-style: none; cursor: pointer; padding: 9px 14px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .tl-details > summary::-webkit-details-marker { display: none; }
  .tl-chevron { color: var(--muted); font-size: 11px; transition: transform .15s ease; }
  .tl-details[open] > summary .tl-chevron { transform: rotate(90deg); }
  .tl-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .tl-date { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
  .tl-state { font-size: 12px; font-weight: 600; color: #374151; }
  .tl-dir { font-size: 11px; font-weight: 700; padding: 0 6px; border-radius: 4px; }
  .tl-dir.up { background: #fdeaea; color: var(--up); }
  .tl-dir.down { background: #e7f6ec; color: var(--down); }
  .tl-current-tag { background: var(--accent); color: #fff; font-size: 11px; font-weight: 600; padding: 1px 7px; border-radius: 999px; }
  .tl-body { padding: 8px 14px 10px; border-top: 1px dashed var(--border); display: flex; flex-direction: column; gap: 4px; }
  .tl-details > .ticket-view { margin: 8px 14px 12px; background: #fff; border: 1px solid var(--border); border-radius: 6px; padding: 10px; }
  .tl-row { display: flex; gap: 10px; font-size: 13px; line-height: 1.7; }
  .tl-label { flex: 0 0 64px; color: var(--muted); font-size: 12px; padding-top: 1px; }
  .tl-text { flex: 1; min-width: 0; word-break: break-word; }
  .tl-row.tl-result .tl-text b { color: var(--text); }
  .ver-chip { flex: 0 0 auto; display: inline-block; font-size: 11px; font-weight: 700; border-radius: 4px; padding: 0 6px; margin-right: 2px; background: #f1f3f5; color: #4b5563; font-variant-numeric: tabular-nums; }
  .ver-chip.vc-pending { background: #eef4ff; color: #2563eb; }
  .ver-chip.vc-ok { background: #ecfdf5; color: #047857; }
  .ver-chip.vc-bad { background: #fef2f2; color: #b91c1c; }
  .ver-chip.vc-skip { background: #f1f3f5; color: #6b7280; }
  .sig-chart-block { margin: 10px 0 2px; }
  .sig-chart-head { font-size: 13px; font-weight: 600; color: var(--muted); margin: 0 0 4px; }
  .sig-chart-block .lifecycle svg { width: 100%; height: auto; max-height: none; }
  .lifecycle { position: relative; }
  .chart-day-info { display: grid; grid-template-columns: repeat(8, minmax(0, 1fr)); gap: 2px 8px; align-items: start; font-size: 12px; color: var(--muted); padding: 2px 0 4px; min-height: 22px; font-variant-numeric: tabular-nums; overflow-x: auto; }
  .price-chart-wrap .chart-day-info { grid-template-columns: repeat(10, minmax(0, 1fr)); gap: 2px 8px; }
  .chart-day-info b { font-weight: 700; }
  .chart-day-info > span { display: flex; flex-direction: column; gap: 1px; align-items: center; text-align: center; white-space: normal; overflow: visible; text-overflow: clip; line-height: 1.45; }
  .chart-day-info > span > b, .chart-day-info > span > span { display: block; width: 100%; text-align: center; }
  .chart-crosshair { display: none; pointer-events: none; }
  .chart-hover-tip { display: none; position: absolute; z-index: 6; background: #1f2328; color: #ffffff; font-size: 12px; line-height: 1.5; padding: 4px 10px; border-radius: 6px; pointer-events: none; white-space: nowrap; box-shadow: 0 6px 18px rgba(15,23,42,.25); transform: translateY(-100%); }
  .zp-zone { cursor: pointer; }
  .zp-zone.hover { filter: brightness(1.18); }
  .zp-zone.hover .zp-base { opacity: 0.22 !important; }
  .sig-chart-missing { border: 1px dashed var(--border); border-radius: 8px; padding: 12px; text-align: center; }
  .signal-obs { margin-top: 8px; font-size: 12px; color: var(--muted); border-top: 1px dashed var(--border); padding-top: 6px; }
  @media (max-width: 1080px) { .pool-layout { grid-template-columns: 1fr; } .pool-side { position: static; } }

  /* 故事池：最近出池 20 条——表头固定在滚动区外，滚动区初始约可见 5 行 */
  .closed-table { border: 1px solid var(--border); border-radius: 8px; overflow-x: auto; background: var(--card); }
  .closed-head-wrap { scrollbar-gutter: stable; overflow-y: hidden; border-bottom: 1px solid var(--border); }
  .closed-scroll { max-height: 300px; overflow-y: auto; scrollbar-gutter: stable; }
  .closed-table table { width: 100%; min-width: 860px; table-layout: fixed; border-collapse: collapse; }
  .closed-head-wrap, .closed-scroll { min-width: 860px; }
  .closed-head th { border-bottom: none; background: var(--header-bg); color: #374151; font-weight: 600; }
  .closed-scroll tbody tr:nth-child(even) td { background: var(--zebra); }
  .closed-scroll tbody tr:hover td { background: var(--row-hover); }
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
  table.fields th { width: 88px; text-align: left; vertical-align: top; color: var(--muted); font-weight: 600; padding: 6px 10px 6px 0; white-space: nowrap; }
  table.fields td { vertical-align: top; padding: 6px 0; word-break: break-word; font-size: 13px; }

  .card h4 { margin: 12px 0 6px; font-size: 13px; color: var(--muted); }
  .lifecycle { margin: 10px 0; }
  .lifecycle svg { width: 100%; height: auto; max-height: 200px; background: #fbfdff; border: 1px solid var(--border); border-radius: 8px; }
  details.version { border: 1px solid var(--border); border-radius: 8px; margin: 8px 0; background: #fbfcfd; }
  details.version > summary { cursor: pointer; padding: 8px 12px; font-size: 13px; list-style: none; }
  details.version > summary::-webkit-details-marker { display: none; }
  details.version > summary::before { content: "▸"; color: var(--muted); margin-right: 6px; }
  details.version[open] > summary::before { content: "▾"; }
  .version-body { padding: 2px 12px 10px; }
  .version-body table.fields th { width: 64px; font-size: 12px; }
  .version-body table.fields td { font-size: 13px; }
  table.stats { width: 100%; border-collapse: collapse; }
  table.stats th, table.stats td { padding: 8px 10px; text-align: left; border-bottom: 1px solid var(--border); font-size: 13px; line-height: 1.6; }
  table.stats tr:last-child th, table.stats tr:last-child td { border-bottom: none; }
  table.stats th { color: #374151; font-weight: 600; background: var(--header-bg); }
  table.stats tbody tr:nth-child(even) td { background: var(--zebra); }
  table.stats tbody tr:hover td { background: var(--row-hover); }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  table.stats tr.sub th, table.stats tr.sub td { padding-top: 0; }
  table.stats tr.sub td { color: var(--muted); font-size: 12px; line-height: 1.7; }
  table.stats tr.sub + tr th, table.stats tr.sub + tr td { padding-top: 6px; }

  /* 故事池 */
  .story-panel { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); padding: 12px 14px; margin-bottom: 12px; }
  .story-panel-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .story-panel-head .story-theme { margin-right: 2px; }
  .story-branches { display: flex; flex-direction: column; gap: 10px; margin-top: 10px; }
  .branch-path { border-top: 1px solid var(--border); padding-top: 8px; }
  .branch-path:first-child { border-top: none; padding-top: 0; }
  .branch-path-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 6px; }
  .branch-path-row { display: flex; align-items: stretch; gap: 6px; flex-wrap: wrap; }
  .path-arrow { align-self: center; color: var(--muted); }
  .node-chip { border: 1px solid var(--border); border-radius: 8px; background: #fff; padding: 6px 8px; min-width: 130px; max-width: 220px; }
  .node-chip.terminal { border-width: 2px; }
  .node-chip.terminal.bp-primary, .node-chip.terminal.primary { border-color: #6366f1; }
  .node-chip .node-chip-head { display: flex; align-items: center; gap: 6px; }
  .node-chip .node-chip-head b { font-size: 13px; }
  .node-chip .node-chip-sub { font-size: 11px; color: var(--muted); margin: 2px 0; }
  .node-chip .node-chip-val { font-size: 12px; color: #374151; }
  .node-chip.node-confirmed { background: #f0fdf4; }
  .node-chip.node-broken { background: #fef2f2; }
  .branch-path-foot { font-size: 12px; line-height: 1.6; margin-top: 4px; }
  .branch-meta-line { padding: 2px 0; font-size: 12px; }
  .dg-canvas { position: relative; margin: 8px 0 4px; padding: 12px; border: 1px solid var(--border); border-radius: var(--radius); background: #fbfcfd; overflow: visible; }
  .dg-edges { position: absolute; inset: 0; z-index: 0; pointer-events: none; }
  .dg-layers { position: relative; z-index: 1; display: flex; gap: 32px; align-items: flex-start; }
  .dg-layer { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; gap: 12px; }
  .dg-node { position: relative; border: 1px solid var(--border); border-radius: 8px; background: #fff; padding: 10px 12px; min-height: 72px; cursor: pointer; }
  .dg-node.node-confirmed { border-color: #047857; background: #f0fdf4; }
  .dg-node.node-broken { border-color: #b91c1c; background: #fef2f2; }
  .dg-node-head { display: flex; align-items: center; gap: 6px; }
  .dg-node-head b { font-size: 13px; }
  .dg-node-dir { color: var(--muted); }
  .dg-node-caliber { margin-top: 6px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border: 1px solid #e2e8f0; background: #f8fafc; color: #475569; border-radius: 999px; font-size: 11px; padding: 2px 8px; cursor: pointer; text-align: left; }
  .dg-node-caliber:hover { border-color: #94a3b8; background: #f1f5f9; }
  .dg-node-val { margin-top: 4px; font-size: 13px; font-weight: 600; }
  .dg-node-foot { margin-top: 2px; font-size: 11px; color: var(--muted); }
  .dg-node .node-state { width: 14px; text-align: center; }
  .sg-detail.wide { max-width: 360px; }
  .dg-detail { position: absolute; top: 8px; right: 8px; z-index: 10; max-width: 340px; }

  .story-card { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); padding: 0; margin-bottom: 12px; overflow: hidden; }
  .story-card > summary { list-style: none; cursor: pointer; padding: 12px 16px; display: block; }
  .story-card > summary::-webkit-details-marker { display: none; }
  .story-card > summary::before { content: '▸'; color: var(--muted); margin-right: 8px; font-size: 12px; display: inline-block; vertical-align: middle; }
  .story-card[open] > summary::before { content: '▾'; }
  .story-summary { display: block; }
  .story-theme { font-size: 15px; font-weight: 700; display: inline; vertical-align: middle; letter-spacing: .01em; }
  .story-head { display: flex; align-items: center; gap: 10px 12px; flex-wrap: wrap; font-size: 12px; line-height: 1.7; margin-top: 6px; }
  .story-body { border-top: 1px solid var(--border); padding: 12px 16px; }
  .story-subtitle { font-size: 13px; color: var(--muted); line-height: 1.6; margin-bottom: 10px; }
  .story-graph { position: relative; margin: 4px 0 10px; padding: 8px; border: 1px solid var(--border); border-radius: 8px; background: #fbfcfd; overflow-x: auto; }
  .sg-svg { display: block; width: 100%; height: auto; min-width: 320px; }
  .sg-node { transition: opacity .15s ease; }
  .sg-edge { transition: opacity .15s ease; cursor: pointer; }
  .sg-dim { opacity: 0.18; }
  .sg-detail { position: absolute; top: 10px; right: 10px; max-width: 280px; z-index: 5; }
  .sg-detail-card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; box-shadow: 0 8px 24px rgba(15,23,42,.12); padding: 10px 12px; font-size: 12px; cursor: grab; }
  .sg-detail-card:active { cursor: grabbing; }
  .sg-detail.sg-dragging { user-select: none; }
  .sg-detail.sg-dragging .sg-detail-card { cursor: grabbing; }
  .sg-detail-card a { cursor: pointer; }
  .sg-detail-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 6px; font-size: 13px; }
  .sg-detail-close { border: none; background: transparent; font-size: 16px; line-height: 1; cursor: pointer; color: var(--muted); }
  .sg-detail-row { display: flex; justify-content: space-between; gap: 12px; padding: 2px 0; color: var(--muted); }
  .sg-detail-row b { color: var(--text); font-weight: 600; text-align: right; }
  .sg-detail-note { margin-top: 6px; color: var(--muted); font-size: 11px; }
  .sg-detail-note.caliber-what { margin: 6px 0; padding: 6px 8px; border-radius: 6px; background: #f0f9ff; color: #0f172a; font-size: 12px; line-height: 1.6; }
  .sg-detail-note.caliber-node { margin: 6px 0; padding: 6px 8px; border-radius: 6px; background: #f8fafc; color: #334155; font-size: 12px; line-height: 1.6; }
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
  .branch-table { width: 100%; table-layout: fixed; border-collapse: separate; border-spacing: 0; margin: 6px 0 12px; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; background: var(--card); }
  .branch-table .path-cell { font-size: 12px; color: #374151; line-height: 1.5; }
  .branch-table .impact-cell { line-height: 1.5; }
  .branch-table th, .branch-table td { padding: 8px 10px; text-align: left; border-bottom: 1px solid var(--border); font-size: 12px; line-height: 1.6; }
  .branch-table th { color: #374151; font-weight: 600; white-space: nowrap; background: var(--header-bg); }
  .branch-table tbody tr:nth-child(even) td { background: var(--zebra); }
  .branch-table tbody tr:hover td { background: var(--row-hover); }
  .branch-table tbody tr:last-child td { border-bottom: none; }
  .branch-table th:first-child, .branch-table td:first-child { white-space: nowrap; }
  .branch-priority { white-space: nowrap; }
  .story-sub-detail { margin-top: 8px; border-top: 1px dashed var(--border); padding-top: 6px; }
  .story-sub-detail summary { cursor: pointer; color: var(--muted); font-size: 12px; font-weight: 600; }
  .branch-table-wide { min-width: 720px; }
  .row-chevron { display: inline-block; margin-right: 6px; color: var(--muted); font-size: 11px; transition: transform .15s ease; }
  .branch-row.open .row-chevron, .closed-row.open .row-chevron { transform: rotate(90deg); }
  .branch-row { cursor: pointer; }
  .branch-row:hover td { background: #f6f8fb; }
  .branch-row.open td { background: #f1f5f9; }
  .branch-row td:first-child { border-left: 3px solid transparent; }
  .branch-row.open td:first-child { border-left-color: #6366f1; }
  .closed-row { cursor: pointer; }
  .closed-row:hover td { background: #f6f8fb; }
  .closed-row.open td { background: #f1f5f9; }
  .closed-row td:first-child { border-left: 3px solid transparent; }
  .closed-row.status-completed td:first-child { border-left-color: #047857; }
  .closed-row.status-falsified td:first-child, .closed-row.status-expired td:first-child, .closed-row.status-void td:first-child { border-left-color: #b91c1c; }
  .closed-row.status-superseded td:first-child { border-left-color: #94a3b8; }
  .branch-detail-row td, .closed-detail-row td { padding: 12px 14px; background: #fbfcfd; border-left: 3px solid #e2e8f0; }
  .branch-detail { display: flex; flex-direction: column; gap: 6px; }
  .bd-row { display: flex; gap: 10px; font-size: 12px; line-height: 1.6; }
  .bd-label { flex: 0 0 72px; color: var(--muted); }
  .bd-nodes { display: flex; flex-direction: column; gap: 4px; margin-top: 4px; }
  .bd-node { display: flex; align-items: center; gap: 8px; font-size: 12px; padding: 4px 8px; border-radius: 6px; background: #fff; border: 1px solid var(--border); }
  .bd-node .node-state { width: 14px; text-align: center; }
  .bd-node .node-label { font-weight: 600; }
  .bd-node .node-status, .bd-node .node-value { color: var(--muted); }
  .branch-detail-row.open td, .closed-detail-row.open td { animation: story-detail-in .18s ease; }
  @keyframes story-detail-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
  .story-detail-btn, .closed-detail-btn { border: 1px solid var(--border); background: var(--card); border-radius: 6px; padding: 3px 8px; font-size: 12px; cursor: pointer; color: var(--text); }
  .closed-detail-btn { border: none; background: transparent; padding: 0; font-weight: 600; cursor: pointer; color: var(--text); font-size: 13px; text-align: left; }
  .story-modal { display: none; position: fixed; inset: 0; z-index: 50; }
  .story-modal.open { display: block; }
  .story-modal-backdrop { position: absolute; inset: 0; background: rgba(15,23,42,.45); }
  .story-modal-body { position: absolute; inset: 24px 24px 24px 24px; max-width: 960px; margin: 0 auto; background: var(--card); border-radius: 12px; overflow: auto; padding: 18px 20px; box-shadow: 0 20px 60px rgba(0,0,0,.25); }
  .story-modal-close { position: absolute; top: 10px; right: 12px; border: none; background: transparent; font-size: 24px; line-height: 1; cursor: pointer; color: var(--muted); z-index: 2; }
  .story-modal-body-sm { max-width: 900px; max-height: 62vh; inset: 36px 18px 36px 18px; margin: 0 auto; }
  .story-inline-panel { display: none; margin: 8px 0 12px; }
  .story-inline-panel.open { display: block; }
  .story-branches { display: flex; flex-direction: column; gap: 6px; margin-bottom: 10px; }
  .story-branch { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 13px; padding: 6px 8px; border: 1px solid var(--border); border-radius: 6px; background: #fafbfc; }
  .branch-priority { font-size: 11px; padding: 1px 6px; border-radius: 4px; }
  .branch-priority.bp-primary { background: #eef2ff; color: #3730a3; }
  .branch-priority.bp-secondary { background: #f3f4f6; color: #4b5563; }
  .branch-symbol { font-weight: 600; }
  .branch-dir, .branch-status, .branch-proof { color: var(--muted); font-size: 12px; }
  .story-status { font-size: 12px; padding: 2px 8px; border-radius: 999px; font-weight: 600; }
  .source-class { font-size: 11px; padding: 1px 7px; border-radius: 999px; background: #f1f5f9; color: #475569; font-weight: 600; }
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
  table.index th { background: var(--header-bg); font-weight: 600; white-space: nowrap; }
  table.index tbody tr:nth-child(even) { background: var(--zebra); }
  table.index tbody tr:hover { background: var(--row-hover); }
  table.index tbody tr.current { background: #eef4ff; }
  .badge-current { display: inline-block; margin-left: 6px; font-size: 11px; padding: 1px 6px; border-radius: 999px; background: var(--accent); color: #fff; }
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
    .opp-layout { grid-template-columns: 1fr; }
    .opp-nav { order: 0; width: 100%; flex-direction: row; flex-wrap: wrap; position: static; }
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
      ${statCard('📈', '本期机会', opps.length, 'blue', kpiDeltas.opportunities ? kpiDeltas.opportunities.total : null)}
      ${statCard('↑', '看多', opps.filter((o) => o.thesis && o.thesis.finalDirection === 'bullish').length, 'red', kpiDeltas.opportunities ? kpiDeltas.opportunities.bullish : null)}
      ${statCard('↓', '看空', opps.filter((o) => o.thesis && o.thesis.finalDirection === 'bearish').length, 'green', kpiDeltas.opportunities ? kpiDeltas.opportunities.bearish : null)}
      ${statCard('⚠️', '信号池内', pool.length, 'gray', kpiDeltas.opportunities ? kpiDeltas.opportunities.signalPoolCount : null)}
    </div>
    ${oppHtml}
  </section>

  <section id="tab-pool" class="tab-panel">
    <div class="summary-bar">
      ${statCard('📊', '池内信号', pool.length, 'blue', kpiDeltas.signals ? kpiDeltas.signals.pool : null)}
      ${statCard('🟢', '追踪中', activeCount, 'green', kpiDeltas.signals ? kpiDeltas.signals.active : null)}
      ${statCard('🟡', '非生效观察', downgradedCount, 'gray', kpiDeltas.signals ? kpiDeltas.signals.downgraded : null)}
      ${statCard('📦', '历史已出池', stats.totalClosed == null ? 0 : stats.totalClosed, 'red', kpiDeltas.signals ? kpiDeltas.signals.totalClosed : null)}
    </div>
    <div class="pool-layout">
      <div class="pool-main">
        <h2>池内信号（全量追踪）</h2>
        <div class="decision-export-bar"><span>人类决策：在下方报价对比中填写理由并点击按钮，决策保存在浏览器本地；导出 JSON 后由 agent 回填信号池。</span><button type="button" class="decision-export-btn" id="signal-decisions-export">导出决策 JSON</button></div>
        ${poolPanels}
        <h2>最近出池信号（最新 5 个）</h2>
        ${sigClosedPanels}
        ${signalChartHoverScript()}
      </div>
      <aside class="pool-side">
        <div class="side-card"><h3>历史统计</h3>${statsTable(stats)}</div>
        <div class="side-card"><h3>口径说明</h3><ul class="side-notes"><li>池内与出池信号统一为同一种信号面板：版本时间线 + 价格轨迹图</li><li>每个信号每个交易日只保留一条最新策略，后续交易日才追加新版本</li><li>时间线头部常显（版本/日期/状态/方向），点击展开完整策略文本；当前版本默认展开</li><li>时间线圆点：绿=盈利终态 · 红=亏损终态 · 灰=未执行/跳过 · 蓝框=当前版本</li><li>出池：方向层 + 执行层两层归因，出池方式只做附注</li></ul></div>
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
  const DASH_RUN_ID = ${JSON.stringify(runId)};
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

  // 故事跳转：机会分析/信号池卡片头部的故事按钮 → 切到故事池并定位对应故事
  document.querySelectorAll('[data-story-jump]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const chainId = btn.dataset.storyJump;
      document.querySelector('.tab[data-tab="stories"]').click();
      let target = document.getElementById('story-chain-' + chainId);
      if (!target) {
        const detailRow = document.getElementById('closed-detail-' + chainId);
        if (detailRow) {
          const row = detailRow.previousElementSibling;
          detailRow.style.display = 'table-row';
          detailRow.classList.add('open');
          if (row) row.classList.add('open');
          target = detailRow;
        }
      }
      if (target) {
        setTimeout(() => {
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
          target.classList.add('story-flash');
          setTimeout(() => target.classList.remove('story-flash'), 2200);
        }, 50);
      }
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

  // 信号报价对比：人类决策（浏览器本地暂存 + 导出 JSON 供 agent 回填）
  const DECISION_STORE_KEY = 'frSignalDecisions:' + DASH_RUN_ID;
  function loadDecisions() {
    try { return JSON.parse(localStorage.getItem(DECISION_STORE_KEY) || '{}'); } catch (e) { return {}; }
  }
  function saveDecisions(obj) {
    localStorage.setItem(DECISION_STORE_KEY, JSON.stringify(obj));
  }
  function localDecisionRecordHtml(d) {
    const dt = d.decidedAt ? d.decidedAt.replace('T', ' ').slice(0, 16) : '—';
    const labels = { adopt: '采用新报价', keep: '维持旧单', pause: '暂停信号', close: '关闭信号' };
    return '<details class="decision-record is-local" data-key="' + d.signalId + '|' + d.quoteVersionId + '">' +
      '<summary><b>对账决策</b> · ' + (labels[d.action] || d.action) + ' · ' + d.quoteVersionId + ' · ' + dt + ' <span class="dr-badge">待回填</span></summary>' +
      '<div class="decision-record-body">' +
      '<div class="local-compare-slot"></div>' +
      '<div class="dr-row"><span>理由</span><span>' + d.reason + '</span></div>' +
      '<div class="dr-row"><span>动作</span><span>' + (labels[d.action] || d.action) + '</span></div>' +
      '<button type="button" class="decision-record-edit">修改决策</button>' +
      '</div></details>';
  }
  function renderDecisionStates() {
    const decisions = loadDecisions();
    const labels = { adopt: '采用新报价', keep: '维持旧单', pause: '暂停信号', close: '关闭信号' };
    document.querySelectorAll('.quote-compare').forEach((box) => {
      const key = box.dataset.signalId + '|' + box.dataset.quoteVersionId;
      box.style.display = decisions[key] ? 'none' : '';
    });
    document.querySelectorAll('.decision-records').forEach((zone) => {
      zone.querySelectorAll('.decision-record.is-local').forEach((el) => el.remove());
      const signalId = zone.dataset.signalId;
      Object.values(decisions).filter((d) => d.signalId === signalId).forEach((d) => {
        zone.insertAdjacentHTML('beforeend', localDecisionRecordHtml(d));
        const rec = zone.querySelector('.decision-record.is-local[data-key="' + d.signalId + '|' + d.quoteVersionId + '"]');
        const src = document.querySelector('.quote-compare[data-quote-version-id="' + d.quoteVersionId + '"]');
        if (rec && src) {
          const slot = rec.querySelector('.local-compare-slot');
          ['quote-compare-head', 'quote-diff-notes', 'quote-compare-grid', 'quote-recon'].forEach((cls) => {
            const el = src.querySelector('.' + cls);
            if (el) slot.appendChild(el.cloneNode(true));
          });
        }
      });
      if (!zone.querySelector('.decision-record')) zone.innerHTML = '';
    });
    document.querySelectorAll('.decision-record.is-local .decision-record-edit').forEach((btn) => {
      btn.addEventListener('click', () => {
        const rec = btn.closest('.decision-record');
        const d = decisions[rec.dataset.key];
        if (!d) return;
        const body = rec.querySelector('.decision-record-body');
        const opts = Object.entries(labels).map(([v, l]) => '<option value="' + v + '"' + (v === d.action ? ' selected' : '') + '>' + l + '</option>').join('');
        body.innerHTML = '<div class="dr-row"><span>动作</span><span><select class="local-action">' + opts + '</select></span></div>' +
          '<div class="dr-row"><span>理由</span><span><input class="local-reason" type="text" maxlength="200" value="' + d.reason + '"></span></div>' +
          '<button type="button" class="local-save">保存修改</button> <button type="button" class="local-cancel">取消</button>';
        body.querySelector('.local-save').addEventListener('click', () => {
          const reason = body.querySelector('.local-reason').value.trim();
          if (!reason) { alert('理由不能为空'); return; }
          d.action = body.querySelector('.local-action').value;
          d.reason = reason;
          d.decidedAt = new Date().toISOString();
          saveDecisions(decisions);
          renderDecisionStates();
        });
        body.querySelector('.local-cancel').addEventListener('click', () => renderDecisionStates());
      });
    });
  }
  document.querySelectorAll('.quote-decide').forEach((btn) => {
    btn.addEventListener('click', () => {
      const box = btn.closest('.quote-compare');
      if (!box) return;
      const reasonInput = box.querySelector('.quote-reason');
      const reason = (reasonInput && reasonInput.value ? reasonInput.value : '').trim();
      if (!reason) { alert('请先填写决策理由'); return; }
      const decision = {
        signalId: box.dataset.signalId,
        quoteVersionId: box.dataset.quoteVersionId,
        action: btn.dataset.action,
        reason,
        decidedAt: new Date().toISOString()
      };
      const decisions = loadDecisions();
      decisions[decision.signalId + '|' + decision.quoteVersionId] = decision;
      saveDecisions(decisions);
      renderDecisionStates();
    });
  });
  const exportBtn = document.getElementById('signal-decisions-export');
  if (exportBtn) {
    exportBtn.addEventListener('click', () => {
      const decisions = loadDecisions();
      const list = Object.values(decisions);
      if (list.length === 0) { alert('还没有任何决策'); return; }
      const doc = {
        schema: 'futures-radar-signal-decisions/1',
        runId: DASH_RUN_ID,
        decisions: list
      };
      const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'signal-pool-decisions-' + DASH_RUN_ID + '.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    });
  }
  renderDecisionStates();

  // 信号池表格：点击行展开/折叠详情
  document.querySelectorAll('.signal-row').forEach((row) => {    row.addEventListener('click', () => {
      const d = document.getElementById(row.dataset.detailId);
      if (!d) return;
      const open = d.style.display !== 'none';
      if (open) { d.style.display = 'none'; d.classList.remove('open'); row.classList.remove('open'); }
      else { d.style.display = 'table-row'; d.classList.add('open'); row.classList.add('open'); }
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

module.exports = { renderDashboardHtml, historyIndex, seriesBars, main };

if (require.main === module) main();
