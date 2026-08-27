import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { buildSectorSnapshot, buildSectorField } = require('../collector/sector-aggregator.cjs');

const RAW_FIXTURE = path.resolve(__dirname, '..', 'reasoning', 'test', 'fixtures', 'raw-rb0-20260805.json');
const SYMBOLS = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'config', 'symbols.json'), 'utf8'));

describe('sector-aggregator 板块指标', () => {
  it('从真实 raw 夹具构建板块快照，且不使用持仓数据', () => {
    const raw = JSON.parse(fs.readFileSync(RAW_FIXTURE, 'utf8'));
    const snapshot = buildSectorSnapshot(raw, SYMBOLS, { runId: 'sector-test', signalDate: '2026-08-05' });

    assert.equal(snapshot.schema, 'futures-radar-sector-snapshot/1');
    assert.ok(snapshot.sectors.black, 'RB0 所在黑色系应存在');
    const sec = snapshot.sectors.black;
    assert.equal(sec.sector, 'black');
    assert.equal(sec.leaderSymbol, 'RB0');
    assert.equal(sec.members, 1);
    assert.ok(Number.isFinite(sec.ret1d));
    assert.ok(Number.isFinite(sec.ret5d));
    assert.ok(Number.isFinite(sec.advanceRatio1d));
    assert.ok(sec.coherence1d == null || Number.isFinite(sec.coherence1d));
    assert.ok(!('open_interest' in sec) && !('oi' in sec));
  });

  it('buildSectorField 生成 packet 可用的 sector_movement 证据', () => {
    const raw = JSON.parse(fs.readFileSync(RAW_FIXTURE, 'utf8'));
    const snapshot = buildSectorSnapshot(raw, SYMBOLS, { runId: 'sector-test', signalDate: '2026-08-05' });
    const field = buildSectorField(snapshot, raw, 'RB0', '2026-08-05');

    assert.equal(field.gap, null);
    assert.equal(field.sector, 'black');
    assert.equal(field.sector_label, '黑色系');
    assert.equal(typeof field.sector_ret1d, 'number');
    assert.equal(typeof field.sector_ret5d, 'number');
    assert.equal(field.leader_symbol, 'RB0');
    assert.equal(field.freshness, 'same_day');
  });

  it('无板块快照时返回 gap=missing 而不是抛错', () => {
    const raw = JSON.parse(fs.readFileSync(RAW_FIXTURE, 'utf8'));
    const field = buildSectorField({ sectors: {} }, raw, 'RB0', '2026-08-05');
    assert.equal(field.gap, 'missing');
  });
});
