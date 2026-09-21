// stories/cli/news-snapshot-cli.cjs — 新闻/政策快照文件库 CLI
//
// 用法:
//   node stories/cli/news-snapshot-cli.cjs install --runId <runId>
//     agent 写好 output/runs/<runId>/news-snapshot.json 后安装进 data/news/ 并重建索引
//   node stories/cli/news-snapshot-cli.cjs validate --runId <runId> [--candidate]
//     校验候选稿（默认 --candidate）或已安装快照
//   node stories/cli/news-snapshot-cli.cjs view --runId <runId>
//   node stories/cli/news-snapshot-cli.cjs index
//
// 纪律：本 CLI 确定性、不联网、不调用 LLM，只做校验与文件库搬运。
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { runtimeRoot } = require('../../shared/workspace.cjs');
const news = require('../lib/news-snapshot.cjs');

function flagVal(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}

function printCheck(check, label) {
  console.log(`${label}: ${check.ok ? 'OK' : 'FAIL'}（${check.coverage ? check.coverage.total : 0} 条）`);
  for (const e of check.errors) console.log(`  [ERROR] ${e}`);
  for (const w of check.warnings) console.log(`  [WARN] ${w}`);
  if (check.coverage) {
    const cov = Object.entries(check.coverage)
      .filter(([k]) => k !== 'total')
      .map(([k, v]) => `${k}:${v}`).join(' ');
    console.log(`  coverage: ${cov}`);
  }
}

function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const runId = flagVal(args, '--runId');
  if (cmd === 'install') {
    if (!runId) { console.error('install 需要 --runId'); process.exitCode = 1; return; }
    const cand = path.join(runtimeRoot, 'runs', runId, 'news-snapshot.json');
    if (!fs.existsSync(cand)) { console.error(`候选稿不存在: ${cand}`); process.exitCode = 1; return; }
    const doc = JSON.parse(fs.readFileSync(cand, 'utf8'));
    const check = news.validateNewsSnapshot(doc);
    printCheck(check, `candidate ${cand}`);
    if (!check.ok) { process.exitCode = 1; return; }
    const out = news.writeNewsSnapshot(doc);
    if (!out.ok) { console.error(out.errors.join('; ')); process.exitCode = 1; return; }
    console.log(`installed: ${out.file}`);
    console.log(`index updated: ${news.newsIndexPath()}`);
    return;
  }
  if (cmd === 'validate') {
    if (!runId) { console.error('validate 需要 --runId'); process.exitCode = 1; return; }
    const useInstalled = args.includes('--installed');
    const file = useInstalled ? news.newsFile(runId) : path.join(runtimeRoot, 'runs', runId, 'news-snapshot.json');
    if (!fs.existsSync(file)) { console.error(`文件不存在: ${file}`); process.exitCode = 1; return; }
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    const check = news.validateNewsSnapshot(doc);
    printCheck(check, file);
    if (!check.ok) process.exitCode = 1;
    return;
  }
  if (cmd === 'view') {
    if (!runId) { console.error('view 需要 --runId'); process.exitCode = 1; return; }
    const doc = news.loadNewsSnapshot(runId);
    if (!doc) { console.error(`新闻快照不存在: ${runId}`); process.exitCode = 1; return; }
    console.log(JSON.stringify(doc, null, 2));
    return;
  }
  if (cmd === 'index') {
    const index = news.loadNewsIndex();
    console.log(JSON.stringify(index, null, 2));
    return;
  }
  console.log('usage: node stories/cli/news-snapshot-cli.cjs <install|validate|view|index> --runId <runId>');
  process.exitCode = 1;
}

main();
