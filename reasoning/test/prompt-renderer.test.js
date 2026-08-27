/**
 * Prompt Renderer Test
 * 验证prompt渲染器能正确替换占位符并生成四臂prompt
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { renderFourArmPrompts } from '../lib/prompt-renderer.js';

describe('Prompt Renderer', () => {
  test('渲染SP prompt替换所有占位符', () => {
    const packet = {
      symbol: 'RB2501',
      signalDate: '2026-08-15',
      fields: {
        price_data: {
          source: 'akshare',
          asOf: '2026-08-15T15:00:00+08:00',
          fetchedAt: '2026-08-15T15:05:00+08:00',
          close_60d: [4000, 4100],
          ma20: 4050,
          ma60: 3980,
          freshness: 'same_day',
          gap: null
        }
      }
    };

    const prompts = renderFourArmPrompts(packet);

    // 验证symbol替换
    assert.ok(prompts.sp.includes('RB2501'));
    assert.ok(!prompts.sp.includes('{{symbol}}'));

    // 验证signalDate替换
    assert.ok(prompts.sp.includes('2026-08-15'));
    assert.ok(!prompts.sp.includes('{{signalDate}}'));

    // 验证evidence替换
    assert.ok(prompts.sp.includes('price_data'));
    assert.ok(prompts.sp.includes('close_60d'));
    assert.ok(!prompts.sp.includes('{{evidence}}'));
  });

  test('渲染四臂prompt均替换占位符', () => {
    const packet = {
      symbol: 'RB2501',
      signalDate: '2026-08-15',
      fields: {
        price_data: {
          source: 'akshare',
          asOf: '2026-08-15T15:00:00+08:00',
          fetchedAt: '2026-08-15T15:05:00+08:00',
          close_60d: [4000, 4100],
          ma20: 4050,
          ma60: 3980,
          freshness: 'same_day',
          gap: null
        },
        volume_oi: {
          source: 'akshare',
          asOf: '2026-08-15T15:00:00+08:00',
          fetchedAt: '2026-08-15T15:06:00+08:00',
          volume_60d: [100000, 110000],
          avgVolume5d: 105000,
          freshness: 'same_day',
          gap: null
        }
      }
    };

    const prompts = renderFourArmPrompts(packet);

    // 验证四个prompt都没有未替换的占位符
    for (const [arm, prompt] of Object.entries(prompts)) {
      assert.ok(!prompt.includes('{{symbol}}'), `${arm} 应替换symbol`);
      assert.ok(!prompt.includes('{{signalDate}}'), `${arm} 应替换signalDate`);
      assert.ok(!prompt.includes('{{evidence}}'), `${arm} 应替换evidence`);
    }
  });

  test('evidence渲染包含所有字段元数据', () => {
    const packet = {
      symbol: 'RB2501',
      signalDate: '2026-08-15',
      fields: {
        price_data: {
          source: 'akshare',
          asOf: '2026-08-15T15:00:00+08:00',
          fetchedAt: '2026-08-15T15:05:00+08:00',
          close_60d: [4000, 4100],
          ma20: 4050,
          ma60: 3980,
          freshness: 'same_day',
          gap: null
        }
      }
    };

    const prompts = renderFourArmPrompts(packet);

    // 验证元数据字段
    assert.ok(prompts.sp.includes('source: akshare'));
    assert.ok(prompts.sp.includes('asOf: 2026-08-15T15:00:00+08:00'));
    assert.ok(prompts.sp.includes('fetchedAt: 2026-08-15T15:05:00+08:00'));
    assert.ok(prompts.sp.includes('freshness: same_day'));
    assert.ok(prompts.sp.includes('gap: null'));

    // 验证数据字段
    assert.ok(prompts.sp.includes('close_60d: [4000, 4100]'));
    assert.ok(prompts.sp.includes('ma20: 4050'));
    assert.ok(prompts.sp.includes('ma60: 3980'));
  });

  test('渲染包含_published_at的可选字段', () => {
    const packet = {
      symbol: 'RB2501',
      signalDate: '2026-08-15',
      fields: {
        price_data: {
          source: 'akshare',
          asOf: '2026-08-15T15:00:00+08:00',
          fetchedAt: '2026-08-15T15:05:00+08:00',
          close_60d: [4000, 4100],
          ma20: 4050,
          ma60: 3980,
          freshness: 'same_day',
          gap: null
        },
        basis: {
          source: 'mx-data',
          asOf: '2026-08-15T14:30:00+08:00',
          fetchedAt: '2026-08-15T15:10:00+08:00',
          _published_at: '2026-08-15T14:30:00+08:00',
          value: 50,
          freshness: 'same_day',
          gap: null
        }
      }
    };

    const prompts = renderFourArmPrompts(packet);

    // 验证_published_at渲染
    assert.ok(prompts.sp.includes('_published_at: 2026-08-15T14:30:00+08:00'));
  });

  test('SP prompt包含strategy固定值说明', () => {
    const packet = {
      symbol: 'RB2501',
      signalDate: '2026-08-15',
      fields: {
        price_data: {
          source: 'akshare',
          asOf: '2026-08-15T15:00:00+08:00',
          fetchedAt: '2026-08-15T15:05:00+08:00',
          close_60d: [4000, 4100],
          ma20: 4050,
          ma60: 3980,
          freshness: 'same_day',
          gap: null
        }
      }
    };

    const prompts = renderFourArmPrompts(packet);

    // SP策略应说明strategy固定为"sp"
    assert.ok(prompts.sp.includes('"strategy": "sp"'));
  });

  test('FinCoT prompt包含三分支说明', () => {
    const packet = {
      symbol: 'RB2501',
      signalDate: '2026-08-15',
      fields: {
        price_data: {
          source: 'akshare',
          asOf: '2026-08-15T15:00:00+08:00',
          fetchedAt: '2026-08-15T15:05:00+08:00',
          close_60d: [4000, 4100],
          ma20: 4050,
          ma60: 3980,
          freshness: 'same_day',
          gap: null
        },
        volume_oi: {
          source: 'akshare',
          asOf: '2026-08-15T15:00:00+08:00',
          fetchedAt: '2026-08-15T15:06:00+08:00',
          volume_60d: [100000, 110000],
          avgVolume5d: 105000,
          freshness: 'same_day',
          gap: null
        }
      }
    };

    const prompts = renderFourArmPrompts(packet);

    // FinCoT应包含三分支结构说明
    assert.ok(prompts.finCot.includes('Regime'));
    assert.ok(prompts.finCot.includes('Macro'));
    assert.ok(prompts.finCot.includes('Position'));
  });
});
