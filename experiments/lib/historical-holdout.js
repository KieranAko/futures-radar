import fs from 'node:fs';
import { createRequire } from 'node:module';
import { runDirectionMatrixDate } from './direction-matrix-runner.js';

// 复用 backtest 现有模块：窗口语义来自 cache-slicer，交易日历来自 time-sampler。
// 本文件只保留：manifest 校验（固定日期清单）、冻结模型适配（buildReplayRaw）、
// 单日可执行门（前置/T+11 窗口，条件判断不实现索引算术）、主/对照配对评分循环。
const require = createRequire(import.meta.url);
const { sliceWindow, getVerifyWindow } = require('../../backtest/cache-slicer.cjs');
const { getTradingDaysFromCache } = require('../../backtest/time-sampler.cjs');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// 配置由 manifest 声明并随清单冻结；工具层只做结构校验，不再硬编码参数值。
function assertConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') throw new Error('holdout config must be an object');
  const allowed = new Set(['erThreshold', 'topN', 'holdPeriod', 'slopeThreshold']);
  for (const key of Object.keys(cfg)) {
    if (!allowed.has(key)) throw new Error(`unknown holdout config key: ${key}`);
  }
  if (!Number.isFinite(cfg.erThreshold) || cfg.erThreshold <= 0 || cfg.erThreshold > 1) {
    throw new Error('invalid erThreshold in holdout config');
  }
  if (cfg.topN !== null && (!Number.isInteger(cfg.topN) || cfg.topN <= 0)) {
    throw new Error('invalid topN in holdout config');
  }
  if (!Number.isInteger(cfg.holdPeriod) || cfg.holdPeriod <= 0) {
    throw new Error('invalid holdPeriod in holdout config');
  }
  if (!Number.isFinite(cfg.slopeThreshold) || cfg.slopeThreshold <= 0) {
    throw new Error('invalid slopeThreshold in holdout config');
  }
}

// ER20+ATR14+HV20 的最大前置需求，与 selectOpportunitiesO1 的 signalIdx>=25 一致：
// 需要 T 前 25 根 + T 本身。sliceWindow 返回的窗口包含 T，因此请求 26 根并以 26 根为门。
const MIN_PRIOR_BARS = 25;
const WINDOW_BARS = MIN_PRIOR_BARS + 1;
// H10：T+1 open 进场，T+11 close 出场
const LABEL_BARS = 11;

function assertManifest(manifest) {
  if (manifest?.schemaVersion !== 1) throw new Error('unsupported holdout manifest schema');
  if (!/^[0-9a-f]{40}$/.test(manifest.modelFreezeCommit ?? '')) {
    throw new Error('invalid model freeze commit');
  }
  if (!manifest.configs || typeof manifest.configs !== 'object' || Object.keys(manifest.configs).length === 0) {
    throw new Error('holdout configs missing');
  }
  for (const cfg of Object.values(manifest.configs)) assertConfig(cfg);
  if (!Array.isArray(manifest.signalDates) || manifest.signalDates.length === 0) {
    throw new Error('holdout signal dates missing');
  }
  const unique = new Set(manifest.signalDates);
  if (unique.size !== manifest.signalDates.length) throw new Error('duplicate holdout signal date');
  if (manifest.signalDates.some(d => !DATE_RE.test(d))) throw new Error('invalid holdout signal date');
  const sorted = [...manifest.signalDates].sort();
  if (JSON.stringify(sorted) !== JSON.stringify(manifest.signalDates)) {
    throw new Error('holdout signal dates must be strictly ordered');
  }
}

// 样本分类模式：post-dev（晚于开发 label end）或 pre-dev（早于开发期首个评分日期）。
// 两者必须有其一，防止把开发期内的日期混入留出。
export function assertDevelopmentBoundary(manifest) {
  const devEnd = manifest.selection?.lastDevelopmentLabelEndDate;
  const devStart = manifest.selection?.developmentFirstRunDate;
  const hasEnd = DATE_RE.test(devEnd ?? '');
  const hasStart = DATE_RE.test(devStart ?? '');
  if (hasEnd === hasStart) {
    throw new Error('selection must declare exactly one of lastDevelopmentLabelEndDate or developmentFirstRunDate');
  }
  for (const signalDate of manifest.signalDates) {
    if (hasEnd && signalDate <= devEnd) throw new Error(`${signalDate} is not after development label end`);
    if (hasStart && signalDate >= devStart) throw new Error(`${signalDate} is not before development first run`);
  }
}

export function loadHoldoutManifest(manifestPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assertManifest(manifest);
  return manifest;
}

/** 冻结模型适配：历史缓存 → runDirectionMatrixDate 的 raw 输入 */
export function buildReplayRaw(cache) {
  const contracts = {};
  for (const [symbol, contract] of Object.entries(cache?.contracts ?? {})) {
    const source = contract.ohlcv;
    if (!source?.dates) continue;
    contracts[symbol] = {
      ...contract,
      name: contract.name ?? symbol,
      multiplier: contract.multiplier ?? 1,
      ohlcv: {
        ...source,
        openInterest: source.openInterest ?? source.open_interest ?? []
      }
    };
  }
  return { meta: cache.meta ?? {}, contracts };
}

/**
 * 单日可执行门（复用 cache-slicer 窗口语义）：
 * 每合约需 >=MIN_PRIOR_BARS 前置 bar、T+LABEL_BARS 窗口存在、T+1 open 与 T+LABEL_BARS close 有限。
 * 日期不存在时 sliceWindow 直接抛错，同样 fail closed。
 */
export function assertExecutable(raw, signalDate) {
  for (const symbol of Object.keys(raw.contracts)) {
    const prior = sliceWindow(symbol, signalDate, WINDOW_BARS, raw);
    if (prior.windowDays < WINDOW_BARS) {
      throw new Error(`${signalDate} lacks ${MIN_PRIOR_BARS} prior bars for ${symbol}`);
    }
    const verify = getVerifyWindow(symbol, signalDate, LABEL_BARS, raw);
    if (verify === null) {
      throw new Error(`${signalDate} lacks T+${LABEL_BARS} bars for ${symbol}`);
    }
    if (!Number.isFinite(verify.t1_open) || !Number.isFinite(verify.tk_close)) {
      throw new Error(`${signalDate} has non-finite entry or T+${LABEL_BARS} close for ${symbol}`);
    }
  }
}

/** 固定日期清单必须全部落在交易日历上（复用 time-sampler 的日历抽取） */
export function assertTradingCalendar(manifest, cache) {
  const calendar = getTradingDaysFromCache(
    manifest.selection.firstSignalDate,
    manifest.selection.lastSignalDate,
    cache
  );
  const calendarSet = new Set(calendar);
  for (const d of manifest.signalDates) {
    if (!calendarSet.has(d)) throw new Error(`manifest signal date ${d} is not a trading day`);
  }
}

export function runHistoricalHoldout(
  manifest,
  cache,
  runDate = runDirectionMatrixDate
) {
  assertManifest(manifest);
  assertDevelopmentBoundary(manifest);
  assertTradingCalendar(manifest, cache);
  const raw = buildReplayRaw(cache);
  if (Object.keys(raw.contracts).length !== manifest.source.contracts) {
    throw new Error('historical cache contract count drifted');
  }

  const dates = [];
  for (const signalDate of manifest.signalDates) {
    assertExecutable(raw, signalDate);
    const entry = { signalDate, marketCount: Object.keys(raw.contracts).length };
    for (const [key, config] of Object.entries(manifest.configs)) {
      entry[key] = runDate(signalDate, raw, config);
    }
    dates.push(entry);
  }

  return {
    schemaVersion: 1,
    modelFreezeCommit: manifest.modelFreezeCommit,
    sourceSha256: manifest.source.sha256,
    pairedDates: dates.length,
    dates
  };
}
