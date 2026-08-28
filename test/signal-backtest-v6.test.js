import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { isBannedCombo } = require('../strategies/signal-backtest/runner.cjs');

const ROOT = path.resolve(__dirname, '..', 'strategies', 'signal-backtest');
const OUTPUT = path.join(ROOT, 'output');

describe('v6 safe engine baseline', () => {
  it('produces three-arm comparison with v5 old-engine reference and gate reasons', () => {
    const p = path.join(OUTPUT, 'signal-quality-baseline-v6.json');
    assert.ok(fs.existsSync(p), 'run `node strategies/signal-backtest/runner-v6.cjs` first');
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.equal(j.schema, 'futures-radar-signal-backtest/6');
    assert.equal(j.meta.engine, 'v6-safe');
    for (const arm of ['A', 'B', 'C']) {
      assert.ok(j.arms[arm] && Array.isArray(j.signals[arm]), `missing arm ${arm}`);
      assert.ok(j.oldArms[arm] && j.oldArms[arm].aggregate, `missing old arm ${arm}`);
      assert.ok(j.gateReasons[arm].length > 0, `${arm} should record gate skips`);
    }
    const md = fs.readFileSync(path.join(OUTPUT, 'signal-quality-baseline-v6.md'), 'utf8');
    assert.match(md, /v6 安全引擎/);
    assert.match(md, /v5 原引擎 vs v6 安全引擎/);
    assert.match(md, /闸命中统计/);
  });

  it('reproduces the attributed C-arm safety outcomes without look-ahead', () => {
    const j = JSON.parse(fs.readFileSync(path.join(OUTPUT, 'signal-quality-baseline-v6.json'), 'utf8'));
    const c = j.signals.C;
    // #2 SC0 04-17 冲击冲突追空 → G1 拦截
    const g1 = c.find(s => s.symbol === 'SC0' && s.signalDate === '2026-04-17');
    assert.equal(g1.status, 'gate_skipped');
    assert.ok(g1.gateReasons.some(r => r.startsWith('g1_shock_conflict')));
    // #3 SC0 08-17 追涨 → G2 确认距离拦截
    const g2 = c.find(s => s.symbol === 'SC0' && s.signalDate === '2026-08-17');
    assert.equal(g2.status, 'gate_skipped');
    assert.ok(g2.gateReasons.some(r => r.startsWith('g2_confirmation_too_far')));
    // #1 RB0 06-30 → 3 日确认退出，小赚离场
    const t1 = c.find(s => s.symbol === 'RB0' && s.signalDate === '2026-06-30');
    assert.equal(t1.status, 'verified');
    assert.equal(t1.exitType, 'time_stop_3d');
    assert.ok(t1.pnlPct > -1 && t1.pnlPct < 1);
    // #4 SC0 06-24 三层共振赢单保留
    const t4 = c.find(s => s.symbol === 'SC0' && s.signalDate === '2026-06-24');
    assert.equal(t4.status, 'verified');
    assert.equal(t4.directionCorrect, true);
    assert.ok(t4.pnlPct > 5);
    // 所有信号无禁用参数组合
    for (const s of c) assert.ok(!isBannedCombo(s), `banned combo ${s.symbol} ${s.signalDate}`);
  });
});
