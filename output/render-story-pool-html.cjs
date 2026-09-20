// output/render-story-pool-html.cjs — 故事传导链池看板渲染
//
// 输入：data/story-pool/view.json（由 stories/lib/story-chain.cjs buildView 产出）
// 输出：dashboard Tab1（故事池）HTML 片段。确定性、不联网、不调用 LLM。
// 活跃故事卡使用 <details> 折叠；人类可读：主题为标题，节点行含当前值/单位/取数路径/可信度。
'use strict';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const STATUS_LABEL = {
  resolving: '🔍 解析中',
  pending: '⏳ 待确认',
  proven: '✅ 已证明',
  completed: '🏁 已走完',
  falsified: '❌ 已证伪',
  expired: '⏰ 已过期',
  superseded: '♻️ 已换代',
  void: '🚫 已作废',
};

const NODE_STATUS_LABEL = { confirmed: '已确认', broken: '已断裂', pending: '待确认' };

const EVENT_LABEL = {
  registered: '链注册',
  confirmed: '节点确认',
  broken: '节点断裂',
  proven: '达到证明点',
  completed: '传导链走完',
  falsified: '传导链证伪',
  expired: '链过期',
  superseded: '被换代',
  void: '作废',
  resolve_progress: '检索解析进度',
  resolved: '全部节点解析完成',
  linked_signal: '回链信号',
  speed_anomaly: '流速异常',
};

const CRED_LABEL = { high: '高', medium: '中', low: '低', unknown: '未知' };
const CRED_CLASS = { high: 'cred-high', medium: 'cred-medium', low: 'cred-low', unknown: 'cred-unknown' };

function storyStatusBadge(status) {
  const cls = ['proven', 'completed'].includes(status) ? 'st-ok' : ['falsified', 'void', 'expired'].includes(status) ? 'st-bad' : status === 'resolving' ? 'st-watch' : 'st-run';
  return `<span class="story-status ${cls}">${STATUS_LABEL[status] || escapeHtml(status)}</span>`;
}

function credBadge(cred) {
  if (!cred) return '<span class="cred cred-unknown">未标注</span>';
  return `<span class="cred ${CRED_CLASS[cred] || 'cred-unknown'}">可信度 ${CRED_LABEL[cred] || escapeHtml(cred)}</span>`;
}

function fmtVal(v) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return '—';
  const n = Number(v);
  return Math.abs(n) >= 100 ? n.toFixed(1) : n.toFixed(2);
}

function nodeClass(n) {
  if (n.status === 'confirmed') return 'node-confirmed';
  if (n.status === 'broken') return 'node-broken';
  return 'node-pending';
}

function fmtSigned(v) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return '—';
  const n = Number(v);
  return (n > 0 ? '+' : '') + fmtVal(n);
}

function nodeRow(n) {
  const exp = n.expectation === 1 ? '预期 ↑' : n.expectation === -1 ? '预期 ↓' : '';
  const path = n.resolution ? n.resolution.path : 'T0';
  const label = n.label || n.concept || n.indicatorId || n.id;
  const cur = n.lastValue ?? n.observedValue;
  const prev = n.prevValue;
  const curAt = n.lastValueAt || (n.status === 'confirmed' ? n.observedAt : null);
  const mom = Number.isFinite(Number(cur)) && Number.isFinite(Number(prev)) ? Number(cur) - Number(prev) : null;
  const tier = n.resolution && n.resolution.sourceTier ? `· 来源${escapeHtml(n.resolution.sourceTier)}级` : '';
  return `<div class="story-node ${nodeClass(n)}">
    <div class="node-line node-title">
      <span class="node-state">${n.status === 'confirmed' ? '✔' : n.status === 'broken' ? '✘' : '·'}</span>
      <span class="node-label">${escapeHtml(label)}</span>
      <span class="node-status">${NODE_STATUS_LABEL[n.status] || escapeHtml(n.status)}</span>
      <span class="node-dir">${exp}</span>
      ${credBadge(n.credibility)}
    </div>
    <div class="node-line node-values">
      <span class="node-value">前值 ${fmtVal(prev)}${prev != null && n.prevValueAt ? `（${escapeHtml(n.prevValueAt)}）` : ''} → 当前 <b>${fmtVal(cur)}</b>${curAt ? `（${escapeHtml(curAt)}）` : ''} · 环比 <b class="${mom > 0 ? 'mom-up' : mom < 0 ? 'mom-down' : ''}">${fmtSigned(mom)}</b> ${escapeHtml(n.unit || '')}</span>
    </div>
    <div class="node-line node-meta-line">
      <span class="node-meta">${escapeHtml(n.indicatorId || n.concept || '—')}</span>
      <span class="node-path">${escapeHtml(path)}${tier}</span>
      <span class="node-window">观察窗口 ${escapeHtml(n.windowStartDate || '—')} → ${escapeHtml(n.windowDeadlineDate || '—')}</span>
      ${n.status === 'confirmed' && n.observedAt ? `<span class="node-confirm-at">确认于 ${escapeHtml(n.observedAt)}</span>` : ''}
      ${n.brokenReason ? `<span class="node-broken-reason">断裂原因：${escapeHtml(n.brokenReason)}</span>` : ''}
    </div>
  </div>`;
}

function chainCard(c) {
  const confirmed = (c.nodes || []).filter((n) => n.status === 'confirmed').length;
  const total = c.nodes ? c.nodes.length : 0;
  const dir = c.direction === -1 ? '🔻 空' : '🔺 多';
  const unresolved = c.unresolvedNodes ? ` · 🔍 未解析 ${c.unresolvedNodes}` : '';
  const events = (c.events || []).slice(-5).map((e) =>
    `<div class="story-event"><span class="event-date">${escapeHtml(e.date || '')}</span> · <b>${EVENT_LABEL[e.type] || escapeHtml(e.type || '')}</b>${e.nodeId ? ` · 节点 ${escapeHtml(e.nodeId)}` : ''}：${escapeHtml(e.detail || '')}</div>`
  ).join('');
  return `<details class="story-card">
  <summary class="story-summary">
    <span class="story-theme">${escapeHtml(c.theme || '（未命名主题）')}</span>
    <span class="story-head">
      <span class="story-chain-id">${escapeHtml(c.chainId)}</span>
      ${storyStatusBadge(c.status)}
      <span class="story-dir">${dir}</span>
      <span class="story-sector">板块 ${escapeHtml(c.sector || '—')}</span>
      <span class="story-rep">代表 ${escapeHtml(c.representative || '—')}</span>
      <span class="story-proof">证明点 p=${c.entryProofIndex ?? '—'} · ${confirmed}/${total} 节点已确认${unresolved}</span>
      ${(c.seats || []).length ? `<span class="story-seats">席位血缘：${c.seats.map((s) => `${escapeHtml(s.runId)} → ${escapeHtml(s.symbol)}`).join('、')}</span>` : ''}
      ${c.linkedSignalId ? `<span class="story-link">→ 信号 ${escapeHtml(c.linkedSignalId)}</span>` : ''}
    </span>
  </summary>
  <div class="story-body">
    <div class="story-progress"><div class="story-progress-fill" style="width:${total ? Math.round(confirmed / total * 100) : 0}%"></div></div>
    <div class="story-nodes">${(c.nodes || []).map(nodeRow).join('')}</div>
    <div class="story-events">${events || '<span class="muted">暂无事件</span>'}</div>
  </div>
</details>`;
}

function closedTable(closed) {
  if (!closed || closed.length === 0) return '<p class="muted">暂无已出池故事。</p>';
  const rows = closed.map((c) => `<tr>
    <td class="closed-theme">${escapeHtml(c.theme || '（未命名主题）')}<div class="muted">${escapeHtml(c.chainId)}</div></td>
    <td>${escapeHtml(c.sector)}</td><td>${storyStatusBadge(c.status)}</td>
    <td>${c.proven ? '✅' : '—'}</td><td>${c.confirmedNodes}/${c.totalNodes}</td>
    <td>${escapeHtml(c.closeReason || '—')}</td><td>${escapeHtml(c.createdAt)} → ${escapeHtml(c.closedAt || '—')}</td>
  </tr>`).join('');
  return `<table class="stats"><tr><th>主题</th><th>板块</th><th>终态</th><th>曾证明</th><th>节点</th><th>出池原因</th><th>生命周期</th></tr>${rows}</table>`;
}

function pathStatsTable(stats) {
  const p = stats.nodeHitRateByPath || {};
  const rows = Object.entries(p).map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${v.evaluated}</td><td>${v.confirmed}</td><td>${v.evaluated ? (v.confirmed / v.evaluated * 100).toFixed(0) + '%' : '—'}</td></tr>`).join('');
  return `<table class="stats"><tr><th>路径</th><th>已评估节点</th><th>确认</th><th>命中率</th></tr>${rows || '<tr><td colspan="4" class="muted">暂无节点评估</td></tr>'}</table>`;
}

function credStatsTable(stats) {
  const c = stats.confirmedCredibility || {};
  return `<table class="stats"><tr><th>可信度</th><th>已确认节点数</th></tr>
    <tr><td>高</td><td>${c.high || 0}</td></tr><tr><td>中</td><td>${c.medium || 0}</td></tr>
    <tr><td>低</td><td>${c.low || 0}</td></tr><tr><td>未知</td><td>${c.unknown || 0}</td></tr></table>`;
}

function storyPoolHtml(view) {
  const stats = view && view.stats ? view.stats : {};
  const active = view && Array.isArray(view.active) ? view.active : [];
  const closed = view && Array.isArray(view.recentClosed) ? view.recentClosed : [];
  return `
  <div class="summary-bar">
    <span class="stat"><span class="stat-icon blue">🔗</span><span class="stat-meta"><b>${stats.totalChains || 0}</b><span>故事总数</span></span></span>
    <span class="stat"><span class="stat-icon blue">🔍</span><span class="stat-meta"><b>${stats.resolvingChains || 0}</b><span>解析中</span></span></span>
    <span class="stat"><span class="stat-icon green">✅</span><span class="stat-meta"><b>${stats.provenChains || 0}</b><span>曾证明</span></span></span>
    <span class="stat"><span class="stat-icon red">❌</span><span class="stat-meta"><b>${stats.falsifiedChains || 0}</b><span>证伪</span></span></span>
    <span class="stat"><span class="stat-icon gray">🎯</span><span class="stat-meta"><b>${stats.nodeHitRate != null ? (stats.nodeHitRate * 100).toFixed(0) + '%' : '—'}</b><span>节点命中率</span></span></span>
  </div>
  <div class="pool-layout">
    <div class="pool-main">
      <h2>活跃故事（点击标题折叠/展开）</h2>
      ${active.map(chainCard).join('') || '<p class="muted">当前故事池为空——没有清晰传导逻辑的板块不注册。</p>'}
      <h2>最近出池故事（最新 20 条）</h2>
      ${closedTable(closed)}
    </div>
    <aside class="pool-side">
      <div class="side-card"><h3>节点命中率（按取数路径）</h3>${pathStatsTable(stats)}</div>
      <div class="side-card"><h3>已确认节点可信度分布</h3>${credStatsTable(stats)}</div>
      <div class="side-card"><h3>口径说明</h3><ul class="side-notes">
        <li>链 = 1 主题 + ≥2 节点 + ≥1 顺序边 + 1 板块 + 1 代表品种 + 1 方向 + 自声明证明点 p</li>
        <li>证明按前缀顺序；任一边反向/超时即证伪；p 达标前只观察不下注</li>
        <li>当前值 = 节点指标最近一次观测值（T0 每日更新 / T2 为解析快照）</li>
        <li>T0 文件库稳定源 / T2 WebSearch 检索源（取数路径 ≠ 可信度）</li>
        <li>proven 链下期进入生产席位，经策略计划进入信号池前向验证（linkedSignalId 回链）</li>
      </ul></div>
    </aside>
  </div>`;
}

module.exports = { storyPoolHtml, escapeHtml };
