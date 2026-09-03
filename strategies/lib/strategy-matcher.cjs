// strategies/lib/strategy-matcher.cjs — Stage 8 (t8): 确定性 TOP3 策略匹配引擎
//
// 职责（按 strategies/strategy-matching-rules.json 实现）：
//   1. 加载并校验 strategy-library.json
//   2. 读取 run 已冻结 artifacts（report-model/probability/sector-snapshot/
//      sector-driver/macro-snapshot/analysis/raw/config/symbols）
//   3. 逐 TOP3 品种：策略匹配计分 → playbook 选择 → 风控层（positionSizing §9）
//      → 集中度仲裁 → 产出 strategy-plan.json v1.0（t7 契约）
//
// FORBIDDEN（t6 inputs.forbidden / t7 边界）：
//   - 不读取 ohlcv.openInterest / derived.avgOI5d 等任何 OI 字段
//   - 不联网、不调用 LLM、不使用 Math.random/时间戳（generatedAt 由输入派生）
//   - 不新增数据源、不使用未来数据、不输出收益承诺
// 纯函数核心（buildStrategyPlan 只读文件，不写文件）；CLI 见 build-strategy-plan.cjs

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { skillRoot, runDir } = require('../../lib/workspace.cjs');

// ── 常量（与 strategy-library.json riskConfig / risk-framework §9 一致） ──
const LIBRARY_PATH = () => path.join(skillRoot, 'strategies', 'strategy-library.json');
const RULES_PATH = () => path.join(skillRoot, 'strategies', 'strategy-matching-rules.json');
const PLAN_SCHEMA_PATH = () => path.join(skillRoot, 'report', 'strategy-plan.schema.json');
const SYMBOLS_PATH = () => path.join(skillRoot, 'config', 'symbols.json');

const RISK_CFG_DEFAULTS = {
  riskPerTradePct: 0.01,
  confidenceScale: { high: 1.0, medium: 0.75, low: 0 },
  volTargetPerPosition: 0.10,
  marginUtilizationCap: 0.33,
  stopK: { high: 2.0, medium: 1.5 },
  limitStopCap: 0.8,
  marginRate: 0.08,
  minRR: 1.5,
  volPercentileWarn: 85, // 百分数单位（与 report-model hv.percentile90d 一致）
  volPercentileSkip: 95,
  divergenceDegrade: 20, // 百分数单位（divergence.pct）
  singleSymbolMarginGate: 0.20,
  maxHoldingDays: 5,
  bookRiskCap: 0.025
};

// ── 风控参数单一真相源（t13 修复） ─────────────────────────────
// library.riskConfig 为权威值；RISK_CFG_DEFAULTS 仅作缺失键回退。
// 库中 volPercentileWarn/Skip、divergenceDegrade 为分数（0.85/0.95/0.20），
// matcher 内部用百分数（85/95/20）：<1 视为分数 ×100，≥1 视为百分数原值。
function effectiveRiskConfig(libRiskCfg) {
  const base = JSON.parse(JSON.stringify(RISK_CFG_DEFAULTS));
  if (!libRiskCfg || typeof libRiskCfg !== 'object') return base;
  const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  const pct = (v, fallback) => { const x = num(v, fallback); return x < 1 ? x * 100 : x; };
  const take = (obj, key, fallback) => {
    if (!obj || typeof obj !== 'object') return fallback;
    const v = obj[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  };
  base.riskPerTradePct = take(libRiskCfg.riskPerTradePct, 'default', base.riskPerTradePct);
  const cs = libRiskCfg.confidenceScale;
  if (cs && typeof cs === 'object') {
    base.confidenceScale = {
      high: num(cs.high, base.confidenceScale.high),
      medium: num(cs.medium, base.confidenceScale.medium),
      low: num(cs.low, base.confidenceScale.low)
    };
  }
  base.volTargetPerPosition = take(libRiskCfg.volTargetPerPosition, 'default', base.volTargetPerPosition);
  base.marginUtilizationCap = take(libRiskCfg.marginUtilizationCap, 'value', base.marginUtilizationCap);
  const sk = libRiskCfg.stopK;
  if (sk && typeof sk === 'object' && sk.byConfidence && typeof sk.byConfidence === 'object') {
    base.stopK = {
      high: num(sk.byConfidence.high, base.stopK.high),
      medium: num(sk.byConfidence.medium, base.stopK.medium)
    };
  }
  base.limitStopCap = take(libRiskCfg.limitStopCap, 'value', base.limitStopCap);
  base.marginRate = take(libRiskCfg.marginRateDefault, 'value', base.marginRate);
  base.minRR = take(libRiskCfg.minRR, 'value', base.minRR);
  base.volPercentileWarn = pct(take(libRiskCfg.volPercentileWarn, 'value', null), base.volPercentileWarn);
  base.volPercentileSkip = pct(take(libRiskCfg.volPercentileSkip, 'value', null), base.volPercentileSkip);
  base.divergenceDegrade = pct(take(libRiskCfg.divergenceDegrade, 'value', null), base.divergenceDegrade);
  base.singleSymbolMarginGate = take(libRiskCfg.singleSymbolMarginGate, 'value', base.singleSymbolMarginGate);
  base.maxHoldingDays = take(libRiskCfg.maxHoldingDays, 'default', base.maxHoldingDays);
  base.bookRiskCap = take(libRiskCfg.bookRiskCap, 'value', base.bookRiskCap);
  return base;
}

const MATCH_THRESHOLD = 1.5;
const FALLBACK_PRIORITY = ['PB-01', 'PB-03', 'PB-07', 'PB-08', 'PB-04', 'PB-05', 'PB-06'];
const BASE01 = {
  strategyId: 'BASE-01',
  name: '报告结论跟随（Q1+Q4+Q5 框架基线）',
  score: 0,
  matchEvidence: '无策略命中，按报告 Q1（驱动）+Q4（确认）+Q5（失效）框架基线适配',
  evidenceType: 'deterministic'
};

const EVENT_KEYWORDS = ['黑海', '粮道', '制裁', '减产', '极端天气', 'OPEC', '限产', '收储', '抛储', '地缘', '检修', '关税', '物流', '装置', '矿端', '运河', '拥堵', '航线', '天气', '管道', '安检', '环保'];
const MACRO_SHORT_KEYWORDS = ['宏观'];

const DISCLAIMER =
  '⚠️ 免责声明：本板块策略为分析工具输出，仅为方向增强与执行参考，不构成投资建议，不执行真实交易。' +
  '所有参数（手数/止损/目标）均为按示例权益的确定性风险计算演示，不含任何收益承诺或预期收益；' +
  '历史文献与样本内回测结论不代表未来表现。保证金与涨跌停以交易所当日公告为准。报告结论（方向/置信度）是第一依据，本板块不得反向修改。';

// ── 工具函数 ──────────────────────────────────────────────────
function round2(x) { return Math.round(x * 100) / 100; }
function floor1(x) { return Math.floor(x * 10) / 10; } // 截断 1 位小数（workedExample 口径）

function readJSON(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function sha256(str) { return crypto.createHash('sha256').update(str, 'utf8').digest('hex'); }

// ── 库校验（acceptance: 策略库 JSON 可加载并通过 schema 校验） ──
function validateLibrary(library) {
  const errors = [];
  if (!library || typeof library !== 'object') return { ok: false, errors: ['library is not an object'] };
  if (library.schemaVersion !== '1.0.0') errors.push('library.schemaVersion !== 1.0.0');
  for (const fam of ['macro', 'category', 'execution']) {
    const list = library.strategies && library.strategies[fam];
    if (!Array.isArray(list) || list.length === 0) {
      errors.push(`strategies.${fam} missing/empty`);
      continue;
    }
    const seen = new Set();
    for (const s of list) {
      if (!s.id) { errors.push(`${fam}: strategy missing id`); continue; }
      if (seen.has(s.id)) errors.push(`duplicate id ${s.id}`);
      seen.add(s.id);
      if (!s.name) errors.push(`${s.id}: missing name`);
      if (!Array.isArray(s.invalidation) || s.invalidation.length === 0) errors.push(`${s.id}: missing invalidation`);
      if (!Array.isArray(s.evidenceSources) || s.evidenceSources.length === 0) errors.push(`${s.id}: missing evidenceSources`);
      if (fam === 'execution') {
        if (!s.params || typeof s.params !== 'object') errors.push(`${s.id}: missing params`);
        if (s.defaultStatus && !['active', 'disabled'].includes(s.defaultStatus)) errors.push(`${s.id}: bad defaultStatus`);
      } else {
        if (!s.match || typeof s.match !== 'object') errors.push(`${s.id}: missing match`);
      }
    }
  }
  const rc = library.riskConfig;
  if (!rc) errors.push('riskConfig missing');
  else {
    for (const key of ['riskPerTradePct', 'confidenceScale', 'stopK', 'limitStopCap', 'marginUtilizationCap', 'maxHoldingDays', 'minRR', 'volPercentileWarn', 'volPercentileSkip', 'divergenceDegrade', 'drawdownLadder']) {
      if (rc[key] === undefined) errors.push(`riskConfig.${key} missing`);
    }
  }
  if (!library.positionSizing || !Array.isArray(library.positionSizing.steps) || library.positionSizing.steps.length < 6) {
    errors.push('positionSizing.steps missing/incomplete');
  }
  if (!library.planSchema || !Array.isArray(library.planSchema.guarantees) || library.planSchema.guarantees.length < 3) {
    errors.push('planSchema.guarantees missing/incomplete');
  }
  return { ok: errors.length === 0, errors };
}

// ── plan schema 校验（draft-07 子集：type/required/properties/items/enum/const/
//    pattern/minItems/maxItems/minimum/maximum/exclusiveMinimum/minLength/
//    additionalProperties:$ref/not{const}/type-array） ─────────────
function validatePlan(plan, schema, root) {
  const errors = [];
  const resolveRef = (node) => {
    if (!node || typeof node !== 'object') return null;
    if (node.$ref) {
      const p = node.$ref.replace(/^#\/definitions\//, '');
      return (root || schema).definitions[p] || null;
    }
    return node;
  };
  const check = (value, node, pth) => {
    if (!node) return;
    node = resolveRef(node) || node;
    if (node.const !== undefined && value !== node.const) {
      errors.push(`${pth}: expected const ${JSON.stringify(node.const)}, got ${JSON.stringify(value)}`);
      return;
    }
    if (node.not && node.not.const !== undefined && value === node.not.const) {
      errors.push(`${pth}: forbidden const ${node.not.const}`);
      return;
    }
    if (node.enum && !node.enum.includes(value)) errors.push(`${pth}: not in enum`);
    const t = node.type;
    if (t) {
      const types = Array.isArray(t) ? t : [t];
      const vt = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
      const typeOk = types.includes(vt) || (vt === 'number' && types.includes('integer'));
      if (!typeOk) { errors.push(`${pth}: type ${vt} not in [${types}]`); return; }
      if (types.includes('integer') && !Number.isInteger(value)) errors.push(`${pth}: expected integer`);
      if (types.includes('string')) {
        if (node.minLength !== undefined && value.length < node.minLength) errors.push(`${pth}: minLength`);
        if (node.pattern !== undefined && !new RegExp(node.pattern).test(value)) errors.push(`${pth}: pattern mismatch`);
      }
      if (types.includes('number') || types.includes('integer')) {
        if (node.minimum !== undefined && value < node.minimum) errors.push(`${pth}: < minimum ${node.minimum}`);
        if (node.maximum !== undefined && value > node.maximum) errors.push(`${pth}: > maximum ${node.maximum}`);
        if (node.exclusiveMinimum !== undefined && value <= node.exclusiveMinimum) errors.push(`${pth}: <= exclusiveMinimum`);
      }
      if (types.includes('array')) {
        if (node.minItems !== undefined && value.length < node.minItems) errors.push(`${pth}: minItems ${node.minItems}`);
        if (node.maxItems !== undefined && value.length > node.maxItems) errors.push(`${pth}: maxItems ${node.maxItems}`);
        if (node.items) for (let i = 0; i < value.length; i++) check(value[i], node.items, `${pth}[${i}]`);
      }
      if (types.includes('object')) {
        if (node.required) for (const r of node.required) {
          if (!(r in value)) errors.push(`${pth}: missing required ${r}`);
        }
        if (node.properties) for (const [k, sub] of Object.entries(node.properties)) {
          if (k in value) check(value[k], sub, `${pth}.${k}`);
        }
        if (node.additionalProperties === false) {
          const allowed = new Set([...(node.properties ? Object.keys(node.properties) : [])]);
          for (const k of Object.keys(value)) if (!allowed.has(k)) errors.push(`${pth}: unexpected key ${k}`);
        }
      }
    }
  };
  check(plan, schema, '$');
  return { ok: errors.length === 0, errors };
}

// ── artifacts 加载与 symbol 上下文 ────────────────────────────
function loadArtifacts(runDirPath) {
  const read = (name) => readJSON(path.isAbsolute(name) ? name : path.join(runDirPath, name));
  const mainSeriesPath = path.join(runDirPath, 'analyze', 'main-series.json');
  return {
    reportModel: read('report-model.json'),
    probability: read('probability.json'),
    sectorSnapshot: read('sector-snapshot.json'),
    sectorDriver: read('sector-driver.json'),
    macroSnapshot: read('macro-snapshot.json'),
    analysis: read('analysis.json'),
    raw: read('raw.json'),
    symbols: read(SYMBOLS_PATH()),
    mainSeries: fs.existsSync(mainSeriesPath) ? readJSON(mainSeriesPath) : {}
  };
}

function findSymbolCfg(symbolsJson, code) {
  const map = symbolsJson.symbols || symbolsJson;
  for (const v of Object.values(map)) {
    if (v && typeof v === 'object' && v.symbol === code) return v;
  }
  return null;
}

function top3Opportunities(reportModel) {
  // report-model.opportunities 即重点机会（第三章顺序）；rank 字段是 Top10 排名，不用于顺序
  const ops = Array.isArray(reportModel.opportunities) ? reportModel.opportunities : [];
  return ops.slice(0, 3).map((o, i) => ({ ...o, planRank: i + 1 }));
}

// ── 指标计算（t6 formulas） ───────────────────────────────────
function sma(values, n) {
  if (values.length < n) return null;
  const seg = values.slice(values.length - n);
  return seg.reduce((a, b) => a + b, 0) / n;
}
function ema(values, n) {
  if (values.length < 2) return null;
  const k = 2 / (n + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}
function computeIndicators(seriesClose, seriesHigh, seriesLow, seriesVolume, derived) {
  const last = seriesClose.length - 1;
  const close = seriesClose[last];
  const ma20 = sma(seriesClose, 20);
  const ma60 = sma(seriesClose, 60);
  const e20 = ema(seriesClose, 20);
  const e20Prev = ema(seriesClose.slice(0, last), 20);
  const ema20Slope = e20 !== null && e20Prev ? (e20 - e20Prev) / e20Prev : null;
  const high20 = seriesHigh.length >= 20 ? Math.max(...seriesHigh.slice(last - 19, last + 1)) : null;
  const low20 = seriesLow.length >= 20 ? Math.min(...seriesLow.slice(last - 19, last + 1)) : null;
  const avgV5 = seriesVolume.slice(last - 4, last + 1).reduce((a, b) => a + b, 0) / 5;
  const volumeRatio = seriesVolume[last] / avgV5;
  const change5d = derived && typeof derived.change5d === 'number' ? derived.change5d : null;
  const change1d = derived && typeof derived.change1d === 'number' ? derived.change1d : null;
  const trs = [];
  for (let i = Math.max(1, last - 6); i <= last; i++) {
    const tr = Math.max(seriesHigh[i] - seriesLow[i], Math.abs(seriesHigh[i] - seriesClose[i - 1]), Math.abs(seriesLow[i] - seriesClose[i - 1]));
    trs.push(tr);
  }
  const trToday = trs[trs.length - 1];
  const nr7 = trs.length >= 7 && trToday === Math.min(...trs);
  return { close, ma20, ma60, ema20Slope, high20, low20, volumeRatio, change5d, change1d, trToday, nr7 };
}

// 趋势对齐（t6 formulas.trendAlignment）：MS-01 专用
function trendAligned(direction, ind) {
  if (direction === 'bullish') return ind.close > ind.ma20 && ind.close > ind.ma60 && ind.change5d > 0;
  if (direction === 'bearish') return ind.close < ind.ma20 && ind.close < ind.ma60 && ind.change5d < 0;
  return false;
}

// riskOn/riskOff 评分（t6 formulas.riskOnScore）
function riskScores(macroIndicators) {
  let riskOn = 0, riskOff = 0;
  const stale = [];
  const rules = {
    DXY: (v) => { if (v < 0) riskOn++; else riskOff++; },
    US10Y: (v) => { if (v < 0.20) riskOn++; else riskOff++; },
    USDCNH: (v) => { if (v < 0) riskOn++; else riskOff++; },
    DR007: (x) => { const low = x.value < 2.0; if (low && x.change5d < 0.5) riskOn++; else if (!low || x.change5d >= 0.5) riskOff++; },
    SC0: (v) => { if (v > -1) riskOn++; else riskOff++; }
  };
  for (const [code, fn] of Object.entries(rules)) {
    const x = macroIndicators[code];
    if (!x) continue;
    if (x.status !== 'fresh') { stale.push(code); continue; }
    fn(code === 'DR007' ? { value: x.value, change5d: x.change5d } : x.change5d);
  }
  return { riskOn, riskOff, stale };
}

// ── 字段读取（t6 fieldResolution + library fieldCatalog 名称映射） ──
const FIELD_MAP = {
  rm: {
    driverPrimary: 'thesis.driver.primary',
    driverSecondary: 'thesis.driver.secondary',
    trendAssessment: 'thesis.trendOrImpulse.assessment',
    oddsReasoning: 'thesis.odds.reasoning',
    oddsBias: 'thesis.odds.bias',
    confirmSignals: 'thesis.confirmations.signals',
    invalidationConditions: 'thesis.invalidations.conditions',
    risks: 'thesis.risks.items',
    finalDirection: 'thesis.finalDirection',
    finalConfidence: 'thesis.finalConfidence',
    hvAnnual: 'marketFacts.hv.annual',
    hvPercentile90d: 'marketFacts.hv.percentile90d',
    hvDegraded: 'marketFacts.hv.degraded',
    atr5: 'priceRanges[0].atrBand.atr5',
    atrBand: 'priceRanges[0].atrBand.band',
    divergencePct: 'priceRanges[0].divergence.pct',
    divergenceInterpretation: 'priceRanges[0].divergence.interpretation',
    sector: 'sector'
  },
  ss: {
    sectorDirection: 'direction',
    sectorRet5d: 'ret5d',
    advanceRatio1d: 'advanceRatio1d',
    volumeRatio20d: 'volumeRatio20d',
    leaders: 'leaders',
    laggards: 'laggards'
  },
  sd: {
    directionObserved: 'direction_observed',
    driverPrimary: 'driver.primary',
    driverConfidence: 'driver.confidence'
  },
  pb: {
    cone3d: "cone['3d']",
    cone5d: "cone['5d']",
    hv95Band3d: 'atrComparison.hv95Band3d',
    atrComparison: 'atrComparison'
  },
  cfg: { symbolMeta: 'symbolMeta' }
};

function resolveField(fieldKey, ctx) {
  const dot = fieldKey.indexOf('.');
  const ns = dot === -1 ? fieldKey : fieldKey.slice(0, dot);
  const key = dot === -1 ? '' : fieldKey.slice(dot + 1);
  const pick = (obj, p) => (p ? p.split('.').reduce((a, k) => {
    if (a == null) return a;
    const m = k.match(/^(.+)\[(\d+)\]$/);
    return m ? a[m[1]]?.[Number(m[2])] : a[k];
  }, obj) : obj);
  switch (ns) {
    case 'rm': {
      const mapped = FIELD_MAP.rm[key] || key;
      return pick(ctx.rm, mapped);
    }
    case 'ss': {
      const sec = ctx.sectorSnapshot && ctx.sectorSnapshot.sectors && ctx.sectorSnapshot.sectors[ctx.rm.sector];
      return pick(sec, FIELD_MAP.ss[key] || key);
    }
    case 'sd': {
      const sec = ctx.sectorDriver && ctx.sectorDriver.sectors && ctx.sectorDriver.sectors[ctx.rm.sector];
      return pick(sec, FIELD_MAP.sd[key] || key);
    }
    case 'pb': {
      if (key === 'cone3d' || key === 'cone5d') {
        const d = key === 'cone3d' ? '3d' : '5d';
        return ctx.probEntry?.cone?.[d];
      }
      return pick(ctx.probEntry, FIELD_MAP.pb[key] || key);
    }
    case 'cfg':
      return ctx.symbolCfg;
    default:
      return undefined;
  }
}

// ── 操作符语义（t6 opSemantics） ──────────────────────────────
function evalCond(cond, value, reportDirection) {
  const v = value;
  // 'reportDirection' 语义值：板块方向（up/down/flat）与报告方向（bullish/bearish/neutral）归一比较
  if (cond.value === 'reportDirection') {
    const norm = v === 'up' ? 'bullish' : v === 'down' ? 'bearish' : v === 'flat' ? 'neutral' : v;
    if (cond.op === 'eq') return norm === reportDirection;
    if (cond.op === 'ne') return norm !== reportDirection;
    return false;
  }
  switch (cond.op) {
    case 'eq': return v === cond.value;
    case 'ne': return v !== cond.value;
    case 'gt': case 'gte': case 'lt': case 'lte': {
      const n = typeof v === 'number' ? v : parseFloat(v);
      if (Number.isNaN(n)) return false;
      if (cond.op === 'gt') return n > cond.value;
      if (cond.op === 'gte') return n >= cond.value;
      if (cond.op === 'lt') return n < cond.value;
      return n <= cond.value;
    }
    case 'matchesAny': {
      if (typeof v !== 'string' || !v) return false;
      return cond.values.some(kw => v.toLowerCase().includes(kw.toLowerCase()));
    }
    case 'matchesAll': {
      if (typeof v !== 'string' || !v) return false;
      return cond.values.every(kw => v.toLowerCase().includes(kw.toLowerCase()));
    }
    case 'containsNone': {
      if (typeof v !== 'string' || !v) return true;
      return !cond.values.some(kw => v.toLowerCase().includes(kw.toLowerCase()));
    }
    case 'exists':
      if (v === undefined || v === null) return false;
      if (Array.isArray(v)) return v.length > 0;
      return String(v).length > 0;
    case 'in':
      return Array.isArray(cond.value) && cond.value.includes(v);
    default:
      return false;
  }
}

// ── 文本抽取（t6 config parse 规则） ──────────────────────────
function parseFirstPct(text) {
  const m = text && String(text).match(/(\d+(?:\.\d+)?)\s*%/);
  return m ? parseFloat(m[1]) : null;
}
function parseStructuralStop(texts) {
  for (const t of texts || []) {
    const m = String(t).match(/MA20\s*[（(]?\s*约?\s*(\d+(?:\.\d+)?)/);
    if (m) return parseFloat(m[1]);
  }
  return null;
}
function parseFirstNumber(text) {
  if (!text) return null;
  // 优先取括号内的具体价位（如 MA20(7721.5)），避免误取指标名中的 20/60
  const paren = String(text).match(/[（(]\s*(\d+(?:\.\d+)?)\s*[)）]/);
  if (paren) return parseFloat(paren[1]);
  const m = String(text).match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}

// ── 策略匹配（t6 matching） ───────────────────────────────────
function evalStrategy(strategy, ctx, ind, formulas) {
  const dir = ctx.rm.thesis.finalDirection;
  const evidenceType = strategy.match.evidenceType || 'deterministic';
  // 板块门（sectors 非 * 时必须包含品种板块）
  if (strategy.sectors && !strategy.sectors.includes('*') && !strategy.sectors.includes(ctx.rm.sector)) {
    return { matched: false, reason: `板块 ${ctx.rm.sector} 不在适用板块` };
  }
  if (strategy.id === 'MS-01') {
    // t6：trendAlignment 公式匹配；预测区间不再作为趋势信号降级依据
    if (dir === 'neutral' || !trendAligned(dir, ind)) return { matched: false, reason: '趋势不对齐' };
    const score = round2(strategy.match.weight * 1.0 * confMult(strategy.confidenceHint));
    // t13：证据串符号按方向——bullish 用 '>'、bearish 用 '<'
    const sign = dir === 'bullish' ? '>' : '<';
    const ma60Text = ind.ma60 != null ? ind.ma60.toFixed(1) : '—';
    const chgText = ind.change5d != null ? `${ind.change5d > 0 ? '+' : ''}${ind.change5d.toFixed(2)}%` : '—';
    const evidence = `趋势对齐（close ${ind.close}${sign}MA20(${ind.ma20 != null ? ind.ma20.toFixed(1) : '—'})/MA60(${ma60Text}) 且 change5d ${chgText} 同向）`;
    return { matched: true, score, degradation: null, evidence };
  }
  if (strategy.id === 'MS-02') {
    const { riskOn, riskOff, stale } = formulas.riskScores;
    if (dir === 'bullish') {
      const sectorDir = ctx.sectorSnapshot && ctx.sectorSnapshot.sectors?.[ctx.rm.sector]?.direction;
      const adv = ctx.sectorSnapshot && ctx.sectorSnapshot.sectors?.[ctx.rm.sector]?.advanceRatio1d;
      if (riskOn < 3) return { matched: false, reason: `riskOn=${riskOn}<3` };
      if (sectorDir !== 'up') return { matched: false, reason: '板块方向与多头候选不一致' };
      if (!(adv >= 50)) return { matched: false, reason: `广度 ${adv}<50` };
    } else if (dir === 'bearish') {
      const driverOk = MACRO_SHORT_KEYWORDS.some(kw => String(ctx.rm.thesis.driver.primary || '').includes(kw));
      if (riskOff < 3) return { matched: false, reason: `riskOff=${riskOff}<3` };
      if (!driverOk) return { matched: false, reason: '空头腿未命中宏观驱动关键词' };
    } else {
      return { matched: false, reason: '方向中性' };
    }
    const score = round2(strategy.match.weight * 1.0 * confMult(strategy.confidenceHint));
    const legEvidence = dir === 'bearish'
      ? `riskOff=${riskOff} ≥3（stale 锚点: ${stale.length ? stale.join(',') : '无'}）；driver 命中宏观关键词`
      : `riskOn=${riskOn} ≥3；板块方向与广度共振`;
    return { matched: true, score, note: stale.length ? `stale 锚点: ${stale.join(',')}` : null, evidence: legEvidence };
  }
  if (strategy.id === 'MS-05') {
    // quadrantProxy：锚点矛盾 → 当日不匹配
    const conflict = formulas.quadrantConflict;
    if (conflict) return { matched: false, reason: '象限代理矛盾，当日不匹配' };
  }
  if (strategy.id === 'MS-07') {
    const sec = ctx.sectorSnapshot && ctx.sectorSnapshot.sectors && ctx.sectorSnapshot.sectors[ctx.rm.sector];
    if (!sec || sec.advanceRatio1d === undefined) return { matched: false, reason: '板块成员不足，不判定' };
  }
  // 通用求值：required 全真 + forbidden 全假
  const required = strategy.match.required || [];
  const forbidden = strategy.match.forbidden || [];
  let qual = false;
  for (const cond of required) {
    let v;
    if (cond.field === 'riskOnScore' || cond.field === 'riskOffScore') {
      v = formulas.riskScores[cond.field === 'riskOnScore' ? 'riskOn' : 'riskOff'];
    } else {
      v = resolveField(cond.field, ctx);
      // CS-02：季节性文本同时看主/次驱动
      if (strategy.id === 'CS-02' && cond.field === 'rm.driverPrimary') {
        v = `${ctx.rm.thesis.driver.primary || ''} ${ctx.rm.thesis.driver.secondary || ''}`;
      }
    }
    if (!evalCond(cond, v, dir)) return { matched: false, reason: `required 未通过: ${cond.field} ${cond.op}` };
    if (cond.evidenceType === 'qualitative') qual = true;
  }
  for (const cond of forbidden) {
    const v = resolveField(cond.field, ctx);
    if (evalCond(cond, v, dir)) return { matched: false, reason: `forbidden 命中: ${cond.field}` };
  }
  const evMult = (qual || evidenceType === 'qualitative') ? 0.5 : 1.0;
  const score = round2(strategy.match.weight * evMult * confMult(strategy.confidenceHint));
  return { matched: true, score, qualitative: evMult === 0.5 };
}

function confMult(hint) {
  return hint === 'high' ? 1.0 : hint === 'medium' ? 0.75 : 0.5;
}

function matchStrategies(library, ctx, ind, formulas) {
  const hits = [];
  for (const fam of ['macro', 'category']) {
    for (const s of library.strategies[fam]) {
      if (s.defaultStatus && s.defaultStatus !== 'active') continue;
      if (s.role === 'risk-overlay') continue; // MS-04 overlay 不参与匹配计分（t6）
      const r = evalStrategy(s, ctx, ind, formulas);
      if (!r.matched) continue;
      hits.push({
        strategyId: s.id,
        name: s.name,
        score: r.score,
        matchEvidence: r.evidence || (r.reason ? `${r.reason}` : buildEvidence(s, ctx, formulas)),
        evidenceType: r.qualitative ? 'qualitative' : 'deterministic',
        role: s.role,
        pairsWith: s.pairsWith || [],
        weight: s.match.weight || 0,
        _note: r.note || null
      });
    }
  }
  hits.sort((a, b) => b.score - a.score || (a.strategyId < b.strategyId ? -1 : 1));
  const thresholdHits = hits.filter(h => h.score >= MATCH_THRESHOLD);
  const matched = thresholdHits.slice(0, 3);
  // t13：top-3 截断后 score≥阈值的落选者并入 supportingEvidence（保留证据链并标注超出展示上限）
  const overflow = thresholdHits.slice(3).map(h => ({ ...h, matchEvidence: `（超出展示上限，保留证据链）${h.matchEvidence}` }));
  const supporting = [...overflow, ...hits.filter(h => h.score < MATCH_THRESHOLD)];
  return { matched, supporting };
}

function buildEvidence(strategy, ctx, formulas) {
  const parts = [];
  for (const cond of strategy.match.required || []) {
    let v;
    if (cond.field === 'riskOnScore' || cond.field === 'riskOffScore') {
      v = formulas && formulas.riskScores ? (cond.field === 'riskOnScore' ? formulas.riskScores.riskOn : formulas.riskScores.riskOff) : '—';
    } else {
      v = resolveField(cond.field, ctx);
    }
    const shown = Array.isArray(v) ? `${v.length} 项` : typeof v === 'string' ? v.slice(0, 40) : v;
    const opLabel = cond.op === 'exists' ? '非空' : cond.op === 'matchesAny' ? `包含 [${cond.values.join('/')}]` : `${cond.op} ${cond.value}`;
    parts.push(`${cond.field} ${opLabel} → 实值=${shown}`);
  }
  return parts.length > 0 ? parts.join('；') : `策略条件求值通过（${strategy.summary.slice(0, 50)}）`;
}

function pickPrimary(matched) {
  const order = { direction: 0, 'regime-filter': 1, 'evidence-tag': 2 };
  const roleOf = (m) => (m && order[m.role] !== undefined ? order[m.role] : 3);
  let best = matched[0];
  for (const m of matched.slice(1)) {
    if (roleOf(m) < roleOf(best) || (roleOf(m) === roleOf(best) && m.score > best.score)) best = m;
  }
  return best || matched[0];
}

// ── playbook 选择（t6 playbookSelection） ─────────────────────
function playbookStateGate(pbId, ctx, ind) {
  const dir = ctx.rm.thesis.finalDirection;
  const hvPct = ctx.rm.marketFacts?.hv?.percentile90d;
  const divPct = ctx.rm.priceRanges?.[0]?.divergence?.pct ?? 0;
  const atr5 = ctx.rm.priceRanges?.[0]?.atrBand?.atr5;
  const change1d = ind.change1d;
  const volRatio = ind.volumeRatio;
  const pass = (note) => ({ pass: true, note });
  const fail = (note) => ({ pass: false, note });
  switch (pbId) {
    case 'PB-01': {
      const ok = dir === 'bullish' ? (ind.close > ind.ma20 && ind.ema20Slope >= 0.003) : (ind.close < ind.ma20 && ind.ema20Slope <= -0.003);
      return ok ? pass('close 与 EMA20 斜率同向') : fail(`close${ind.close} vs MA20(${ind.ma20?.toFixed(1)})，ema20Slope=${(ind.ema20Slope * 100).toFixed(2)}%/日`);
    }
    case 'PB-03': {
      const ok = dir === 'bullish' ? (ind.close > ind.ma20 && ind.ma20 > ind.ma60) : (ind.close < ind.ma20 && ind.ma20 < ind.ma60);
      return ok ? pass('MA20/MA60 对齐') : fail(`MA20(${ind.ma20?.toFixed(1)}) vs MA60(${ind.ma60?.toFixed(1)})`);
    }
    case 'PB-07': {
      const driver = String(ctx.rm.thesis.driver.primary || '');
      const kw = EVENT_KEYWORDS.some(k => driver.includes(k));
      const conf = (ctx.rm.thesis.confirmations?.signals || []).length > 0;
      if (!kw) return fail('驱动未命中事件关键词');
      if (!conf) return fail('Q4 确认信号为空');
      const eventDay = change1d !== null && atr5 && (Math.abs(change1d) >= Math.max((2 * atr5 / ind.close) * 100, 3)); // change1d 为百分数
      return eventDay
        ? { pass: true, note: '事件日已确认', pending: false }
        : { pass: true, note: '事件日幅度未达标 → 触发 pending（转执行触发=Q4 确认信号）', pending: true };
    }
    case 'PB-08': {
      // 触发 pending：价格需位于 3d p68 沿 ±0.25×ATR5
      const cone3d = ctx.probEntry?.cone?.['3d'];
      const p68 = cone3d?.p68 || null;
      const near = p68 ? (dir === 'bullish' ? Math.abs(ind.close - p68[0]) : Math.abs(ind.close - p68[1])) : Infinity;
      const buff = 0.25 * atr5;
      const triggered = near <= buff;
      return triggered
        ? { pass: true, note: `价格位于 p68 沿 ±0.25×ATR5（触发）`, pending: false }
        : { pass: true, note: `价格未触及 3d p68 ${dir === 'bullish' ? '下' : '上'}沿（${p68 ? (dir === 'bullish' ? p68[0].toFixed(1) : p68[1].toFixed(1)) : '—'}）±0.25×ATR5 → 触发 pending`, pending: true };
    }
    case 'PB-04': {
      const ok = (hvPct !== undefined && hvPct <= 30) || ind.nr7;
      return ok ? pass(`HV%ile=${hvPct} 或 NR7`) : fail(`HV%ile=${hvPct} 且非 NR7`);
    }
    case 'PB-05': {
      const newDriver = String(ctx.rm.thesis.driver.primary || '').trim().length > 0;
      if (newDriver) return fail('存在当日驱动，均值回归前提不满足');
      if (hvPct !== undefined && hvPct > 85) return fail(`HV%ile=${hvPct}>85`);
      return pass('无新驱动且 HV%ile≤85');
    }
    case 'PB-06': {
      const boxW = ind.high20 !== null && ind.low20 !== null ? ind.high20 - ind.low20 : 0;
      const atr = ctx.rm.priceRanges?.[0]?.atrBand?.atr5 || 0;
      if (hvPct !== undefined && hvPct > 40) return fail(`HV%ile=${hvPct}>40`);
      if (boxW < 2.5 * atr) return fail(`箱宽 ${boxW.toFixed(0)} < 2.5×ATR5`);
      return pass('箱体条件满足');
    }
    default:
      return fail('未知 playbook');
  }
}

function selectPlaybook(library, matched, ctx, ind) {
  const cands = [];
  const seen = new Set();
  for (const m of matched) {
    for (const p of m.pairsWith || []) {
      if (p.startsWith('PB-') && !seen.has(p)) { seen.add(p); cands.push(p); }
    }
  }
  // pairsWith 候选全部失败 → 按 fallbackPriority 补齐求值（t6 playbookSelection）
  for (const p of FALLBACK_PRIORITY) if (!seen.has(p)) cands.push(p);
  const activePBs = new Set(
    (library.strategies.execution || []).filter(s => !s.defaultStatus || s.defaultStatus === 'active').map(s => s.id)
  );
  const pool = cands.filter(p => p !== 'PB-02' && activePBs.has(p));
  if (pool.length === 0) return { playbookId: 'PB-01', gateStatus: 'fail-open', gateNote: '无可用 playbook（PB-02 禁用）', triggerPending: true };
  for (const pbId of pool) {
    const gate = playbookStateGate(pbId, ctx, ind);
    if (gate.pass) {
      return { playbookId: pbId, gateStatus: gate.pending ? 'pending' : 'pass', gateNote: gate.note, triggerPending: !!gate.pending };
    }
  }
  const first = pool[0];
  const g = playbookStateGate(first, ctx, ind);
  return { playbookId: first, gateStatus: 'fail-open', gateNote: `状态门未满足（${g.note}）；plan 通常为 watch，转执行触发=Q4 确认信号`, triggerPending: true };
}

// ── 风控层（positionSizing §9，六步） ─────────────────────────
function riskLayer(ctx, ind, opts) {
  const rc = opts.rc || RISK_CFG_DEFAULTS; // t13：rc 由 library.riskConfig 归一而来（effectiveRiskConfig）
  const dir = ctx.rm.thesis.finalDirection;
  const customStopRaw = opts.customStopPrice;
  const customStopPrice = customStopRaw === null || customStopRaw === undefined || customStopRaw === ''
    ? null
    : (Number.isFinite(Number(customStopRaw)) ? Number(customStopRaw) : null);
  const conf = ctx.rm.thesis.finalConfidence || 'medium';
  const close = ind.close;
  const atr5 = ctx.rm.priceRanges?.[0]?.atrBand?.atr5 ?? 0;
  const hv = ctx.rm.marketFacts?.hv || {};
  const divPct = ctx.rm.priceRanges?.[0]?.divergence?.pct ?? 0;
  const mult = ctx.symbolCfg?.multiplier ?? 1;
  const equity = opts.equityCny;
  const limitPct = opts.limitPct;
  const structuralStop = opts.structuralStop;
  const cone3d = ctx.probEntry?.cone?.['3d'];
  const p95 = cone3d?.p95 || ctx.probEntry?.atrComparison?.hv95Band3d || null;
  // tailGapPct3d：p95 下沿相对 close 的向下距离（risk-framework §10 口径，负值=下行边距）
  const tailGapPct3d = p95 && p95[0] != null ? round2(((p95[0] - close) / close) * 100) : null;
  const tailMag = tailGapPct3d === null ? 0 : Math.abs(tailGapPct3d);

  const reasons = [];
  const notes = [];
  const confScale = rc.confidenceScale[conf] ?? 0;
  const stopK = rc.stopK[conf] ?? rc.stopK.medium;

  let lots = 0, status;
  let stopDistancePts = 0, stopPrice = 0, unitRiskCny = 0;

  // step 2：止损距离 = min(K×ATR5, 0.8×limitPct×close, |结构位−close|)
  //（neutral/low 置信的 watch 计划同样输出止损/失效参数，risk-framework §9 step 1）
  const capLimit = rc.limitStopCap * (limitPct / 100) * close;
  const structDist = structuralStop !== null ? Math.abs(structuralStop - close) : Infinity;
  if (customStopPrice !== null) {
    // Strategy-LLM 给出的理论失效位/概率尾止损：由 reasoning 决策，风控层只负责据此计算风险与手数
    stopDistancePts = Math.max(Math.abs(customStopPrice - close), 0.01);
    stopPrice = customStopPrice;
    notes.push('止损由 Strategy-LLM 根据报告 Q5/概率区间指定');
  } else {
    stopDistancePts = Math.max(Math.min(stopK * atr5, capLimit, structDist), 0.01);
    if (stopDistancePts === capLimit && capLimit < stopK * atr5) notes.push('止损受 0.8×涨跌停幅度约束');
    if (structDist !== Infinity && structDist <= stopDistancePts + 1e-9) notes.push(`结构位（Q5 MA20≈${structuralStop}）比 ATR 止损更近，采用结构位`);
    stopPrice = dir === 'bullish' ? close - stopDistancePts : close + stopDistancePts;
  }
  unitRiskCny = stopDistancePts * mult;

  if (dir === 'neutral' || conf === 'low' || confScale === 0) {
    status = 'watch';
    reasons.push(conf === 'low' ? '报告置信度为 low：只观察不持仓' : '报告方向中性：只观察不持仓');
  } else {
    // step 3：三路手数
    const lotsRisk = Math.floor((equity * rc.riskPerTradePct * confScale) / unitRiskCny);
    const lotsVol = Math.floor((equity * rc.volTargetPerPosition) / (hv.annual * close * mult));
    const lotsMargin = Math.floor((equity * rc.marginUtilizationCap) / (close * mult * rc.marginRate));
    lots = Math.min(lotsRisk, lotsVol, lotsMargin);
    // 风险预算不足 / 波动率目标否决（原因只列起约束作用的那一路；顺序按 workedExample）
    if (lotsRisk < 1) {
      const needEq = unitRiskCny / (rc.riskPerTradePct * confScale);
      reasons.unshift(`风险预算不足（medium 约需 ${floor1(needEq / 10000)} 万权益才到 1 手）`);
    } else if (lotsVol < 1) {
      const needEq = (hv.annual * close * mult) / rc.volTargetPerPosition;
      reasons.push(`波动率目标否决（lotsVol=0，约 ${floor1(needEq / 10000)} 万权益起 1 手）`);
    }
    // step 4：警示调整（预测区间由五模型参考区间给出，不再用 divergence 硬门禁）
    if (hv.degraded) {
      const degradedVol = Math.floor(lotsVol * 0.5);
      lots = Math.min(lots, degradedVol);
      reasons.push('HV 数据降级（vol cap ×0.5，手数仍由风险预算决定）');
    }
    if (hv.percentile90d !== undefined && hv.percentile90d >= rc.volPercentileSkip) {
      lots = 0;
      status = 'skip';
      reasons.push(`波动率分位 ${hv.percentile90d}≥95：跳过`);
    }
    if (hv.percentile90d !== undefined && hv.percentile90d >= rc.volPercentileWarn) {
      lots = Math.floor(lots / 2);
      if (conf !== 'high') {
        lots = 0;
        reasons.push(`波动率分位 ${hv.percentile90d}≥85 且非 high 置信`);
      } else {
        reasons.push(`波动率分位 ${hv.percentile90d}≥85：仓位减半`);
      }
    }
    if (tailMag >= limitPct && tailGapPct3d !== null) {
      lots = Math.floor(lots / 2);
      reasons.push(`尾部 3d p95 反向 ${tailGapPct3d.toFixed(1)}% ≥ 涨跌停 ${limitPct}%（连续停板警示）`);
    }
    // stressRisk：仅尾部超限情景下做额外减仓（risk-framework §10 口径：RM0 stress=1174 不触发减仓）
    if (tailMag >= limitPct && lots > 0) {
      const stressRisk = lots * mult * (limitPct / 100) * close;
      const budget = 1.5 * rc.riskPerTradePct * confScale * equity;
      if (stressRisk > budget) lots = Math.max(0, Math.floor(lots * (budget / stressRisk)));
    }
    // step 5：Hard 校验
    if (lots <= 0) {
      if (status !== 'skip') status = 'watch';
    } else {
      if ((lots * unitRiskCny) / equity > rc.riskPerTradePct) {
        lots = Math.floor((equity * rc.riskPerTradePct) / unitRiskCny);
        if (lots <= 0) { lots = 0; status = 'watch'; }
      }
      const marginPerLot = close * mult * rc.marginRate;
      if (marginPerLot > rc.singleSymbolMarginGate * equity) {
        lots = 0;
        status = 'watch';
        reasons.push(`资金不足（1 手保证金 ${Math.round(marginPerLot)} CNY > 20% 权益）`);
      }
    }
    if (lots > 0 && status !== 'skip') status = 'executable';
  }

  // step 6：盈亏比校验（仅对可执行候选；用 playbook T2 距离）
  const rr = opts.rrInfo; // {t2Distance, ok} 由调用方按 playbook 提供
  if (status === 'executable' && rr && rr.ok === false) {
    lots = 0;
    status = 'skip';
    reasons.push('风险回报比不足（<1.5）');
  }

  if (status !== 'skip' && status !== 'watch') {
    if (reasons.length === 0) reasons.push('全部 hard 校验与警示规则通过');
  }
  if (status === 'executable' && reasons.length === 0) reasons.push('风险参数在阈值内');

  const marginPerLot = close * mult * rc.marginRate;
  const marginUtilizationPct = round2((lots * marginPerLot) / equity * 100);
  const volContributionPctAnnual = round2(((lots * close * mult) / equity) * hv.annual * 100);
  const stressRiskCny = Math.round(lots * mult * (limitPct / 100) * close);

  return {
    riskAssessment: {
      riskPerTradePct: rc.riskPerTradePct,
      confidenceScale: confScale,
      stopK,
      stopDistancePts: round2(stopDistancePts),
      stopPrice: round2(stopPrice),
      structuralStop,
      unitRiskCny: round2(unitRiskCny),
      lots,
      marginPerLotCny: Math.round(marginPerLot),
      marginUtilizationPct,
      volContributionPctAnnual,
      tailGapPct3d,
      stressRiskCny,
      eventRiskNote: (ctx.analysisEntry?.q6_risks?.eventRisk) || '—',
      maxHoldingDays: rc.maxHoldingDays
    },
    executionStatus: status,
    statusReasons: reasons,
    notes
  };
}

// ── RR 目标距离（t6 playbook targets 口径） ───────────────────
function playbookRRInfo(pbId, ctx, ind, stopDistancePts) {
  const cone3d = ctx.probEntry?.cone?.['3d'];
  const p68 = cone3d?.p68 || null;
  const p95 = cone3d?.p95 || null;
  const dir = ctx.rm.thesis.finalDirection;
  let t2Distance = null;
  switch (pbId) {
    case 'PB-01': case 'PB-07': t2Distance = 3 * stopDistancePts; break;
    case 'PB-03': case 'PB-05': case 'PB-06': t2Distance = 2 * stopDistancePts; break;
    case 'PB-04': {
      const edge = p95 ? (dir === 'bullish' ? p95[1] - ind.close : ind.close - p95[0]) : null;
      t2Distance = Math.max(edge || 0, 2 * stopDistancePts);
      break;
    }
    case 'PB-08': {
      const edge = p95 ? (dir === 'bullish' ? p95[1] - ind.close : ind.close - p95[0]) : null;
      t2Distance = edge || 0;
      break;
    }
    default: t2Distance = 2 * stopDistancePts;
  }
  return { t2Distance, ok: stopDistancePts <= 0 || t2Distance <= 0 ? true : (t2Distance / stopDistancePts) >= 1.5 };
}

// PB-08 放弃条款：锥形止损（p95 反向沿 ±0.25×ATR5）> 1.5×T1 预期距离 → 当日放弃
function pb08AbandonNote(ctx, ind) {
  const cone3d = ctx.probEntry?.cone?.['3d'];
  const p68 = cone3d?.p68 || null;
  const p95 = cone3d?.p95 || null;
  if (!p68 || !p95) return null;
  const dir = ctx.rm.thesis.finalDirection;
  const atr5 = ctx.rm.priceRanges?.[0]?.atrBand?.atr5 ?? 0;
  const buffer = 0.25 * atr5;
  const pbStop = dir === 'bullish' ? (ind.close - (p95[0] - buffer)) : ((p95[1] + buffer) - ind.close);
  const t1Dist = dir === 'bullish' ? p68[1] - ind.close : ind.close - p68[0];
  if (pbStop > 1.5 * t1Dist) {
    return `PB-08 放弃条款：锥形止损距离 ${pbStop.toFixed(1)} > 1.5×T1 预期（${(1.5 * t1Dist).toFixed(1)}）→ 当日放弃，转执行触发=Q4 确认信号`;
  }
  return null;
}

// ── targets 文案 ──────────────────────────────────────────────
function buildTargets(pbId, ctx, ind) {
  const cone3d = ctx.probEntry?.cone?.['3d'];
  const p68 = cone3d?.p68 || null;
  const p95 = cone3d?.p95 || null;
  const dir = ctx.rm.thesis.finalDirection;
  const f = (x) => (x == null ? '—' : x.toFixed(1));
  switch (pbId) {
    case 'PB-01': return { t1: '2R（平 50%）', t2: '3R 或 3d p95 沿（先到者）', basis: 'R 口径' };
    case 'PB-03': return { t1: '前高/前低 或 3d p68 沿（先到者，平 50%）', t2: '2R–3R（余仓 1×ATR5 移动止损）', basis: 'R 口径' };
    case 'PB-04': return { t1: '2R（平 50%）', t2: `3d p95 ${dir === 'bullish' ? '上' : '下'}沿 ${f(dir === 'bullish' ? p95?.[1] : p95?.[0])}`, basis: 'R + 概率锥' };
    case 'PB-05': return { t1: 'MA20（平 50%）', t2: '2R（全平）', basis: 'R + MA20' };
    case 'PB-06': return { t1: '对侧边界（潜在盈利 ≥1.5R 才入场）', t2: '箱高 1:1 投影 或 2R（先到者）', basis: '箱体投影' };
    case 'PB-07': return { t1: `3d p95 ${dir === 'bullish' ? '上' : '下'}沿 ${f(dir === 'bullish' ? p95?.[1] : p95?.[0])}（平 50%）`, t2: '2× 事件区间投影 或 3R（先到者）', basis: '事件投影 + R' };
    case 'PB-08': return { t1: `3d p68 ${dir === 'bullish' ? '上' : '下'}沿 ${f(dir === 'bullish' ? p68?.[1] : p68?.[0])}（平 50%）`, t2: `3d p95 ${dir === 'bullish' ? '上' : '下'}沿 ${f(dir === 'bullish' ? p95?.[1] : p95?.[0])}`, basis: '概率锥区间' };
    default: return { t1: '—', t2: '—', basis: '—' };
  }
}

// ── plan 组装 ─────────────────────────────────────────────────
function buildPlanForSymbol({ library, ctx, ind, formulas, equityCny, limitPct, rank, rc, playbookTemplate, reasoning = null }) {
  const rm = ctx.rm;
  const dir = rm.thesis.finalDirection;
  const { matched, supporting } = matchStrategies(library, ctx, ind, formulas);
  const effectiveMatched = applyGuarantee(matched);
  const primary = pickPrimary(effectiveMatched);
  const pb = selectPlaybook(library, effectiveMatched, ctx, ind);
  const confirmSignals = rm.thesis.confirmations?.signals || [];
  const confirmText = (reasoning && reasoning.entry && reasoning.entry.triggerSource) || confirmSignals[0] || '—';
  const triggerLevel = reasoning && reasoning.entry && Number.isFinite(Number(reasoning.entry.triggerLevel))
    ? Number(reasoning.entry.triggerLevel)
    : parseFirstNumber(confirmText);
  const structuralStop = parseStructuralStop([...(rm.thesis.invalidations?.conditions || []), ctx.analysisEntry?.q5_invalidation ? JSON.stringify(ctx.analysisEntry.q5_invalidation) : '']);
  const rcEff = rc || RISK_CFG_DEFAULTS;
  const customStopPrice = reasoning && reasoning.stop && Number.isFinite(Number(reasoning.stop.stopPrice)) ? Number(reasoning.stop.stopPrice) : null;
  const stopDistEst = customStopPrice != null ? Math.abs(customStopPrice - ind.close) : riskLayerStubStop(ctx, ind, limitPct, structuralStop, rcEff);
  const rrInfo = playbookRRInfo(pb.playbookId, ctx, ind, stopDistEst);
  const risk = riskLayer(ctx, ind, { equityCny, limitPct, structuralStop, rrInfo, rc: rcEff, customStopPrice });
  const targets = buildTargets(pb.playbookId, ctx, ind);
  // PB-08 放弃条款：锥形止损（p95 反向沿 ±0.25×ATR5）> 1.5×T1 预期 → 当日放弃（gateNote 口径）
  const gateAbandonNote = pb.playbookId === 'PB-08' ? pb08AbandonNote(ctx, ind) : null;
  const playbookOut = gateAbandonNote ? { ...pb, gateNote: `${pb.gateNote}；${gateAbandonNote}` } : pb;
  const status = risk.executionStatus;
  const reasons = [...risk.statusReasons];
  if (gateAbandonNote) reasons.push(gateAbandonNote);

  // t13：执行条款按方向选择——bullish 省略空头专用约束（空头距涨停/空头反抽），
  // 替换为多头侧对等约束（多头距跌停/多头回踩持仓不塌）；bearish 反之。
  const longClause = '多头距跌停 <1×ATR5 禁开（Q6 口径）';
  const shortClause = '空头距涨停 <1×ATR5 禁开（Q6 口径）';
  const dirClause = dir === 'bullish' ? longClause : dir === 'bearish' ? shortClause : '方向中性：仅观察';
  let executionConvention;
  if (playbookOut.playbookId === 'PB-03') {
    executionConvention = dir === 'bullish'
      ? 'T+1 开盘；跳空 >0.75×ATR5 放弃；多头回踩要求持仓不塌（报告既有表述）'
      : 'T+1 开盘；跳空 >0.75×ATR5 放弃；空头反抽要求持仓不增（报告既有表述）';
  } else if (playbookOut.playbookId === 'PB-07') {
    executionConvention = `T+1 收盘确认（触发条件含收盘）；确认后下一交易日开盘执行；跳空 >0.75×ATR5 放弃；${dirClause}`;
  } else {
    executionConvention = `T+1 开盘；跳空 >0.5×ATR5 放弃；${dirClause}`;
  }
  const dirLabel = dir === 'bullish' ? '↑ 多' : dir === 'bearish' ? '↓ 空' : '→ 中性';
  const invalidation = rm.thesis.invalidations?.conditions || [];

  // Strategy-LLM 输出优先：报告驱动表达层的入场/止损/目标/理论匹配
  const reasoningEntry = reasoning && reasoning.entry ? reasoning.entry : null;
  const reasoningStop = reasoning && reasoning.stop ? reasoning.stop : null;
  const reasoningTargets = reasoning && reasoning.targets ? reasoning.targets : null;
  const reasoningConf = reasoning && reasoning.strategyConfidence ? reasoning.strategyConfidence : null;
  const reportConf = rm.thesis.finalConfidence || 'medium';
  const strategyConfidence = reasoningConf || reportConf;
  const entry = {
    trigger: (reasoningEntry && reasoningEntry.trigger) || `${dirLabel}：${confirmText}`,
    triggerLevel: reasoningEntry && reasoningEntry.triggerLevel != null ? reasoningEntry.triggerLevel : triggerLevel,
    triggerSource: (reasoningEntry && reasoningEntry.triggerSource) || confirmText,
    triggerTiming: (reasoningEntry && reasoningEntry.triggerTiming) || (dir === 'neutral'
      ? '无执行时点（观察）'
      : (pb.playbookId === 'PB-07'
        ? 'T+1 收盘确认；确认后下一交易日开盘执行'
        : 'T+1 开盘执行')),
    execution: (reasoningEntry && reasoningEntry.execution) || (pb.playbookId === 'PB-07'
      ? 'T+1 收盘确认；确认后下一交易日开盘执行；跳空 >0.75×ATR5 放弃'
      : (pb.playbookId === 'PB-03' ? 'T+1 开盘；跳空 >0.75×ATR5 放弃' : 'T+1 开盘；跳空 >0.5×ATR5 放弃'))
  };
  const stop = {
    stopPrice: risk.riskAssessment.stopPrice,
    stopDistancePts: risk.riskAssessment.stopDistancePts,
    basis: (reasoningStop && reasoningStop.basis) || `min(stopK×ATR5, 0.8×limitPct×close, |Q5 结构位−close|)${risk.notes.length ? '；' + risk.notes.join('；') : ''}`
  };
  const finalTargets = {
    t1: (reasoningTargets && reasoningTargets.t1) || targets.t1,
    t2: (reasoningTargets && reasoningTargets.t2) || targets.t2,
    basis: (reasoningTargets && reasoningTargets.basis) || targets.basis
  };
  const plan = {
    symbol: rm.symbol,
    name: rm.name,
    contract: ctx.contract || null,
    rank,
    sector: rm.sector,
    reportBaseline: {
      direction: dir,
      confidence: rm.thesis.finalConfidence || 'medium',
      driver: rm.thesis.driver?.primary || '',
      confirmSignals: [...confirmSignals],
      invalidationConditions: [...invalidation]
    },
    matchedStrategies: effectiveMatched.map(({ strategyId, name, score, matchEvidence, evidenceType }) => ({ strategyId, name, score, matchEvidence, evidenceType })),
    supportingEvidence: supporting.map(({ strategyId, name, score, matchEvidence, evidenceType }) => ({ strategyId, name, score, matchEvidence, evidenceType })),
    playbook: {
      playbookId: playbookOut.playbookId,
      gateStatus: playbookOut.gateStatus,
      gateNote: playbookOut.gateNote,
      executionConvention
    },
    entry,
    stop,
    targets: finalTargets,
    position: {
      lots: risk.riskAssessment.lots,
      lotsBasis: risk.lotsBasisNote || 'min(风险预算手数, 波动率目标手数, 保证金手数)'
    },
    riskAssessment: risk.riskAssessment,
    executionStatus: status,
    statusReasons: reasons,
    invalidation: {
      hard: [...invalidation],
      timeStop: 'T+5 无确认无失效则市价退出',
      supersededByNextRun: true
    },
    notes: [...risk.notes],
    disclaimer: DISCLAIMER
  };
  if (reasoning) {
    plan.strategyConfidence = strategyConfidence;
    plan.confidenceDowngradeReasons = Array.isArray(reasoning.confidenceDowngradeReasons) ? reasoning.confidenceDowngradeReasons : [];
    plan.theoryFit = reasoning.theoryFit || 'approximate';
    plan.theoryGapNote = reasoning.theoryGapNote || null;
    plan.reasoningRef = reasoning.reasoningRef || null;
  }
  return plan;
}

function riskLayerStubStop(ctx, ind, limitPct, structuralStop, rc) {
  const rcx = rc || RISK_CFG_DEFAULTS;
  const close = ind.close;
  const atr5 = ctx.rm.priceRanges?.[0]?.atrBand?.atr5 ?? 0;
  const conf = ctx.rm.thesis.finalConfidence || 'medium';
  const stopK = rcx.stopK[conf] ?? rcx.stopK.medium;
  const capLimit = rcx.limitStopCap * (limitPct / 100) * close;
  const structDist = structuralStop !== null ? Math.abs(structuralStop - close) : Infinity;
  return Math.min(stopK * atr5, capLimit, structDist);
}

// ── 集中度仲裁（t6 concentrationArbitration） ─────────────────
function arbitrateConcentration(plans) {
  const decisions = [];
  const groups = new Map();
  for (const p of plans) {
    if (p.executionStatus !== 'executable') continue;
    const key = `${p.sector}|${p.reportBaseline.direction}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    // 保留优先级：confidence → RR（T2/止损）→ rank
    const score = (p) => {
      const conf = p.reportBaseline.confidence === 'high' ? 2 : p.reportBaseline.confidence === 'medium' ? 1 : 0;
      const rr = p.riskAssessment.stopDistancePts > 0 ? (p._rrT2Distance || 0) / p.riskAssessment.stopDistancePts : 0;
      return { conf, rr, rank: -p.rank };
    };
    group.sort((a, b) => (score(b).conf - score(a).conf) || (score(b).rr - score(a).rr) || (score(b).rank - score(a).rank));
    const kept = group[0];
    const downgraded = group.slice(1);
    for (const d of downgraded) {
      d.executionStatus = 'watch';
      d.position.lots = 0;
      d.riskAssessment.lots = 0;
      d.statusReasons = [`集中度冲突：同板块同向仓位保留置信度更高/赔率更优者（${kept.symbol}）`, ...d.statusReasons.filter(r => !r.includes('全部 hard'))];
    }
    decisions.push({
      conflictGroup: key,
      keptSymbol: kept.symbol,
      downgradedSymbols: downgraded.map(d => d.symbol),
      reason: `同 sector 且同方向的可执行计划只能保留一个（置信度→RR→rank）`
    });
  }
  return decisions;
}

// ── 主入口：buildStrategyPlan ─────────────────────────────────
// 队长裁定保底（t6 guarantee）：matched 为空 → BASE-01 补足一条
function applyGuarantee(matched) {
  if (matched.length > 0) return matched;
  return [{ ...BASE01, role: 'direction', pairsWith: [], weight: 0 }];
}

function buildStrategyPlan({ runId, equityCny = 100000, reasoning = null }) {
  const library = readJSON(LIBRARY_PATH());
  const rules = readJSON(RULES_PATH());
  const schema = readJSON(PLAN_SCHEMA_PATH());
  const libCheck = validateLibrary(library);
  if (!libCheck.ok) throw new Error(`library validation failed: ${libCheck.errors.join('; ')}`);

  const runPath = runDir(runId);
  const artifacts = loadArtifacts(runPath);
  const tops = top3Opportunities(artifacts.reportModel);
  if (tops.length === 0) throw new Error(`run ${runId}: no TOP3 opportunities`);

  // signalDate 以 analysis.json 的分析日为准（行情收盘日），report-model.generatedAt 可能晚于行情日
  const signalDate = (artifacts.analysis.meta?.analyzedAt || artifacts.reportModel.meta?.generatedAt || '').slice(0, 10) || runId.slice(0, 8).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
  const inputFiles = [
    { name: 'report-model.json', p: path.join(runPath, 'report-model.json') },
    { name: 'probability.json', p: path.join(runPath, 'probability.json') },
    { name: 'sector-snapshot.json', p: path.join(runPath, 'sector-snapshot.json') },
    { name: 'sector-driver.json', p: path.join(runPath, 'sector-driver.json') },
    { name: 'macro-snapshot.json', p: path.join(runPath, 'macro-snapshot.json') },
    { name: 'analysis.json', p: path.join(runPath, 'analysis.json') },
    { name: 'raw.json', p: path.join(runPath, 'raw.json') },
    { name: 'config/symbols.json', p: SYMBOLS_PATH() }
  ];
  if (reasoning) {
    inputFiles.push({ name: 'strategy-reasoning.json', p: path.join(runPath, 'strategy-reasoning.json') });
  }
  const inputsSha = sha256(inputFiles.map(f => fs.readFileSync(f.p)).join('\n'));

  const macroIndicators = artifacts.reportModel.macro?.indicators || artifacts.macroSnapshot?.indicators || {};
  const scores = riskScores(macroIndicators);
  const quadrantConflict = (() => {
    // 通胀代理内部矛盾（SC0 方向 vs 农产品板块方向）→ 不稳定
    const sc0 = macroIndicators.SC0;
    const agDir = artifacts.sectorSnapshot?.sectors?.agriculture?.direction;
    if (sc0 && sc0.status === 'fresh' && agDir) {
      const sc0Down = sc0.change5d <= 0;
      const agUp = agDir === 'up';
      return sc0Down && agUp; // 一降一升 → 矛盾
    }
    return false;
  })();
  const formulas = { riskScores: scores, quadrantConflict };
  // t13：风控参数以 library.riskConfig 为权威（effectiveRiskConfig 归一），RISK_CFG_DEFAULTS 仅回退
  const effRc = effectiveRiskConfig(library.riskConfig);

  const plans = [];
  for (const op of tops) {
    const probEntry = (artifacts.probability.probabilities || []).find(p => p.symbol === op.symbol) || {};
    const contract = artifacts.raw?.contracts?.[op.symbol];
    const ohlcv = contract?.ohlcv;
    if (!ohlcv || !Array.isArray(ohlcv.close) || ohlcv.close.length < 21) {
      throw new Error(`${op.symbol}: raw.json ohlcv 序列不足（需要 ≥21 bars）`);
    }
    const ind = computeIndicators(ohlcv.close, ohlcv.high, ohlcv.low, ohlcv.volume, contract.derived);
    const analysisEntry = (artifacts.analysis.analyses && Object.values(artifacts.analysis.analyses).find(a => a.symbol === op.symbol)) || {};
    const symbolCfg = findSymbolCfg(artifacts.symbols, op.symbol) || { multiplier: 1 };
    const limitPct = parseFirstPct(analysisEntry.q6_risks?.limitDistance) || 4; // 保守默认 4%
    const ctx = {
      rm: op,
      probEntry,
      sectorSnapshot: artifacts.sectorSnapshot,
      sectorDriver: artifacts.sectorDriver,
      macroIndicators,
      analysisEntry,
      symbolCfg,
      rawContract: contract,
      contract: (artifacts.mainSeries && artifacts.mainSeries[op.symbol] && artifacts.mainSeries[op.symbol].contract) || null
    };
    const reasoningEntry = reasoning && Array.isArray(reasoning.strategies)
      ? reasoning.strategies.find((r) => r.symbol === op.symbol) || null
      : null;
    const plan = buildPlanForSymbol({ library, ctx, ind, formulas, equityCny, limitPct, rank: op.planRank, rc: effRc, reasoning: reasoningEntry });
    // 记录 RR 供集中度仲裁使用
    const stopDist = plan.riskAssessment.stopDistancePts;
    const rrInfo = playbookRRInfo(plan.playbook.playbookId, ctx, ind, stopDist);
    plan._rrT2Distance = rrInfo.t2Distance;
    // lotsBasis 明细（positionSizing §9 step 3 口径，用同一 effRc）
    const rc = effRc;
    const confScale = rc.confidenceScale[plan.reportBaseline.confidence] ?? 0;
    const lotsRisk = Math.floor((equityCny * rc.riskPerTradePct * confScale) / (plan.riskAssessment.unitRiskCny || Infinity));
    const lotsVol = Math.floor((equityCny * rc.volTargetPerPosition) / ((op.marketFacts?.hv?.annual || 0) * ind.close * (symbolCfg.multiplier || 1)));
    const lotsMargin = Math.floor((equityCny * rc.marginUtilizationCap) / (ind.close * (symbolCfg.multiplier || 1) * rc.marginRate));
    plan.position.lotsBasis = `min(风险预算 ${lotsRisk} 手, 波动率目标 ${lotsVol} 手, 保证金 ${lotsMargin} 手)`;
    plans.push(plan);
  }

  const concentrationDecisions = arbitrateConcentration(plans);
  for (const p of plans) delete p._rrT2Distance;

  const plan = {
    schemaVersion: '1.0.0',
    meta: {
      runId,
      signalDate,
      matcherVersion: '1.0.0',
      rulesVersion: rules.schemaVersion,
      libraryVersion: library.schemaVersion,
      equityCny,
      marginRate: effRc.marginRate,
      generatedAt: `${signalDate}T00:00:00.000Z`, // 确定性：由输入派生（无时间戳依赖）
      inputsSha
    },
    plans,
    concentrationDecisions,
    provenance: {
      source: `output/runs/${runId}/{report-model,probability,sector-snapshot,sector-driver,macro-snapshot,analysis,raw}.json + config/symbols.json`,
      generator: 'futures-radar/strategies/lib/strategy-matcher.cjs',
      discipline: [
        '无新增持仓(OI)数据依赖：Q4/Q5 既有持仓表述仅文本引用（未读取 ohlcv.openInterest/derived.avgOI5d）',
        '无前视：只使用信号日 T 及之前的已冻结值',
        '无收益承诺：不输出任何收益/胜率数字',
        '不修改报告方向与置信度'
      ]
    },
    disclaimer: DISCLAIMER
  };
  return { plan, schema };
}

module.exports = {
  buildStrategyPlan,
  validateLibrary,
  validatePlan,
  riskScores,
  trendAligned,
  computeIndicators,
  parseFirstPct,
  parseStructuralStop,
  parseFirstNumber,
  matchStrategies,
  selectPlaybook,
  arbitrateConcentration,
  applyGuarantee,
  effectiveRiskConfig,
  MATCH_THRESHOLD,
  FALLBACK_PRIORITY,
  DISCLAIMER
};
