import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  ELEMENTS_SCHEMA,
  validateElements,
  elementForSymbol,
  entryFromElements,
  bindCheck,
  askBackMessage,
  firstNumber
} = require('../analysis/strategy/ticket-elements.cjs');

function makeElements(overrides = {}) {
  return {
    schema: ELEMENTS_SCHEMA,
    runId: 'r1',
    tickets: [{
      symbol: 'RB0',
      direction: 'bearish',
      contract: 'RB2701',
      activation: '反抽至 3119 下方不破',
      activationLevel: 3119,
      activationSource: 'near_term.pdl',
      activationQuote: '交易单原句',
      confirmation: 'T+1 收盘仍位于 3119 下方',
      entry: 'T+2 开盘入场',
      abandon: '偏离超过 13.8 放弃',
      entryZone: { lower: 3105.2, upper: 3119, lowerBasis: '偏离 >13.8 放弃', upperBasis: '反抽不破 3119' },
      stop: { level: 3132, basis: '收盘站回价值区上沿' },
      targets: { t1: '3065', t2: '3034', basis: '…' },
      maxHold: 'T+5 未到目标市价离场',
      invalidation: ['收盘站上 3132'],
      unresolved: [],
      note: '空 RB2701。反抽至 3119 下方不破；T+1 收盘仍位于 3119 下方；T+2 开盘入场，入场区间 3105.2–3119：开盘高于 3119 放弃（反抽不破失效），低于 3105.2 放弃（偏离 >13.8）。止损 3132，目标 3065/3034。T+5 未到目标市价离场。收盘站上 3132。',
      ...overrides
    }]
  };
}

describe('ticket-elements 交易单要素契约', () => {
  it('完整要素通过结构校验', () => {
    const r = validateElements(makeElements());
    assert.equal(r.ok, true);
  });

  it('缺少确认方式/止损/目标/证伪时校验失败', () => {
    const r = validateElements(makeElements({ confirmation: '', stop: { level: null }, targets: { t1: '' }, invalidation: [] }));
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes('confirmation')));
    assert.ok(r.errors.some((e) => e.includes('stop.level')));
    assert.ok(r.errors.some((e) => e.includes('targets.t1')));
    assert.ok(r.errors.some((e) => e.includes('invalidation')));
  });

  it('录入员改写/补充原文没有的数字时校验失败（保真）', () => {
    const r1 = validateElements(makeElements({ maxHold: 'T+4 未到目标离场' }));
    assert.equal(r1.ok, false);
    assert.ok(r1.errors.some((e) => e.includes('T+4') && e.includes('找不到')));
    const r2 = validateElements(makeElements({ stop: { level: 3133, basis: '收盘站回价值区上沿' } }));
    assert.equal(r2.ok, false);
    assert.ok(r2.errors.some((e) => e.includes('stop.level 3133') && e.includes('找不到')));
    const r3 = validateElements(makeElements({ abandon: '偏离 >12.9 放弃' }));
    assert.equal(r3.ok, false);
    assert.ok(r3.errors.some((e) => e.includes('abandon 点数 12.9') && e.includes('找不到')));
  });

  it('交易单缺 abandon 点数 / targets.t2 / stop.basis 时结构校验失败（ST-01/02/06）', () => {
    const r1 = validateElements(makeElements({ abandon: '' }));
    assert.equal(r1.ok, false);
    assert.ok(r1.errors.some((e) => e.includes('abandon')));
    const r2 = validateElements(makeElements({ targets: { t1: '3065', t2: '', basis: '…' } }));
    assert.equal(r2.ok, false);
    assert.ok(r2.errors.some((e) => e.includes('targets.t2')));
    const r3 = validateElements(makeElements({ stop: { level: 3132, basis: '' } }));
    assert.equal(r3.ok, false);
    assert.ok(r3.errors.some((e) => e.includes('stop.basis')));
    const r4 = validateElements(makeElements({ abandon: '偏离超过阈值放弃' }));
    assert.equal(r4.ok, false);
    assert.ok(r4.errors.some((e) => e.includes('abandon') && e.includes('具体点数')));
    const r5 = validateElements(makeElements({ entryZone: undefined }));
    assert.equal(r5.ok, false);
    assert.ok(r5.errors.some((e) => e.includes('entryZone')));
  });

  it('空单入场区间上沿越过止损时绑定回问（entryZone 只验不修）', () => {
    const el = makeElements().tickets[0];
    const opp = { marketFacts: { pdh: 3140, pdl: 3119, valueAreaHigh: 3132, valueAreaLow: 3119 }, priceRanges: [{ atrBand: { atr5: 27.6 }, hvCone: { p68: [3018.8, 3175.1], p95: [2931.8, 3253] } }] };
    assert.equal(bindCheck(el, opp).ok, true);
    const bad = { ...el, entryZone: { lower: 3105.2, upper: 3135, lowerBasis: '偏离 >13.8 放弃', upperBasis: '错误上沿' } };
    const r = bindCheck(bad, opp);
    assert.equal(r.ok, false);
    assert.ok(r.issues.some((i) => i.includes('3135') && i.includes('高于止损 3132')));
  });

  it('多单入场区间下沿跌破止损 / 触发价不在区间内时绑定回问', () => {
    const base = { ...makeElements().tickets[0], symbol: 'CU0', direction: 'bullish', activation: '回踩至 109150 不破', activationLevel: 109150, activationSource: 'near_term.valueAreaLow', stop: { level: 107870, basis: '收盘跌破价值区上沿' } };
    const opp = { marketFacts: { pdh: 108580, pdl: 107410, valueAreaHigh: 107870, valueAreaLow: 109150 }, priceRanges: [{ atrBand: { atr5: 1200 }, hvCone: { p68: [104150, 112200], p95: [100150, 116700] } }] };
    const badStop = { ...base, entryZone: { lower: 107000, upper: 109750, lowerBasis: '错误下沿', upperBasis: '偏离 >600 放弃' } };
    const r1 = bindCheck(badStop, opp);
    assert.equal(r1.ok, false);
    assert.ok(r1.issues.some((i) => i.includes('107000') && i.includes('低于止损 107870')));
    const badTrigger = { ...base, entryZone: { lower: 109200, upper: 109750, lowerBasis: '错误下沿', upperBasis: '偏离 >600 放弃' } };
    const r2 = bindCheck(badTrigger, opp);
    assert.equal(r2.ok, false);
    assert.ok(r2.issues.some((i) => i.includes('109150') && i.includes('不在入场区间')));
  });

  it('entryFromElements 从要素拼出计划字段，不复制单段自由文本', () => {
    const el = makeElements().tickets[0];
    const entry = entryFromElements(el);
    assert.equal(entry.triggerLevel, 3119);
    assert.ok(entry.trigger.includes('反抽至 3119 下方不破'));
    assert.ok(entry.trigger.includes('确认：T+1 收盘仍位于 3119 下方'));
    assert.equal(entry.execution, 'T+2 开盘入场；偏离超过 13.8 放弃');
    assert.deepEqual({ lower: entry.entryZone.lower, upper: entry.entryZone.upper }, { lower: 3105.2, upper: 3119 });
  });

  it('激活价有来源时绑定通过，无来源且对不上冻结价位时回问交易员', () => {
    const el = makeElements().tickets[0];
    const opp = { marketFacts: { pdh: 3140, pdl: 3119, valueAreaHigh: 3132, valueAreaLow: 3119 }, priceRanges: [{ atrBand: { atr5: 27.6 }, hvCone: { p68: [3018.8, 3175.1], p95: [2931.8, 3253] } }] };
    assert.equal(bindCheck(el, opp).ok, true);
    const bad = { ...el, activationSource: '', activationLevel: 3500 };
    const r = bindCheck(bad, opp);
    assert.equal(r.ok, false);
    assert.ok(r.issues[0].includes('3500'));
  });

  it('askBackMessage 输出自然语言回问', () => {
    const msg = askBackMessage(makeElements(), ['RB0: 激活价 3500 无法绑定']);
    assert.ok(msg.includes('# 交易单要素回问'));
    assert.ok(msg.includes('RB0: 激活价 3500 无法绑定'));
    assert.ok(msg.includes('空 RB2701'));
  });

  it('elementForSymbol 与 firstNumber 基础行为', () => {
    assert.equal(elementForSymbol(makeElements(), 'RB0').symbol, 'RB0');
    assert.equal(elementForSymbol(makeElements(), 'X0'), null);
    assert.equal(firstNumber('目标 3065（3d p68）'), 3065);
    assert.equal(firstNumber(null), null);
  });
});
