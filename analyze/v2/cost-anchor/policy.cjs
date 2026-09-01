// experiment-line/cost-anchor/policy.cjs — 成本锚新鲜度与置信度策略（theory-base/05）
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = require('./root.cjs');
const POLICY_PATH = path.join(ROOT, 'data', 'cost-anchor', 'policy.json');
const GOLDEN_PATH = path.join(ROOT, 'data', 'cost-anchor', 'golden-sources.json');
const QUERY_PATH = path.join(ROOT, 'data', 'cost-anchor', 'query-templates.json');

const UNKNOWN_FALLBACK = { maxStaleDays: 7, deviationRefreshPct: 0, minSources: 0 };

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function loadPolicy() {
  return readJson(POLICY_PATH);
}

function loadGoldenSources() {
  return readJson(GOLDEN_PATH);
}

function loadQueryTemplates() {
  return readJson(QUERY_PATH);
}

function anchorTypePolicy(policy, anchorType) {
  const p = policy && policy.anchorTypes ? policy.anchorTypes[anchorType] : null;
  return p || UNKNOWN_FALLBACK;
}

function asOfFullDate(s) {
  const str = String(s || '');
  const md = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (md) return md[0];
  const ym = str.match(/^(\d{4})-(\d{2})/);
  if (ym) {
    const y = Number(ym[1]);
    const m = Number(ym[2]);
    return `${ym[1]}-${ym[2]}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
  }
  const y = str.match(/^(\d{4})/);
  if (y) return `${y[1]}-12-31`;
  return str;
}

/**
 * 确定性新鲜度判定：只依据主档记录 + 当日信号日期（不读任何 run 快照）。
 * @param {object} record data-store 主档记录
 * @param {string} signalDate YYYY-MM-DD
 * @param {object} [ctx] { priceDeviationPct?: number }
 */
function freshness(record, signalDate, ctx = {}) {
  if (!record) return { fresh: false, reasons: ['无主档记录'] };
  const policy = loadPolicy();
  const p = anchorTypePolicy(policy, record.anchorType);
  const reasons = [];
  const asOf = asOfFullDate(record.asOf);
  if (asOf > signalDate) return { fresh: false, reasons: [`asOf ${asOf} 晚于信号日 ${signalDate}`] };
  const ageDays = Math.max(0, Math.round((Date.parse(`${signalDate}T00:00:00Z`) - Date.parse(`${asOf}T00:00:00Z`)) / 86400000));
  if (ageDays > p.maxStaleDays) reasons.push(`${record.anchorType} 记录 age=${ageDays}d > ${p.maxStaleDays}d`);
  if (p.deviationRefreshPct > 0 && Number.isFinite(ctx.priceDeviationPct) && ctx.priceDeviationPct > p.deviationRefreshPct) {
    reasons.push(`价格偏离 ${ctx.priceDeviationPct.toFixed(1)}% > ${p.deviationRefreshPct}%`);
  }
  if (record.confidence === 'unknown') reasons.push('上期结论 unknown，按短周期重试');
  return { fresh: reasons.length === 0, reasons };
}

/**
 * 从来源层级/独立来源数/价差推导置信度（确定性，不依赖 LLM 感觉）。
 */
function deriveConfidence(record, policy) {
  const p = policy || loadPolicy();
  const tiers = Array.isArray(record.sourceTiers) ? record.sourceTiers : [];
  const valid = tiers.filter((t) => p.sourceTiers && p.sourceTiers[t]);
  const spreadPct = Number.isFinite(record.valueLow) && Number.isFinite(record.valueHigh) && record.valueHigh > 0
    ? ((record.valueHigh - record.valueLow) / record.valueHigh) * 100
    : null;
  if (valid.length === 0) return 'unknown';
  const hasS = valid.includes('S');
  const hasA = valid.includes('A');
  const independent = Math.max(valid.length, Array.isArray(record.sourceDates) ? record.sourceDates.length : 0);
  if (independent >= 2 && (hasS || hasA) && spreadPct != null && spreadPct < 15) return 'high';
  if (independent >= 2 && spreadPct != null && spreadPct < 20) return 'medium';
  if (independent >= 1 && spreadPct != null && spreadPct <= 50) return 'low';
  return 'unknown';
}

module.exports = { loadPolicy, loadGoldenSources, loadQueryTemplates, anchorTypePolicy, freshness, deriveConfidence, asOfFullDate };
