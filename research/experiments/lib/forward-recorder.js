/**
 * Forward Recorder — 新日期登记 → H10 成熟结算 → 进度查询 最小闭环
 *
 * Spec (缅因猫 2026-08-13 + 2026-08-24 不变量审计):
 * - 主配置固定 ER>=0.20+D0，对照 ER>=0.18+D0，均 topN=null/H10/slope=0.3
 * - 正式样本必须从 minimumSignalDate（冻结提交后首个可登记日）起；此前日期一律拒绝
 * - 登记只记录候选与 D0 方向快照，pending 无收益
 * - 正式样本必须有 runId 溯源（register/settle 均强制，缺失 fail closed）
 * - 结算必须用含 T+11 bar 的新快照；成熟依据真实 bar 可用性，不用自然日推算
 * - settle 时重算 cohort 与 D0 并与登记比对，漂移即 fail closed
 * - manifest 完整性（version/冻结元数据/记录状态/内容哈希）由 forward-manifest guard 保证
 */

import fs from 'node:fs';
import { runDirectionMatrixDate } from './direction-matrix-runner.js';
import {
  FORWARD_CONFIGS,
  FINITE_TRADE_FIELDS,
  loadManifest,
  saveManifestAtomic,
  assertFrozenConfigs,
  assertManifestIntegrity
} from './forward-manifest.js';

function resolveRaw(rawInput) {
  if (typeof rawInput === 'string') {
    return JSON.parse(fs.readFileSync(rawInput, 'utf8'));
  }
  return rawInput;
}

function rawHasDate(raw, signalDate) {
  return Object.values(raw?.contracts ?? {})
    .some(c => Array.isArray(c?.ohlcv?.dates) && c.ohlcv.dates.includes(signalDate));
}

/** 快照：候选集合 + D0 方向（排序保证可比） */
function computeCohort(signalDate, raw, config) {
  const res = runDirectionMatrixDate(signalDate, raw, config);
  return {
    candidateCount: res.candidates.length,
    candidateSymbols: res.candidates.map(c => c.symbol).sort(),
    d0Signals: res.signals
      .filter(s => s.d0 !== 'uncertain')
      .map(s => ({ symbol: s.symbol, direction: s.d0 }))
      .sort((a, b) => a.symbol.localeCompare(b.symbol))
  };
}

function cohortMatches(snapshot, current) {
  return JSON.stringify(snapshot.candidateSymbols) === JSON.stringify(current.candidateSymbols)
    && JSON.stringify(snapshot.d0Signals) === JSON.stringify(current.d0Signals);
}

/**
 * 成熟判定：每个候选合约在新快照中都有 T+11 的 bar（dates.length >= T+12）。
 * 零候选日期退化为用 raw 首个合约判定覆盖范围。
 */
function isMature(signalDate, raw, candidateSymbols) {
  const contracts = raw?.contracts ?? {};
  const syms = candidateSymbols.length > 0
    ? candidateSymbols
    : [Object.keys(contracts)[0]].filter(Boolean);
  for (const sym of syms) {
    const c = contracts[sym];
    if (!Array.isArray(c?.ohlcv?.dates)) return false;
    const T = c.ohlcv.dates.indexOf(signalDate);
    if (T < 0) return false;
    if (c.ohlcv.dates.length < T + 12) return false;
  }
  return true;
}

/** 正式样本必须有 runId 溯源——缺失或非法 fail closed */
function requireRunId(raw, when) {
  const runId = raw?.meta?.runId;
  if (typeof runId !== 'string' || runId.length === 0) {
    throw new Error(`raw meta.runId missing ${when}: forward samples require provenance, fail closed`);
  }
  return runId;
}

/**
 * 结算前数值不变式：outcomes 的非空数值与 d0 trades 全字段必须 finite。
 * NaN 会经 JSON 序列化落盘为 null，污染正式样本——此处 fail closed。
 */
function assertFiniteResults(label, res) {
  for (const o of res.outcomes) {
    if (o.priceChange !== null && !Number.isFinite(o.priceChange)) {
      throw new Error(`non-finite outcome at settle (${label}, ${o.symbol}): priceChange=${o.priceChange}`);
    }
    if (o.absMove !== null && !Number.isFinite(o.absMove)) {
      throw new Error(`non-finite outcome at settle (${label}, ${o.symbol}): absMove=${o.absMove}`);
    }
  }
  for (const t of res.trades.d0) {
    for (const field of FINITE_TRADE_FIELDS) {
      if (!Number.isFinite(t[field])) {
        throw new Error(`non-finite d0 trade at settle (${label}, ${t.symbol}): ${field}=${t[field]}`);
      }
    }
  }
}

/**
 * 登记一个 signal date：记录主/对照候选与 D0 快照（pending，无收益）
 * @returns {Object} 登记记录
 */
export function registerForwardDate(manifestPath, rawInput, signalDate) {
  const manifest = loadManifest(manifestPath);
  assertFrozenConfigs(manifest);
  assertManifestIntegrity(manifest);

  const min = manifest.minimumSignalDate;
  if (signalDate < min) {
    throw new Error(`signalDate ${signalDate} is before minimumSignalDate ${min}: old dates must not be replayed`);
  }
  if (manifest.dates?.[signalDate]) {
    throw new Error(`duplicate registration: ${signalDate} already exists`);
  }
  const lastDate = Object.keys(manifest.dates ?? {}).sort().at(-1);
  if (lastDate && signalDate <= lastDate) {
    throw new Error(`out-of-order registration: ${signalDate} <= last registered ${lastDate}`);
  }

  const raw = resolveRaw(rawInput);
  if (!rawHasDate(raw, signalDate)) {
    throw new Error(`signalDate ${signalDate} not present in raw data`);
  }
  const runId = requireRunId(raw, 'at register');

  const record = {
    signalDate,
    registeredAt: new Date().toISOString(),
    runId,
    rawPath: typeof rawInput === 'string' ? rawInput : null,
    main: computeCohort(signalDate, raw, FORWARD_CONFIGS.main),
    control: computeCohort(signalDate, raw, FORWARD_CONFIGS.control)
  };

  manifest.dates ??= {};
  manifest.dates[signalDate] = record;
  saveManifestAtomic(manifestPath, manifest);
  return record;
}

/**
 * 结算一个已登记日期：要求新快照覆盖 T+11、cohort/D0 无漂移，
 * 通过后写 d0 trades 与 outcomes（fail closed）
 * @returns {Object} settled 记录
 */
export function settleForwardDate(manifestPath, rawInput, signalDate) {
  const manifest = loadManifest(manifestPath);
  assertFrozenConfigs(manifest);
  assertManifestIntegrity(manifest);

  const record = manifest.dates?.[signalDate];
  if (!record) {
    throw new Error(`signalDate ${signalDate} is not registered`);
  }
  if (record.settled) {
    throw new Error(`signalDate ${signalDate} already settled`);
  }

  const raw = resolveRaw(rawInput);
  const settleRunId = requireRunId(raw, 'at settle');

  const candidateSymbols = [...new Set([
    ...record.main.candidateSymbols,
    ...record.control.candidateSymbols
  ])];
  if (!isMature(signalDate, raw, candidateSymbols)) {
    throw new Error(`signalDate ${signalDate} not mature: new snapshot lacks T+11 bars`);
  }

  const drift = [];
  for (const [label, config] of [['main', FORWARD_CONFIGS.main], ['control', FORWARD_CONFIGS.control]]) {
    const current = computeCohort(signalDate, raw, config);
    if (!cohortMatches(record[label], current)) {
      drift.push(label);
    }
  }
  if (drift.length > 0) {
    throw new Error(`drift detected at settle for ${signalDate} (${drift.join(', ')}): fail closed`);
  }

  const mainRes = runDirectionMatrixDate(signalDate, raw, FORWARD_CONFIGS.main);
  const controlRes = runDirectionMatrixDate(signalDate, raw, FORWARD_CONFIGS.control);

  assertFiniteResults('main', mainRes);
  assertFiniteResults('control', controlRes);

  record.settled = {
    settledAt: new Date().toISOString(),
    settleRunId,
    driftStatus: 'ok',
    main: { trades: mainRes.trades.d0, outcomes: mainRes.outcomes },
    control: { trades: controlRes.trades.d0, outcomes: controlRes.outcomes }
  };
  saveManifestAtomic(manifestPath, manifest);
  return record.settled;
}

/**
 * 进度查询：注册/结算/零候选摘要
 */
export function getForwardStatus(manifestPath) {
  const manifest = loadManifest(manifestPath);
  assertFrozenConfigs(manifest);
  assertManifestIntegrity(manifest);
  const dates = Object.keys(manifest.dates ?? {}).sort();
  const settledDates = dates.filter(d => manifest.dates[d].settled);
  const pendingDates = dates.filter(d => !manifest.dates[d].settled);
  const zeroCandidateDates = dates.filter(d => {
    const rec = manifest.dates[d];
    return rec.main.candidateCount === 0 && rec.control.candidateCount === 0;
  });
  return {
    minimumSignalDate: manifest.minimumSignalDate,
    freezeCommit: manifest.freezeCommit,
    frozenAt: manifest.frozenAt,
    registered: dates.length,
    settledCount: settledDates.length,
    pendingCount: pendingDates.length,
    zeroCandidateDates,
    pendingDates,
    settledDates
  };
}
