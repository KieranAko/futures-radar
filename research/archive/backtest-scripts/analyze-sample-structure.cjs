#!/usr/bin/env node
/**
 * analyze-sample-structure.cjs — P1第1项：有效样本结构统计
 *
 * 目的：分析70笔fixed-window交易的样本结构
 * 输出：
 * 1. 名义交易数 vs 唯一signal/entry/exit日期数
 * 2. 每个日期交易数分布（最大同日交易数）
 * 3. Symbol/sector聚类
 * 4. 持仓窗口重叠度
 * 5. 按entry-date聚类后的有效N代理（非严格ESS）
 *
 * Usage: node analyze-sample-structure.cjs --window T+10
 */

const fs = require('fs');
const path = require('path');

const BACKTEST_DIR = __dirname;

// Sector映射规则：按交易所/品种大类
const SECTOR_MAP = {
  // 能源化工 - 上期能源/大商所/郑商所
  'SC': { sector: '能源', exchange: '上期能源' },
  'EC': { sector: '能源化工', exchange: '上期能源' },
  'LU': { sector: '能源化工', exchange: '上期所' },
  'FU': { sector: '能源化工', exchange: '上期所' },
  'BU': { sector: '能源化工', exchange: '上期所' },
  'EG': { sector: '能源化工', exchange: '大商所' },
  'EB': { sector: '能源化工', exchange: '大商所' },
  'PG': { sector: '能源化工', exchange: '大商所' },
  'PP': { sector: '能源化工', exchange: '大商所' },
  'L': { sector: '能源化工', exchange: '大商所' },
  'V': { sector: '能源化工', exchange: '大商所' },
  'TA': { sector: '能源化工', exchange: '郑商所' },
  'MA': { sector: '能源化工', exchange: '郑商所' },
  'PF': { sector: '能源化工', exchange: '郑商所' },
  'SA': { sector: '能源化工', exchange: '郑商所' },

  // 黑色金属 - 上期所/大商所
  'RB': { sector: '黑色金属', exchange: '上期所' },
  'HC': { sector: '黑色金属', exchange: '上期所' },
  'SS': { sector: '黑色金属', exchange: '上期所' },
  'I': { sector: '黑色金属', exchange: '大商所' },
  'J': { sector: '黑色金属', exchange: '大商所' },
  'JM': { sector: '黑色金属', exchange: '大商所' },

  // 有色金属 - 上期所
  'CU': { sector: '有色金属', exchange: '上期所' },
  'AL': { sector: '有色金属', exchange: '上期所' },
  'ZN': { sector: '有色金属', exchange: '上期所' },
  'PB': { sector: '有色金属', exchange: '上期所' },
  'NI': { sector: '有色金属', exchange: '上期所' },
  'SN': { sector: '有色金属', exchange: '上期所' },

  // 贵金属 - 上期所
  'AU': { sector: '贵金属', exchange: '上期所' },
  'AG': { sector: '贵金属', exchange: '上期所' },

  // 橡胶 - 上期所/上期能源
  'RU': { sector: '橡胶', exchange: '上期所' },
  'NR': { sector: '橡胶', exchange: '上期所' },
  'BR': { sector: '橡胶', exchange: '上期能源' },

  // 纸浆 - 上期所
  'SP': { sector: '工业品', exchange: '上期所' },

  // 其他工业品 - 郑商所
  'SH': { sector: '工业品', exchange: '郑商所' },
  'PX': { sector: '工业品', exchange: '郑商所' },

  // 农产品 - 大商所/郑商所
  'M': { sector: '农产品', exchange: '大商所' },
  'Y': { sector: '农产品', exchange: '大商所' },
  'P': { sector: '农产品', exchange: '大商所' },
  'A': { sector: '农产品', exchange: '大商所' },
  'C': { sector: '农产品', exchange: '大商所' },
  'CS': { sector: '农产品', exchange: '大商所' },
  'JD': { sector: '农产品', exchange: '大商所' },
  'RR': { sector: '农产品', exchange: '大商所' },
  'SR': { sector: '农产品', exchange: '郑商所' },
  'CF': { sector: '农产品', exchange: '郑商所' },
  'CY': { sector: '农产品', exchange: '郑商所' },
  'AP': { sector: '农产品', exchange: '郑商所' },
  'CJ': { sector: '农产品', exchange: '郑商所' },
  'RM': { sector: '农产品', exchange: '郑商所' },
  'OI': { sector: '农产品', exchange: '郑商所' },
  'PK': { sector: '农产品', exchange: '郑商所' },
  'UR': { sector: '农产品', exchange: '郑商所' },
  'AO': { sector: '农产品', exchange: '郑商所' },

  // 畜牧 - 大商所
  'LC': { sector: '畜牧', exchange: '大商所' },
  'LH': { sector: '畜牧', exchange: '大商所' },

  // 工业品 - 郑商所/其他
  'FG': { sector: '工业品', exchange: '郑商所' },
  'SF': { sector: '工业品', exchange: '郑商所' },
  'SM': { sector: '工业品', exchange: '郑商所' },
  'ZC': { sector: '工业品', exchange: '郑商所' },
  'SI': { sector: '工业品', exchange: '郑商所' }
};

function getSymbolMetadata(symbol) {
  // 移除数字后缀，获取品种代码
  const code = symbol.replace(/\d+$/, '');
  const meta = SECTOR_MAP[code];

  if (meta) {
    return {
      code,
      sector: meta.sector,
      exchange: meta.exchange
    };
  }

  return {
    code,
    sector: 'unknown',
    exchange: 'unknown'
  };
}

function analyzeSampleStructure(trades) {
  // 1. 名义交易数 vs 唯一日期数
  const nominalN = trades.length;
  const uniqueSignalDates = new Set(trades.map(t => t.signalDate || t.entryDate));
  const uniqueEntryDates = new Set(trades.map(t => t.entryDate));
  const uniqueExitDates = new Set(trades.map(t => t.exitDate));

  // 2. 每个日期交易数分布
  const entryDateCounts = {};
  for (const trade of trades) {
    const date = trade.entryDate;
    entryDateCounts[date] = (entryDateCounts[date] || 0) + 1;
  }

  const entryDateDistribution = Object.entries(entryDateCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([date, count]) => ({ date, count }));

  const maxSameDay = Math.max(...Object.values(entryDateCounts));

  // 3. Symbol/sector聚类
  const symbolCounts = {};
  const sectorCounts = {};
  const exchangeCounts = {};

  for (const trade of trades) {
    const symbol = trade.symbol;
    const meta = getSymbolMetadata(symbol);

    symbolCounts[symbol] = (symbolCounts[symbol] || 0) + 1;
    sectorCounts[meta.sector] = (sectorCounts[meta.sector] || 0) + 1;
    exchangeCounts[meta.exchange] = (exchangeCounts[meta.exchange] || 0) + 1;
  }

  // 4. 持仓窗口重叠度
  const overlaps = [];
  const sortedTrades = trades.slice().sort((a, b) =>
    new Date(a.entryDate) - new Date(b.entryDate)
  );

  for (let i = 0; i < sortedTrades.length; i++) {
    const t1 = sortedTrades[i];
    const t1Entry = new Date(t1.entryDate);
    const t1Exit = new Date(t1.exitDate);

    let overlapCount = 0;
    for (let j = 0; j < sortedTrades.length; j++) {
      if (i === j) continue;
      const t2 = sortedTrades[j];
      const t2Entry = new Date(t2.entryDate);
      const t2Exit = new Date(t2.exitDate);

      // 判断窗口重叠：t1Entry <= t2Exit && t2Entry <= t1Exit
      if (t1Entry <= t2Exit && t2Entry <= t1Exit) {
        overlapCount++;
      }
    }

    overlaps.push({
      symbol: t1.symbol,
      entryDate: t1.entryDate,
      exitDate: t1.exitDate,
      overlapCount
    });
  }

  const avgOverlap = overlaps.reduce((a, b) => a + b.overlapCount, 0) / overlaps.length;
  const maxOverlap = Math.max(...overlaps.map(o => o.overlapCount));

  // 5. 按entry-date聚类后的有效N代理
  // 说明：这不是严格的Effective Sample Size (ESS)，仅作为entry-date clusters的计数
  // 真实ESS未知，不能直接用于统计推断
  const entryDateClusters = uniqueEntryDates.size;

  return {
    nominal: {
      trades: nominalN,
      uniqueSignalDates: uniqueSignalDates.size,
      uniqueEntryDates: uniqueEntryDates.size,
      uniqueExitDates: uniqueExitDates.size
    },
    entryDateDistribution: {
      top10: entryDateDistribution.slice(0, 10),
      maxSameDay,
      avgSameDay: nominalN / uniqueEntryDates.size
    },
    clustering: {
      symbols: Object.entries(symbolCounts).sort((a, b) => b[1] - a[1]).map(([s, c]) => ({ symbol: s, count: c })),
      sectors: Object.entries(sectorCounts).sort((a, b) => b[1] - a[1]).map(([s, c]) => ({ sector: s, count: c })),
      exchanges: Object.entries(exchangeCounts).sort((a, b) => b[1] - a[1]).map(([e, c]) => ({ exchange: e, count: c }))
    },
    overlap: {
      avgOverlapPerTrade: avgOverlap,
      maxOverlapPerTrade: maxOverlap,
      top10MostOverlapped: overlaps.sort((a, b) => b.overlapCount - a.overlapCount).slice(0, 10)
    },
    effectiveN: {
      entryDateClusters: entryDateClusters,
      method: 'unique_entry_dates',
      note: '这是entry-date cluster count，不是严格的Effective Sample Size (ESS)。真实ESS未知，不能直接用于统计推断。'
    }
  };
}

function generateReport(analysis, window) {
  const lines = [];

  lines.push(`# P1-1: 有效样本结构统计 (${window})`);
  lines.push('');
  lines.push('⚠️ **声明**：本报告为样本内诊断，不代表样本外有效性。');
  lines.push('');

  lines.push('## 1. 名义交易数 vs 唯一日期数');
  lines.push('');
  lines.push(`| 指标 | 数量 |`);
  lines.push(`|------|------|`);
  lines.push(`| 名义交易数 | ${analysis.nominal.trades} |`);
  lines.push(`| 唯一信号日期 | ${analysis.nominal.uniqueSignalDates} |`);
  lines.push(`| 唯一入场日期 | ${analysis.nominal.uniqueEntryDates} |`);
  lines.push(`| 唯一退出日期 | ${analysis.nominal.uniqueExitDates} |`);
  lines.push('');

  lines.push('## 2. 入场日期分布（Top 10）');
  lines.push('');
  lines.push(`| 入场日期 | 交易数 |`);
  lines.push(`|---------|--------|`);
  for (const item of analysis.entryDateDistribution.top10) {
    lines.push(`| ${item.date} | ${item.count} |`);
  }
  lines.push('');
  lines.push(`**统计**：`);
  lines.push(`- 最大同日交易数：${analysis.entryDateDistribution.maxSameDay}`);
  lines.push(`- 平均同日交易数：${analysis.entryDateDistribution.avgSameDay.toFixed(2)}`);
  lines.push('');

  lines.push('## 3. Symbol/Sector 聚类');
  lines.push('');
  lines.push('### 按Sector分布');
  lines.push('');
  lines.push(`| Sector | 交易数 | 占比 |`);
  lines.push(`|--------|--------|------|`);
  for (const item of analysis.clustering.sectors) {
    const pct = (item.count / analysis.nominal.trades * 100).toFixed(1);
    lines.push(`| ${item.sector} | ${item.count} | ${pct}% |`);
  }
  lines.push('');

  lines.push('### 按交易所分布');
  lines.push('');
  lines.push(`| 交易所 | 交易数 | 占比 |`);
  lines.push(`|--------|--------|------|`);
  for (const item of analysis.clustering.exchanges) {
    const pct = (item.count / analysis.nominal.trades * 100).toFixed(1);
    lines.push(`| ${item.exchange} | ${item.count} | ${pct}% |`);
  }
  lines.push('');

  lines.push('### Symbol Top 10');
  lines.push('');
  lines.push(`| Symbol | 交易数 |`);
  lines.push(`|--------|--------|`);
  for (const item of analysis.clustering.symbols.slice(0, 10)) {
    lines.push(`| ${item.symbol} | ${item.count} |`);
  }
  lines.push('');

  lines.push('## 4. 持仓窗口重叠度');
  lines.push('');
  lines.push(`| 指标 | 值 |`);
  lines.push(`|------|-----|`);
  lines.push(`| 平均每笔重叠交易数 | ${analysis.overlap.avgOverlapPerTrade.toFixed(2)} |`);
  lines.push(`| 最大每笔重叠交易数 | ${analysis.overlap.maxOverlapPerTrade} |`);
  lines.push('');
  lines.push('### 重叠度最高的交易（Top 10）');
  lines.push('');
  lines.push(`| Symbol | 入场日期 | 退出日期 | 重叠交易数 |`);
  lines.push(`|--------|---------|---------|-----------|`);
  for (const item of analysis.overlap.top10MostOverlapped) {
    lines.push(`| ${item.symbol} | ${item.entryDate} | ${item.exitDate} | ${item.overlapCount} |`);
  }
  lines.push('');

  lines.push('## 5. Entry-Date Clusters');
  lines.push('');
  lines.push(`| 指标 | 值 |`);
  lines.push(`|------|-----|`);
  lines.push(`| Entry-Date Clusters | ${analysis.effectiveN.entryDateClusters} |`);
  lines.push(`| 方法 | ${analysis.effectiveN.method} |`);
  lines.push('');
  lines.push(`**说明**：${analysis.effectiveN.note}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(`**报告生成时间**：${new Date().toISOString().split('T')[0]}`);
  lines.push(`**状态**：样本内诊断`);

  return lines.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const windowArg = args.find(a => a.startsWith('--window='));
  const window = windowArg ? windowArg.split('=')[1] : 'T+10';

  console.log(`\n=== P1-1: Sample Structure Analysis (${window}) ===\n`);

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
    console.error(`No fixed-window result files found in ${BACKTEST_DIR}`);
    console.error(`Please run fixed-window-comparison.cjs first.`);
    process.exit(1);
  }

  const resultPath = files[0].path;
  console.log(`Using: ${files[0].name}\n`);

  const results = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  const trades = results.results[window] || [];

  if (trades.length === 0) {
    console.error(`No trades found for window ${window} in ${resultPath}`);
    console.error(`Available windows: ${Object.keys(results.results).join(', ')}`);
    process.exit(1);
  }

  console.log(`Loaded ${trades.length} trades from ${window} window\n`);

  // 分析样本结构
  const analysis = analyzeSampleStructure(trades);

  // 输出JSON
  const jsonPath = path.join(BACKTEST_DIR, `sample-structure-${window.toLowerCase()}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(analysis, null, 2));
  console.log(`✓ Saved JSON to: ${jsonPath}`);

  // 生成报告
  const report = generateReport(analysis, window);
  const reportPath = path.join(BACKTEST_DIR, `SAMPLE-STRUCTURE-${window}.md`);
  fs.writeFileSync(reportPath, report);
  console.log(`✓ Saved report to: ${reportPath}`);

  // 输出关键统计
  console.log(`\n=== Key Statistics ===\n`);
  console.log(`Nominal N: ${analysis.nominal.trades}`);
  console.log(`Unique Entry Dates: ${analysis.nominal.uniqueEntryDates}`);
  console.log(`Entry-Date Clusters: ${analysis.effectiveN.entryDateClusters}`);
  console.log(`Max Same-Day Trades: ${analysis.entryDateDistribution.maxSameDay}`);
  console.log(`Avg Overlap Per Trade: ${analysis.overlap.avgOverlapPerTrade.toFixed(2)}`);
  console.log('');
}

main().catch(console.error);
