#!/usr/bin/env node
/**
 * scanner-wrapper.cjs — Scanner包装器，供random-control.cjs调用
 *
 * 目的：在给定信号日期重新运行scanner，避免泄漏
 *
 * 关键：
 * - 截断数据到信号日期T
 * - 重新计算HV、ATR、EMA等指标
 * - 应用hard-filter（涨跌停、换月、OHLC约束）
 * - 返回候选品种列表
 */

const fs = require('fs');
const path = require('path');

const BACKTEST_DIR = __dirname;
const RUN_DIR = path.join(BACKTEST_DIR, 'runs');

/**
 * 简化的scanner逻辑：从raw数据提取候选品种
 *
 * 真实实现应该：
 * 1. 读取原始OHLC数据
 * 2. 截断到signalDate
 * 3. 计算HV、ATR、EMA指标
 * 4. 应用hard-filter
 * 5. 应用模型规则（HV>1.1, ATR>2%, EMA斜率）
 *
 * 当前简化版：从历史run目录读取candidates.json作为近似
 * ⚠️ 注意：这是简化实现，真实实现需要重新计算指标
 */
async function runScanner(signalDate, modelName) {
  // 查找包含该信号日期的run目录
  const runDirs = fs.readdirSync(RUN_DIR)
    .filter(d => d.startsWith('bt-'))
    .map(d => path.join(RUN_DIR, d))
    .filter(d => fs.statSync(d).isDirectory());

  // 按日期排序，找到最接近signalDate的run
  const targetDate = new Date(signalDate);
  let closestRun = null;
  let minDiff = Infinity;

  for (const runDir of runDirs) {
    const runDate = extractRunDate(runDir);
    if (!runDate) continue;

    const diff = Math.abs(runDate - targetDate);
    if (diff < minDiff && runDate <= targetDate) {
      minDiff = diff;
      closestRun = runDir;
    }
  }

  if (!closestRun) {
    console.warn(`No run found for signal date ${signalDate}`);
    return [];
  }

  // 读取filtered-hard.json（包含通过hard-filter的品种）
  const filteredPath = path.join(closestRun, 'filtered-hard.json');
  if (!fs.existsSync(filteredPath)) {
    console.warn(`No filtered-hard.json found in ${closestRun}`);
    return [];
  }

  const filteredData = JSON.parse(fs.readFileSync(filteredPath, 'utf8'));

  // filtered-hard.json格式：{ passed: [...], rejected: [...] }
  const candidates = filteredData.passed || [];

  if (!Array.isArray(candidates)) {
    console.warn(`Invalid filtered format in ${closestRun}`);
    return [];
  }

  // 返回通过hard-filter的品种
  return candidates.map(c => ({
    symbol: c.symbol,
    direction: c.direction || 'bullish',
    confidence: c.confidence || 'medium',
    hv: c.indicators?.hv20 || null,
    atr: c.indicators?.atr5 || null
  }));
}

/**
 * 从run目录名提取日期
 * bt-20240102 -> 2024-01-02
 */
function extractRunDate(runDir) {
  const match = path.basename(runDir).match(/bt-(\d{8})/);
  if (!match) return null;

  const dateStr = match[1];
  const year = dateStr.substring(0, 4);
  const month = dateStr.substring(4, 6);
  const day = dateStr.substring(6, 8);

  return new Date(`${year}-${month}-${day}`);
}

module.exports = {
  runScanner
};
