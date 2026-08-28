// experiment-line/report.cjs — 实验线报告组装（v6：真实报告 + 实验线增量，不碰生产渲染器）
//
// 组装规则：
//   1. 正文 = experiment-line/runs/<runId>/report.md（镜像完整重放产出的真实报告，与生产同构）；
//   2. 附录 = 实验线增量（可信度评级 / 机制识别 / 前向验证 / 镜像回放 / 影子快照）；
//   3. 正文与附录严格分离，附录只增不改正文（P6 实验隔离）。
//
// 用法: node experiment-line/report.cjs --runId <生产runId>
// 输出: experiment-line/runs/<runId>/report-experiment.md
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const EL = __dirname;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function buildAppendix(runId) {
  const trustFile = path.join(EL, 'results', 'trust', `${runId}.json`);
  const mechFile = path.join(EL, 'results', 'mechanism-identify', `${runId}.json`);
  const fwdFile = path.join(EL, 'results', 'forward', `${runId}.json`);
  const replayFile = path.join(EL, 'results', `${runId}-replay.json`);
  const missing = [trustFile, mechFile, fwdFile].filter((f) => !fs.existsSync(f));
  if (missing.length) {
    throw new Error(`missing experiment-line results: ${missing.join(', ')} (run mirror replay / trust-model / mechanism-identify / forward-verify first)`);
  }
  const trust = readJson(trustFile);
  const mech = readJson(mechFile);
  const fwd = readJson(fwdFile);
  // 实验线自产 run 没有生产对照回放；镜像回放章节标记 self-generated
  const replay = fs.existsSync(replayFile) ? readJson(replayFile) : null;

  const L = [];
  L.push('## 附：实验线状态（实验线增量，不影响上方报告）');
  L.push('');
  L.push('### 可信度评级（三层合成：族级证据 × 状态匹配 × 实现保真）');
  L.push('');
  L.push('| 品种 | 族 | 族级证据 | 状态匹配 | 实现保真 | 评级 | 降档原因 |');
  L.push('|------|----|---------|---------|---------|------|---------|');
  for (const r of trust.rows) {
    L.push(`| ${r.symbol} | ${r.family} | ${r.familyLevel} | ${r.scores.stateMatch === 2 ? 'matched' : 'unknown'} | ${r.scores.fidelity === 2 ? 'high' : 'unknown'} | **${r.trust}** | ${r.downgradeReasons.join('；') || '—'} |`);
  }
  L.push('');

  L.push('### 机制识别（analyze candidate v1，关键词规则）');
  L.push('');
  for (const r of mech.rows) {
    L.push(`- ${r.symbol} → family=**${r.family}**，match=${r.matchStatus}，机制目录：${r.mechanismIds.join(', ') || '无'}（${r.registryNote}）`);
  }
  L.push('');

  L.push('### 前向验证（V8 T+1 语义，参数来自冻结计划）');
  L.push('');
  L.push(`计划 ${fwd.summary.plans} 条：verified ${fwd.summary.verified}；not_executable ${fwd.summary.notExecutable}；trigger_miss ${fwd.summary.triggerMiss}；待数据 ${fwd.summary.pendingData}；gap_skip ${fwd.summary.gapSkip}。`);
  for (const r of fwd.rows) {
    L.push(`- ${r.symbol}（${r.executionStatus}）：**${r.status}**${r.triggerVerifyDate ? `，T+1=${r.triggerVerifyDate}` : ''}${r.entryDate ? `，入场=${r.entryDate}` : ''}${r.exitDate ? `，离场=${r.exitDate}（${r.exitType}）` : ''}${r.netPnlPct != null ? `，净=${r.netPnlPct}%` : ''}`);
  }
  L.push('');

  const s = replay ? replay.summary : null;
  L.push('### 镜像回放（stable 基线）');
  L.push('');
  if (s) {
    L.push(`环节 ${s.total}：一致 ${s.ok}；真实差异 ${s.diff}；版本漂移 ${s.versionDrift}；错误 ${s.error}。策略适配回放：**${(replay.checks.find((c) => c.stage === 'strategy-plan') || {}).status}**。`);
  } else {
    L.push('本 run 为**实验线自产新报告**（实验线完整采集/分析/渲染），无生产对照回放；生产镜像回放仅适用于生产已有 run。');
  }
  L.push('');

  const shadowDir = path.join(EL, 'shadow', 'report-trust-model-v1', 'snapshots');
  if (fs.existsSync(shadowDir)) {
    const snaps = fs.readdirSync(shadowDir).filter((f) => f.startsWith(runId)).sort();
    L.push('### 影子快照');
    L.push('');
    const shown = snaps.slice(-3);
    L.push(snaps.length ? `本 run 快照共 **${snaps.length}** 条，最近：${shown.join('；')}` : '本 run 暂无影子快照。');
    L.push('');
  }

  L.push('*实验线增量只提供证据充分程度信息，不修改上方报告的方向与置信度，不构成投资建议。*');
  L.push('');
  return L.join('\n');
}

function main(runIdArg) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--runId');
  const runId = runIdArg || (i >= 0 ? args[i + 1] : null);
  if (!runId) throw new Error('--runId required');

  const baseReport = path.join(EL, 'runs', runId, 'report.md');
  if (!fs.existsSync(baseReport)) throw new Error(`base report missing: ${baseReport} (run mirror.cjs replay first)`);
  const body = fs.readFileSync(baseReport, 'utf8').replace(/\s+$/, '');
  const appendix = buildAppendix(runId);
  const md = `${body}\n\n---\n\n${appendix}\n`;
  const outFile = path.join(EL, 'runs', runId, 'report-experiment.md');
  fs.writeFileSync(outFile, md, 'utf8');
  console.log(`experiment-line report: ${outFile} (${md.split('\n').length} lines)`);
  return { file: outFile, md };
}

if (require.main === module) main();
module.exports = { main, buildAppendix };
