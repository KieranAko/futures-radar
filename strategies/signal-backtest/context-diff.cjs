// strategies/signal-backtest/context-diff.cjs — v5 变化检测器（确定性）
//
// 相邻锚点之间检测“实质性变化”。只有 changed=true 的锚点需要重跑完整 FinCoT；
// changed=false 的锚点在 FinCoT 文件里写 reusedFrom=<上一锚点日期>。
// 判定全部基于 bundle 行（已截断到锚点日），无未来数据。
'use strict';

const fs = require('fs');
const path = require('path');
const { V5 } = require('./context-bundle-builder.cjs');

const MACRO_IDS = ['DXY', 'USDCNH', 'US10Y', 'DR007', 'SC0'];
// 只有高影响事件触发完整 FinCoT 重跑；EIA 周度等例行数据不触发（已在 bundle 中供参考）
const HIGH_IMPACT = new Set(['fomc', 'opec_meeting']); // 政策冲击才强制重跑；数据发布仍作为上下文进入 bundle

function signOf(v) { return v == null ? 0 : (v > 0 ? 1 : v < 0 ? -1 : 0); }

function diffRowsWith(prev, curr, opts = {}) {
  const {
    macroMinAbs = 0.5,
    macroMinFlips = 2,
    sectorMinAbs = 1.0,
    momentumMinAbs = 2.0,
    highImpact = HIGH_IMPACT
  } = opts;
  const reasons = [];
  if (!prev) return { changed: true, reasons: ['first_anchor'] };

  // 1) 宏观 change5d 方向翻转（单个指标小波动不算，需至少 2 个指标同向翻转）
  const macroFlips = [];
  for (const id of MACRO_IDS) {
    const p = prev.macro[id]; const c = curr.macro[id];
    const pv = p && p[2]; const cv = c && c[2];
    if (pv != null && cv != null && signOf(pv) !== signOf(cv) && signOf(cv) !== 0 && Math.abs(cv) >= macroMinAbs) {
      macroFlips.push(id);
    }
  }
  if (macroFlips.length >= macroMinFlips) reasons.push(`macro_flips:${macroFlips.join(',')}`);
  // 2) 板块 5 日方向翻转（幅度 >= 1%）
  if (prev.sect.r5 != null && curr.sect.r5 != null && signOf(prev.sect.r5) !== signOf(curr.sect.r5) && signOf(curr.sect.r5) !== 0 && Math.abs(curr.sect.r5) >= sectorMinAbs) {
    reasons.push('sector_flip:r5');
  }
  // 3) 价格均线位势翻转（close 与 MA20 的关系）
  if (signOf(prev.c - prev.m20) !== signOf(curr.c - curr.m20) && signOf(curr.c - curr.m20) !== 0) {
    reasons.push('price_ma20_cross');
  }
  // 4) 5 日动量方向翻转（幅度 >= 2%）
  if (signOf(prev.chg5) !== signOf(curr.chg5) && signOf(curr.chg5) !== 0 && Math.abs(curr.chg5) >= momentumMinAbs) {
    reasons.push('momentum_flip:chg5');
  }
  // 5) 本锚点窗口内有新的高影响事件
  const prevDate = prev.d;
  const newEvents = (curr.evt || []).filter(e => {
    const [mmdd, type] = e.split('|');
    return mmdd > prevDate.slice(5) && highImpact.has(type);
  });
  if (newEvents.length > 0) reasons.push(`new_event:${newEvents[0].split('|')[1]}`);
  return { changed: reasons.length > 0, reasons };
}

function diffRows(prev, curr) { return diffRowsWith(prev, curr); }

function buildDiff(symbol) {
  const bundle = JSON.parse(fs.readFileSync(path.join(V5, `bundle-${symbol}.json`), 'utf8'));
  const rows = bundle.rows;
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const d = diffRows(i > 0 ? rows[i - 1] : null, rows[i]);
    out.push({ date: rows[i].d, ...d, reusedFrom: d.changed ? null : rows[i - 1].d });
  }
  return out;
}

function buildAll() {
  const manifest = { schema: 'futures-radar-context-diff/1', generatedAt: new Date().toISOString(), symbols: [] };
  for (const sym of ['RB0', 'M0', 'SC0']) {
    const diff = buildDiff(sym);
    const p = path.join(V5, `diff-${sym}.json`);
    fs.writeFileSync(p, JSON.stringify({ schema: 'futures-radar-context-diff/1', symbol: sym, rows: diff }, null, 2), 'utf8');
    manifest.symbols.push({ symbol: sym, path: `diff-${sym}.json`, changed: diff.filter(d => d.changed).length, reused: diff.filter(d => !d.changed).length });
  }
  fs.writeFileSync(path.join(V5, 'diff-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return manifest;
}

if (require.main === module) console.log(JSON.stringify(buildAll(), null, 2));

module.exports = { diffRows, diffRowsWith, buildDiff, buildAll };
