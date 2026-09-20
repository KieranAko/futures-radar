// analysis/v2/run-v2.cjs — 生产 Analyze v2 编排器 + KPI 记录
//
// 执行图（LLM 逻辑调用=2，工具步骤=4）：
//   packet-freeze-v2 → prefill-v2 → prompt-builder-v2
//   → [LLM 单轮批量：<runDir>/analyze/outputs-v2.json]（操作者按 prompts-v2.md 执行）
//   → assemble-v2 --as-production（组装生产六问 + grounding/等价性校验）
//
// 用法: node analysis/v2/run-v2.cjs --runId <runId>
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const { runDir } = require(path.join(ROOT, 'shared', 'workspace.cjs'));

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function runTool(script, runId, extraArgs = []) {
  const scriptPath = path.join(ROOT, 'analysis', 'v2', script);
  const res = spawnSync('node', [scriptPath, '--runId', runId, ...extraArgs], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 300000,
  });
  if (res.status !== 0) throw new Error(`${script} failed:\n${res.stderr || res.stdout}`);
}

function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--runId');
  const runId = i >= 0 ? args[i + 1] : null;
  if (!runId) throw new Error('--runId required');
  const t0 = Date.now();
  const runPath = runDir(runId);
  const analyzeDir = path.join(runPath, 'analyze');

  runTool('packet-freeze-v2.cjs', runId);
  runTool('prefill-v2.cjs', runId);
  runTool('prompt-builder-v2.cjs', runId);

  const outFile = path.join(analyzeDir, 'outputs-v2.json');
  if (!fs.existsSync(outFile)) {
    console.log(`LLM 执行步骤：按 ${path.join(analyzeDir, 'prompts-v2.md')} 完成单轮批量推理，写 ${outFile}，然后重跑本命令。`);
    return { pendingLlmStep: true };
  }
  runTool('assemble-v2.cjs', runId, ['--as-production']);

  const outputs = readJson(outFile);
  const prompts = fs.readFileSync(path.join(analyzeDir, 'prompts-v2.md'), 'utf8');
  const equivalence = readJson(path.join(analyzeDir, 'equivalence-v2.json'));
  const elapsedMs = Date.now() - t0;

  const kpi = {
    schema: 'futures-radar-analyze-v2-kpi/1',
    runId,
    generatedAt: new Date().toISOString(),
    kpi: {
      logicalLlmCalls: outputs.logicalLlmCalls ?? null,
      targetLlmCalls: 3,
      toolSteps: 4,
      elapsedMs,
      promptChars: prompts.length,
      outputChars: JSON.stringify(outputs).length,
      estimatedTokens: Math.round(prompts.length / 3 + JSON.stringify(outputs).length / 3),
      sixQuestionsComplete: Object.values(equivalence.sixQuestions).every(Boolean),
      grounding: equivalence.grounding,
      mechanismRefCoverage: equivalence.mechanismRefCoverage != null ? `${equivalence.mechanismRefCoverage}/3` : 'n/a',
      note: '生产 Analyze v2；LLM 逻辑调用目标 ≤3，机制候选来自归档实验线 registry（V2 待迁至 research/mechanisms/registry）。',
    },
    comparison: {
      productionBaseline: { llmCalls: '7-9（板块 N 次 + FinCoT×3 + 六问×3）', serial: true },
      v2: { llmCalls: outputs.logicalLlmCalls, serial: false, singlePass: true },
    },
  };
  const kpiFile = path.join(analyzeDir, 'analyze-v2-kpi.json');
  writeJson(kpiFile, kpi);
  console.log(JSON.stringify(kpi.kpi, null, 2));
  console.log(`kpi: ${kpiFile}`);
  return kpi;
}

if (require.main === module) main();
module.exports = { main };
