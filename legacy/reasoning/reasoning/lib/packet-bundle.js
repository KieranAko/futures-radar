/**
 * Packet Bundle
 * point-in-time 资格评估 + evidence-packets.json bundle 构建
 */

import { validateTimeBoundary } from './packet-validator.js';
import { hashPacket } from './reasoning-artifact.js';

const OBSERVED_ORIGIN = 'observed';
const QUALIFYING_TIMESTAMPS = ['asOf', 'fetchedAt', '_published_at'];

/**
 * 评估 packet 的 point-in-time 资格：
 * 复用 validateTimeBoundary() 的结果 + provenance 检查（_timestamp_origin）
 * @param {object} packet - evidence-packet
 * @returns {{eligible: boolean, reasons: string[]}}
 */
export function assessPointInTime(packet) {
  const reasons = [];

  const timeBoundary = validateTimeBoundary(packet);
  for (const violation of timeBoundary.violations) {
    reasons.push(`${violation.constraint}: ${violation.field} ${violation.detail}`);
  }

  for (const [fieldName, fieldData] of Object.entries(packet.fields || {})) {
    if (!fieldData || typeof fieldData !== 'object') continue;
    const bearsTimestamp = QUALIFYING_TIMESTAMPS.some((t) => fieldData[t]);
    if (!bearsTimestamp) continue;
    if (fieldData._timestamp_origin !== OBSERVED_ORIGIN) {
      const origin =
        fieldData._timestamp_origin === undefined ? 'missing' : fieldData._timestamp_origin;
      reasons.push(
        `provenance: ${fieldName}._timestamp_origin=${origin} (must be ${OBSERVED_ORIGIN})`
      );
    }
  }

  return { eligible: reasons.length === 0, reasons };
}

/**
 * 构建 evidence-packets.json bundle（契约 §1.1）
 * @param {object} args
 * @param {string} args.runId
 * @param {string} args.signalDate
 * @param {object[]} args.packets
 * @returns {{meta: object, packets: object[]}}
 */
export function buildPacketBundle({ runId, signalDate, packets }) {
  if (!Array.isArray(packets)) {
    throw new Error('packets must be an array');
  }

  const seenSymbols = new Set();
  const out = [];

  for (const packet of packets) {
    if (packet.signalDate !== signalDate) {
      throw new Error(
        `signalDate mismatch: bundle=${signalDate}, packet ${packet.symbol}=${packet.signalDate}`
      );
    }
    if (seenSymbols.has(packet.symbol)) {
      throw new Error(`Duplicate symbol in bundle: ${packet.symbol}`);
    }
    seenSymbols.add(packet.symbol);

    const clone = JSON.parse(JSON.stringify(packet));
    clone.point_in_time = assessPointInTime(clone);
    clone.packetHash = hashPacket(clone);
    out.push(clone);
  }

  return {
    meta: {
      runId,
      signalDate,
      createdAt: new Date().toISOString(),
      packetSchemaVersion: '1.0.0',
      candidateCount: out.length
    },
    packets: out
  };
}
