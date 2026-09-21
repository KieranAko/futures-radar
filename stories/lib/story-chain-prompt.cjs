// stories/lib/story-chain-prompt.cjs — 传导链构造提示词构建器
//
// 设计哲学（与用户对齐）：提示词负责「唤醒状态」，契约负责「约束形态」。
// 不指定 LLM 使用哪种理论流派；传导链是宏观经济学经典语言，训练语料已有，
// 提示词只负责把模型切换到「宏观策略团队」状态，并注入当日冻结数据上下文。
//
// 用法:
//   node stories/cli/story-chain-cli.cjs prompt --runId <runId>
//   → output/runs/<runId>/story-chain-prompt.md
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { skillRoot, runtimeRoot } = require('../../shared/workspace.cjs');
const chainLib = require('./story-chain.cjs');
const newsLib = require('./news-snapshot.cjs');

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

function sourceClassLabelOf(c) {
  if (c.sourceClass) return chainLib.SOURCE_CLASS_LABELS[c.sourceClass] || c.sourceClass;
  const first = c.nodes && c.nodes[0];
  if (first && first.indicatorId && first.indicatorId.startsWith('macro.')) return '宏观源';
  if (first && first.concept && first.dataPlan && first.dataPlan.kind === 'flow') return '供需源';
  if (first && first.concept) return '事件源';
  if (first && first.indicatorId) return '行为源';
  return '—';
}

function activeChainTable(chains) {
  if (!chains || chains.length === 0) return '（当前故事池为空，可以从零构造）';
  const lines = ['| chainId | 源类 | 源 | 代表品种 | 方向 | 状态 | 已证明节点 |', '|---------|------|------|------|------|------|-----------|'];
  for (const c of chains) {
    const src = c.sourceId
      || (c.nodes && c.nodes[0] && (c.nodes[0].indicatorId || c.nodes[0].concept))
      || c.sector || '—';
    const branches = Array.isArray(c.branches) && c.branches.length > 0
      ? c.branches
      : (Array.isArray(c.terminals) && c.terminals.length > 0 ? c.terminals : []);
    const rep = c.representative || (branches[0] && branches[0].symbol) || '—';
    const dir = c.direction !== undefined && c.direction !== null ? c.direction : (branches[0] && branches[0].direction);
    lines.push(`| ${c.chainId} | ${sourceClassLabelOf(c)} | ${src} | ${rep} | ${dir === 1 ? '多' : dir === -1 ? '空' : '—'} | ${c.status}${c.provisional ? '·provisional' : ''} | ${c.nodes.filter((n) => n.status === 'confirmed').length}/${c.nodes.length} |`);
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
  L.push('### 今日信息快照（新闻/政策，只提供事实，不预置方向）');
  L.push('');
  const newsItems = (ctx.newsDoc && Array.isArray(ctx.newsDoc.items)) ? ctx.newsDoc.items : [];
  if (newsItems.length > 0) {
    for (const it of newsItems) {
      L.push(`- [${it.id}] ${it.date} ${it.type} ${(it.sectors || []).join('/')}：${it.title}。${it.summary}（来源 ${(it.sources || []).length} 条${it.singleSource ? '，单源' : ''}）`);
    }
  } else {
    L.push('（本期无新闻快照；只能用宏观/板块冻结数据构造链）');
  }
  L.push('');
  L.push('### 故事池当前活跃链（同源只能一条活跃链；替换需声明 replace=true；provisional 链仅观察不参与证明）');
  L.push('');
  L.push(activeChainTable(ctx.activeChains));
  L.push('');
  L.push('### 指标目录（节点只能引用这些指标）');
  L.push('');
  L.push(catalogSummary(ctx.catalog));
  L.push('');
  L.push('### 链首合法来源（源类由引擎按首节点自动判定，不允许伪装成其他类）');
  L.push('');
  L.push('| 源类 | 链首写法 | 适用场景 |');
  L.push('|------|---------|---------|');
  L.push('| 宏观源 | `macro.<ANCHOR>.change5d` | 政策/利率/汇率/油价等宏观力量传导 |');
  L.push('| 事件源 | T2 `concept` + `kind=event` | 政策发布、报告发布等"发生即事实" |');
  L.push('| 供需源 | T2 `concept` + `kind=flow`（metric/basis/minSources 冻结口径） | 成交量、库存、开工等基本面序列 |');
  L.push('| 行为源 | `sector.<SECTOR>.oi.flow5d`（目录唯一 allowAsRoot 的行为指标） | 板块资金流/持仓结构驱动的市场结构机会 |');
  L.push('');
  L.push('行为源链条的机制纪律：资金流是"动作"，不是"价格涨跌"，因此 `sector.*.oi.flow5d` 可以作链首；但板块收益、相对强度与品种价格仍然禁止作链首（它们是价格结果，不是驱动）。行为源链条必须写清"资金流向哪里、为什么先压/抬中间环节、最后落到哪个品种"，禁止把"持仓流出+价格下跌"直接用箭头相连。');
  L.push('## 推理步骤（自由发挥，不限定理论流派）');
  L.push('');
  L.push('1. **源优先，目标其次**：先只用宏观锚点、政策/事件知识与 T2 数据口径，识别 1~3 个当前最可能改变资金流向的力量；也可以从一个市场现象/信号质量假设出发（假设目标合法），但目标只是候选，不是结论。**禁止用品种当日价格/信号反过来定源、再带着源的方向去搜索证据**——源必须独立于品种方向成立：删除品种价格与板块快照后，这个源依然成立，才允许作为链首；');
  L.push('2. 对每个力量问：钱会先动哪个市场？然后流进哪个板块？最后推高/压低哪个品种？把答案排成时间顺序；');
  L.push('3. 把每一步落成一个可观测节点（引用指标目录），把步与步之间的因果写成一条边（带时间窗）；边的 logic 必须写清机制（上一环通过什么路径触发下一环），禁止只用箭头连接两个节点名；');
  L.push('4. **前提严谨性自查（必做，禁止为了证明目标而放宽节点）**：对照当日冻结数据，逐节点核对当前观测方向与 expectation 是否一致；当前方向与 expectation 相反的节点，必须写清窗口期内反转的机制，写不清就把该链删掉；上下游只是同涨同跌、或只靠路由表词条连接的边，一律不注册；T2 节点的 concept 与检索词必须是中性口径（被测量的量+窗口+基准），方向只写进 expectation，禁止出现"走弱/上升/回落"等结论词；');
  L.push('5. 为每条链声明证明点 entryProofIndex：所有节点从注册日起并行观察、独立计数，日频节点连续 3 个交易日同向即证明，反向连续 2 个交易日即证伪；达到证明点即 proven。没有"当前节点"概念。前提证据不足时可用 `"provisional": true` 声明仅观察不参与证明；');
  L.push('6. **写链推理卡（与六问信息量对齐，供审计 LLM 对质，必填）**：claim 写明源、方向与源到终点的路径；mechanisms 逐条边写清"为什么上一环触发下一环"；evidenceRefs 引用新闻快照 item id 与指标 id；assumptions 写前提假设；uncertainties 写不确定处；falsifiers 写证伪条件。推理卡是你的推理原文，不是节点 id 的重复列表；');
  L.push('7. 写主题：主标题 4–14 字（短语，禁止 →），副标题 10–60 字（驱动+传导+品种+阶段，禁止 →）；');
  L.push('8. 输出前自查四条标准：自洽、可监测、可证伪、未走完。');
  L.push('');
  L.push('## 输出契约');
  L.push('');
  L.push('把结果写成 `output/runs/<runId>/story-chains.json`，格式：');
  L.push('');
  L.push('```json');
  L.push('{');
  L.push('  "chains": [');
  L.push('    {');
  L.push('      "schema": "futures-radar-story-chain/3",');
  L.push('      "chainId": "CH-<SOURCE>-<YYYYMMDD>-<NN>",');
  L.push('      "createdAt": "<YYYY-MM-DD>",');
  L.push('      "sourceId": "macro.<ANCHOR>.change5d",');
  L.push('      "theme": "<主标题短语：主语+状态 / 事件+传导 / 力量+对象>",');
  L.push('      "themeDetail": "<驱动 + 传导 + 品种 + 当前阶段的一句话>",');
  L.push('      "replace": false,');
  L.push('      "nodes": [');
  L.push('        { "id": "n1", "indicatorId": "macro.<ANCHOR>.change5d", "expectation": "<±1>", "label": "<节点里程碑>" },');
  L.push('        { "id": "n2", "indicatorId": "sector.<SECTOR>.<METRIC>", "expectation": "<±1>", "label": "<传导节点>" },');
  L.push('        { "id": "n2b", "concept": "<T2 概念：被测量的量+窗口+基准，≥8 字，中性无方向>", "dataPlan": { "paths": ["T2"], "kind": "event|flow", "baseline": "<基线数值>", "unit": "<单位>", "maxFreshDays": "<1..30>", "metric": "<kind=flow 必填：被测量的具体指标名>", "basis": "<kind=flow 必填：level|dod|wow|mom|yoy>", "minSources": "<kind=flow 时必填 2..5；event 可省略>", "searchHints": ["<中性检索词（机构/序列/口径），禁止预置方向>"] }, "expectation": "<±1>", "label": "<节点里程碑>" },');
  L.push('        { "id": "n3", "indicatorId": "symbol.<SYMBOL>.price.ret5d", "expectation": "<±1>", "label": "<代表品种节点>", "terminal": true, "priority": "primary|secondary", "impactRationale": "<8–80字：为什么选这个品种>", "proofIndex": "<2..祖先节点数>" }');
  L.push('      ],');
  L.push('      "edges": [');
  L.push('        { "id": "e1", "from": "n1", "to": "n2", "latencyDays": "<1..10>", "logic": "<机制说明：上一环通过什么路径触发下一环>" }');
  L.push('      ],');
  L.push('      "reasoningCard": {');
  L.push('        "schema": "futures-radar-story-reasoning-card/1",');
  L.push('        "claim": { "source": "<源=新闻快照 id 或指标 id>", "direction": "<±1>", "path": ["n1", "n2", "n3"] },');
  L.push('        "mechanisms": [ { "edgeId": "e1", "why": "<为什么上一环触发下一环>" } ],');
  L.push('        "evidenceRefs": { "news": ["<新闻快照 item id>"], "indicators": ["<指标 id>"] },');
  L.push('        "assumptions": ["<前提假设>"], "uncertainties": ["<不确定性>"], "falsifiers": ["<证伪条件>"]');
  L.push('      }');
  L.push('    }');
  L.push('  ]');
  L.push('}');
  L.push('```');
  L.push('');
  L.push('上面的尖括号全部是占位符，只展示字段形状；具体锚点/板块/品种/方向/时滞必须来自当日冻结数据与你的机制判断，禁止照抄任何示例内容。');
  L.push('');
  L.push('硬约束：schema /3；sourceId 等于首节点指标或概念，且同源同时只允许一条活跃链（replace=true 换代）；节点 ≥3；图必须无环（允许扇出/汇合）；terminal 必须是 symbol.* 可交易节点，priority=primary|secondary，impactRationale 8–80 字，2 ≤ proofIndex ≤ 祖先节点数；指标必须在上节目录内；expectation 仅 ±1；latencyDays 1..10；theme 4–14 字且不含 →；themeDetail 10–60 字且不含 →；reasoningCard 必填且 mechanisms 与 edges 一一对应。');
  L.push('');
  L.push('T2 新契约：T2 节点必须显式 `kind=event|flow` 与 `maxFreshDays`（1..30，无默认）；`flow` 还必须显式 `metric`（被测量的具体指标名）与 `basis`（level|dod|wow|mom|yoy），resolve 时每条 observation 的 metric/basis 必须与 dataPlan 完全一致、至少 `minSources` 2..5 个独立域名来源且所有来源相对 baseline 的方向一致，任一不符整体拒收；`event` 单源可确认。所有 observation 的 `sourceTier` 必填 S/A/B/C（缺失/非法拒收，不默认 C）。检索是中性采集：concept 与 searchHints 必须中性（禁止方向结论词），检索 brief 不把 concept 当检索词，只用中性口径检索；同一来源中的反向口径必须一并报告。');
  L.push('');
  L.push('没有清晰传导逻辑的源头不注册。空输出合法：`{ "chains": [] }`。');
  L.push('');
  return L.join('\n');
}

function writeStoryChainPrompt(runId) {
  // 文件库唯一事实源：data/macro/<runId>.json + data/sector/snapshots/<runId>.json
  const macroDoc = readJson(path.join(skillRoot, 'data', 'macro', `${runId}.json`));
  const macro = macroDoc && macroDoc.snapshot ? macroDoc.snapshot : macroDoc;
  const sectorDoc = readJson(path.join(skillRoot, 'data', 'sector', 'snapshots', `${runId}.json`));
  const sectorSnap = sectorDoc && sectorDoc.snapshot ? sectorDoc.snapshot : sectorDoc;
  const newsDoc = newsLib.loadNewsSnapshot(runId);
  if (newsDoc) {
    const newsCheck = newsLib.validateNewsSnapshot(newsDoc);
    if (!newsCheck.ok) console.warn(`story-chain-prompt: 新闻快照 ${runId} 不合法，将不使用：${newsCheck.errors.join('; ')}`);
  }
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
    newsDoc: newsDoc && newsLib.validateNewsSnapshot(newsDoc).ok ? newsDoc : null,
  });
  // 提示词是工作文件，写 runtimeRoot（output/）下供操作者查阅
  const outFile = path.join(runtimeRoot, 'runs', runId, 'story-chain-prompt.md');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, prompt, 'utf8');
  return { file: outFile, signalDate, activeChainCount: activeChains.length };
}

module.exports = { buildStoryChainPrompt, writeStoryChainPrompt };
