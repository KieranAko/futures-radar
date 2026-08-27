/**
 * collector/akshare-macro.test.js — 数据源适配器 spec 传递测试
 *
 * 真实验证暴露的 bug：akshare 源需要 signalDate 推算起始日期，
 * 但 fetchSeries 未把它合并进传给 Python 脚本的 spec（KeyError 'signalDate'）。
 * 用 Node 假采集脚本替代 Python，断言 spec 内容逐字透传。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { fetchSeries } = require('../collector/akshare-macro.cjs');

function makeFakeScript(tmp) {
  const p = path.join(tmp, 'fake-macro-fetcher.cjs');
  fs.writeFileSync(p, [
    "const spec = JSON.parse(process.argv[process.argv.indexOf('--spec') + 1]);",
    "process.stdout.write(JSON.stringify({ ok: true, kind: spec.kind, spec: spec, series: [['2026-08-25', 1.0]], fetchedAt: '2026-08-26T06:00:00Z' }));",
  ].join('\n'));
  return p;
}

describe('akshare-macro fetchSeries', () => {
  it('把 signalDate 合并进传给采集脚本的 spec（akshare 源需要起始日期）', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'akshare-macro-test-'));
    const scriptPath = makeFakeScript(tmp);
    const res = fetchSeries(
      { kind: 'akshare_bond_zh_us_rate', field: '美国国债收益率10年' },
      { pythonCmd: process.execPath, scriptPath, signalDate: '2026-08-25' }
    );
    assert.strictEqual(res.ok, true, JSON.stringify(res));
    assert.strictEqual(res.spec.signalDate, '2026-08-25');
    assert.strictEqual(res.spec.field, '美国国债收益率10年');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('无 signalDate 时 spec 原样传递（sina_fx 不需要）', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'akshare-macro-test-'));
    const scriptPath = makeFakeScript(tmp);
    const res = fetchSeries(
      { kind: 'sina_fx', symbol: 'DINIW' },
      { pythonCmd: process.execPath, scriptPath }
    );
    assert.strictEqual(res.ok, true, JSON.stringify(res));
    assert.strictEqual(res.spec.signalDate, undefined);
    assert.strictEqual(res.spec.symbol, 'DINIW');
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
