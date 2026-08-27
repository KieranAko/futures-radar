#!/usr/bin/env node
/**
 * probe-sources.cjs — futures-radar source detection
 * Detects: akshare (primary scanner), mx-data (Top 3 enhancer), WebSearch (always available)
 *
 * Usage:
 *   node collector/probe-sources.cjs
 *   node collector/probe-sources.cjs --json
 *   node collector/probe-sources.cjs --runId <id>
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const os = require('os');
const { skillRoot } = require('../lib/workspace.cjs');

const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
function resolveHome(p) {
  if (!p) return p;
  return p.replace(/\$HOME/g, HOME);
}

function probeCmd(cmd, args, cwd, timeoutMs) {
  const t = timeoutMs || 30000;
  try {
    const r = spawnSync(cmd, args, { cwd: cwd || process.cwd(), timeout: t, encoding: 'utf8', windowsHide: true });
    return {
      ok: r.status === 0 && !r.error,
      stdout: (r.stdout || '').slice(0, 16000),
      stderr: (r.stderr || '').slice(0, 800),
      code: r.status,
      signal: r.signal,
      error: r.error ? r.error.message : null
    };
  } catch (e) {
    return { ok: false, stdout: '', stderr: '', code: null, error: e.message };
  }
}

// ── Probe: Python + akshare ──────────────────────────────────
function probeAkshare() {
  const result = {
    tool: 'akshare',
    role: 'primary_scanner',
    critical: true,
    status: 'not_installed',
    details: '',
    python: null,
    akshare: null,
    probeCheck: null
  };

  // Check Python
  const py = probeCmd('python', ['--version'], null, 10000);
  if (!py.ok) {
    result.details = 'Python not found or not on PATH';
    result.status = 'tool_missing';
    return result;
  }
  result.python = { version: py.stdout.trim() || 'unknown', ok: true };

  // Check akshare import
  const ak = probeCmd('python', ['-c', 'import akshare; print(akshare.__version__)'], null, 15000);
  if (!ak.ok) {
    result.akshare = { installed: false, error: ak.stderr.slice(0, 400) || ak.error || 'import failed' };
    result.details = `Python OK (${result.python.version}) but akshare not installed. Run: pip install akshare`;
    result.status = 'tool_missing';
    return result;
  }
  result.akshare = { installed: true, version: ak.stdout.trim() };

  // Lightweight probe: call futures_display_main_sina() to verify API works
  const probe = probeCmd('python', [
    '-c',
    'import akshare as ak; df = ak.futures_display_main_sina(); print(f"OK:{len(df)}")'
  ], null, 30000);
  result.probeCheck = {
    ok: probe.ok && probe.stdout.includes('OK:'),
    symbolCount: probe.ok ? parseInt((probe.stdout.match(/OK:(\d+)/) || [])[1]) || 0 : 0,
    stderr: probe.stderr.slice(0, 400)
  };

  if (result.probeCheck.ok && result.probeCheck.symbolCount > 0) {
    result.status = 'available';
    result.details = `akshare ${result.akshare.version}, ${result.probeCheck.symbolCount} contracts via futures_display_main_sina()`;
  } else {
    result.status = 'probe_failed';
    result.details = 'akshare import OK but futures_display_main_sina() probe failed';
  }

  return result;
}

// ── Probe: mx-data ───────────────────────────────────────────
function probeMxData() {
  const result = {
    tool: 'mx-data',
    role: 'top3_enhancer',
    critical: false,
    status: 'not_installed',
    details: '',
    scriptPath: null,
    apiKeySet: false
  };

  // Find mx_data.py — check known locations (env override wins)
  const candidates = [
    process.env.MX_DATA_PATH,
    path.join(skillRoot, '..', 'mx-data', 'mx_data.py'),                        // skill 根目录的兄弟目录
    path.join(HOME || '', '.agents', 'skills', 'mx-data', 'mx_data.py'),
    path.join(HOME || '', '.claude', 'skills', 'mx-data', 'mx_data.py'),
    path.resolve(__dirname, '..', '..', '..', '..', 'skills', 'mx-data', 'mx_data.py') // 传统 <project>/skills 布局
  ].filter(Boolean);
  let scriptPath = null;
  for (const p of candidates) {
    if (fs.existsSync(p)) { scriptPath = p; break; }
  }

  if (!scriptPath) {
    result.details = 'mx_data.py not found in known locations';
    result.status = 'path_missing';
    return result;
  }
  result.scriptPath = scriptPath;

  // Check MX_APIKEY
  result.apiKeySet = !!process.env.MX_APIKEY;

  if (!result.apiKeySet) {
    result.details = `mx_data.py found at ${scriptPath} but MX_APIKEY env var not set`;
    result.status = 'auth_missing';
    return result;
  }

  result.status = 'available';
  result.details = `mx_data.py at ${scriptPath}, MX_APIKEY set`;
  return result;
}

// ── Probe: WebSearch ─────────────────────────────────────────
function probeWebSearch() {
  return {
    tool: 'websearch',
    role: 'top3_enhancer',
    critical: false,
    status: 'available',
    details: 'WebSearch always available in CLI environment'
  };
}

// ── main ─────────────────────────────────────────────────────
function main() {
  const args = process.argv.slice(2);
  const jsonFlag = args.includes('--json');
  const reuseIfFresh = args.includes('--reuse-if-fresh');
  const runIdIdx = args.indexOf('--runId');
  const runId = runIdIdx >= 0 ? args[runIdIdx + 1] : null;

  // P2：窗口内探针复用（已有 source-probe.json 且非 fatal 且未过期 → 不重打探针端点）
  if (reuseIfFresh && runId) {
    const { runtimeRoot } = require('../lib/workspace.cjs');
    const { readFreshProbeIfValid } = require('./probe-reuse.cjs');
    const reuse = readFreshProbeIfValid(path.join(runtimeRoot, 'runs', runId));
    if (reuse.reused) {
      const p = reuse.probe;
      console.log('=== futures-radar 前置探测（窗口内复用） ===');
      console.log(`时间: ${p.meta.checkedAt}（${reuse.reason}）`);
      console.log(`判定: ${p.summary.verdict}`);
      console.log(`可用: [${p.summary.available.join(', ')}]`);
      if (p.summary.degraded && p.summary.degraded.length) console.log(`降级: [${p.summary.degraded.join(', ')}]`);
      process.exit(0);
    }
    console.log(`(probe reuse skipped: ${reuse.reason})`);
  }

  const results = {
    checkedAt: new Date().toISOString(),
    sources: {
      akshare: probeAkshare(),
      mxdata: probeMxData(),
      websearch: probeWebSearch()
    }
  };

  // ── Summary ──────────────────────────────────────────────
  const critical = ['akshare'];
  const criticalAvailable = critical.filter(t => results.sources[t].status === 'available');
  const criticalMissing = critical.filter(t => results.sources[t].status !== 'available');

  results.summary = {
    available: Object.entries(results.sources)
      .filter(([, v]) => v.status === 'available')
      .map(([k]) => k),
    degraded: Object.entries(results.sources)
      .filter(([, v]) => v.status !== 'available' && v.status !== 'not_installed')
      .map(([k]) => k),
    unavailable: Object.entries(results.sources)
      .filter(([, v]) => v.status === 'not_installed' || v.status === 'path_missing')
      .map(([k]) => k),
    verdict: criticalMissing.length === critical.length ? 'fatal'
      : criticalMissing.length > 0 ? 'degraded'
      : 'ok'
  };

  // ── Output ────────────────────────────────────────────────
  if (jsonFlag) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  console.log('=== futures-radar 前置探测 ===');
  console.log(`时间: ${results.checkedAt}\n`);

  for (const [id, r] of Object.entries(results.sources)) {
    const icon = r.status === 'available' ? '[OK]'
      : r.status === 'probe_failed' ? '[WARN]'
      : r.status === 'auth_missing' ? '[AUTH]'
      : '[MISS]';
    const crit = r.critical ? ' (CRITICAL)' : '';
    console.log(`${icon} ${r.tool}${crit}: ${r.status}`);
    console.log(`   ${r.details}`);
    if (r.akshare) {
      console.log(`   akshare version: ${r.akshare.version || 'N/A'}`);
    }
    if (r.probeCheck) {
      console.log(`   probe: ${r.probeCheck.ok ? r.probeCheck.symbolCount + ' contracts' : 'FAILED'}`);
    }
    console.log();
  }

  console.log(`判定: ${results.summary.verdict}`);
  console.log(`可用: [${results.summary.available.join(', ')}]`);
  if (results.summary.degraded.length) console.log(`降级: [${results.summary.degraded.join(', ')}]`);
  if (results.summary.unavailable.length) console.log(`不可用: [${results.summary.unavailable.join(', ')}]`);

  // ── Write source-probe.json ───────────────────────────────
  if (runId) {
    const { runtimeRoot } = require('../lib/workspace.cjs');
    const runDir = path.join(runtimeRoot, 'runs', runId);
    fs.mkdirSync(runDir, { recursive: true });

    const probeOutput = {
      meta: {
        checkedAt: results.checkedAt,
        runId: runId,
        version: '0.1.0'
      },
      sources: Object.entries(results.sources).map(([id, r]) => ({
        sourceId: id,
        name: r.tool,
        role: r.role,
        critical: r.critical,
        probeStatus: r.status,
        details: r.details
      })),
      summary: results.summary
    };

    fs.writeFileSync(path.join(runDir, 'source-probe.json'), JSON.stringify(probeOutput, null, 2));
    console.log(`\nsource-probe.json → ${path.join(runDir, 'source-probe.json')}`);
  }

  // exit code
  if (results.summary.verdict === 'fatal') process.exit(2);
  if (results.summary.verdict === 'degraded') process.exit(0);
  process.exit(0);
}

main();
