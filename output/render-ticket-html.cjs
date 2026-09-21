// output/render-ticket-html.cjs — 共享「交易单」视图组件
//
// 机会分析 tab 与信号池 tab 的交易策略都渲染同一份要素：
// 方向 → 生效条件（含确认与关键价位）→ 入场 → 止损/目标/最长持有 → 证伪。
// 输入是交易单要素视图模型，不再是 plan.entry 的字段列表。

'use strict';

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmt(x, d = 0) {
  if (x === null || x === undefined || !Number.isFinite(Number(x))) return '—';
  return Number(x).toFixed(d);
}

function ticketViewHtml(v) {
  const dir = v.direction;
  const dirCls = dir === 'bullish' ? 'up' : dir === 'bearish' ? 'down' : '';
  const dirText = dir === 'bullish' ? '多' : dir === 'bearish' ? '空' : '观察';
  const stopHtml = v.stopPrice != null
    ? `<b class="ticket-price ${dir === 'bullish' ? 'down' : 'up'}">${fmt(v.stopPrice)}</b>${v.stopBasis ? `<small>${escapeHtml(v.stopBasis)}</small>` : ''}`
    : '—';
  const targetHtml = `${v.t1 || '—'}${v.t2 ? ` → ${v.t2}` : ''}${v.targetsBasis ? `<small>${escapeHtml(v.targetsBasis)}</small>` : ''}`;
  return `<div class="ticket-view">
    <div class="ticket-head">
      <span class="ticket-dir ${dirCls}">${dirText}</span>
      <b class="ticket-contract">${escapeHtml(v.contract || v.symbol || '—')}</b>
      <span class="ticket-state">${escapeHtml(v.state || '')}</span>
    </div>
    <div class="ticket-active">
      <div class="ticket-active-main">${escapeHtml(v.activation || '—')}</div>
      ${v.confirmation ? `<div class="ticket-active-confirm">确认：${escapeHtml(v.confirmation)}</div>` : ''}
      ${v.activationLevel != null ? `<div class="ticket-active-level">关键价位 <b>${fmt(v.activationLevel)}</b></div>` : ''}
    </div>
    <div class="ticket-entry-line">
      <span>入场</span>
      <div class="ticket-entry-main">${escapeHtml(v.entry || '—')}${v.abandon ? `<span class="ticket-abandon">${escapeHtml(v.abandon)}</span>` : ''}</div>
    </div>
    <div class="ticket-params">
      <div class="ticket-param ticket-stop"><span>止损</span>${stopHtml}</div>
      <div class="ticket-param ticket-target"><span>目标</span><div>${targetHtml}</div></div>
      <div class="ticket-param ticket-hold"><span>最长持有</span><div>${escapeHtml(v.maxHold || '—')}</div></div>
    </div>
    ${Array.isArray(v.invalidation) && v.invalidation.length ? `<div class="ticket-inval"><span>证伪</span><div>${escapeHtml(v.invalidation.join('；'))}</div></div>` : ''}
    ${v.riskLine ? `<div class="ticket-risk">${escapeHtml(v.riskLine)}</div>` : ''}
  </div>`;
}

module.exports = { ticketViewHtml, escapeHtml };
