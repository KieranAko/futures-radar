#!/usr/bin/env node
/**
 * audit-data-quality.cjs — 数据质量全面审计
 *
 * 扫描所有回测run文件，生成数据质量报告
 *
 * Usage: node audit-data-quality.cjs
 */

const fs = require('fs');
const path = require('path');
const { generateQualityReport } = require('./data-quality.cjs');

const RUNS_DIR = path.join(__dirname, 'runs');

function auditAllContracts() {
  // 查找所有bt-*目录下的raw.json文件
  const runDirs = fs.readdirSync(RUNS_DIR)
    .filter(f => f.startsWith('bt-'))
    .filter(f => fs.statSync(path.join(RUNS_DIR, f)).isDirectory());

  if (runDirs.length === 0) {
    console.error('No run directories found in', RUNS_DIR);
    process.exit(1);
  }

  console.log(`Found ${runDirs.length} run directories, auditing ALL runs...`);

  const allReports = [];
  const summary = {
    totalRuns: runDirs.length,
    totalContractSnapshots: 0,
    contractsWithOHLCViolations: 0,
    contractsWithLimitMoves: 0,
    contractsWithRollovers: 0,
    totalOHLCViolations: 0,
    totalLimitMoves: 0,
    totalRolloverDays: 0,
    cleanContracts: 0
  };

  // 用于去重：记录唯一的 symbol+date 组合
  const uniqueLimitMoves = new Set();
  const uniqueRollovers = new Set();
  const uniqueOHLCViolations = new Set();

  // 审计所有run（每个run有独立的60日窗口数据）
  for (const runDir of runDirs) {
    const rawFile = path.join(RUNS_DIR, runDir, 'raw.json');
    if (!fs.existsSync(rawFile)) {
      console.log(`  Skipping ${runDir}: no raw.json`);
      continue;
    }

    const raw = JSON.parse(fs.readFileSync(rawFile, 'utf-8'));
    if (!raw || !raw.contracts) {
      console.log(`  Skipping ${runDir}: invalid format`);
      continue;
    }

    console.log(`\nAuditing ${runDir}...`);

    for (const [symbol, contract] of Object.entries(raw.contracts)) {
      if (!contract.ohlcv || !contract.ohlcv.dates) continue;

      const report = generateQualityReport(symbol, contract.ohlcv);
      allReports.push({ runDir, ...report });

      summary.totalContractSnapshots++;
      summary.totalOHLCViolations += report.ohlcViolations;
      summary.totalLimitMoves += report.limitMoves;
      summary.totalRolloverDays += report.rolloverDays;

      if (report.ohlcViolations > 0) summary.contractsWithOHLCViolations++;
      if (report.limitMoves > 0) summary.contractsWithLimitMoves++;
      if (report.rolloverDays > 0) summary.contractsWithRollovers++;
      if (report.isClean) summary.cleanContracts++;

      // 去重统计：使用完整数组（非截断的展示数组）
      if (report.limitMovesFull) {
        report.limitMovesFull.forEach(lm => {
          uniqueLimitMoves.add(`${symbol}:${lm.date}`);
        });
      }
      if (report.rolloverDaysFull) {
        report.rolloverDaysFull.forEach(rd => {
          uniqueRollovers.add(`${symbol}:${rd.date}`);
        });
      }
      if (report.ohlcViolationsFull) {
        report.ohlcViolationsFull.forEach(v => {
          uniqueOHLCViolations.add(`${symbol}:${v.date}`);
        });
      }

      // 打印有问题的合约
      if (!report.isClean) {
        console.log(`  [${symbol}] ${contract.name || 'Unknown'}`);
        if (report.ohlcViolations > 0) {
          console.log(`    ⚠️  OHLC violations: ${report.ohlcViolations}`);
          report.ohlcViolationDetails.slice(0, 2).forEach(v => {
            console.log(`        ${v.date}: ${v.message}`);
          });
        }
        if (report.limitMoves > 0) {
          console.log(`    📊 Limit moves: ${report.limitMoves}`);
          report.limitMoveDetails.slice(0, 2).forEach(lm => {
            console.log(`        ${lm.date}: ${lm.change.toFixed(2)}%`);
          });
        }
        if (report.rolloverDays > 0) {
          console.log(`    🔄 Rollover days: ${report.rolloverDays}`);
          report.rolloverDayDetails.forEach(rd => {
            console.log(`        ${rd.date}: price jump ${rd.priceJump.toFixed(2)}%, OI drop ${rd.oiDrop.toFixed(2)}%`);
          });
        }
      }
    }
  }

  // 打印总结
  console.log('\n' + '═'.repeat(80));
  console.log('DATA QUALITY SUMMARY (ALL RUNS)');
  console.log('═'.repeat(80));
  console.log(`Total runs audited: ${summary.totalRuns}`);
  console.log(`Total contract snapshots: ${summary.totalContractSnapshots}`);
  console.log(`Clean snapshots (no issues): ${summary.cleanContracts} (${(summary.cleanContracts / summary.totalContractSnapshots * 100).toFixed(1)}%)`);
  console.log('');
  console.log('SNAPSHOT OCCURRENCES (with duplicates across runs):');
  console.log(`  Snapshots with OHLC violations: ${summary.contractsWithOHLCViolations}`);
  console.log(`  Total OHLC violation occurrences: ${summary.totalOHLCViolations}`);
  console.log(`  Snapshots with ≥9.5% price jumps: ${summary.contractsWithLimitMoves}`);
  console.log(`  Total ≥9.5% price jump occurrences: ${summary.totalLimitMoves}`);
  console.log(`  Snapshots with rollover detection: ${summary.contractsWithRollovers}`);
  console.log(`  Total rollover occurrences: ${summary.totalRolloverDays}`);
  console.log('');
  console.log('UNIQUE SYMBOL-DATE COMBINATIONS (deduplicated):');
  console.log(`  Unique OHLC violation dates: ${uniqueOHLCViolations.size}`);
  console.log(`  Unique ≥9.5% price jump dates: ${uniqueLimitMoves.size}`);
  console.log(`  Unique rollover dates: ${uniqueRollovers.size}`);
  console.log('═'.repeat(80));

  // 保存详细报告
  const outputFile = path.join(__dirname, 'data-quality-report-full.json');
  fs.writeFileSync(outputFile, JSON.stringify({
    auditDate: new Date().toISOString(),
    totalRuns: summary.totalRuns,
    summary,
    uniqueEvents: {
      ohlcViolations: uniqueOHLCViolations.size,
      limitMoves: uniqueLimitMoves.size,
      rollovers: uniqueRollovers.size
    },
    uniqueOHLCViolationsList: Array.from(uniqueOHLCViolations),
    uniqueLimitMovesList: Array.from(uniqueLimitMoves),
    uniqueRolloversList: Array.from(uniqueRollovers),
    reports: allReports
  }, null, 2));

  console.log(`\nDetailed report saved to: ${outputFile}`);
}

auditAllContracts();
