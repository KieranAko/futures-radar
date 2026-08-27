#!/usr/bin/env node
/**
 * futures-radar 一键安装：把本仓库接入 agent 的 skills 目录。
 * 默认目标：~/.claude/skills/futures-radar
 * Windows 优先目录联接（junction，无需管理员），Unix 优先符号链接；失败回退复制。
 *
 * 用法：
 *   node scripts/install.mjs
 *   node scripts/install.mjs --target <目录>      # 自定义 skills 目录（如 ~/.agents/skills）
 *   node scripts/install.mjs --copy                # 强制复制（不建链接）
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const flagVal = (f) => { const i = args.indexOf(f); return i === -1 ? null : args[i + 1]; };
const targetArg = flagVal('--target');
const forceCopy = args.includes('--copy');

const home = os.homedir();
const targetDir = targetArg
  ? path.resolve(targetArg.replace(/^~/, home))
  : path.join(home, '.claude', 'skills');
const linkPath = path.join(targetDir, 'futures-radar');

if (!fs.existsSync(path.join(REPO_ROOT, 'SKILL.md'))) {
  console.error('FATAL: 请在 futures-radar 仓库根目录运行（找不到 SKILL.md）');
  process.exit(1);
}

fs.mkdirSync(targetDir, { recursive: true });

if (fs.existsSync(linkPath)) {
  console.log('目标已存在：' + linkPath + '（跳过，如需重建请先删除）');
  process.exit(0);
}

function tryLink() {
  if (process.platform === 'win32' && !forceCopy) {
    const r = spawnSync('cmd', ['/c', 'mklink', '/J', linkPath, REPO_ROOT], { encoding: 'utf8' });
    if (r.status === 0) return true;
    console.warn('junction 失败，尝试符号链接：' + (r.stderr || '').trim());
    const r2 = spawnSync('cmd', ['/c', 'mklink', '/D', linkPath, REPO_ROOT], { encoding: 'utf8' });
    if (r2.status === 0) return true;
    console.warn('符号链接失败，回退复制。');
  } else if (!forceCopy) {
    try {
      fs.symlinkSync(REPO_ROOT, linkPath, 'dir');
      return true;
    } catch (e) {
      console.warn('symlink 失败，回退复制：' + e.message);
    }
  }
  return false;
}

if (tryLink()) {
  console.log('✓ 已链接：' + linkPath + ' → ' + REPO_ROOT);
} else {
  fs.cpSync(REPO_ROOT, linkPath, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(REPO_ROOT, src);
      if (rel === '') return true;
      const parts = rel.split(path.sep);
      if (parts[0] === '.git' || parts.includes('node_modules') || parts.includes('__pycache__')) return false;
      // data/ 只复制 README.md；运行数据目录不复制（安装后由 store:init/seed 生成）
      if (parts[0] === 'data' && rel !== path.join('data', 'README.md')) return false;
      if (rel.endsWith('.log')) return false;
      return true;
    }
  });
  console.log('✓ 已复制：' + linkPath);
}
console.log('安装完成。前置检查：node collector/probe-sources.cjs');
console.log('（在 ' + REPO_ROOT + ' 或安装目录均可运行，脚本自动定位 skillRoot）');
