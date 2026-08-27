/**
 * analyze/assemble-results.mjs — Analyze 阶段步骤 3（自动）
 * 校验 LLM 推理文档（{runDir}/analyze/outputs/{symbol}-fincot.md 的 JSON 块）
 * 复用 reasoning-runner：extractResult（输入一致性）+ validateGrounding，
 * grounding 不通过自动降级 pass/model_abstain。输出 reasoning-results.json。
 *
 * Usage:
 *   node analyze/assemble-results.mjs --runId 20260825-1020-auto
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { runReasoningArm } from '../reasoning/lib/reasoning-runner.js';

const require = createRequire(import.meta.url);
const { runDir } = require('../lib/workspace.cjs');

const MODEL = { provider: 'deepseek', modelId: 'deepseek-v4-pro', temperature: 0, maxTokens: 2048 };
const PROMPT_VERSION = 'v1.3-fincot-macro';

const args = process.argv.slice(2);
const flagVal = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? null : args[i + 1];
};
const runId = flagVal('--runId');
if (!runId) {
  console.error('FATAL: --runId required');
  process.exit(1);
}

const dir = runDir(runId);
const bundlePath = path.join(dir, 'evidence-packets.json');
const outputsDir = path.join(dir, 'analyze', 'outputs');
if (!fs.existsSync(bundlePath)) {
  console.error(`FATAL: missing ${bundlePath} — run freeze-packets.mjs first`);
  process.exit(1);
}

const bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf-8'));
const results = [];

for (const packet of bundle.packets) {
  const docPath = path.join(outputsDir, `${packet.symbol}-fincot.md`);
  if (!fs.existsSync(docPath)) {
    console.error(`FATAL: missing reasoning doc: ${docPath}`);
    console.error('LLM 步骤：读 analyze/prompts/{symbol}-fincot.md，输出推理文档到 analyze/outputs/');
    process.exit(1);
  }

  const doc = fs.readFileSync(docPath, 'utf-8');
  const jsonMatch = doc.match(/```json\s*([\s\S]*?)\s*```/);
  if (!jsonMatch) {
    console.error('FATAL: ' + docPath + ' 无 json 代码块');
    process.exit(1);
  }
  const text = jsonMatch[1].trim();

  // recorded provider：文档文本固定，parseRetries=0（重试不会改变输出）
  const provider = {
    async complete() {
      return { text, provider: 'recorded', modelId: MODEL.modelId, temperature: MODEL.temperature, maxTokens: MODEL.maxTokens };
    }
  };

  const entry = await runReasoningArm({
    packet,
    arm: 'fincot',
    provider,
    model: MODEL,
    promptVersion: PROMPT_VERSION,
    parseRetries: 0
  });
  results.push(entry);

  const log = entry.status === 'accepted'
    ? `${entry.result.direction}/${entry.result.confidence} grounded`
    : entry.status === 'grounding_degraded'
      ? `降级 pass/model_abstain（${entry.originalGrounding.ungrounded_evidence.concat(entry.originalGrounding.ungrounded_opposing, entry.originalGrounding.ungrounded_macro || []).join(', ')}）`
      : `${entry.status}${entry.parseError ? `: ${entry.parseError}` : ''}`;
  console.log(`[${entry.status}] ${packet.symbol}: ${log}`);
}

const artifact = {
  meta: {
    mode: 'daily',
    signalDate: bundle.meta.signalDate,
    generatedAt: new Date().toISOString(),
    promptVersion: PROMPT_VERSION,
    model: MODEL
  },
  results
};
fs.writeFileSync(path.join(dir, 'reasoning-results.json'), JSON.stringify(artifact, null, 2));
console.log(`Wrote reasoning-results.json (${results.length} entries)`);
