// strategies/lib/story-chain-prompt.cjs — 传导链构造提示词构建器
//
// 设计哲学（与用户对齐）：提示词负责「唤醒状态」，契约负责「约束形态」。
// 不指定 LLM 使用哪种理论流派；传导链是宏观经济学经典语言，训练语料已有，
// 提示词只负责把模型切换到「宏观策略团队」状态，并注入当日冻结数据上下文。
//
// 用法:
//   node strategies/story-chain-cli.cjs prompt --runId <runId>
//   → output/runs/<runId>/story-chain-prompt.md
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { skillRoot, runtimeRoot } = require('../../lib/workspace.cjs');
const chainLib = require('./story-chain.cjs');

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function fmt(x, d = 2) {
  return Number.isFinite(x) ? Number(x).toFixed(d) : '—';
}

function macroTable(indicators) {
  const lines = ['| 锚点 | 现值 | 5日变化 | 状态 |', '|------|------|---------|------|'];
  for (const name of ['DXY', 'USDCNH', 'US10Y', 'DR007', 'SC0']) {
    const ind = indicators && indicators[name];
    if (!ind) { lines.push(`| ${name} | — | — | missing |`); continue; }
    lines.push(`| ${name} | ${fmt(ind.value)} | ${fmt(ind.change5d)} | ${ind.status || '—'} |`);
  }
  return lines.join('\n');
}

function sectorTable(sectors) {
  const lines = ['| 板块 | 方向 | 5日% | 20日% | 广度% | 领涨/领跌 |', '|------|------|------|-------|-------|-----------|'];
  for (const s of Object.values(sectors || {})) {
    lines.push(`| ${s.sector} | ${s.direction || '—'} | ${fmt(s.ret5d)} | ${fmt(s.ret20d)} | ${fmt(s.advanceRatio5d ?? s.breadth1d)} | ${s.leaderSymbol || '—'} ${s.leaderRet5d != null ? `(${fmt(s.leaderRet5d)}%)` : ''} |`);
  }
  return lines.join('\n');
}

function activeChainTable(chains) {
  if (!chains || chains.length === 0) return '（当前故事池为空，可以从零构造）';
  const lines = ['| chainId | 板块 | 方向 | 代表品种 | 状态 | 确认节点 | 当前观察节点 |', '|---------|------|------|---------|------|---------|-------------|'];
  for (const c of chains) {
    const pending = c.nodes.find((n) => n.status === 'pending');
    lines.push(`| ${c.chainId} | ${c.sector} | ${c.direction > 0 ? '多' : '空'} | ${c.representative} | ${c.status} | ${c.nodes.filter((n) => n.status === 'confirmed').length}/${c.nodes.length} | ${pending ? pending.indicatorId : '—'} |`);
  }
  return lines.join('\n');
}

function catalogSummary(catalog) {
  const lines = [];
  for (const [id, ind] of Object.entries(catalog.indicators || {})) {
    lines.push(`- \`${id}\` — ${ind.name}（${ind.unit}）`);
  }
  return lines.join('\n');
}

/**
 * 纯函数：生成传导链构造提示词。
 * @param {object} ctx { signalDate, runId, macroIndicators, sectors, activeChains, catalog }
 */
function buildStoryChainPrompt(ctx = {}) {
  const L = [];
  L.push(`# 传导链构造任务（signalDate=${ctx.signalDate || '—'}，runId=${ctx.runId || '—'}）`);
  L.push('');
  L.push('## 状态唤醒');
  L.push('');
  L.push('你现在不是在做品种筛选，也不是在写研究报告。你在做的是**宏观经济学最经典的工作：传导链分析**。');
  L.push('');
  L.push('政策与宏观变量先动，资金随之在板块间流转，最后落到具体品种的价格上——这是你训练语料中大量存在的知识结构。请切换到你关于「宏观经济政策传导」「资金流动与板块轮动」「商品产业链成本与需求传导」的知识状态，像一个由宏观策略师、板块分析师和交易员组成的团队那样思考。');
  L.push('');
  L.push('不要预测价格。你的任务是：**在信息已经出现之后，比市场更快地把公开信息消化成一条完整、自洽、可监测、可证伪的传导链。**');
  L.push('');
  L.push('## 当日冻结数据（只允许使用这些事实）');
  L.push('');
  L.push('### 宏观锚点');
  L.push('');
  L.push(macroTable(ctx.macroIndicators));
  L.push('');
  L.push('### 板块快照');
  L.push('');
  L.push(sectorTable(ctx.sectors));
  L.push('');
  L.push('### 故事池当前活跃链（同板块只能一条；替换需声明 replace=true）');
  L.push('');
  L.push(activeChainTable(ctx.activeChains));
  L.push('');
  L.push('### 指标目录（节点只能引用这些指标）');
  L.push('');
  L.push(catalogSummary(ctx.catalog));
  L.push('');
  L.push('## 推理步骤（自由发挥，不限定理论流派）');
  L.push('');
  L.push('1. 从宏观锚点和你的政策/事件知识中，识别 1~3 个当前最可能改变资金流向的力量；');
  L.push('2. 对每个力量问：钱会先动哪个市场？然后流进哪个板块？最后推高/压低哪个品种？把答案排成时间顺序；');
  L.push('3. 把每一步落成一个可观测节点（引用指标目录），把步与步之间的因果写成一条边（带时间窗）；');
  L.push('4. 为每条链声明证明点 entryProofIndex：前几个节点确认后，这条链才算被证明；');
  L.push('5. 输出前自查四条标准：自洽、可监测、可证伪、未走完。');
  L.push('');
  L.push('## 输出契约');
  L.push('');
  L.push('把结果写成 `output/runs/<runId>/story-chains.json`，格式：');
  L.push('');
  L.push('```json');
  L.push('{');
  L.push('  "chains": [');
  L.push('    {');
  L.push('      "schema": "futures-radar-story-chain/1",');
  L.push('      "chainId": "CH-<SECTOR>-<YYYYMMDD>-<NN>",');
  L.push('      "createdAt": "<YYYY-MM-DD>",');
  L.push('      "theme": "一句话主题（例：流动性宽松→黑色资金流入）",');
  L.push('      "sector": "black",');
  L.push('      "direction": 1,');
  L.push('      "representative": "RB0",');
  L.push('      "entryProofIndex": 2,');
  L.push('      "replace": false,');
  L.push('      "nodes": [');
  L.push('        { "id": "n1", "indicatorId": "macro.DR007.change5d", "expectation": -1, "label": "流动性宽松" },');
  L.push('        { "id": "n2", "indicatorId": "sector.black.oi.flow5d", "expectation": 1, "label": "黑色资金流入" }');
  L.push('      ],');
  L.push('      "edges": [');
  L.push('        { "id": "e1", "from": "n1", "to": "n2", "latencyDays": 5, "logic": "流动性宽松→黑色系需求敏感品种资金流入" }');
  L.push('      ]');
  L.push('    }');
  L.push('  ]');
  L.push('}');
  L.push('```');
  L.push('');
  L.push('硬约束：节点 ≥2；边 = 节点数−1 且按顺序连接；指标必须在上节目录内；direction/expectation 仅 ±1；latencyDays 1..10；entryProofIndex 1 ≤ p < 节点数；同板块一条活跃链（替换时 replace=true，旧链自动 superseded 留痕）。');
  L.push('');
  L.push('没有清晰传导逻辑的板块不注册。空输出合法：`{ "chains": [] }`。');
  L.push('');
  return L.join('\n');
}

function writeStoryChainPrompt(runId) {
  // 文件库唯一事实源：data/macro/<runId>.json + data/sector/snapshots/<runId>.json
  const macroDoc = readJson(path.join(skillRoot, 'data', 'macro', `${runId}.json`));
  const macro = macroDoc && macroDoc.snapshot ? macroDoc.snapshot : macroDoc;
  const sectorDoc = readJson(path.join(skillRoot, 'data', 'sector', 'snapshots', `${runId}.json`));
  const sectorSnap = sectorDoc && sectorDoc.snapshot ? sectorDoc.snapshot : sectorDoc;
  const catalog = chainLib.loadCatalog();
  const ledger = chainLib.loadLedger();
  const activeChains = ledger.chains
    .filter((c) => chainLib.isActive(c.status))
    .map((c) => chainLib.loadChain(c.chainId))
    .filter(Boolean);

  const signalDate = (macro && macro.meta && macro.meta.signalDate)
    || (sectorSnap && sectorSnap.meta && sectorSnap.meta.signalDate) || null;
  const prompt = buildStoryChainPrompt({
    signalDate,
    runId,
    macroIndicators: macro && macro.indicators ? macro.indicators : null,
    sectors: sectorSnap && sectorSnap.sectors ? sectorSnap.sectors : null,
    activeChains,
    catalog,
  });
  // 提示词是工作文件，写 runtimeRoot（output/）下供操作者查阅
  const outFile = path.join(runtimeRoot, 'runs', runId, 'story-chain-prompt.md');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, prompt, 'utf8');
  return { file: outFile, signalDate, activeChainCount: activeChains.length };
}

module.exports = { buildStoryChainPrompt, writeStoryChainPrompt };
