#!/usr/bin/env node
/**
 * collector/probe-reuse.cjs — 探针结果跨阶段复用（P2 可靠容错，v0.1.2）
 *
 * 背景：SKILL.md 前置要求跑一次探针，管道 stage 0 又会再跑一次——两次背靠背
 * 打 qihuohangqing.js 正是今天 456 的诱因之一。方案：已有 source-probe.json
 * 且在窗口内（默认 30 分钟）且 verdict != fatal → 直接复用，不再重打探针端点。
 * FUTURES_FORCE_PROBE=1 强制重探。
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_REUSE_MINUTES = 30;

/**
 * 读取 run 目录中可复用的探针结果。
 * @returns {{reused:boolean, probe?:object, reason?:string}}
 */
function readFreshProbeIfValid(runDir, opts = {}) {
  if (process.env.FUTURES_FORCE_PROBE === '1') {
    return { reused: false, reason: 'FUTURES_FORCE_PROBE=1' };
  }
  const probePath = path.join(runDir, 'source-probe.json');
  if (!fs.existsSync(probePath)) {
    return { reused: false, reason: 'no source-probe.json' };
  }
  let probe;
  try {
    probe = JSON.parse(fs.readFileSync(probePath, 'utf8'));
  } catch {
    return { reused: false, reason: 'source-probe.json unreadable' };
  }
  const checkedAt = probe.meta && probe.meta.checkedAt;
  if (!checkedAt) {
    return { reused: false, reason: 'no checkedAt' };
  }
  const t = new Date(checkedAt);
  if (isNaN(t.getTime())) {
    return { reused: false, reason: 'bad checkedAt' };
  }
  const maxAgeMs = (opts.reuseMinutes ?? DEFAULT_REUSE_MINUTES) * 60 * 1000;
  if (Date.now() - t.getTime() > maxAgeMs) {
    return { reused: false, reason: `probe too old (age ${Math.round((Date.now() - t.getTime()) / 60000)}min > ${opts.reuseMinutes ?? DEFAULT_REUSE_MINUTES}min)` };
  }
  const verdict = probe.summary && probe.summary.verdict;
  if (verdict === 'fatal') {
    return { reused: false, reason: 'probe verdict fatal — must re-probe' };
  }
  return { reused: true, probe, reason: 'fresh probe reused' };
}

module.exports = { readFreshProbeIfValid, DEFAULT_REUSE_MINUTES };
