import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const { runtimeRoot } = require(path.join(ROOT, 'lib', 'workspace.cjs'));

describe('report content preservation（信息完整优先）', () => {
  const runsRoot = path.join(runtimeRoot, 'runs');
  const runId = fs.existsSync(runsRoot)
    ? fs.readdirSync(runsRoot).filter((d) => fs.existsSync(path.join(runsRoot, d, 'report.md'))).sort().pop()
    : null;
  const runDir = runId ? path.join(runsRoot, runId) : null;
  if (!runDir) return;
  const reportPath = path.join(runDir, 'report.md');

  const report = fs.readFileSync(reportPath, 'utf8');
  const model = JSON.parse(fs.readFileSync(path.join(runDir, 'report-model.json'), 'utf8'));
  const strategyPlan = JSON.parse(fs.readFileSync(path.join(runDir, 'strategy-plan.json'), 'utf8'));

  it('五章框架 + 速览存在，且删除独立今日不做什么章节', () => {
    for (const heading of ['## 结论速览', '## 一、市场环境', '## 二、候选筛选', '## 三、重点机会分析', '## 四、交易策略', '## 五、方法与数据说明']) {
      assert.ok(report.includes(heading), `missing ${heading}`);
    }
    assert.ok(!report.includes('## 阅读导航'));
    assert.ok(!report.includes('## 四、今日不做什么'));
    assert.ok(report.includes('未入选品种及其理由见上表'));
  });

  it('过滤决策完整保留（KEEP+DROP 及理由）', () => {
    for (const dec of model.screening.decisions) {
      assert.ok(report.includes(`${dec.symbol} ${dec.name}`), `missing decision row ${dec.symbol}`);
      if (dec.decision !== 'KEEP') assert.ok(report.includes(dec.reason), `missing drop reason ${dec.symbol}`);
    }
  });

  it('TOP3 六问完整保留（不截断）', () => {
    for (const opp of model.opportunities) {
      const t = opp.thesis;
      assert.ok(report.includes(`### ${opp.symbol} ${opp.name}`));
      assert.ok(report.includes(`**锚定合约**: ${opp.contract}（收盘 ${opp.marketFacts.close}）`), `missing close for ${opp.symbol}`);
      for (const label of ['**驱动 (Q1)**', '**趋势/脉冲 (Q2)**', '**赔率 (Q3)**', '**确认信号 (Q4)**', '**失效条件 (Q5)**', '**风险 (Q6)**']) {
        assert.ok(report.includes(label), `missing ${label} for ${opp.symbol}`);
      }
      for (const sig of t.confirmations.signals) assert.ok(report.includes(sig), `missing Q4 signal for ${opp.symbol}`);
      for (const cond of t.invalidations.conditions) assert.ok(report.includes(cond), `missing Q5 condition for ${opp.symbol}`);
    }
  });

  it('策略计划全部字段行保留', () => {
    for (const p of strategyPlan.plans) {
      assert.ok(report.includes(`### ${p.symbol} ${p.name}（锚定合约 ${p.contract}）`));
      const newLayout = !!p.strategyConfidence;
      if (newLayout) {
        for (const field of ['入场机会点', '触发/执行时点', '执行口径', '止损', '目标', '仓位', '证伪/失效']) {
          assert.ok(report.includes(`| ${field} |`), `missing ${field} for ${p.symbol}`);
        }
        assert.ok(report.includes('| 风险与依据 | 内容 |'), `missing risk table for ${p.symbol}`);
        for (const field of ['每手风险', '策略依据', '状态说明']) {
          assert.ok(report.includes(`| ${field} |`), `missing ${field} for ${p.symbol}`);
        }
        if (p.executionStatus === 'watch') assert.ok(report.includes('| 转执行触发 |'), `missing watch trigger for ${p.symbol}`);
      } else {
        for (const field of ['- **入场机会点**', '- **触发/执行时点**', '- **执行口径**', '- **止损**', '- **目标**', '- **仓位**', '- **证伪/失效**', '- **风险要点**', '- **策略依据**', '- **状态**']) {
          assert.ok(report.includes(field), `missing ${field} for ${p.symbol}`);
        }
        if (p.executionStatus === 'watch') assert.ok(report.includes('- **转执行触发**'));
      }
      const close = (model.opportunities.find((o) => o.symbol === p.symbol) || {}).marketFacts?.close;
      if (close != null) {
        const needle = newLayout ? `| 收盘价基准 | ${close}` : `- **收盘价基准**: ${close}`;
        assert.ok(report.includes(needle), `missing strategy close for ${p.symbol}`);
      }
    }
    if (report.includes('### 上一期策略证伪反馈')) {
      assert.ok(report.includes('| 计划 | 品种 | 方向/置信度 | 策略 | 信号日 | 验证结果 | 归因 |'));
    }
  });

  it('方法与数据说明完整保留', () => {
    for (const block of ['价格区间方法', 'EWMA', 'GARCH', 'FHS', 'EVT-POT', 'ACI', '置信度定义', '成本锚方法']) {
      assert.ok(report.includes(block), `missing appendix ${block}`);
    }
    for (const line of ['免责声明', '数据来源：akshare']) assert.ok(report.includes(line));
  });
});
