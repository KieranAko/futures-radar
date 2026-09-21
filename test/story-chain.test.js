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

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'story-chain-'));
}

function baseDef(overrides = {}) {
  return {
    schema: 'futures-radar-story-chain/1',
    chainId: 'CH-TEST-20260901-01',
    createdAt: '2026-09-01',
    sector: 'black',
    direction: 1,
    representative: 'RB0',
    entryProofIndex: 2,
    theoryRef: '02-term-structure.md 流动性传导',
    nodes: [
      { id: 'n1', indicatorId: 'macro.DR007.change5d', expectation: -1, label: '流动性宽松' },
      { id: 'n2', indicatorId: 'sector.black.oi.flow5d', expectation: 1, label: '黑色资金流入' },
      { id: 'n3', indicatorId: 'symbol.RB0.price.ret5d', expectation: 1, label: '螺纹趋势确认' },
    ],
    edges: [
      { id: 'e1', from: 'n1', to: 'n2', latencyDays: 5, logic: '流动性宽松→黑色系需求敏感品种资金流入' },
      { id: 'e2', from: 'n2', to: 'n3', latencyDays: 5, logic: '板块资金流→代表品种趋势展开' },
    ],
    ...overrides,
  };
}

const TRADING = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-12', '2026-09-15', '2026-09-16'];

describe('story-chain 传导链构造器核心', () => {
  it('合法链通过校验：≥2 节点、线性边、指标目录、板块与代表品种一致', () => {
    const r = sc.validateChainDefinition(baseDef());
    assert.equal(r.ok, true, r.errors.join(';'));
  });

  it('拒绝结构非法链：单节点/无证明点/指标不在目录/品种与板块不符/非顺序边', () => {
    const noNodes = sc.validateChainDefinition(baseDef({ nodes: [], edges: [] }));
    assert.match(noNodes.errors.join('|'), /至少需要 2 个节点/);
    const badP = sc.validateChainDefinition(baseDef({ entryProofIndex: 3 }));
    assert.match(badP.errors.join('|'), /entryProofIndex/);
    const badInd = baseDef();
    badInd.nodes[1].indicatorId = 'sector.black.not.exist';
    assert.match(sc.validateChainDefinition(badInd).errors.join('|'), /不在目录/);
    const badSym = sc.validateChainDefinition(baseDef({ representative: 'AU0' }));
    assert.match(badSym.errors.join('|'), /不属于板块 black/);
    const badEdge = baseDef();
    badEdge.edges[0].from = 'n2';
    assert.match(sc.validateChainDefinition(badEdge).errors.join('|'), /必须连接/);
    const badLatency = baseDef();
    badLatency.edges[0].latencyDays = 99;
    assert.match(sc.validateChainDefinition(badLatency).errors.join('|'), /latencyDays/);
  });

  it('注册入池；同板块一条活跃链；--supersede 换代并保留旧链历史', () => {
    const root = tmpRoot();
    const r1 = sc.registerChain(baseDef(), { root });
    assert.equal(r1.ok, true);
    const dup = sc.registerChain(baseDef(), { root });
    assert.equal(dup.ok, false);
    assert.equal(dup.phase, 'duplicate_id');
    const occupied = sc.registerChain(baseDef({ chainId: 'CH-TEST-20260902-02', createdAt: '2026-09-02' }), { root });
    assert.equal(occupied.phase, 'sector_occupied');
    const r2 = sc.registerChain(baseDef({ chainId: 'CH-TEST-20260902-02', createdAt: '2026-09-02' }), { root, supersede: true });
    assert.equal(r2.ok, true);
    assert.equal(r2.superseded, r1.chainId);
    const old = sc.loadChain(r1.chainId, root);
    assert.equal(old.status, 'superseded');
    assert.equal(old.closeReason, 'superseded');
    const ledger = sc.loadLedger(root);
    assert.equal(ledger.chains.filter((c) => sc.isActive(c.status)).length, 1);
  });

  it('状态机并行证明：所有节点独立计数，连续 3 个数据日同向证明，p=2 达标 proven，全部证明 completed', () => {
    const root = tmpRoot();
    const chain = sc.registerChain(baseDef(), { root }).chainId;
    const c = sc.loadChain(chain, root);
    const v1 = {
      'macro.DR007.change5d': { value: -5, direction: -1, asOf: '2026-09-02' },
      'sector.black.oi.flow5d': { value: 3, direction: 1, asOf: '2026-09-02' },
    };
    const r1 = sc.applyObservation(c, '2026-09-02', v1, { tradingDates: TRADING });
    assert.equal(c.status, 'pending'); // 单日同向不证明
    assert.ok(r1.events.some((e) => e.type === 'observing'));
    assert.equal(c.nodes[0].sameStreak, 1);
    assert.equal(c.nodes[1].sameStreak, 1); // 并行：下游同日计数
    sc.applyObservation(c, '2026-09-03', {
      'macro.DR007.change5d': { value: -6, direction: -1, asOf: '2026-09-03' },
      'sector.black.oi.flow5d': { value: 3, direction: 1, asOf: '2026-09-03' },
    }, { tradingDates: TRADING });
    const rp = sc.applyObservation(c, '2026-09-04', {
      'macro.DR007.change5d': { value: -7, direction: -1, asOf: '2026-09-04' },
      'sector.black.oi.flow5d': { value: 3, direction: 1, asOf: '2026-09-04' },
    }, { tradingDates: TRADING });
    assert.equal(c.nodes[0].status, 'confirmed');
    assert.equal(c.nodes[1].status, 'confirmed');
    assert.equal(rp.chain.status, 'proven');
    assert.equal(rp.chain.provenAt, '2026-09-04');
    // 终节点连续 3 日同向 → completed
    sc.applyObservation(c, '2026-09-05', { 'symbol.RB0.price.ret5d': { value: 4, direction: 1, asOf: '2026-09-05' } }, { tradingDates: TRADING });
    sc.applyObservation(c, '2026-09-08', { 'symbol.RB0.price.ret5d': { value: 4, direction: 1, asOf: '2026-09-08' } }, { tradingDates: TRADING });
    sc.applyObservation(c, '2026-09-09', { 'symbol.RB0.price.ret5d': { value: 4, direction: 1, asOf: '2026-09-09' } }, { tradingDates: TRADING });
    assert.equal(c.status, 'completed');
    assert.equal(c.closeReason, 'completed');
  });

  it('并行证伪：下游节点不等上游，独立反向计数，连续 2 日反向即 falsified', () => {
    const root = tmpRoot();
    const chain = sc.registerChain(baseDef(), { root }).chainId;
    const c = sc.loadChain(chain, root);
    // 同一天 n2 反向：并行模式下 n2 立即反向 1/2，不再被上游门挡住
    const r = sc.applyObservation(c, '2026-09-02', {
      'macro.DR007.change5d': null,
      'sector.black.oi.flow5d': { value: -3, direction: -1 },
    }, { tradingDates: TRADING });
    assert.equal(c.nodes[1].status, 'pending');
    assert.equal(c.nodes[1].oppStreak, 1);
    // n1/n2 第二天都反向 → 证伪
    const r2 = sc.applyObservation(c, '2026-09-03', {
      'macro.DR007.change5d': { value: 5, direction: 1, asOf: '2026-09-03' },
      'sector.black.oi.flow5d': { value: -3, direction: -1, asOf: '2026-09-03' },
    }, { tradingDates: TRADING });
    assert.equal(c.status, 'falsified');
    assert.equal(c.nodes[1].brokenReason, 'opposite_direction');
    assert.equal(c.nodes[0].status, 'pending'); // n1 只反向 1/2，链已因 n2 独立证伪
    assert.ok(r2.events.some((e) => e.type === 'falsified'));
  });

  it('窗口超时证伪：latencyDays 按交易日计数', () => {
    const root = tmpRoot();
    const chain = sc.registerChain(baseDef(), { root }).chainId;
    const c = sc.loadChain(chain, root);
    // 09-01 起，latency 5：09-09 时已过 6 个交易日（02,03,04,05,08,09）
    sc.applyObservation(c, '2026-09-09', {}, { tradingDates: TRADING });
    assert.equal(c.status, 'falsified');
    assert.equal(c.nodes[0].brokenReason, 'timeout');
  });

  it('流速异常只告警不判死链', () => {
    const root = tmpRoot();
    const chain = sc.registerChain(baseDef(), { root }).chainId;
    const c = sc.loadChain(chain, root);
    const r = sc.applyObservation(c, '2026-09-02', {
      'sector.black.oi.flow5d': { value: 5, direction: 1, speedZ: 2.8 },
    }, { tradingDates: TRADING });
    assert.equal(c.status, 'pending');
    assert.ok(r.events.some((e) => e.type === 'speed_anomaly'));
  });

  it('链级寿命到期：超过 maxLifespanTradingDays 未完成 → expired', () => {
    const root = tmpRoot();
    const chain = sc.registerChain(baseDef({ maxLifespanTradingDays: 5 }), { root }).chainId;
    const c = sc.loadChain(chain, root);
    const r = sc.applyObservation(c, '2026-09-10', {}, { tradingDates: TRADING });
    assert.equal(c.status, 'expired');
    assert.ok(r.events.some((e) => e.type === 'expired'));
  });

  it('observeAll 更新台账与视图统计（节点命中率）', () => {
    const root = tmpRoot();
    sc.registerChain(baseDef(), { root });
    const obs = (d, v) => sc.observeAll(d, v, { root, tradingDates: TRADING });
    obs('2026-09-02', {
      'macro.DR007.change5d': { value: -5, direction: -1, asOf: '2026-09-02' },
      'sector.black.oi.flow5d': { value: 3, direction: 1, asOf: '2026-09-02' },
    });
    obs('2026-09-03', {
      'macro.DR007.change5d': { value: -6, direction: -1, asOf: '2026-09-03' },
      'sector.black.oi.flow5d': { value: 3, direction: 1, asOf: '2026-09-03' },
    });
    obs('2026-09-04', {
      'macro.DR007.change5d': { value: -7, direction: -1, asOf: '2026-09-04' },
      'sector.black.oi.flow5d': { value: 3, direction: 1, asOf: '2026-09-04' },
    });
    const view = sc.buildView({ root });
    assert.equal(view.stats.totalChains, 1);
    assert.equal(view.stats.provenChains, 1);
    assert.ok(view.active[0].chainId);
  });
});

describe('story-chain 提示词构建器（状态唤醒 + 硬契约）', () => {
  const pb = require(path.join(ROOT, 'stories', 'lib', 'story-chain-prompt.cjs'));
  it('提示词唤醒宏观传导知识状态，且不指定理论流派', () => {
    const p = pb.buildStoryChainPrompt({
      signalDate: '2026-09-18', runId: 'x', macroIndicators: {}, sectors: {}, activeChains: [], catalog: { indicators: {} },
    });
    assert.match(p, /传导链分析/);
    assert.match(p, /宏观经济学/);
    assert.match(p, /资金流动与板块轮动/);
    assert.match(p, /不限定理论流派/);
    assert.match(p, /不要预测价格/);
  });
  it('提示词包含当日数据上下文、指标目录与输出硬约束', () => {
    const p = pb.buildStoryChainPrompt({
      signalDate: '2026-09-18',
      runId: 'x',
      macroIndicators: { DR007: { value: 1.4, change5d: 2.8, status: 'fresh' } },
      sectors: { black: { sector: 'black', direction: 'down', ret5d: -2.4, ret20d: -0.2, advanceRatio5d: 0, leaderSymbol: 'J0', leaderRet5d: -4.3 } },
      activeChains: [],
      catalog: { indicators: { 'macro.DR007.change5d': { name: 'DR007 5 日变化', unit: 'bp' } } },
    });
    assert.match(p, /\| DR007 \| 1\.40 \| 2\.80 \| fresh \|/);
    assert.match(p, /macro\.DR007\.change5d/);
    assert.match(p, /节点 ≥3/);
    assert.match(p, /entryProofIndex/);
    assert.match(p, /story-chains\.json/);
  });
});

describe('story-chain v2：T2 找数据策略与可信度', () => {
  function v2Def(overrides = {}) {
    return {
      schema: 'futures-radar-story-chain/2',
      chainId: 'CH-ENERGY-20260902-01',
      createdAt: '2026-09-02',
      theme: '能化成本改善',
      themeDetail: '流动性宽松改善能化成本与需求，PTA 等待需求兑现',
      sector: 'energy_chemical',
      direction: 1,
      representative: 'TA0',
      entryProofIndex: 2,
      nodes: [
        { id: 'n1', indicatorId: 'macro.DR007.change5d', expectation: -1, label: '流动性宽松' },
        {
          id: 'n2', concept: 'PX 加工费相对中性水平', expectation: 1, label: 'PX 加工费高于基线',
          dataPlan: { paths: ['T2'], unit: '元/吨', baseline: 800, searchHints: ['PX 加工费'], maxFreshDays: 7 },
        },
        { id: 'n3', indicatorId: 'symbol.TA0.price.ret5d', expectation: 1, label: 'PTA 转强' },
      ],
      edges: [
        { id: 'e1', from: 'n1', to: 'n2', latencyDays: 5, logic: '流动性宽松→能化板块成本与需求改善' },
        { id: 'e2', from: 'n2', to: 'n3', latencyDays: 5, logic: '加工费走强→PTA 价格转强' },
      ],
      ...overrides,
    };
  }

  it('T2 节点链注册进入 resolving（证明点冻结），占住板块', () => {
    const root = tmpRoot();
    const r = sc.registerChain(v2Def(), { root });
    assert.equal(r.ok, true);
    assert.equal(r.status, 'resolving');
    assert.equal(r.unresolved, 1);
    const c = sc.loadChain(r.chainId, root);
    assert.equal(c.nodes[0].resolution.path, 'T0');
    assert.equal(c.nodes[1].resolution, null);
    const occupied = sc.registerChain(v2Def({ chainId: 'CH-ENERGY-20260903-02', createdAt: '2026-09-03' }), { root });
    assert.equal(occupied.phase, 'sector_occupied'); // resolving 也占板块
  });

  it('v2 链必须有主标题与副标题，且不得用箭头拼接', () => {
    const noTheme = v2Def();
    delete noTheme.theme;
    assert.match(sc.validateChainDefinition(noTheme).errors.join('|'), /theme/);
    const noDetail = v2Def();
    delete noDetail.themeDetail;
    assert.match(sc.validateChainDefinition(noDetail).errors.join('|'), /themeDetail/);
    const arrowTheme = v2Def({ theme: '流动性宽松→能化改善' });
    assert.match(sc.validateChainDefinition(arrowTheme).errors.join('|'), /theme 不得使用箭头/);
    const arrowDetail = v2Def({ themeDetail: '流动性宽松→能化改善→PTA 转强' });
    assert.match(sc.validateChainDefinition(arrowDetail).errors.join('|'), /themeDetail 不得使用箭头/);
  });

  it('T2 节点缺 baseline/unit 或只有 T1 路径被拒收', () => {
    const noBaseline = v2Def();
    delete noBaseline.nodes[1].dataPlan.baseline;
    assert.match(sc.validateChainDefinition(noBaseline).errors.join('|'), /baseline/);
    const t1Only = v2Def();
    t1Only.nodes[1].dataPlan.paths = ['T1'];
    assert.match(sc.validateChainDefinition(t1Only).errors.join('|'), /T2 兜底/);
  });

  it('resolve 检索结果入库：resolving → pending；T2 节点按 baseline 判定方向并标注可信度', () => {
    const root = tmpRoot();
    const r = sc.registerChain(v2Def(), { root });
    const brief = sc.generateResolveBrief(r.chainId, { root });
    assert.equal(brief.ok, true);
    const resolved = sc.resolveChain(r.chainId, {
      root,
      results: [{ nodeId: 'n2', value: 900, asOf: '2026-09-02', unit: '元/吨', sourceUrl: 'https://example.com/px', sourceTitle: 'x', sourceTier: 'A' }],
    });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.status, 'pending');
    const c = sc.loadChain(r.chainId, root);
    assert.equal(c.nodes[1].resolution.path, 'T2');
    assert.equal(c.nodes[1].indicatorId, `T2.${r.chainId}.n2`);
    // 并行观察：n1 首日 1/3，同时 T2 事件快照一次即证明，可信度 medium（单独立源 A 且 fresh）
    sc.applyObservation(c, '2026-09-03', { 'macro.DR007.change5d': { value: -3, direction: -1, asOf: '2026-09-03' } }, { tradingDates: TRADING });
    assert.equal(c.status, 'pending'); // p=2：仅 n2 证明还不够
    assert.equal(c.nodes[1].status, 'confirmed');
    assert.equal(c.nodes[1].credibility, 'medium');
    sc.applyObservation(c, '2026-09-04', { 'macro.DR007.change5d': { value: -4, direction: -1, asOf: '2026-09-04' } }, { tradingDates: TRADING });
    sc.applyObservation(c, '2026-09-05', { 'macro.DR007.change5d': { value: -5, direction: -1, asOf: '2026-09-05' } }, { tradingDates: TRADING });
    assert.equal(c.nodes[0].status, 'confirmed');
    assert.equal(c.status, 'proven');
  });

  it('T2 数据过期 → 不产生观测，按超时证伪', () => {
    const root = tmpRoot();
    const r = sc.registerChain(v2Def(), { root });
    sc.resolveChain(r.chainId, {
      root,
      results: [{ nodeId: 'n2', value: 900, asOf: '2026-09-01', unit: '元/吨', sourceUrl: 'https://example.com/px', sourceTitle: 'x', sourceTier: 'A' }],
    });
    const c = sc.loadChain(r.chainId, root);
    // 所有节点自注册日（09-02）并行开窗；n2 快照过期，窗口 latency 5，09-10 超时证伪
    sc.applyObservation(c, '2026-09-10', {}, { tradingDates: TRADING });
    assert.equal(c.nodes[1].status, 'broken');
    assert.equal(c.nodes[1].brokenReason, 'timeout');
    assert.equal(c.status, 'falsified');
  });

  it('检索失败可作废（void），不再占板块', () => {
    const root = tmpRoot();
    const r = sc.registerChain(v2Def(), { root });
    const out = sc.resolveChain(r.chainId, { root, voidReason: 'T2 检索无来源' });
    assert.equal(out.status, 'void');
    const c = sc.loadChain(r.chainId, root);
    assert.equal(c.closeReason, 'void');
    const again = sc.registerChain(v2Def({ chainId: 'CH-ENERGY-20260903-02', createdAt: '2026-09-03' }), { root });
    assert.equal(again.ok, true); // void 后板块空出
  });

  it('视图统计包含路径命中率与可信度分布', () => {
    const root = tmpRoot();
    const r = sc.registerChain(v2Def(), { root });
    sc.resolveChain(r.chainId, {
      root,
      results: [{ nodeId: 'n2', value: 900, asOf: '2026-09-02', unit: '元/吨', sourceUrl: 'https://example.com/px', sourceTitle: 'x', sourceTier: 'A' }],
    });
    const c = sc.loadChain(r.chainId, root);
    sc.applyObservation(c, '2026-09-03', { 'macro.DR007.change5d': { value: -3, direction: -1, asOf: '2026-09-03' } }, { tradingDates: TRADING });
    sc.applyObservation(c, '2026-09-04', { 'macro.DR007.change5d': { value: -4, direction: -1, asOf: '2026-09-04' } }, { tradingDates: TRADING });
    sc.applyObservation(c, '2026-09-05', { 'macro.DR007.change5d': { value: -5, direction: -1, asOf: '2026-09-05' } }, { tradingDates: TRADING });
    sc.saveChain(c, root);
    const view = sc.buildView({ root });
    assert.equal(view.stats.nodeHitRateByPath.T2.confirmed, 1); // 并行模式下 T2 首日即证明
    assert.ok('confirmedCredibility' in view.stats);
    assert.equal(view.stats.totalChains, 1);
  });
});

describe('story-chain /3：DAG 扇出与汇合、terminal 分支', () => {
  function v3Def(overrides = {}) {
    const def = {
      schema: 'futures-radar-story-chain/3',
      chainId: 'CH-SC0-20260918-01',
      createdAt: '2026-09-18',
      sourceId: 'macro.SC0.change5d',
      theme: '原油坍塌的能化传导',
      themeDetail: 'SC0 成本坍塌向能化传导，燃料油与 LPG 补跌空间分化',
      nodes: [
        { id: 'n1', indicatorId: 'macro.SC0.change5d', expectation: -1, label: '原油下跌' },
        { id: 'n2', indicatorId: 'sector.energy_chemical.oi.flow5d', expectation: -1, label: '能化资金流出' },
        { id: 'n5', indicatorId: 'sector.energy_chemical.index.ret5d', expectation: -1, label: '能化指数走弱' },
        { id: 'n3', indicatorId: 'symbol.FU0.price.ret5d', expectation: -1, label: '燃料油补跌', terminal: true, priority: 'primary', impactRationale: '燃料油对 SC0 成本弹性最大，且前期跌幅滞后，补跌空间最大', proofIndex: 2 },
        { id: 'n4', indicatorId: 'symbol.PG0.price.ret5d', expectation: -1, label: 'LPG 下行', terminal: true, priority: 'secondary', impactRationale: 'LPG 成本支撑直接下移，但弹性弱于燃料油', proofIndex: 2 },
      ],
      edges: [
        { id: 'e1', from: 'n1', to: 'n2', latencyDays: 5, logic: '原油下跌→能化资金流出' },
        { id: 'e2', from: 'n2', to: 'n3', latencyDays: 5, logic: '能化资金流出→燃料油补跌' },
        { id: 'e3', from: 'n1', to: 'n5', latencyDays: 3, logic: '原油下跌→能化指数走弱' },
        { id: 'e4', from: 'n5', to: 'n4', latencyDays: 7, logic: '能化指数走弱→LPG 成本支撑下移' },
        { id: 'e5', from: 'n5', to: 'n3', latencyDays: 3, logic: '能化指数走弱→燃料油补跌（汇合）' },
      ],
      maxLifespanTradingDays: 20,
      ...overrides,
    };
    def.reasoningCard = {
      schema: 'futures-radar-story-reasoning-card/1',
      claim: { source: 'macro.SC0.change5d', direction: -1, path: ['n1', 'n2', 'n3'] },
      mechanisms: def.edges.map((e) => ({ edgeId: e.id, why: e.logic })),
      evidenceRefs: { news: [], indicators: def.nodes.map((n) => n.indicatorId).filter(Boolean) },
      assumptions: ['原油是能化板块定价锚'],
      uncertainties: ['LPG 分支弹性弱于燃料油'],
      falsifiers: ['源节点连续两日反向'],
    };
    return def;
  }

  it('合法 DAG 链通过校验并注册（一源一链）', () => {
    const root = tmpRoot();
    const r = sc.registerChain(v3Def(), { root });
    assert.equal(r.ok, true);
    assert.equal(r.status, 'pending');
    const c = sc.loadChain(r.chainId, root);
    assert.equal(c.schema, 'futures-radar-story-chain/3');
    assert.equal(c.sourceId, 'macro.SC0.change5d');
    assert.equal(c.terminals.length, 2);
    assert.equal(c.terminals[0].priority, 'primary');
  });

  it('同 sourceId 重复注册被拒；supersede 换代旧链', () => {
    const root = tmpRoot();
    sc.registerChain(v3Def(), { root });
    const dup = sc.registerChain(v3Def({ chainId: 'CH-SC0-20260918-02' }), { root });
    assert.equal(dup.phase, 'source_occupied');
    const rep = sc.registerChain(v3Def({ chainId: 'CH-SC0-20260918-02' }), { root, supersede: true });
    assert.equal(rep.ok, true);
    assert.equal(rep.superseded, 'CH-SC0-20260918-01');
  });

  it('sourceId 必须等于首节点；terminal 必须可交易；图不允许环', () => {
    assert.match(sc.validateChainDefinition(v3Def({ sourceId: 'macro.DXY.change5d' })).errors.join('|'), /sourceId/);
    const badTerminal = v3Def();
    badTerminal.nodes[3].indicatorId = 'sector.energy_chemical.oi.flow5d';
    assert.match(sc.validateChainDefinition(badTerminal).errors.join('|'), /terminal/);
    const cycle = v3Def();
    cycle.edges.push({ id: 'e4', from: 'n3', to: 'n1', latencyDays: 5, logic: '反向循环传导路径' });
    assert.match(sc.validateChainDefinition(cycle).errors.join('|'), /环/);
  });

  it('汇合边合法；proofIndex 不能超过祖先数', () => {
    assert.equal(sc.validateChainDefinition(v3Def()).ok, true);
    const badProof = v3Def();
    badProof.nodes[3].proofIndex = 99; // n4 祖先数只有 2（n1,n5）
    assert.match(sc.validateChainDefinition(badProof).errors.join('|'), /proofIndex/);
  });

  it('DAG 状态机：并行计数连续 3 日同向证明，主支 proven，次支仍 pending', () => {
    const root = tmpRoot();
    sc.registerChain(v3Def(), { root });
    const chain = sc.loadChain('CH-SC0-20260918-01', root);
    sc.applyObservation(chain, '2026-09-18', {
      'macro.SC0.change5d': { value: -10, direction: -1, asOf: '2026-09-18' },
      'sector.energy_chemical.oi.flow5d': { value: -2, direction: -1, asOf: '2026-09-18' },
    }, { tradingDates: TRADING });
    sc.applyObservation(chain, '2026-09-19', {
      'macro.SC0.change5d': { value: -11, direction: -1, asOf: '2026-09-19' },
      'sector.energy_chemical.oi.flow5d': { value: -3, direction: -1, asOf: '2026-09-19' },
    }, { tradingDates: TRADING });
    sc.applyObservation(chain, '2026-09-22', {
      'macro.SC0.change5d': { value: -12, direction: -1, asOf: '2026-09-22' },
      'sector.energy_chemical.oi.flow5d': { value: -4, direction: -1, asOf: '2026-09-22' },
      'sector.energy_chemical.index.ret5d': { value: -2, direction: -1, asOf: '2026-09-22' },
    }, { tradingDates: TRADING });
    assert.equal(chain.status, 'proven');
    assert.equal(chain.terminals[0].status, 'proven'); // FU0 主支（n1+n2 已证明）
    assert.equal(chain.terminals[1].status, 'pending'); // PG0 次支（n5 仅 1/3）
  });
});

describe('story-chain 席位血缘（前向记录）', () => {
  it('observeAll 同步 pending→proven 台账，视图携带席位血缘', () => {
    const root = tmpRoot();
    const r = sc.registerChain(baseDef(), { root });
    const obs = (d, v) => sc.observeAll(d, v, { root, tradingDates: TRADING });
    obs('2026-09-02', {
      'macro.DR007.change5d': { value: -5, direction: -1, asOf: '2026-09-02' },
      'sector.black.oi.flow5d': { value: 3, direction: 1, asOf: '2026-09-02' },
    });
    obs('2026-09-03', {
      'macro.DR007.change5d': { value: -6, direction: -1, asOf: '2026-09-03' },
      'sector.black.oi.flow5d': { value: 3, direction: 1, asOf: '2026-09-03' },
    });
    obs('2026-09-04', {
      'macro.DR007.change5d': { value: -7, direction: -1, asOf: '2026-09-04' },
      'sector.black.oi.flow5d': { value: 3, direction: 1, asOf: '2026-09-04' },
    });
    const ledger = sc.loadLedger(root);
    assert.equal(ledger.chains.find((c) => c.chainId === r.chainId).status, 'proven');
    // 前向席位记录（apply-story-seats 写入 data/story-pool/seats/<runId>.json）
    fs.mkdirSync(path.join(root, 'seats'), { recursive: true });
    fs.writeFileSync(path.join(root, 'seats', 'run-1.json'), JSON.stringify({
      schema: 'futures-radar-story-seats/1', runId: 'run-1', appliedAt: 't',
      seats: [{ chainId: r.chainId, theme: '主题', symbol: 'RB0', appliedAt: 't' }],
    }));
    const view = sc.buildView({ root });
    assert.equal(view.active[0].seats.length, 1);
    assert.equal(view.active[0].seats[0].runId, 'run-1');
    assert.equal(view.active[0].seats[0].symbol, 'RB0');
  });
});

describe('story-chain 新数据判定与真实前值', () => {
  it('同 asOf 无新数据不得确认；前值取序列真实上一周期值', () => {
    const root = tmpRoot();
    const r = sc.registerChain(baseDef(), { root });
    const c = sc.loadChain(r.chainId, root);
    // 数据日早于窗口起点：只更新展示值，不判定
    sc.applyObservation(c, '2026-09-02', {
      'macro.DR007.change5d': { value: -5, direction: -1, prevValue: -3, prevAt: '2026-08-29', asOf: '2026-08-31' },
    }, { tradingDates: TRADING });
    assert.equal(c.nodes[0].status, 'pending');
    assert.equal(c.nodes[0].lastValue, -5);
    // 同 asOf 再次观测：无新数据，不得确认
    sc.applyObservation(c, '2026-09-03', {
      'macro.DR007.change5d': { value: -5, direction: -1, prevValue: -3, prevAt: '2026-08-29', asOf: '2026-08-31' },
    }, { tradingDates: TRADING });
    assert.equal(c.nodes[0].status, 'pending');
    // 真实新数据（asOf 推进）只记第 1/3 天观察，连续第三个新数据日才证明
    sc.applyObservation(c, '2026-09-04', {
      'macro.DR007.change5d': { value: -6, direction: -1, prevValue: -5, prevAt: '2026-09-01', asOf: '2026-09-02' },
    }, { tradingDates: TRADING });
    assert.equal(c.nodes[0].status, 'pending');
    assert.equal(c.nodes[0].sameStreak, 1);
    sc.applyObservation(c, '2026-09-05', {
      'macro.DR007.change5d': { value: -7, direction: -1, prevValue: -6, prevAt: '2026-09-02', asOf: '2026-09-05' },
    }, { tradingDates: TRADING });
    assert.equal(c.nodes[0].status, 'pending');
    assert.equal(c.nodes[0].sameStreak, 2);
    sc.applyObservation(c, '2026-09-08', {
      'macro.DR007.change5d': { value: -8, direction: -1, prevValue: -7, prevAt: '2026-09-05', asOf: '2026-09-08' },
    }, { tradingDates: TRADING });
    assert.equal(c.nodes[0].status, 'confirmed');
    assert.equal(c.nodes[0].prevValue, -7);
    assert.equal(c.nodes[0].prevValueAt, '2026-09-05');
  });
});
