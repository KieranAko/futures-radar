// report/render-dashboard-html.cjs — 三 Tab 看板（自包含单文件 HTML）
//
// 用法:
//   node report/render-dashboard-html.cjs --runId <runId>
//
// Tab1 机会分析看板：读 report-model.json，只渲染机会分析相关内容。
// Tab2 信号池看板：读 signal-pool.json，复用 render-signal-pool-html.cjs 的卡片函数。
// Tab3 历史报告索引：扫描 output/runs/*/report.html 建索引，点击浏览器阅读。
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

function oppTitle(opp) {
  const dir = opp.thesis && opp.thesis.finalDirection ? opp.thesis.finalDirection : 'neutral';
  const conf = opp.thesis && opp.thesis.finalConfidence ? opp.thesis.finalConfidence : 'low';
  const close = opp.marketFacts && opp.marketFacts.close != null ? fmt(opp.marketFacts.close) : '—';
  const dirEmoji = dir === 'bullish' ? '🔴' : dir === 'bearish' ? '🟢' : '⚪';
  return `${dirEmoji} ${opp.name || opp.symbol}（${opp.contract || opp.symbol}）· ${directionLabel(dir)} · ${confidenceLabel(conf)}置信 · 收盘 ${close}`;
}

function fieldRow(label, value) {
  return `<tr><th>${escapeHtml(label)}</th><td>${value}</td></tr>`;
}

function oppCard(opp) {
  const t = opp.thesis || {};
  const rows = [];
  const driver = t.driver || {};
  if (driver.primary) rows.push(fieldRow('驱动主线', `${escapeHtml(driver.primary)}${driver.secondary ? `<br><span class="muted">${escapeHtml(driver.secondary)}</span>` : ''}`));
  const odds = t.odds || {};
  if (odds.reasoning) rows.push(fieldRow('核心逻辑', escapeHtml(odds.reasoning)));
  const confirmations = t.confirmations && Array.isArray(t.confirmations.signals) ? t.confirmations.signals : [];
  if (confirmations.length) rows.push(fieldRow('确认信号', `<ul class="tight">${confirmations.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ul>`));
  const invalidations = t.invalidations && Array.isArray(t.invalidations.conditions) ? t.invalidations.conditions : [];
  if (invalidations.length) rows.push(fieldRow('失效条件', `<ul class="tight">${invalidations.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ul>`));
  const risks = t.risks && Array.isArray(t.risks.items) ? t.risks.items : [];
  if (risks.length) rows.push(fieldRow('主要风险', `<ul class="tight">${risks.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ul>`));

  const detail = [];
  if (driver.primary || driver.secondary || driver.evidence || driver.source) {
    detail.push(`<h4>Q1 驱动</h4><p>${escapeHtml(driver.primary || '')}${driver.secondary ? `<br><span class="muted">${escapeHtml(driver.secondary)}</span>` : ''}</p>`);
    if (driver.evidence) detail.push(`<p class="muted">证据：${escapeHtml(driver.evidence)}</p>`);
    if (driver.source) detail.push(`<p class="muted">来源：${escapeHtml(driver.source)}</p>`);
  }
  if (t.trendOrImpulse && t.trendOrImpulse.assessment) detail.push(`<h4>Q2 趋势/脉冲</h4><p>${escapeHtml(t.trendOrImpulse.assessment)}</p>`);
  if (odds.bias || odds.reasoning) detail.push(`<h4>Q3 赔率</h4><p>${escapeHtml(odds.bias || '')} · ${escapeHtml(odds.reasoning || '')}</p>`);

  return `<details class="card"><summary>${oppTitle(opp)}</summary><div class="card-body"><table class="fields">${rows.join('')}</table>${detail.join('')}</div></details>`;
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

function renderDashboardHtml({ runId, reportModel, signalPoolView, history }) {
  const opps = reportModel && Array.isArray(reportModel.opportunities) ? reportModel.opportunities : [];
  const pool = signalPoolView && Array.isArray(signalPoolView.pool) ? signalPoolView.pool : [];
  const recentClosed = signalPoolView && Array.isArray(signalPoolView.recentClosed) ? signalPoolView.recentClosed : [];
  const stats = signalPoolView && signalPoolView.historyStats ? signalPoolView.historyStats : {};
  const details = signalPoolView && signalPoolView.details ? signalPoolView.details : {};

  const oppCards = opps.map((o) => oppCard(o)).join('\n');
  const poolCards = pool.map((s) => {
    const d = details[s.signalId] || {};
    return signalCard({ ...s, versions: d.versions || [] });
  }).join('\n');
  const closedCards = recentClosed.map((s) => {
    const d = details[s.signalId] || {};
    return signalCard({ ...s, versions: d.versions || [] }, { closed: true });
  }).join('\n');

  const histRows = history.map((h) => `<tr><td>${escapeHtml(h.runId)}</td><td>${escapeHtml(h.date)}</td><td>${escapeHtml(h.oppSymbols || '—')}</td><td><a href="${escapeHtml(h.href)}">打开 →</a></td></tr>`).join('');

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
  main { max-width: 980px; margin: 0 auto; padding: 18px 22px 48px; }
  .tab-panel { display: none; }
  .tab-panel.active { display: block; }
  .summary-bar { display: flex; gap: 10px; flex-wrap: wrap; margin: 6px 0 16px; }
  .summary-bar .stat { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); padding: 10px 16px; min-width: 110px; }
  .summary-bar .stat b { display: block; font-size: 20px; }
  .summary-bar .stat span { color: var(--muted); font-size: 12px; }
  section h2 { font-size: 15px; margin: 22px 0 10px; padding-left: 8px; border-left: 3px solid var(--accent); }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); margin: 10px 0; box-shadow: 0 1px 2px rgba(0,0,0,.03); }
  .card > summary { cursor: pointer; padding: 12px 16px; font-weight: 600; list-style: none; display: flex; align-items: center; gap: 8px; }
  .card > summary::-webkit-details-marker { display: none; }
  .card > summary::before { content: "▸"; color: var(--muted); transition: transform .15s; }
  .card[open] > summary::before { transform: rotate(90deg); }
  .card-body { padding: 4px 16px 14px; border-top: 1px solid var(--border); }
  table.fields { width: 100%; border-collapse: collapse; table-layout: fixed; margin: 6px 0; }
  table.fields th { width: 88px; text-align: left; vertical-align: top; color: var(--muted); font-weight: 500; padding: 5px 10px 5px 0; white-space: nowrap; }
  table.fields td { vertical-align: top; padding: 5px 0; word-break: break-word; }
  .muted { color: var(--muted); font-size: 12px; }
  ul.tight { margin: 0; padding-left: 18px; }
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
  table.index { width: 100%; border-collapse: collapse; background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
  table.index th, table.index td { padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--border); }
  table.index tr:last-child th, table.index tr:last-child td { border-bottom: none; }
  table.index th { background: #f7f8fa; font-weight: 600; }
  table.index a { color: var(--accent); text-decoration: none; }
  @media print { header { position: static; } .tab { display: none; } .tab-panel { display: block !important; } }
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
      ${oppCards || '<p class="muted">本期无机会分析。</p>'}
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
      ${histRows ? `<div class="table-wrap"><table class="index"><tr><th>runId</th><th>日期</th><th>机会品种</th><th></th></tr>${histRows}</table></div>` : '<p class="muted">暂无历史报告。</p>'}
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
  const history = historyIndex(runId, path.join(runtimeRoot, 'runs'));
  const html = renderDashboardHtml({ runId, reportModel, signalPoolView, history });
  const outPath = path.join(runtimeRoot, 'dashboard.html');
  fs.writeFileSync(outPath, html, 'utf8');
  console.log(`dashboard.html: ${outPath}`);
  console.log(`  opportunities=${reportModel && reportModel.opportunities ? reportModel.opportunities.length : 0}, pool=${signalPoolView && signalPoolView.pool ? signalPoolView.pool.length : 0}, history=${history.length}`);
}

module.exports = { renderDashboardHtml, historyIndex, main };

if (require.main === module) main();
