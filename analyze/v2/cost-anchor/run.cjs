// experiment-line/cost-anchor/run.cjs — 每期 TOP3 成本锚入口（cache-first）
//
// 用法:
//   node analyze/v2/cost-anchor/run.cjs --runId <runId>
//
// 第一次（有 miss/stale）: 写 data/cost-anchor/research/<runId>.brief.json，退出码 2（等待检索结果）
// 填入 data/cost-anchor/research/<runId>.results.json 后重跑:
//   validate → ingest 到 data-store 主档 → 投影 output/runs/<runId>/cost-anchor.json
// 检索任务与结果只走文件库，不读、不写 output/runs/<runId>/analyze/。
'use strict';

const { freshness } = require('./policy.cjs');
const { dataStore, resolveFromLibrary, projectSnapshot, researchResultsPath, readJson } = require('./library.cjs');
const { normalizeResearchResult } = require('./extract.cjs');
const { validateResearchBatch } = require('./validate.cjs');
const { buildBrief } = require('./research-runner.cjs');

const TYPE_HINTS = {
  black: 'processing_margin',
  nonferrous: 'extraction',
  precious: 'extraction',
  energy_chemical: 'processing_margin',
  agriculture: 'production_cost',
  new_materials: 'extraction',
  shipping: 'none'
};

function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--runId');
  const runId = i >= 0 ? args[i + 1] : null;
  if (!runId) throw new Error('--runId required');
  const force = args.includes('--force');

  const resolved = resolveFromLibrary(runId, freshness);
  const pending = force ? resolved.symbols : resolved.symbols.filter((s) => !s.reused);
  if (pending.length === 0) {
    const out = projectSnapshot(runId, resolved.signalDate);
    console.log(`cost-anchor: all ${resolved.symbols.length} cache-hit; snapshot projected`);
    return { ok: true, runId, snapshot: out };
  }

  const resultsFile = researchResultsPath(runId);
  const results = readJson(resultsFile, null);
  if (!results) {
    const targets = pending.map((p) => ({
      symbol: p.symbol,
      name: p.name || p.symbol,
      sector: p.sector,
      anchorType: TYPE_HINTS[p.sector] || 'processing_margin',
      signalDate: resolved.signalDate
    }));
    const brief = buildBrief(runId, targets);
    console.log(`cost-anchor: ${pending.length} symbol(s) need research`);
    for (const r of brief.requests) console.log(`  - ${r.symbol} (${r.anchorType}): ${r.queries.join(' | ')}`);
    console.log(`STOP — 完成检索后写入: ${resultsFile}`);
    process.exitCode = 2;
    return { ok: false, phase: 'research_required', brief: brief.file, pending: pending.map((p) => p.symbol) };
  }

  const rawResults = results.results || results;
  const normalizedInputs = rawResults.map((raw) => normalizeResearchResult(raw, { runId, signalDate: resolved.signalDate }));
  const batch = validateResearchBatch(normalizedInputs, pending.map((p) => p.symbol), resolved.signalDate);
  if (!batch.ok) {
    console.error('cost-anchor research results validation FAILED:');
    for (const e of batch.errors) console.error(`  - ${e}`);
    process.exitCode = 1;
    return { ok: false, phase: 'validation_failed', errors: batch.errors };
  }
  for (const [symbol, record] of Object.entries(batch.records)) {
    const res = dataStore.ingestCostAnchor({ runId, symbol, record });
    if (!res.written) {
      console.error(`  ingest failed ${symbol}: ${res.reason}`);
      process.exitCode = 1;
      return { ok: false, phase: 'ingest_failed', symbol, reason: res.reason };
    }
    console.log(`  ingested ${symbol}: ${res.recordId} (${record.anchorType}, ${record.confidence})`);
  }
  // 写回主档后必须从主档重新投影（不直接用检索结果写快照）
  const out = projectSnapshot(runId, resolved.signalDate);
  console.log(`cost-anchor: snapshot projected from library (${out.symbols.length} symbols)`);
  return { ok: true, runId, snapshot: out };
}

if (require.main === module) main();
module.exports = { main, TYPE_HINTS };
