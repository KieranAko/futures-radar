// test/strategy-section.test.js — t9 渲染测试（t7 契约 §5: T-1~T-7 中渲染相关断言）
// 覆盖 t9 acceptance：板块存在且每 TOP3 ≥1 策略；策略文本含入场/止损/目标/仓位/失效/风险/免责；
// 原四章内容不变（composeReportWithStrategy 插入逻辑）；确定性；禁用词表。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const matcher = require('../strategies/lib/strategy-matcher.cjs');
const render = require('../report/render-strategy-section.cjs');
const { renderStrategySection, composeReportWithStrategy } = render;

const skillRoot = path.resolve(import.meta.dirname, '..');
const library = JSON.parse(fs.readFileSync(path.join(skillRoot, 'strategies', 'strategy-library.json'), 'utf8'));
const { plan } = matcher.buildStrategyPlan({ runId: '20260827-1910-auto' });
const section = renderStrategySection(plan, library);

// 免责声明自带否定表述（“不含任何收益承诺或预期收益”），禁用词断言需剔除声明文本
const sectionBody = section.replace(plan.disclaimer, '');

describe('strategy-section: 板块存在与策略适配（acceptance 1/2）', () => {
  it('渲染片段含「四、交易策略（执行参考）」章节标题', () => {
    assert.ok(section.includes('## 四、交易策略（执行参考）'));
  });

  it('策略总览表包含每个 TOP3 品种（每个 TOP3 ≥1 策略）', () => {
    for (const p of plan.plans) {
      assert.ok(section.includes(`| ${p.symbol} ${p.name} |`), p.symbol);
      assert.ok(section.includes(`${p.matchedStrategies[0].strategyId} + ${p.playbook.playbookId}`), p.symbol);
    }
  });

  it('每个品种小节包含锚定合约与关键执行字段', () => {
    for (const p of plan.plans) {
      const heading = `### ${p.symbol} ${p.name}（锚定合约 ${p.contract || '—'}）`;
      assert.ok(section.includes(heading), `${p.symbol}: ${heading}`);
    }
  });

  it('策略文本含入场机会点/止损/目标/仓位/证伪失效/风险/免责', () => {
    const heads = [];
    const re = /\n### [^#]/g;
    let m;
    while ((m = re.exec('\n' + section)) !== null) heads.push(m.index - 1);
    for (const p of plan.plans) {
      const blockStart = section.indexOf(`### ${p.symbol} ${p.name}`);
      const next = heads.map(i => i).filter(i => i > blockStart);
      const block = section.slice(blockStart, next.length ? next[0] : undefined);
      for (const kw of ['- **入场机会点**:', '- **触发/执行时点**:', '- **执行口径**:', '- **止损**:', '- **目标**:', '- **仓位**:', '- **证伪/失效**:', '每手风险']) {
        assert.ok(block.includes(kw), `${p.symbol}: ${kw}`);
      }
    }
    assert.ok(section.includes('### 免责声明与风险边界'));
    assert.ok(section.includes('不构成投资建议'));
    assert.ok(section.includes('不执行真实交易'));
  });

  it('watch 计划附「转执行触发」', () => {
    for (const p of plan.plans.filter(x => x.executionStatus === 'watch')) {
      assert.ok(section.includes(`- **转执行触发**: ${p.entry.trigger}`), p.symbol);
    }
  });

  it('t13-4: 执行条款按方向选择——多头计划不含「空头距涨停」', () => {
    for (const p of plan.plans.filter(x => x.reportBaseline.direction === 'bullish')) {
      const blockStart = section.indexOf(`### ${p.symbol} ${p.name}`);
      const next = section.indexOf('\n### ', blockStart + 4);
      const block = section.slice(blockStart, next === -1 ? undefined : next);
      assert.ok(!block.includes('空头距涨停'), `${p.symbol} 多头计划不得含空头专用约束`);
      assert.ok(block.includes('多头距跌停'), `${p.symbol} 应含多头侧对等约束`);
    }
    for (const p of plan.plans.filter(x => x.reportBaseline.direction === 'bearish')) {
      const blockStart = section.indexOf(`### ${p.symbol} ${p.name}`);
      const next = section.indexOf('\n### ', blockStart + 4);
      const block = section.slice(blockStart, next === -1 ? undefined : next);
      assert.ok(!block.includes('多头距跌停'), `${p.symbol} 空头计划不得含多头专用约束`);
    }
  });
});

describe('strategy-section: 禁用词表与免责（t7 §3.6/§3.7）', () => {
  it('板块正文（剔除免责声明）不含收益承诺/指令类禁用词', () => {
    const forbidden = /年化收益|预期收益|目标收益|保证收益|收益承诺|稳赚|保本|无风险|必涨|必跌|躺赢|稳赢|建议买入|建议卖出|强烈推荐|加仓买入|重仓买入|All ?[Ii]n|满仓/;
    assert.ok(!forbidden.test(sectionBody));
  });

  it('板块正文不含 % 收益率表述', () => {
    assert.ok(!/(收益|回报|胜率)\s*[+＋]?\d+(\.\d+)?\s*%/.test(sectionBody));
  });
});

describe('strategy-section: 四章+附录不变（composeReportWithStrategy）', () => {
  const base = [
    '# 期货投机机会雷达 — 2026-08-27',
    '',
    '## 一、市场雷达',
    '内容A',
    '## 二、候选筛选',
    '内容B',
    '## 三、重点机会分析',
    '内容C',
    '## 五、方法与数据说明',
    '### 价格区间方法',
    '附录内容',
    '---',
    '*免责声明：本报告由 AI 生成*'
  ].join('\n');

  it('插入后原四章与附录所有行原样保留（逐行顺序不变）', () => {
    const out = composeReportWithStrategy(base, '## 四、交易策略（执行参考）\n板块内容');
    const baseLines = base.split('\n');
    const outLines = out.split('\n');
    let i = 0;
    for (const line of outLines) {
      if (i < baseLines.length && line === baseLines[i]) i++;
    }
    assert.equal(i, baseLines.length, 'base lines must be a subsequence in order');
  });

  it('新章节位于重点机会之后、方法与数据说明之前', () => {
    const out = composeReportWithStrategy(base, '## 四、交易策略（执行参考）\n板块内容');
    const idx3 = out.indexOf('## 三、重点机会分析');
    const idx4 = out.indexOf('## 四、交易策略（执行参考）');
    const idxA = out.indexOf('## 五、方法与数据说明');
    assert.ok(idx3 < idx4 && idx4 < idxA);
  });

  it('无附录锚点时回退为末尾追加', () => {
    const out = composeReportWithStrategy('# 标题\n正文', '## 四、交易策略（执行参考）\n板块内容');
    assert.ok(out.endsWith('板块内容\n'));
  });
});

describe('strategy-section: 确定性', () => {
  it('同输入渲染两次输出一致', () => {
    const a = renderStrategySection(plan, library);
    const b = renderStrategySection(plan, library);
    assert.equal(a, b);
  });

  it('族级证据状态行只读展示、不改变方向与置信度', () => {
    const fam = {
      updatedAt: '2026-08-29',
      families: { carry: { level: 'g1' }, momentum: { level: 'instance_gate_failed' } },
    };
    const withFam = renderStrategySection(plan, library, null, fam);
    const withoutFam = renderStrategySection(plan, library, null, null);
    assert.ok(withFam.includes('族级证据状态（实验线 2026-08-29）'));
    assert.ok(!withoutFam.includes('族级证据状态'));
    // 族级证据行不得引入收益/胜率数字
    assert.ok(!/(收益|回报|胜率)\s*[+＋]?\d+(\.\d+)?\s*%/.test(withFam.split('族级证据状态')[1] || ''));
  });
});
