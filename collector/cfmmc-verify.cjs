#!/usr/bin/env node
/**
 * collector/cfmmc-verify.cjs — CFMMC 交叉验证层（P0 时效闭环，v0.1.2）
 *
 * 职责：收盘快照通道补入的当日 bar，用 CFMMC（中国期货市场监控中心）官方
 * 日线做逐品种交叉验证：
 *   - 白名单主力连续符号（CU0）→ 品种前缀（CU）→ CFMMC 当日行中按成交量
 *     最大选取"主导合约"，与该合约的官方 bar 比对
 *   - 三态：verified（核心字段在阈值内）/ diverged（超阈值，记录 diffs）/
 *           unverified（无法比对：市场失败/该品种无当日数据/主导合约缺失）
 *   - 阈值（已批准 P0 设计）：价格 open/high/low/close/settle 相对差 ≤0.1%；
 *     volume/open_interest 相对差 ≤5%
 *   - 结算价：快照 settle 与 CFMMC 不一致时仅标注 settleProvisional=true
 *     （保守方案，只标注不修订）
 *   - divergence 写入 provenance（perSymbol.lastBarVerification）+ raw.json
 *     meta.cfmmcVerify（summary）+ 时效卡显示"已验证/未验证"
 *
 * 集成点：collector/akshare-futures.cjs 在 fast-close 合并之后调用
 *   runCfmmcVerification(rawData, { runDir })（warn-only，不阻塞采集）
 * 开关：FUTURES_CFMMC_VERIFY=0 关闭（默认开）
 */

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const PRICE_TOLERANCE = 0.001; // 0.1%
const VOLUME_OI_TOLERANCE = 0.05; // 5%
const PRICE_FIELDS = ['open', 'high', 'low', 'close', 'settle'];
const COUNT_FIELDS = ['volume', 'open_interest'];

// 品种前缀：主力连续符号去尾 0（RB0→RB，I0→I，LH0→LH）；与传导路由同约定
function varietyPrefix(symbol) {
  return String(symbol).replace(/0$/, '');
}

function relDiff(a, b) {
  if (b === 0 || b === null || b === undefined) {
    return a === b ? 0 : Infinity;
  }
  return Math.abs(a - b) / Math.abs(b);
}

/**
 * 纯比对逻辑（可单测）：对单个主力连续符号的当日 bar 与 CFMMC 当日行比对。
 * @param {object} bar - {open,high,low,close,settle,volume,open_interest}
 * @param {Array<object>} cfmmcRows - 当日 CFMMC 行（含 variety/volume 等）
 * @param {string} symbol - 主力连续符号（如 CU0）
 * @returns {{status:'verified'|'diverged'|'unverified', contract?:string, diffs?:Array<{field, snapshot, cfmmc, diffPct}>, settleProvisional?:boolean, reason?:string}}
 */
function verifyBarAgainstCfmmc(bar, cfmmcRows, symbol) {
  const prefix = varietyPrefix(symbol);
  const dayRows = (cfmmcRows || []).filter(
    (r) => r && r.variety === prefix && r.symbol != null
  );
  if (dayRows.length === 0) {
    return { status: 'unverified', reason: 'no_cfmmc_rows_for_variety' };
  }
  // 主导合约：当日成交量最大
  const dominant = [...dayRows].sort((a, b) => (b.volume || 0) - (a.volume || 0))[0];

  const diffs = [];
  for (const f of PRICE_FIELDS) {
    if (bar[f] == null || dominant[f] == null) continue;
    const d = relDiff(bar[f], dominant[f]);
    if (d > PRICE_TOLERANCE) {
      diffs.push({ field: f, snapshot: bar[f], cfmmc: dominant[f], diffPct: +(d * 100).toFixed(4) });
    }
  }
  for (const f of COUNT_FIELDS) {
    if (bar[f] == null || dominant[f] == null) continue;
    const d = relDiff(bar[f], dominant[f]);
    if (d > VOLUME_OI_TOLERANCE) {
      diffs.push({ field: f, snapshot: bar[f], cfmmc: dominant[f], diffPct: +(d * 100).toFixed(4) });
    }
  }

  const settleDiff = diffs.some((x) => x.field === 'settle');
  if (diffs.length === 0) {
    return { status: 'verified', contract: dominant.symbol, settleProvisional: false };
  }
  return {
    status: 'diverged',
    contract: dominant.symbol,
    diffs,
    settleProvisional: settleDiff
  };
}

/**
 * 对 rawData.contracts 中所有"当日 bar 来自快照通道"的合约执行 CFMMC 验证。
 * 纯函数：不动 rawData 数值，仅写入验证元数据（lastBarVerification / meta.cfmmcVerify）。
 * @returns {summary: {verified, diverged, unverified, settleProvisionalCount}, markets, checkedAt}
 */
function applyVerificationResults(rawData, cfmmcPayload, opts = {}) {
  const checkedAt = new Date().toISOString();
  const rows = (cfmmcPayload && cfmmcPayload.rows) || [];
  const markets = (cfmmcPayload && cfmmcPayload.markets) || {};
  const summary = { verified: 0, diverged: 0, unverified: 0, settleProvisionalCount: 0 };

  for (const [sym, contract] of Object.entries(rawData.contracts || {})) {
    const ohlcv = contract.ohlcv;
    if (!ohlcv || !Array.isArray(ohlcv.dates) || ohlcv.dates.length === 0) continue;
    const lastIdx = ohlcv.dates.length - 1;
    const isSnapshotBar = contract.lastBarSource === 'sina_close_snapshot';
    const bar = {
      open: ohlcv.open[lastIdx], high: ohlcv.high[lastIdx], low: ohlcv.low[lastIdx],
      close: ohlcv.close[lastIdx], settle: ohlcv.settle[lastIdx],
      volume: ohlcv.volume[lastIdx], open_interest: ohlcv.open_interest[lastIdx]
    };
    const res = verifyBarAgainstCfmmc(bar, rows, sym);
    if (isSnapshotBar) {
      contract.lastBarVerification = { ...res, source: 'cfmmc', checkedAt };
      summary[res.status]++;
      if (res.settleProvisional) summary.settleProvisionalCount++;
    } else {
      // 非快照 bar（日线接口已发布）：不比对，标注 not_applicable
      contract.lastBarVerification = { status: 'not_applicable', source: 'cfmmc', checkedAt, reason: 'bar_from_daily_interface' };
    }
  }

  return {
    checkedAt,
    date: (cfmmcPayload && cfmmcPayload.date) || null,
    markets,
    summary
  };
}

/**
 * 拉取 CFMMC 当日日线（spawn python cfmmc_daily.py）→ 比对 → 写入 rawData 元数据。
 * @returns {Promise<object>} result（summary/markets/checkedAt）
 */
async function runCfmmcVerification(rawData, opts = {}) {
  const skillRoot = opts.skillRoot || (() => {
    let dir = __dirname;
    while (dir !== path.dirname(dir)) {
      if (fs.existsSync(path.join(dir, 'SKILL.md'))) return dir;
      dir = path.dirname(dir);
    }
    throw new Error('cannot find skill root');
  })();
  const scriptPath = path.join(skillRoot, 'collector', 'cfmmc_daily.py');
  const date = opts.date || (() => {
    const d = new Date();
    return d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
  })();

  const out = await new Promise((resolve, reject) => {
    const child = cp.execFile(
      'python', [scriptPath, '--date', date],
      { encoding: 'utf8', timeout: 120000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(new Error('cfmmc_daily.py failed: ' + (err.message || '') + ' ' + (stdout || '').slice(0, 300)));
        try {
          resolve(JSON.parse(stdout));
        } catch (e) {
          reject(new Error('cfmmc_daily.py output not JSON: ' + e.message));
        }
      }
    );
    child.on('error', (e) => reject(new Error('spawn python failed: ' + e.message)));
  });

  const result = applyVerificationResults(rawData, out, {});
  rawData.meta.cfmmcVerify = result;
  return result;
}

module.exports = { verifyBarAgainstCfmmc, applyVerificationResults, runCfmmcVerification, varietyPrefix, PRICE_TOLERANCE, VOLUME_OI_TOLERANCE };
