// output/render-ticket-html.cjs — 共享「交易单」视图组件
//
// 按交易执行员的阅读顺序设计：先看方向/合约，再按行看
// 生效条件 → 入场 → 止损 → 目标 → 最长持有 → 证伪。
// 视觉保持整齐：统一字号、统一标签列宽、关键数字只加粗不放大。

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

  const row = (label, value) => `<div class="ticket-row"><span class="ticket-label">${label}</span><span class="ticket-value">${value}</span></div>`;

  const activation = [
    v.activation || '—',
    v.confirmation ? `确认：${v.confirmation}` : null,
    v.activationLevel != null ? `触发位 ${fmt(v.activationLevel)}` : null
  ].filter(Boolean).join('；');

  const entry = [v.entry || '—', v.abandon || null].filter(Boolean).join('；');
  const stop = `${v.stopPrice != null ? `<b>${fmt(v.stopPrice)}</b>` : '—'}${v.stopBasis ? `（${escapeHtml(v.stopBasis)}）` : ''}`;
  const targets = `${v.t1 || '—'}${v.t2 ? ` → ${v.t2}` : ''}${v.targetsBasis ? `（${escapeHtml(v.targetsBasis)}）` : ''}`;
  const invalidation = Array.isArray(v.invalidation) && v.invalidation.length ? v.invalidation.join('；') : '—';

  return `<div class="ticket-view">
    <div class="ticket-head">
      <span class="ticket-dir ${dirCls}">${dirText}</span>
      <b class="ticket-contract">${escapeHtml(v.contract || v.symbol || '—')}</b>
      <span class="ticket-state">${escapeHtml(v.state || '')}</span>
    </div>
    <div class="ticket-rows">
      ${row('生效条件', escapeHtml(activation))}
      ${row('入场', escapeHtml(entry))}
      ${row('止损', stop)}
      ${row('目标', escapeHtml(targets))}
      ${row('最长持有', escapeHtml(v.maxHold || '—'))}
      ${row('证伪', escapeHtml(invalidation))}
      ${v.riskLine ? row('风险', escapeHtml(v.riskLine)) : ''}
    </div>
  </div>`;
}

module.exports = { ticketViewHtml, escapeHtml };
