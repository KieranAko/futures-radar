#!/usr/bin/env node
// signals/cli/signal-reconcile-cli.cjs — 交易单对账 CLI
//
// 用法:
//   prompt  node signals/cli/signal-reconcile-cli.cjs prompt --runId <runId>
//           生成对账 LLM 提示词：同一信号的 livingTicket 与待决策新报价并排 +
//           结构化 diff + 市场追踪状态；只要求解释差异与冲突，不判胜负。
//   apply   node signals/cli/signal-reconcile-cli.cjs apply --file <json> --runId <runId>
//           校验对账 LLM 输出并回填到信号版本（reconciliation），重建 signal-pool.json。
//
// 纪律：确定性；本 CLI 不调用 LLM、不联网。

'use strict';

const fs = require('fs');
const path = require('path');
const { skillRoot, runDir, runtimeRoot } = require('../../shared/workspace.cjs');
const { validateReconciliation } = require('../reconciliation/ticket-reconciliation-lib.cjs');
const { loadLedger, loadSignal, saveSignal, buildView, livingVersionOf } = require('../lib/signal-pool.cjs');

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

function fmtVal(v) {
  if (v === null || v === undefined) return '—';
  if (Array.isArray(v)) return v.join('；') || '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function ticketBlock(v) {
  const e = v.entry || {};
  const s = v.stop || {};
  const t = v.targets || {};
  const inv = v.invalidation || {};
  const zone = e.entryZone
    ? `入场区间 [${e.entryZone.lower}, ${e.entryZone.upper}]（下沿：${e.entryZone.lowerBasis || '—'}；上沿：${e.entryZone.upperBasis || '—'}）`
    : '—';
  return [
    `版本：${v.versionId}（报价日 ${v.quoteDate || v.signalDate}，run ${v.runId}）`,
    `方向：${v.direction} / 置信度 ${v.confidence} / 状态 ${v.state || '—'} / ${v.executionStatus || '—'}`,
    `触发：${fmtVal(e.trigger)}；触发价 ${fmtVal(e.triggerLevel)}；来源 ${fmtVal(e.triggerSource)}`,
    `确认：${fmtVal(e.triggerTiming)}`,
    `执行：${fmtVal(e.execution)}；偏离阈值 ${fmtVal(e.gapThresholdPts)}；triggerStyle ${fmtVal(e.triggerStyle)}；triggerMode ${fmtVal(e.triggerMode)}`,
    `入场执行区间：${zone}`,
    `止损：${fmtVal(s.stopPrice)}（${fmtVal(s.basis)}）`,
    `目标：T1 ${fmtVal(t.t1)}；T2 ${fmtVal(t.t2)}（${fmtVal(t.basis)}）`,
    `硬失效：${fmtVal(inv.hard)}`,
    `时间止损：${fmtVal(inv.timeStop)}`
  ].join('\n');
}

function pendingQuotes(signal) {
  const versions = Array.isArray(signal.versions) ? signal.versions : [];
  return versions.filter((v) => v.decision && v.decision.status === 'pending');
}

function buildPrompt(runId, rootOverride = null) {
  const root = rootOverride || poolRoot();
  const ledger = loadLedger(root);
  const sections = [];
  let quoteCount = 0;
  for (const row of ledger.signals) {
    const sig = loadSignal(row.signalId, root);
    if (!sig) continue;
    const living = livingVersionOf(sig);
    if (!living) continue;
    const pending = pendingQuotes(sig);
    if (pending.length === 0) continue;
    quoteCount += pending.length;
    const lines = [];
    lines.push(`## 信号 ${sig.signalId}（${sig.symbol} ${sig.contract || ''}，T0=${sig.createdDate}）`);
    lines.push('');
    lines.push(`当前方向：${sig.direction}；池状态：${sig.poolStatus}；最新价 ${fmtVal(sig.latestClose)}；兑现进度 ${fmtVal(sig.fulfillProgress)}；失效距离 ${fmtVal(sig.invalidationDistance)} ATR`);
    lines.push('');
    lines.push('### 当前有效交易单（livingTicket，市场正在追踪）');
    lines.push(ticketBlock(living));
    for (const q of pending) {
      lines.push('');
      lines.push(`### 新报价 ${q.versionId}（待人类决策）`);
      lines.push(ticketBlock(q));
      if (q.diff && Array.isArray(q.diff.changedFields) && q.diff.changedFields.length) {
        lines.push('');
        lines.push(`结构化差异（relation=${q.diff.relation}）：`);
        for (const d of q.diff.changedFields) {
          lines.push(`- ${d.label}（${d.field}）：旧=${fmtVal(d.oldValue)} → 新=${fmtVal(d.newValue)}`);
        }
      } else {
        lines.push('');
        lines.push('结构化差异：无');
      }
    }
    sections.push(lines.join('\n'));
  }
  if (sections.length === 0) {
    return { quoteCount, prompt: '本期无待决策的新报价，无需对账。\n' };
  }
  const header = [
    '# 交易单对账提示词',
    '',
    `runId: ${runId}`,
    '',
    '你的任务：阅读每个信号下面并排给出的「当前有效交易单」与「新报价」，只做两件事：',
    '1. 指出两份交易单之间的所有差异；',
    '2. 用中文解释这些差异/冲突的实质，说明它们各自意味着什么，帮助人类分析师快速理解。',
    '',
    '禁止：不要判断谁对谁错；不要建议人类采用或放弃；不要修改任何交易单字段；不要给出方向结论。',
    '把每个信号视为独立小节；对没有差异的信号不要输出。',
    ''
  ].join('\n');
  return { quoteCount, prompt: `${header}${sections.join('\n\n')}\n` };
}

function applyReconciliation(runId, file, rootOverride = null) {
  if (!file) file = path.join(runDir(runId), 'signals', 'reconcile-output.json');
  if (!fs.existsSync(file)) {
    return { skipped: true, file, reason: '对账产物不存在，跳过回填' };
  }
  const doc = readJSON(file);
  const check = validateReconciliation(doc);
  if (!check.ok) {
    console.error('reconciliation validation FAILED:');
    for (const e of check.errors) console.error('  - ' + e);
    process.exit(1);
  }
  const root = rootOverride || poolRoot();
  const ledger = loadLedger(root);
  let appliedQuotes = 0;
  const appliedSignals = new Set();
  for (const entry of doc.signals) {
    const row = ledger.signals.find((r) => r.signalId === entry.signalId);
    if (!row) {
      console.warn(`signal ${entry.signalId} not in ledger, skipped`);
      continue;
    }
    const sig = loadSignal(row.signalId, root);
    if (!sig) continue;
    for (const q of entry.quotes) {
      const v = sig.versions.find((x) => x.versionId === q.versionId);
      if (!v) {
        console.warn(`quote ${q.versionId} not found in ${sig.signalId}, skipped`);
        continue;
      }
      v.reconciliation = {
        schema: 'futures-radar-ticket-reconciliation-quote/1',
        appliedRunId: runId,
        summary: q.summary,
        conflicts: Array.isArray(q.conflicts) ? q.conflicts : []
      };
      appliedQuotes++;
      appliedSignals.add(sig.signalId);
    }
    if (appliedSignals.has(sig.signalId)) saveSignal(sig, root);
  }
  ledger.updatedRunId = runId;
  const { saveLedger } = require('../lib/signal-pool.cjs');
  saveLedger(ledger, root);
  const view = buildView(runId, ledger, root);
  const viewPath = path.join(runDir(runId), 'signal-pool.json');
  writeFile(viewPath, JSON.stringify(view, null, 2) + '\n');
  return { appliedQuotes, appliedSignals: appliedSignals.size, viewPath };
}

function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const flag = (name) => {
    const i = args.indexOf(name);
    return i === -1 ? null : args[i + 1];
  };
  if (cmd === 'prompt') {
    const runId = flag('--runId');
    const rootOverride = flag('--root');
    if (!runId) { console.error('FATAL: --runId required'); process.exit(1); }
    const { prompt, quoteCount } = buildPrompt(runId, rootOverride);
    const out = path.join(runDir(runId), 'signals', 'reconcile-prompt.md');
    writeFile(out, prompt);
    console.log(`reconcile prompt: ${out}`);
    console.log(`pending quotes: ${quoteCount}`);
    return;
  }
  if (cmd === 'apply') {
    const runId = flag('--runId');
    const file = flag('--file');
    const rootOverride = flag('--root');
    if (!runId) { console.error('FATAL: --runId required'); process.exit(1); }
    const r = applyReconciliation(runId, file, rootOverride);
    if (r.skipped) {
      console.warn(`reconciliation skipped: ${r.reason}`);
      return;
    }
    console.log(`reconciliation applied: ${r.appliedQuotes} quotes on ${r.appliedSignals} signals`);
    console.log(`signal-pool.json rebuilt: ${r.viewPath}`);
    return;
  }
  console.error('usage: signal-reconcile-cli.cjs <prompt|apply> [--runId <id>] [--file <json>]');
  process.exit(1);
}

if (require.main === module) main();

module.exports = { buildPrompt, applyReconciliation };
