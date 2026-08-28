#!/usr/bin/env node
/**
 * ga3-sector-rebuild.cjs — GA-3 板块广度/leaders/laggards 历史重建
 *
 * 用 GA-1 回填后的 data/daily 全历史 bars，按 collector/sector-aggregator.cjs 口径
 * （等权收益链式指数 1000 基点、advanceRatio、coherence、volumeRatio20d、方向一致 leader）
 * 逐日重建板块序列并入库 data/sector/<sector>.json（schema futures-radar-sector-series/1）。
 *
 * 额外输出（候补策略 TR-08/FS-06/TR-04 需要的历史 leaders/laggards 明细）：
 *   strategies/research/v2/falsification/data/ga3-sector-series-ext.json
 *
 * PIT：每个日期的板块指标只用 ≤该日期 的成员 bars 计算（F8）。
 * 换月跳变：板块指数链式收益含换月日（与 aggregator 口径一致，未剔除）；
 *   消费者如需剔除按 ga1-roll-jumps.json 处理。
 *
 * Usage:
 *   node strategies/research/v2/falsification/ga3-sector-rebuild.cjs
 */

const fs = require('fs');
const path = require('path');

const SKILL_ROOT = path.join(__dirname, '../../../..');
const DAILY_DIR = path.join(SKILL_ROOT, 'data', 'daily');
const SECTOR_DIR = path.join(SKILL_ROOT, 'data', 'sector');
const FALS_DATA_DIR = path.join(__dirname, 'data');
const EXT_PATH = path.join(FALS_DATA_DIR, 'ga3-sector-series-ext.json');

const dataStore = require(path.join(SKILL_ROOT, 'data-store', 'index.cjs'));

const DIRECTION_THRESHOLD_PCT = 0.3;
const SERIES_SCHEMA = 'futures-radar-sector-series/1';
const SNAPSHOT_SCHEMA = 'futures-radar-sector-snapshot/1';
const RUN_ID = 'ga-3-sector-rebuild';

const r2 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);

function main() {
  const t0 = Date.now();
  fs.mkdirSync(FALS_DATA_DIR, { recursive: true });

  const symbolsConfig = JSON.parse(fs.readFileSync(path.join(SKILL_ROOT, 'config', 'symbols.json'), 'utf8'));
  const active = (symbolsConfig.symbols || []).filter((s) => s.active);
  const sectorDefs = symbolsConfig.sectors || {};
  const bySector = new Map();
  for (const s of active) {
    if (!bySector.has(s.sector)) bySector.set(s.sector, []);
    bySector.get(s.sector).push(s);
  }

  // 载入成员日线
  const memberSeries = new Map(); // symbol -> { dates, close, volume, name }
  for (const s of active) {
    const p = path.join(DAILY_DIR, `${s.symbol}.json`);
    if (!fs.existsSync(p)) continue;
    const w = JSON.parse(fs.readFileSync(p, 'utf8'));
    const o = w.contract && w.contract.ohlcv;
    if (!o || !Array.isArray(o.dates) || o.dates.length < 2) continue;
    memberSeries.set(s.symbol, { dates: o.dates, close: o.close, volume: o.volume, name: s.name });
  }

  const snapshotSectors = {};
  const ext = { schema: 'falsification-ga3-sector-ext/1', runId: RUN_ID, computedAt: new Date().toISOString(), note: 'leaders=ret5d 前 3，laggards=ret5d 后 3（与 aggregator byRet5d 口径一致）', sectors: {} };
  const summary = {};

  for (const [sectorId, memberDefs] of bySector) {
    const members = memberDefs
      .map((def) => ({ def, series: memberSeries.get(def.symbol) }))
      .filter((m) => m.series);
    if (members.length === 0) {
      console.warn(`⚠️ sector ${sectorId}: no member data, skipped`);
      continue;
    }

    // 指数链式重建（与 buildSectorIndex 同口径：并集日期、等权、前一日 = 并集前一日期）
    const closeBySymbol = new Map();
    const allDates = new Set();
    for (const m of members) {
      const map = new Map();
      for (let i = 0; i < m.series.dates.length; i++) {
        map.set(m.series.dates[i], m.series.close[i]);
        allDates.add(m.series.dates[i]);
      }
      closeBySymbol.set(m.def.symbol, map);
    }
    const sortedDates = [...allDates].sort();
    const indexRows = []; // {date, level}
    let lastLevel = 1000;
    for (let di = 0; di < sortedDates.length; di++) {
      const date = sortedDates[di];
      const prevDate = di > 0 ? sortedDates[di - 1] : null;
      const rets = [];
      for (const m of members) {
        const map = closeBySymbol.get(m.def.symbol);
        const cur = map.get(date);
        const prev = prevDate != null ? map.get(prevDate) : null;
        if (!Number.isFinite(cur) || !Number.isFinite(prev) || prev <= 0) continue;
        rets.push((cur / prev - 1) * 100);
      }
      if (rets.length === 0) continue;
      const avgRet = mean(rets);
      lastLevel = lastLevel * (1 + avgRet / 100);
      indexRows.push({ date, level: lastLevel, ret1d: avgRet });
    }
    for (let i = 0; i < indexRows.length; i++) {
      indexRows[i].ret5d = i >= 5 ? ((indexRows[i].level / indexRows[i - 5].level) - 1) * 100 : null;
      indexRows[i].ret20d = i >= 20 ? ((indexRows[i].level / indexRows[i - 20].level) - 1) * 100 : null;
    }

    // 逐日成员统计（成员自身序列截断至该日期；memberIndicators 口径）
    // 预建每个成员「截至并集日期」的索引
    const memberUpTo = new Map(); // symbol -> Map(date -> {idx, ret1d, ret5d, volRatio})
    for (const m of members) {
      const d = m.series.dates, c = m.series.close, v = m.series.volume;
      const mMap = new Map();
      let sumV = 0;
      const vbuf = new Array(20).fill(0);
      let vpos = 0, vcnt = 0;
      for (let i = 0; i < d.length; i++) {
        if (vcnt === 20) { sumV -= vbuf[vpos]; } else { vcnt++; }
        vbuf[vpos] = v[i]; sumV += v[i]; vpos = (vpos + 1) % 20;
        const ret1d = i >= 1 && c[i - 1] > 0 ? (c[i] / c[i - 1] - 1) * 100 : null;
        const ret5d = i >= 5 && c[i - 5] > 0 ? (c[i] / c[i - 5] - 1) * 100 : null;
        const volRatio = vcnt === 20 && sumV > 0 ? v[i] / (sumV / 20) : null;
        mMap.set(d[i], { idx: i, ret1d, ret5d, volRatio });
      }
      memberUpTo.set(m.def.symbol, mMap);
    }

    const rows = [];
    const extRows = [];
    for (const row of indexRows) {
      const date = row.date;
      const stats = [];
      for (const m of members) {
        const st = memberUpTo.get(m.def.symbol).get(date);
        if (!st) continue;
        stats.push({ symbol: m.def.symbol, name: m.series.name, ret1d: st.ret1d, ret5d: st.ret5d, volumeRatio20d: st.volRatio });
      }
      if (stats.length === 0) continue;

      const ret1d = row.ret1d;
      const advanceRatio = (field) => {
        const values = stats.map((s) => s[field]).filter((v) => v != null && Number.isFinite(v));
        if (values.length === 0) return null;
        return parseFloat(((values.filter((v) => v > 0).length / values.length) * 100).toFixed(1));
      };
      const ret1Values = stats.map((s) => s.ret1d).filter((v) => v != null && Number.isFinite(v));
      const coherence = Math.abs(ret1d) >= DIRECTION_THRESHOLD_PCT && ret1Values.length > 0
        ? parseFloat(((ret1Values.filter((v) => (ret1d > 0 ? v > 0 : v < 0)).length / ret1Values.length) * 100).toFixed(1))
        : null;
      const volRatios = stats.map((s) => s.volumeRatio20d).filter((v) => v != null && Number.isFinite(v));
      const volumeRatio20d = volRatios.length > 0 ? parseFloat(mean(volRatios).toFixed(2)) : null;
      const direction = ret1d >= DIRECTION_THRESHOLD_PCT ? 'up' : ret1d <= -DIRECTION_THRESHOLD_PCT ? 'down' : 'flat';

      const signedValue = (s) => s.ret5d != null ? s.ret5d : (s.ret1d != null ? s.ret1d : 0);
      let leader = stats[0];
      for (const s of stats) {
        if (direction === 'up') { if (signedValue(s) > signedValue(leader)) leader = s; }
        else if (direction === 'down') { if (signedValue(s) < signedValue(leader)) leader = s; }
        else { if (Math.abs(signedValue(s)) > Math.abs(signedValue(leader))) leader = s; }
      }
      const byRet5d = [...stats].sort((a, b) => {
        const av = a.ret5d != null ? a.ret5d : -Infinity;
        const bv = b.ret5d != null ? b.ret5d : -Infinity;
        return bv - av;
      });
      const memberRow = (s) => ({ symbol: s.symbol, name: s.name, ret1d: r2(s.ret1d), ret5d: r2(s.ret5d) });
      const leaders = byRet5d.slice(0, 3).map(memberRow);
      const laggards = byRet5d.slice(-3).reverse().map(memberRow);

      rows.push({
        date,
        runId: RUN_ID,
        direction,
        indexLevel: r2(row.level),
        ret1d: r2(row.ret1d),
        ret5d: r2(row.ret5d),
        ret20d: r2(row.ret20d),
        advanceRatio1d: advanceRatio('ret1d'),
        advanceRatio5d: advanceRatio('ret5d'),
        coherence1d: coherence,
        volumeRatio20d,
        leaderSymbol: leader ? leader.symbol : null,
        leaderName: leader ? leader.name : null,
        leaderRet5d: leader && leader.ret5d != null ? r2(leader.ret5d) : null,
        members: stats.length
      });
      extRows.push({ date, leaders, laggards, members: stats.length });
    }

    if (rows.length === 0) {
      console.warn(`⚠️ sector ${sectorId}: no rows built, skipped`);
      continue;
    }

    const label = (sectorDefs[sectorId] && sectorDefs[sectorId].label) || sectorId;

    // 写入 data/sector/<sector>.json（标准 schema，全历史替换）
    const seriesPath = path.join(SECTOR_DIR, `${sectorId}.json`);
    fs.writeFileSync(seriesPath, JSON.stringify({
      schema: SERIES_SCHEMA,
      sector: sectorId,
      label,
      updatedAt: new Date().toISOString(),
      rows
    }, null, 2));

    // 最新一日快照（sector-snapshot schema，供 report/analyze 回退读取一致性）
    const last = rows[rows.length - 1];
    snapshotSectors[sectorId] = {
      sector: sectorId,
      label,
      direction: last.direction,
      indexLevel: last.indexLevel,
      ret1d: last.ret1d,
      ret5d: last.ret5d,
      ret20d: last.ret20d,
      advanceRatio1d: last.advanceRatio1d,
      advanceRatio5d: last.advanceRatio5d,
      coherence1d: last.coherence1d,
      volumeRatio20d: last.volumeRatio20d,
      leaderSymbol: last.leaderSymbol,
      leaderName: last.leaderName,
      leaderRet5d: last.leaderRet5d,
      leaders: extRows[extRows.length - 1].leaders,
      laggards: extRows[extRows.length - 1].laggards,
      members: last.members,
      dataStart: rows[0].date,
      dataEnd: last.date
    };

    ext.sectors[sectorId] = { label, rows: extRows };
    summary[sectorId] = { label, rows: rows.length, first: rows[0].date, last: last.date, members: last.members };
    console.log(`[${sectorId}] ${label}: rows=${rows.length} (${rows[0].date} .. ${last.date}) lastIndex=${last.indexLevel} ret1d=${last.ret1d}% breadth1d=${last.advanceRatio1d}% leader=${last.leaderSymbol}`);
  }

  // 快照文件（data/sector/snapshots/<runId>.json）——经 ingestSectorSnapshot 保持与管道一致
  const snapshot = {
    schema: SNAPSHOT_SCHEMA,
    meta: {
      runId: RUN_ID,
      signalDate: Object.values(snapshotSectors).map((s) => s.dataEnd).sort().pop() || null,
      generatedAt: new Date().toISOString(),
      method: 'equal_weight_return_chained_v1',
      directionThresholdPct: DIRECTION_THRESHOLD_PCT,
      source: 'derived:data/daily (GA-1 full history)',
      note: 'GA-3 历史重建：板块日收益=成员等权平均；指数基点为1000；不使用持仓数据'
    },
    sectors: snapshotSectors
  };
  try {
    const r = dataStore.ingestSectorSnapshot({ runId: RUN_ID, snapshot });
    console.log(`\ningestSectorSnapshot: ${JSON.stringify(r)}`);
  } catch (err) {
    console.warn(`⚠️ ingestSectorSnapshot failed: ${err.message}`);
  }

  fs.writeFileSync(EXT_PATH, JSON.stringify(ext, null, 2));

  console.log(`\n=== GA-3 Sector Rebuild Summary (elapsed=${((Date.now() - t0) / 1000).toFixed(1)}s) ===`);
  console.log(JSON.stringify(summary, null, 1));
  console.log(`outputs: data/sector/<sector>.json (7 sectors full history), data/sector/snapshots/${RUN_ID}.json, ${EXT_PATH}`);
}

main();
