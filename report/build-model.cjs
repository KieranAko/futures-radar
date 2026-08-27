// report/build-model.cjs — Stage 5B: Analysis Integration
// Phase 8-A implementation
//
// Responsibility: Integrate analysis.json thesis layer with report-facts.json
// - Extract Q1-Q6 raw strings from analysis.json (preserve actual structure)
// - Record final judgments (finalDirection/finalConfidence/oddsBias)
// - Mark judgment changes (assessmentChanged when screening vs analysis differ)
// - Preserve numeric facts unchanged (inherit from report-facts.json)
//
// Current mode: Manual copy of analysis.json strings
// Future mode: LLM generates structured thesis JSON
//
// FORBIDDEN:
// - Modifying report-facts.json numeric fields
// - Tampering with provenance
// - Fabricating structured sub-fields from strings

const fs = require('fs');
const path = require('path');
const { runtimeRoot } = require('../lib/workspace.cjs');

// ── CLI ──────────────────────────────────────────────────────
const args = process.argv.slice(2);
function flagVal(flag) {
  const i = args.indexOf(flag);
  return i === -1 ? null : args[i + 1];
}

const runId = flagVal('--runId');
if (!runId) {
  console.error('FATAL: --runId required');
  process.exit(1);
}

const RUN_DIR = path.join(runtimeRoot, 'runs', runId);

// ── Helpers ──────────────────────────────────────────────────
function readJSON(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  const content = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(content);
}

function writeJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

// 六问 canonical 词汇（analyze/blueprint.md）；FinCoT 原始词汇 long/short/pass
// 若被 LLM 手写进 analysis.json，必须在此响亮报错，禁止透传到 report-model 静默渲染 '—'。
const DIRECTION_VOCAB = new Set(['bullish', 'bearish', 'neutral']);

function assertCanonicalDirection(value, field, symbol) {
  if (value === null || value === undefined) return; // 无方向合法态
  if (!DIRECTION_VOCAB.has(value)) {
    console.error(`FATAL: ${symbol} ${field} invalid canonical direction: ${JSON.stringify(value)} (expected bullish|bearish|neutral)`);
    process.exit(1);
  }
}

// ── Stage 5B Entry ───────────────────────────────────────────
console.log('=== Stage 5B: Analysis Integration ===');
console.log(`runId: ${runId}`);
console.log(`runDir: ${RUN_DIR}\n`);

// ── Step 1: Load artifacts ───────────────────────────────────
console.log('[1/4] Loading artifacts...');
const reportFactsPath = path.join(RUN_DIR, 'report-facts.json');
const analysisPath = path.join(RUN_DIR, 'analysis.json');

const reportFacts = readJSON(reportFactsPath);
const analysis = readJSON(analysisPath);

console.log(`  report-facts: ${reportFacts.opportunities.length} opportunities`);
console.log(`  analysis: ${analysis.analyses.length} analyses`);

// ── Step 2: RunId consistency check ──────────────────────────
console.log('\n[2/4] RunId consistency check...');
if (analysis.meta.runId !== runId) {
  console.error(`FATAL: analysis.json runId mismatch: expected ${runId}, got ${analysis.meta.runId}`);
  process.exit(1);
}
console.log(`  ✓ analysis.json runId matches: ${runId}`);

// ── Step 3: Symbol join validation ──────────────────────────
console.log('\n[3/4] Symbol join validation...');
const opportunitySymbols = reportFacts.opportunities.map(o => o.symbol);
console.log(`  Opportunity symbols: ${opportunitySymbols.join(', ')}`);

const missing = [];
for (const symbol of opportunitySymbols) {
  const analysisEntry = analysis.analyses.find(a => a.symbol === symbol);
  if (!analysisEntry) {
    missing.push(symbol);
  }
}

if (missing.length > 0) {
  console.error(`FATAL: Missing analysis for symbols: ${missing.join(', ')}`);
  process.exit(1);
}
console.log(`  ✓ All opportunity symbols have analysis`);

// ── Step 4: Build report-model with thesis layer ─────────────
console.log('\n[4/4] Building report-model with thesis layer...');

const reportModel = {
  meta: reportFacts.meta,
  screening: reportFacts.screening,
  rejected: reportFacts.rejected,
  macro: reportFacts.macro,
  sector: reportFacts.sector || null,
  sectorDriver: reportFacts.sectorDriver || null,
  freshness: reportFacts.freshness || null,
  opportunities: []
};

for (const opp of reportFacts.opportunities) {
  const analysisEntry = analysis.analyses.find(a => a.symbol === opp.symbol);

  if (!analysisEntry) {
    console.error(`FATAL: Analysis missing for ${opp.symbol}`);
    process.exit(1);
  }

  // P2 fail loud：方向字段遇非 canonical 值（FinCoT 词汇 long/short/pass 等）立即终止，
  // 不透传到 report-model（render-markdown 会静默渲染 '—'）。
  assertCanonicalDirection(opp.screening.initialDirection, 'screening.initialDirection', opp.symbol);
  assertCanonicalDirection(analysisEntry.direction, 'analysis.direction', opp.symbol);
  assertCanonicalDirection(analysisEntry.q3_odds.bias, 'analysis.q3_odds.bias', opp.symbol);

  // Extract thesis fields from analysis.json (preserve raw structure)
  const thesis = {
    driver: {
      primary: analysisEntry.q1_driver.primary,
      secondary: analysisEntry.q1_driver.secondary,
      evidence: analysisEntry.q1_driver.evidence, // raw string
      source: analysisEntry.q1_driver.source,
      provenance: {
        artifactId: 'analysis-json',
        runId: analysis.meta.runId,
        field: 'q1_driver'
      }
    },
    trendOrImpulse: {
      assessment: typeof analysisEntry.q2_trendOrImpulse === 'string'
        ? analysisEntry.q2_trendOrImpulse
        : (analysisEntry.q2_trendOrImpulse.assessment ||
           [analysisEntry.q2_trendOrImpulse.volumeChange,
            analysisEntry.q2_trendOrImpulse.oiChange,
            analysisEntry.q2_trendOrImpulse.priceAlignment].filter(Boolean).join('; ')),
      provenance: {
        artifactId: 'analysis-json',
        runId: analysis.meta.runId,
        field: 'q2_trendOrImpulse'
      }
    },
    odds: {
      bias: analysisEntry.q3_odds.bias,
      reasoning: analysisEntry.q3_odds.reasoning || analysisEntry.q3_odds.summary ||
                 `多头: ${(analysisEntry.q3_odds.longCase || []).join('; ')} vs 空头: ${(analysisEntry.q3_odds.shortCase || []).join('; ')}`,
      provenance: {
        artifactId: 'analysis-json',
        runId: analysis.meta.runId,
        field: 'q3_odds'
      }
    },
    confirmations: {
      signals: analysisEntry.q4_confirmation.signals, // raw string[]
      provenance: {
        artifactId: 'analysis-json',
        runId: analysis.meta.runId,
        field: 'q4_confirmation'
      }
    },
    invalidations: {
      conditions: analysisEntry.q5_invalidation.conditions, // raw string[]
      provenance: {
        artifactId: 'analysis-json',
        runId: analysis.meta.runId,
        field: 'q5_invalidation'
      }
    },
    risks: {
      items: analysisEntry.q6_risks.items || [
        analysisEntry.q6_risks.limitDistance || '',
        analysisEntry.q6_risks.overnightGap || '',
        analysisEntry.q6_risks.margin || '',
        analysisEntry.q6_risks.rollover || '',
        analysisEntry.q6_risks.eventRisk || ''
      ].filter(Boolean),
      provenance: {
        artifactId: 'analysis-json',
        runId: analysis.meta.runId,
        field: 'q6_risks'
      }
    },
    finalDirection: analysisEntry.direction,
    finalConfidence: analysisEntry.confidence,
    assessmentChanged: (
      opp.screening.initialDirection !== analysisEntry.direction ||
      opp.screening.initialConfidence !== analysisEntry.confidence
    )
  };

  reportModel.opportunities.push({
    symbol: opp.symbol,
    name: opp.name,
    rank: opp.rank,
    sector: opp.sector || null,
    marketFacts: opp.marketFacts,
    priceRanges: opp.priceRanges,
    screening: opp.screening,
    thesis
  });

  if (thesis.assessmentChanged) {
    console.log(`  ⚠️  ${opp.symbol}: Judgment changed (${opp.screening.initialDirection}/${opp.screening.initialConfidence} → ${analysisEntry.direction}/${analysisEntry.confidence})`);
  }
}

console.log(`  ✓ Built ${reportModel.opportunities.length} opportunities with thesis`);

// ── Output: report-model.json ─────────────────────────────────
console.log('\n[Output] Writing report-model.json...');
const outputPath = path.join(RUN_DIR, 'report-model.json');
writeJSON(outputPath, reportModel);

console.log(`  ✓ Written to: ${outputPath}`);
console.log('\n=== Stage 5B Complete ===');
console.log(`Total opportunities: ${reportModel.opportunities.length}`);
console.log(`Judgment changes: ${reportModel.opportunities.filter(o => o.thesis.assessmentChanged).length}`);
console.log(`Output: report-model.json (${JSON.stringify(reportModel).length} bytes)`);

