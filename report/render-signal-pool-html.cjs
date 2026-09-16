// report/render-signal-pool-html.cjs — 信号池看板（自包含单文件 HTML）
//
// 用法:
//   node report/render-signal-pool-html.cjs --runId <runId>
//
// 行为:
//   读 output/runs/<runId>/signal-pool.json → 渲染双 Tab HTML →
//   写 <runtimeRoot>/signal-pool.html（稳定路径，每期覆盖）。
//
// Tab1 信号池看板：池内信号全量卡片 + 最近出池 5 个 + 历史统计；
//                  信号与策略版本均可展开（原生 <details>）。
// Tab2 完整报告：仅放当前 run 的 report.md 索引链接。
//
// 纪律：确定性、不联网、不调用 LLM、无外部 CSS/JS 依赖；所有字段转义。

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { runtimeRoot, runDir } = require('../lib/workspace.cjs');
const {
  statusBadge,
  directionLabel,
  confidenceLabel,
  poolStatusLabel,
  closeReasonLabel,
  verdictLabel,
  signalVerificationLabel,
  signalVersionVerificationLabel,
  versionExitDetail
} = require('./render-strategy-section.cjs');

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
  return `V${num} · ${statusBadge(v.executionStatus)} · ${v.signalDate} · ${escapeHtml(v.stateTransition === 'signal_created' ? '入池' : (v.stateTransition || '—'))} · ${signalVersionVerificationLabel(v)}`;
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
    const ev = o.events && o.events.length ? o.events.join(' · ') : '—';
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
    <div class="anchor-head">锚定策略：${escapeHtml(a.versionId)} · ${statusBadge(a.executionStatus)} · ${escapeHtml(a.signalDate)}</div>
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

function signalCard(sig, { closed = false } = {}) {
  const body = [];
  const rows = [];
  if (closed) {
    const closedDate = sig.closedAt ? String(sig.closedAt).slice(0, 10) : '—';
    rows.push(fieldRow('入池', `${sig.createdDate} <span class="muted">${escapeHtml(sig.createdRunId)}</span>`));
    rows.push(fieldRow('出池', `${closedDate} · ${closeReasonLabel(sig.closeReason)} · 窗口判定 ${verdictLabel(sig.verdict)}`));
  } else {
    rows.push(fieldRow('入池', `${sig.createdDate} <span class="muted">${escapeHtml(sig.createdRunId)}</span>`));
    rows.push(fieldRow('最近更新', `${sig.lastSeenDate} <span class="muted">${escapeHtml(sig.lastSeenRunId)}</span>`));
  }
  const cur = sig.currentVersion || {};
  const curExpr = cur.executionStatus
    ? `${statusBadge(cur.executionStatus)}${cur.entryTrigger ? ` — ${escapeHtml(cur.entryTrigger)}` : ''}`
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

  if (!closed) body.push(anchorPanel(sig));
  body.push(`<table class="fields">${rows.join('')}</table>`);
  body.push(timelineBlock(sig));

  const versions = Array.isArray(sig.versions) ? sig.versions : [];
  if (versions.length > 0) {
    body.push(`<h4>策略版本（${versions.length}）</h4>`);
    for (const v of versions) {
      body.push(`<details class="version"><summary>${versionSummary(v)}</summary><div class="version-body">${versionBody(v)}</div></details>`);
    }
  }

  return `<details class="card ${closed ? 'closed' : ''}"><summary>${signalTitle(sig)}</summary><div class="card-body">${body.join('')}</div></details>`;
}

function statsTable(stats) {
  const byReason = stats.byCloseReason || {};
  const byOutcome = stats.byOutcome || {};
  const rows = [
    ['历史已出池信号', stats.totalClosed == null ? 0 : stats.totalClosed],
    ['已兑现', byOutcome.fulfilled || 0],
    ['已失效', byOutcome.invalidated || 0],
    ['失效 · 反向翻转', byReason.flipped || 0],
    ['失效 · Q5证伪', byReason.invalidated_q5 || 0],
    ['失效 · 机会衰竭', byReason.faded || 0],
    ['失效 · 窗口到期', byReason.expired || 0]
  ];
  return `<table class="stats">${rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('')}</table>`;
}

function renderSignalPoolHtml(view, opts = {}) {
  const runId = opts.runId || (view.meta && view.meta.runId) || '';
  const pool = Array.isArray(view.pool) ? view.pool : [];
  const recentClosed = Array.isArray(view.recentClosed) ? view.recentClosed : [];
  const stats = view.historyStats || {};
  const details = view.details || {};

  const poolCards = pool.map((s) => {
    const detail = details[s.signalId] || {};
    return signalCard({ ...s, versions: detail.versions || [] });
  }).join('\n');

  const closedCards = recentClosed.map((s) => {
    const detail = details[s.signalId] || {};
    return signalCard({ ...s, versions: detail.versions || [] }, { closed: true });
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
  const args = process.argv.slice(2);
  const i = args.indexOf('--runId');
  const runId = i === -1 ? null : args[i + 1];
  if (!runId) {
    console.error('FATAL: --runId required');
    process.exit(1);
  }
  const signalPoolPath = path.join(runDir(runId), 'signal-pool.json');
  if (!fs.existsSync(signalPoolPath)) {
    console.error(`FATAL: signal-pool.json not found: ${signalPoolPath}`);
    process.exit(1);
  }
  const view = JSON.parse(fs.readFileSync(signalPoolPath, 'utf8'));
  const html = renderSignalPoolHtml(view, { runId });
  const outPath = path.join(runtimeRoot, 'signal-pool.html');
  fs.writeFileSync(outPath, html, 'utf8');
  console.log(`signal-pool.html: ${outPath}`);
  console.log(`  pool=${view.pool ? view.pool.length : 0}, recentClosed=${view.recentClosed ? view.recentClosed.length : 0}, closedTotal=${view.historyStats ? view.historyStats.totalClosed : 0}`);
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
