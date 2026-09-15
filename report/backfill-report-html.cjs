// report/backfill-report-html.cjs — 为历史生产 run 回填 report.html
//
// 用法:
//   node report/backfill-report-html.cjs
//
// 扫描 output/runs/*/report.md（生产 runId 格式），缺 report.html 的补生成。
// 幂等：已存在 report.html 的 run 跳过。

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { runtimeRoot } = require('../lib/workspace.cjs');
const { renderReportHtml } = require('./render-report-html.cjs');

function main() {
  const runsRoot = path.join(runtimeRoot, 'runs');
  if (!fs.existsSync(runsRoot)) {
    console.error(`FATAL: runs root not found: ${runsRoot}`);
    process.exit(1);
  }
  let created = 0;
  let skipped = 0;
  let failed = 0;
  for (const name of fs.readdirSync(runsRoot).sort()) {
    if (!/^\d{8}-\d{4}-auto$/.test(name)) continue;
    const dir = path.join(runsRoot, name);
    const mdPath = path.join(dir, 'report.md');
    const htmlPath = path.join(dir, 'report.html');
    if (!fs.existsSync(mdPath)) continue;
    if (fs.existsSync(htmlPath)) {
      skipped++;
      continue;
    }
    try {
      const md = fs.readFileSync(mdPath, 'utf8');
      const html = renderReportHtml(md, { runId: name, backHref: '../../dashboard.html' });
      fs.writeFileSync(htmlPath, html, 'utf8');
      created++;
      console.log(`  created ${name}/report.html`);
    } catch (err) {
      failed++;
      console.error(`  FAILED ${name}: ${err.message}`);
    }
  }
  console.log(`backfill-report-html: created=${created}, skipped=${skipped}, failed=${failed}`);
}

if (require.main === module) main();
module.exports = { main };
