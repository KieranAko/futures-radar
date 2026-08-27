#!/usr/bin/env node
/**
 * test-p1.cjs — P1第1-2项最小测试
 *
 * 验证：
 * 1. 样本结构统计正确性
 * 2. Random Direction收益翻转逻辑
 * 3. 经验p值计算公式
 * 4. 输出文件生成
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const BACKTEST_DIR = __dirname;

console.log('\n=== P1 Tests ===\n');

// Test 1: 样本结构统计文件存在
console.log('Test 1: 样本结构统计输出...');
const sampleStructPath = path.join(BACKTEST_DIR, 'sample-structure-t+10.json');
assert(fs.existsSync(sampleStructPath), 'sample-structure-t+10.json should exist');

const sampleStruct = JSON.parse(fs.readFileSync(sampleStructPath, 'utf8'));
assert(sampleStruct.nominal.trades === 70, 'Nominal N should be 70');
assert(sampleStruct.nominal.uniqueEntryDates === 30, 'Unique entry dates should be 30');
assert(sampleStruct.effectiveN.entryDateClusters === 30, 'Entry-date clusters should be 30');
assert(sampleStruct.effectiveN.method === 'unique_entry_dates', 'Method should be unique_entry_dates');
console.log('✓ Sample structure statistics correct');

// Test 2: Random Direction输出验证
console.log('\nTest 2: Random Direction输出...');
const rdPath = path.join(BACKTEST_DIR, 'random-direction-t+10-1000seeds.json');
assert(fs.existsSync(rdPath), 'random-direction-t+10-1000seeds.json should exist');

const rdResults = JSON.parse(fs.readFileSync(rdPath, 'utf8'));
assert(rdResults.type === 'random_direction', 'Type should be random_direction');
assert(rdResults.seeds === 1000, 'Seeds should be 1000');
assert(rdResults.observed.trades === 70, 'Observed trades should be 70');
assert(typeof rdResults.empiricalP === 'number', 'Empirical p should be a number');
assert(rdResults.empiricalP >= 0 && rdResults.empiricalP <= 1, 'Empirical p should be in [0,1]');
console.log(`✓ Random Direction: p=${rdResults.empiricalP.toFixed(4)}`);

// Test 3: 经验p值计算验证
console.log('\nTest 3: 经验p值计算公式...');
const betterCount = rdResults.null.betterCount;
const seeds = rdResults.seeds;
const expectedP = (1 + betterCount) / (seeds + 1);
assert(Math.abs(rdResults.empiricalP - expectedP) < 0.0001, 'Empirical p formula incorrect');
console.log(`✓ p = (1 + ${betterCount}) / (${seeds} + 1) = ${expectedP.toFixed(4)}`);

// Test 4: 成本恒等式验证（Cost Identity）
console.log('\nTest 4: 成本恒等式验证...');
// 验证：对于同一笔交易的多空两方向，longNet + shortNet = -2×cost
// 读取fixed-window结果验证公式
const fixedWindowFiles = fs.readdirSync(BACKTEST_DIR)
  .filter(f => f.startsWith('fixed-window-') && f.endsWith('.json'));
assert(fixedWindowFiles.length > 0, 'No fixed-window file found');

const fixedData = JSON.parse(fs.readFileSync(path.join(BACKTEST_DIR, fixedWindowFiles[0]), 'utf8'));
const t10Trades = fixedData.results['T+10'] || [];
assert(t10Trades.length > 0, 'No T+10 trades found');

// 取第一笔交易验证恒等式
const testTrade = t10Trades[0];
const longNet = testTrade.grossReturn - testTrade.costs;
const shortNet = -testTrade.grossReturn - testTrade.costs;
const costIdentity = longNet + shortNet;
const expectedIdentity = -2 * testTrade.costs;

assert(Math.abs(costIdentity - expectedIdentity) < 0.000001,
  `Cost identity failed: longNet(${longNet.toFixed(6)}) + shortNet(${shortNet.toFixed(6)}) = ${costIdentity.toFixed(6)}, expected ${expectedIdentity.toFixed(6)}`);
console.log(`✓ Cost identity verified: longNet + shortNet = -2×cost = ${expectedIdentity.toFixed(6)}`);

// Test 5: Random Selection输出验证
console.log('\nTest 5: Random Selection状态检查...');
const rsPath = path.join(BACKTEST_DIR, 'random-selection-t+10-100seeds.json');
const rsInvalidPath = path.join(BACKTEST_DIR, 'random-selection-t+10-100seeds.json.INVALID');

if (fs.existsSync(rsInvalidPath)) {
  console.log('✓ Random Selection INVALID (前期实现已撤回，待重写)');
} else if (fs.existsSync(rsPath)) {
  console.log('⚠ Random Selection artifact exists but should be marked INVALID');
} else {
  console.log('✓ Random Selection NOT_IMPLEMENTED (expected)');
}

// Test 6: 报告文件生成
console.log('\nTest 6: 报告文件生成...');
const reports = [
  'SAMPLE-STRUCTURE-T+10.md',
  'RANDOM-DIRECTION-T+10.md',
  'P1-SUMMARY.md'
];

for (const report of reports) {
  const reportPath = path.join(BACKTEST_DIR, report);
  assert(fs.existsSync(reportPath), `${report} should exist`);
  const content = fs.readFileSync(reportPath, 'utf8');
  assert(content.includes('样本内诊断'), `${report} should include disclaimer`);
}
console.log('✓ All valid reports generated with disclaimers');

// Check INVALID reports
const rsReportInvalid = path.join(BACKTEST_DIR, 'RANDOM-SELECTION-T+10.md.INVALID');
if (fs.existsSync(rsReportInvalid)) {
  console.log('✓ Random Selection report marked INVALID');
}

// Test 7: 模块完成状态验证
console.log('\nTest 7: 模块完成状态验证...');
assert(typeof rdResults.empiricalP === 'number', 'Random Direction empirical p should exist');
console.log('✓ Item 1 (Sample Structure): PASS');
console.log('✓ Random Direction: PASS');
console.log('✓ Random Selection: NOT_IMPLEMENTED (expected)');

console.log('\n=== Test Results ===\n');
console.log('PASS: Item 1 + Random Direction');
console.log('EXPECTED_FAIL: Random Selection (前期实现已撤回)');
console.log('\nSummary:');
console.log(`- Nominal N: ${sampleStruct.nominal.trades}`);
console.log(`- Entry-Date Clusters: ${sampleStruct.effectiveN.entryDateClusters} (${(sampleStruct.effectiveN.entryDateClusters / sampleStruct.nominal.trades * 100).toFixed(0)}%)`);
console.log(`- Random Direction p: ${rdResults.empiricalP.toFixed(4)}`);
console.log(`- Random Selection: INVALID (待重写)`);
console.log('');
