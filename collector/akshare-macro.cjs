// collector/akshare-macro.cjs — Phase 3 阶段一宏观锚点数据源适配器
//
// 职责：按指标 fetch spec 调用 Python 采集脚本（macro_collector.py），
// 返回原始日频序列。bar 选择（<= signalDate）与 change5d 计算在
// macro-probe.cjs 完成，本模块不做数值派生。
//
// 可注入 pythonCmd/scriptPath 供测试替换假采集器。

const path = require('path');
const cp = require('child_process');
const { skillRoot } = require('../lib/workspace.cjs');

const DEFAULT_SCRIPT = path.join(skillRoot, 'collector', 'macro_collector.py');

function fetchSeries(fetchSpec, { pythonCmd = 'python', scriptPath = null, timeoutMs = 90000, signalDate = null } = {}) {
  const script = scriptPath || DEFAULT_SCRIPT;
  // akshare 源需要 signalDate 推算起始日期，合并进 spec；sina_fx 不需要
  const spec = signalDate ? { ...fetchSpec, signalDate } : fetchSpec;
  const args = [script, '--spec', JSON.stringify(spec)];
  const res = cp.spawnSync(pythonCmd, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });

  if (res.error) {
    return { ok: false, error: `spawn failed: ${res.error.message}`, fetchedAt: null };
  }

  const stdout = (res.stdout || '').trim();
  const line = stdout.split(/\r?\n/).filter((l) => l.trim().startsWith('{')).pop();
  if (!line) {
    return {
      ok: false,
      error: `no JSON output (exit ${res.status}): ${(res.stderr || '').slice(0, 200)}`,
      fetchedAt: null,
    };
  }

  try {
    return JSON.parse(line);
  } catch (e) {
    return { ok: false, error: `bad JSON output: ${line.slice(0, 200)}`, fetchedAt: null };
  }
}

module.exports = { fetchSeries };
