/**
 * Term Structure Evidence — IO 层（子进程抓取 + 编排）
 * Analyze 阶段增强：akshare 近月/远月真实报价 → term_structure 字段
 *
 * 提取逻辑放在 Analyze 阶段而非 raw-adapter：近远月报价需要实时调用
 * akshare 具体月份合约接口（futures_zh_daily_sina），raw.json 只含主力连续。
 *
 * 纯函数在 term-structure-core.js；本文件仅 fetchNearFarCloses /
 * extractTermStructure 走子进程。
 */

import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { commodityPrefix, resolveContractCandidates, assembleTermStructure } from './term-structure-core.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(__dirname, '..', '..');

/**
 * 调用 Python akshare 拉取候选合约在 signalDate 的收盘价
 * 批量级失败（子进程崩溃/输出解析失败）按指数退避重试，避开 sina 456 限流窗口
 * @param {string[]} contractCodes - 具体合约代码列表
 * @param {string} signalDate - YYYY-MM-DD
 * @param {object} options
 * @param {string} options.python - python 可执行名
 * @param {number} options.timeout - 子进程超时 ms
 * @param {number} options.retries - 失败后额外重试次数（默认 2）
 * @param {number} options.backoffBaseMs - 首次退避等待 ms（默认 20000，指数翻倍）
 * @returns {Promise<object>} Python 输出的 contracts 结果
 */
export async function fetchNearFarCloses(contractCodes, signalDate, {
  python = 'python',
  timeout = 180000,
  retries = 2,
  backoffBaseMs = 20000
} = {}) {
  const script = path.join(SKILL_ROOT, 'collector', 'futures-term-structure.py');

  const spawnOnce = () =>
    new Promise((resolve, reject) => {
      const child = cp.spawn(python, [
        script,
        '--contracts', contractCodes.join(','),
        '--date', signalDate
      ], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout,
        windowsHide: true
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      child.on('error', (err) => {
        reject(new Error(`Python spawn failed: ${err.message}`));
      });
      child.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`Python exited with code ${code}: ${stderr.slice(0, 300)}`));
          return;
        }
        try {
          const parsed = JSON.parse(stdout);
          if (parsed.error) {
            reject(new Error(`Python error: ${parsed.detail || parsed.error}`));
            return;
          }
          resolve(parsed.contracts || {});
        } catch (err) {
          reject(new Error(`Failed to parse Python output: ${err.message}`));
        }
      });
    });

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await spawnOnce();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await sleep(backoffBaseMs * 2 ** attempt);
      }
    }
  }
  throw lastErr;
}

/**
 * 编排：raw.json 校验 signalDate 存在 + Python 拉候选合约报价 → 组装 term_structure 字段
 * Analyze 阶段调用。
 * @param {string} rawJsonPath - raw.json 路径
 * @param {string} symbol - 主力连续代码（如 RB0）
 * @param {string} signalDate - YYYY-MM-DD
 * @param {object} options
 * @param {string} options.fetchedAt - 实际抓取时间（默认 now）
 * @param {string} options.python - python 可执行名
 * @param {number} options.timeout - 子进程超时 ms
 * @returns {Promise<{field: object, contractsResult: object, dominantContract: string|null}>}
 *   field: term_structure 字段；contractsResult: 候选合约抓取结果；
 *   dominantContract: 当日主导合约（freeze-packets 干净序列复用，不重复解析）
 */
export async function extractTermStructure(rawJsonPath, symbol, signalDate, {
  fetchedAt = new Date().toISOString(),
  python = 'python',
  timeout = 180000
} = {}) {
  const rawData = JSON.parse(fs.readFileSync(rawJsonPath, 'utf-8'));
  const contractData = rawData.contracts?.[symbol];
  const dates = contractData?.ohlcv?.dates || [];
  const signalIndex = dates.indexOf(signalDate);
  if (signalIndex === -1) {
    return {
      field: {
        source: 'akshare',
        asOf: `${signalDate}T15:00:00+08:00`,
        fetchedAt,
        _timestamp_origin: 'observed',
        gap: 'missing'
      },
      contractsResult: {},
      dominantContract: null
    };
  }

  const prefix = commodityPrefix(symbol);
  const candidates = resolveContractCandidates(signalDate);
  const allCodes = [...candidates.near, ...candidates.far].map((m) => `${prefix}${m}`);
  const contractsResult = await fetchNearFarCloses(allCodes, signalDate, { python, timeout });

  const { field, dominantContract } = assembleTermStructure({
    symbol,
    signalDate,
    fetchedAt,
    contractsResult
  });

  return { field, contractsResult, dominantContract };
}

// CLI: node reasoning/lib/term-structure.js --rawJson <path> --symbol RB0 --signalDate 2026-08-04
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const flagVal = (flag) => {
    const i = args.indexOf(flag);
    return i === -1 ? null : args[i + 1];
  };
  const rawJson = flagVal('--rawJson');
  const symbol = flagVal('--symbol');
  const signalDate = flagVal('--signalDate');
  const fetchedAt = flagVal('--fetchedAt') || new Date().toISOString();

  if (!rawJson || !symbol || !signalDate) {
    console.error('FATAL: --rawJson, --symbol, --signalDate required');
    process.exit(1);
  }

  extractTermStructure(rawJson, symbol, signalDate, { fetchedAt })
    .then(({ field }) => {
      console.log(JSON.stringify(field, null, 2));
    })
    .catch((err) => {
      console.error(`FATAL: ${err.message}`);
      process.exit(1);
    });
}
