// experiment-line/cost-anchor/research-runner.cjs — 只为 miss/stale 的 TOP3 品种生成检索任务
// 检索模板来自 data/cost-anchor/query-templates.json（方法学指标名，不泛搜"成本"）。
'use strict';

const path = require('node:path');
const ROOT = require('./root.cjs');
const { loadQueryTemplates, loadGoldenSources } = require('./policy.cjs');
const { runDir } = require(path.join(ROOT, 'lib', 'workspace.cjs'));
const { writeJson, readJson } = require('./library.cjs');

function fillTemplate(tpl, ctx) {
  return tpl
    .replace(/\{name\}/g, ctx.name)
    .replace(/\{indicator\}/g, ctx.indicator)
    .replace(/\{year\}/g, ctx.year || String(ctx.signalDate).slice(0, 4));
}

function buildBrief(runId, targets) {
  const templates = loadQueryTemplates();
  const golden = loadGoldenSources();
  const signalDate = targets[0].signalDate;
  const requests = targets.map((t) => {
    const typeTemplates = (templates.types && templates.types[t.anchorType]) || templates.types.processing_margin;
    const queries = [];
    for (const indicator of typeTemplates.indicators.slice(0, 2)) {
      for (const tpl of typeTemplates.queries.slice(0, 2)) {
        queries.push(fillTemplate(tpl, { ...t, indicator }));
      }
    }
    return {
      symbol: t.symbol,
      name: t.name,
      sector: t.sector,
      anchorType: t.anchorType,
      signalDate,
      queries: [...new Set(queries)].slice(0, 3),
      allowedSources: (golden.bySector && golden.bySector[t.sector]) || [],
      outputContract: {
        schema: 'futures-radar-cost-anchor-research/1',
        required: ['symbol', 'anchorType', 'indicator', 'valueLow', 'valueHigh', 'unit', 'asOf', 'sourceDates', 'sourceTiers', 'sources', 'confidence'],
        notes: [
          '每个数字必须带来源 URL 与发布日期',
          '禁止股吧/社交媒体，除非引用可回溯官方原文',
          '查不到时输出 status="unknown"，禁止编造'
        ]
      }
    };
  });
  const brief = {
    schema: 'futures-radar-cost-anchor-research-brief/1',
    runId,
    signalDate,
    targets: requests
  };
  const file = path.join(runDir(runId), 'analyze', 'cost-anchor-research-brief.json');
  writeJson(file, brief);
  return { file, requests };
}

module.exports = { buildBrief, fillTemplate };
