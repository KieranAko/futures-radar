#!/usr/bin/env node
/**
 * analyze/assemble-sector-driver.cjs — 板块驱动 LLM 结果组装（v0.1.5）
 *
 * 步骤：
 *   1. 读 sector-driver-packets.json + analyze/outputs/sector-driver/*.md
 *   2. 解析每个板块的 JSON 结论
 *   3. schema/门禁校验（方向必须与观察一致、driver 必须有板块级证据等）
 *   4. 写 sector-driver.json
 *   5. 用 sector-driver.json 重渲染个股 FinCoT prompts（sector_driver_context 注入）
 *
 * Usage: node analyze/assemble-sector-driver.cjs --runId <id>
 */

const fs = require('fs');
const path = require('path');
const { runDir } = require('../lib/workspace.cjs');
const lib = require('./sector-driver-lib.cjs');

const args = process.argv.slice(2);
const i = args.indexOf('--runId');
const runId = i >= 0 ? args[i + 1] : null;
if (!runId) {
  console.error('FATAL: --runId required');
  process.exit(1);
}

const dir = runDir(runId);
const bundlePath = path.join(dir, 'sector-driver-packets.json');
const outputsDir = path.join(dir, 'analyze', 'outputs', 'sector-driver');
if (!fs.existsSync(bundlePath)) {
  console.error(`FATAL: missing ${bundlePath} — run freeze-packets.mjs first`);
  process.exit(1);
}

const bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf-8'));
const sectors = {};

for (const [sectorId, packet] of Object.entries(bundle.packets)) {
  const docPath = path.join(outputsDir, `${sectorId}.md`);
  if (!fs.existsSync(docPath)) {
    console.error(`FATAL: missing sector-driver doc: ${docPath}`);
    console.error('LLM 步骤：读 analyze/prompts/sector-driver/<sector>.md，输出到 analyze/outputs/sector-driver/');
    process.exit(1);
  }
  const doc = fs.readFileSync(docPath, 'utf-8');
  const entry = lib.parseOutputFromDoc(doc);
  if (!entry) {
    console.error(`FATAL: ${docPath} 无合法 JSON 代码块`);
    process.exit(1);
  }
  sectors[sectorId] = entry;
}

const output = {
  meta: {
    runId,
    signalDate: bundle.meta.signalDate,
    generatedAt: new Date().toISOString(),
    mode: 'sector-driver'
  },
  sectors
};

const validation = lib.validateSectorDriverOutput(output, bundle.packets);
if (!validation.ok) {
  console.error('FATAL: sector-driver validation failed:');
  for (const e of validation.errors) console.error(`  - ${e}`);
  process.exit(1);
}

fs.writeFileSync(path.join(dir, 'sector-driver.json'), JSON.stringify(output, null, 2));
console.log(`Wrote sector-driver.json (${Object.keys(sectors).length} sectors)`);
for (const [sid, entry] of Object.entries(sectors)) {
  console.log(`  [${entry.status}] ${sid}: ${entry.driver ? entry.driver.primary : entry.reason}`);
}

// 用板块驱动结论重渲染个股 FinCoT prompts（sector_driver_context 独立上下文）
(async () => {
  const evidencePath = path.join(dir, 'evidence-packets.json');
  if (!fs.existsSync(evidencePath)) {
    console.warn('evidence-packets.json 不存在，跳过 FinCoT prompt 重渲染');
    return;
  }
  const { renderFourArmPrompts } = await import('../reasoning/lib/prompt-renderer.js');
  const bundle2 = JSON.parse(fs.readFileSync(evidencePath, 'utf-8'));
  const promptsDir = path.join(dir, 'analyze', 'prompts');
  fs.mkdirSync(promptsDir, { recursive: true });
  for (const packet of bundle2.packets) {
    const sectorId = packet.fields.sector_movement && packet.fields.sector_movement.gap === null
      ? packet.fields.sector_movement.sector
      : null;
    const context = lib.renderSectorDriverContextBlock(output, sectorId);
    const prompts = renderFourArmPrompts(packet, { sectorDriverContext: context });
    fs.writeFileSync(path.join(promptsDir, `${packet.symbol}-fincot.md`), prompts.finCot);
  }
  console.log('Re-rendered FinCoT prompts with sector_driver_context');
})().catch((err) => {
  console.error(`FATAL: prompt re-render failed: ${err.message}`);
  process.exit(1);
});
