/**
 * Forward Manifest Guard — 冻结元数据 / 内容哈希 / 记录状态校验 / 原子写入
 *
 * Spec (缅因猫 2026-08-13 + 2026-08-24 不变量审计):
 * - manifest 必须记录 minimumSignalDate/freezeCommit/frozenAt；缺失或非法 fail closed
 * - 内容自哈希：每次写入封存 sha256，读取时校验，防绕过 recorder 的篡改
 * - version 必须为 1
 * - dates 记录结构校验：pending 无收益、settled 结构完整、数值 finite
 * - 原子替换：tmp + rename
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runtimeRoot } = require('../../lib/workspace.cjs');

// 默认 manifest 跟随统一运行产物目录（runtimeRoot/forward/manifest.json），
// runtimeRoot 由 lib/workspace.cjs 解析：默认 <skill>/output，可 FUTURES_RUNTIME_ROOT 覆盖。
export const DEFAULT_MANIFEST_PATH = path.join(runtimeRoot, 'forward', 'manifest.json');

/** 冻结配置——代码内唯一真相，禁止修改 */
export const FORWARD_CONFIGS = Object.freeze({
  main: Object.freeze({ erThreshold: 0.20, topN: null, holdPeriod: 10, slopeThreshold: 0.3 }),
  control: Object.freeze({ erThreshold: 0.18, topN: null, holdPeriod: 10, slopeThreshold: 0.3 })
});

/** 冻结提交元数据——锚定模型冻结 commit 7abfaab51，代码内唯一真相，禁止修改 */
export const FORWARD_FREEZE = Object.freeze({
  minimumSignalDate: '2026-08-14',
  freezeCommit: '7abfaab516652675561cbb96be5d5d6e899a0393',
  frozenAt: '2026-08-14T09:49:06+08:00'
});

/** settle 落盘前必须 finite 的 trade 数值字段 */
export const FINITE_TRADE_FIELDS = ['entryPrice', 'exitPrice', 'grossReturn', 'costs', 'netReturn'];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HEX40_RE = /^[0-9a-f]{40}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function isValidDateStr(s) {
  if (!DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function isValidIso(s) {
  return typeof s === 'string' && ISO_RE.test(s) && !Number.isNaN(Date.parse(s));
}

/** 键排序的规范序列化——哈希与对象键插入顺序无关 */
function canonicalStringify(value) {
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalStringify).join(',') + ']';
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalStringify(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

/** manifest 内容哈希（不含 hash 字段本身） */
export function computeManifestHash(manifest) {
  const { hash, ...rest } = manifest ?? {};
  return createHash('sha256').update(canonicalStringify(rest), 'utf8').digest('hex');
}

export function loadManifest(manifestPath) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    throw new Error(`manifest corrupted or unreadable at ${manifestPath}: ${err.message}`);
  }
  return manifest;
}

/** 原子写入：先写 tmp 再 rename；写入前封存内容哈希 */
export function saveManifestAtomic(manifestPath, manifest) {
  delete manifest.hash;
  manifest.hash = computeManifestHash(manifest);
  const tmp = `${manifestPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2), 'utf8');
  fs.renameSync(tmp, manifestPath);
}

export function assertFrozenConfigs(manifest) {
  const cfg = manifest?.frozenConfigs;
  const ok = cfg
    && JSON.stringify(cfg.main) === JSON.stringify(FORWARD_CONFIGS.main)
    && JSON.stringify(cfg.control) === JSON.stringify(FORWARD_CONFIGS.control);
  if (!ok) {
    throw new Error('frozen configs drifted: manifest frozenConfigs does not match FORWARD_CONFIGS');
  }
}

/** dates 记录结构 + 状态机校验：pending 无收益、settled 结构完整、数值 finite */
export function assertManifestRecords(manifest) {
  const dates = manifest?.dates ?? {};
  if (typeof dates !== 'object' || Array.isArray(dates)) {
    throw new Error('manifest dates must be an object: fail closed');
  }
  for (const [key, rec] of Object.entries(dates)) {
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
      throw new Error(`record ${key} is not an object: fail closed`);
    }
    if (!isValidDateStr(key) || rec.signalDate !== key) {
      throw new Error(`record key ${key} does not match its signalDate: fail closed`);
    }
    if (!isValidIso(rec.registeredAt)) {
      throw new Error(`record ${key} registeredAt invalid: fail closed`);
    }
    if (typeof rec.runId !== 'string' || rec.runId.length === 0) {
      throw new Error(`record ${key} runId invalid: fail closed`);
    }
    if (rec.rawPath !== null && typeof rec.rawPath !== 'string') {
      throw new Error(`record ${key} rawPath invalid: fail closed`);
    }
    for (const label of ['main', 'control']) {
      const arm = rec[label];
      if (!arm || typeof arm !== 'object') {
        throw new Error(`record ${key} ${label} missing: fail closed`);
      }
      if (!Number.isInteger(arm.candidateCount) || arm.candidateCount < 0
          || !Array.isArray(arm.candidateSymbols) || arm.candidateSymbols.length !== arm.candidateCount) {
        throw new Error(`record ${key} ${label} candidateCount inconsistent: fail closed`);
      }
      if (!arm.candidateSymbols.every((s) => typeof s === 'string' && s.length > 0)) {
        throw new Error(`record ${key} ${label} candidateSymbols invalid: fail closed`);
      }
      if (!Array.isArray(arm.d0Signals)
          || !arm.d0Signals.every((s) => s && typeof s.symbol === 'string'
            && ['long', 'short'].includes(s.direction))) {
        throw new Error(`record ${key} ${label} d0Signals invalid: fail closed`);
      }
    }
    if (rec.settled === undefined) continue;
    const s = rec.settled;
    if (!s || typeof s !== 'object' || Array.isArray(s)) {
      throw new Error(`record ${key} settled invalid: fail closed`);
    }
    if (!isValidIso(s.settledAt)) {
      throw new Error(`record ${key} settledAt invalid: fail closed`);
    }
    if (typeof s.settleRunId !== 'string' || s.settleRunId.length === 0) {
      throw new Error(`record ${key} settleRunId invalid: fail closed`);
    }
    if (s.driftStatus !== 'ok') {
      throw new Error(`record ${key} driftStatus must be ok: fail closed`);
    }
    for (const label of ['main', 'control']) {
      const arm = s[label];
      if (!arm || typeof arm !== 'object'
          || !Array.isArray(arm.trades) || !Array.isArray(arm.outcomes)) {
        throw new Error(`record ${key} settled ${label} invalid: fail closed`);
      }
      for (const t of arm.trades) {
        for (const field of FINITE_TRADE_FIELDS) {
          if (!Number.isFinite(t[field])) {
            throw new Error(`record ${key} settled ${label} trade non-finite ${field}: fail closed`);
          }
        }
      }
      for (const o of arm.outcomes) {
        if ((o.priceChange !== null && !Number.isFinite(o.priceChange))
            || (o.absMove !== null && !Number.isFinite(o.absMove))) {
          throw new Error(`record ${key} settled ${label} outcome non-finite: fail closed`);
        }
      }
    }
  }
}

/**
 * 冻结边界完整性：version → 冻结元数据 → 记录状态 → 内容哈希。
 * 任一缺失、非法或漂移均 fail closed。哈希最后校验，保证具体违规给出可诊断错误。
 */
export function assertManifestIntegrity(manifest) {
  if (manifest?.version !== 1) {
    throw new Error('manifest version missing or invalid (must be 1): fail closed');
  }
  const min = manifest?.minimumSignalDate;
  if (!min || typeof min !== 'string' || !isValidDateStr(min)) {
    throw new Error('minimumSignalDate missing or invalid in manifest: fail closed');
  }
  if (min !== FORWARD_FREEZE.minimumSignalDate) {
    throw new Error(`minimumSignalDate drifted from FORWARD_FREEZE (got ${min}, want ${FORWARD_FREEZE.minimumSignalDate}): fail closed`);
  }
  const fc = manifest?.freezeCommit;
  if (!fc || typeof fc !== 'string' || !HEX40_RE.test(fc)) {
    throw new Error('freezeCommit missing or invalid in manifest: fail closed');
  }
  if (fc !== FORWARD_FREEZE.freezeCommit) {
    throw new Error('freezeCommit drifted from FORWARD_FREEZE: fail closed');
  }
  const fa = manifest?.frozenAt;
  if (!fa || typeof fa !== 'string' || !ISO_RE.test(fa) || Number.isNaN(Date.parse(fa))) {
    throw new Error('frozenAt missing or invalid in manifest: fail closed');
  }
  if (fa !== FORWARD_FREEZE.frozenAt) {
    throw new Error('frozenAt drifted from FORWARD_FREEZE: fail closed');
  }
  assertManifestRecords(manifest);
  const hash = manifest?.hash;
  if (typeof hash !== 'string' || !HEX64_RE.test(hash)) {
    throw new Error('manifest content hash missing or invalid: fail closed');
  }
  if (hash !== computeManifestHash(manifest)) {
    throw new Error('manifest content hash mismatch: fail closed');
  }
}
