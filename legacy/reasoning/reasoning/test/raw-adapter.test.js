/**
 * Raw Adapter Test
 * 验证从真实raw.json提取packet字段的能力
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { buildPacketFromRawJson, extractContractFields } from '../lib/raw-adapter.js';
import { buildPacket } from '../lib/packet-builder.js';
import { RAW_JSON_PATH } from './helpers/fixtures.mjs';

describe('Raw Adapter', () => {
  test('从真实raw.json提取RB0的2026-08-04数据', () => {
    const rawJsonPath = RAW_JSON_PATH;
    const raw = buildPacketFromRawJson(rawJsonPath, 'RB0', '2026-08-04');

    assert.strictEqual(raw.symbol, 'RB0');
    assert.strictEqual(raw.signalDate, '2026-08-04');
    assert.ok(raw.fields.price_data);
    assert.ok(raw.fields.volume_oi);
  });

  test('真实artifact保留源抓取时间且暴露晚于冻结点的事实', () => {
    const rawJsonPath = RAW_JSON_PATH;
    const raw = buildPacketFromRawJson(rawJsonPath, 'RB0', '2026-08-04');

    assert.strictEqual(raw.fields.price_data.fetchedAt, '2026-08-05T10:28:05.739623');
    assert.strictEqual(raw.fields.volume_oi.fetchedAt, '2026-08-05T10:28:05.739623');
    assert.ok(new Date(raw.fields.price_data.fetchedAt) > new Date(raw.packetFrozenAt));
  });

  test('提取的price_data包含必填字段', () => {
    const rawJsonPath = RAW_JSON_PATH;
    const raw = buildPacketFromRawJson(rawJsonPath, 'RB0', '2026-08-04');

    const { price_data } = raw.fields;
    assert.ok(price_data.asOf);
    assert.ok(price_data.fetchedAt);
    assert.ok(Array.isArray(price_data.close_60d));
    assert.ok(price_data.close_60d.length > 0);
    assert.strictEqual(typeof price_data.ma20, 'number');
    assert.strictEqual(typeof price_data.ma60, 'number');
    assert.strictEqual(price_data.freshness, 'same_day');
    assert.strictEqual(price_data.gap, null);
  });

  test('提取的volume_oi包含必填字段', () => {
    const rawJsonPath = RAW_JSON_PATH;
    const raw = buildPacketFromRawJson(rawJsonPath, 'RB0', '2026-08-04');

    const { volume_oi } = raw.fields;
    assert.ok(volume_oi.asOf);
    assert.ok(volume_oi.fetchedAt);
    assert.ok(Array.isArray(volume_oi.volume_60d));
    assert.ok(volume_oi.volume_60d.length > 0);
    assert.ok(Array.isArray(volume_oi.openInterest_60d));
    assert.strictEqual(volume_oi.openInterest_60d.length, volume_oi.volume_60d.length);
    assert.strictEqual(typeof volume_oi.avgVolume5d, 'number');
    assert.strictEqual(volume_oi.freshness, 'same_day');
    assert.strictEqual(volume_oi.gap, null);
  });

  test('真实artifact因源抓取晚于历史冻结点而被时间门禁拒绝', () => {
    const rawJsonPath = RAW_JSON_PATH;
    const raw = buildPacketFromRawJson(rawJsonPath, 'RB0', '2026-08-04');

    const { packet, validation } = buildPacket(raw);

    assert.strictEqual(validation.schema.valid, true, 'schema验证应通过');
    assert.strictEqual(validation.timeBoundary.valid, false, '事后抓取artifact不得伪装成point-in-time packet');
    assert.strictEqual(packet.quality_check.executable, false, '时间边界违约时packet不可执行');
    assert.ok(validation.timeBoundary.violations.some(
      violation => violation.constraint === 'fetchedAt <= packetFrozenAt'
    ));
    assert.ok(!packet.quality_check.required_available.includes('price_data'));
    assert.ok(!packet.quality_check.required_available.includes('volume_oi'));
  });

  test('真实数据的MA计算正确', () => {
    const rawJsonPath = RAW_JSON_PATH;
    const raw = buildPacketFromRawJson(rawJsonPath, 'RB0', '2026-08-04');

    const { price_data } = raw.fields;

    const artifact = JSON.parse(readFileSync(rawJsonPath, 'utf8'));
    const closes = artifact.contracts.RB0.ohlcv.close;
    const signalIndex = artifact.contracts.RB0.ohlcv.dates.indexOf('2026-08-04');
    const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
    const expectedMa20 = mean(closes.slice(signalIndex - 19, signalIndex + 1));
    const expectedMa60 = mean(closes.slice(signalIndex - 59, signalIndex + 1));

    assert.strictEqual(price_data.ma20, expectedMa20);
    assert.strictEqual(price_data.ma60, expectedMa60);
  });

  test('不存在的symbol抛出错误', () => {
    const rawJsonPath = RAW_JSON_PATH;

    assert.throws(() => {
      buildPacketFromRawJson(rawJsonPath, 'NONEXISTENT', '2026-08-04');
    }, /Symbol NONEXISTENT not found/);
  });

  test('不存在的signalDate返回空fields', () => {
    const rawJsonPath = RAW_JSON_PATH;
    const raw = buildPacketFromRawJson(rawJsonPath, 'RB0', '2025-01-01');

    // signalDate不在数据范围内时，fields应为空或标记为missing
    const fieldCount = Object.keys(raw.fields).length;
    assert.ok(fieldCount === 0 || raw.fields.price_data?.gap === 'missing');
  });

  test('MA锚定signalDate：数组含未来bar时不得泄漏（回归：尾部锚定bug）', () => {
    // 构造 65 个 bar，signalDate 在第 60 个（index 59），后面 5 根是"未来"数据
    const dates = Array.from({ length: 65 }, (_, i) => `2026-05-${String(i + 1).padStart(2, '0')}`);
    const close = Array.from({ length: 65 }, (_, i) => 1000 + i);
    const volume = Array.from({ length: 65 }, () => 100000);

    const signalDate = dates[59];
    const fields = extractContractFields(
      { fetchedAt: `${signalDate}T15:30:00+08:00`, ohlcv: { dates, close, volume } }, 'RB0', signalDate,
      `${signalDate}T15:00:00+08:00`, `${signalDate}T16:30:00+08:00`);

    // 截至 index 59 的 MA20 = mean(close[40..59])
    const expectedMa20 = (close[40] + close[59]) / 2;
    // 尾部锚定的错误值 = mean(close[45..64])，混入未来 5 bar
    const tailMa20 = (close[45] + close[64]) / 2;
    // 截至 index 59 的 MA60 = mean(close[0..59])
    const expectedMa60 = (close[0] + close[59]) / 2;

    assert.strictEqual(fields.price_data.ma20, expectedMa20, 'MA20必须锚定signalDate窗口');
    assert.notStrictEqual(fields.price_data.ma20, tailMa20, '不得使用尾部未来bar');
    assert.strictEqual(fields.price_data.ma60, expectedMa60, 'MA60必须锚定signalDate窗口');
    // close_60d 也必须止于 signalDate
    assert.strictEqual(fields.price_data.close_60d.length, 60);
    assert.strictEqual(fields.price_data.close_60d.at(-1), close[59]);
  });

  test('历史不足60bar时ma60为null且price_data标missing', () => {
    // 仅 40 个 bar，signalDate 在末尾（index 39）——MA60 窗口不足
    const dates = Array.from({ length: 40 }, (_, i) => `2026-05-${String(i + 1).padStart(2, '0')}`);
    const close = Array.from({ length: 40 }, (_, i) => 1000 + i);
    const volume = Array.from({ length: 40 }, () => 100000);

    const signalDate = dates[39];
    const fields = extractContractFields(
      { fetchedAt: `${signalDate}T15:30:00+08:00`, ohlcv: { dates, close, volume } }, 'RB0', signalDate,
      `${signalDate}T15:00:00+08:00`, `${signalDate}T16:30:00+08:00`);

    assert.strictEqual(fields.price_data.gap, 'missing', 'MA60不足时price_data应标missing');
    assert.strictEqual(fields.price_data.ma20, undefined);
    assert.ok(fields.volume_oi, 'volume_oi不受MA窗口影响');
  });
});
