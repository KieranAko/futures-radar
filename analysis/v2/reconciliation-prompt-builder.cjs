// analysis/v2/reconciliation-prompt-builder.cjs — 六问第二遍推理输入构建
//
// 运行时机：审计 LLM 写出 audit-findings.json 且存在 conflict 品种之后。
//   node analysis/v2/reconciliation-prompt-builder.cjs --runId <runId>
//
// 产出：output/runs/<runId>/analyze/reconciliation-prompt.md
// LLM/agent 按提示词写 analyze/outputs-v2-reconciliation.json（只写修订增量）。
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { runDir } = require('../../shared/workspace.cjs');
const news = require('../../stories/lib/news-snapshot.cjs');
const audit = require('./audit-lib.cjs');
const recon = require('./reconciliation-lib.cjs');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function flagVal(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}

function packetField(packet, dotted) {
  let cur = packet;
  for (const part of String(dotted || '').split('.')) {
    if (cur == null) return null;
    cur = cur[part];
  }
  return cur;
}

function resolveFactId(id, { newsDoc, packet }) {
  if (id && newsDoc) {
    const it = (newsDoc.items || []).find((x) => x.id === id);
    if (it) return `${id}：${it.title}。${it.summary}`;
  }
  if (packet) {
    const v = packetField(packet, id);
    if (v !== undefined && v !== null) {
      return `${id} = ${JSON.stringify(v)}`;
    }
  }
  return `${id}（未能解析该事实 id，请忽略该引用）`;
}

function main() {
  const args = process.argv.slice(2);
  const runId = flagVal(args, '--runId');
  if (!runId) throw new Error('--runId required');
  const dir = runDir(runId);
  const findingsFile = path.join(dir, 'analyze', 'audit-findings.json');
  const promptFile = path.join(dir, 'analyze', 'reconciliation-prompt.md');

  if (!fs.existsSync(findingsFile)) {
    fs.mkdirSync(path.dirname(promptFile), { recursive: true });
    fs.writeFileSync(promptFile, '# 六问第二遍\n\n无 audit-findings.json，不需要第二遍。\n', 'utf8');
    console.log(`reconciliation prompt: ${promptFile}（无审计 findings）`);
    return '';
  }

  const findings = readJson(findingsFile);
  const conflicts = (findings.findings || []).filter((f) => f.verdict === 'conflict');
  const outputs = readJson(path.join(dir, 'analyze', 'outputs-v2.json'));
  const outputsBySymbol = new Map((outputs.results || []).map((o) => [o.symbol, o]));
  const packets = readJson(path.join(dir, 'analyze', 'packets-v2.json')).packets || {};
  const newsDoc = news.loadNewsSnapshot(runId) || null;

  if (conflicts.length === 0) {
    fs.mkdirSync(path.dirname(promptFile), { recursive: true });
    fs.writeFileSync(promptFile, '# 六问第二遍\n\n审计结论全部 aligned，不需要第二遍。\n', 'utf8');
    console.log(`reconciliation prompt: ${promptFile}（0 conflict）`);
    return '';
  }

  const L = [];
  L.push(`# 六问第二遍（审计追问后的最终综合，runId=${runId}）`);
  L.push('');
  L.push('你是六问 LLM。下面是你自己第一遍的独立推理，以及审计 LLM 提炼出的冲突点。');
  L.push('本阶段只回应冲突：不要重新读取整条传导链，不要引入冲突点之外的信息。');
  L.push('');
  L.push('输出规则：');
  L.push('- 只输出需要修改的字段（revisions 增量），未修改的字段不要出现；');
  L.push('- auditImpact=none 表示冲突已被事实澄清、无需修改；');
  L.push('- auditImpact=kept_with_reasons 表示维持原判，必须在 auditResponse 里给出坚持理由；');
  L.push('- auditImpact=revised_driver 表示修改驱动相关字段（q1_driver 等）；');
  L.push('- auditImpact=revised_direction 表示修改方向（direction 必填，可同时给 confidence/passReason）。');
  L.push('');
  L.push('## 品种冲突点');
  L.push('');
  for (const f of conflicts) {
    L.push(`### ${f.symbol}`);
    L.push('');
    L.push('【你第一遍的关键结论】');
    L.push(audit.sixOutputBlock(outputsBySymbol.get(f.symbol)));
    L.push('');
    L.push('【审计冲突点（少量）】');
    for (const c of f.conflicts || []) {
      L.push(`- 维度=${c.dimension}`);
      L.push(`  - 你第一遍的原话：${c.analysisClaim}`);
      L.push(`  - 链的主张：${c.chainClaim}`);
      L.push(`  - 审计追问：${c.question}`);
      for (const id of c.factIds || []) {
        L.push(`  - 必要事实 ${resolveFactId(id, { newsDoc, packet: packets[f.symbol] })}`);
      }
    }
    L.push('');
  }
  L.push('## 输出 JSON（写入 analyze/outputs-v2-reconciliation.json）');
  L.push('```json');
  L.push('{');
  L.push(`  "schema": "${recon.RECONCILIATION_SCHEMA}",`);
  L.push('  "runId": "<runId>",');
  L.push('  "generatedAt": "<ISO>",');
  L.push('  "revisions": [');
  L.push('    {');
  L.push('      "symbol": "RB0", "auditImpact": "kept_with_reasons",');
  L.push('      "auditResponse": "为什么维持或修改",');
  L.push('      "revisions": { "q1_driver": { "primary": "..." } }');
  L.push('    }');
  L.push('  ]');
  L.push('}');
  L.push('```');

  fs.mkdirSync(path.dirname(promptFile), { recursive: true });
  fs.writeFileSync(promptFile, L.join('\n'), 'utf8');
  console.log(`reconciliation prompt: ${promptFile}（${conflicts.length} conflict symbols）`);
  return L.join('\n');
}

if (require.main === module) main();
module.exports = { main, resolveFactId, packetField };
