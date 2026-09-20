// experiment-line/g2.cjs — G2 机制级回测工具框架（v6 架构 L2）
//
// G2 只对 G1 promote 的机制开放（P5/AD-5：便宜筛通过才进下一级）。
// 当前实现：门槛校验 + 从 G1 结果生成机制级绩效报告（年度/回撤/波动率/Sharpe）。
// 无 g1_pass 机制时，assess 拒绝并返回拒绝原因——这是架构的强制行为，不是错误。
//
// 用法:
//   node experiment-line/g2.cjs assess --id <机制id>
//   node experiment-line/g2.cjs list
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const EL = __dirname;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function mean(xs) {
  const a = xs.filter((v) => Number.isFinite(v));
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
}

function maxDrawdown(xs) {
  let peak = -Infinity;
  let dd = 0;
  let eq = 0;
  for (const v of xs) {
    eq += v;
    peak = Math.max(peak, eq);
    dd = Math.min(dd, eq - peak);
  }
  return dd;
}

function assess(id) {
  const regFile = path.join(EL, 'registry', `${id}.json`);
  if (!fs.existsSync(regFile)) throw new Error(`mechanism not registered: ${id}`);
  const reg = readJson(regFile);

  if (reg.status !== 'g1_pass') {
    const out = {
      schema: 'futures-radar-experiment-line-g2/1',
      id,
      assessedAt: new Date().toISOString(),
      eligible: false,
      reason: `G1 gate not passed (registry.status=${reg.status}, g1 verdict=${reg.g1?.verdict || '-'})`,
      note: 'G2 只对 G1 promote 的机制开放；如需继续研究请重新预注册新形态（24 协议：修改即新实验）。',
    };
    writeJson(path.join(EL, 'results', 'g2', `${id}.json`), out);
    console.log(`[${id}] G2 rejected: ${out.reason}`);
    return out;
  }

  const resultFile = path.join(EL, 'results', 'g1', `${id}-result.json`);
  if (!fs.existsSync(resultFile)) throw new Error(`G1 result missing: ${resultFile}`);

  const r = readJson(resultFile);
  const nets = (r.events || []).map((e) => e.netPct).filter((v) => Number.isFinite(v));
  const byYear = {};
  for (const e of r.events || []) {
    const y = (e.date || e.month || '').slice(0, 4);
    if (!y) continue;
    byYear[y] = byYear[y] || [];
    byYear[y].push(e.netPct);
  }
  const annual = Object.fromEntries(
    Object.entries(byYear).map(([y, xs]) => [y, { n: xs.length, meanNetPct: mean(xs) }])
  );
  const out = {
    schema: 'futures-radar-experiment-line-g2/1',
    id,
    assessedAt: new Date().toISOString(),
    eligible: true,
    g1Decision: r.decision,
    performance: {
      n: nets.length,
      meanNetPct: mean(nets),
      stdPct: (() => {
        const m = mean(nets);
        if (m === null) return null;
        return Math.sqrt(nets.reduce((s, v) => s + (v - m) ** 2, 0) / (nets.length - 1));
      })(),
      sharpeAnnualized: (() => {
        const m = mean(nets);
        if (m === null || nets.length < 2) return null;
        const sd = Math.sqrt(nets.reduce((s, v) => s + (v - m) ** 2, 0) / (nets.length - 1));
        return sd === 0 ? null : (m / sd) * Math.sqrt(12);
      })(),
      maxDrawdownPct: maxDrawdown(nets),
      annual,
    },
    note: '机制级绩效报告；实例级回测（G3）需在 G2 决策通过后另行注册',
  };
  writeJson(path.join(EL, 'results', 'g2', `${id}.json`), out);
  console.log(`[${id}] G2 assessed: n=${out.performance.n} mean=${out.performance.meanNetPct}`);
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const flag = (f) => {
    const i = args.indexOf(f);
    return i === -1 ? null : args[i + 1];
  };
  if (args[0] === 'assess') return assess(flag('--id'));
  if (args[0] === 'list') {
    const dir = path.join(EL, 'results', 'g2');
    if (!fs.existsSync(dir)) return [];
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      const r = readJson(path.join(dir, f));
      console.log(`${r.id}  eligible=${r.eligible}  ${r.reason || ''}`);
    }
    return null;
  }
  throw new Error('usage: node experiment-line/g2.cjs assess --id <id> | list');
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(`FATAL: ${e.message}`);
    process.exit(1);
  }
}

module.exports = { assess, maxDrawdown };
