/**
 * test/audit-lib.test.js — 审计 LLM 契约
 *
 * 覆盖：
 *   1. findings schema 结构校验（aligned/conflict、冲突点上限、字段引用）
 *   2. audit prompt 只包含链推理卡与六问原文、共同事实，并声明审计纪律
 *   3. 无推理卡的链在 prompt 中标记 evidence 缺口，不允许审计补写链主张
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const audit = require(path.join(ROOT, 'analysis', 'v2', 'audit-lib.cjs'));

const SYMBOLS = ['RB0', 'FU0'];
const CHAINS = ['CH-BLACK-20260921-03', 'CH-ENERGY-20260921-01'];

function conflictDoc(overrides = {}) {
  return {
    schema: 'futures-radar-audit-findings/1',
    runId: '20260921-1514-auto',
    generatedAt: '2026-09-21T08:00:00.000Z',
    findings: [
      {
        symbol: 'RB0',
        chainId: 'CH-BLACK-20260921-03',
        verdict: 'conflict',
        conflicts: [
          {
            dimension: 'driver',
            chainClaim: '链认为主驱动是板块持仓流出',
            analysisClaim: '六问认为主驱动是价格结构',
            question: '请核对：资金流证据是否足以改变 Q1 主驱动？',
            factIds: ['news-20260921-black-01'],
          },
        ],
      },
      {
        symbol: 'FU0',
        chainId: 'CH-ENERGY-20260921-01',
        verdict: 'aligned',
        conflicts: [],
      },
    ],
    ...overrides,
  };
}

describe('审计 findings 契约校验', () => {
  it('合法 aligned/conflict 混合 findings 通过', () => {
    const check = audit.validateAuditFindings(conflictDoc(), { symbols: SYMBOLS, chainIds: CHAINS });
    assert.equal(check.ok, true, check.errors.join(';'));
  });

  it('schema/runId/findings 结构错误拒收', () => {
    assert.match(audit.validateAuditFindings(null, { symbols: SYMBOLS, chainIds: CHAINS }).errors.join('|'), /schema/);
    assert.match(audit.validateAuditFindings({ schema: audit.AUDIT_FINDINGS_SCHEMA, findings: [] }, { symbols: SYMBOLS, chainIds: CHAINS }).errors.join('|'), /runId/);
  });

  it('conflict 必须 1..3 个冲突点；aligned 必须空数组', () => {
    const noConflict = conflictDoc();
    noConflict.findings[0].conflicts = [];
    assert.match(audit.validateAuditFindings(noConflict, { symbols: SYMBOLS, chainIds: CHAINS }).errors.join('|'), /至少 1 个冲突点/);

    const tooMany = conflictDoc();
    tooMany.findings[0].conflicts = [1, 2, 3, 4].map((i) => ({
      dimension: 'driver', chainClaim: `链${i}`, analysisClaim: `六问${i}`, question: `问题${i}`,
    }));
    assert.match(audit.validateAuditFindings(tooMany, { symbols: SYMBOLS, chainIds: CHAINS }).errors.join('|'), /最多 3/);

    const alignedWithConflict = conflictDoc();
    alignedWithConflict.findings[1].conflicts = alignedWithConflict.findings[0].conflicts;
    assert.match(audit.validateAuditFindings(alignedWithConflict, { symbols: SYMBOLS, chainIds: CHAINS }).errors.join('|'), /aligned 时 conflicts 必须为空/);
  });

  it('symbol/chainId/dimension/question 引用与枚举校验', () => {
    const bad = conflictDoc();
    bad.findings[0].symbol = 'XX0';
    bad.findings[0].chainId = 'CH-UNKNOWN';
    bad.findings[0].conflicts[0].dimension = 'mood';
    delete bad.findings[0].conflicts[0].question;
    const errors = audit.validateAuditFindings(bad, { symbols: SYMBOLS, chainIds: CHAINS }).errors.join('|');
    assert.match(errors, /symbol 缺失或不在/);
    assert.match(errors, /chainId 缺失或不是/);
    assert.match(errors, /dimension 必须/);
    assert.match(errors, /question 缺失/);
  });
});

describe('审计提示词构建', () => {
  function chain() {
    return {
      chainId: 'CH-BLACK-20260921-03',
      sourceClass: 'behavior',
      status: 'pending',
      provisional: false,
      reasoningCard: {
        schema: 'futures-radar-story-reasoning-card/1',
        claim: { source: 'sector.black.oi.flow5d', direction: -1, path: ['n1', 'n2', 'n3'] },
        mechanisms: [
          { edgeId: 'e1', why: '持仓净流出使黑色失去承接，相对强度转负' },
          { edgeId: 'e2', why: '资金退潮下螺纹最先被减仓定价并失守 MA20' },
        ],
        evidenceRefs: { news: ['news-20260921-black-01'], indicators: ['sector.black.oi.flow5d'] },
        assumptions: ['资金流出是主动退潮'],
        uncertainties: ['口径为全板块 OI'],
        falsifiers: ['源节点连续两日反向'],
      },
      nodes: [
        { id: 'n1', label: '黑色持仓净流出', expectation: -1, status: 'pending', sameStreak: 1, oppStreak: 0 },
      ],
    };
  }

  function output() {
    return {
      symbol: 'RB0', direction: 'short', confidence: 'medium',
      q1_driver: { primary: '价格结构承压', evidence: 'close < MA20' },
      q2_trendOrImpulse: { assessment: '震荡偏弱' },
      q3_odds: { bias: 'bearish', summary: '等待破位确认' },
      q4_confirmation: { signals: ['跌破 3119'] },
      q5_invalidation: { conditions: ['站上 3132'] },
      confidenceRationale: {
        supportingFactors: [{ note: '收于 MA20 下方' }],
        opposingFactors: [{ note: 'MA60 上方' }],
        uncertainties: ['反抽未结束'],
      },
    };
  }

  it('prompt 包含审计职责、双方原文与共同新闻事实', () => {
    const p = audit.buildAuditPrompt({
      runId: 'x',
      pairs: [{ symbol: 'RB0', chain: chain() }],
      outputsBySymbol: { RB0: output() },
      newsDoc: { items: [{ id: 'news-1', date: '2026-09-21', type: 'industry', sectors: ['black'], title: '成交数据发布', summary: '两个机构发布成交量口径信息。' }] },
      packetsBySymbol: { RB0: { price_data: { close: 3117, ma20: 3129 }, sector_context: { sector: 'black', ret5d: -0.39 } } },
    });
    assert.match(p, /审计 LLM/);
    assert.match(p, /不判谁对谁错/);
    assert.match(p, /不追问传导链/);
    assert.match(p, /链 CH-BLACK-20260921-03/);
    assert.match(p, /持仓净流出使黑色失去承接/);
    assert.match(p, /价格结构承压/);
    assert.match(p, /news-1/);
    assert.match(p, /每品种最多 3 个冲突点/);
  });

  it('无推理卡的链在 prompt 中标记 evidence 缺口', () => {
    const noCard = chain();
    noCard.reasoningCard = null;
    noCard.definition = { reasoningCard: null };
    const p = audit.buildAuditPrompt({
      runId: 'x',
      pairs: [{ symbol: 'RB0', chain: noCard }],
      outputsBySymbol: { RB0: output() },
      newsDoc: null,
      packetsBySymbol: {},
    });
    assert.match(p, /暂无 reasoningCard/);
    assert.match(p, /不得补写链主张/);
  });
});
