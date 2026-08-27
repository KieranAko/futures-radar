// test/probe-reuse.test.js — P2 探针复用单元测试（临时目录夹具）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pr from '../collector/probe-reuse.cjs';
const { readFreshProbeIfValid } = pr;

function makeProbe(checkedAt, verdict = 'ok') {
  return { meta: { checkedAt }, summary: { verdict, available: ['akshare'], degraded: [] } };
}

function writeProbe(dir, probe) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'source-probe.json'), JSON.stringify(probe));
}

test('readFreshProbeIfValid: 窗口内 ok → 复用', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-probe-'));
  try {
    writeProbe(dir, makeProbe(new Date().toISOString()));
    const r = readFreshProbeIfValid(dir, { reuseMinutes: 30 });
    assert.equal(r.reused, true);
    assert.equal(r.probe.summary.verdict, 'ok');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('readFreshProbeIfValid: 过期 → 不复用', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-probe-'));
  try {
    writeProbe(dir, makeProbe(new Date(Date.now() - 31 * 60000).toISOString()));
    const r = readFreshProbeIfValid(dir, { reuseMinutes: 30 });
    assert.equal(r.reused, false);
    assert.match(r.reason, /too old/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('readFreshProbeIfValid: fatal → 不复用', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-probe-'));
  try {
    writeProbe(dir, makeProbe(new Date().toISOString(), 'fatal'));
    const r = readFreshProbeIfValid(dir, { reuseMinutes: 30 });
    assert.equal(r.reused, false);
    assert.match(r.reason, /fatal/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('readFreshProbeIfValid: 无文件/坏文件 → 不复用', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-probe-'));
  try {
    assert.equal(readFreshProbeIfValid(dir, {}).reused, false);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'source-probe.json'), 'junk');
    assert.equal(readFreshProbeIfValid(dir, {}).reused, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
