/**
 * Raw Adapter
 * 从真实raw.json提取evidence-packet字段
 */

import fs from 'node:fs';

/**
 * 计算截至 signalIndex 的移动平均线（窗口必须锚定 signalDate，禁止尾部锚定——尾部可能含未来 bar）
 * @param {number[]} closes - 收盘价数组
 * @param {number} signalIndex - signalDate 在数组中的索引
 * @param {number} period - MA周期
 * @returns {number|null}
 */
function calculateMA(closes, signalIndex, period) {
  if (!closes || signalIndex + 1 < period) return null;
  const windowCloses = closes.slice(signalIndex - period + 1, signalIndex + 1);
  const sum = windowCloses.reduce((acc, val) => acc + val, 0);
  return sum / period;
}

/**
 * 从raw.json提取单个合约的packet字段
 * @param {object} contractData - raw.json中的单个合约数据
 * @param {string} symbol - 合约代码
 * @param {string} signalDate - 信号日期 YYYY-MM-DD
 * @param {string} marketCutoffAt - 行情截断时点
 * @param {string} packetFrozenAt - packet冻结时点
 * @returns {object} 提取的字段数据
 */
export function extractContractFields(contractData, symbol, signalDate, marketCutoffAt, packetFrozenAt) {
  const fields = {};

  // 验证基本数据
  if (!contractData.ohlcv || !contractData.ohlcv.dates || !contractData.ohlcv.close) {
    return fields;
  }

  const { dates, close, volume, openInterest } = contractData.ohlcv;
  const sourceFetchedAt = contractData.fetchedAt;
  if (!sourceFetchedAt) {
    return fields;
  }

  // 找到signalDate的索引
  const signalIndex = dates.indexOf(signalDate);
  if (signalIndex === -1) {
    return fields; // signalDate不在数据范围内
  }

  // 提取price_data
  const close60d = close.slice(Math.max(0, signalIndex - 59), signalIndex + 1);
  const ma20 = calculateMA(close, signalIndex, 20);
  const ma60 = calculateMA(close, signalIndex, 60);

  if (close60d.length > 0 && ma20 !== null && ma60 !== null) {
    fields.price_data = {
      source: 'akshare',
      asOf: `${signalDate}T15:00:00+08:00`,
      fetchedAt: sourceFetchedAt,
      close_60d: close60d,
      ma20,
      ma60,
      freshness: 'same_day',
      gap: null
    };
  } else {
    fields.price_data = {
      source: 'akshare',
      asOf: `${signalDate}T15:00:00+08:00`,
      fetchedAt: sourceFetchedAt,
      gap: 'missing'
    };
  }

  // 提取volume_oi
  if (volume && volume.length > signalIndex) {
    const volume60d = volume.slice(Math.max(0, signalIndex - 59), signalIndex + 1);
    const recentVolume = volume.slice(Math.max(0, signalIndex - 4), signalIndex + 1);
    const avgVolume5d = recentVolume.reduce((acc, val) => acc + val, 0) / recentVolume.length;

    if (volume60d.length > 0) {
      fields.volume_oi = {
        source: 'akshare',
        asOf: `${signalDate}T15:00:00+08:00`,
        fetchedAt: sourceFetchedAt,
        volume_60d: volume60d,
        avgVolume5d,
        freshness: 'same_day',
        gap: null
      };

      if (openInterest && openInterest.length > signalIndex) {
        fields.volume_oi.openInterest_60d = openInterest.slice(
          Math.max(0, signalIndex - 59),
          signalIndex + 1
        );
      }
    } else {
      fields.volume_oi = {
        source: 'akshare',
        asOf: `${signalDate}T15:00:00+08:00`,
        fetchedAt: sourceFetchedAt,
        gap: 'missing'
      };
    }
  }

  return fields;
}

/**
 * 从raw.json文件构建packet
 * @param {string} rawJsonPath - raw.json文件路径
 * @param {string} symbol - 合约代码
 * @param {string} signalDate - 信号日期 YYYY-MM-DD
 * @returns {object} raw packet输入（用于buildPacket）
 */
export function buildPacketFromRawJson(rawJsonPath, symbol, signalDate) {
  const rawData = JSON.parse(fs.readFileSync(rawJsonPath, 'utf-8'));

  if (!rawData.contracts || !rawData.contracts[symbol]) {
    throw new Error(`Symbol ${symbol} not found in raw.json`);
  }

  const contractData = rawData.contracts[symbol];
  const marketCutoffAt = `${signalDate}T15:00:00+08:00`;
  const packetFrozenAt = `${signalDate}T16:30:00+08:00`;

  // 从rawData.meta获取frozenCommit（如果有的话）
  const frozenCommit = rawData.meta?.runId || 'unknown';

  const fields = extractContractFields(contractData, symbol, signalDate, marketCutoffAt, packetFrozenAt);

  return {
    symbol,
    signalDate,
    marketCutoffAt,
    packetFrozenAt,
    frozenCommit,
    fields
  };
}
