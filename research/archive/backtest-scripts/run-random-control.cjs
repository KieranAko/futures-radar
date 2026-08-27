#!/usr/bin/env node
/**
 * run-random-control.cjs — 运行随机对照组实验的主入口
 *
 * Usage:
 *   node run-random-control.cjs --type direction --seeds 1000 --window T+10
 *   node run-random-control.cjs --type selection --seeds 100 --window T+10
 */

const fs = require('fs');
const path = require('path');
const { randomDirectionControl, randomSelectionControl } = require('./random-control.cjs');

const BACKTEST_DIR = __dirname;

async function main() {
  const args = process.argv.slice(2);

  // 解析参数
  const typeArg = args.find(a => a.startsWith('--type='));
  const seedsArg = args.find(a => a.startsWith('--seeds='));
  const windowArg = args.find(a => a.startsWith('--window='));

  if (!typeArg) {
    console.error('Usage: node run-random-control.cjs --type=<direction|selection> --seeds=<N> --window=<T+N>');
    process.exit(1);
  }

  const type = typeArg.split('=')[1];
  const seeds = seedsArg ? parseInt(seedsArg.split('=')[1]) : 1000;
  const window = windowArg ? windowArg.split('=')[1] : 'T+10';

  console.log(`\n=== P1-2: Random Control Experiment ===`);
  console.log(`Type: ${type}`);
  console.log(`Seeds: ${seeds}`);
  console.log(`Window: ${window}`);
  console.log('');

  // 查找最新的fixed-window结果文件
  const files = fs.readdirSync(BACKTEST_DIR)
    .filter(f => f.startsWith('fixed-window-') && f.endsWith('.json'))
    .map(f => ({
      name: f,
      path: path.join(BACKTEST_DIR, f),
      mtime: fs.statSync(path.join(BACKTEST_DIR, f)).mtime
    }))
    .sort((a, b) => b.mtime - a.mtime);

  if (files.length === 0) {
    console.error(`No fixed-window result files found`);
    process.exit(1);
  }

  const resultPath = files[0].path;
  console.log(`Using: ${files[0].name}\n`);

  const results = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  const trades = results.results[window] || [];

  if (trades.length === 0) {
    console.error(`No trades found for window ${window}`);
    process.exit(1);
  }

  console.log(`Loaded ${trades.length} observed trades\n`);

  // 运行对应的随机对照实验
  let randomResults;
  if (type === 'direction') {
    randomResults = await randomDirectionControl(trades, seeds);
  } else if (type === 'selection') {
    randomResults = await randomSelectionControl(trades, seeds, results.model);
  } else {
    console.error(`Unknown type: ${type}. Use 'direction' or 'selection'`);
    process.exit(1);
  }

  // 保存结果
  const outputPath = path.join(BACKTEST_DIR, `random-${type}-${window.toLowerCase()}-${seeds}seeds.json`);
  fs.writeFileSync(outputPath, JSON.stringify(randomResults, null, 2));
  console.log(`✓ Saved results to: ${outputPath}`);

  // 生成简短报告
  const reportPath = path.join(BACKTEST_DIR, `RANDOM-${type.toUpperCase()}-${window}.md`);
  const report = generateReport(randomResults, window, type);
  fs.writeFileSync(reportPath, report);
  console.log(`✓ Saved report to: ${reportPath}`);
}

function generateReport(results, window, type) {
  const lines = [];

  lines.push(`# P1-2: 随机对照组实验 — ${type === 'direction' ? 'Random Direction' : 'Random Selection'} (${window})`);
  lines.push('');
  lines.push('⚠️ **声明**：本报告为样本内诊断，不代表样本外有效性。');
  lines.push('');

  lines.push('## 1. 实验设计');
  lines.push('');
  if (type === 'direction') {
    lines.push('**类型**：Random Direction（随机方向）');
    lines.push('');
    lines.push('**方法**：');
    lines.push('- 固定信号队列（symbol + signalDate）');
    lines.push('- 随机翻转每笔交易的方向（bullish ↔ bearish）');
    lines.push('- 方向改变时，收益符号翻转');
    lines.push('- 独立种子数：' + results.seeds);
  } else {
    lines.push('**类型**：Random Selection（随机选择）');
    lines.push('');
    lines.push('**方法**：');
    lines.push('- 固定信号日期');
    lines.push('- 在每个信号日重新运行scanner（无泄漏）');
    lines.push('- 从候选池随机选择品种');
    lines.push('- 保持每日选择数量与observed一致');
    lines.push('- 独立种子数：' + results.seeds);
  }
  lines.push('');

  lines.push('## 2. 统计结果');
  lines.push('');
  lines.push('| 指标 | Observed | Null Mean | Null Std |');
  lines.push('|------|----------|-----------|----------|');
  lines.push(`| 平均收益 | ${(results.observed.avgReturn * 100).toFixed(2)}% | ${(results.null.mean * 100).toFixed(2)}% | ${(results.null.std * 100).toFixed(2)}% |`);
  lines.push(`| 交易数 | ${results.observed.trades} | ${results.observed.trades} | - |`);
  lines.push('');

  lines.push('## 3. 经验p值');
  lines.push('');
  lines.push('| 指标 | 值 |');
  lines.push('|------|-----|');
  lines.push(`| Null >= Observed | ${results.null.betterCount}/${results.seeds} |`);
  lines.push(`| 经验p值 | ${results.empiricalP.toFixed(4)} |`);
  lines.push('');
  lines.push(`**计算公式**：p = (1 + null>=observed) / (seeds + 1)`);
  lines.push('');

  lines.push('## 4. 解释');
  lines.push('');
  lines.push(`**结论**：${results.interpretation}`);
  lines.push('');
  if (results.empiricalP < 0.05) {
    lines.push('✅ 信号显著优于随机（p<0.05），拒绝零假设');
  } else if (results.empiricalP < 0.10) {
    lines.push('⚠️ 信号弱显著优于随机（p<0.10），边缘证据');
  } else {
    lines.push('❌ 信号未显著优于随机（p>=0.10），无法拒绝零假设');
  }
  lines.push('');

  if (type === 'selection' && results.auditTrail) {
    lines.push('## 5. 审计追踪（第一个种子）');
    lines.push('');
    lines.push('| 信号日期 | 候选池大小 | 候选池Hash | 选择数量 |');
    lines.push('|---------|-----------|-----------|---------|');
    for (const audit of results.auditTrail.slice(0, 10)) {
      lines.push(`| ${audit.signalDate} | ${audit.poolSize} | ${audit.poolHash} | ${audit.selectedCount} |`);
    }
    if (results.auditTrail.length > 10) {
      lines.push(`| ... | ... | ... | ... |`);
      lines.push(`| (共${results.auditTrail.length}个信号日期) | | | |`);
    }
    lines.push('');
    lines.push('**说明**：候选池Hash用于验证无泄漏（每个信号日重新计算）');
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push(`**报告生成时间**：${new Date().toISOString().split('T')[0]}`);
  lines.push(`**状态**：样本内诊断`);

  return lines.join('\n');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
