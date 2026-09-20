/**
 * Specific-Contract Series Test (P0: 主力连续污染修复)
 *
 * 架构裁定（HANDOFF_MAIN_CONTINUOUS_FIX.md）：
 * 主力连续是"筛选指数"，不是"价格水平数据源"。
 * deep-dig 的 price_data / volume_oi 必须用当日主导合约自身序列。
 *
 * 验收标准：SA2701 MA20/MA60 与同花顺期货 APP 一致（容差 <0.5%）。
 * 已知污染案例：SA0 主力连续 MA20=984.85 vs SA2701 自身 1025.3（同花顺 1026.4）。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildCleanSeriesFields,
  fetchContractHistory,
  overrideWithCleanSeries
} from '../lib/specific-contract.js';
import { assessPointInTime } from '../lib/packet-bundle.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures');

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf-8'));
}

// 同花顺期货 APP 显示值（铲屎官 2026-08-26 核对，信号日 2026-08-25）
const THS_MA20 = 1026.4;
const THS_TOLERANCE = 0.005; // 验收容差 <0.5%

const BASE_META = {
  signalDate: '2026-08-25',
  fetchedAt: '2026-08-26T09:08:43.180Z'
};

describe('Specific Contract — buildCleanSeriesFields（纯函数）', () => {
  test('SA2701 干净序列 MA20/MA60 与同花顺一致（容差 <0.5%）', () => {
    const fixture = loadFixture('sa2701-history.json');
    const { price_data, volume_oi } = buildCleanSeriesFields({
      contract: fixture.contract,
      bars: fixture.bars,
      ...BASE_META
    });

    assert.strictEqual(price_data.gap, null);
    assert.ok(Math.abs(price_data.ma20 - THS_MA20) / THS_MA20 < THS_TOLERANCE,
      `MA20=${price_data.ma20} 与同花顺 ${THS_MA20} 偏差超 0.5%`);
    assert.ok(Math.abs(price_data.ma60 - 1114.9833) / 1114.9833 < THS_TOLERANCE,
      `MA60=${price_data.ma60} 与干净序列期望 1114.9833 偏差超 0.5%`);
    assert.strictEqual(price_data.close_60d.length, 60);
    assert.strictEqual(price_data.close_60d[59], 1045);
  });

  test('修复有效：干净 MA20 与主力连续污染值 984.85 差异 >30 点', () => {
    const fixture = loadFixture('sa2701-history.json');
    const dirty = loadFixture('sa0-main-continuous.json');
    const { price_data } = buildCleanSeriesFields({
      contract: fixture.contract,
      bars: fixture.bars,
      ...BASE_META
    });
    const dirtyCloses = dirty.bars.map((b) => b.close);
    const dirtyMa20 = dirtyCloses.slice(-20).reduce((a, b) => a + b, 0) / 20;

    assert.strictEqual(dirtyMa20, 984.85, 'fixture 对照值漂移，需更新期望');
    assert.ok(Math.abs(price_data.ma20 - dirtyMa20) > 30,
      `干净 MA20=${price_data.ma20} 与污染值 ${dirtyMa20} 差异应 >30 点`);
  });

  test('字段标注口径：series_contract / series_source', () => {
    const fixture = loadFixture('sa2701-history.json');
    const { price_data } = buildCleanSeriesFields({
      contract: fixture.contract,
      bars: fixture.bars,
      ...BASE_META
    });
    assert.strictEqual(price_data.series_contract, 'SA2701');
    assert.strictEqual(price_data.series_source, 'specific_contract');
  });

  test('volume_oi 基于干净序列：avgVolume5d / openInterest_60d', () => {
    const fixture = loadFixture('sa2701-history.json');
    const { volume_oi } = buildCleanSeriesFields({
      contract: fixture.contract,
      bars: fixture.bars,
      ...BASE_META
    });
    assert.strictEqual(volume_oi.gap, null);
    assert.strictEqual(volume_oi.avgVolume5d, 1592266.4);
    assert.strictEqual(volume_oi.volume_60d.length, 60);
    assert.strictEqual(volume_oi.openInterest_60d.length, 60);
    assert.strictEqual(volume_oi.openInterest_60d[59], 1078079);
  });

  test('历史 20-59 bar → ma60=null + 标注，不得静默冒充', () => {
    const fixture = loadFixture('sa2701-history.json');
    const { price_data } = buildCleanSeriesFields({
      contract: fixture.contract,
      bars: fixture.bars.slice(-40), // 40 bar：ma20 可算，ma60 不足
      ...BASE_META
    });
    assert.strictEqual(price_data.gap, null);
    assert.strictEqual(price_data.ma60, null);
    assert.ok(price_data.series_note.includes('ma60'), '应标注 ma60 降级原因');
    assert.ok(price_data.ma20 !== null, '40 bar 应可算 ma20');
  });

  test('历史 <20 bar → price_data gap=missing，整体降级', () => {
    const fixture = loadFixture('sa2701-history.json');
    const { price_data, volume_oi } = buildCleanSeriesFields({
      contract: fixture.contract,
      bars: fixture.bars.slice(-10),
      ...BASE_META
    });
    assert.strictEqual(price_data.gap, 'missing');
    assert.strictEqual(volume_oi.gap, 'missing');
  });

  test('signalDate 锚定：尾部含未来 bar 时截断，不用未来数据', () => {
    const fixture = loadFixture('sa2701-history.json');
    const futureBar = {
      date: '2026-08-26', open: 9999, high: 9999, low: 9999, close: 9999,
      volume: 1, hold: 1, settle: 9999
    };
    const { price_data } = buildCleanSeriesFields({
      contract: fixture.contract,
      bars: [...fixture.bars, futureBar], // 混入 8-26 未来 bar
      ...BASE_META
    });
    assert.strictEqual(price_data.close_60d[59], 1045, '60 日窗口末值必须是 8-25 收盘');
    assert.ok(!price_data.close_60d.includes(9999), '未来 bar 不得进入窗口');
  });

  test('provenance：gap=null 字段必须带 _timestamp_origin=observed（回归：override 丢章导致 replay 资格丢失）', () => {
    const fixture = loadFixture('sa2701-history.json');
    const { price_data, volume_oi } = buildCleanSeriesFields({
      contract: fixture.contract,
      bars: fixture.bars,
      ...BASE_META
    });
    assert.strictEqual(price_data._timestamp_origin, 'observed',
      'price_data 覆盖后必须保留 observed 溯源章');
    assert.strictEqual(volume_oi._timestamp_origin, 'observed',
      'volume_oi 覆盖后必须保留 observed 溯源章');
  });

  test('provenance：gap=missing 字段不得伪造 observed 章', () => {
    const fixture = loadFixture('sa2701-history.json');
    const { price_data } = buildCleanSeriesFields({
      contract: fixture.contract,
      bars: fixture.bars.slice(-10),
      ...BASE_META
    });
    assert.strictEqual(price_data.gap, 'missing');
    assert.strictEqual(price_data._timestamp_origin, undefined,
      '数据不足时不得盖章 observed（缺失数据无 replay 资格）');
  });
});

describe('Specific Contract — override 后 point-in-time 资格（集成）', () => {
  test('干净序列覆盖后 assessPointInTime 必须 eligible=true', () => {
    const fixture = loadFixture('sa2701-history.json');
    const raw = {
      symbol: 'SA0',
      signalDate: '2026-08-25',
      marketCutoffAt: '2026-08-25T15:00:00+08:00',
      packetFrozenAt: '2026-08-26T09:10:00.000Z',
      fields: {}
    };
    const result = overrideWithCleanSeries(raw, fixture.contract, fixture.bars, '2026-08-26T09:09:00.000Z');
    assert.strictEqual(result.ok, true);

    const { eligible, reasons } = assessPointInTime(raw);
    assert.strictEqual(eligible, true, reasons.join('; '));
  });

  test('fetchedAt 晚于 packetFrozenAt（封存时刻早于抓取）→ 时间边界 violation', () => {
    const fixture = loadFixture('sa2701-history.json');
    const raw = {
      symbol: 'SA0',
      signalDate: '2026-08-25',
      marketCutoffAt: '2026-08-25T15:00:00+08:00',
      packetFrozenAt: '2026-08-26T09:08:00.000Z', // 早于 fetchedAt
      fields: {}
    };
    overrideWithCleanSeries(raw, fixture.contract, fixture.bars, '2026-08-26T09:09:00.000Z');

    const { eligible, reasons } = assessPointInTime(raw);
    assert.strictEqual(eligible, false, 'fetchedAt > packetFrozenAt 不得 eligible');
    assert.ok(reasons.some((r) => r.includes('fetchedAt')), `reasons 应含时间边界违规: ${reasons.join('; ')}`);
  });
});

describe('Specific Contract — fetchContractHistory 退避重试', () => {
  test('子进程连续失败 → 按退避重试后最终 reject', async () => {
    const start = Date.now();
    await assert.rejects(
      fetchContractHistory('SA2701', '2026-08-25', {
        python: process.execPath, // node 无法执行 .py，稳定触发 exit code 1
        retries: 2,
        backoffBaseMs: 5,
        timeout: 10000
      }),
      /exited with code/
    );
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 15, `退避等待应生效（5ms + 10ms，实际 ${elapsed}ms）`);
  });
});
