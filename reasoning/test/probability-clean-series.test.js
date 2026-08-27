/**
 * Probability Stage 4.5 — P0 干净序列消费测试
 *
 * 架构裁定（HANDOFF_MAIN_CONTINUOUS_FIX.md）验收：
 * "现价距 MA 百分比、HV、ATR 全部基于干净序列"。
 * freeze-packets 产出 analyze/main-series.json（主导合约 OHLCV）后，
 * probability 阶段必须优先消费它，旧 run 无此文件时回退 raw.json。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { execute, loadMainSeries, computeATRFromBars } = require(
  '../../probability/stage-4-5.cjs'
);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures');

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf-8'));
}

// 手工构造极简 run 目录（execute 的输入契约）
function buildRunDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p45-test-'));
  const clean = loadFixture('sa2701-history.json');
  const dirty = loadFixture('sa0-main-continuous.json');

  const rawDates = dirty.bars.map((b) => b.date);
  const raw = {
    contracts: {
      SA0: {
        ohlcv: {
          dates: rawDates,
          open: dirty.bars.map((b) => b.open),
          high: dirty.bars.map((b) => b.high),
          low: dirty.bars.map((b) => b.low),
          close: dirty.bars.map((b) => b.close)
        }
      }
    }
  };

  const filtered = {
    meta: { runId: 'p45-clean-test' },
    candidates: [{ symbol: 'SA0', decision: 'KEEP' }]
  };

  const candidates = {
    candidates: [{
      symbol: 'SA0',
      trend: { close: 9999 },
      indicators: { atr5: 999.9 } // 哨兵值：干净序列可用时不得被使用
    }]
  };

  fs.mkdirSync(path.join(dir, 'analyze'));
  fs.writeFileSync(
    path.join(dir, 'analyze', 'main-series.json'),
    JSON.stringify({ SA0: { contract: clean.contract, bars: clean.bars } }, null, 2)
  );
  fs.writeFileSync(path.join(dir, 'raw.json'), JSON.stringify(raw));
  fs.writeFileSync(path.join(dir, 'filtered.json'), JSON.stringify(filtered));
  fs.writeFileSync(path.join(dir, 'candidates.json'), JSON.stringify(candidates));
  return dir;
}

describe('Probability — computeATRFromBars（与 scanner 同口径）', () => {
  test('干净序列 ATR5 与手工期望一致', () => {
    const fixture = loadFixture('sa2701-history.json');
    const bars = fixture.bars.slice(-21);
    const tr = [];
    for (let i = 1; i < bars.length; i++) {
      tr.push(Math.max(
        bars[i].high - bars[i].low,
        Math.abs(bars[i].high - bars[i - 1].close),
        Math.abs(bars[i].low - bars[i - 1].close)
      ));
    }
    const expected = tr.slice(-5).reduce((a, b) => a + b, 0) / 5;
    const atr5 = computeATRFromBars(bars, 5);
    assert.ok(atr5 !== null);
    assert.ok(Math.abs(atr5 - expected) < 1e-9, `ATR5=${atr5} 期望 ${expected}`);
  });

  test('干净序列 ATR5 ≠ 主力连续污染 ATR5（污染被纠正）', () => {
    const clean = loadFixture('sa2701-history.json');
    const dirty = loadFixture('sa0-main-continuous.json');
    const cleanAtr = computeATRFromBars(clean.bars.slice(-21), 5);
    const dirtyAtr = computeATRFromBars(dirty.bars.slice(-21), 5);
    assert.ok(cleanAtr !== null && dirtyAtr !== null);
    assert.notStrictEqual(cleanAtr, dirtyAtr, '干净/污染序列 ATR 相同说明修复失效');
  });

  test('bar 不足 → null', () => {
    const fixture = loadFixture('sa2701-history.json');
    assert.strictEqual(computeATRFromBars(fixture.bars.slice(0, 3), 5), null);
  });
});

describe('Probability — loadMainSeries', () => {
  test('文件缺失 → {}（旧 run 回退）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p45-ms-'));
    assert.deepStrictEqual(loadMainSeries(dir), {});
  });

  test('文件存在 → 解析为 { symbol: { contract, bars } }', () => {
    const dir = buildRunDir();
    const ms = loadMainSeries(dir);
    assert.ok(ms.SA0);
    assert.strictEqual(ms.SA0.contract, 'SA2701');
    assert.ok(ms.SA0.bars.length >= 21);
  });
});

describe('Probability — execute() 干净序列优先（P0 验收）', () => {
  test('main-series.json 存在时 close/HV/ATR 全来自主导合约，不用哨兵 ATR', async () => {
    const dir = buildRunDir();
    const clean = loadFixture('sa2701-history.json');
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'raw.json'), 'utf-8'));
    const filtered = JSON.parse(fs.readFileSync(path.join(dir, 'filtered.json'), 'utf-8'));
    const candidates = JSON.parse(fs.readFileSync(path.join(dir, 'candidates.json'), 'utf-8'));

    const output = await execute(dir, { filtered, candidates, raw });

    const entry = output.probabilities[0];
    assert.strictEqual(entry.symbol, 'SA0');
    assert.strictEqual(entry.seriesSource, 'specific_contract:SA2701');
    assert.strictEqual(entry.close, clean.bars[clean.bars.length - 1].close,
      'close 必须是主导合约最后收盘');
    assert.notStrictEqual(entry.atrComparison.atr5, 999.9,
      '干净序列可用时不得回退 candidates.json 哨兵 ATR');
    assert.strictEqual(entry.hv.totalBars, clean.bars.length,
      'HV 输入 bar 数 = 干净序列长度');

    const expectedAtr = computeATRFromBars(clean.bars, 5);
    assert.ok(Math.abs(entry.atrComparison.atr5 - expectedAtr) < 1e-6,
      `ATR5=${entry.atrComparison.atr5} 期望干净序列 ${expectedAtr}`);
  });

  test('无 main-series.json → 回退 raw.json 口径（旧 run 兼容）', async () => {
    const dir = buildRunDir();
    fs.rmSync(path.join(dir, 'analyze', 'main-series.json'));
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'raw.json'), 'utf-8'));
    const filtered = JSON.parse(fs.readFileSync(path.join(dir, 'filtered.json'), 'utf-8'));
    const candidates = JSON.parse(fs.readFileSync(path.join(dir, 'candidates.json'), 'utf-8'));

    const output = await execute(dir, { filtered, candidates, raw });
    const entry = output.probabilities[0];
    assert.strictEqual(entry.seriesSource, 'main_continuous:raw.json+atr:candidates.json');
    assert.strictEqual(entry.close, raw.contracts.SA0.ohlcv.close.at(-1));
    assert.strictEqual(entry.atrComparison.atr5, 999.9,
      '旧 run 回退：ATR 来自 candidates.json');
  });
});
