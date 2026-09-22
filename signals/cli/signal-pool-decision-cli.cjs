#!/usr/bin/env node
// signals/cli/signal-pool-decision-cli.cjs — 人类信号决策回填 CLI
//
// dashboard 的“报价对比”决策交互导出 futures-radar-signal-decisions/1 JSON；
// 本 CLI 校验并回填到 data/signal-pool，重建 signal-pool.json。
//
// 用法:
//   node signals/cli/signal-pool-decision-cli.cjs apply --file <json> --runId <runId>
//
// 纪律：本 CLI 不调用 LLM、不联网；决策与理由由人类填写。

'use strict';

const fs = require('fs');
const path = require('path');
const { skillRoot, runDir, runtimeRoot } = require('../../shared/workspace.cjs');
const { validateDecisions, DECISION_RECORD_SCHEMA } = require('../decisions/signal-decision-lib.cjs');
const {
  loadLedger,
  saveLedger,
  loadSignal,
  saveSignal,
  buildView,
  closeSignal,
  createSignalFromVersion,
  livingVersionOf
} = require('../lib/signal-pool.cjs');

function poolRoot(rootOverride = null) {
  if (rootOverride) return rootOverride;
  if (process.env.FUTURES_RUNTIME_ROOT) return path.join(runtimeRoot, 'data', 'signal-pool');
  return path.join(skillRoot, 'data', 'signal-pool');
}

function readJSON(p, fallback = null) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function writeFile(p, s) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, s, 'utf8');
}

function appendDecisionRecord(sig, d, runId, now, livingBefore = null) {
  if (!Array.isArray(sig.decisionRecords)) sig.decisionRecords = [];
  const record = {
    schema: DECISION_RECORD_SCHEMA,
    recordId: `DR-${sig.signalId}-${String(d.quoteVersionId).replace(/[^A-Za-z0-9-]/g, '-')}-${Date.now()}`,
    signalId: sig.signalId,
    quoteVersionId: d.quoteVersionId,
    livingVersionIdBefore: livingBefore || sig.livingVersionId || null,
    action: d.action,
    reason: d.reason,
    decidedAt: d.decidedAt || now,
    decidedBy: 'human-dashboard',
    status: 'applied'
  };
  sig.decisionRecords.push(record);
  return record;
}

function applyDecisions(runId, file, rootOverride = null) {
  if (!fs.existsSync(file)) return { skipped: true, file, reason: '决策文件不存在' };
  const doc = readJSON(file);
  const check = validateDecisions(doc);
  if (!check.ok) {
    console.error('decision validation FAILED:');
    for (const e of check.errors) console.error('  - ' + e);
    process.exit(1);
  }
  const root = rootOverride || poolRoot();
  const ledger = loadLedger(root);
  const summary = { adopt: 0, keep: 0, pause: 0, close: 0, flippedNewSignal: 0 };
  const touched = new Set();
  for (const d of doc.decisions) {
    const row = ledger.signals.find((r) => r.signalId === d.signalId);
    if (!row) {
      console.warn(`signal ${d.signalId} not in ledger, skipped`);
      continue;
    }
    const sig = loadSignal(row.signalId, root);
    if (!sig) continue;
    const quote = sig.versions.find((v) => v.versionId === d.quoteVersionId);
    if (!quote) {
      console.warn(`quote ${d.quoteVersionId} not found in ${sig.signalId}, skipped`);
      continue;
    }
    const now = new Date().toISOString();
    const livingBefore = sig.livingVersionId || null;
    if (d.action === 'adopt') {
      if (quote.direction !== sig.direction) {
        // 反向报价被人类采纳 = 旧假设被人类推翻：旧信号 flipped 关闭，新信号重新出生（新 T0）。
        closeSignal(sig, 'flipped');
        sig.closedAt = d.decidedAt || now;
        quote.decision = { status: 'adopted', reason: d.reason, decidedAt: d.decidedAt || now, decidedRunId: runId };
        appendDecisionRecord(sig, d, runId, now, livingBefore);
        saveSignal(sig, root);
        const neu = createSignalFromVersion(sig, quote, runId, root);
        ledger.signals.push({ signalId: neu.signalId, symbol: neu.symbol });
        saveSignal(neu, root);
        summary.flippedNewSignal++;
      } else {
        sig.livingVersionId = quote.versionId;
        sig.currentVersionId = quote.versionId;
        sig.direction = quote.direction;
        if (quote.contract) sig.contract = quote.contract;
        quote.decision = { status: 'adopted', reason: d.reason, decidedAt: d.decidedAt || now, decidedRunId: runId };
        sig.poolStatus = 'active';
        appendDecisionRecord(sig, d, runId, now, livingBefore);
      }
      summary.adopt++;
    } else if (d.action === 'keep') {
      quote.decision = { status: 'kept', reason: d.reason, decidedAt: d.decidedAt || now, decidedRunId: runId };
      appendDecisionRecord(sig, d, runId, now, livingBefore);
      summary.keep++;
    } else if (d.action === 'pause') {
      quote.decision = { status: 'paused', reason: d.reason, decidedAt: d.decidedAt || now, decidedRunId: runId };
      sig.poolStatus = 'downgraded';
      appendDecisionRecord(sig, d, runId, now, livingBefore);
      summary.pause++;
    } else if (d.action === 'close') {
      closeSignal(sig, d.closeReason || 'faded');
      sig.closedAt = d.decidedAt || now;
      quote.decision = { status: 'closed', reason: d.reason, decidedAt: d.decidedAt || now, decidedRunId: runId };
      appendDecisionRecord(sig, d, runId, now, livingBefore);
      summary.close++;
    }
    touched.add(sig.signalId);
    if (sig.poolStatus !== 'closed') saveSignal(sig, root);
    else saveSignal(sig, root);
  }
  for (const signalId of touched) {
    // 已被翻转关闭的旧信号已在上面保存；此处仅确保 ledger 同步。
  }
  ledger.updatedRunId = runId;
  saveLedger(ledger, root);
  const view = buildView(runId, ledger, root);
  const viewPath = path.join(runDir(runId), 'signal-pool.json');
  writeFile(viewPath, JSON.stringify(view, null, 2) + '\n');
  return { summary, viewPath };
}

function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const flag = (name) => {
    const i = args.indexOf(name);
    return i === -1 ? null : args[i + 1];
  };
  if (cmd === 'apply') {
    const runId = flag('--runId');
    const file = flag('--file');
    const rootOverride = flag('--root');
    if (!runId) { console.error('FATAL: --runId required'); process.exit(1); }
    const r = applyDecisions(runId, file, rootOverride);
    if (r.skipped) {
      console.warn(`decisions skipped: ${r.reason}`);
      return;
    }
    console.log(`decisions applied: ${JSON.stringify(r.summary)}`);
    console.log(`signal-pool.json rebuilt: ${r.viewPath}`);
    return;
  }
  console.error('usage: signal-pool-decision-cli.cjs apply --file <json> --runId <runId>');
  process.exit(1);
}

if (require.main === module) main();

module.exports = { applyDecisions };
