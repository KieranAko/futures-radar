// strategies/signal-pool/apply-tracking-seats.cjs — 信号池追踪席位注入
//
// 在 LLM 初筛写完 filtered.json 之后、freeze-packets 之前运行：
//   node strategies/signal-pool/apply-tracking-seats.cjs --runId <runId>
//
// 行为：读取信号池 ledger，把所有池内（active/downgraded）信号品种强制加入
//       filtered.json 的 candidates（KEEP），标记 tracking=true / signalId，
//       使它们与 TOP3 一样进入完整深入分析（追踪席位）。
//
// 纪律：确定性、不联网、不调用 LLM；只修改 filtered.json 的 candidates/downgraded/meta。

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { runDir } = require('../../lib/workspace.cjs');
const { loadLedger, loadSignal } = require('../lib/signal-pool.cjs');

function flagVal(args, flag) {
  const i = args.indexOf(flag);
  return i === -1 ? null : args[i + 1];
}

function readJSON(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeJSONAtomic(p, data) {
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, p);
}

function applyTrackingSeats(filtered, poolSignals, now = new Date().toISOString()) {
  const candidates = Array.isArray(filtered.candidates) ? filtered.candidates : [];
  const downgraded = Array.isArray(filtered.downgraded) ? filtered.downgraded : [];
  const candidateSymbols = new Set(candidates.map((c) => c.symbol));

  const added = [];
  for (const sig of poolSignals) {
    if (candidateSymbols.has(sig.symbol)) continue;
    const cur = sig.versions.find((v) => v.versionId === sig.currentVersionId) || sig.versions[sig.versions.length - 1];
    const confidence = cur && ['high', 'medium', 'low'].includes(cur.confidence) ? cur.confidence : 'medium';
    const directionHint = sig.direction === 'bearish' ? 'bearish' : 'bullish';
    candidates.push({
      symbol: sig.symbol,
      rank: 90 + added.length,
      directionHint,
      directionBias: directionHint,
      decision: 'KEEP',
      confidence,
      reason: `信号池追踪席位 ${sig.signalId}：入池 ${sig.createdDate}，${sig.thesis || '品种机会持续追踪'}`,
      informationGap: '信号池追踪席位：需与 TOP3 同规格完整再分析',
      tracking: true,
      signalId: sig.signalId
    });
    added.push(sig.symbol);
  }

  const nextDowngraded = downgraded.filter((d) => {
    if (added.includes(d.symbol) || candidateSymbols.has(d.symbol)) return false;
    return true;
  });

  filtered.candidates = candidates;
  filtered.downgraded = nextDowngraded;
  filtered.meta = filtered.meta || {};
  filtered.meta.outputCount = candidates.filter((c) => c.decision === 'KEEP').length;
  filtered.meta.trackingSeats = added.length;
  filtered.meta.note = (filtered.meta.note ? filtered.meta.note + '；' : '') + `信号池追踪席位注入 ${added.length} 个`;
  filtered.meta.trackingAppliedAt = now;
  return { filtered, added };
}

function main() {
  const args = process.argv.slice(2);
  const runId = flagVal(args, '--runId');
  if (!runId) {
    console.error('FATAL: --runId required');
    process.exit(1);
  }

  const dir = runDir(runId);
  const filteredPath = path.join(dir, 'filtered.json');
  if (!fs.existsSync(filteredPath)) {
    console.error(`FATAL: filtered.json not found in ${dir}`);
    process.exit(1);
  }

  const filtered = readJSON(filteredPath);
  const ledger = loadLedger();
  const poolSignals = [];
  for (const row of ledger.signals) {
    const sig = loadSignal(row.signalId);
    if (sig && sig.poolStatus !== 'closed') poolSignals.push(sig);
  }

  const { added } = applyTrackingSeats(filtered, poolSignals);
  writeJSONAtomic(filteredPath, filtered);

  console.log(`signal-pool tracking seats: added ${added.length} (${added.join(', ') || 'none'})`);
  console.log(`filtered.json KEEP=${filtered.meta.outputCount}, downgraded=${filtered.downgraded.length}`);
}

if (require.main === module) main();
module.exports = { main, applyTrackingSeats };
