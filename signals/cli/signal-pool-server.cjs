#!/usr/bin/env node
// signals/cli/signal-pool-server.cjs — futures-radar 本地 dashboard 服务（一期）
//
// 用法:
//   node signals/cli/signal-pool-server.cjs --runId <runId> [--port 8765] [--no-render] [--root <poolRoot>]
//
// 功能:
//   - 托管 output/dashboard.html（dashboard 作为唯一入口）
//   - GET  /api/health          服务状态
//   - POST /api/decisions       决策回填：写信号文件 → 重建 signal-pool.json → 重渲染 dashboard
//   - POST /api/service/shutdown 停止服务
//
// 纪律：仅监听 127.0.0.1；不调用 LLM；不访问外网。

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');
const { skillRoot, runtimeRoot, runDir } = require('../../shared/workspace.cjs');
const { applyDecisionsDoc } = require('./signal-pool-decision-cli.cjs');

const DEFAULT_PORT = 8765;
const DEFAULT_HOST = '127.0.0.1';

function readJSON(p, fallback = null) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function latestRunId() {
  const base = path.join(runtimeRoot, 'runs');
  if (!fs.existsSync(base)) return null;
  const ids = fs.readdirSync(base).filter((d) => fs.existsSync(path.join(base, d, 'report-model.json')));
  ids.sort((a, b) => String(b).localeCompare(String(a)));
  return ids[0] || null;
}

function renderDashboard(runId) {
  const script = path.join(skillRoot, 'output', 'render-markdown.cjs');
  if (!fs.existsSync(script)) return { ok: false, error: 'render-markdown.cjs not found' };
  const res = spawnSync('node', [script, '--runId', runId], { encoding: 'utf8', timeout: 120000, windowsHide: true });
  return { ok: res.status === 0, error: res.status === 0 ? null : (res.stderr || res.stdout || `exit ${res.status}`) };
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function handlerFactory({ runId, rootOverride, renderEnabled, port, host, startedAt, shutdown }) {
  return async function handler(req, res) {
    const url = (req.url || '/').split('?')[0];
    try {
      if (url === '/' || url === '/dashboard.html') {
        const file = path.join(runtimeRoot, 'dashboard.html');
        if (!fs.existsSync(file)) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('dashboard.html not found. Run render-markdown first.');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
        fs.createReadStream(file).pipe(res);
        return;
      }
      if (url === '/api/health') {
        sendJson(res, 200, {
          ok: true,
          service: 'futures-radar-dashboard',
          runId,
          port,
          host,
          pid: process.pid,
          startedAt,
          renderEnabled
        });
        return;
      }
      if (url === '/api/decisions' && req.method === 'POST') {
        const raw = await readBody(req);
        const doc = JSON.parse(raw || '{}');
        const applied = applyDecisionsDoc(runId, doc, rootOverride);
        if (applied.ok === false) {
          sendJson(res, 400, { ok: false, error: applied.error, details: applied.details });
          return;
        }
        let render = { ok: true };
        if (renderEnabled) render = renderDashboard(runId);
        sendJson(res, 200, { ok: true, summary: applied.summary, viewPath: applied.viewPath, render });
        return;
      }
      if (url === '/api/service/shutdown' && req.method === 'POST') {
        sendJson(res, 200, { ok: true, message: 'shutting down' });
        if (shutdown) shutdown();
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e && e.message ? e.message : String(e) });
    }
  };
}

function startServer(options = {}) {
  const runId = options.runId || latestRunId();
  if (!runId) throw new Error('--runId required and no runs found under output/runs');
  const port = Number(options.port || process.env.FR_PORT || DEFAULT_PORT);
  const host = options.host || DEFAULT_HOST;
  const renderEnabled = options.render !== false;
  const rootOverride = options.root || null;
  const startedAt = new Date().toISOString();
  const server = http.createServer(handlerFactory({
    runId, rootOverride, renderEnabled, port, host, startedAt,
    shutdown() { server.close(() => {}); }
  }));
  server.on('error', (e) => {
    if (e && e.code === 'EADDRINUSE') {
      console.error(`FATAL: port ${port} already in use. Stop the old service or set FR_PORT.`);
      process.exit(1);
    }
    throw e;
  });
  return { server, runId, port, host, start() { return new Promise((resolve) => server.listen(port, host, () => resolve(server.address()))); } };
}

function main() {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i === -1 ? null : args[i + 1];
  };
  const runId = flag('--runId') || latestRunId();
  if (!runId) { console.error('FATAL: --runId required and no runs found'); process.exit(1); }
  const port = Number(flag('--port') || process.env.FR_PORT || DEFAULT_PORT);
  const renderEnabled = !args.includes('--no-render');
  const rootOverride = flag('--root') || null;
  const startedAt = new Date().toISOString();
  const server = http.createServer(handlerFactory({
    runId, rootOverride, renderEnabled, port, host: DEFAULT_HOST, startedAt,
    shutdown() { server.close(() => process.exit(0)); }
  }));
  server.on('error', (e) => {
    if (e && e.code === 'EADDRINUSE') {
      console.error(`FATAL: port ${port} already in use. Stop the old service or set FR_PORT.`);
      process.exit(1);
    }
    throw e;
  });
  server.listen(port, DEFAULT_HOST, () => {
    console.log(`futures-radar dashboard service`);
    console.log(`  url: http://${DEFAULT_HOST}:${port}`);
    console.log(`  runId: ${runId}`);
    console.log(`  render: ${renderEnabled ? 'on' : 'off'}`);
  });
}

if (require.main === module) main();

module.exports = { startServer, handlerFactory, latestRunId, renderDashboard };
