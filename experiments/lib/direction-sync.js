/**
 * D4 Sector Sync Layer — 板块同步确认
 *
 * Spec (缅因猫 2026-08-13 P0 review):
 * - 权威映射来自 config/symbols.json（collector 同源），不读历史 raw.sector（未富化）
 * - D4 = D3 + sector sync: 同 signalDate、同 sector 的其他合约截断到各自 T 计算 D0，
 *   仅 D0 为 long/short 的 peer 纳入有效 peer；candidate 自身排除
 * - 有效 peer >= 2 且 sameDirection / validDirectionalPeers >= 0.60 才保留 D3 方向
 * - peer 只用截至各自 T 的 close，不得读取未来
 * - sector 仅用于同日 peer 分组，不参与机会 cohort
 */

import fs from 'node:fs';
import { determineD0Direction } from './direction-features.js';

export const D4_SYNC_RATIO = 0.60;
export const D4_MIN_PEERS = 2;

/**
 * 从 symbols.json（已解析对象或文件路径）加载 symbol->sector 映射
 * sector 缺失/unknown 的条目被排除
 * @param {Object|string} source - 解析后的配置对象或文件路径
 * @returns {Map<string, string>} symbol -> sector
 */
export function loadSectorMap(source) {
  const config = typeof source === 'string'
    ? JSON.parse(fs.readFileSync(source, 'utf8'))
    : source;
  const map = new Map();
  for (const s of config.symbols ?? []) {
    if (s.symbol && typeof s.sector === 'string' && s.sector !== 'unknown') {
      map.set(s.symbol, s.sector);
    }
  }
  return map;
}

/**
 * 同 sector 有效方向 peer：同 signalDate、同 sector、排除自身、
 * 截断到各自 T 后 D0 为 long/short 的合约（uncertain 不入列）
 * @param {string} signalDate - 信号日期 T
 * @param {string} symbol - 候选合约（自身）
 * @param {Object} raw - Raw OHLCV 数据
 * @param {Map<string, string>} sectorMap - symbol -> sector
 * @param {number} slopeThreshold - D0 斜率阈值
 * @returns {Array<{symbol: string, direction: 'long'|'short'}>}
 */
export function getDirectionalPeers(signalDate, symbol, raw, sectorMap, slopeThreshold = 0.3) {
  const sector = sectorMap.get(symbol);
  if (!sector) return [];

  const peers = [];
  for (const [sym, contract] of Object.entries(raw.contracts ?? {})) {
    if (sym === symbol) continue;
    if (sectorMap.get(sym) !== sector) continue;
    if (!contract?.ohlcv) continue;

    const { dates, close } = contract.ohlcv;
    const T = dates.indexOf(signalDate);
    if (T < 0) continue;
    if (!Array.isArray(close) || close.length <= T) continue;

    const tClose = close.slice(0, T + 1);
    const d0 = determineD0Direction(tClose, slopeThreshold);
    if (d0 === 'uncertain') continue;

    peers.push({ symbol: sym, direction: d0 });
  }
  return peers;
}

/**
 * D4 板块同步确认：有效 peer >= 2 且同向比例 >= 0.60
 * @param {'long'|'short'} candidateDirection - D3 方向
 * @param {Array<{direction: 'long'|'short'}>} directionalPeers - 已过滤的有效方向 peer
 * @returns {boolean} true 保留 D3 方向
 */
export function confirmD4SectorSync(candidateDirection, directionalPeers) {
  if (directionalPeers.length < D4_MIN_PEERS) return false;
  const same = directionalPeers.filter(p => p.direction === candidateDirection).length;
  return same / directionalPeers.length >= D4_SYNC_RATIO;
}

/**
 * D4 层：D3 + 板块同步确认
 * @returns {'long'|'short'|'uncertain'}
 */
export function layerD4Direction(signalDate, symbol, raw, sectorMap, d3Direction, slopeThreshold = 0.3) {
  if (d3Direction === 'uncertain') return 'uncertain';
  if (!sectorMap.has(symbol)) return 'uncertain';
  const peers = getDirectionalPeers(signalDate, symbol, raw, sectorMap, slopeThreshold);
  return confirmD4SectorSync(d3Direction, peers) ? d3Direction : 'uncertain';
}
