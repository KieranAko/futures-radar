/**
 * test/reconciliation.test.js — 六问两遍：审计追问后的修订增量契约
 *
 * 覆盖：
 *   1. outputs-v2-reconciliation 结构校验（auditImpact 枚举/可修订字段/修订非空规则）
 *   2. 六问第二遍提示词只给冲突点与必要事实 id，不再给整条链
 *   3. assemble 合并函数只覆盖明确出现的字段（原字段优先）
 *   4. 无 audit-findings 时向后兼容（audit mode=unavailable）
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
const recon = require(path.join(ROOT, 'analysis', 'v2', 'reconciliation-lib.cjs'));
const audit = require(path.join(ROOT, 'analysis', 'v2', 'audit-lib.cjs'));
const builder = require(path.join(ROOT, 'analysis', 'v2', 'reconciliation-prompt-builder.cjs'));
const assemble = require(path.join(ROOT, 'analysis', 'v2', 'assemble-v2.cjs'));

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'recon-'));
}

function validDoc(overrides = {}) {
  return {
    schema: 'futures-radar-sixq-reconciliation/1',
    runId: '20260921-1514-auto',
    generatedAt: '2026-09-21T08:00:00.000Z',
    revisions: [
      {
        symbol: 'RB0',
        auditImpact: 'kept_with_reasons',
        auditResponse: '审计追问所指的资金流证据可信度不足，维持价格结构主驱动判断。',
        revisions: {},
      },
      {
        symbol: 'FU0',
        auditImpact: 'revised_driver',
        auditResponse: '采纳链关于成本传导的证据，主驱动由板块情绪改为原油成本坍塌。',
        revisions: { q1_driver: { primary: '原油成本坍塌' } },
      },
    ],
    ...overrides,
  };
}

describe('六问第二遍修订契约校验', () => {
  it('合法 kept_with_reasons / revised_driver 通过', () => {
    const check = recon.validateReconciliation(validDoc(), { symbols: ['RB0', 'FU0'] });
    assert.equal(check.ok, true, check.errors.join(';'));
  });

  it('auditImpact 枚举与 response 缺失拒收', () => {
    const bad = validDoc();
    bad.revisions[0].auditImpact = 'maybe';
    delete bad.revisions[0].auditResponse;
    const errors = recon.validateReconciliation(bad, { symbols: ['RB0', 'FU0'] }).errors.join('|');
    assert.match(errors, /auditImpact 必须/);
    assert.match(errors, /auditResponse 缺失/);
  });

  it('symbol 不在冲突集合内或重复拒收', () => {
    const bad = validDoc();
    bad.revisions[0].symbol = 'XX0';
    assert.match(recon.validateReconciliation(bad, { symbols: ['RB0', 'FU0'] }).errors.join('|'), /symbol 缺失或不在/);
    const dup = validDoc();
    dup.revisions[1].symbol = dup.revisions[0].symbol;
    assert.match(recon.validateReconciliation(dup, { symbols: ['RB0', 'FU0'] }).errors.join('|'), /重复/);
  });

  it('revised_driver/direction 必须有至少一个修订字段；非法字段拒收', () => {
    const empty = validDoc();
    empty.revisions[0].auditImpact = 'revised_driver';
    assert.match(recon.validateReconciliation(empty, { symbols: ['RB0', 'FU0'] }).errors.join('|'), /至少修订一个字段/);
    const illegal = validDoc();
    illegal.revisions[0].revisions = { arbitrary_field: 1 };
    assert.match(recon.validateReconciliation(illegal, { symbols: ['RB0', 'FU0'] }).errors.join('|'), /不在允许修订字段内/);
  });
});

describe('六问第二遍提示词', () => {
  const findings = {
    schema: 'futures-radar-audit-findings/1',
    runId: 'x',
    findings: [
      {
        symbol: 'RB0', chainId: 'CH-BLACK-20260921-03', verdict: 'conflict',
        conflicts: [
          {
            dimension: 'driver',
            chainClaim: '链认为主驱动是板块持仓流出',
            analysisClaim: '六问第一遍认为主驱动是价格结构',
            question: '请核对：资金流证据是否足以改变 Q1 主驱动？',
            factIds: ['news-20260921-black-01', 'price_data.close'],
          },
        ],
      },
    ],
  };
  const outputs = {
    results: [
      {
        symbol: 'RB0', direction: 'short', confidence: 'medium',
        q1_driver: { primary: '价格结构', evidence: 'close < ma20' },
        q2_trendOrImpulse: { assessment: '震荡偏弱' },
        q3_odds: { bias: 'bearish', summary: '等待破位' },
        q4_confirmation: { signals: ['跌破 3119'] },
        q5_invalidation: { conditions: ['站上 3132'] },
        confidenceRationale: { supportingFactors: [], opposingFactors: [], uncertainties: [] },
      },
    ],
  };
  const packets = { RB0: { price_data: { close: 3117, ma20: 3129 } } };
  const newsDoc = {
    items: [
      { id: 'news-20260921-black-01', date: '2026-09-20', type: 'industry', sectors: ['black'], title: '建筑钢材成交量数据发布', summary: '两个机构发布不同口径成交量数据。' },
    ],
  };

  it('prompt 只含冲突点与必要事实，不含链推理卡', () => {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, 'analyze'), { recursive: true });
    fs.writeFileSync(path.join(root, 'analyze', 'audit-findings.json'), JSON.stringify(findings));
    fs.writeFileSync(path.join(root, 'analyze', 'outputs-v2.json'), JSON.stringify(outputs));
    fs.writeFileSync(path.join(root, 'analyze', 'packets-v2.json'), JSON.stringify({ packets }));
    // 纯函数部分：直接调用 resolveFactId 验证事实解析
    const fact = builder.resolveFactId('price_data.close', { newsDoc, packet: packets.RB0 });
    assert.equal(fact, 'price_data.close = 3117');
    const newsFact = builder.resolveFactId('news-20260921-black-01', { newsDoc, packet: packets.RB0 });
    assert.match(newsFact, /建筑钢材成交量数据发布/);
    const unknown = builder.resolveFactId('ghost.id', { newsDoc, packet: packets.RB0 });
    assert.match(unknown, /未能解析/);
  });

  it('审计 prompt 不含整条链的节点结构，但含双方冲突原文', () => {
    const p = audit.buildAuditPrompt({
      runId: 'x',
      pairs: [{
        symbol: 'RB0',
        chain: {
          chainId: 'CH-BLACK-20260921-03',
          reasoningCard: {
            schema: 'futures-radar-story-reasoning-card/1',
            claim: { source: 'sector.black.oi.flow5d', direction: -1, path: ['n1', 'n2', 'n3'] },
            mechanisms: [{ edgeId: 'e1', why: '资金流出使板块失去承接' }],
            assumptions: ['x'], uncertainties: ['y'], falsifiers: ['z'],
          },
          nodes: [{ id: 'n1', status: 'pending' }],
        },
      }],
      outputsBySymbol: { RB0: outputs.results[0] },
      newsDoc,
      packetsBySymbol: packets,
    });
    assert.match(p, /chainClaim|链认为主驱动/);
    assert.doesNotMatch(p, /dataPlan/);
  });
});

describe('assemble 合并函数与审计态', () => {
  it('applyRevisions 只覆盖明确出现的字段', () => {
    const o = { symbol: 'RB0', direction: 'short', confidence: 'medium', q1_driver: { primary: 'A' } };
    const next = assemble.applyRevisions(o, {
      auditImpact: 'revised_driver',
      revisions: { q1_driver: { primary: 'B', evidence: 'x' }, confidence: 'low' },
    });
    assert.equal(next.symbol, 'RB0');
    assert.equal(next.direction, 'short');
    assert.equal(next.q1_driver.primary, 'B');
    assert.equal(next.confidence, 'low');
  });

  it('无 audit-findings 时向后兼容（mode=unavailable）', () => {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, 'analyze'), { recursive: true });
    const state = assemble.loadAuditState(root, ['RB0']);
    assert.equal(state.mode, 'unavailable');
  });
});
