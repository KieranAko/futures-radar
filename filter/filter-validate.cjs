// filter/filter-validate.cjs — 初筛输出校验（只查四条硬约束）
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { runDir } = require('../lib/workspace.cjs');

const HINTS = ['bullish', 'bearish', 'unclear'];
const CONFIDENCE = ['high', 'medium', 'low'];

function validate(runId) {
  const dir = runDir(runId);
  const hard = JSON.parse(fs.readFileSync(path.join(dir, 'filtered-hard.json'), 'utf8'));
  const out = JSON.parse(fs.readFileSync(path.join(dir, 'filtered.json'), 'utf8'));
  const errors = [];
  const tombstone = new Set((hard.rejected || []).map((r) => r.symbol));
  const keeps = (out.candidates || []).filter((c) => c.decision === 'KEEP');

  for (const c of out.candidates || []) {
    if (tombstone.has(c.symbol)) errors.push(`${c.symbol}: hard-filter 墓碑不可复活`);
    if (!HINTS.includes(c.directionHint)) errors.push(`${c.symbol}: directionHint 必须为 ${HINTS.join('/')}`);
    if (!CONFIDENCE.includes(c.confidence)) errors.push(`${c.symbol}: confidence 必须为 ${CONFIDENCE.join('/')}`);
    if (!c.reason || String(c.reason).trim() === '') errors.push(`${c.symbol}: reason 不能为空`);
    if (!c.informationGap || String(c.informationGap).trim() === '') errors.push(`${c.symbol}: informationGap 不能为空`);
    if (c.odds || c.longCase || c.shortCase) errors.push(`${c.symbol}: 初筛阶段禁止输出赔率/longCase/shortCase`);
  }
  // 信号池追踪席位（tracking=true）允许让 KEEP 超过 3；但新鲜 TOP3 KEEP 仍 ≤3
  const freshKeeps = keeps.filter((c) => !c.tracking);
  const trackingKeeps = keeps.filter((c) => c.tracking === true);
  if (freshKeeps.length > 3) errors.push(`非追踪 KEEP 数量 ${freshKeeps.length} > 3（追踪席位可另加）`);
  if (trackingKeeps.length > 0 && trackingKeeps.some((c) => !c.signalId)) errors.push('追踪席位必须携带 signalId');
  if (keeps.length === 0) errors.push('KEEP 数量为 0：初筛必须至少选出 1 个有分析价值的品种');
  return { ok: errors.length === 0, errors, keepCount: keeps.length, freshKeeps: freshKeeps.length, trackingKeeps: trackingKeeps.length };
}

function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--runId');
  const runId = i >= 0 ? args[i + 1] : null;
  if (!runId) throw new Error('--runId required');
  const result = validate(runId);
  if (!result.ok) {
    console.error('filter-validate FAILED:');
    for (const e of result.errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log(`filter-validate ok (KEEP=${result.keepCount})`);
  return result;
}

if (require.main === module) main();
module.exports = { validate, main };
