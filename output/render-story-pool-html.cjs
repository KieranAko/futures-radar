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

function short(s, n) {
  const t = String(s ?? '');
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function jsonAttr(obj) {
  return JSON.stringify(obj).replace(/'/g, '&#39;');
}

function computeLayers(nodes, edges) {
  const ids = nodes.map((n) => n.id);
  const indeg = new Map(ids.map((id) => [id, 0]));
  const adj = new Map(ids.map((id) => [id, []]));
  for (const e of edges || []) {
    if (!e || !e.from || !e.to) continue;
    indeg.set(e.to, (indeg.get(e.to) || 0) + 1);
    adj.get(e.from).push(e.to);
  }
  const depth = new Map();
  const queue = ids.filter((id) => indeg.get(id) === 0);
  queue.forEach((id) => depth.set(id, 0));
  while (queue.length) {
    const id = queue.shift();
    for (const to of adj.get(id) || []) {
      indeg.set(to, indeg.get(to) - 1);
      depth.set(to, Math.max(depth.get(to) || 0, (depth.get(id) || 0) + 1));
      if (indeg.get(to) === 0) queue.push(to);
    }
  }
  if (depth.size !== ids.length) ids.forEach((id, i) => depth.set(id, depth.has(id) ? depth.get(id) : i));
  const layers = new Map();
  for (const id of ids) {
    const d = depth.get(id);
    if (!layers.has(d)) layers.set(d, []);
    layers.get(d).push(id);
  }
  return { depth, layers };
}

function nodeSvg(n, x, y, sourceId, markerId, idPrefix = '') {
  const w = 196, h = 66;
  const isSource = n.id === sourceId;
  const isTerminal = !!n.terminal;
  const status = n.status || 'pending';
  let fill, stroke, text;
  if (status === 'broken') { fill = '#fef2f2'; stroke = '#b91c1c'; text = '#7f1d1d'; }
  else if (status === 'confirmed') { fill = '#ecfdf5'; stroke = '#047857'; text = '#065f46'; }
  else if (isTerminal && n.priority === 'primary') { fill = '#eef2ff'; stroke = '#6366f1'; text = '#3730a3'; }
  else if (isTerminal && n.priority === 'secondary') { fill = '#f3f4f6'; stroke = '#9ca3af'; text = '#374151'; }
  else if (isSource) { fill = '#1f2937'; stroke = '#1f2937'; text = '#ffffff'; }
  else { fill = '#f8fafc'; stroke = '#cbd5e1'; text = '#334155'; }
  const label = n.label || n.id;
  const sub = n.indicatorId || n.concept || '';
  const dir = n.expectation === 1 ? '↑' : n.expectation === -1 ? '↓' : '';
  const statusShort = status === 'confirmed' ? '✔' : status === 'broken' ? '✘' : '·';
  return `<g class="sg-node" data-id="${escapeHtml(idPrefix + n.id)}" transform="translate(${x},${y})" style="cursor:pointer">
    <rect width="${w}" height="${h}" rx="10" fill="${fill}" stroke="${stroke}" stroke-width="${isTerminal ? 2.5 : 1.5}"></rect>
    <text x="12" y="25" font-size="13" font-weight="700" fill="${text}">${escapeHtml(short(label, 12))}</text>
    <text x="12" y="43" font-size="10" fill="${text}" opacity="0.78">${escapeHtml(short(sub, 24))}</text>
    <text x="${w - 12}" y="25" font-size="12" fill="${text}" text-anchor="end">${dir}${statusShort}</text>
    ${isTerminal ? `<text x="12" y="58" font-size="10" fill="${text}" opacity="0.95">${n.priority === 'primary' ? '主支' : '次支'} · p=${n.proofIndex ?? '—'}</text>` : ''}
  </g>`;
}

function edgeSvg(e, fromPos, toPos, markerId) {
  const x1 = fromPos.x + 196, y1 = fromPos.y + 33;
  const x2 = toPos.x, y2 = toPos.y + 33;
  const dx = Math.max(42, (x2 - x1) * 0.45);
  return `<path class="sg-edge" data-from="${escapeHtml(e.from)}" data-to="${escapeHtml(e.to)}" d="M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}" fill="none" stroke="#94a3b8" stroke-width="1.6" marker-end="url(#${markerId})"></path>`;
}

function storyGraphHtml(c) {
  const nodes = c.nodes || [];
  const edges = c.edges || [];
  const sourceId = nodes[0] && nodes[0].id;
  const { layers } = computeLayers(nodes, edges);
  const nodeW = 196, nodeH = 66, gapX = 164, gapY = 20;
  const maxLayer = Math.max(...[...layers.keys()].map(Number));
  const maxCount = Math.max(...[...layers.values()].map((a) => a.length));
  const svgW = Math.max(420, (maxLayer + 1) * (nodeW + gapX) + 16);
  const svgH = Math.max(110, maxCount * (nodeH + gapY) + 16);
  const pos = new Map();
  for (const [d, ids] of layers) {
    ids.forEach((id, i) => {
      pos.set(id, { x: 10 + Number(d) * (nodeW + gapX), y: 10 + i * (nodeH + gapY) });
    });
  }
  const markerId = `sg-arrow-${String(c.chainId).replace(/[^A-Za-z0-9_-]/g, '')}`;
  const svgNodes = nodes.map((n) => nodeSvg(n, pos.get(n.id).x, pos.get(n.id).y, sourceId, markerId));
  const svgEdges = edges.map((e) => edgeSvg(e, pos.get(e.from), pos.get(e.to), markerId));
  const graphNodes = nodes.map((n) => ({
    id: n.id, label: n.label || n.id, indicatorId: n.indicatorId || n.concept || '',
    status: n.status, terminal: !!n.terminal, priority: n.priority || null, proofIndex: n.proofIndex ?? null,
    expectation: n.expectation, credibility: n.credibility, unit: n.unit || '',
    lastValue: n.lastValue ?? null, lastValueAt: n.lastValueAt || null,
    prevValue: n.prevValue ?? null, prevValueAt: n.prevValueAt || null,
    observedAt: n.observedAt || null, windowStartDate: n.windowStartDate || null,
    windowDeadlineDate: n.windowDeadlineDate || null, brokenReason: n.brokenReason || null,
  }));
  const graphEdges = edges.map((e) => ({ from: e.from, to: e.to, logic: e.logic || '', latencyDays: e.latencyDays }));
  return `<div class="story-graph" data-nodes='${jsonAttr(graphNodes)}' data-edges='${jsonAttr(graphEdges)}'>
    <svg viewBox="0 0 ${svgW} ${svgH}" class="sg-svg">
      <defs><marker id="${markerId}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#94a3b8"></path></marker></defs>
      ${svgEdges.join('')}
      ${svgNodes.join('')}
    </svg>
    <div class="sg-detail"></div>
  </div>`;
}

function branchSummaryHtml(c) {
  const branches = (c.branches && c.branches.length > 0)
    ? c.branches
    : [{ branchId: null, symbol: c.representative, direction: c.direction, priority: 'primary', status: c.status, proofIndex: c.entryProofIndex, impactRationale: null }];
  const rows = branches.map((b) => {
    const bDir = b.direction === -1 ? '空' : b.direction === 1 ? '多' : '—';
    return `<tr>
      <td><span class="branch-priority ${b.priority === 'primary' ? 'bp-primary' : 'bp-secondary'}">${b.priority === 'primary' ? '主支' : '次支'}</span></td>
      <td><b>${escapeHtml(b.symbol || '—')}</b></td>
      <td>${bDir}</td>
      <td>${escapeHtml(b.status || '—')}</td>
      <td>${b.proofIndex != null ? `p=${b.proofIndex}` : '—'}</td>
      <td class="muted">${escapeHtml(b.impactRationale || '—')}</td>
    </tr>`;
  }).join('');
  return `<table class="branch-table"><thead><tr><th>分支</th><th>品种</th><th>方向</th><th>状态</th><th>证明</th><th>为什么是这里</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function graphScript() {
  return `<script>
(function () {
  function short(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  function byId(nodes, id) { return nodes.find(function (n) { return n.id === id; }); }
  function setOf(ids) { var s = {}; ids.forEach(function (id) { s[id] = 1; }); return s; }
  function ancestors(id, edges) {
    var out = [id], seen = setOf(out), changed = true;
    while (changed) {
      changed = false;
      edges.forEach(function (e) {
        if (seen[e.to] && !seen[e.from]) { seen[e.from] = 1; out.push(e.from); changed = true; }
      });
    }
    return out;
  }
  function descendants(id, edges) {
    var out = [id], seen = setOf(out), changed = true;
    while (changed) {
      changed = false;
      edges.forEach(function (e) {
        if (seen[e.from] && !seen[e.to]) { seen[e.to] = 1; out.push(e.to); changed = true; }
      });
    }
    return out;
  }
  document.querySelectorAll('.story-graph').forEach(function (g) {
    var nodes, edges, detail;
    try { nodes = JSON.parse(g.getAttribute('data-nodes')); edges = JSON.parse(g.getAttribute('data-edges')); } catch (e) { return; }
    var nodeEls = g.querySelectorAll('.sg-node');
    var edgeEls = g.querySelectorAll('.sg-edge');
    detail = g.querySelector('.sg-detail');
    function clearDim() {
      nodeEls.forEach(function (n) { n.classList.remove('sg-dim'); });
      edgeEls.forEach(function (e) { e.classList.remove('sg-dim'); });
    }
    function highlightPath(id) {
      var pathIds = setOf(ancestors(id, edges).concat(descendants(id, edges)));
      nodeEls.forEach(function (n) { n.classList.toggle('sg-dim', !pathIds[n.getAttribute('data-id')]); });
      edgeEls.forEach(function (e) {
        var on = pathIds[e.getAttribute('data-from')] && pathIds[e.getAttribute('data-to')];
        e.classList.toggle('sg-dim', !on);
      });
    }
    function showNodeDetail(n) {
      var rows = [];
      rows.push('<div class="sg-detail-head"><b>' + short(n.label, 20) + '</b><button class="sg-detail-close" aria-label="关闭">×</button></div>');
      if (n.theme) rows.push('<div class="sg-detail-row"><span>故事</span><b>' + short(n.theme, 20) + '</b></div>');
      rows.push('<div class="sg-detail-row"><span>状态</span><b>' + short(n.status, 10) + (n.terminal ? ' · ' + (n.priority === 'primary' ? '主支' : '次支') : '') + '</b></div>');
      rows.push('<div class="sg-detail-row"><span>方向</span><b>' + (n.expectation === 1 ? '预期 ↑' : n.expectation === -1 ? '预期 ↓' : '—') + '</b></div>');
      if (n.lastValue != null) rows.push('<div class="sg-detail-row"><span>当前值</span><b>' + n.lastValue + (n.unit ? ' ' + n.unit : '') + '（' + short(n.lastValueAt, 10) + '）</b></div>');
      if (n.brokenReason) rows.push('<div class="sg-detail-row"><span>断裂原因</span><b>' + short(n.brokenReason, 24) + '</b></div>');
      rows.push('<div class="sg-detail-note">完整字段见下方「节点明细」</div>');
      detail.innerHTML = '<div class="sg-detail-card">' + rows.join('') + '</div>';
    }
    function showEdgeDetail(e, from, to) {
      detail.innerHTML = '<div class="sg-detail-card">'
        + '<div class="sg-detail-head"><b>传导边 ' + short(from.label, 10) + ' → ' + short(to.label, 10) + '</b><button class="sg-detail-close" aria-label="关闭">×</button></div>'
        + '<div class="sg-detail-row"><span>逻辑</span><b>' + short(e.logic, 60) + '</b></div>'
        + '<div class="sg-detail-row"><span>时间窗</span><b>' + e.latencyDays + ' 个交易日</b></div>'
        + '</div>';
    }
    g._highlight = highlightPath;
    g._clear = clearDim;
    nodeEls.forEach(function (n) {
      n.addEventListener('mouseenter', function () { highlightPath(n.getAttribute('data-id')); });
      n.addEventListener('mouseleave', clearDim);
      n.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var node = byId(nodes, n.getAttribute('data-id'));
        if (node) showNodeDetail(node);
      });
    });
    edgeEls.forEach(function (e) {
      e.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var from = byId(nodes, e.getAttribute('data-from'));
        var to = byId(nodes, e.getAttribute('data-to'));
        var edge = edges.find(function (x) { return x.from === e.getAttribute('data-from') && x.to === e.getAttribute('data-to'); });
        if (edge && from && to) showEdgeDetail(edge, from, to);
      });
    });
    g.addEventListener('click', function (ev) {
      if (ev.target && ev.target.classList && ev.target.classList.contains('sg-detail-close')) { detail.innerHTML = ''; }
    });
  });

  document.querySelectorAll('.branch-row').forEach(function (row) {
    row.addEventListener('click', function () {
      var graph = document.querySelector('.story-graph-market');
      if (!graph || !graph._highlight) return;
      var nid = row.getAttribute('data-graph-node');
      graph._highlight(nid);
      if (graph.scrollIntoView) graph.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  });

  function openModal(id) { var m = document.getElementById('story-modal-' + id); if (m) m.classList.add('open'); }
  function closeModal(m) { if (m) m.classList.remove('open'); }
  document.querySelectorAll('.story-detail-btn, .closed-detail-btn').forEach(function (btn) {
    btn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      openModal(btn.getAttribute('data-chain-id'));
    });
  });
  document.querySelectorAll('.story-modal-close').forEach(function (btn) {
    btn.addEventListener('click', function () { closeModal(btn.closest('.story-modal')); });
  });
  document.querySelectorAll('.story-modal-backdrop').forEach(function (bd) {
    bd.addEventListener('click', function () { closeModal(bd.closest('.story-modal')); });
  });
})();
</script>`;
}

function chainNodesAndEdges(c) {
  return { nodes: c.nodes || [], edges: c.edges || [] };
}

function pathToTerminal(c, branchId) {
  const { nodes, edges } = chainNodesAndEdges(c);
  const target = branchId || (c.branches && c.branches[0] && c.branches[0].branchId) || (nodes[nodes.length - 1] && nodes[nodes.length - 1].id);
  const source = nodes[0] && nodes[0].id;
  if (!target || !source) return [];
  const adj = new Map(nodes.map((n) => [n.id, []]));
  for (const e of edges || []) if (adj.has(e.from)) adj.get(e.from).push(e.to);
  const prev = new Map();
  const q = [source]; prev.set(source, null);
  while (q.length) {
    const id = q.shift();
    if (id === target) break;
    for (const to of adj.get(id) || []) if (!prev.has(to)) { prev.set(to, id); q.push(to); }
  }
  if (!prev.has(target)) return [];
  const path = [];
  let cur = target;
  while (cur) { path.unshift(cur); cur = prev.get(cur); }
  return path.map((id) => nodes.find((n) => n.id === id)).filter(Boolean);
}

function branchTableHtml(active) {
  const rows = [];
  for (const c of active || []) {
    const branches = (c.branches && c.branches.length > 0) ? c.branches : [];
    for (const b of branches) {
      const path = pathToTerminal(c, b.branchId);
      const pathText = path.map((n) => n.label || n.id).join(' → ');
      rows.push({ c, b, pathText });
    }
  }
  const trs = rows.map(({ c, b, pathText }) => {
    const bDir = b.direction === -1 ? '空' : b.direction === 1 ? '多' : '—';
    const graphNodeId = `${c.chainId}::${b.branchId || ''}`;
    return `<tr class="branch-row" data-graph-node="${escapeHtml(graphNodeId)}" data-chain-id="${escapeHtml(c.chainId)}">
      <td><span class="branch-priority ${b.priority === 'primary' ? 'bp-primary' : 'bp-secondary'}">${b.priority === 'primary' ? '主支' : '次支'}</span></td>
      <td class="muted">${escapeHtml(c.sourceId || '—')}</td>
      <td>${escapeHtml(pathText || '—')}</td>
      <td><b>${escapeHtml(b.symbol || '—')}</b></td>
      <td>${bDir}</td>
      <td>${escapeHtml(b.status || '—')}</td>
      <td>${b.proofIndex != null ? `p=${b.proofIndex}` : '—'}</td>
      <td class="muted">${escapeHtml(b.impactRationale || '—')}</td>
      <td><button class="story-detail-btn" data-chain-id="${escapeHtml(c.chainId)}" title="查看故事详情">详情</button></td>
    </tr>`;
  }).join('');
  return `<table class="branch-table branch-table-wide">
    <thead><tr><th>分支</th><th>源</th><th>传导路径</th><th>终点</th><th>方向</th><th>状态</th><th>证明</th><th>为什么是这里</th><th></th></tr></thead>
    <tbody>${trs || '<tr><td colspan="9" class="muted">当前故事池为空</td></tr>'}</tbody></table>`;
}

function marketMapHtml(active) {
  const chains = active || [];
  const nodeW = 196, nodeH = 66, gapX = 164, gapY = 20;
  // 全局分层：每列一个 depth，跨链纵向堆叠
  const colItems = new Map();
  const colCounts = new Map();
  const positions = new Map();
  const nodesOut = [];
  const edgesOut = [];
  for (const c of chains) {
    const { nodes, edges } = chainNodesAndEdges(c);
    const { layers } = computeLayers(nodes, edges);
    for (const [d, ids] of layers) {
      if (!colItems.has(Number(d))) colItems.set(Number(d), []);
      for (const id of ids) colItems.get(Number(d)).push({ c, id });
    }
    for (const e of edges || []) edgesOut.push({ c, e });
  }
  const maxDepth = Math.max(0, ...[...colItems.keys()].map(Number));
  const columns = [];
  for (let d = 0; d <= maxDepth; d++) columns.push(colItems.get(d) || []);
  const colHeight = columns.map((items) => items.length * (nodeH + gapY) + 12);
  const svgH = Math.max(120, ...colHeight);
  const svgW = Math.max(420, (maxDepth + 1) * (nodeW + gapX) + 16);
  columns.forEach((items, d) => {
    items.forEach((item, i) => {
      positions.set(`${item.c.chainId}::${item.id}`, { x: 10 + d * (nodeW + gapX), y: 10 + i * (nodeH + gapY) });
    });
  });
  const markerId = 'sg-arrow-market';
  const edgesSvg = [];
  for (const { c, e } of edgesOut) {
    const from = positions.get(`${c.chainId}::${e.from}`);
    const to = positions.get(`${c.chainId}::${e.to}`);
    if (!from || !to) continue;
    const x1 = from.x + nodeW, y1 = from.y + nodeH / 2;
    const x2 = to.x, y2 = to.y + nodeH / 2;
    const dx = Math.max(42, (x2 - x1) * 0.45);
    edgesSvg.push(`<path class="sg-edge" data-from="${escapeHtml(c.chainId + '::' + e.from)}" data-to="${escapeHtml(c.chainId + '::' + e.to)}" d="M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}" fill="none" stroke="#94a3b8" stroke-width="1.6" marker-end="url(#${markerId})"></path>`);
  }
  const nodeSvgList = [];
  for (const c of chains) {
    const { nodes } = chainNodesAndEdges(c);
    for (const n of nodes) {
      const p = positions.get(`${c.chainId}::${n.id}`);
      if (!p) continue;
      nodeSvgList.push(nodeSvg(n, p.x, p.y, nodes[0] && nodes[0].id, markerId, `${c.chainId}::`));
    }
  }
  // 构建 data 节点/边（带 chainId 前缀）
  const graphNodes = [];
  for (const c of chains) {
    const { nodes } = chainNodesAndEdges(c);
    for (const n of nodes) {
      graphNodes.push({
        id: `${c.chainId}::${n.id}`, chainId: c.chainId, theme: c.theme || '',
        label: n.label || n.id, indicatorId: n.indicatorId || n.concept || '',
        status: n.status, terminal: !!n.terminal, priority: n.priority || null, proofIndex: n.proofIndex ?? null,
        expectation: n.expectation, credibility: n.credibility, unit: n.unit || '',
        lastValue: n.lastValue ?? null, lastValueAt: n.lastValueAt || null,
        prevValue: n.prevValue ?? null, prevValueAt: n.prevValueAt || null,
        observedAt: n.observedAt || null, windowStartDate: n.windowStartDate || null,
        windowDeadlineDate: n.windowDeadlineDate || null, brokenReason: n.brokenReason || null,
      });
    }
  }
  const graphEdges = [];
  for (const { c, e } of edgesOut) {
    graphEdges.push({ from: `${c.chainId}::${e.from}`, to: `${c.chainId}::${e.to}`, logic: e.logic || '', latencyDays: e.latencyDays });
  }
  return `<div class="story-graph story-graph-market" data-nodes='${jsonAttr(graphNodes)}' data-edges='${jsonAttr(graphEdges)}'>
    <svg viewBox="0 0 ${svgW} ${svgH}" class="sg-svg">
      <defs><marker id="${markerId}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#94a3b8"></path></marker></defs>
      ${edgesSvg.join('')}
      ${nodeSvgList.join('')}
    </svg>
    <div class="sg-detail"></div>
  </div>`;
}

function graphLegendHtml() {
  return `<div class="sg-legend">
    <span><i class="lg-dot lg-source"></i>源</span>
    <span><i class="lg-dot lg-mid"></i>中间</span>
    <span><i class="lg-dot lg-primary"></i>主支终点</span>
    <span><i class="lg-dot lg-secondary"></i>次支终点</span>
    <span><i class="lg-dot lg-confirmed"></i>已确认</span>
    <span><i class="lg-dot lg-broken"></i>已断裂</span>
  </div>`;
}

function chainCard(c) {
  const confirmed = (c.nodes || []).filter((n) => n.status === 'confirmed').length;
  const total = c.nodes ? c.nodes.length : 0;
  const dir = c.direction === -1 ? '🔻 空' : c.direction === 1 ? '🔺 多' : '—';
  const unresolved = c.unresolvedNodes ? ` · 🔍 未解析 ${c.unresolvedNodes}` : '';
  const branches = (c.branches && c.branches.length > 0)
    ? c.branches
    : [{ branchId: null, symbol: c.representative, direction: c.direction, priority: 'primary', status: c.status, proofIndex: c.entryProofIndex, impactRationale: null }];
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
      <span class="story-source">源 ${escapeHtml(c.sourceId || c.sector || '—')}</span>
      ${branches.map((b) => `<span class="story-rep">${escapeHtml(b.symbol || '—')} ${b.direction === -1 ? '空' : b.direction === 1 ? '多' : ''}</span>`).join('')}
      <span class="story-proof">确认 ${confirmed}/${total} 节点${unresolved}</span>
      ${(c.seats || []).length ? `<span class="story-seats">席位血缘：${c.seats.map((s) => `${escapeHtml(s.runId)} → ${escapeHtml(s.symbol)}`).join('、')}</span>` : ''}
      ${c.linkedSignalId ? `<span class="story-link">→ 信号 ${escapeHtml(c.linkedSignalId)}</span>` : ''}
    </span>
  </summary>
  <div class="story-body">
    ${c.themeDetail ? `<div class="story-subtitle">${escapeHtml(c.themeDetail)}</div>` : ''}
    ${graphLegendHtml()}
    ${storyGraphHtml(c)}
    ${branchSummaryHtml(c)}
    <details class="story-sub-detail">
      <summary>节点明细（${c.nodes ? c.nodes.length : 0}）</summary>
      <div class="story-nodes">${(c.nodes || []).map(nodeRow).join('')}</div>
    </details>
    <details class="story-sub-detail">
      <summary>最近事件（${(c.events || []).slice(-5).length}）</summary>
      <div class="story-events">${events || '<span class="muted">暂无事件</span>'}</div>
    </details>
  </div>
</details>`;
}

function closedTable(closed) {
  if (!closed || closed.length === 0) return '<p class="muted">暂无已出池故事。</p>';
  const rows = closed.map((c) => `<tr>
    <td class="closed-theme"><button class="closed-detail-btn" data-chain-id="${escapeHtml(c.chainId)}">${escapeHtml(c.theme || '（未命名主题）')}</button><div class="muted">${escapeHtml(c.chainId)}</div></td>
    <td>${escapeHtml(c.sector || '—')}</td><td>${storyStatusBadge(c.status)}</td>
    <td>${c.proven ? '✅' : '—'}</td><td>${c.confirmedNodes}/${c.totalNodes}</td>
    <td>${escapeHtml(c.closeReason || '—')}</td><td>${escapeHtml(c.createdAt)} → ${escapeHtml(c.closedAt || '—')}</td>
  </tr>`).join('');
  return `<div class="closed-table">
    <div class="closed-head-wrap"><table class="stats closed-head"><tr><th>主题</th><th>板块</th><th>终态</th><th>曾证明</th><th>节点</th><th>出池原因</th><th>生命周期</th></tr></table></div>
    <div class="closed-scroll"><table class="stats closed-body">${rows}</table></div>
  </div>`;
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

function activeChainModalHtml(c) {
  return `<div class="story-modal" id="story-modal-${escapeHtml(c.chainId)}">
    <div class="story-modal-backdrop"></div>
    <div class="story-modal-body">
      <button class="story-modal-close" data-chain-id="${escapeHtml(c.chainId)}" aria-label="关闭">×</button>
      ${chainCard(c)}
    </div>
  </div>`;
}

function closedChainModalHtml(c) {
  const nodes = (c.nodes || []).map((n) => `<div class="story-node ${nodeClass(n)}">
    <div class="node-line node-title"><span class="node-state">${n.status === 'confirmed' ? '✔' : n.status === 'broken' ? '✘' : '·'}</span><span class="node-label">${escapeHtml(n.label || n.id)}</span><span class="node-status">${NODE_STATUS_LABEL[n.status] || escapeHtml(n.status)}</span><span class="node-dir">${n.expectation === 1 ? '预期 ↑' : n.expectation === -1 ? '预期 ↓' : ''}</span></div>
    <div class="node-line node-values"><span class="node-value">前值 ${fmtVal(n.prevValue)}${n.prevValueAt ? `（${escapeHtml(n.prevValueAt)}）` : ''} → 当前 <b>${fmtVal(n.lastValue)}</b>${n.lastValueAt ? `（${escapeHtml(n.lastValueAt)}）` : ''} · 环比 <b>${Number.isFinite(Number(n.lastValue)) && Number.isFinite(Number(n.prevValue)) ? fmtSigned(Number(n.lastValue) - Number(n.prevValue)) : '—'}</b> ${escapeHtml(n.unit || '')}</span></div>
    <div class="node-line node-meta-line"><span class="node-meta">${escapeHtml(n.indicatorId || n.concept || '—')}</span><span class="node-path">${escapeHtml(n.resolution ? n.resolution.path : 'T0')}</span></div>
  </div>`).join('');
  const events = (c.events || []).slice(-5).map((e) => `<div class="story-event"><span class="event-date">${escapeHtml(e.date || '')}</span> · <b>${EVENT_LABEL[e.type] || escapeHtml(e.type || '')}</b>${e.nodeId ? ` · 节点 ${escapeHtml(e.nodeId)}` : ''}：${escapeHtml(e.detail || '')}</div>`).join('');
  return `<div class="story-modal" id="story-modal-${escapeHtml(c.chainId)}">
    <div class="story-modal-backdrop"></div>
    <div class="story-modal-body">
      <button class="story-modal-close" data-chain-id="${escapeHtml(c.chainId)}" aria-label="关闭">×</button>
      <div class="story-card" style="margin:0;border:none">
        <div class="story-summary">
          <span class="story-theme">${escapeHtml(c.theme || '（未命名主题）')}</span>
          <div class="story-subtitle">${escapeHtml(c.themeDetail || '')}</div>
          <div class="story-head"><span class="story-chain-id">${escapeHtml(c.chainId)}</span>${storyStatusBadge(c.status)}<span class="story-source">源 ${escapeHtml(c.sourceId || c.sector || '—')}</span><span class="story-proof">${c.confirmedNodes}/${c.totalNodes} 节点确认 · ${escapeHtml(c.closeReason || '—')}</span></div>
        </div>
        <div class="story-body"><div class="story-nodes">${nodes || '<span class="muted">暂无节点明细</span>'}</div><div class="story-events">${events || '<span class="muted">暂无事件</span>'}</div></div>
      </div>
    </div>
  </div>`;
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
      <h2>活跃故事传导总览</h2>
      ${active.length ? `${graphLegendHtml()}${marketMapHtml(active)}${branchTableHtml(active)}` : '<p class="muted">当前故事池为空——没有清晰传导逻辑的源头不注册。</p>'}
      <h2>最近出池故事（最新 20 条）</h2>
      ${closedTable(closed)}
    </div>
    <aside class="pool-side">
      <div class="side-card"><h3>节点命中率（按取数路径）</h3>${pathStatsTable(stats)}</div>
      <div class="side-card"><h3>已确认节点可信度分布</h3>${credStatsTable(stats)}</div>
      <div class="side-card"><h3>口径说明</h3><ul class="side-notes">
        <li>一条链 = 一个源 + 若干可观测节点 + 若干可交易终点（DAG，允许扇出/汇合）</li>
        <li>终点必须是冲击最大的可交易品种；分支独立证明/证伪</li>
        <li>当前值 = 节点指标最近一次观测值（T0 每日更新 / T2 为解析快照）</li>
        <li>T0 文件库稳定源 / T2 WebSearch 检索源（取数路径 ≠ 可信度）</li>
        <li>active 分支进入生产席位，按品种聚合 storyRefs 后深挖</li>
      </ul></div>
    </aside>
  </div>
  ${active.map(activeChainModalHtml).join('')}
  ${closed.map(closedChainModalHtml).join('')}
  ${graphScript()}`;
}

module.exports = { storyPoolHtml, escapeHtml };
