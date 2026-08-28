// experiment-line/analyze-v2/run-v2.cjs — candidate v2 编排器 + KPI 记录
//
// 执行图（O6 并行化由工具阶段表达；LLM 逻辑调用=2）：
//   packet-freeze-v2 ∥ prefill-v2（可并行，数据同源）
//   → prompt-builder-v2
//   → [LLM 单轮批量：outputs-v2.json]（由操作者按 prompts-v2.md 执行）
//   → assemble-v2（组装 + 六问等价性 + grounding 校验）
//
// 用法: node experiment-line/analyze-v2/run-v2.cjs --runId <runId>
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const EL = path.resolve(__dirname, '..');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function runTool(script, runId) {
  const res = spawnSync('node', [path.join(EL, 'analyze-v2', script), '--runId', runId], {
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

  runTool('packet-freeze-v2.cjs', runId);
  runTool('prefill-v2.cjs', runId);
  runTool('prompt-builder-v2.cjs', runId);

  const outFile = path.join(EL, 'runs', runId, 'analyze', 'outputs-v2.json');
  if (!fs.existsSync(outFile)) {
    console.log('LLM 执行步骤：按 analyze/prompts-v2.md 完成单轮批量推理，写 analyze/outputs-v2.json，然后重跑本命令。');
    return { pendingLlmStep: true };
  }
  runTool('assemble-v2.cjs', runId);

  const outputs = readJson(outFile);
  const prompts = fs.readFileSync(path.join(EL, 'runs', runId, 'analyze', 'prompts-v2.md'), 'utf8');
  const equivalence = readJson(path.join(EL, 'runs', runId, 'analyze', 'equivalence-v2.json'));
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
      mechanismRefCoverage: `${equivalence.mechanismRefCoverage}/3`,
      note: '生产基线 7-9 次 LLM 调用；token 对比需影子期同输入实测，此处仅记录绝对量',
    },
    comparison: {
      productionBaseline: { llmCalls: '7-9（板块 N 次 + FinCoT×3 + 六问×3）', serial: true },
      v2: { llmCalls: outputs.logicalLlmCalls, serial: false, singlePass: true },
    },
  };
  const kpiFile = path.join(EL, 'results', `analyze-v2-kpi-${runId}.json`);
  writeJson(kpiFile, kpi);
  console.log(JSON.stringify(kpi.kpi, null, 2));
  console.log(`kpi: ${kpiFile}`);
  return kpi;
}

if (require.main === module) main();
module.exports = { main };
