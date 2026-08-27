// lib/workspace.cjs — futures-radar v0.1.0
// Unified path resolver. All scripts import this instead of hardcoding paths.
// Environment overrides: FUTURES_RUNTIME_ROOT, FUTURES_SKILL_ROOT

const fs = require('fs');
const path = require('path');

// ── Roots ──────────────────────────────────────────────────────
const skillRoot = process.env.FUTURES_SKILL_ROOT
  || (() => {
    let dir = __dirname;
    while (dir !== path.dirname(dir)) {
      if (fs.existsSync(path.join(dir, 'SKILL.md'))) return dir;
      dir = path.dirname(dir);
    }
    throw new Error('Cannot find futures-radar skill root (no SKILL.md found)');
  })();

function findProjectRoot(dir) {
  let d = dir;
  while (d !== path.dirname(d)) {
    if (fs.existsSync(path.join(d, 'package.json'))) return d;
    d = path.dirname(d);
  }
  return path.resolve(skillRoot, '../../..');
}

const runtimeRoot = process.env.FUTURES_RUNTIME_ROOT
  || path.join(findProjectRoot(skillRoot), 'data', 'futures-radar');

// ── Derived paths ──────────────────────────────────────────────
function runDir(runId) {
  return path.join(runtimeRoot, 'runs', runId);
}

function currentFile() {
  return path.join(runtimeRoot, 'current.md');
}

// ── HOME directory ─────────────────────────────────────────────
const homeDir = process.env.HOME || process.env.USERPROFILE || null;

module.exports = { skillRoot, runtimeRoot, runDir, currentFile, homeDir };
