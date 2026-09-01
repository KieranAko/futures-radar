#!/usr/bin/env node
// scripts/git-push-policy.cjs — git 推送策略 v1（docs/git-push-policy.md）
//
// 用法:
//   node scripts/git-push-policy.cjs --check            # 只判定 PUSH/HOLD（不跑测试）
//   node scripts/git-push-policy.cjs --push             # check 通过 → npm test → push
//   node scripts/git-push-policy.cjs --push --emergency # T0 紧急通道（仍会跑测试）
//   node scripts/git-push-policy.cjs --push --milestone # 显式声明里程碑
//   node scripts/git-push-policy.cjs --check --min-commits 3 --min-lines 150 --max-hours 24
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const STATE_FILE = path.join(ROOT, '.git', 'futures-radar-push-policy.json');

function git(args) {
  const res = cp.spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  if (res.error) throw new Error(`git ${args.join(' ')} failed: ${res.error.message}`);
  return { stdout: res.stdout.trim(), stderr: res.stderr.trim(), code: res.status };
}

function flagVal(args, flag) {
  const i = args.indexOf(flag);
  return i === -1 ? null : args[i + 1];
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return null; }
}

function writeState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify({ ...state, lastPushAt: new Date().toISOString() }, null, 2) + '\n', 'utf8');
}

function unpushedSummary() {
  const ahead = git(['rev-list', '--count', 'origin/main..HEAD']);
  const behind = git(['rev-list', '--count', 'HEAD..origin/main']);
  const shortstat = git(['diff', '--shortstat', 'origin/main...HEAD']).stdout;
  const commits = git(['log', '--format=%H%x1f%s%x1f%b', 'origin/main..HEAD']).stdout
    .split('\n').filter(Boolean)
    .map((line) => {
      const [hash, subject, ...body] = line.split('\x1f');
      return { hash, subject, body: body.join('\n') };
    });
  let lines = 0;
  const m = shortstat.match(/(\d+) insertions?\(\+\)/);
  const d = shortstat.match(/(\d+) deletions?\(-\)/);
  if (m) lines += Number(m[1]);
  if (d) lines += Number(d[1]);
  return { ahead: Number(ahead.stdout), behind: Number(behind.stdout), lines, commits };
}

function hasMilestoneCommit(commits) {
  return commits.some((c) => /^feat[:(]/.test(c.subject) || /Push-Policy:\s*milestone/i.test(c.body));
}

/**
 * 纯策略判定（可测试）。
 */
function evaluatePolicy({ ahead, behind, lines, commits, lastPushAt, now = Date.now(), emergency = false, milestone = false, minCommits = 3, minLines = 150, maxHours = 24 }) {
  if (ahead === 0) return { verdict: 'HOLD', reasons: ['无未推送提交'] };
  if (behind > 0) return { verdict: 'HOLD', reasons: [`落后远端 ${behind} 个提交，禁止直接推送（先合并/变基）`] };
  if (emergency) return { verdict: 'PUSH', tier: 'T0', reasons: ['紧急通道：数据正确性/生产阻断修复'] };
  if (milestone || hasMilestoneCommit(commits)) return { verdict: 'PUSH', tier: 'T1', reasons: ['功能里程碑：feat 提交或显式 --milestone'] };
  if (ahead >= minCommits) return { verdict: 'PUSH', tier: 'T2', reasons: [`累计 ${ahead} 个提交 ≥ ${minCommits}`] };
  if (lines >= minLines) return { verdict: 'PUSH', tier: 'T2', reasons: [`累计 ${lines} 行变更 ≥ ${minLines}`] };
  const ageHours = lastPushAt ? Math.max(0, (now - Date.parse(lastPushAt)) / 3600000) : Infinity;
  if (lastPushAt && ageHours >= maxHours) return { verdict: 'PUSH', tier: 'T3', reasons: [`距上次推送 ${ageHours.toFixed(1)}h ≥ ${maxHours}h`] };
  return {
    verdict: 'HOLD',
    reasons: [
      `提交数 ${ahead}/${minCommits}`,
      `行数 ${lines}/${minLines}`,
      lastPushAt ? `距上次推送 ${ageHours.toFixed(1)}h/${maxHours}h` : '无上次推送记录'
    ]
  };
}

function collect() {
  const { ahead, behind, lines, commits } = unpushedSummary();
  const lastPushAt = readState()?.lastPushAt || null;
  const clean = git(['status', '--porcelain']).stdout === '';
  return { ahead, behind, lines, commits, lastPushAt, clean };
}

function check(args) {
  const info = collect();
  const policy = evaluatePolicy({
    ...info,
    emergency: args.includes('--emergency'),
    milestone: args.includes('--milestone'),
    minCommits: Number(flagVal(args, '--min-commits') || 3),
    minLines: Number(flagVal(args, '--min-lines') || 150),
    maxHours: Number(flagVal(args, '--max-hours') || 24)
  });
  if (!info.clean) {
    policy.verdict = 'HOLD';
    policy.reasons.push('工作区不干净（有未提交文件）');
  }
  return { ...info, ...policy };
}

function runTests() {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const res = cp.spawnSync(npm, ['test'], { cwd: ROOT, stdio: 'inherit', shell: true, windowsHide: true });
  return res.status === 0;
}

function push() {
  const before = collect();
  const res = git(['push', 'origin', 'main']);
  if (res.code !== 0) throw new Error(`git push failed: ${res.stderr || res.stdout}`);
  writeState({ commitsAtPush: before.ahead, linesAtPush: before.lines, commits: before.commits.map((c) => c.hash) });
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--push')) {
    const c = check(args);
    console.log(`push-policy: ${c.verdict}${c.tier ? ` (${c.tier})` : ''} — ${c.reasons.join('；')}`);
    if (c.verdict !== 'PUSH') process.exit(1);
    console.log('push-policy: running npm test...');
    if (!runTests()) {
      console.error('push-policy: npm test failed — push aborted');
      process.exit(1);
    }
    console.log('push-policy: git push origin main...');
    push();
    console.log('push-policy: pushed and state updated');
    return;
  }
  const c = check(args);
  console.log(`push-policy: ${c.verdict}${c.tier ? ` (${c.tier})` : ''}`);
  for (const r of c.reasons) console.log(`  - ${r}`);
  process.exit(c.verdict === 'PUSH' ? 0 : 1);
}

if (require.main === module) main();
module.exports = { evaluatePolicy, check, collect, main };
