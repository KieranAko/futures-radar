// strategies/story-pool/link-signal-pool.cjs — 故事链 ↔ 信号池 回链
//
// 在 build-strategy-plan（信号池更新）之后运行：
//   node strategies/story-pool/link-signal-pool.cjs --runId <runId>
//
// 行为：把本期信号池里、与 proven/completed 故事链「代表品种 + 方向」匹配的信号，
//       回写到链文件（linkedSignalId / linkedSignalRunId + linked_signal 事件），
//       使故事池台账能看到链的最终表达与前向验证去向。
//
// 纪律：确定性、不联网、不调用 LLM；只改故事池链文件的 linkage 字段与事件。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { runDir } = require('../../lib/workspace.cjs');
const { loadLedger, loadChain, saveChain } = require('../lib/story-chain.cjs');
const signalPool = require('../lib/signal-pool.cjs');

function flagVal(args, flag) {
  const i = args.indexOf(flag);
  return i === -1 ? null : args[i + 1];
}

function signalDirectionOf(sig) {
  if (sig.direction === 'bearish') return -1;
  if (sig.direction === 'bullish') return 1;
  return 0;
}

/**
 * 纯函数：把本期信号池信号回链到故事链。
 * @param {object[]} chains 故事池链（含 provenAt 的活跃/已完成链）
 * @param {object[]} signals 本期信号池信号（createdRunId 或 lastSeenRunId === runId）
 * @param {string} runId
 */
function linkChains(chains, signals, runId) {
  const updates = [];
  for (const chain of chains || []) {
    if (!chain || !chain.provenAt || chain.linkedSignalId) continue;
    const match = (signals || []).find((s) =>
      s.symbol === chain.representative
      && signalDirectionOf(s) === chain.direction
      && (s.createdRunId === runId || s.lastSeenRunId === runId)
    );
    if (!match) continue;
    chain.linkedSignalId = match.signalId;
    chain.linkedSignalRunId = runId;
    chain.events.push({
      date: new Date().toISOString().slice(0, 10),
      type: 'linked_signal',
      detail: `链 ${chain.chainId} → 信号 ${match.signalId}（${match.direction}）进入前向验证`,
    });
    updates.push({ chainId: chain.chainId, signalId: match.signalId });
  }
  return { updates };
}

function main() {
  const args = process.argv.slice(2);
  const runId = flagVal(args, '--runId');
  if (!runId) {
    console.error('FATAL: --runId required');
    process.exit(1);
  }

  const signalLedger = signalPool.loadLedger();
  const runSignals = [];
  for (const row of signalLedger.signals) {
    const sig = signalPool.loadSignal(row.signalId);
    if (!sig) continue;
    if (sig.createdRunId === runId || sig.lastSeenRunId === runId) runSignals.push(sig);
  }

  const storyLedger = loadLedger();
  const chains = [];
  for (const row of storyLedger.chains) {
    const c = loadChain(row.chainId);
    if (c && c.provenAt) chains.push(c);
  }

  const { updates } = linkChains(chains, runSignals, runId);
  for (const u of updates) {
    const c = chains.find((x) => x.chainId === u.chainId);
    if (c) saveChain(c);
  }
  console.log(`story-chain ↔ signal-pool: linked ${updates.length}（${updates.map((u) => `${u.chainId}→${u.signalId}`).join(', ') || 'none'}）`);
}

if (require.main === module) main();
module.exports = { main, linkChains, signalDirectionOf };
