// analysis/v2/audit-prompt-builder.cjs — 审计 LLM 推理输入构建
//
// 运行时机：六问第一遍 outputs-v2.json 落盘后、assemble 之前。
//   node analysis/v2/audit-prompt-builder.cjs --runId <runId>
//
// 产出：output/runs/<runId>/analyze/audit-prompt.md
// LLM/agent 按提示词写 analyze/audit-findings.json。
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { runDir } = require('../../shared/workspace.cjs');
const { loadLedger, loadChain, isActive } = require('../../stories/lib/story-chain.cjs');
const news = require('../../stories/lib/news-snapshot.cjs');
const audit = require('./audit-lib.cjs');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function flagVal(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}

function main() {
  const args = process.argv.slice(2);
  const runId = flagVal(args, '--runId');
  if (!runId) throw new Error('--runId required');
  const dir = runDir(runId);
  const outputs = readJson(path.join(dir, 'analyze', 'outputs-v2.json'));
  const packets = readJson(path.join(dir, 'analyze', 'packets-v2.json'));
  const newsDoc = news.loadNewsSnapshot(runId) || null;
  if (newsDoc) {
    const check = news.validateNewsSnapshot(newsDoc);
    if (!check.ok) {
      console.error('FATAL: 已安装新闻快照不合法，先修复 data/news/<runId>.json');
      console.error(check.errors.join('\n'));
      process.exit(1);
    }
  }

  const outputsBySymbol = new Map();
  for (const o of outputs.results || []) outputsBySymbol.set(o.symbol, o);
  const packetsBySymbol = packets.packets || {};

  const ledger = loadLedger();
  const pairs = [];
  for (const row of ledger.chains.filter((c) => isActive(c.status))) {
    const chain = loadChain(row.chainId);
    if (!chain) continue;
    const terminalSymbols = new Set((chain.terminals || []).map((t) => t.symbol));
    for (const sym of terminalSymbols) {
      if (outputsBySymbol.has(sym)) pairs.push({ symbol: sym, chain });
    }
  }

  const prompt = audit.buildAuditPrompt({
    runId,
    pairs,
    outputsBySymbol: Object.fromEntries(outputsBySymbol),
    newsDoc,
    packetsBySymbol,
  });

  const outDir = path.join(dir, 'analyze');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'audit-prompt.md');
  fs.writeFileSync(outFile, prompt, 'utf8');
  console.log(`audit prompt: ${outFile}`);
  console.log(`pairs=${pairs.length} symbols=${outputsBySymbol.size} chainsWithCard=${pairs.filter(({ chain }) => chain.reasoningCard || (chain.definition && chain.definition.reasoningCard)).length}`);
  return prompt;
}

if (require.main === module) main();
module.exports = { main };
