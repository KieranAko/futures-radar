#!/usr/bin/env node
/**
 * akshare-futures.cjs — futures-radar collector (Phase 3)
 * Wraps Python futures_collector.py, enriches with metadata, writes output artifacts.
 *
 * Usage:
 *   node collector/akshare-futures.cjs --runId 20260730-1645-auto
 */

const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { runtimeRoot, skillRoot } = require('../lib/workspace.cjs');
const { ParallelCollector } = require('./parallel-collector.cjs');
const { rejectFutureDateContracts } = require('./future-date-guard.cjs');

// ── CLI ──────────────────────────────────────────────────────
const args = process.argv.slice(2);
const runIdIdx = args.indexOf('--runId');
const runId = runIdIdx >= 0 ? args[runIdIdx + 1] : null;

if (!runId) {
  console.error('ERROR: --runId is required');
  process.exit(1);
}

const RUN_DIR = path.join(runtimeRoot, 'runs', runId);
const SYMBOLS_PATH = path.join(skillRoot, 'config', 'symbols.json');
const PYTHON_SCRIPT = path.join(skillRoot, 'collector', 'futures_collector.py');

// ── Main ─────────────────────────────────────────────────────
async function main() {
  console.log(`=== futures-radar collect ===`);
  console.log(`runId: ${runId}`);

  // 1. Read symbols whitelist (dynamic)
  if (!fs.existsSync(SYMBOLS_PATH)) {
    console.error(`ERROR: symbols.json not found: ${SYMBOLS_PATH}`);
    process.exit(1);
  }
  const symbolsConfig = JSON.parse(fs.readFileSync(SYMBOLS_PATH, 'utf8'));
  const activeSymbols = symbolsConfig.symbols.filter(s => s.active);
  const symbolMap = {};
  for (const s of symbolsConfig.symbols) {
    symbolMap[s.symbol] = s;
  }

  console.log(`Active symbols: ${activeSymbols.length}/${symbolsConfig.symbols.length}`);

  // 2. Run parallel collection
  const t0 = Date.now();
  const collector = new ParallelCollector(
    activeSymbols.map(s => s.symbol),
    {
      maxWorkers: 4,
      batchSize: 5,
      days: 60,
      timeout: 180000, // 3 minutes per batch
      maxRetries: 3,
      pythonScript: PYTHON_SCRIPT,
      tempDir: RUN_DIR
    }
  );

  const collectionResult = await collector.run();
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  // 3. Merge results from all successful batches
  if (collectionResult.success.length === 0) {
    console.error(`ERROR: All batches failed, no data collected`);
    process.exit(1);
  }

  const rawData = {
    meta: {
      sourceVersion: null, // Will extract from first batch
      totalSymbols: activeSymbols.length,
      succeeded: 0,
      failed: 0,
      daysPerSymbol: 60
    },
    contracts: {},
    gaps: {}
  };

  // Merge successful batches
  for (const batchResult of collectionResult.success) {
    if (!rawData.meta.sourceVersion && batchResult.data.meta) {
      rawData.meta.sourceVersion = batchResult.data.meta.sourceVersion;
    }
    Object.assign(rawData.contracts, batchResult.data.contracts || {});
    Object.assign(rawData.gaps, batchResult.data.gaps || {});
  }

  // 3.5 Future-date guard (冻结不变量 #1)
  // 末 bar 日期 > 本地今日或非法日期（非严格 YYYY-MM-DD/真实日历）视为源行为异常
  // （应永不触发）。必须在 enrich/持久化前剔除，否则污染数据会被后续增量采集
  // 复用。fail-loud: 告警日志含完整诊断（symbol/rawDate/lastBarDate/fetchedAt/reason）。
  const now = new Date();
  const localToday =
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const { ok: guardOk, rejected: guardRejected, contractsLeft } = rejectFutureDateContracts(rawData, localToday);
  if (!guardOk) {
    console.warn(`⚠️ [future-date-guard] ${guardRejected.length} contract(s) rejected (should never happen; local today = ${localToday})`);
    for (const r of guardRejected) {
      console.warn(`  ✗ ${r.symbol}: lastBarDate=${r.lastBarDate || 'N/A'} rawDate=${r.rawDate == null ? 'N/A' : r.rawDate} fetchedAt=${r.fetchedAt || 'N/A'} reason=${r.reason}`);
    }
    if (contractsLeft === 0) {
      console.error(`FATAL: all ${guardRejected.length} contract(s) rejected by future-date-guard; aborting collect`);
      process.exit(1);
    }
  }

  rawData.meta.succeeded = Object.keys(rawData.contracts).length;
  rawData.meta.failed = Object.keys(rawData.gaps).length + collectionResult.failed.length;

  // Log failures
  if (collectionResult.failed.length > 0) {
    const failedPath = path.join(RUN_DIR, 'collection-failures.json');
    fs.writeFileSync(failedPath, JSON.stringify(collectionResult.failed, null, 2));
    console.log(`\n⚠️ ${collectionResult.failed.length} batches failed, logged to collection-failures.json`);
  }

  // 4. Enrich contracts with metadata + derived fields
  const collectedAt = new Date().toISOString();
  const enriched = {};

  for (const [sym, contract] of Object.entries(rawData.contracts)) {
    const meta = symbolMap[sym] || { symbol: sym, name: sym, exchange: 'unknown', sector: 'unknown' };
    const ohlcv = contract.ohlcv;
    const close = ohlcv.close;
    const n = close.length;

    const multiplier = meta.multiplier || 1;

    // Derived: turnover = volume * settle * multiplier (per bar, in 元)
    const turnover = ohlcv.volume.map((v, i) => {
      const s = ohlcv.settle[i] || ohlcv.close[i] || 0;
      return Math.round(v * s * multiplier);
    });

    // Derived: 1d/3d/5d/20d change
    function pctChange(lag) {
      if (n <= lag) return null;
      const prev = close[n - 1 - lag];
      const cur = close[n - 1];
      if (!prev || prev === 0) return null;
      return parseFloat(((cur - prev) / prev * 100).toFixed(2));
    }

    // Derived: average of last N bars
    function avgLast(field, days) {
      const arr = field;
      const slice = arr.slice(Math.max(0, arr.length - days));
      if (slice.length === 0) return null;
      return parseFloat((slice.reduce((a, b) => a + b, 0) / slice.length).toFixed(2));
    }

    enriched[sym] = {
      symbol: sym,
      name: meta.name,
      exchange: meta.exchange,
      sector: meta.sector,
      multiplier: multiplier,
      unit: meta.unit || '',
      status: 'ok',
      fetchedAt: contract.fetchedAt,
      totalBars: contract.totalBars,
      usedBars: contract.usedBars,
      dataStart: contract.dataStart,
      dataEnd: contract.dataEnd,
      ohlcv: {
        dates: ohlcv.dates,
        open: ohlcv.open,
        high: ohlcv.high,
        low: ohlcv.low,
        close: ohlcv.close,
        volume: ohlcv.volume,
        turnover: turnover,
        openInterest: ohlcv.open_interest,
        settle: ohlcv.settle
      },
      derived: {
        change1d: pctChange(1),
        change3d: pctChange(3),
        change5d: pctChange(5),
        change20d: pctChange(20),
        avgVolume5d: avgLast(ohlcv.volume, 5),
        avgTurnover5d: avgLast(turnover, 5),
        avgOI5d: avgLast(ohlcv.open_interest, 5),
        close: close[n - 1],
        settle: ohlcv.settle[n - 1]
      }
    };
  }

  // 5. Enrich gaps with metadata
  const gaps = {};
  for (const [sym, gap] of Object.entries(rawData.gaps)) {
    const meta = symbolMap[sym] || {};
    gaps[sym] = {
      symbol: sym,
      name: meta.name || sym,
      exchange: meta.exchange || 'unknown',
      sector: meta.sector || 'unknown',
      status: 'gap',
      reason: gap.reason || 'unknown',
      fetchedAt: collectedAt
    };
  }

  // 6. Write raw.json
  const rawJson = {
    meta: {
      runId,
      collectedAt,
      source: 'akshare',
      sourceVersion: rawData.meta.sourceVersion,
      symbolsScanned: rawData.meta.totalSymbols,
      symbolsSucceeded: rawData.meta.succeeded,
      symbolsFailed: rawData.meta.failed,
      daysPerSymbol: rawData.meta.daysPerSymbol,
      elapsedSeconds: parseFloat(elapsed),
      fullPull: true
    },
    contracts: enriched,
    gaps,
    macroAnchors: {
      _note: 'Macro anchors deferred to Phase 3 macro pass or Top 3 analysis stage',
      collected: false
    }
  };

  const rawJsonPath = path.join(RUN_DIR, 'raw.json');
  fs.writeFileSync(rawJsonPath, JSON.stringify(rawJson, null, 2));
  console.log(`raw.json → ${rawJsonPath}`);

  // 7. Write provenance.json
  const provenance = {
    runId,
    collectedAt,
    pipelineVersion: '0.1.1',
    sources: {
      akshare: {
        version: rawData.meta.sourceVersion,
        status: 'available',
        contractsCollected: rawData.meta.succeeded,
        contractsFailed: rawData.meta.failed,
        elapsedSeconds: parseFloat(elapsed)
      }
    },
    perSymbol: {}
  };

  for (const [sym, c] of Object.entries(enriched)) {
    provenance.perSymbol[sym] = {
      source: 'akshare',
      fetchedAt: c.fetchedAt,
      dataStart: c.dataStart,
      dataEnd: c.dataEnd,
      bars: c.usedBars,
      status: 'ok'
    };
  }
  for (const [sym, g] of Object.entries(gaps)) {
    provenance.perSymbol[sym] = {
      source: 'akshare',
      fetchedAt: g.fetchedAt,
      status: 'gap',
      reason: g.reason
    };
  }

  const provenancePath = path.join(RUN_DIR, 'provenance.json');
  fs.writeFileSync(provenancePath, JSON.stringify(provenance, null, 2));
  console.log(`provenance.json → ${provenancePath}`);

  // 8. Write raw-snapshot.md (human-readable)
  function fmtTurnover(val) {
    if (val >= 1e12) return (val / 1e12).toFixed(2) + 'T';
    if (val >= 1e8) return (val / 1e8).toFixed(2) + '亿';
    if (val >= 1e4) return (val / 1e4).toFixed(2) + '万';
    return Math.round(val).toLocaleString();
  }

  const sectorGroups = {};
  for (const c of Object.values(enriched)) {
    const s = c.sector || 'unknown';
    if (!sectorGroups[s]) sectorGroups[s] = [];
    sectorGroups[s].push(c);
  }

  const sectorLabels = {
    black: '黑色系', nonferrous: '有色金属', precious: '贵金属',
    energy_chemical: '能化', agriculture: '农产品',
    financial: '金融期货', shipping: '航运', new_materials: '新材料'
  };

  let md = `# Futures Radar — Raw Snapshot\n\n`;
  md += `**Run ID**: ${runId}\n`;
  md += `**Collected**: ${collectedAt}\n`;
  md += `**Source**: akshare ${rawData.meta.sourceVersion}\n`;
  md += `**Summary**: ${rawData.meta.succeeded} OK / ${rawData.meta.failed} gaps / ${rawData.meta.totalSymbols} scanned\n`;
  md += `**Elapsed**: ${elapsed}s\n\n`;

  md += `## 板块概览\n\n`;
  md += `| 板块 | OK | Gap |\n`;
  md += `|------|----|-----|\n`;
  for (const [sector, label] of Object.entries(sectorLabels)) {
    const sectorEnriched = Object.values(enriched).filter(c => c.sector === sector);
    const sectorGaps = Object.values(gaps).filter(g => g.sector === sector);
    if (sectorEnriched.length + sectorGaps.length > 0) {
      md += `| ${label} | ${sectorEnriched.length} | ${sectorGaps.length} |\n`;
    }
  }

  md += `\n## 品种行情\n\n`;
  for (const [sector, label] of Object.entries(sectorLabels)) {
    const sectorEnriched = Object.values(enriched).filter(c => c.sector === sector);
    const sectorGaps = Object.values(gaps).filter(g => g.sector === sector);
    if (sectorEnriched.length + sectorGaps.length === 0) continue;

    md += `### ${label}\n\n`;
    md += `| 品种 | 代码 | 收盘价 | 涨跌(1d) | 涨跌(5d) | 涨跌(20d) | 成交量(5d均) | 成交额(5d均) | 持仓量(5d均) |\n`;
    md += `|------|------|--------|----------|----------|-----------|-------------|-------------|-------------|\n`;

    for (const c of sectorEnriched.sort((a, b) => a.symbol.localeCompare(b.symbol))) {
      const ch1 = c.derived.change1d != null ? `${c.derived.change1d > 0 ? '+' : ''}${c.derived.change1d}%` : '-';
      const ch5 = c.derived.change5d != null ? `${c.derived.change5d > 0 ? '+' : ''}${c.derived.change5d}%` : '-';
      const ch20 = c.derived.change20d != null ? `${c.derived.change20d > 0 ? '+' : ''}${c.derived.change20d}%` : '-';
      const vol = c.derived.avgVolume5d != null ? Math.round(c.derived.avgVolume5d).toLocaleString() : '-';
      const to = c.derived.avgTurnover5d != null ? fmtTurnover(c.derived.avgTurnover5d) : '-';
      const oi = c.derived.avgOI5d != null ? Math.round(c.derived.avgOI5d).toLocaleString() : '-';
      md += `| ${c.name} | ${c.symbol} | ${c.derived.close} | ${ch1} | ${ch5} | ${ch20} | ${vol} | ${to} | ${oi} |\n`;
    }

    for (const g of Object.values(gaps).filter(g => g.sector === sector)) {
      md += `| ${g.name} | ${g.symbol} | ⚠️ GAP | ${g.reason} | - | - | - | - |\n`;
    }

    md += `\n`;
  }

  if (Object.keys(gaps).length > 0) {
    md += `## 采集缺口\n\n`;
    for (const [sym, g] of Object.entries(gaps)) {
      md += `- **${g.name}** (${sym}): ${g.reason}\n`;
    }
    md += `\n`;
  }

  md += `## 宏观锚点\n\n`;
  md += `_宏观锚点采集暂未实现（Phase 3+）。将在 Top 3 分析阶段通过 mx-data/WebSearch 获取。_\n`;

  const snapshotPath = path.join(RUN_DIR, 'raw-snapshot.md');
  fs.writeFileSync(snapshotPath, md);
  console.log(`raw-snapshot.md → ${snapshotPath}`);

  // 9. Summary
  console.log(`\n=== COLLECT COMPLETE ===`);
  console.log(`${rawData.meta.succeeded} OK, ${rawData.meta.failed} gaps, ${elapsed}s`);
  if (rawData.meta.failed > 0) {
    console.log(`Gaps: ${Object.keys(gaps).join(', ')}`);
  }

  process.exit(0);
}

main().catch(err => {
  console.error(`FATAL: ${err.message}`);
  process.exit(1);
});
