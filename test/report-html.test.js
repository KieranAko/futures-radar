import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mdToHtml, renderReportHtml, escapeHtml } = require('../output/render-report-html.cjs');

describe('report-html：md→HTML 轻量转换器', () => {
  it('标题/表格/列表/引用/分隔线/段落', () => {
    const md = [
      '# 标题一',
      '## 标题二',
      '| 品种 | 方向 |',
      '|------|------|',
      '| PP0 | 看多 |',
      '- 项目一',
      '- 项目二',
      '> 引用内容',
      '---',
      '普通段落'
    ].join('\n');
    const html = mdToHtml(md);
    assert.ok(html.includes('<h1>标题一</h1>'));
    assert.ok(html.includes('<h2>标题二</h2>'));
    assert.ok(html.includes('<table>'));
    assert.ok(html.includes('<td>看多</td>'));
    assert.ok(html.includes('<ul><li>项目一</li><li>项目二</li></ul>'));
    assert.ok(html.includes('<blockquote>引用内容</blockquote>'));
    assert.ok(html.includes('<hr>'));
    assert.ok(html.includes('<p>普通段落</p>'));
  });

  it('加粗与链接行内转换', () => {
    const html = mdToHtml('**加粗** [链接](http://x)');
    assert.ok(html.includes('<strong>加粗</strong>'));
    assert.ok(html.includes('<a href="http://x">链接</a>'));
  });

  it('原始 HTML 直通（信号池卡片表格）', () => {
    const html = mdToHtml('<table style="width:100%"><tr><td>x</td></tr></table>');
    assert.ok(html.includes('<table style="width:100%">'));
    assert.ok(html.includes('<td>x</td>'));
  });

  it('确定性：同输入两次输出一致', () => {
    const md = '# A\n\n| x |\n|---|\n| 1 |\n';
    assert.equal(mdToHtml(md), mdToHtml(md));
    assert.equal(renderReportHtml(md, { runId: 'r1' }), renderReportHtml(md, { runId: 'r1' }));
  });

  it('renderReportHtml 输出自包含文档与返回链接', () => {
    const html = renderReportHtml('# 报告', { runId: 'r1', backHref: '../../dashboard.html' });
    assert.ok(html.includes('<!doctype html>'));
    assert.ok(html.includes('<h1>报告</h1>'));
    assert.ok(html.includes('href="../../dashboard.html"'));
    assert.ok(!html.includes('<script src'));
    assert.ok(!html.includes('https://'));
  });

  it('escapeHtml 转义特殊字符', () => {
    assert.equal(escapeHtml('<a href="x">'), '&lt;a href=&quot;x&quot;&gt;');
  });
});
