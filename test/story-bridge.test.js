import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const seats = require(path.join(ROOT, 'stories', 'seats', 'apply-story-seats.cjs'));
const link = require(path.join(ROOT, 'stories', 'seats', 'link-signal-pool.cjs'));

function provenChain(overrides = {}) {
  return {
    chainId: 'CH-BLACK-20260917-01',
    sector: 'black',
    representative: 'RB0',
    direction: 1,
    status: 'proven',
    provenAt: '2026-09-17',
    entryProofIndex: 2,
    linkedSignalId: null,
    events: [],
    nodes: [
      { id: 'n1', status: 'confirmed', credibility: 'high' },
      { id: 'n2', status: 'confirmed', credibility: 'medium' },
      { id: 'n3', status: 'pending', credibility: null },
    ],
    ...overrides,
  };
}

describe('story-pool ↔ production/signal-pool 桥', () => {
  it('proven 链注入 filtered.json 追踪席位（tracking + storyChainId），pending 链不注入', () => {
    const filtered = {
      meta: { runId: 'r', inputCount: 10, outputCount: 3, note: 'x' },
      candidates: [
        { symbol: 'PF0', rank: 1, directionHint: 'bullish', directionBias: 'bullish', decision: 'KEEP', confidence: 'medium', reason: 'x', informationGap: 'x' },
      ],
      downgraded: [{ symbol: 'RB0', reason: 'x', informationGap: 'x' }],
    };
    const { filtered: out, added } = seats.applyStorySeats(filtered, [provenChain(), provenChain({ chainId: 'CH-BLACK-20260918-02', representative: 'RB0', direction: -1, status: 'pending', provenAt: null })], 't');
    assert.deepEqual(added, ['RB0']);
    assert.equal(out.meta.outputCount, 2);
    assert.equal(out.meta.storySeats, 1);
    const rb = out.candidates.find((c) => c.symbol === 'RB0');
    assert.equal(rb.decision, 'KEEP');
    assert.equal(rb.tracking, true);
    assert.equal(rb.storyChainId, 'CH-BLACK-20260917-01');
    assert.equal(rb.directionHint, 'bullish');
    assert.equal(out.downgraded.length, 0); // 已升为 KEEP，从 downgraded 移除
  });

  it('席位置信度由已确认节点可信度决定：全 high→high，含 low→low', () => {
    const c1 = provenChain();
    c1.nodes.forEach((n) => { if (n.status === 'confirmed') n.credibility = 'high'; });
    assert.equal(seats.chainConfidence(c1), 'high');
    const c2 = provenChain();
    c2.nodes[0].credibility = 'low';
    assert.equal(seats.chainConfidence(c2), 'low');
  });

  it('linkChains 按品种+方向+本期 runId 回链，且不重复链接', () => {
    const chains = [provenChain()];
    const signals = [
      { signalId: 'SIG-RB0-20260918-01', symbol: 'RB0', direction: 'bullish', createdRunId: '20260918-1530-auto', lastSeenRunId: '20260918-1530-auto' },
    ];
    const { updates } = link.linkChains(chains, signals, '20260918-1530-auto');
    assert.equal(updates.length, 1);
    assert.equal(chains[0].linkedSignalId, 'SIG-RB0-20260918-01');
    assert.ok(chains[0].events.some((e) => e.type === 'linked_signal'));
    const again = link.linkChains(chains, signals, '20260918-1530-auto');
    assert.equal(again.updates.length, 0);
  });

  it('linkChains 方向/品种/runId 不匹配不链接', () => {
    const bearish = provenChain({ direction: -1 });
    const wrongRun = [{
      signalId: 'SIG-RB0-20260917-01', symbol: 'RB0', direction: 'bullish',
      createdRunId: '20260917-1530-auto', lastSeenRunId: '20260917-1530-auto',
    }];
    assert.equal(link.linkChains([bearish], wrongRun, '20260918-1530-auto').updates.length, 0);
    const otherSymbol = [{
      signalId: 'SIG-HC0-20260918-01', symbol: 'HC0', direction: 'bullish',
      createdRunId: '20260918-1530-auto', lastSeenRunId: '20260918-1530-auto',
    }];
    assert.equal(link.linkChains([provenChain()], otherSymbol, '20260918-1530-auto').updates.length, 0);
  });
});

describe('build-filtered-from-story-pool（filter-llm 退役替代品）', () => {
  const builder = require(path.join(ROOT, 'stories', 'seats', 'build-filtered-from-story-pool.cjs'));
  it('所有活跃故事链（含 pending）+ 信号池追踪席位生成 KEEP；无来源时为空仓', () => {
    const proven = [
      { chainId: 'CH-NEWMAT-20260918-01', theme: '新材料板块共振下行', sector: 'new_materials', representative: 'LC0', direction: -1, status: 'pending', provenAt: null, entryProofIndex: 2 },
      { chainId: 'CH-BLACK-20260918-04', theme: '流动性收紧→黑色资金流出', sector: 'black', representative: 'RB0', direction: -1, status: 'pending', provenAt: null, entryProofIndex: 2 },
    ];
    const sig = [{ signalId: 'SIG-FG0-20260918-01', symbol: 'FG0', direction: 'bearish', poolStatus: 'active', createdDate: '2026-09-18', thesis: '玻璃空头', storyChainId: 'CH-ENERGY-20260918-01', versions: [{ currentVersionId: null, confidence: 'medium' }] }];
    const out = builder.buildFilteredFromStoryPool({ runId: 'r', filteredAt: 't', provenChains: proven, poolSignals: sig });
    assert.equal(out.meta.storySeats, 2);
    assert.equal(out.meta.trackingSeats, 1);
    assert.equal(out.candidates.length, 3);
    assert.equal(out.candidates[0].symbol, 'LC0');
    assert.equal(out.candidates[0].storyChainId, 'CH-NEWMAT-20260918-01');
    assert.equal(out.candidates[1].symbol, 'RB0');
    assert.equal(out.candidates[2].signalId, 'SIG-FG0-20260918-01');
    const empty = builder.buildFilteredFromStoryPool({ runId: 'r', filteredAt: 't', provenChains: [], poolSignals: [] });
    assert.equal(empty.candidates.length, 0);
    assert.equal(empty.meta.outputCount, 0);
    assert.match(empty.meta.note, /filter-llm 已退役/);
    // 孤儿信号（无 storyChainId）不进入机会分析
    const orphan = builder.buildFilteredFromStoryPool({ runId: 'r', filteredAt: 't', provenChains: [], poolSignals: [{ signalId: 'SIG-ORPHAN-01', symbol: 'X0', direction: 'bearish', poolStatus: 'active', thesis: 'x', versions: [] }] });
    assert.equal(orphan.candidates.length, 0);
    assert.equal(orphan.meta.trackingSeats, 0);
  });

  it('ASM-03/04：机器席位带 author 标记，confidence 缺失为 null，非法方向跳过', () => {
    const out = builder.buildFilteredFromStoryPool({
      runId: 'r',
      filteredAt: 't',
      provenChains: [{ chainId: 'CH-X-1', sector: 'black', representative: 'RB0', direction: -1, status: 'pending', entryProofIndex: 1 }],
      poolSignals: [
        { signalId: 'SIG-A-1', symbol: 'A0', direction: 'sideways', poolStatus: 'active', thesis: 'x', storyChainId: 'CH-X-1', versions: [] },
        { signalId: 'SIG-B-1', symbol: 'B0', direction: 'bearish', poolStatus: 'active', thesis: 'y', storyChainId: 'CH-X-1', versions: [] },
      ],
    });
    assert.equal(out.meta.author, 'deterministic-seats');
    const story = out.candidates.find((c) => c.storyChainId === 'CH-X-1');
    assert.equal(story.author, 'machine-seat');
    assert.equal(story.confidence, null);
    assert.equal(out.candidates.some((c) => c.symbol === 'A0'), false);
    const sig = out.candidates.find((c) => c.signalId === 'SIG-B-1');
    assert.equal(sig.author, 'machine-seat');
    assert.equal(sig.confidence, null);
  });
});
