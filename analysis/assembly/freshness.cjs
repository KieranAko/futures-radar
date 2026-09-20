#!/usr/bin/env node
/**
 * report/freshness.cjs — 数据时效说明卡（v0.1.2）
 *
 * 目的：报告顶部展示"数据到底新不新"——行情末 bar 日期、当日 bar 来源
 * （日线接口 vs 收盘快照通道）、宏观锚点 asOf 分布、采集时刻与口径说明。
 * 全部字段由既有 artifact（raw.json / macro-snapshot.json）确定性推导，
 * 不联网、不重算、不改数值；旧 run 缺失字段时优雅降级。
 *
 * 管线挂载：5A build-facts 生成 freshness → 5B 透传 → 5C 渲染卡片。
 */

// 从 raw.json + macro-snapshot.json 推导数据时效事实
function buildFreshness({ rawJson, macroSnapshot }) {
  const contracts = (rawJson && rawJson.contracts) || {};
  const symbols = Object.keys(contracts);

  const dataEnds = symbols.map((s) => {
    const c = contracts[s];
    const dates = c && c.ohlcv && Array.isArray(c.ohlcv.dates) ? c.ohlcv.dates : [];
    return c && c.dataEnd ? c.dataEnd : (dates[dates.length - 1] || null);
  });
  const latestBarDate = dataEnds.filter(Boolean).sort().slice(-1)[0] || null;
  const withLatestBar = dataEnds.filter((d) => d === latestBarDate).length;

  const barSources = {};
  for (const s of symbols) {
    const src = contracts[s].lastBarSource || 'akshare_sina_daily';
    barSources[src] = (barSources[src] || 0) + 1;
  }

  const fastClose = (rawJson && rawJson.meta && rawJson.meta.fastClose) || null;
  const collectedAt = (rawJson && rawJson.meta && rawJson.meta.collectedAt) || null;
  const sourceVersion = (rawJson && rawJson.meta && rawJson.meta.sourceVersion) || null;

  const macro = { available: false };
  if (macroSnapshot && macroSnapshot.meta && macroSnapshot.indicators) {
    macro.available = true;
    macro.signalDate = macroSnapshot.meta.signalDate || null;
    macro.snapshotFrozenAt = macroSnapshot.meta.snapshotFrozenAt || null;
    const entries = Object.entries(macroSnapshot.indicators);
    macro.fresh = entries.filter(([, v]) => v && v.status === 'fresh').map(([id]) => id);
    macro.stale = entries
      .filter(([, v]) => v && v.status === 'stale')
      .map(([id, v]) => ({ id, asOf: v.asOf || null }));
    macro.missing = entries.filter(([, v]) => !v || v.status === 'missing').map(([id]) => id);
  }

  // P0：CFMMC 交叉验证结果（collector 写入 raw.json meta.cfmmcVerify）
  const cfmmcVerify = (rawJson && rawJson.meta && rawJson.meta.cfmmcVerify) || null;

  return {
    totalSymbols: symbols.length,
    latestBarDate,
    withLatestBar,
    barSources,
    fastClose,
    cfmmcVerify,
    collectedAt,
    sourceVersion,
    macro
  };
}

// freshness → markdown 卡片行（blockquote 风格，无行尾换行）
function renderFreshnessCard(f) {
  if (!f) return [];

  const lines = [];
  lines.push('> **数据时效说明**');
  lines.push('>');

  // 行情末 bar
  if (f.latestBarDate) {
    lines.push(`> - **行情数据**: ${f.withLatestBar}/${f.totalSymbols} 品种最后一根日线 = **${f.latestBarDate}**（完整 bar，收盘后口径）`);
  } else {
    lines.push(`> - **行情数据**: ${f.totalSymbols} 品种未取到有效日线`);
  }

  // 当日 bar 来源（快照通道 vs 日线接口）
  if (f.fastClose && f.fastClose.used) {
    const snapN = f.fastClose.appended || 0;
    const dailyN = f.barSources.akshare_sina_daily || 0;
    lines.push(`> - **当日 bar 来源**: ${snapN} 个由收盘快照通道补入（\`${f.fastClose.source || 'sina_close_snapshot'}\`：date==本地今日 + time≥15:00 + OHLC 自洽校验；实测与 CFMMC 官方日线一致）；${dailyN} 个来自日线接口`);
  } else {
    const note = (f.fastClose && f.fastClose.note) || '快照通道未启用或无需补入';
    lines.push(`> - **当日 bar 来源**: 全部来自 sina 日线接口（${note}）`);
  }

  // 当日 bar 验证（P0：CFMMC 交叉验证，divergence 记 provenance）
  if (f.cfmmcVerify && f.cfmmcVerify.summary) {
    const s = f.cfmmcVerify.summary;
    const parts = [];
    parts.push(`${s.verified}/${s.verified + s.diverged + s.unverified} 与 CFMMC 官方日线一致`);
    if (s.diverged > 0) {
      parts.push(`${s.diverged} 个偏离（超阈值，详见 provenance.lastBarVerification）`);
    }
    if (s.unverified > 0) {
      parts.push(`${s.unverified} 个未验证（DCE/CZCE 源未发布或接口失败，延后比对）`);
    }
    if (s.settleProvisionalCount > 0) {
      parts.push(`${s.settleProvisionalCount} 个结算价为快照口径（provisional，官方结算发布后以 CFMMC 为准，不修订历史）`);
    }
    lines.push('> - **当日 bar 验证**: ' + parts.join('；'));
  } else if (f.cfmmcVerify && f.cfmmcVerify.note) {
    lines.push('> - **当日 bar 验证**: 未执行（' + f.cfmmcVerify.note + '）');
  }

  // 宏观锚点 asOf 分布
  if (f.macro.available) {
    const parts = [];
    const total = f.macro.fresh.length + f.macro.stale.length + f.macro.missing.length;
    parts.push(`${f.macro.fresh.length + f.macro.stale.length}/${total} 可用`);
    if (f.macro.fresh.length) {
      parts.push(`${f.macro.fresh.join('/')} asOf ${f.macro.signalDate || '—'}`);
    }
    if (f.macro.stale.length) {
      const ids = f.macro.stale.map((s) => s.id).join('/');
      const asOfs = [...new Set(f.macro.stale.map((s) => s.asOf).filter(Boolean))].join('，');
      parts.push(`${ids} asOf ${asOfs || '—'}（源发布节奏滞后，表内已标 stale，不阻塞主链路）`);
    }
    if (f.macro.missing.length) {
      parts.push(`${f.macro.missing.join('/')} 缺失（不伪造）`);
    }
    lines.push('> - **宏观锚点**: ' + parts.join('；'));
  } else {
    lines.push('> - **宏观锚点**: 本 run 未采集宏观快照（宏观数据不可用）');
  }

  // 采集时刻 + 源版本
  if (f.collectedAt) {
    lines.push(`> - **采集时刻**: ${f.collectedAt}${f.sourceVersion ? `（源 akshare ${f.sourceVersion}）` : ''}`);
  }

  // 口径
  lines.push('> - **口径**: 日线接口仅返回完整 bar；夜盘归属下一交易日（源盖章）；快照通道 append-only，不覆盖历史 bar');
  lines.push('>');

  return lines;
}

module.exports = { buildFreshness, renderFreshnessCard };
