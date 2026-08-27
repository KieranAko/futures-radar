#!/usr/bin/env node
/**
 * collector/sector-aggregator.cjs — 板块聚合指标（v0.1.5）
 *
 * 定位：从本 run raw.json 在采集层确定性构建板块指数/广度/领涨领跌指标。
 * 不新增外部数据源、不使用持仓数据（报告不支持持仓分析）。
 *
 * 方法（参考商品板块指数编制惯例，如南华商品指数/Wind 商品指数）：
 *   - 板块日收益 = 板块内有效成员当日收益率的等权平均
 *   - 板块指数 = 1000 基点，按日收益链式累乘
 *   - 广度 = 上涨成员占比（1d/5d）
 *   - coherence = 成员方向与板块方向一致的比例
 *   - volume_ratio = 成员成交量相对自身20日均量的比值均值
 *   - leader = |5日收益率|最大的成员（领涨/领跌代表）
 *
 * Usage:
 *   node collector/sector-aggregator.cjs --runId <id>
 */

const fs = require('fs');
const path = require('path');
const { runtimeRoot, skillRoot } = require('../lib/workspace.cjs');
const dataStore = require('../data-store/index.cjs');

const DIRECTION_THRESHOLD_PCT = 0.3;
const SECTOR_SCHEMA = 'futures-radar-sector-snapshot/1';

function readJSON(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function mean(arr) {
  if (!arr || arr.length === 0) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function retPct(cur, prev) {
  if (!Number.isFinite(cur) || !Number.isFinite(prev) || prev <= 0) return null;
  return ((cur / prev - 1) * 100);
}

function retN(close, n) {
  if (!Array.isArray(close) || close.length <= n) return null;
  return retPct(close[close.length - 1], close[close.length - 1 - n]);
}

function memberIndicators(contract) {
  const o = contract && contract.ohlcv;
  if (!o || !Array.isArray(o.close) || !Array.isArray(o.volume)) return null;
  const close = o.close;
  const volume = o.volume;
  const vol20 = volume.slice(-20);
  const avgVol20 = mean(vol20);
  return {
    symbol: contract.symbol,
    name: contract.name || contract.symbol,
    ret1d: retN(close, 1),
    ret5d: retN(close, 5),
    ret20d: retN(close, 20),
    volumeRatio20d: avgVol20 && avgVol20 > 0 ? volume[volume.length - 1] / avgVol20 : null
  };
}

function buildSectorIndex(members) {
  const closeBySymbol = new Map();
  const allDates = new Set();
  for (const m of members) {
    const dates = m.contract.ohlcv.dates;
    const close = m.contract.ohlcv.close;
    const map = new Map();
    for (let i = 0; i < dates.length; i++) {
      map.set(dates[i], close[i]);
      allDates.add(dates[i]);
    }
    closeBySymbol.set(m.symbol, map);
  }

  const sortedDates = [...allDates].sort();
  const rows = [];
  let lastLevel = 1000;
  for (const date of sortedDates) {
    const rets = [];
    for (const m of members) {
      const map = closeBySymbol.get(m.symbol);
      const cur = map.get(date);
      if (!Number.isFinite(cur)) continue;
      // 上一个可用日期：按排序日期在前一根；直接在每个成员内部取前一日期的 map 不可行，
      // 因此用 sortedDates 中的前一个日期作为 prev date（板块日频，成员缺 bar 则跳过）。
      const prevDate = sortedDates[sortedDates.indexOf(date) - 1];
      const prev = prevDate !== undefined ? map.get(prevDate) : null;
      if (!Number.isFinite(prev) || prev <= 0) continue;
      const r = (cur / prev - 1) * 100;
      if (Number.isFinite(r)) rets.push(r);
    }
    if (rets.length === 0) continue;
    const avgRet = mean(rets);
    const level = lastLevel * (1 + avgRet / 100);
    rows.push({ date, level, ret1d: avgRet });
    lastLevel = level;
  }

  for (let i = 0; i < rows.length; i++) {
    rows[i].ret5d = i >= 5 ? retPct(rows[i].level, rows[i - 5].level) : null;
    rows[i].ret20d = i >= 20 ? retPct(rows[i].level, rows[i - 20].level) : null;
  }
  return rows;
}

/**
 * 从 raw.json 构建全市场板块快照。
 * @returns {{ schema, meta, sectors }}
 */
function buildSectorSnapshot(rawJson, symbolsConfig, { runId, signalDate } = {}) {
  const contracts = rawJson.contracts || {};
  const symbols = Array.isArray(symbolsConfig.symbols) ? symbolsConfig.symbols : [];
  const activeBySector = new Map();
  for (const s of symbols) {
    if (!s.active) continue;
    if (!contracts[s.symbol]) continue;
    if (!activeBySector.has(s.sector)) activeBySector.set(s.sector, []);
    activeBySector.get(s.sector).push(s);
  }

  let resolvedSignalDate = signalDate || null;
  if (!resolvedSignalDate) {
    let maxDate = null;
    for (const c of Object.values(contracts)) {
      const dates = c && c.ohlcv && Array.isArray(c.ohlcv.dates) ? c.ohlcv.dates : [];
      const last = dates.length > 0 ? dates[dates.length - 1] : null;
      if (last && (maxDate === null || last > maxDate)) maxDate = last;
    }
    resolvedSignalDate = maxDate;
  }

  const sectors = {};
  for (const [sectorId, sectorDefs] of Object.entries(symbolsConfig.sectors || {})) {
    const memberDefs = activeBySector.get(sectorId) || [];
    const members = memberDefs
      .map((def) => ({ ...def, contract: contracts[def.symbol] }))
      .filter((m) => m.contract && m.contract.ohlcv && Array.isArray(m.contract.ohlcv.dates) && m.contract.ohlcv.dates.length >= 2);

    if (members.length === 0) continue;

    const indexRows = buildSectorIndex(members);
    const stats = members.map((m) => memberIndicators(m.contract)).filter(Boolean);
    const lastRow = indexRows[indexRows.length - 1];

    const ret1d = lastRow ? parseFloat(lastRow.ret1d.toFixed(2)) : null;
    const ret5d = lastRow && lastRow.ret5d != null ? parseFloat(lastRow.ret5d.toFixed(2)) : null;
    const ret20d = lastRow && lastRow.ret20d != null ? parseFloat(lastRow.ret20d.toFixed(2)) : null;

    const advanceRatio = (field) => {
      const values = stats.map((s) => s[field]).filter((v) => v != null && Number.isFinite(v));
      if (values.length === 0) return null;
      const up = values.filter((v) => v > 0).length;
      return parseFloat(((up / values.length) * 100).toFixed(1));
    };

    const ret1Values = stats.map((s) => s.ret1d).filter((v) => v != null && Number.isFinite(v));
    const coherence = ret1d != null && Math.abs(ret1d) >= DIRECTION_THRESHOLD_PCT && ret1Values.length > 0
      ? parseFloat(((ret1Values.filter((v) => (ret1d > 0 ? v > 0 : v < 0)).length / ret1Values.length) * 100).toFixed(1))
      : null;

    const volumeRatios = stats.map((s) => s.volumeRatio20d).filter((v) => v != null && Number.isFinite(v));
    const volumeRatio = volumeRatios.length > 0 ? parseFloat(mean(volumeRatios).toFixed(2)) : null;

    let leader = stats[0] || null;
    for (const s of stats) {
      const a = Math.abs(s.ret5d != null ? s.ret5d : (s.ret1d != null ? s.ret1d : 0));
      const b = Math.abs(leader.ret5d != null ? leader.ret5d : (leader.ret1d != null ? leader.ret1d : 0));
      if (a > b) leader = s;
    }

    const direction = ret1d == null ? 'flat' : ret1d >= DIRECTION_THRESHOLD_PCT ? 'up' : ret1d <= -DIRECTION_THRESHOLD_PCT ? 'down' : 'flat';

    sectors[sectorId] = {
      sector: sectorId,
      label: sectorDefs.label || sectorId,
      direction,
      indexLevel: lastRow ? parseFloat(lastRow.level.toFixed(2)) : null,
      ret1d,
      ret5d,
      ret20d,
      advanceRatio1d: advanceRatio('ret1d'),
      advanceRatio5d: advanceRatio('ret5d'),
      coherence1d: coherence,
      volumeRatio20d: volumeRatio,
      leaderSymbol: leader ? leader.symbol : null,
      leaderName: leader ? leader.name : null,
      leaderRet5d: leader && leader.ret5d != null ? parseFloat(leader.ret5d.toFixed(2)) : null,
      members: members.length,
      dataStart: lastRow ? indexRows[0].date : null,
      dataEnd: lastRow ? lastRow.date : null
    };
  }

  return {
    schema: SECTOR_SCHEMA,
    meta: {
      runId,
      signalDate: resolvedSignalDate,
      generatedAt: new Date().toISOString(),
      method: 'equal_weight_return_chained_v1',
      directionThresholdPct: DIRECTION_THRESHOLD_PCT,
      source: 'derived:raw.json',
      note: '板块日收益=成员等权平均；指数基点为1000；不使用持仓数据'
    },
    sectors
  };
}

/**
 * 从 raw.json 读 symbol→sector 映射，用于 evidence 字段组装。
 */
function buildSectorField(snapshot, rawJson, symbol, signalDate) {
  const contract = rawJson.contracts && rawJson.contracts[symbol];
  if (!contract || !snapshot || !snapshot.sectors) return null;
  const sectorId = contract.sector || null;
  const sec = sectorId ? snapshot.sectors[sectorId] : null;
  const fetchedAt = (snapshot.meta && snapshot.meta.generatedAt) || new Date().toISOString();
  if (!sec) {
    return {
      source: 'derived:raw.json',
      asOf: `${signalDate}T15:00:00+08:00`,
      fetchedAt,
      freshness: 'same_day',
      gap: 'missing'
    };
  }
  return {
    source: 'derived:raw.json',
    asOf: `${signalDate}T15:00:00+08:00`,
    fetchedAt,
    freshness: 'same_day',
    gap: null,
    sector: sectorId,
    sector_label: sec.label,
    sector_ret1d: sec.ret1d,
    sector_ret5d: sec.ret5d,
    sector_ret20d: sec.ret20d,
    advance_ratio_1d: sec.advanceRatio1d,
    advance_ratio_5d: sec.advanceRatio5d,
    coherence_1d: sec.coherence1d,
    volume_ratio_20d: sec.volumeRatio20d,
    leader_symbol: sec.leaderSymbol,
    leader_name: sec.leaderName,
    leader_ret5d: sec.leaderRet5d,
    members: sec.members
  };
}

function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--runId');
  const runId = i >= 0 ? args[i + 1] : null;
  if (!runId) {
    console.error('FATAL: --runId required');
    process.exit(1);
  }

  const runDir = path.join(runtimeRoot, 'runs', runId);
  const rawPath = path.join(runDir, 'raw.json');
  if (!fs.existsSync(rawPath)) {
    console.error(`FATAL: raw.json not found: ${rawPath}`);
    process.exit(1);
  }

  const rawJson = readJSON(rawPath);
  const symbolsConfig = readJSON(path.join(skillRoot, 'config', 'symbols.json'));
  const snapshot = buildSectorSnapshot(rawJson, symbolsConfig, { runId });

  const outPath = path.join(runDir, 'sector-snapshot.json');
  fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2));
  console.log(`sector-snapshot.json → ${outPath}`);
  console.log(`sectors: ${Object.keys(snapshot.sectors).length}`);
  for (const [id, s] of Object.entries(snapshot.sectors)) {
    console.log(`  [${id}] ${s.label}: ${s.direction} ret1d=${s.ret1d}% ret5d=${s.ret5d}% breadth=${s.advanceRatio1d}% leader=${s.leaderSymbol}`);
  }

  try {
    dataStore.ingestSectorSnapshot({ runId, snapshot });
    console.log(`data-store: sector snapshot mirrored`);
  } catch (err) {
    console.warn(`WARN: data-store sector ingest failed (non-blocking): ${err.message}`);
  }
}

if (require.main === module) {
  main();
}

module.exports = { buildSectorSnapshot, buildSectorField, memberIndicators, buildSectorIndex };
