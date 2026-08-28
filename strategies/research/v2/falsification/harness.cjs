// falsification harness — CLI entry
// usage:
//   node harness.cjs selftest [--verbose]          run synthetic self-test battery
//   node harness.cjs run --spec <id|file> [--seed N] [--out <dir>] [--verbose]
//   node harness.cjs list                          list specs and adapters
//   node harness.cjs validate-spec <file>          validate a spec JSON against the schema
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { FALS_DIR, FALS_DATA_DIR, REPO_ROOT } = require('./harness-lib/util.cjs');
const { Engine, compareToBaseline } = require('./harness-lib/engine.cjs');
const G = require('./harness-lib/gates.cjs');
const { renderMarkdown, buildBundle } = require('./harness-lib/report.cjs');
const selftest = require('./harness-lib/selftest.cjs');
const demoAdapter = require('./harness-lib/strategies/demo.cjs');
const tr01Adapter = require('./harness-lib/strategies/TR-01.cjs');
const tr03Adapter = require('./harness-lib/strategies/TR-03.cjs');
const tr06Adapter = require('./harness-lib/strategies/TR-06.cjs');
const fs04Adapter = require('./harness-lib/strategies/FS-04.cjs');
const fs05Adapter = require('./harness-lib/strategies/FS-05.cjs');
const m1Adapter = require('./harness-lib/strategies/M1.cjs');
const ec01Adapter = require('./harness-lib/strategies/EC-01.cjs');

const SPECS_DIR = path.join(FALS_DIR, 'specs');
const ADAPTERS = {
  demo: demoAdapter,
  'TR-01': tr01Adapter,
  'TR-03': tr03Adapter,
  'TR-06': tr06Adapter,
  'FS-04': fs04Adapter,
  'FS-05': fs05Adapter,
  M1: m1Adapter,
  'EC-01': ec01Adapter,
};

function listSpecs() {
  const out = [];
  if (fs.existsSync(SPECS_DIR)) {
    for (const f of fs.readdirSync(SPECS_DIR).filter((f) => f.endsWith('.json'))) {
      const spec = JSON.parse(fs.readFileSync(path.join(SPECS_DIR, f), 'utf8'));
      out.push({ file: f, specId: spec.specId, strategyId: spec.strategyId, adapter: spec.signal?.adapter });
    }
  }
  return out;
}

function loadSpec(ref) {
  const byFile = path.isAbsolute(ref) || ref.endsWith('.json')
    ? ref
    : path.join(SPECS_DIR, `${ref}.json`);
  if (fs.existsSync(byFile)) {
    return { spec: JSON.parse(fs.readFileSync(byFile, 'utf8')), file: byFile };
  }
  throw new Error(`spec not found: ${ref} (looked in ${SPECS_DIR})`);
}

function validateSpec(spec) {
  const errors = [];
  const need = (cond, msg) => { if (!cond) errors.push(msg); };
  need(spec.specId && typeof spec.specId === 'string', 'specId required');
  need(spec.strategyId && typeof spec.strategyId === 'string', 'strategyId required');
  need(Array.isArray(spec.universe?.symbols) && spec.universe.symbols.length > 0, 'universe.symbols non-empty');
  need(typeof spec.period?.start === 'string' && typeof spec.period?.end === 'string', 'period.start/end required');
  need(['purged-expanding', 'rolling'].includes(spec.folds?.mode), 'folds.mode ∈ {purged-expanding, rolling}');
  need(spec.execution?.cost && typeof spec.execution.cost.roundtripBps === 'number', 'execution.cost.roundtripBps number');
  need(Array.isArray(spec.strategyLevel?.baselines), 'strategyLevel.baselines array');
  need(typeof spec.strategyLevel?.minTrades === 'number', 'strategyLevel.minTrades number');
  need(typeof spec.strategyLevel?.pfThreshold === 'number', 'strategyLevel.pfThreshold number');
  need(spec.signal?.adapter && ADAPTERS[spec.signal.adapter], `signal.adapter registered (available: ${Object.keys(ADAPTERS).join(', ')})`);
  if (spec.universe?.symbols?.length) {
    for (const sym of spec.universe.symbols) {
      const f = path.join(REPO_ROOT, 'data', 'daily', `${sym}.json`);
      need(fs.existsSync(f), `data/daily/${sym}.json missing`);
    }
  }
  return errors;
}

function runSpec(spec, { seed = 20260828, outDir = null, verbose = false }) {
  const errors = validateSpec(spec);
  if (errors.length) throw new Error(`spec invalid:\n- ${errors.join('\n- ')}`);
  const engine = new Engine(spec, { adapters: ADAPTERS, seed });
  const result = engine.run();
  const strategyGate = G.evaluateStrategyGate(result, spec);
  const theoryEval = G.evaluateTheory(result.theory);
  const killVerdicts = G.evaluateKillRules(result, spec, theoryEval);
  const suggestion = G.suggestState({ spec, strategyGate, theoryEval, killVerdicts });
  const baselineComparisons = {};
  const netRs = result.trades.map((t) => t.netR);
  if (result.baselines.random) {
    baselineComparisons.random = compareToBaseline(netRs, result.baselines.random.pooledNetRs, { seed: seed + 2 });
  }
  for (const name of ['always-long', 'always-short']) {
    const b = result.baselines[name];
    if (b) {
      // bps-space market baselines: convert to pseudo-R via the strategy's median RELATIVE
      // initial-risk distance (|entry-stop|/entry), keeping units comparable with trade R-multiples
      const relRisks = result.trades
        .map((t) => {
          const risk = Math.abs(t.legs.reduce((s, l) => s + l.weight * (l.entry - l.stop), 0));
          const notional = Math.abs(t.legs.reduce((s, l) => s + l.weight * l.entry, 0));
          return notional > 0 ? risk / notional : null;
        })
        .filter((x) => x !== null && x > 0);
      const medianRelRisk = median(relRisks);
      const pseudoRs = b.rows.map((r) => (r.retBps / 1e4) / Math.max(0.0001, medianRelRisk || 1));
      baselineComparisons[name] = {
        convention: 'market baseline in bps converted to pseudo-R via strategy median relative initial-risk distance (|entry-stop|/entry)',
        strategyMeanR: strategyGate.stats.meanR,
        baselineMeanBps: b.stats.meanRetBps,
        baselineMeanPseudoR: pseudoRs.length ? pseudoRs.reduce((a, x) => a + x, 0) / pseudoRs.length : null,
      };
    }
  }
  const bundle = buildBundle({
    result, strategyGate, theoryEval, killVerdicts, suggestion, baselineComparisons,
    library: spec.library || null,
    specFile: spec.specId,
  });
  const md = renderMarkdown({ result, strategyGate, theoryEval, killVerdicts, suggestion, baselineComparisons, library: spec.library || null });
  const outDirResolved = outDir || path.join(FALS_DATA_DIR, 'harness-runs');
  fs.mkdirSync(outDirResolved, { recursive: true });
  const base = `${spec.specId}-seed${seed}`;
  const jsonFile = path.join(outDirResolved, `${base}.json`);
  const mdFile = path.join(outDirResolved, `${base}.md`);
  fs.writeFileSync(jsonFile, JSON.stringify(bundle, null, 2), 'utf8');
  fs.writeFileSync(mdFile, md, 'utf8');
  if (verbose) {
    console.log(`trades=${strategyGate.stats.n} meanR=${strategyGate.stats.meanR} PF=${strategyGate.stats.pf} CI=[${strategyGate.stats.ci95}]`);
    console.log(`suggestedState=${suggestion.suggestedState}`);
    console.log(`written: ${jsonFile}`);
    console.log(`written: ${mdFile}`);
  }
  return { bundle, mdFile, jsonFile };
}

function median(xs) {
  const a = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((p, q) => p - q);
  if (!a.length) return 0;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function main(argv) {
  const cmd = argv[2] || 'help';
  const flag = (name) => argv.includes(name);
  const opt = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
  };
  if (cmd === 'selftest') {
    const s = selftest.runAll({ verbose: flag('--verbose') });
    process.exit(s.failed > 0 ? 1 : 0);
  }
  if (cmd === 'run') {
    const ref = opt('--spec');
    if (!ref) { console.error('usage: node harness.cjs run --spec <id|file> [--seed N] [--out dir]'); process.exit(2); }
    const { spec, file } = loadSpec(ref);
    const seed = Number(opt('--seed') || 20260828);
    const outDir = opt('--out');
    console.log(`spec: ${spec.specId} (${file}) · seed=${seed}`);
    const r = runSpec(spec, { seed, outDir, verbose: true });
    console.log(`report: ${r.mdFile}`);
    return;
  }
  if (cmd === 'list') {
    console.log('specs:');
    for (const s of listSpecs()) console.log(`  ${s.file}  →  ${s.specId} (${s.strategyId}) adapter=${s.adapter}`);
    console.log('adapters:', Object.keys(ADAPTERS).join(', '));
    return;
  }
  if (cmd === 'validate-spec') {
    const ref = argv[3];
    if (!ref) { console.error('usage: node harness.cjs validate-spec <file>'); process.exit(2); }
    const { spec } = loadSpec(ref);
    const errors = validateSpec(spec);
    if (errors.length) {
      console.error('spec invalid:');
      for (const e of errors) console.error(`  - ${e}`);
      process.exit(1);
    }
    console.log('spec valid');
    return;
  }
  console.log(`falsification harness
  node harness.cjs selftest [--verbose]
  node harness.cjs run --spec <id|file> [--seed N] [--out dir] [--verbose]
  node harness.cjs list
  node harness.cjs validate-spec <file>`);
}

if (require.main === module) main(process.argv);

module.exports = { runSpec, validateSpec, listSpecs, ADAPTERS };
