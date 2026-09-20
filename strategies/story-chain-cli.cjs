// strategies/story-chain-cli.cjs — 传导链构造器 CLI
//
// 用法:
//   node strategies/story-chain-cli.cjs register --file <chain.json> [--supersede]
//   node strategies/story-chain-cli.cjs observe --date <YYYY-MM-DD> | --runId <runId>
//   node strategies/story-chain-cli.cjs list
//   node strategies/story-chain-cli.cjs view
//
// 职责边界：本 CLI 与 lib/story-chain.cjs 全部确定性；LLM 只负责构造链文件。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { skillRoot } = require('../lib/workspace.cjs');
const chain = require('./lib/story-chain.cjs');
const indicators = require('./lib/story-indicators.cjs');
const promptBuilder = require('./lib/story-chain-prompt.cjs');

function flagVal(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}

function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (!cmd) { usage(); return; }

  if (cmd === 'register') {
    const file = flagVal(args, '--file');
    if (!file) { console.error('register 需要 --file <chain.json>'); process.exitCode = 1; return; }
    const raw = JSON.parse(fs.readFileSync(path.resolve(skillRoot, file), 'utf8'));
    const defs = args.includes('--batch') ? (raw.chains || []) : [raw];
    let failed = false;
    for (const def of defs) {
      const res = chain.registerChain(def, { supersede: args.includes('--supersede') || def.replace === true });
      if (!res.ok) {
        failed = true;
        console.error(`register FAILED ${def.chainId || '?'} (${res.phase}):`);
        for (const e of res.errors) console.error(`  - ${e}`);
      } else {
        console.log(`registered: ${res.chainId}${res.superseded ? `（superseded ${res.superseded}）` : ''}`);
      }
    }
    if (failed) process.exitCode = 1;
    return;
  }

  if (cmd === 'observe') {
    const date = flagVal(args, '--date');
    const runId = flagVal(args, '--runId');
    if (!date && !runId) { console.error('observe 需要 --date 或 --runId'); process.exitCode = 1; return; }
    const ctx = date ? indicators.computeForDate(date) : indicators.computeForRun(runId);
    const obsDate = date || ctx.signalDate || null;
    if (!obsDate) { console.error('无法确定观测日期'); process.exitCode = 1; return; }
    const out = chain.observeAll(obsDate, ctx.values, { tradingDates: ctx.tradingDates });
    const label = date ? date : runId;
    console.log(`observe ${label}: ${out.alerts.length} 条告警`);
    for (const a of out.alerts) {
      console.log(`  [${a.chainId}] ${a.type}${a.nodeId ? ` node=${a.nodeId}` : ''}: ${a.detail}`);
    }
    chain.writeView();
    console.log('view written: data/story-pool/view.json');
    return;
  }

  if (cmd === 'list') {
    const ledger = chain.loadLedger();
    console.log('story-pool ledger:');
    for (const row of ledger.chains) {
      console.log(`  ${row.chainId}  ${row.sector.padEnd(16)} ${row.status.padEnd(10)} ${row.createdAt}${row.closedAt ? ' → ' + row.closedAt + ' (' + row.closeReason + ')' : ''}`);
    }
    return;
  }

  if (cmd === 'view') {
    const view = chain.writeView();
    console.log(JSON.stringify(view, null, 2));
    return;
  }

  if (cmd === 'prompt') {
    const runId = flagVal(args, '--runId');
    if (!runId) { console.error('prompt 需要 --runId'); process.exitCode = 1; return; }
    const out = promptBuilder.writeStoryChainPrompt(runId);
    console.log(`story-chain prompt: ${out.file}`);
    console.log(`signalDate=${out.signalDate} activeChains=${out.activeChainCount}`);
    return;
  }

  if (cmd === 'resolve') {
    const chainId = flagVal(args, '--chainId');
    if (!chainId) { console.error('resolve 需要 --chainId'); process.exitCode = 1; return; }
    if (args.includes('--brief')) {
      const out = chain.generateResolveBrief(chainId);
      if (!out.ok) { console.error(out.errors.join('; ')); process.exitCode = 1; return; }
      console.log(`brief written: ${out.file}`);
      for (const r of out.requests) console.log(`  ${r.nodeId}: ${r.queries.join(' | ')}`);
      return;
    }
    if (args.includes('--void')) {
      const reason = flagVal(args, '--voidReason') || 'T2 检索失败，节点无法解析';
      const out = chain.resolveChain(chainId, { voidReason: reason });
      if (!out.ok) { console.error(out.errors.join('; ')); process.exitCode = 1; return; }
      console.log(`chain ${chainId} → ${out.status}`);
      return;
    }
    const file = flagVal(args, '--file');
    if (!file) { console.error('resolve 需要 --brief / --file results.json / --void'); process.exitCode = 1; return; }
    const results = JSON.parse(fs.readFileSync(path.resolve(skillRoot, file), 'utf8'));
    const out = chain.resolveChain(chainId, { results });
    if (!out.ok) { console.error(out.errors.join('; ')); process.exitCode = 1; return; }
    console.log(`chain ${chainId} → ${out.status}（resolved ${out.resolvedNow}, remaining ${out.remaining}）`);
    for (const e of out.errors) console.error(`  WARN ${e}`);
    return;
  }

  usage();
}

function usage() {
  console.log('usage: node strategies/story-chain-cli.cjs <register|observe|resolve|prompt|list|view> ...');
}

main();
