import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ticketViewHtml, escapeHtml } = require('../output/render-ticket-html.cjs');

describe('render-ticket-html 共享交易单视图', () => {
  it('渲染方向、生效条件、确认、关键价位、入场与放弃条款', () => {
    const html = ticketViewHtml({
      direction: 'bearish',
      contract: 'RB2701',
      state: '生效观察',
      activation: '反抽至 3119 下方不破',
      activationLevel: 3119,
      confirmation: 'T+1 收盘仍位于 3119 下方',
      entry: 'T+2 开盘入场',
      abandon: '偏离 >0.5×ATR5 放弃',
      stopPrice: 3132,
      stopBasis: '收盘站回价值区上沿',
      t1: '3065',
      t2: '3034',
      maxHold: 'T+5 未到目标市价离场',
      invalidation: ['收盘站上 3132'],
      riskLine: ''
    });
    assert.ok(html.includes('ticket-view'));
    assert.ok(html.includes('>空</span>'));
    assert.ok(html.includes('RB2701'));
    assert.ok(html.includes('生效条件'));
    assert.ok(html.includes('反抽至 3119 下方不破'));
    assert.ok(html.includes('确认：T+1 收盘仍位于 3119 下方'));
    assert.ok(html.includes('T+2 开盘入场'));
    assert.ok(html.includes('偏离 &gt;0.5×ATR5 放弃'));
    assert.ok(html.includes('3132'));
    assert.ok(html.includes('3065'));
    assert.ok(html.includes('T+5 未到目标市价离场'));
    assert.ok(html.includes('收盘站上 3132'));
  });

  it('escapeHtml 转义 HTML 特殊字符', () => {
    assert.equal(escapeHtml('<a href="x">'), '&lt;a href=&quot;x&quot;&gt;');
  });
});
