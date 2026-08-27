// report/build-facts.cjs — Stage 5A: Report Facts Assembly
// Phase 8-A implementation
//
// Responsibility: Deterministic facts assembly from 3 JSON artifacts
// - Symbol join validation (runId consistency, KEEP candidates presence)
// - Numeric field extraction (close/atr/hv/cone/divergence)
// - Screening stage judgment recording (initialDirection/initialConfidence)
// - Screening stage text copying (summary/watchConditions/criteria.*.note, verbatim)
// - Data quality aggregation (correctionCount/totalBars/degraded)
// - Provenance tracking (artifactId/runId/jsonPath/timestamp)
// - Phase 3 阶段一：macro-snapshot.json 原样透传 + 传导路由（不改数值、不重算）
//
// FORBIDDEN:
// - Synthesizing new natural language descriptions
// - Calling LLM
// - Estimating or modifying numeric values
// - Reading candidates.json ATR fields (use probability.json.atrComparison only)
// - 修改/重算宏观快照数值（透传）；报告阶段不联网

const fs = require('fs');
const path = require('path');
const { runtimeRoot, skillRoot } = require('../lib/workspace.cjs');
const { validateMacroSnapshot } = require('../collector/macro-probe.cjs');
const { buildFreshness } = require('./freshness.cjs');
const dataStore = require('../data-store/index.cjs');

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

// ── 宏观传导路由（模块级，可单测）─────────────────────────────
let _transmissionCfg = null;
function loadTransmissionConfig() {
  if (!_transmissionCfg) {
    _transmissionCfg = readJSON(path.join(skillRoot, 'config', 'macro-transmission.json'));
  }
  return _transmissionCfg;
}

let _macroIndicatorCfg = null;
function loadMacroIndicatorConfig() {
  if (!_macroIndicatorCfg) {
    _macroIndicatorCfg = readJSON(path.join(skillRoot, 'config', 'macro-indicators.json'));
  }
  return _macroIndicatorCfg;
}

// 品种代码去尾 0 → 前缀，自上而下首个命中生效；未命中 → 空集（not_applicable 合法）
function relevantAnchorsFor(symbol) {
  const prefix = String(symbol).replace(/0$/, '');
  const rules = loadTransmissionConfig().rules || [];
  for (const rule of rules) {
    if ((rule.prefixes || []).includes(prefix)) {
      return (rule.anchors || []).slice();
    }
  }
  return [];
}

// 展示层信息（label/unit/decimals）由 5A 一次性注入，5C 不读配置
function buildMacroDisplayMap() {
  const cfg = loadMacroIndicatorConfig();
  const display = {};
  for (const [id, c] of Object.entries(cfg.indicators)) {
    display[id] = { label: c.label, unit: c.unit, decimals: c.decimals };
  }
  return display;
}

// 宏观段：快照存在且 schema 校验通过且 runId 一致 → available=true + 透传；
// 快照缺失/不可解析/schema 损坏 → 尝试 data-store 中同 runId 的精确镜像；
// 仍无 → available=false（fail closed）；runId 不一致 → 仍透传但标记不可用
function loadMacroSnapshotWithStoreFallback(runDir, runId) {
  const snapshotPath = path.join(runDir, 'macro-snapshot.json');
  if (fs.existsSync(snapshotPath)) {
    try {
      return { snapshot: readJSON(snapshotPath), fromStore: false };
    } catch (e) {
      // 文件损坏，尝试文件库精确镜像
    }
  }
  try {
    const stored = dataStore.getMacroSnapshot(runId);
    if (stored) return { snapshot: stored, fromStore: true };
  } catch {
    // 忽略文件库异常，按缺失处理
  }
  return { snapshot: null, fromStore: false };
}

function buildMacroSection(runDir, runId, keepSymbols) {
  const loaded = loadMacroSnapshotWithStoreFallback(runDir, runId);
  if (!loaded.snapshot) {
    return { available: false, reason: 'no macro-snapshot.json in run (旧 run 未采集宏观快照)' };
  }
  const snapshot = loaded.snapshot;
  // 复用采集阶段同款校验：可解析但 schema 损坏的快照不得进入报告（fail closed）
  const v = validateMacroSnapshot(snapshot);
  if (!v.ok) {
    return { available: false, reason: `macro-snapshot failed validation: ${v.errors.slice(0, 3).join('; ')}` };
  }
  const runIdMatch = snapshot.meta.runId === runId;
  const relevance = {};
  for (const sym of keepSymbols) {
    relevance[sym] = relevantAnchorsFor(sym);
  }
  return {
    available: runIdMatch,
    reason: runIdMatch ? undefined : `macro-snapshot runId mismatch: ${snapshot.meta.runId}`,
    meta: snapshot.meta,
    indicators: snapshot.indicators,
    quality: snapshot.quality,
    relevance,
    display: buildMacroDisplayMap(),
    fromStoreFallback: loaded.fromStore || undefined
  };
}

// ── Stage 5A Entry ───────────────────────────────────────────
function main() {
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

  console.log('=== Stage 5A: Report Facts Assembly ===');
  console.log(`runId: ${runId}`);
  console.log(`runDir: ${RUN_DIR}\n`);

  // ── Step 1: Load artifacts ───────────────────────────────────
  console.log('[1/7] Loading artifacts...');
  const candidatesPath = path.join(RUN_DIR, 'candidates.json');
  const filteredPath = path.join(RUN_DIR, 'filtered.json');
  const probabilityPath = path.join(RUN_DIR, 'probability.json');

  const candidates = readJSON(candidatesPath);
  const filtered = readJSON(filteredPath);
  const probability = readJSON(probabilityPath);

  // 锚定合约（Analyze 阶段冻结的主导合约；缺失时旧 run 显示 —）
  const mainSeriesPath = path.join(RUN_DIR, 'analyze', 'main-series.json');
  let mainSeries = {};
  try {
    mainSeries = fs.existsSync(mainSeriesPath) ? readJSON(mainSeriesPath) : {};
  } catch {
    mainSeries = {};
  }

  console.log(`  candidates: ${candidates.candidates.length} symbols`);
  console.log(`  filtered: ${filtered.candidates.length} KEEP, ${filtered.downgraded.length} DOWNGRADE`);
  console.log(`  probability: ${probability.probabilities.length} entries`);

  // ── Step 2: RunId consistency gate ───────────────────────────
  console.log('\n[2/7] RunId consistency check...');
  const runIds = {
    candidates: candidates.meta.runId,
    filtered: filtered.meta.runId,
    probability: probability.meta.runId
  };

  const uniqueRunIds = new Set(Object.values(runIds));
  if (uniqueRunIds.size > 1) {
    console.error('FATAL: RunId mismatch across artifacts:');
    console.error(JSON.stringify(runIds, null, 2));
    process.exit(1);
  }
  console.log(`  ✓ All artifacts share runId: ${runId}`);

  // ── Step 3: Symbol join gate ─────────────────────────────────
  console.log('\n[3/7] Symbol join validation...');
  const keepSymbols = filtered.candidates.map(c => c.symbol);
  console.log(`  KEEP symbols: ${keepSymbols.join(', ')}`);

  // Check each KEEP symbol exists in all artifacts
  const missing = [];
  for (const symbol of keepSymbols) {
    const inCandidates = candidates.candidates.some(c => c.symbol === symbol);
    const inProbability = probability.probabilities.some(p => p.symbol === symbol);

    if (!inCandidates) missing.push(`${symbol} missing in candidates.json`);
    if (!inProbability) missing.push(`${symbol} missing in probability.json`);
  }

  if (missing.length > 0) {
    console.error('FATAL: Symbol join failed:');
    missing.forEach(m => console.error(`  - ${m}`));
    process.exit(1);
  }
  console.log(`  ✓ All KEEP symbols present in all artifacts`);

  // ── Step 4: Build screening.top10 ────────────────────────────
  console.log('\n[4/7] Building screening.top10...');
  const top10 = candidates.candidates.slice(0, 10).map((c, idx) => ({
    rank: idx + 1,
    symbol: c.symbol,
    name: c.name,
    exchange: c.exchange,
    sector: c.sector,
    score: c.score,
    indicators: {
      atr5: c.indicators.atr5,
      atrPct: c.indicators.atrPct,
      hv5: c.indicators.hv5,
      hv20: c.indicators.hv20,
      volPercentile: c.indicators.volPercentile,
      volMultiplier: c.indicators.volMultiplier,
      change5d: c.indicators.change5d
    },
    trend: {
      close: c.trend.close,
      vsMA20: c.trend.vsMA20,
      vsMA60: c.trend.vsMA60,
      direction: c.trend.direction
    },
    liquidity: {
      avgVolume5d: c.liquidity.avgVolume5d,
      avgTurnover5d: c.liquidity.avgTurnover5d,
      avgOI5d: c.liquidity.avgOI5d
    },
    provenance: {
      artifactId: 'candidates-json',
      runId: candidates.meta.runId,
      index: idx
    }
  }));
  console.log(`  ✓ Extracted ${top10.length} top candidates`);

  // ── Step 5: Build screening.decisions ─────────────────────────
  console.log('\n[5/7] Building screening.decisions...');
  const decisions = [];

  // KEEP decisions
  for (const c of filtered.candidates) {
    const candidateEntry = candidates.candidates.find(cc => cc.symbol === c.symbol);
    if (!candidateEntry) {
      console.error(`FATAL: KEEP symbol ${c.symbol} not found in candidates.json`);
      process.exit(1);
    }
    decisions.push({
      symbol: c.symbol,
      name: candidateEntry.name,
      rank: candidateEntry.rank || candidates.candidates.indexOf(candidateEntry) + 1,
      decision: 'KEEP',
      initialConfidence: c.confidence,
      initialDirection: c.directionBias,
      provenance: {
        artifactId: 'filtered-json',
        runId: filtered.meta.runId,
        path: 'candidates'
      }
    });
  }

  // DOWNGRADE decisions
  for (const d of filtered.downgraded) {
    const candidateEntry = candidates.candidates.find(c => c.symbol === d.symbol);
    decisions.push({
      symbol: d.symbol,
      name: candidateEntry ? candidateEntry.name : d.symbol,
      rank: candidateEntry ? (candidateEntry.rank || candidates.candidates.indexOf(candidateEntry) + 1) : 999,
      decision: 'DOWNGRADE',
      initialConfidence: null,
      initialDirection: null,
      reason: d.reason,
      note: d.note || undefined,
      provenance: {
        artifactId: 'filtered-json',
        runId: filtered.meta.runId,
        path: 'downgraded'
      }
    });
  }
  console.log(`  ✓ Built ${decisions.length} decisions (${filtered.candidates.length} KEEP, ${filtered.downgraded.length} DOWNGRADE)`);

  // ── Step 6: Build opportunities + rejected ────────────────────
  console.log('\n[6/7] Building opportunities and rejected...');
  const opportunities = [];
  const rejected = [];

  // Build opportunities from KEEP candidates
  for (const keepCandidate of filtered.candidates) {
    const symbol = keepCandidate.symbol;
    const candidateEntry = candidates.candidates.find(c => c.symbol === symbol);
    const probEntry = probability.probabilities.find(p => p.symbol === symbol);

    if (!candidateEntry || !probEntry) {
      console.error(`FATAL: Symbol ${symbol} missing in candidates or probability`);
      process.exit(1);
    }

    // Extract price ranges from probability.json (3d and 5d)
    const priceRanges = [];
    if (probEntry.cone) {
      for (const period of ['3d', '5d']) {
        const coneData = probEntry.cone[period];
        const atrComp = probEntry.atrComparison;

        priceRanges.push({
          period,
          hvCone: coneData ? {
            p68: coneData.p68,
            p95: coneData.p95
          } : null,
          atrBand: {
            atr5: atrComp.atr5,
            band: atrComp.atr2xBand
          },
          divergence: {
            pct: atrComp.divergencePct !== undefined ? atrComp.divergencePct : null,
            interpretation: atrComp.interpretation
          },
          provenance: {
            artifactId: 'probability-json',
            runId: probability.meta.runId,
            calculatedAt: probability.meta.calculatedAt
          }
        });
      }
    }

    opportunities.push({
      symbol,
      name: candidateEntry.name,
      rank: candidateEntry.rank || candidates.candidates.indexOf(candidateEntry) + 1,
      sector: candidateEntry.sector,
      contract: (mainSeries[symbol] && mainSeries[symbol].contract) || null,
      marketFacts: {
        close: probEntry.close,
        hv: probEntry.hv ? {
          annual: probEntry.hv.annual,
          periodDays: probEntry.hv.periodDays,
          percentile90d: probEntry.hv.percentile90d,
          estimator: probEntry.hv.estimator,
          correctionCount: probEntry.hv.correctionCount,
          totalBars: probEntry.hv.totalBars,
          degraded: probEntry.hv.degraded
        } : null,
        provenance: {
          close: { artifactId: 'probability-json', runId: probability.meta.runId, path: `probabilities[${symbol}].close` },
          hv: probEntry.hv ? { artifactId: 'probability-json', runId: probability.meta.runId, path: `probabilities[${symbol}].hv` } : null
        }
      },
      priceRanges,
      screening: {
        initialConfidence: keepCandidate.confidence,
        initialDirection: keepCandidate.directionBias,
        criteria: keepCandidate.criteria,
        summary: keepCandidate.summary,
        watchConditions: keepCandidate.watchConditions,
        provenance: {
          artifactId: 'filtered-json',
          runId: filtered.meta.runId,
          path: `candidates[${symbol}]`
        }
      }
    });
  }

  // Build rejected from DOWNGRADE
  for (const d of filtered.downgraded) {
    const candidateEntry = candidates.candidates.find(c => c.symbol === d.symbol);
    rejected.push({
      symbol: d.symbol,
      name: candidateEntry ? candidateEntry.name : d.symbol,
      rank: candidateEntry ? (candidateEntry.rank || candidates.candidates.indexOf(candidateEntry) + 1) : 999,
      reason: d.reason,
      note: d.note || '',
      provenance: {
        artifactId: 'filtered-json',
        runId: filtered.meta.runId,
        path: 'downgraded'
      }
    });
  }

  console.log(`  ✓ Built ${opportunities.length} opportunities, ${rejected.length} rejected`);

  // ── Step 7: Macro section（Phase 3 阶段一）────────────────────
  console.log('\n[7/7] Building macro section...');
  const macro = buildMacroSection(RUN_DIR, runId, keepSymbols);

  // 数据时效段（v0.1.2）：只读 raw.json 的 meta/contracts 元数据（末 bar 日期/来源盖章），
  // 不重算行情数值；raw.json 缺失/不可解析 → freshness=null，5C 跳过卡片（旧 run 兼容）
  let freshness = null;
  const rawJsonPath = path.join(RUN_DIR, 'raw.json');
  if (fs.existsSync(rawJsonPath)) {
    try {
      freshness = buildFreshness({
        rawJson: readJSON(rawJsonPath),
        macroSnapshot: macro.available ? macro : null
      });
      console.log(`\n  freshness: latestBar=${freshness.latestBarDate} (${freshness.withLatestBar}/${freshness.totalSymbols})`);
    } catch (e) {
      console.warn(`  ⚠️ freshness unavailable: ${e.message}`);
      freshness = null;
    }
  } else {
    console.warn('  ⚠️ raw.json not found — freshness card disabled');
  }
  console.log(macro.available
    ? `  ✓ macro-snapshot available (${macro.quality.available} available, ${macro.quality.missing} missing)`
    : `  macro unavailable: ${macro.reason}`);

  // v0.1.5：板块异动快照（采集层产出；缺失时回退文件库同 runId 快照）
  let sector = null;
  const sectorSnapshotPath = path.join(RUN_DIR, 'sector-snapshot.json');
  try {
    sector = fs.existsSync(sectorSnapshotPath)
      ? readJSON(sectorSnapshotPath)
      : dataStore.getSectorSnapshot(runId);
  } catch (e) {
    console.warn(`  ⚠️ sector snapshot unavailable: ${e.message}`);
  }
  console.log(sector && sector.sectors
    ? `  ✓ sector-snapshot available (${Object.keys(sector.sectors).length} sectors)`
    : '  sector unavailable: report renders sector table as empty');

  // 板块驱动 LLM 结论（独立于 sector 观察值）
  let sectorDriver = null;
  const sectorDriverPath = path.join(RUN_DIR, 'sector-driver.json');
  if (fs.existsSync(sectorDriverPath)) {
    try {
      sectorDriver = readJSON(sectorDriverPath);
      console.log(`  ✓ sector-driver available (${Object.keys(sectorDriver.sectors || {}).length} sectors)`);
    } catch (e) {
      console.warn(`  ⚠️ sector-driver unreadable: ${e.message}`);
    }
  } else {
    console.log('  sector-driver unavailable: 驱动线索列显示 —');
  }

  // ── Output: report-facts.json ────────────────────────────────
  console.log('\n[Output] Writing report-facts.json...');

  const reportFacts = {
    meta: {
      runId,
      generatedAt: new Date().toISOString(),
      totalSymbols: candidates.meta.preFilter?.total || candidates.candidates.length,
      top10Count: top10.length,
      keepCount: filtered.candidates.length,
      pipelineVersion: '0.1.8',
      artifacts: {
        candidates: {
          runId: candidates.meta.runId,
          scannedAt: candidates.meta.scannedAt || candidates.meta.timestamp
        },
        filtered: {
          runId: filtered.meta.runId,
          filteredAt: filtered.meta.filteredAt || filtered.meta.timestamp
        },
        probability: {
          runId: probability.meta.runId,
          calculatedAt: probability.meta.calculatedAt
        }
      }
    },
    screening: {
      top10,
      decisions
    },
    opportunities,
    rejected,
    macro,
    sector,
    sectorDriver,
    freshness
  };

  const outputPath = path.join(RUN_DIR, 'report-facts.json');
  writeJSON(outputPath, reportFacts);

  console.log(`  ✓ Written to: ${outputPath}`);
  console.log('\n=== Stage 5A Complete ===');
  console.log(`Total opportunities: ${opportunities.length}`);
  console.log(`Total rejected: ${rejected.length}`);
  console.log(`Output: report-facts.json (${JSON.stringify(reportFacts).length} bytes)`);
}

if (require.main === module) {
  main();
}

module.exports = { relevantAnchorsFor };
