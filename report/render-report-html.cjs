// report/render-report-html.cjs — 把 report.md 转为自包含 report.html（浏览器可读）
//
// 用法:
//   node report/render-report-html.cjs --runId <runId>
//
// 行为:
//   读 output/runs/<runId>/report.md → 轻量 md→HTML 转换 → 套阅读模板
//   → 写 output/runs/<runId>/report.html
//
// 只覆盖本项目报告使用的 Markdown 子集：
//   #/##/###/#### 标题、| 表格、- 列表、> 引用、--- 分隔线、
//   **加粗**、[链接](url)、行内 `代码`，以及以 < 开头的原始 HTML 直通。
//
// 纪律：确定性、不联网、不调用 LLM、无外部 CSS/JS 依赖。

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { runDir } = require('../lib/workspace.cjs');

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inlineMd(s) {
  let t = escapeHtml(s);
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  return t;
}

function tableCell(s) {
  return inlineMd(s.trim());
}

function tableBlock(lines) {
  const rows = [];
  for (const line of lines) {
    if (/^\s*\|?[\s:\-|]+\|?\s*$/.test(line) && /-/.test(line)) continue; // 分隔行
    const cells = line.replace(/^\|/, '').replace(/\|$/, '').split('|');
    rows.push(cells.map(tableCell));
  }
  if (rows.length === 0) return '';
  const thead = `<thead><tr>${rows[0].map((c) => `<th>${c}</th>`).join('')}</tr></thead>`;
  const tbody = `<tbody>${rows.slice(1).map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody>`;
  return `<div class="table-wrap"><table>${thead}${tbody}</table></div>`;
}

function listBlock(lines) {
  const items = lines.map((l) => `<li>${inlineMd(l.replace(/^-\s+/, ''))}</li>`).join('');
  return `<ul>${items}</ul>`;
}

function quoteBlock(lines) {
  const inner = lines.map((l) => inlineMd(l.replace(/^>\s?/, ''))).join('<br>');
  return `<blockquote>${inner}</blockquote>`;
}

function paragraphBlock(lines) {
  const inner = lines.map((l) => inlineMd(l)).join('<br>');
  return `<p>${inner}</p>`;
}

function mdToHtml(md) {
  const lines = String(md || '').split(/\r?\n/);
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === '') { i++; continue; }

    // 原始 HTML 直通（报告中的信号池卡片等内嵌 HTML）
    if (trimmed.startsWith('<')) {
      out.push(line);
      i++;
      continue;
    }

    // 标题
    const h = trimmed.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      out.push(`<h${level}>${inlineMd(h[2])}</h${level}>`);
      i++;
      continue;
    }

    // 分隔线
    if (/^-{3,}\s*$/.test(trimmed)) {
      out.push('<hr>');
      i++;
      continue;
    }

    // 表格
    if (trimmed.startsWith('|')) {
      const block = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        block.push(lines[i]);
        i++;
      }
      out.push(tableBlock(block));
      continue;
    }

    // 引用块
    if (trimmed.startsWith('>')) {
      const block = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        block.push(lines[i]);
        i++;
      }
      out.push(quoteBlock(block));
      continue;
    }

    // 列表
    if (/^-\s+/.test(trimmed)) {
      const block = [];
      while (i < lines.length && /^-\s+/.test(lines[i].trim())) {
        block.push(lines[i]);
        i++;
      }
      out.push(listBlock(block));
      continue;
    }

    // 普通段落
    const block = [];
    while (i < lines.length && lines[i].trim() !== '' && !/^(#{1,4}\s|\||>|-{3,}\s*$|-\s+)/.test(lines[i].trim()) && !lines[i].trim().startsWith('<')) {
      block.push(lines[i]);
      i++;
    }
    if (block.length > 0) out.push(paragraphBlock(block));
  }
  return out.join('\n');
}

function renderReportHtml(md, opts = {}) {
  const runId = opts.runId || '';
  const title = opts.title || `Futures Radar · ${runId}`;
  const body = mdToHtml(md);
  const backHref = opts.backHref || '../../dashboard.html';
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { --bg:#ffffff; --text:#1f2328; --muted:#6b7280; --border:#e5e7eb; --accent:#2563eb; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.7 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
  .topbar { position: sticky; top: 0; background: #f7f8fa; border-bottom: 1px solid var(--border); padding: 10px 20px; font-size: 13px; }
  .topbar a { color: var(--accent); text-decoration: none; }
  main { max-width: 960px; margin: 0 auto; padding: 20px 24px 60px; }
  h1 { font-size: 22px; border-bottom: 2px solid var(--border); padding-bottom: 8px; }
  h2 { font-size: 18px; margin-top: 28px; border-bottom: 1px solid var(--border); padding-bottom: 6px; }
  h3 { font-size: 16px; margin-top: 22px; }
  h4 { font-size: 15px; margin-top: 16px; }
  p { margin: 8px 0; }
  .table-wrap { overflow-x: auto; margin: 10px 0; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th, td { border: 1px solid var(--border); padding: 6px 10px; text-align: left; vertical-align: top; }
  th { background: #f7f8fa; font-weight: 600; white-space: nowrap; }
  blockquote { margin: 10px 0; padding: 8px 14px; border-left: 3px solid var(--accent); background: #f7f8fa; color: #374151; }
  ul { margin: 8px 0; padding-left: 24px; }
  hr { border: none; border-top: 1px solid var(--border); margin: 18px 0; }
  code { background: #f3f4f6; padding: 1px 5px; border-radius: 4px; font-size: 13px; }
  @media print { .topbar { display: none; } }
</style>
</head>
<body>
<div class="topbar"><a href="${escapeHtml(backHref)}">← 返回看板</a> · ${escapeHtml(runId)}</div>
<main>
${body}
</main>
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
  const mdPath = path.join(dir, 'report.md');
  if (!fs.existsSync(mdPath)) {
    console.error(`FATAL: report.md not found: ${mdPath}`);
    process.exit(1);
  }
  const md = fs.readFileSync(mdPath, 'utf8');
  const html = renderReportHtml(md, { runId, backHref: '../../dashboard.html' });
  const outPath = path.join(dir, 'report.html');
  fs.writeFileSync(outPath, html, 'utf8');
  console.log(`report.html: ${outPath}`);
}

module.exports = { mdToHtml, renderReportHtml, escapeHtml, main };

if (require.main === module) main();
