/**
 * Test: Forward CLI — 命令面不变量（exit code / 输出契约）
 *
 * Spec (缅因猫 2026-08-24 不变量审计):
 * - register：旧日期/重复 → exit 1；合法 → exit 0 + ok JSON
 * - settle：成熟快照 → exit 0 + ok JSON；错误 → exit 1
 * - status：exit 0 + 摘要 JSON
 * - 未知命令 → exit 1
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  DATE_MAIN,
  RAW_MAIN,
  TRUNC_MAIN,
  createFreshManifest
} from './helpers/forward-fixtures.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(__dirname, '..', 'forward-cli.js');
const EXPERIMENTS_DIR = path.join(__dirname, '..');

function runCli(args) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: EXPERIMENTS_DIR,
    encoding: 'utf8'
  });
}

function writeRawFile(raw) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forward-cli-'));
  const p = path.join(dir, 'raw.json');
  fs.writeFileSync(p, JSON.stringify(raw), 'utf8');
  return p;
}

test('register before freeze date -> exit 1 with boundary message', () => {
  const { manifestPath } = createFreshManifest();
  const rawPath = writeRawFile(TRUNC_MAIN);
  const res = runCli(['register', rawPath, '2026-08-05', '--manifest', manifestPath]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /before/i);
});

test('register valid date -> exit 0 with ok JSON', () => {
  const { manifestPath } = createFreshManifest();
  const rawPath = writeRawFile(TRUNC_MAIN);
  const res = runCli(['register', rawPath, DATE_MAIN, '--manifest', manifestPath]);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.signalDate, DATE_MAIN);
  assert.equal(out.main.candidateCount, 4);
});

test('duplicate register -> exit 1', () => {
  const { manifestPath } = createFreshManifest();
  const rawPath = writeRawFile(TRUNC_MAIN);
  assert.equal(runCli(['register', rawPath, DATE_MAIN, '--manifest', manifestPath]).status, 0);
  const res = runCli(['register', rawPath, DATE_MAIN, '--manifest', manifestPath]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /duplicate|already/i);
});

test('settle mature raw -> exit 0 with ok JSON', () => {
  const { manifestPath } = createFreshManifest();
  const regRaw = writeRawFile(TRUNC_MAIN);
  const fullRaw = writeRawFile(RAW_MAIN);
  assert.equal(runCli(['register', regRaw, DATE_MAIN, '--manifest', manifestPath]).status, 0);
  const res = runCli(['settle', fullRaw, DATE_MAIN, '--manifest', manifestPath]);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.driftStatus, 'ok');
  assert.ok(out.mainTrades >= 1);
});

test('status -> exit 0 with registered/settled counts', () => {
  const { manifestPath } = createFreshManifest();
  const res = runCli(['status', '--manifest', manifestPath]);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.registered, 0);
});

test('unknown command -> exit 1', () => {
  const { manifestPath } = createFreshManifest();
  const res = runCli(['frobnicate', '--manifest', manifestPath]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /unknown/i);
});
