import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { buildSectorSnapshot } = require('../collector/sector-aggregator.cjs');
const lib = require('../analyze/sector-driver-lib.cjs');

const RAW_FIXTURE = path.resolve(__dirname, '..', 'reasoning', 'test', 'fixtures', 'raw-rb0-20260805.json');
const SYMBOLS = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'config', 'symbols.json'), 'utf8'));

function makeBundle() {
  const raw = JSON.parse(fs.readFileSync(RAW_FIXTURE, 'utf8'));
  const snapshot = buildSectorSnapshot(raw, SYMBOLS, { runId: 'sector-driver-test', signalDate: '2026-08-05' });
  const macroSnapshot = {
    meta: { runId: 'sector-driver-test', signalDate: '2026-08-05', snapshotFrozenAt: '2026-08-05T09:00:00Z', marketCutoffAt: '2026-08-05', schemaVersion: '1.0.0' },
    indicators: {
      DXY: { status: 'fresh', value: 99, change5d: 0.1, asOf: '2026-08-05', source: 'sina' },
      USDCNH: { status: 'fresh', value: 6.7, change5d: -0.1, asOf: '2026-08-05', source: 'sina' }
    }
  };
  return lib.buildSectorDriverPackets({ sectorSnapshot: snapshot, macroSnapshot, symbolsConfig: SYMBOLS, runId: 'sector-driver-test' });
}

describe('sector-driver-lib 板块驱动证据链', () => {
  it('buildSectorDriverPackets 只含板块观察值，不混入个股 Q1', () => {
    const bundle = makeBundle();
    const p = bundle.packets.black;
    assert.equal(p.sector, 'black');
    assert.equal(typeof p.observed.ret1d, 'number');
    assert.ok(Array.isArray(p.observed.leaders));
    assert.equal(JSON.stringify(bundle).includes('q1_driver'), false);
  });

  it('renderSectorDriverPrompt 替换全部占位符', () => {
    const bundle = makeBundle();
    const prompt = lib.renderSectorDriverPrompt(bundle.packets.black);
    assert.ok(!prompt.includes('{{sector}}'));
    assert.ok(!prompt.includes('{{signalDate}}'));
    assert.ok(!prompt.includes('{{evidence}}'));
    assert.ok(prompt.includes('黑色系'));
    assert.ok(prompt.includes('leaders'));
  });

  it('sector driver context 必须标注 context_only，不作为 packet 证据', () => {
    const driver = {
      meta: { mode: 'sector-driver' },
      sectors: {
        black: {
          status: 'analyzed',
          direction_observed: 'up',
          member_structure: 'broad_based',
          relation_to_individual: 'context_only',
          driver: {
            primary: '政策预期推动黑色系整体偏强',
            category: 'policy',
            confidence: 'medium',
            evidence: [{ source: 'websearch', url: 'https://example.com', title: 't', published_at: '2026-08-05', claim: 'x' }],
            invalidation: ['政策预期落空']
          }
        }
      }
    };
    const ctx = lib.renderSectorDriverContextBlock(driver, 'black');
    assert.ok(ctx.includes('context_only') || ctx.includes('不是 packet 证据'));
    assert.ok(ctx.includes('不得机械决定'));
  });

  it('validateSectorDriverOutput：analyzed 必须有板块级 evidence 和 invalidation', () => {
    const bundle = makeBundle();
    const direction = bundle.packets.black.observed.direction;
    const base = {
      sector: 'black',
      signalDate: '2026-08-05',
      direction_observed: direction,
      member_structure: 'broad_based',
      relation_to_individual: 'context_only',
      reason: null,
      driver: {
        primary: '板块级驱动',
        category: 'macro',
        confidence: 'medium',
        evidence: [{ source: 'websearch', url: 'u', title: 't', published_at: '2026-08-05', claim: 'c' }],
        invalidation: ['失效']
      }
    };
    const ok = lib.validateSectorDriverOutput({
      meta: { mode: 'sector-driver' },
      sectors: { black: { ...base, status: 'analyzed' } }
    }, bundle.packets);
    assert.equal(ok.ok, true);

    const bad = lib.validateSectorDriverOutput({
      meta: { mode: 'sector-driver' },
      sectors: { black: { ...base, status: 'analyzed', driver: { ...base.driver, evidence: [] } } }
    }, bundle.packets);
    assert.equal(bad.ok, false);
    assert.ok(bad.errors.some((e) => e.includes('evidence')));
  });

  it('validateSectorDriverOutput：unknown/abstain 必须给 reason 且 driver=null', () => {
    const bundle = makeBundle();
    const out = lib.validateSectorDriverOutput({
      meta: { mode: 'sector-driver' },
      sectors: {
        black: {
          sector: 'black',
          signalDate: '2026-08-05',
          status: 'unknown',
          direction_observed: bundle.packets.black.observed.direction,
          member_structure: 'broad_based',
          driver: null,
          reason: '无板块级驱动证据',
          relation_to_individual: 'context_only'
        }
      }
    }, bundle.packets);
    assert.equal(out.ok, true);
  });

  it('validateSectorDriverOutput：方向与观察值不一致时 fail loud', () => {
    const bundle = makeBundle();
    const out = lib.validateSectorDriverOutput({
      meta: { mode: 'sector-driver' },
      sectors: {
        black: {
          sector: 'black',
          signalDate: '2026-08-05',
          status: 'unknown',
          direction_observed: 'down',
          member_structure: 'broad_based',
          driver: null,
          reason: 'x',
          relation_to_individual: 'context_only'
        }
      }
    }, bundle.packets);
    assert.equal(out.ok, false);
    assert.ok(out.errors.some((e) => e.includes('direction_observed')));
  });
});
