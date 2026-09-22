/**
 * test/story-chain-v21.test.js — V2.1 故事链收紧契约
 *
 * 覆盖：
 *   1. T2 节点必须显式 kind=event|flow、maxFreshDays；flow 必须 minSources 2..5
 *   2. resolve 多源契约：sourceTier 必填（不默认 C）、flow 多源独立域名且方向一致
 *   3. provisional 链不参与证明、不产生故事席位；markChainProvisional 降级
 *   4. 提示词包含前提严谨性/中性采集/T2 新契约，活跃链表对 V3 链不再显示 undefined
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const sc = require(path.join(ROOT, 'stories', 'lib', 'story-chain.cjs'));
const seats = require(path.join(ROOT, 'stories', 'seats', 'build-filtered-from-story-pool.cjs'));
const pb = require(path.join(ROOT, 'stories', 'lib', 'story-chain-prompt.cjs'));

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'story-chain-v21-'));
}

function reasoningCardFor(def, overrides = {}) {
  const terminal = (def.nodes || []).find((n) => n.terminal) || {};
  return {
    schema: 'futures-radar-story-reasoning-card/1',
    claim: {
      source: def.sourceId,
      direction: terminal.expectation != null ? terminal.expectation : -1,
      path: (def.nodes || []).map((n) => n.id),
    },
    mechanisms: (def.edges || []).map((e) => ({ edgeId: e.id, why: e.logic })),
    evidenceRefs: {
      news: [],
      indicators: (def.nodes || []).map((n) => n.indicatorId).filter(Boolean),
    },
    assumptions: ['测试前提：源与传导路径独立成立'],
    uncertainties: ['测试不确定性：下游节点可能延迟兑现'],
    falsifiers: ['测试证伪：源节点连续两日反向'],
    ...overrides,
  };
}

function flowDef(overrides = {}) {
  const def = {
    schema: 'futures-radar-story-chain/3',
    chainId: 'CH-BLACK-20260920-01',
    createdAt: '2026-09-20',
    sourceId: '全国建筑钢材成交量日同比',
    theme: '黑色需求退潮',
    themeDetail: '建材成交同比走弱，黑色板块跑输市场，螺纹等待跌破 MA20',
    nodes: [
      {
        id: 'n1', concept: '全国建筑钢材成交量日同比',
        dataPlan: { paths: ['T2'], kind: 'flow', baseline: 0, unit: '%', maxFreshDays: 7, metric: '全国建筑钢材成交量', basis: 'yoy', minSources: 2, searchHints: ['Mysteel 建筑钢材成交量'] },
        expectation: -1, label: '终端需求走弱',
      },
      { id: 'n2', indicatorId: 'sector.black.rs5d', expectation: -1, label: '黑色板块跑输市场' },
      {
        id: 'n3', indicatorId: 'symbol.RB0.price.vs_ma20', expectation: -1, label: '螺纹跌破 MA20',
        terminal: true, priority: 'primary',
        impactRationale: '需求证伪后螺纹定价最先承压并失守 MA20', proofIndex: 2,
      },
    ],
    edges: [
      { id: 'e1', from: 'n1', to: 'n2', latencyDays: 5, logic: '终端需求走弱使钢厂与贸易商让价去库，黑色板块相对强度转负' },
      { id: 'e2', from: 'n2', to: 'n3', latencyDays: 5, logic: '板块弱势由需求主导，资金优先对螺纹定价，收盘跌破 MA20' },
    ],
    maxLifespanTradingDays: 20,
    ...overrides,
  };
  def.reasoningCard = def.reasoningCard ?? reasoningCardFor(def);
  return def;
}

function flowResults(observations) {
  return { results: [{ nodeId: 'n1', observations }] };
}

describe('V2.1 T2 契约收紧（注册校验）', () => {
  it('T2 节点必须显式 kind=event|flow；缺失/非法拒收', () => {
    const noKind = flowDef();
    delete noKind.nodes[0].dataPlan.kind;
    assert.match(sc.validateChainDefinition(noKind).errors.join('|'), /kind/);
    const badKind = flowDef();
    badKind.nodes[0].dataPlan.kind = 'series';
    assert.match(sc.validateChainDefinition(badKind).errors.join('|'), /kind/);
    assert.equal(sc.validateChainDefinition(flowDef()).ok, true);
  });

  it('T2 节点必须显式 maxFreshDays（无默认 7）', () => {
    const noFresh = flowDef();
    delete noFresh.nodes[0].dataPlan.maxFreshDays;
    assert.match(sc.validateChainDefinition(noFresh).errors.join('|'), /maxFreshDays 必须显式/);
  });

  it('kind=flow 必须显式 minSources 2..5', () => {
    const noMin = flowDef();
    delete noMin.nodes[0].dataPlan.minSources;
    assert.match(sc.validateChainDefinition(noMin).errors.join('|'), /minSources/);
    const lowMin = flowDef();
    lowMin.nodes[0].dataPlan.minSources = 1;
    assert.match(sc.validateChainDefinition(lowMin).errors.join('|'), /minSources/);
  });

  it('kind=event 允许单源（不要求 minSources）', () => {
    const eventDef = flowDef();
    eventDef.nodes[0].dataPlan = { paths: ['T2'], kind: 'event', baseline: 0, unit: '次', maxFreshDays: 3, searchHints: ['政策公告'] };
    assert.equal(sc.validateChainDefinition(eventDef).ok, true, sc.validateChainDefinition(eventDef).errors.join(';'));
  });
});

describe('V2.1 链推理卡（与六问信息量对齐）', () => {
  it('合法推理卡通过校验并随链注册持久化', () => {
    const root = tmpRoot();
    const r = sc.registerChain(flowDef(), { root });
    assert.equal(r.ok, true, JSON.stringify(r));
    const c = sc.loadChain(r.chainId, root);
    assert.equal(c.reasoningCard.schema, 'futures-radar-story-reasoning-card/1');
    assert.equal(c.reasoningCard.mechanisms.length, 2);
    const view = sc.buildView({ root });
    assert.equal(view.active[0].hasReasoningCard, true);
  });

  it('缺失 reasoningCard 或 schema 错误 → 注册拒收', () => {
    const missing = flowDef();
    delete missing.reasoningCard;
    assert.match(sc.validateChainDefinition(missing).errors.join('|'), /reasoningCard 缺失/);
    const badSchema = flowDef();
    badSchema.reasoningCard = { ...badSchema.reasoningCard, schema: 'x' };
    assert.match(sc.validateChainDefinition(badSchema).errors.join('|'), /reasoningCard\.schema/);
  });

  it('claim 方向/路径与 mechanisms 结构校验（只验形态，不验语义）', () => {
    const badDir = flowDef();
    badDir.reasoningCard = { ...badDir.reasoningCard, claim: { ...badDir.reasoningCard.claim, direction: 0 } };
    assert.match(sc.validateChainDefinition(badDir).errors.join('|'), /claim\.direction/);
    const badPath = flowDef();
    badPath.reasoningCard = { ...badPath.reasoningCard, claim: { ...badPath.reasoningCard.claim, path: ['n1', 'n9', 'n3'] } };
    assert.match(sc.validateChainDefinition(badPath).errors.join('|'), /未定义节点/);
    const badMech = flowDef();
    badMech.reasoningCard = { ...badMech.reasoningCard, mechanisms: badMech.reasoningCard.mechanisms.slice(0, 1) };
    assert.match(sc.validateChainDefinition(badMech).errors.join('|'), /一一对应/);
  });

  it('提示词要求输出 reasoningCard 且信息量与六问对齐', () => {
    const p = pb.buildStoryChainPrompt({ signalDate: '2026-09-21', runId: 'x', macroIndicators: {}, sectors: {}, activeChains: [], catalog: { indicators: {} } });
    assert.match(p, /reasoningCard/);
    assert.match(p, /信息量对齐/);
    assert.match(p, /mechanisms 与 edges 一一对应/);
    assert.match(p, /falsifiers/);
  });
});

describe('V2.1 T2 反证预防（中性概念与冻结口径）', () => {
  it('flow concept 预置方向结论（走弱/下降等）→ 注册拒收', () => {
    const bad = flowDef();
    bad.chainId = 'CH-BLACK-20260920-REV';
    bad.sourceId = '全国建筑钢材成交量同比走弱';
    bad.nodes[0].concept = '全国建筑钢材成交量同比走弱';
    const check = sc.validateChainDefinition(bad);
    assert.equal(check.ok, false);
    assert.match(check.errors.join('|'), /不得预置方向结论/);
  });

  it('searchHints 预置方向结论 → 注册拒收', () => {
    const bad = flowDef();
    bad.nodes[0].dataPlan.searchHints = ['建筑钢材成交走弱'];
    const check = sc.validateChainDefinition(bad);
    assert.equal(check.ok, false);
    assert.match(check.errors.join('|'), /检索词必须是中性口径/);
  });

  it('flow 必须显式 metric 与 basis，concept 必须指向可计量对象', () => {
    const noMetric = flowDef();
    delete noMetric.nodes[0].dataPlan.metric;
    assert.match(sc.validateChainDefinition(noMetric).errors.join('|'), /metric/);
    const noBasis = flowDef();
    delete noBasis.nodes[0].dataPlan.basis;
    assert.match(sc.validateChainDefinition(noBasis).errors.join('|'), /basis/);
    const vague = flowDef();
    vague.nodes[0].concept = '终端需求走弱迹象';
    vague.sourceId = vague.nodes[0].concept;
    const check = sc.validateChainDefinition(vague);
    assert.equal(check.ok, false);
    assert.match(check.errors.join('|'), /可计量的量|预置方向结论/);
  });

  it('resolve brief 不把 concept 当检索词，只拼中性 hints+metric+basis', () => {
    const root = tmpRoot();
    const r = sc.registerChain(flowDef(), { root });
    const out = sc.generateResolveBrief(r.chainId, { root });
    assert.equal(out.ok, true);
    const brief = JSON.parse(fs.readFileSync(out.file, 'utf8'));
    assert.ok(brief.requests[0].queries.includes('Mysteel 建筑钢材成交量'));
    assert.ok(brief.requests[0].queries.includes('全国建筑钢材成交量'));
    assert.ok(brief.requests[0].queries.includes('同比'));
    assert.equal(brief.requests[0].queries.includes('全国建筑钢材成交量日同比'), false);
    assert.equal(brief.requests[0].metric, '全国建筑钢材成交量');
    assert.equal(brief.requests[0].basis, 'yoy');
  });
});

describe('V2.1 T2 resolve 多源契约', () => {
  it('flow 两个独立域名来源且方向一致 → 入库，独立源计数生效', () => {
    const root = tmpRoot();
    const r = sc.registerChain(flowDef(), { root });
    assert.equal(r.ok, true);
    const out = sc.resolveChain(r.chainId, {
      root,
      results: flowResults([
        { value: -23.17, asOf: '2026-09-20', unit: '%', metric: '全国建筑钢材成交量', basis: 'yoy', sourceUrl: 'https://a.example.com/x', sourceTitle: 'x', sourceTier: 'A' },
        { value: -10.95, asOf: '2026-09-19', unit: '%', metric: '全国建筑钢材成交量', basis: 'yoy', sourceUrl: 'https://b.example.net/y', sourceTitle: 'y', sourceTier: 'A' },
      ]),
    });
    assert.equal(out.ok, true, out.errors.join(';'));
    const c = sc.loadChain(r.chainId, root);
    assert.equal(c.nodes[0].resolution.kind, 'flow');
    assert.equal(c.nodes[0].resolution.sources.length, 2);
    assert.equal(sc.deriveCredibility(c.nodes[0], '2026-09-20'), 'high'); // A 级 + 2 独立源 + fresh
  });

  it('flow 观测换基准（dod 冒充 yoy）或换指标 → 拒收', () => {
    const root = tmpRoot();
    const r = sc.registerChain(flowDef(), { root });
    const wrongBasis = sc.resolveChain(r.chainId, {
      root,
      results: flowResults([
        { value: -23.17, asOf: '2026-09-20', unit: '%', metric: '全国建筑钢材成交量', basis: 'dod', sourceUrl: 'https://a.example.com/x', sourceTier: 'A' },
        { value: -10.95, asOf: '2026-09-19', unit: '%', metric: '全国建筑钢材成交量', basis: 'yoy', sourceUrl: 'https://b.example.net/y', sourceTier: 'A' },
      ]),
    });
    assert.equal(wrongBasis.ok, false);
    assert.match(wrongBasis.errors.join('|'), /换基准=挑口径/);
    const wrongMetric = sc.resolveChain(r.chainId, {
      root,
      results: flowResults([
        { value: -23.17, asOf: '2026-09-20', unit: '%', metric: '全国重点城市钢材成交量', basis: 'yoy', sourceUrl: 'https://a.example.com/x', sourceTier: 'A' },
        { value: -10.95, asOf: '2026-09-19', unit: '%', metric: '全国重点城市钢材成交量', basis: 'yoy', sourceUrl: 'https://b.example.net/y', sourceTier: 'A' },
      ]),
    });
    assert.equal(wrongMetric.ok, false);
    assert.match(wrongMetric.errors.join('|'), /换指标=挑口径/);
    const c = sc.loadChain(r.chainId, root);
    assert.equal(c.nodes[0].resolution, null);
  });

  it('flow 多源方向不一致 → 整体拒收，禁止挑口径', () => {
    const root = tmpRoot();
    const r = sc.registerChain(flowDef(), { root });
    const out = sc.resolveChain(r.chainId, {
      root,
      results: flowResults([
        { value: -23.17, asOf: '2026-09-20', unit: '%', metric: '全国建筑钢材成交量', basis: 'yoy', sourceUrl: 'https://a.example.com/x', sourceTier: 'B' },
        { value: 6.86, asOf: '2026-09-19', unit: '%', metric: '全国建筑钢材成交量', basis: 'yoy', sourceUrl: 'https://b.example.net/y', sourceTier: 'B' },
      ]),
    });
    assert.equal(out.ok, false);
    assert.match(out.errors.join('|'), /方向不一致/);
    const c = sc.loadChain(r.chainId, root);
    assert.equal(c.nodes[0].resolution, null);
    assert.equal(c.nodes[0].lastValueAt, null);
  });

  it('flow 同域名多条不构成交叉验证 → 拒收', () => {
    const root = tmpRoot();
    const r = sc.registerChain(flowDef(), { root });
    const out = sc.resolveChain(r.chainId, {
      root,
      results: flowResults([
        { value: -23.17, asOf: '2026-09-20', unit: '%', metric: '全国建筑钢材成交量', basis: 'yoy', sourceUrl: 'https://a.example.com/x', sourceTier: 'B' },
        { value: -10.95, asOf: '2026-09-19', unit: '%', metric: '全国建筑钢材成交量', basis: 'yoy', sourceUrl: 'https://a.example.com/y', sourceTier: 'B' },
      ]),
    });
    assert.equal(out.ok, false);
    assert.match(out.errors.join('|'), /独立来源域名不足/);
  });

  it('sourceTier 缺失/非法 → 拒收，不再默认 C', () => {
    const root = tmpRoot();
    const r = sc.registerChain(flowDef(), { root });
    const out = sc.resolveChain(r.chainId, {
      root,
      results: flowResults([
        { value: -23.17, asOf: '2026-09-20', unit: '%', metric: '全国建筑钢材成交量', basis: 'yoy', sourceUrl: 'https://a.example.com/x' },
        { value: -10.95, asOf: '2026-09-19', unit: '%', metric: '全国建筑钢材成交量', basis: 'yoy', sourceUrl: 'https://b.example.net/y', sourceTier: 'B' },
      ]),
    });
    assert.equal(out.ok, false);
    assert.match(out.errors.join('|'), /sourceTier 缺失或非法/);
    const c = sc.loadChain(r.chainId, root);
    assert.equal(c.nodes[0].resolution, null);
  });

  it('legacy 单字段形状仍兼容（schema/2 旧链节点）', () => {
    const root = tmpRoot();
    const v2 = {
      schema: 'futures-radar-story-chain/2',
      chainId: 'CH-ENERGY-20260920-01',
      createdAt: '2026-09-20',
      theme: '能化成本改善',
      themeDetail: '流动性宽松改善能化成本与需求，PTA 等待需求兑现',
      sector: 'energy_chemical',
      direction: 1,
      representative: 'TA0',
      entryProofIndex: 2,
      nodes: [
        { id: 'n1', indicatorId: 'macro.DR007.change5d', expectation: -1, label: '流动性宽松' },
        { id: 'n2', concept: 'PX 加工费相对中性水平', expectation: 1, label: 'PX 加工费高于基线', dataPlan: { paths: ['T2'], unit: '元/吨', baseline: 800, maxFreshDays: 7 } },
        { id: 'n3', indicatorId: 'symbol.TA0.price.ret5d', expectation: 1, label: 'PTA 转强' },
      ],
      edges: [
        { id: 'e1', from: 'n1', to: 'n2', latencyDays: 5, logic: '流动性宽松改善能化板块成本与需求' },
        { id: 'e2', from: 'n2', to: 'n3', latencyDays: 5, logic: '加工费走强带动 PTA 价格转强' },
      ],
    };
    const r = sc.registerChain(v2, { root });
    assert.equal(r.ok, true, JSON.stringify(r));
    const out = sc.resolveChain(r.chainId, {
      root,
      results: [{ nodeId: 'n2', value: 900, asOf: '2026-09-20', unit: '元/吨', sourceUrl: 'https://a.example.com/px', sourceTitle: 'x', sourceTier: 'A' }],
    });
    assert.equal(out.ok, true, out.errors.join(';'));
    const c = sc.loadChain(r.chainId, root);
    assert.equal(c.nodes[1].resolution.path, 'T2');
    assert.equal(c.nodes[1].resolution.sources.length, 1);
    assert.equal(c.nodes[1].resolution.kind, 'legacy');
  });
});

describe('V2.1 provisional 不参与证明/席位', () => {
  const TRADING = ['2026-09-18', '2026-09-19', '2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23'];
  function provDef(overrides = {}) {
    const def = {
      schema: 'futures-radar-story-chain/3',
      chainId: 'CH-BLACK-20260920-02',
      createdAt: '2026-09-18',
      sourceId: 'macro.SC0.change5d',
      theme: '能化成本坍塌',
      themeDetail: 'SC0 成本坍塌向能化板块传导，燃料油等待补跌确认',
      provisional: true,
      nodes: [
        { id: 'n1', indicatorId: 'macro.SC0.change5d', expectation: -1, label: '原油下跌' },
        { id: 'n2', indicatorId: 'sector.energy_chemical.index.ret5d', expectation: -1, label: '能化跟跌' },
        { id: 'n3', indicatorId: 'symbol.FU0.price.ret5d', expectation: -1, label: '燃料油补跌', terminal: true, priority: 'primary', impactRationale: '燃料油成本传导路径最短且前期跌幅滞后', proofIndex: 2 },
      ],
      edges: [
        { id: 'e1', from: 'n1', to: 'n2', latencyDays: 5, logic: '原油成本坍塌压低能化板块定价预期，板块指数转负' },
        { id: 'e2', from: 'n2', to: 'n3', latencyDays: 5, logic: '板块定价中枢下移后燃料油补跌，FU 收益为负' },
      ],
      maxLifespanTradingDays: 20,
      ...overrides,
    };
    def.reasoningCard = def.reasoningCard ?? reasoningCardFor(def);
    return def;
  }

  it('provisional 链达到 proofIndex 也保持 pending，provenAt 为 null', () => {
    const root = tmpRoot();
    const r = sc.registerChain(provDef(), { root });
    const c = sc.loadChain(r.chainId, root);
    assert.equal(c.provisional, true);
    sc.applyObservation(c, '2026-09-18', { 'macro.SC0.change5d': { value: -10, direction: -1, asOf: '2026-09-18' } }, { tradingDates: TRADING });
    sc.applyObservation(c, '2026-09-19', { 'macro.SC0.change5d': { value: -11, direction: -1, asOf: '2026-09-19' } }, { tradingDates: TRADING });
    sc.applyObservation(c, '2026-09-20', { 'sector.energy_chemical.index.ret5d': { value: -2, direction: -1, asOf: '2026-09-20' } }, { tradingDates: TRADING });
    sc.applyObservation(c, '2026-09-21', { 'sector.energy_chemical.index.ret5d': { value: -3, direction: -1, asOf: '2026-09-21' } }, { tradingDates: TRADING });
    assert.equal(c.terminals[0].status, 'pending'); // 达到证明点也不 proven
    assert.equal(c.status, 'pending');
    assert.equal(c.provenAt, null);
  });

  it('provisional 链不产生故事席位', () => {
    const chain = { chainId: 'CH-X-1', provisional: true, status: 'pending', terminals: [{ nodeId: 'n3', symbol: 'RB0', direction: -1, priority: 'primary', status: 'pending', proofIndex: 2 }] };
    assert.deepEqual(seats.storySeatEntries([chain]), []);
  });

  it('markChainProvisional 降级活跃链并同步台账与视图', () => {
    const root = tmpRoot();
    const r = sc.registerChain(provDef({ provisional: false }), { root });
    const out = sc.markChainProvisional(r.chainId, { root, reason: '前提证据不足' });
    assert.equal(out.ok, true);
    const c = sc.loadChain(r.chainId, root);
    assert.equal(c.provisional, true);
    assert.ok(c.events.some((e) => e.type === 'provisional'));
    const ledger = sc.loadLedger(root);
    assert.equal(ledger.chains.find((x) => x.chainId === r.chainId).provisional, true);
    const view = sc.buildView({ root });
    assert.equal(view.stats.provisionalChains, 1);
  });

  it('已 proven 的链不能直接降级 provisional', () => {
    const root = tmpRoot();
    const r = sc.registerChain(provDef({ provisional: false }), { root });
    const c = sc.loadChain(r.chainId, root);
    sc.applyObservation(c, '2026-09-18', {
      'macro.SC0.change5d': { value: -10, direction: -1, asOf: '2026-09-18' },
      'sector.energy_chemical.index.ret5d': { value: -2, direction: -1, asOf: '2026-09-18' },
    }, { tradingDates: TRADING });
    sc.applyObservation(c, '2026-09-19', {
      'macro.SC0.change5d': { value: -11, direction: -1, asOf: '2026-09-19' },
      'sector.energy_chemical.index.ret5d': { value: -3, direction: -1, asOf: '2026-09-19' },
    }, { tradingDates: TRADING });
    sc.applyObservation(c, '2026-09-20', {
      'macro.SC0.change5d': { value: -12, direction: -1, asOf: '2026-09-20' },
      'sector.energy_chemical.index.ret5d': { value: -4, direction: -1, asOf: '2026-09-20' },
    }, { tradingDates: TRADING });
    assert.equal(c.status, 'proven');
    sc.saveChain(c, root);
    const out = sc.markChainProvisional(r.chainId, { root });
    assert.equal(out.ok, false);
    assert.match(out.errors.join('|'), /已 proven/);
  });
});

describe('V2.1 行为/资金流链首（方向 A：让真实驱动有合法句型）', () => {
  function behaviorDef(overrides = {}) {
    const def = {
      schema: 'futures-radar-story-chain/3',
      chainId: 'CH-BLACK-20260921-BEH',
      createdAt: '2026-09-21',
      sourceId: 'sector.black.oi.flow5d',
      theme: '黑色资金流退潮',
      themeDetail: '黑色板块持仓流出推动相对强度转负，螺纹失守 MA20',
      nodes: [
        { id: 'n1', indicatorId: 'sector.black.oi.flow5d', expectation: -1, label: '黑色持仓净流出' },
        { id: 'n2', indicatorId: 'sector.black.rs5d', expectation: -1, label: '黑色相对强度转负' },
        { id: 'n3', indicatorId: 'symbol.RB0.price.vs_ma20', expectation: -1, label: '螺纹跌破 MA20', terminal: true, priority: 'primary', impactRationale: '板块资金退潮时需求最敏感的螺纹最先失守 MA20', proofIndex: 2 },
      ],
      edges: [
        { id: 'e1', from: 'n1', to: 'n2', latencyDays: 5, logic: '持仓持续流出使黑色板块失去承接，相对全市场强度转负' },
        { id: 'e2', from: 'n2', to: 'n3', latencyDays: 5, logic: '板块弱势由资金退潮主导时，资金优先撤出需求最敏感的螺纹，收盘跌破 MA20' },
      ],
      maxLifespanTradingDays: 20,
      ...overrides,
    };
    def.reasoningCard = def.reasoningCard ?? reasoningCardFor(def);
    return def;
  }

  it('sector.*.oi.flow5d 可作链首，引擎自动判定 sourceClass=behavior', () => {
    const root = tmpRoot();
    const r = sc.registerChain(behaviorDef(), { root });
    assert.equal(r.ok, true, JSON.stringify(r));
    const c = sc.loadChain(r.chainId, root);
    assert.equal(c.sourceClass, 'behavior');
    assert.equal(c.sourceId, 'sector.black.oi.flow5d');
    assert.ok(c.events[0].detail.includes('行为源'));
    const view = sc.buildView({ root });
    assert.equal(view.active[0].sourceClass, 'behavior');
  });

  it('板块收益/相对强度/品种价格仍禁止作链首', () => {
    for (const badRoot of ['sector.black.index.ret5d', 'sector.black.rs5d', 'symbol.RB0.price.vs_ma20', 'symbol.RB0.price.ret5d']) {
      const bad = behaviorDef();
      bad.chainId = 'CH-BAD-ROOT-01';
      bad.sourceId = badRoot;
      bad.nodes[0] = { id: 'n1', indicatorId: badRoot, expectation: -1, label: '坏链首' };
      const check = sc.validateChainDefinition(bad);
      assert.equal(check.ok, false, `${badRoot} 不应允许作链首`);
      assert.match(check.errors.join('|'), /必须是可作链首的源/);
    }
  });

  it('行为链并行观察与三态机同权：连续 3 数据日同向完成证明', () => {
    const root = tmpRoot();
    sc.registerChain(behaviorDef(), { root });
    const c = sc.loadChain('CH-BLACK-20260921-BEH', root);
    const TRADING = ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25'];
    for (const d of TRADING.slice(0, 3)) {
      sc.applyObservation(c, d, {
        'sector.black.oi.flow5d': { value: -1.5, direction: -1, asOf: d },
        'sector.black.rs5d': { value: -1.0, direction: -1, asOf: d },
        'symbol.RB0.price.vs_ma20': { value: -12, direction: -1, asOf: d },
      }, { tradingDates: TRADING });
    }
    assert.equal(c.nodes[0].status, 'confirmed');
    assert.equal(c.nodes[1].status, 'confirmed');
    assert.equal(c.nodes[2].status, 'confirmed');
    assert.equal(c.status, 'completed');
  });

  it('提示词包含四类链首与行为源机制纪律', () => {
    const p = pb.buildStoryChainPrompt({ signalDate: '2026-09-21', runId: 'x', macroIndicators: {}, sectors: {}, activeChains: [], catalog: { indicators: {} } });
    assert.match(p, /行为源/);
    assert.match(p, /sector\.<SECTOR>\.oi\.flow5d/);
    assert.match(p, /板块收益、相对强度与品种价格仍然禁止作链首/);
    assert.match(p, /禁止把"持仓流出\+价格下跌"直接用箭头相连/);
  });
});

describe('V2.1 存量链契约合规审计', () => {
  it('auditChainCompliance 对不符合当前契约的存量 V3 链报 FAIL', () => {
    const root = tmpRoot();
    const def = flowDef();
    delete def.nodes[0].dataPlan.kind; // 旧契约注册后逃过新校验的典型：无 kind 的单源 T2
    const r = sc.registerChain(def, { root });
    assert.equal(r.ok, false, '当前契约已禁止无 kind 注册');
    // 手工注入一条绕过新契约的存量链（模拟历史上注册成功）
    const raw = { ...def };
    raw.nodes[0].dataPlan = { paths: ['T2'], baseline: 0, unit: '%', maxFreshDays: 7, searchHints: ['Mysteel 建筑钢材成交量'] };
    const storiesDir = path.join(root, 'stories');
    fs.mkdirSync(storiesDir, { recursive: true });
    fs.writeFileSync(path.join(storiesDir, `${raw.chainId}.json`), JSON.stringify({ schema: 'futures-radar-story-chain/3', chainId: raw.chainId, definition: raw, status: 'pending', nodes: [], terminals: [], events: [] }), 'utf8');
    const ledger = sc.loadLedger(root);
    ledger.chains.push({ chainId: raw.chainId, status: 'pending', createdAt: raw.createdAt });
    sc.saveLedger(ledger, root);
    const audit = sc.auditChainCompliance(raw.chainId, { root });
    assert.equal(audit.ok, false);
    assert.match(audit.errors.join('|'), /kind/);
    assert.equal(sc.auditActiveChains({ root }).ok, false);
  });

  it('auditChainCompliance 对符合契约的新链报 PASS', () => {
    const root = tmpRoot();
    const r = sc.registerChain(flowDef(), { root });
    const audit = sc.auditChainCompliance(r.chainId, { root });
    assert.equal(audit.ok, true, audit.errors.join(';'));
    assert.equal(sc.auditActiveChains({ root }).ok, true);
  });
});

describe('V2.1 提示词（前提严谨 + T2 新契约 + V3 活跃链表）', () => {
  it('提示词包含前提严谨性自查、中性采集与 T2 新契约', () => {
    const p = pb.buildStoryChainPrompt({ signalDate: '2026-09-21', runId: 'x', macroIndicators: {}, sectors: {}, activeChains: [], catalog: { indicators: {} } });
    assert.match(p, /假设目标合法/);
    assert.match(p, /源优先，目标其次/);
    assert.match(p, /禁止用品种当日价格\/信号反过来定源/);
    assert.match(p, /前提严谨性自查/);
    assert.match(p, /禁止为了证明目标而放宽节点/);
    assert.match(p, /中性采集/);
    assert.match(p, /kind=event\|flow/);
    assert.match(p, /metric/);
    assert.match(p, /basis/);
    assert.match(p, /minSources/);
    assert.match(p, /sourceTier.*必填/);
    assert.match(p, /不默认 C/);
    assert.match(p, /检索 brief 不把 concept 当检索词/);
    assert.doesNotMatch(p, /同板块只能一条/);
  });

  it('故事链提示词注入新闻快照事实（少而精、中性摘录）', () => {
    const p = pb.buildStoryChainPrompt({
      signalDate: '2026-09-21',
      runId: 'x',
      macroIndicators: {},
      sectors: {},
      activeChains: [],
      catalog: { indicators: {} },
      newsDoc: {
        items: [
          { id: 'news-1', date: '2026-09-20', type: 'industry', sectors: ['black'], title: '成交数据发布', summary: '两个机构发布不同口径成交数据。', sources: [{ url: 'https://a.example.com', tier: 'A' }] },
        ],
      },
    });
    assert.match(p, /今日信息快照/);
    assert.match(p, /news-1/);
    assert.match(p, /两个机构发布不同口径成交数据/);
    assert.match(p, /只提供事实，不预置方向/);
  });

  it('活跃链表对 V3 DAG 链使用源与分支代表品种，不出现 undefined', () => {
    const p = pb.buildStoryChainPrompt({
      signalDate: '2026-09-21',
      runId: 'x',
      macroIndicators: {},
      sectors: {},
      activeChains: [{
        chainId: 'CH-ENERGY-20260921-01',
        sourceId: 'macro.SC0.change5d',
        status: 'pending',
        branches: [{ symbol: 'FU0', direction: -1, status: 'pending' }],
        nodes: [
          { id: 'n1', indicatorId: 'macro.SC0.change5d', status: 'pending' },
        ],
      }],
      catalog: { indicators: {} },
    });
    assert.match(p, /CH-ENERGY-20260921-01/);
    assert.match(p, /macro\.SC0\.change5d/);
    assert.match(p, /FU0/);
    assert.doesNotMatch(p, /undefined/);
  });
});

describe('V2.1 计量尺度与变化语义（引擎算，渲染只显示）', () => {
  it('目录每个指标都声明 unit/valueScale/changeKind 与 sourceClass/allowAsRoot；macro.change5d 单位修正为 %', () => {
    const cat = sc.loadCatalog();
    assert.equal(cat.schema, 'futures-radar-story-chain-indicators/4');
    const validScales = ['level', 'rate', 'sign'];
    const validChanges = ['absolute', 'percentage_points', 'relative', 'none'];
    const validSourceClasses = ['macro', 'behavior', 'transmission', 'price'];
    for (const [key, ind] of Object.entries(cat.indicators)) {
      assert.ok(ind.unit, `${key} 缺 unit`);
      assert.ok(validScales.includes(ind.valueScale), `${key} valueScale 非法: ${ind.valueScale}`);
      assert.ok(validChanges.includes(ind.changeKind), `${key} changeKind 非法: ${ind.changeKind}`);
      assert.ok(validSourceClasses.includes(ind.sourceClass), `${key} sourceClass 非法: ${ind.sourceClass}`);
      assert.equal(typeof ind.allowAsRoot, 'boolean', `${key} 缺 allowAsRoot`);
      assert.ok(ind.description && ind.description.length >= 10, `${key} 缺人类可读的 description`);
      if (key.startsWith('macro.') && key.endsWith('.change5d')) {
        assert.equal(ind.unit, '%', `${key} 公式为 (last/base-1)*100，unit 必须是 %`);
        assert.equal(ind.valueScale, 'rate');
        assert.equal(ind.changeKind, 'percentage_points');
        assert.equal(ind.sourceClass, 'macro');
        assert.equal(ind.allowAsRoot, true);
      }
    }
    // 唯一 T0 行为源：板块持仓流；板块收益/相对强度/品种价格都不允许作链首
    assert.equal(cat.indicators['sector.{sector}.oi.flow5d'].sourceClass, 'behavior');
    assert.equal(cat.indicators['sector.{sector}.oi.flow5d'].allowAsRoot, true);
    assert.equal(cat.indicators['sector.{sector}.index.ret5d'].allowAsRoot, false);
    assert.equal(cat.indicators['sector.{sector}.rs5d'].allowAsRoot, false);
    assert.equal(cat.indicators['symbol.{symbol}.price.ret5d'].allowAsRoot, false);
    assert.equal(cat.indicators['symbol.{symbol}.price.vs_ma20'].allowAsRoot, false);
  });

  it('nodeChange：rate 用百分点差，不再裸减百分比', () => {
    const chg = sc.nodeChange({ indicatorId: 'sector.energy_chemical.index.ret5d', unit: '%', lastValue: -2.3931, prevValue: -2.4666 });
    assert.equal(chg.valueScale, 'rate');
    assert.equal(chg.changeKind, 'percentage_points');
    assert.equal(chg.changeValue.toFixed(2), '0.07');
    assert.equal(chg.changeLabel, '个百分点');
  });

  it('nodeChange：level 用绝对差并带目录单位（vs_ma20 为价格点数）', () => {
    const chg = sc.nodeChange({ indicatorId: 'symbol.RB0.price.vs_ma20', unit: 'sign(+1 上方 / -1 下方)', lastValue: -12.35, prevValue: -30.8 });
    assert.equal(chg.valueScale, 'level');
    assert.equal(chg.changeKind, 'absolute');
    assert.equal(chg.changeValue.toFixed(2), '18.45');
    assert.equal(chg.changeLabel, '价格点数');
  });

  it('nodeChange：sign 尺度显示维持/翻转，不做减法', () => {
    const flip = sc.nodeChange({ dataPlan: { unit: 'sign' }, lastValue: 1, prevValue: -1 });
    assert.equal(flip.changeText, '翻转');
    assert.equal(flip.changeValue, null);
    const same = sc.nodeChange({ dataPlan: { unit: 'sign' }, lastValue: -1, prevValue: -1 });
    assert.equal(same.changeText, '维持');
  });

  it('nodeChange：T2 单快照没有时间前值，不伪造变化量', () => {
    const chg = sc.nodeChange({
      indicatorId: 'T2.CH-X.n1', resolution: { path: 'T2' },
      dataPlan: { unit: '%' }, lastValue: -23.17, prevValue: -23.17,
      lastValueAt: '2026-09-20', prevValueAt: '2026-09-20',
    });
    assert.equal(chg.changeValue, null);
    assert.equal(chg.changeText, null);
  });

  it('buildView 投影 changeValue/changeLabel，T0 unit 以目录为准', () => {
    const root = tmpRoot();
    const def = {
      schema: 'futures-radar-story-chain/3',
      chainId: 'CH-ENERGY-20260920-02',
      createdAt: '2026-09-18',
      sourceId: 'macro.SC0.change5d',
      theme: '能化成本坍塌',
      themeDetail: 'SC0 成本坍塌向能化板块传导，燃料油等待补跌确认',
      nodes: [
        { id: 'n1', indicatorId: 'macro.SC0.change5d', expectation: -1, label: '原油下跌' },
        { id: 'n2', indicatorId: 'sector.energy_chemical.index.ret5d', expectation: -1, label: '能化跟跌' },
        { id: 'n3', indicatorId: 'symbol.RB0.price.vs_ma20', expectation: -1, label: '螺纹破位', terminal: true, priority: 'primary', impactRationale: '螺纹需求敏感且率先跌破 MA20', proofIndex: 2 },
      ],
      edges: [
        { id: 'e1', from: 'n1', to: 'n2', latencyDays: 5, logic: '原油成本坍塌压低能化板块定价预期，板块指数转负' },
        { id: 'e2', from: 'n2', to: 'n3', latencyDays: 5, logic: '板块弱势传导至螺纹，收盘跌破 MA20' },
      ],
      maxLifespanTradingDays: 20,
      reasoningCard: {
        schema: 'futures-radar-story-reasoning-card/1',
        claim: { source: 'macro.SC0.change5d', direction: -1, path: ['n1', 'n2', 'n3'] },
        mechanisms: [
          { edgeId: 'e1', why: '原油成本坍塌压低能化板块定价预期，板块指数转负' },
          { edgeId: 'e2', why: '板块弱势传导至螺纹，收盘跌破 MA20' },
        ],
        evidenceRefs: { news: [], indicators: ['macro.SC0.change5d', 'sector.energy_chemical.index.ret5d', 'symbol.RB0.price.vs_ma20'] },
        assumptions: ['成本传导路径成立'],
        uncertainties: ['下游兑现时滞'],
        falsifiers: ['源节点连续两日反向'],
      },
    };
    sc.registerChain(def, { root });
    const c = sc.loadChain(def.chainId, root);
    sc.applyObservation(c, '2026-09-21', {
      'macro.SC0.change5d': { value: -20.14, prevValue: -10.44, prevAt: '2026-09-18', direction: -1, asOf: '2026-09-21' },
      'sector.energy_chemical.index.ret5d': { value: -2.39, prevValue: -2.47, prevAt: '2026-09-18', direction: -1, asOf: '2026-09-21' },
      'symbol.RB0.price.vs_ma20': { value: -12.35, prevValue: -30.8, prevAt: '2026-09-18', direction: -1, asOf: '2026-09-21' },
    }, { tradingDates: ['2026-09-18', '2026-09-21'] });
    sc.saveChain(c, root);
    const view = sc.buildView({ root });
    assert.equal(view.schema, 'futures-radar-story-pool-view/2');
    const nodes = view.active[0].nodes;
    assert.equal(nodes[0].caliber.kind, 'catalog');
    assert.equal(nodes[0].caliber.name, 'SC0 原油 5 交易日涨跌');
    assert.match(nodes[0].caliber.description, /原油在上涨/);
    assert.equal(nodes[1].caliber.name, '板块指数 5 交易日收益');
    assert.match(nodes[2].caliber.description, /收盘在均线上方/);
    assert.equal(nodes[1].changeLabel, '个百分点');
    assert.equal(Number(nodes[1].changeValue).toFixed(2), '0.08');
    assert.equal(nodes[1].unit, '%');
    assert.equal(nodes[2].unit, '价格点数'); // 目录覆盖旧 sign 标签
    assert.equal(nodes[2].changeLabel, '价格点数');
    assert.equal(Number(nodes[2].changeValue).toFixed(2), '18.45');
  });

  it('渲染器不再现场对 prev/current 做减法，也不再出现"环比"', () => {
    const src = fs.readFileSync(path.join(ROOT, 'output', 'render-story-pool-html.cjs'), 'utf8');
    assert.doesNotMatch(src, /Number\(n\.lastValue\)\s*-\s*Number\(n\.prevValue\)/);
    assert.doesNotMatch(src, /Number\(cur\)\s*-\s*Number\(prev\)/);
    assert.doesNotMatch(src, /环比/);
    assert.match(src, /changeTextHtml/);
    assert.match(src, /changeValue/);
  });
});

describe('V2.1 并行观察与节点三态（观察中/已证明/已证伪）', () => {
  const TRADING = ['2026-09-18', '2026-09-19', '2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23'];

  function fuDef() {
    const def = {
      schema: 'futures-radar-story-chain/3',
      chainId: 'CH-ENERGY-20260920-03',
      createdAt: '2026-09-21',
      sourceId: 'macro.SC0.change5d',
      theme: '能化成本坍塌',
      themeDetail: 'SC0 成本坍塌向能化板块传导，燃料油等待补跌确认',
      nodes: [
        { id: 'n1', indicatorId: 'macro.SC0.change5d', expectation: -1, label: '原油下跌' },
        { id: 'n2', indicatorId: 'sector.energy_chemical.index.ret5d', expectation: -1, label: '能化跟跌' },
        { id: 'n3', indicatorId: 'symbol.FU0.price.ret5d', expectation: -1, label: '燃料油补跌', terminal: true, priority: 'primary', impactRationale: '燃料油成本传导路径最短且前期跌幅滞后', proofIndex: 2 },
      ],
      edges: [
        { id: 'e1', from: 'n1', to: 'n2', latencyDays: 3, logic: '原油成本坍塌压低能化板块定价预期，板块指数转负' },
        { id: 'e2', from: 'n2', to: 'n3', latencyDays: 5, logic: '板块定价中枢下移后燃料油补跌，FU 收益为负' },
      ],
      maxLifespanTradingDays: 20,
    };
    def.reasoningCard = reasoningCardFor(def);
    return def;
  }

  const SAME = {
    'macro.SC0.change5d': -20.14,
    'sector.energy_chemical.index.ret5d': -2.39,
    'symbol.FU0.price.ret5d': -4.08,
  };

  function observeSame(c, date, delta = 0) {
    const values = {};
    for (const [id, base] of Object.entries(SAME)) values[id] = { value: base + delta, direction: base + delta > 0 ? 1 : -1, asOf: date };
    return sc.applyObservation(c, date, values, { tradingDates: TRADING });
  }

  it('第一天三个节点同向：全部同向 1/3，各自窗口自注册日开启，无当前节点', () => {
    const root = tmpRoot();
    const r = sc.registerChain(fuDef(), { root });
    const c = sc.loadChain(r.chainId, root);
    observeSame(c, '2026-09-21');
    assert.equal(c.nodes[0].sameStreak, 1);
    assert.equal(c.nodes[1].sameStreak, 1);
    assert.equal(c.nodes[2].sameStreak, 1);
    assert.equal(c.nodes[0].status, 'pending');
    assert.equal(c.nodes[1].status, 'pending');
    assert.equal(c.nodes[2].status, 'pending');
    for (const n of c.nodes) assert.equal(n.windowStartDate, '2026-09-21');
    assert.equal(c.status, 'pending');
  });

  it('连续 3 个交易日同向：全部节点证明，链 completed', () => {
    const root = tmpRoot();
    sc.registerChain(fuDef(), { root });
    const c = sc.loadChain('CH-ENERGY-20260920-03', root);
    observeSame(c, '2026-09-21');
    observeSame(c, '2026-09-22');
    observeSame(c, '2026-09-23');
    assert.equal(c.nodes[0].status, 'confirmed');
    assert.equal(c.nodes[1].status, 'confirmed');
    assert.equal(c.nodes[2].status, 'confirmed');
    assert.equal(c.status, 'completed');
    assert.equal(c.closeReason, 'completed');
  });

  it('节点反向独立计数：连续 2 个反向日即证伪，不等待其他节点', () => {
    const root = tmpRoot();
    sc.registerChain(fuDef(), { root });
    const c = sc.loadChain('CH-ENERGY-20260920-03', root);
    observeSame(c, '2026-09-21');
    // 第二天只有 n3 反向，其余仍同向
    const values = { ...SAME };
    values['symbol.FU0.price.ret5d'] = 1.0;
    sc.applyObservation(c, '2026-09-22', {
      'macro.SC0.change5d': { value: -20.14, direction: -1, asOf: '2026-09-22' },
      'sector.energy_chemical.index.ret5d': { value: -2.39, direction: -1, asOf: '2026-09-22' },
      'symbol.FU0.price.ret5d': { value: 1.0, direction: 1, asOf: '2026-09-22' },
    }, { tradingDates: TRADING });
    assert.equal(c.nodes[2].oppStreak, 1);
    assert.equal(c.nodes[2].status, 'pending');
    sc.applyObservation(c, '2026-09-23', {
      'macro.SC0.change5d': { value: -20.14, direction: -1, asOf: '2026-09-23' },
      'sector.energy_chemical.index.ret5d': { value: -2.39, direction: -1, asOf: '2026-09-23' },
      'symbol.FU0.price.ret5d': { value: 1.0, direction: 1, asOf: '2026-09-23' },
    }, { tradingDates: TRADING });
    assert.equal(c.nodes[2].status, 'broken');
    assert.equal(c.nodes[2].brokenReason, 'opposite_direction');
    assert.equal(c.status, 'falsified');
  });

  it('buildView 投影 sameStreak/oppStreak，且不再有 activeNode/alignment', () => {
    const root = tmpRoot();
    sc.registerChain(fuDef(), { root });
    const c = sc.loadChain('CH-ENERGY-20260920-03', root);
    observeSame(c, '2026-09-21');
    sc.saveChain(c, root);
    const view = sc.buildView({ root });
    assert.equal(view.active[0].nodes[0].sameStreak, 1);
    assert.equal(view.active[0].nodes[1].sameStreak, 1);
    assert.equal(view.active[0].nodes[2].sameStreak, 1);
    assert.equal('activeNode' in view.active[0], false);
    assert.equal('alignment' in view.active[0].nodes[0], false);
  });

  it('渲染器三态文案为 观察中/已证明/已证伪，无三角与当前节点概念', () => {
    const src = fs.readFileSync(path.join(ROOT, 'output', 'render-story-pool-html.cjs'), 'utf8');
    assert.match(src, /已证明/);
    assert.match(src, /已证伪/);
    assert.match(src, /观察中/);
    assert.match(src, /nodeProgressLabel/);
    assert.match(src, /dg-node-caliber/);
    assert.match(src, /showCaliberDetail/);
    assert.match(src, /指标口径/);
    assert.match(src, /指标是什么/);
    assert.match(src, /caliber-what/);
    assert.match(src, /caliber-node/);
    assert.match(src, /closest\('\.dg-node-caliber'\)/);
    assert.match(src, /classList\.remove\('wide'\)/);
    assert.match(src, /class="dg-detail sg-detail"/);
    assert.match(src, /t\.closest\('\.dg-detail'\)/);
    // 交互必须走单一全局点击路由：口径浮层只认口径按钮+浮层内部，
    // 节点浮层只认节点+浮层内部，点页面其他任何位置都关闭。
    assert.match(src, /document\.addEventListener\('click'/);
    assert.match(src, /data-detail-mode/);
    assert.doesNotMatch(src, /el\.addEventListener\('click'/);
    // 浮层支持按住拖动：鼠标在浮层内按下并移动时拖动，拖动后的 click 不关闭浮层。
    assert.match(src, /beginDetailDrag/);
    assert.match(src, /document\.addEventListener\('mousedown'/);
    assert.match(src, /sg-dragging/);
    assert.match(src, /suppressDragClickUntil/);
    // 拖动时冻结宽度（防止 left 超出包含块触发 shrink-to-fit 变窄），并阻止文字选中。
    assert.match(src, /d\.style\.width = dRect\.width/);
    assert.match(src, /d\.style\.width = ''/);
    assert.match(src, /ev\.preventDefault\(\)/);
    assert.match(src, /getSelection\(\)\.removeAllRanges/);
    assert.doesNotMatch(src, /className = 'sg-detail/);
    assert.doesNotMatch(src, /alignmentMarkerHtml/);
    assert.doesNotMatch(src, /node-align-marker/);
    assert.doesNotMatch(src, /dg-stack/);
    assert.doesNotMatch(src, /activeNode/);
    assert.doesNotMatch(src, /isCurrent/);
  });
});
