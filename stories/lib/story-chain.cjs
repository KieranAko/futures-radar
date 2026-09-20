// stories/lib/story-chain.cjs — 传导链构造器核心（故事池 v2）
//
// 职责边界：
//   LLM：构造链（节点/边/方向/证明点/时间窗 + 概念化节点的 dataPlan）
//   脚本：合法性校验、数据源解析（T0/T1/T2）、可信度标注、逐日观测、
//         流向/流速告警、证明/证伪状态机、故事池台账
//
// 两个正交维度（用户裁定）：
//   - 取数路径 T0 文件库 / T1 采集器 / T2 WebSearch：只是取数优先级；
//   - 数据可信度 high/medium/low/unknown：独立标注，不改变证明/证伪判决。
//
// 状态机：resolving | pending → proven → completed | falsified | expired | void
//   T2 节点未解析完成前链处于 resolving（证明点冻结）；解析失败 → void。
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { skillRoot } = require('../../shared/workspace.cjs');

const CHAIN_SCHEMA = 'futures-radar-story-chain/3';
const V2_CHAIN_SCHEMA = 'futures-radar-story-chain/2';
const LEGACY_CHAIN_SCHEMA = 'futures-radar-story-chain/1';
const LEDGER_SCHEMA = 'futures-radar-story-pool-ledger/1';
const VIEW_SCHEMA = 'futures-radar-story-pool-view/1';
const ACTIVE_STATUSES = ['resolving', 'pending', 'proven'];
const TERMINAL_STATUSES = ['completed', 'falsified', 'expired', 'superseded', 'void'];
const DEFAULT_MAX_LIFESPAN_TRADING_DAYS = 20;
const DEFAULT_T2_MAX_FRESH_DAYS = 7;
const VALID_TIERS = ['S', 'A', 'B', 'C'];

function poolRoot(rootOverride = null) {
  return rootOverride || path.join(skillRoot, 'data', 'story-pool');
}

function ledgerPath(root = null) { return path.join(poolRoot(root), 'ledger.json'); }
function storiesDir(root = null) { return path.join(poolRoot(root), 'stories'); }
function seatsDir(root = null) { return path.join(poolRoot(root), 'seats'); }
function researchDir(root = null) { return path.join(poolRoot(root), 'research'); }
function chainFile(chainId, root = null) { return path.join(storiesDir(root), `${chainId}.json`); }
function briefPath(chainId, root = null) { return path.join(researchDir(root), `${chainId}.brief.json`); }
function resultsPath(chainId, root = null) { return path.join(researchDir(root), `${chainId}.results.json`); }

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function defaultLedger() {
  return { schema: LEDGER_SCHEMA, updatedAt: null, chains: [] };
}

function loadLedger(root = null) {
  const p = ledgerPath(root);
  const l = readJson(p, defaultLedger());
  if (!l.chains || !Array.isArray(l.chains)) l.chains = [];
  return l;
}

function saveLedger(ledger, root = null) {
  ledger.schema = LEDGER_SCHEMA;
  ledger.updatedAt = new Date().toISOString();
  writeJsonAtomic(ledgerPath(root), ledger);
  return ledger;
}

function loadChain(chainId, root = null) {
  return readJson(chainFile(chainId, root), null);
}

// 席位血缘前向记录（data/story-pool/seats/<runId>.json，由 apply-story-seats 写入）
function loadSeatRecords(root = null) {
  const dir = seatsDir(root);
  const byChain = new Map();
  if (!fs.existsSync(dir)) return byChain;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const doc = readJson(path.join(dir, f), null);
    if (!doc || !Array.isArray(doc.seats)) continue;
    for (const seat of doc.seats) {
      if (!seat || !seat.chainId) continue;
      if (!byChain.has(seat.chainId)) byChain.set(seat.chainId, []);
      byChain.get(seat.chainId).push({
        runId: doc.runId || f.replace(/\.json$/, ''),
        symbol: seat.symbol || null,
        theme: seat.theme || null,
        appliedAt: doc.appliedAt || null,
      });
    }
  }
  return byChain;
}

function saveChain(chain, root = null) {
  writeJsonAtomic(chainFile(chain.chainId, root), chain);
  return chain;
}

function loadCatalog() {
  return readJson(path.join(skillRoot, 'stories', 'config', 'story-chain-indicators.json'), null);
}

function loadSymbolsConfig() {
  return readJson(path.join(skillRoot, 'config', 'symbols.json'), null);
}

// ── 链契约校验（V3 DAG）────────────────────────────────────
function validateChainDefinitionV3(def, { catalog = null, symbols = null } = {}) {
  const errors = [];
  const cat = catalog || loadCatalog();
  const syms = symbols || loadSymbolsConfig();
  const symbolDefs = (syms && syms.symbols) || [];

  if (!def.sourceId || String(def.sourceId).trim().length === 0) {
    errors.push('sourceId 缺失（一源一链的唯一标识）');
  }

  if (!Array.isArray(def.nodes) || def.nodes.length < 3) {
    errors.push('链至少需要 3 个节点（源 → 至少一个传导节点 → 终点）');
  } else {
    const ids = new Set();
    const allowedIndicatorIds = buildAllowedIndicatorIdsV3(cat, symbolDefs);
    const first = def.nodes[0];
    if (first) {
      const firstRef = first.indicatorId || (first.concept ? `T2:${first.concept}` : null);
      if (def.sourceId && firstRef && def.sourceId !== firstRef && def.sourceId !== first.indicatorId && def.sourceId !== first.concept) {
        errors.push(`sourceId 必须等于首节点的 indicatorId 或 T2 concept`);
      }
      if (!(first.indicatorId && first.indicatorId.startsWith('macro.')) && !(first.concept && String(first.concept).trim().length >= 8)) {
        errors.push('nodes[0] 必须是宏观/事件源节点（macro.* 或 T2 concept）');
      }
    }

    const activeBySector = new Map();
    for (const s of symbolDefs) {
      if (!s || !s.active) continue;
      activeBySector.set(s.sector, (activeBySector.get(s.sector) || 0) + 1);
    }

    for (let i = 0; i < def.nodes.length; i++) {
      const n = def.nodes[i];
      if (!n || !n.id) { errors.push(`nodes[${i}].id 缺失`); continue; }
      if (ids.has(n.id)) errors.push(`节点 id 重复: ${n.id}`); else ids.add(n.id);
      if (n.expectation !== 1 && n.expectation !== -1) errors.push(`nodes[${i}].expectation 必须为 +1 或 -1`);

      const hasT0 = n.indicatorId && allowedIndicatorIds.has(n.indicatorId);
      if (hasT0) {
        const m = String(n.indicatorId || '').match(/^sector\.([^.]+)\./);
        if (m && (activeBySector.get(m[1]) || 0) < 3) {
          errors.push(`nodes ${n.id}: 板块 ${m[1]} 成员 <3，板块指标不可监测`);
        }
      } else {
        if (!n.concept || String(n.concept).trim().length < 8) errors.push(`nodes[${i}].concept 缺失或过短`);
        const dp = n.dataPlan;
        if (!dp || !Array.isArray(dp.paths) || dp.paths.length === 0) {
          errors.push(`nodes[${i}].dataPlan.paths 缺失`);
        } else {
          for (const pa of dp.paths) if (pa !== 'T1' && pa !== 'T2') errors.push(`nodes[${i}].dataPlan.paths 含非法路径 ${pa}`);
          if (dp.paths.includes('T2')) {
            if (!Number.isFinite(dp.baseline)) errors.push(`nodes[${i}].dataPlan.baseline 缺失`);
            if (!dp.unit || String(dp.unit).trim().length === 0) errors.push(`nodes[${i}].dataPlan.unit 缺失`);
            const mf = dp.maxFreshDays ?? DEFAULT_T2_MAX_FRESH_DAYS;
            if (!Number.isInteger(mf) || mf < 1 || mf > 30) errors.push(`nodes[${i}].dataPlan.maxFreshDays 必须为 1..30 整数`);
          }
          if (dp.paths.includes('T1') && !dp.paths.includes('T2')) errors.push(`nodes[${i}] 仅声明 T1，须包含 T2 兜底`);
        }
      }

      if (n.terminal) {
        if (!n.indicatorId || !n.indicatorId.startsWith('symbol.')) {
          errors.push(`terminal ${n.id} 必须为 symbol.* 可交易节点`);
        } else {
          const sym = String(n.indicatorId).split('.')[1];
          const sd = symbolDefs.find((s) => s.symbol === sym && s.active);
          if (!sd) errors.push(`terminal ${n.id} 品种 ${sym} 不在 active 白名单`);
          if (sd && first && first.indicatorId === 'macro.SC0.change5d' && sym === 'SC0') {
            errors.push('terminal 为 SC0 时，macro.SC0.change5d 是自身价格，不得作为故事源');
          }
        }
        if (n.priority !== 'primary' && n.priority !== 'secondary') errors.push(`terminal ${n.id}.priority 必须为 primary|secondary`);
        const ir = String(n.impactRationale || '').trim();
        if (ir.length < 8 || ir.length > 80) errors.push(`terminal ${n.id}.impactRationale 必须为 8–80 字`);
        if (!Number.isInteger(n.proofIndex)) errors.push(`terminal ${n.id}.proofIndex 必须为整数`);
      }
    }

    // 边与图校验（DAG，允许扇出/汇合，禁止环）
    if (!Array.isArray(def.edges) || def.edges.length < 1) {
      errors.push('链至少需要 1 条边');
    } else {
      const edgeSet = new Set();
      for (let i = 0; i < def.edges.length; i++) {
        const e = def.edges[i];
        if (!e || !e.from || !e.to) { errors.push(`edges[${i}] 缺少 from/to`); continue; }
        if (e.from === e.to) errors.push(`edges[${i}] 不允许自环`);
        if (!ids.has(e.from)) errors.push(`edges[${i}].from 指向未定义节点 ${e.from}`);
        if (!ids.has(e.to)) errors.push(`edges[${i}].to 指向未定义节点 ${e.to}`);
        if (!Number.isInteger(e.latencyDays) || e.latencyDays < 1 || e.latencyDays > 10) errors.push(`edges[${i}].latencyDays 必须为 1..10 整数`);
        if (!e.logic || String(e.logic).trim().length < 8) errors.push(`edges[${i}].logic 过短`);
        const key = `${e.from}->${e.to}`;
        if (edgeSet.has(key)) errors.push(`edges[${i}] 重复边 ${key}`); else edgeSet.add(key);
      }

      // 源节点不允许有入边
      const sourceId = def.nodes[0] && def.nodes[0].id;
      const indegree = new Map([...ids].map((id) => [id, 0]));
      for (const e of def.edges || []) {
        if (e && e.to) indegree.set(e.to, (indegree.get(e.to) || 0) + 1);
      }
      if (sourceId && (indegree.get(sourceId) || 0) !== 0) errors.push('源节点 nodes[0] 不允许有入边');

      // 拓扑排序判环
      const order = topologicalOrder(def.nodes, def.edges);
      if (!order) errors.push('图存在环，必须为 DAG');

      // terminal 路径与 proofIndex 约束
      if (order) {
        const terminals = (def.nodes || []).filter((n) => n && n.terminal);
        if (terminals.length === 0) errors.push('至少需要 1 个 terminal 节点');
        const termSymbols = new Set();
        for (const t of terminals) {
          const sym = String(t.indicatorId || '').split('.')[1];
          if (termSymbols.has(sym)) errors.push(`terminal 品种重复: ${sym}`); else termSymbols.add(sym);
          const anc = ancestorsOf(t.id, def.nodes, def.edges); // 不含 terminal 自身
          const minPath = sourceId ? shortestPathLength(sourceId, t.id, def.nodes, def.edges) : null;
          if (minPath == null || minPath < 3) errors.push(`terminal ${t.id} 从源到终点的最短路径至少需要 3 个节点`);
          if (Number.isInteger(t.proofIndex) && (t.proofIndex < 2 || t.proofIndex > anc.length)) {
            errors.push(`terminal ${t.id}.proofIndex 必须满足 2 ≤ proofIndex ≤ 祖先节点数 ${anc.length}`);
          }
        }
      }
    }
  }

  const maxDays = def.maxLifespanTradingDays ?? DEFAULT_MAX_LIFESPAN_TRADING_DAYS;
  if (!Number.isInteger(maxDays) || maxDays < 1 || maxDays > DEFAULT_MAX_LIFESPAN_TRADING_DAYS) {
    errors.push(`maxLifespanTradingDays 必须为 1..${DEFAULT_MAX_LIFESPAN_TRADING_DAYS} 整数`);
  }

  return { ok: errors.length === 0, errors };
}

function buildAllowedIndicatorIdsV3(cat, symbolDefs) {
  const set = new Set();
  if (!cat || !cat.indicators) return set;
  for (const key of Object.keys(cat.indicators)) {
    if (key.includes('{sector}')) {
      for (const s of cat.sectors || []) set.add(key.replace('{sector}', s));
    } else if (key.includes('{symbol}')) {
      for (const s of symbolDefs) {
        if (s && s.active) set.add(key.replace('{symbol}', s.symbol));
      }
    } else {
      set.add(key);
    }
  }
  return set;
}

function topologicalOrder(nodes, edges) {
  const ids = (nodes || []).map((n) => n.id);
  const indegree = new Map(ids.map((id) => [id, 0]));
  const adj = new Map(ids.map((id) => [id, []]));
  for (const e of edges || []) {
    if (!e || !e.from || !e.to) return null;
    if (!indegree.has(e.from) || !indegree.has(e.to)) return null;
    indegree.set(e.to, indegree.get(e.to) + 1);
    adj.get(e.from).push(e.to);
  }
  const queue = ids.filter((id) => indegree.get(id) === 0);
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const to of adj.get(id) || []) {
      indegree.set(to, indegree.get(to) - 1);
      if (indegree.get(to) === 0) queue.push(to);
    }
  }
  return order.length === ids.length ? order : null;
}

function reverseAdjacency(nodes, edges) {
  const rev = new Map((nodes || []).map((n) => [n.id, []]));
  for (const e of edges || []) {
    if (e && rev.has(e.to)) rev.get(e.to).push(e.from);
  }
  return rev;
}

function ancestorsOf(terminalId, nodes, edges) {
  const rev = reverseAdjacency(nodes, edges);
  const seen = new Set();
  const stack = [terminalId];
  while (stack.length) {
    const id = stack.pop();
    for (const parent of rev.get(id) || []) {
      if (!seen.has(parent)) {
        seen.add(parent);
        stack.push(parent);
      }
    }
  }
  return [...seen];
}

function shortestPathLength(sourceId, targetId, nodes, edges) {
  const adj = new Map((nodes || []).map((n) => [n.id, []]));
  for (const e of edges || []) {
    if (e && adj.has(e.from)) adj.get(e.from).push(e.to);
  }
  if (!adj.has(sourceId) || !adj.has(targetId)) return null;
  const dist = new Map((nodes || []).map((n) => [n.id, Infinity]));
  dist.set(sourceId, 1);
  const q = [sourceId];
  while (q.length) {
    const id = q.shift();
    if (id === targetId) return dist.get(id);
    for (const to of adj.get(id) || []) {
      if (dist.get(to) > dist.get(id) + 1) {
        dist.set(to, dist.get(id) + 1);
        q.push(to);
      }
    }
  }
  return dist.get(targetId) === Infinity ? null : dist.get(targetId);
}

// ── 链契约校验 ──────────────────────────────────────────────
function validateChainDefinition(def, { catalog = null, symbols = null } = {}) {
  const errors = [];
  const cat = catalog || loadCatalog();
  const syms = symbols || loadSymbolsConfig();
  if (!def || typeof def !== 'object') return { ok: false, errors: ['definition missing'] };
  if (def.schema !== CHAIN_SCHEMA && def.schema !== V2_CHAIN_SCHEMA && def.schema !== LEGACY_CHAIN_SCHEMA) {
    errors.push(`schema 必须为 ${CHAIN_SCHEMA}（兼容 ${V2_CHAIN_SCHEMA} / ${LEGACY_CHAIN_SCHEMA}）`);
  }
  if (!/^CH-[A-Z0-9-]+$/.test(def.chainId || '')) errors.push('chainId 非法（期望 CH-板块-日期-序号）');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(def.createdAt || '')) errors.push('createdAt 必须为 YYYY-MM-DD');
  if (def.schema === CHAIN_SCHEMA || def.schema === V2_CHAIN_SCHEMA) {
    const theme = String(def.theme || '').trim();
    const themeDetail = String(def.themeDetail || '').trim();
    if (theme.length < 4 || theme.length > 14) {
      errors.push('theme 必须为 4–14 字主标题（短短语，不是完整句子）');
    }
    if (theme.includes('→')) errors.push('theme 不得使用箭头拼接，请用短语主标题');
    if (themeDetail.length < 10 || themeDetail.length > 60) {
      errors.push('themeDetail 必须为 10–60 字叙事副标题（驱动+传导+品种+阶段）');
    }
    if (themeDetail.includes('→')) errors.push('themeDetail 不得使用箭头拼接，请用叙事句式');
  }
  if (def.schema === CHAIN_SCHEMA) {
    return validateChainDefinitionV3(def, { catalog: cat, symbols: syms });
  }

  const sectors = (cat && Array.isArray(cat.sectors)) ? cat.sectors : [];
  if (!sectors.includes(def.sector)) errors.push(`sector 必须在指标目录板块集合内: ${sectors.join(',')}`);
  if (def.direction !== 1 && def.direction !== -1) errors.push('direction 必须为 +1 或 -1');

  const symbolDefs = (syms && syms.symbols) || [];
  const member = symbolDefs.find((s) => s.symbol === def.representative && s.active);
  if (!member) errors.push(`representative ${def.representative} 不在 active 白名单`);
  else if (member.sector !== def.sector) errors.push(`representative ${def.representative} 不属于板块 ${def.sector}`);

  const p = def.entryProofIndex;
  if (!Number.isInteger(p)) errors.push('entryProofIndex 必须为整数');

  // 指标目录模板实例化：sector/symbol 模板展开为链可引用的具体指标 id
  const allowedIndicatorIds = new Set();
  if (cat && cat.indicators) {
    for (const [key] of Object.entries(cat.indicators)) {
      if (key.includes('{sector}')) {
        for (const s of sectors) allowedIndicatorIds.add(key.replace('{sector}', s));
      } else if (key.includes('{symbol}')) {
        if (def.representative) allowedIndicatorIds.add(key.replace('{symbol}', def.representative));
      } else {
        allowedIndicatorIds.add(key);
      }
    }
  }

  if (!Array.isArray(def.nodes) || def.nodes.length < 2) {
    errors.push('链至少需要 2 个节点');
  } else {
    // 证明点下限 2：至少「源节点 + 一个传导节点」确认才算 proven（2 节点链因此不可交易，需 ≥3 节点）
    if (!(p >= 2 && p <= def.nodes.length - 1)) errors.push(`entryProofIndex 必须满足 2 ≤ p < 节点数（即链至少 3 节点才可交易；当前 ${p}/${def.nodes.length}）`);

    // 链首节点必须是真正的上游源：macro 族或 T2 事件概念；板块/品种价格不得作为故事源头
    const first = def.nodes[0];
    if (first && !(first.indicatorId && first.indicatorId.startsWith('macro.')) && !(first.concept && String(first.concept).trim().length >= 8)) {
      errors.push(`nodes[0] 必须是宏观/事件源节点（macro.* 或 T2 concept），板块/品种价格不能作为故事源头`);
    }

    // SC0 自身不能以原油价格作为自己的故事源（循环证据）
    if (def.representative === 'SC0' && (def.nodes || []).some((n) => n.indicatorId === 'macro.SC0.change5d')) {
      errors.push('代表品种为 SC0 时，macro.SC0.change5d 是自身价格，不得作为故事源');
    }

    // 板块节点防循环：板块成员 <3 时板块指标不可监测（沿用 sector-driver abstain 纪律）
    const activeBySector = new Map();
    for (const s of symbolDefs) {
      if (!s || !s.active) continue;
      if (!activeBySector.has(s.sector)) activeBySector.set(s.sector, 0);
      activeBySector.set(s.sector, activeBySector.get(s.sector) + 1);
    }
    for (const n of def.nodes) {
      const m = String(n.indicatorId || '').match(/^sector\.([^.]+)\./);
      if (m && (activeBySector.get(m[1]) || 0) < 3) {
        errors.push(`nodes ${n.id}: 板块 ${m[1]} 成员 <3，板块指标不可监测（abstain），禁止作为传导证据`);
      }
    }

    const ids = new Set();
    for (let i = 0; i < def.nodes.length; i++) {
      const n = def.nodes[i];
      if (!n || !n.id) { errors.push(`nodes[${i}].id 缺失`); continue; }
      if (ids.has(n.id)) errors.push(`节点 id 重复: ${n.id}`);
      else ids.add(n.id);
      if (n.expectation !== 1 && n.expectation !== -1) errors.push(`nodes[${i}].expectation 必须为 +1 或 -1`);

      const hasT0 = n.indicatorId && allowedIndicatorIds.has(n.indicatorId);
      if (hasT0) continue; // T0：目录内稳定源，注册即解析

      // v2：目录外节点必须有 concept + dataPlan（T1/T2 检索意图）
      if (def.schema === LEGACY_CHAIN_SCHEMA) {
        errors.push(`nodes[${i}] 指标 ${n.indicatorId || '(缺失)'} 不在目录`);
        continue;
      }
      if (!n.concept || String(n.concept).trim().length < 8) errors.push(`nodes[${i}].concept 缺失或过短（须写清监测概念）`);
      const dp = n.dataPlan;
      if (!dp || !Array.isArray(dp.paths) || dp.paths.length === 0) {
        errors.push(`nodes[${i}].dataPlan.paths 缺失（须声明 T1/T2 检索路径）`);
      } else {
        for (const pa of dp.paths) {
          if (pa !== 'T1' && pa !== 'T2') errors.push(`nodes[${i}].dataPlan.paths 含非法路径 ${pa}（仅 T1/T2）`);
        }
        if (dp.paths.includes('T2')) {
          if (!Number.isFinite(dp.baseline)) errors.push(`nodes[${i}].dataPlan.baseline 缺失（T2 快照需要基线以判定方向）`);
          if (!dp.unit || String(dp.unit).trim().length === 0) errors.push(`nodes[${i}].dataPlan.unit 缺失`);
          const mf = dp.maxFreshDays ?? DEFAULT_T2_MAX_FRESH_DAYS;
          if (!Number.isInteger(mf) || mf < 1 || mf > 30) errors.push(`nodes[${i}].dataPlan.maxFreshDays 必须为 1..30 整数`);
        }
        if (dp.paths.includes('T1') && !dp.paths.includes('T2')) {
          errors.push(`nodes[${i}] 仅声明 T1 但当前无 T1 采集器注册机制，须包含 T2 兜底`);
        }
      }
    }
  }

  if (!Array.isArray(def.edges) || def.edges.length < 1) {
    errors.push('链至少需要 1 条边');
  } else if (Array.isArray(def.nodes) && def.edges.length !== def.nodes.length - 1) {
    errors.push(`边数必须 = 节点数 - 1（线性传导链，当前 ${def.edges.length}/${def.nodes.length - 1}）`);
  } else if (Array.isArray(def.nodes)) {
    for (let i = 0; i < def.edges.length; i++) {
      const e = def.edges[i];
      if (!e || e.from !== def.nodes[i].id || e.to !== def.nodes[i + 1].id) {
        errors.push(`edges[${i}] 必须连接 nodes[${i}].id → nodes[${i + 1}].id（顺序传导）`);
      }
      if (!Number.isInteger(e.latencyDays) || e.latencyDays < 1 || e.latencyDays > 10) {
        errors.push(`edges[${i}].latencyDays 必须为 1..10 整数`);
      }
      if (!e.logic || String(e.logic).trim().length < 8) errors.push(`edges[${i}].logic 过短（须写清传导逻辑）`);
    }
  }

  const maxDays = def.maxLifespanTradingDays ?? DEFAULT_MAX_LIFESPAN_TRADING_DAYS;
  if (!Number.isInteger(maxDays) || maxDays < 1 || maxDays > DEFAULT_MAX_LIFESPAN_TRADING_DAYS) {
    errors.push(`maxLifespanTradingDays 必须为 1..${DEFAULT_MAX_LIFESPAN_TRADING_DAYS} 整数`);
  }

  return { ok: errors.length === 0, errors };
}

// ── 池状态辅助 ──────────────────────────────────────────────
function isActive(status) { return ACTIVE_STATUSES.includes(status); }
function isTerminal(status) { return TERMINAL_STATUSES.includes(status); }

function tradingDaysBetween(tradingDates, from, to) {
  if (!Array.isArray(tradingDates) || !from || !to || to <= from) return 0;
  let n = 0;
  for (const d of tradingDates) if (d > from && d <= to) n++;
  return n;
}

// 观察窗口截止日 = windowStart 之后第 latencyDays 个交易日；
// 交易日历不足时（窗口起点是最新交易日）按工作日向后外推补足。
function tradingDeadline(tradingDates, windowStart, latencyDays) {
  if (!windowStart || !Number.isInteger(latencyDays) || latencyDays < 1) return null;
  const after = Array.isArray(tradingDates) ? tradingDates.filter((d) => d > windowStart) : [];
  if (after.length >= latencyDays) return after[latencyDays - 1];
  const base = after.length > 0 ? after[after.length - 1] : windowStart;
  const need = latencyDays - after.length;
  const out = [];
  const d = new Date(Date.parse(`${base}T00:00:00Z`));
  while (out.length < need) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    out.push(d.toISOString().slice(0, 10));
  }
  return out[out.length - 1];
}

function dayDiff(a, b) {
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000);
}

// ── 注册（V3 DAG）──────────────────────────────────────────
function registerChainV3(def, { supersede = false, root = null } = {}) {
  const check = validateChainDefinition(def);
  if (!check.ok) return { ok: false, phase: 'validation_failed', errors: check.errors };

  const ledger = loadLedger(root);
  if (ledger.chains.some((c) => c.chainId === def.chainId)) {
    return { ok: false, phase: 'duplicate_id', errors: [`chainId ${def.chainId} 已存在`] };
  }

  const existing = ledger.chains.find((c) => c.sourceId === def.sourceId && isActive(c.status));
  if (existing) {
    if (!supersede) {
      return { ok: false, phase: 'source_occupied', errors: [`源 ${def.sourceId} 已有活跃链 ${existing.chainId}；用 --supersede 换代`] };
    }
    const old = loadChain(existing.chainId, root);
    if (old) {
      old.status = 'superseded';
      old.closedAt = def.createdAt;
      old.closeReason = 'superseded';
      old.events.push({ date: def.createdAt, type: 'superseded', detail: `被 ${def.chainId} 替代` });
      saveChain(old, root);
      const lc = ledger.chains.find((c) => c.chainId === existing.chainId);
      lc.status = 'superseded';
      lc.closedAt = def.createdAt;
      lc.closeReason = 'superseded';
    }
  }

  const catalog = loadCatalog();
  const syms = loadSymbolsConfig();
  const allowed = buildAllowedIndicatorIdsV3(catalog, (syms && syms.symbols) || []);
  const catalogMap = new Map();
  if (catalog && catalog.indicators) {
    for (const [key, ind] of Object.entries(catalog.indicators)) {
      if (key.includes('{sector}')) {
        for (const s of catalog.sectors || []) catalogMap.set(key.replace('{sector}', s), ind);
      } else if (key.includes('{symbol}')) {
        for (const sd of (syms && syms.symbols) || []) if (sd && sd.active) catalogMap.set(key.replace('{symbol}', sd.symbol), ind);
      } else {
        catalogMap.set(key, ind);
      }
    }
  }

  const nodes = def.nodes.map((n) => {
    const hasT0 = n.indicatorId && allowed.has(n.indicatorId);
    const ind = hasT0 ? catalogMap.get(n.indicatorId) : null;
    const terminal = !!n.terminal;
    return {
      id: n.id,
      concept: n.concept || null,
      dataPlan: n.dataPlan || null,
      indicatorId: hasT0 ? n.indicatorId : null,
      expectation: n.expectation,
      label: n.label || null,
      unit: hasT0 && ind ? ind.unit : (n.dataPlan && n.dataPlan.unit) || null,
      status: 'pending',
      windowStartDate: null,
      windowDeadlineDate: null,
      windowLatencyDays: null,
      sameStreak: 0, oppStreak: 0,
      resolution: hasT0 ? { path: 'T0', source: 'catalog', asOf: null } : null,
      credibility: null,
      observedAt: null, observedValue: null, observedDirection: null,
      lastValue: null, lastValueAt: null,
      prevValue: null, prevValueAt: null,
      brokenReason: null,
      confirmedAt: null, brokenAt: null,
      terminal,
      priority: terminal ? n.priority : null,
      impactRationale: terminal ? n.impactRationale : null,
      proofIndex: terminal ? n.proofIndex : null,
    };
  });
  // 源节点窗口自注册日开始
  nodes[0].windowStartDate = def.createdAt;

  const unresolved = nodes.filter((n) => n.resolution === null).length;
  const sourceId = def.sourceId;
  const terminals = nodes.filter((n) => n.terminal).map((n) => ({
    nodeId: n.id, symbol: String(n.indicatorId).split('.')[1], priority: n.priority,
    impactRationale: n.impactRationale, proofIndex: n.proofIndex, status: unresolved > 0 ? 'resolving' : 'pending',
    direction: n.expectation, confirmedCount: 0, intact: true,
  }));

  const chain = {
    schema: CHAIN_SCHEMA,
    chainId: def.chainId,
    sourceId,
    theme: def.theme || null,
    themeDetail: def.themeDetail || null,
    definition: def,
    status: unresolved > 0 ? 'resolving' : 'pending',
    createdAt: def.createdAt,
    maxLifespanTradingDays: def.maxLifespanTradingDays ?? DEFAULT_MAX_LIFESPAN_TRADING_DAYS,
    nodes,
    edges: def.edges,
    terminals,
    events: [{ date: def.createdAt, type: 'registered', detail: `DAG 链注册，源 ${sourceId}；终点 ${terminals.map((t) => t.symbol).join('/')}；T0 节点 ${nodes.filter((n) => n.resolution && n.resolution.path === 'T0').length}/${nodes.length}，待解析 ${unresolved}` }],
    provenAt: null, completedAt: null, falsifiedAt: null, expiredAt: null, voidAt: null,
    closedAt: null, closeReason: null,
  };

  ledger.chains.push({
    chainId: def.chainId, sourceId, status: chain.status,
    createdAt: def.createdAt, closedAt: null, closeReason: null,
  });
  saveChain(chain, root);
  saveLedger(ledger, root);
  return { ok: true, chainId: def.chainId, superseded: existing ? existing.chainId : null, status: chain.status, unresolved, terminals: terminals.length };
}

// ── 注册 ────────────────────────────────────────────────────
function registerChain(def, { supersede = false, root = null } = {}) {
  if (def && def.schema === CHAIN_SCHEMA) {
    return registerChainV3(def, { supersede, root });
  }
  const check = validateChainDefinition(def);
  if (!check.ok) return { ok: false, phase: 'validation_failed', errors: check.errors };

  const ledger = loadLedger(root);
  if (ledger.chains.some((c) => c.chainId === def.chainId)) {
    return { ok: false, phase: 'duplicate_id', errors: [`chainId ${def.chainId} 已存在`] };
  }

  const existing = ledger.chains.find((c) => c.sector === def.sector && isActive(c.status));
  if (existing) {
    if (!supersede) {
      return { ok: false, phase: 'sector_occupied', errors: [`板块 ${def.sector} 已有活跃链 ${existing.chainId}；用 --supersede 换代`] };
    }
    const old = loadChain(existing.chainId, root);
    if (old) {
      old.status = 'superseded';
      old.closedAt = def.createdAt;
      old.closeReason = 'superseded';
      old.events.push({ date: def.createdAt, type: 'superseded', detail: `被 ${def.chainId} 替代` });
      saveChain(old, root);
      const lc = ledger.chains.find((c) => c.chainId === existing.chainId);
      lc.status = 'superseded';
      lc.closedAt = def.createdAt;
      lc.closeReason = 'superseded';
    }
  }

  const catalog = loadCatalog();
  const catalogMap = instantiateCatalogMap(catalog, def);
  const nodes = def.nodes.map((n, i) => {
    const hasT0 = n.indicatorId && catalogMap.has(n.indicatorId);
    const ind = hasT0 ? catalogMap.get(n.indicatorId) : null;
    return {
      id: n.id,
      concept: n.concept || null,
      dataPlan: n.dataPlan || null,
      indicatorId: hasT0 ? n.indicatorId : null,
      expectation: n.expectation,
      label: n.label || null,
      unit: hasT0 && ind ? ind.unit : (n.dataPlan && n.dataPlan.unit) || null,
      status: 'pending',
      windowStartDate: i === 0 ? def.createdAt : null,
      windowDeadlineDate: null,
      sameStreak: 0, oppStreak: 0,
      resolution: hasT0 ? { path: 'T0', source: 'catalog', asOf: null } : null,
      credibility: null,
      observedAt: null, observedValue: null, observedDirection: null,
      lastValue: null, lastValueAt: null,
      prevValue: null, prevValueAt: null,
      brokenReason: null,
    };
  });
  const unresolved = nodes.filter((n) => n.resolution === null).length;
  const chain = {
    schema: def.schema === LEGACY_CHAIN_SCHEMA ? LEGACY_CHAIN_SCHEMA : V2_CHAIN_SCHEMA,
    chainId: def.chainId,
    theme: def.theme || null,
    definition: def,
    status: unresolved > 0 ? 'resolving' : 'pending',
    createdAt: def.createdAt,
    sector: def.sector,
    direction: def.direction,
    representative: def.representative,
    entryProofIndex: def.entryProofIndex,
    maxLifespanTradingDays: def.maxLifespanTradingDays ?? DEFAULT_MAX_LIFESPAN_TRADING_DAYS,
    nodes,
    edges: def.edges,
    events: [{ date: def.createdAt, type: 'registered', detail: `链注册，证明点 p=${def.entryProofIndex}；T0 节点 ${nodes.filter((n) => n.resolution && n.resolution.path === 'T0').length}/${nodes.length}，待解析 ${unresolved}` }],
    provenAt: null, completedAt: null, falsifiedAt: null, expiredAt: null, voidAt: null,
    closedAt: null, closeReason: null,
  };

  ledger.chains.push({
    chainId: def.chainId, sector: def.sector, status: chain.status,
    createdAt: def.createdAt, closedAt: null, closeReason: null,
  });
  saveChain(chain, root);
  saveLedger(ledger, root);
  return { ok: true, chainId: def.chainId, superseded: existing ? existing.chainId : null, status: chain.status, unresolved };
}

function instantiateCatalogIds(catalog, def) {
  return new Set(instantiateCatalogMap(catalog, def).keys());
}

function instantiateCatalogMap(catalog, def) {
  const map = new Map();
  if (!catalog || !catalog.indicators) return map;
  for (const [key, ind] of Object.entries(catalog.indicators)) {
    if (key.includes('{sector}')) {
      for (const s of catalog.sectors || []) map.set(key.replace('{sector}', s), ind);
    } else if (key.includes('{symbol}')) {
      if (def.representative) map.set(key.replace('{symbol}', def.representative), ind);
    } else {
      map.set(key, ind);
    }
  }
  return map;
}

// ── T2 检索任务与解析 ───────────────────────────────────────
function generateResolveBrief(chainId, { root = null } = {}) {
  const chain = loadChain(chainId, root);
  if (!chain) return { ok: false, errors: [`链不存在: ${chainId}`] };
  const unresolved = chain.nodes.filter((n) => n.resolution === null);
  if (unresolved.length === 0) return { ok: false, errors: ['没有待解析节点'] };
  const brief = {
    schema: 'futures-radar-story-node-research-brief/1',
    chainId,
    generatedAt: new Date().toISOString(),
    note: 'LLM/agent 按请求检索，把结果写回 <chainId>.results.json；来源必须带 URL 与层级 S/A/B/C；不得编造。',
    requests: unresolved.map((n) => ({
      nodeId: n.id,
      concept: n.concept,
      unit: n.dataPlan.unit,
      baseline: n.dataPlan.baseline,
      searchHints: n.dataPlan.searchHints || [],
      queries: [n.concept, `${n.dataPlan.unit || ''}`, ...(n.dataPlan.searchHints || [])].filter(Boolean).map((q) => q.trim()).filter((q) => q.length > 0),
    })),
  };
  writeJsonAtomic(briefPath(chainId, root), brief);
  return { ok: true, file: briefPath(chainId, root), requests: brief.requests };
}

function deriveCredibility(node, obsDate) {
  const r = node && node.resolution;
  if (!r) return node && node.indicatorId ? 'high' : 'unknown'; // legacy v1 T0 目录指标
  if (r.path === 'T0') return 'high'; // 文件库确定性 + provenance
  const tier = r.sourceTier;
  const maxFresh = (node.dataPlan && node.dataPlan.maxFreshDays) || DEFAULT_T2_MAX_FRESH_DAYS;
  const age = r.asOf ? dayDiff(obsDate, r.asOf) : 0;
  const fresh = age <= maxFresh;
  const independent = Array.isArray(r.sources) ? new Set(r.sources.map((s) => s && s.url).filter(Boolean)).size : 1;
  if (tier === 'S' || tier === 'A') {
    if (fresh && independent >= 2) return 'high';
    if (fresh) return 'medium';
    return 'medium';
  }
  if (tier === 'B') return fresh ? 'low' : 'unknown';
  return 'unknown';
}

function resolveChain(chainId, { root = null, results = null, voidReason = null } = {}) {
  const chain = loadChain(chainId, root);
  if (!chain) return { ok: false, errors: [`链不存在: ${chainId}`] };
  if (voidReason) {
    if (!isActive(chain.status) && chain.status !== 'resolving') {
      return { ok: false, errors: [`链 ${chainId} 状态为 ${chain.status}，不可作废`] };
    }
  } else if (chain.status !== 'resolving') {
    return { ok: false, errors: [`链 ${chainId} 状态为 ${chain.status}，不在 resolving`] };
  }

  if (voidReason) {
    chain.status = 'void';
    chain.voidAt = new Date().toISOString().slice(0, 10);
    chain.closedAt = chain.voidAt;
    chain.closeReason = 'void';
    chain.events.push({ date: chain.voidAt, type: 'void', detail: String(voidReason) });
    saveChain(chain, root);
    const ledger = loadLedger(root);
    const row = ledger.chains.find((c) => c.chainId === chainId);
    if (row) { row.status = 'void'; row.closedAt = chain.closedAt; row.closeReason = 'void'; }
    saveLedger(ledger, root);
    return { ok: true, chainId, status: 'void' };
  }

  const entries = Array.isArray(results) ? results : (results && Array.isArray(results.results) ? results.results : null);
  if (!entries) return { ok: false, errors: ['需要 T2 检索结果（results 数组）'] };
  const byNode = new Map(entries.filter((e) => e && e.nodeId).map((e) => [e.nodeId, e]));
  const errors = [];
  let resolvedNow = 0;

  for (const node of chain.nodes) {
    if (node.resolution) continue;
    const e = byNode.get(node.id);
    if (!e) continue;
    if (!Number.isFinite(e.value)) { errors.push(`${node.id}: value 缺失或非数值`); continue; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.asOf || '')) { errors.push(`${node.id}: asOf 必须为 YYYY-MM-DD`); continue; }
    if (e.asOf > new Date().toISOString().slice(0, 10)) { errors.push(`${node.id}: asOf 晚于今天`); continue; }
    if (!e.sourceUrl || String(e.sourceUrl).trim().length === 0) { errors.push(`${node.id}: sourceUrl 缺失`); continue; }
    const tier = VALID_TIERS.includes(e.sourceTier) ? e.sourceTier : 'C';
    node.prevValue = node.resolution && Number.isFinite(node.resolution.value) ? node.resolution.value : node.lastValue;
    node.prevValueAt = node.resolution && node.resolution.asOf ? node.resolution.asOf : node.lastValueAt;
    node.resolution = {
      path: 'T2',
      sourceUrl: String(e.sourceUrl),
      sourceTitle: e.sourceTitle || null,
      sourceTier: tier,
      sources: [{ url: String(e.sourceUrl), title: e.sourceTitle || null }],
      value: e.value,
      asOf: e.asOf,
      unit: e.unit || (node.dataPlan && node.dataPlan.unit) || null,
    };
    node.indicatorId = `T2.${chainId}.${node.id}`;
    node.unit = e.unit || (node.dataPlan && node.dataPlan.unit) || null;
    node.lastValue = e.value;
    node.lastValueAt = e.asOf;
    resolvedNow++;
  }

  const remaining = chain.nodes.filter((n) => n.resolution === null).length;
  chain.events.push({ date: new Date().toISOString().slice(0, 10), type: 'resolve_progress', detail: `本轮解析 ${resolvedNow} 个节点，剩余 ${remaining}` });
  if (remaining === 0) {
    chain.status = 'pending';
    chain.events.push({ date: new Date().toISOString().slice(0, 10), type: 'resolved', detail: '全部节点已解析，证明点解冻' });
  }
  saveChain(chain, root);
  const ledger = loadLedger(root);
  const row = ledger.chains.find((c) => c.chainId === chainId);
  if (row) row.status = chain.status;
  saveLedger(ledger, root);
  return { ok: true, chainId, status: chain.status, resolvedNow, remaining, errors };
}

// ── 节点观测与状态机 ────────────────────────────────────────
// values: { indicatorId: { value, direction, speedZ? } }（T0 指标由 story-indicators 计算）
// ── 节点观测与状态机（V3 DAG：分支路径无关证明）─────────────
function applyObservationV3(chain, date, values, ctx = {}) {
  if (!chain || isTerminal(chain.status)) return { chain, events: [] };
  const events = [];
  const tradingDates = ctx.tradingDates || null;

  if (tradingDates) {
    const age = tradingDaysBetween(tradingDates, chain.createdAt, date);
    if (age > chain.maxLifespanTradingDays) {
      chain.status = 'expired';
      chain.expiredAt = date;
      chain.closedAt = date;
      chain.closeReason = 'expired';
      events.push({ date, type: 'expired', detail: `注册后 ${age} 个交易日仍未完成` });
      return { chain, events };
    }
  }

  // 当前值更新（T0/T2 同口径）
  const newData = new Map();
  for (const n of chain.nodes) {
    const isLegacyT0 = !n.resolution && n.indicatorId;
    const p = n.resolution ? n.resolution.path : (isLegacyT0 ? 'T0' : null);
    if (p === 'T0') {
      const v = values && values[n.indicatorId];
      if (v && v.value !== undefined && v.value !== null) {
        const vAsOf = v.asOf || date;
        const hasNew = n.lastValueAt === null || n.lastValueAt === undefined || vAsOf > n.lastValueAt;
        newData.set(n.id, hasNew);
        if (hasNew) {
          n.prevValue = v.prevValue ?? n.lastValue;
          n.prevValueAt = v.prevAt ?? n.lastValueAt;
          n.lastValue = v.value;
          n.lastValueAt = vAsOf;
        }
      }
    } else if (p === 'T2' && n.resolution && n.resolution.value !== undefined) {
      const hasNew = !n.lastValueAt || n.resolution.asOf >= n.lastValueAt;
      newData.set(n.id, hasNew);
      if (hasNew) {
        n.prevValue = n.lastValue;
        n.prevValueAt = n.lastValueAt;
        n.lastValue = n.resolution.value;
        n.lastValueAt = n.resolution.asOf;
      }
    }
    if ((n.status === 'confirmed' || n.status === 'broken') && (n.credibility === null || n.credibility === undefined || n.credibility === 'unknown')) {
      if (p === 'T0') n.credibility = 'high';
    }
  }

  for (const n of chain.nodes) {
    const v = values && values[n.indicatorId];
    if (v && Number.isFinite(v.speedZ) && Math.abs(v.speedZ) > 2.0) {
      events.push({ date, type: 'speed_anomaly', nodeId: n.id, detail: `流速异常 z=${Number(v.speedZ).toFixed(2)}（仅告警，不判死链）` });
    }
  }

  const byId = new Map(chain.nodes.map((n) => [n.id, n]));
  const order = topologicalOrder(chain.nodes, chain.edges) || chain.nodes.map((n) => n.id);

  for (const id of order) {
    const node = byId.get(id);
    if (!node || node.status !== 'pending') continue;

    // 源节点或至少一个父节点已确认，节点观察窗口才开启
    const isSource = id === chain.nodes[0].id;
    const parents = (chain.edges || []).filter((e) => e.to === id).map((e) => e.from);
    if (!isSource && !parents.some((p) => byId.get(p) && byId.get(p).status === 'confirmed')) continue;
    if (!node.windowStartDate) continue;

    const windowStart = node.windowStartDate;
    const latencyDays = node.windowLatencyDays || 5;

    let obsValue = null, obsDir = 0, obsAt = date;
    if (node.resolution && node.resolution.path === 'T2') {
      const r = node.resolution;
      const maxFresh = (node.dataPlan && node.dataPlan.maxFreshDays) || DEFAULT_T2_MAX_FRESH_DAYS;
      const age = r.asOf ? dayDiff(date, r.asOf) : Infinity;
      if (Number.isFinite(age) && age <= maxFresh && newData.get(node.id) === true) {
        const baseline = node.dataPlan && node.dataPlan.baseline;
        const diff = Number.isFinite(baseline) ? r.value - baseline : null;
        obsDir = Number.isFinite(diff) && diff !== 0 ? (diff > 0 ? 1 : -1) : 0;
        obsValue = r.value;
        obsAt = r.asOf;
      }
    } else {
      const v = values ? values[node.indicatorId] : null;
      const vAsOf = v && v.asOf ? v.asOf : date;
      if (v && vAsOf >= windowStart && newData.get(node.id) === true) {
        obsValue = v.value;
        obsDir = (v.direction === 1 || v.direction === -1) ? v.direction : 0;
        obsAt = vAsOf;
      }
    }

    if (obsDir !== 0) {
      const cred = deriveCredibility(node, date);
      if (obsDir === node.expectation) {
        node.sameStreak = (node.sameStreak || 0) + 1;
        node.oppStreak = 0;
        node.observedAt = obsAt;
        node.observedValue = obsValue;
        node.observedDirection = obsDir;
        node.credibility = cred;
        const needSame = node.resolution && node.resolution.path === 'T2' ? 1 : 2;
        if (node.sameStreak >= needSame) {
          node.status = 'confirmed';
          node.confirmedAt = obsAt;
          events.push({ date, type: 'confirmed', nodeId: node.id, credibility: cred, path: node.resolution ? node.resolution.path : 'T0', detail: `${node.indicatorId || node.concept} 连续 ${node.sameStreak} 个数据日方向 ${obsDir > 0 ? '↑' : '↓'} 符合预期（可信度 ${cred}）` });
          // 打开下游窗口（首个父节点确认即可开启；汇合场景另一父节点确认不重置窗口）
          for (const e of chain.edges || []) {
            if (e.from !== id) continue;
            const child = byId.get(e.to);
            if (child && child.status === 'pending' && !child.windowStartDate) {
              child.windowStartDate = obsAt;
              child.windowDeadlineDate = null;
              child.windowLatencyDays = e.latencyDays;
            }
          }
        } else {
          events.push({ date, type: 'observing', nodeId: node.id, detail: `${node.indicatorId || node.concept} 同向第 ${node.sameStreak}/2 个数据日，暂不确认（单日不判）` });
        }
      } else {
        node.oppStreak = (node.oppStreak || 0) + 1;
        node.sameStreak = 0;
        node.observedAt = obsAt;
        node.observedValue = obsValue;
        node.observedDirection = obsDir;
        node.credibility = cred;
        const needOpp = node.resolution && node.resolution.path === 'T2' ? 1 : 2;
        if (node.oppStreak >= needOpp) {
          node.status = 'broken';
          node.brokenAt = obsAt;
          node.brokenReason = 'opposite_direction';
          events.push({ date, type: 'broken', nodeId: node.id, credibility: cred, path: node.resolution ? node.resolution.path : 'T0', detail: `${node.indicatorId || node.concept} 连续 ${node.oppStreak} 个数据日方向 ${obsDir > 0 ? '↑' : '↓'} 与预期相反（可信度 ${cred}）` });
        } else {
          events.push({ date, type: 'observing_opposite', nodeId: node.id, detail: `${node.indicatorId || node.concept} 反向第 ${node.oppStreak}/2 个数据日，暂不判死（单日反向是扰动）` });
        }
      }
    } else if (tradingDates && tradingDaysBetween(tradingDates, windowStart, date) > latencyDays) {
      node.status = 'broken';
      node.brokenAt = date;
      node.brokenReason = 'timeout';
      events.push({ date, type: 'broken', nodeId: node.id, detail: `${node.indicatorId || node.concept} 在 ${latencyDays} 个交易日内未按预期确认（timeout）` });
    }
  }

  // 分支状态：按祖先集合路径无关计算
  const sourceId = chain.nodes[0].id;
  for (const t of chain.terminals || []) {
    const terminalNode = byId.get(t.nodeId);
    if (!terminalNode) continue;
    const ancestors = ancestorsOf(t.nodeId, chain.nodes, chain.edges); // 不含 terminal，但含源节点
    const upstream = ancestors;
    const confirmedUpstream = upstream.filter((id) => byId.get(id) && byId.get(id).status === 'confirmed').length;
    const anyUnresolved = upstream.some((id) => {
      const n = byId.get(id);
      return n && n.resolution === null && n.status !== 'broken';
    });
    const pathIntact = sourceId === t.nodeId
      ? terminalNode.status !== 'broken'
      : pathExists(sourceId, t.nodeId, chain.nodes, chain.edges, byId);

    let st;
    if (terminalNode.status === 'broken') st = 'falsified';
    else if (!pathIntact) st = 'falsified';
    else if (anyUnresolved) st = 'resolving';
    else if (terminalNode.status === 'confirmed' && upstream.every((id) => byId.get(id) && byId.get(id).status === 'confirmed')) st = 'completed';
    else if (confirmedUpstream >= (t.proofIndex || 0)) st = 'proven';
    else st = 'pending';
    t.status = st;
    t.confirmedUpstream = confirmedUpstream;
    t.intact = pathIntact;
  }

  // 链状态聚合
  aggregateChainStatus(chain, date, events);
  chain.events.push(...events);
  return { chain, events };
}

function pathExists(sourceId, targetId, nodes, edges, byId) {
  const adj = new Map(nodes.map((n) => [n.id, []]));
  for (const e of edges || []) {
    if (e && adj.has(e.from)) adj.get(e.from).push(e.to);
  }
  const seen = new Set();
  const q = [sourceId];
  while (q.length) {
    const id = q.shift();
    if (id === targetId) return true;
    for (const to of adj.get(id) || []) {
      const n = byId.get(to);
      if (n && n.status === 'broken') continue;
      if (!seen.has(to)) { seen.add(to); q.push(to); }
    }
  }
  return false;
}

function aggregateChainStatus(chain, date, events) {
  const branches = chain.terminals || [];
  if (branches.length === 0) return;
  const active = branches.filter((t) => ['resolving', 'pending', 'proven'].includes(t.status));
  if (active.length > 0) {
    const next = active.some((t) => t.status === 'proven') ? 'proven'
      : active.some((t) => t.status === 'pending') ? 'pending' : 'resolving';
    if (chain.status !== next) {
      chain.status = next;
      if (next === 'proven' && !chain.provenAt) {
        chain.provenAt = date;
        events.push({ date, type: 'proven', detail: '至少一条分支达到证明点' });
      }
    }
    return;
  }
  if (branches.every((t) => t.status === 'completed')) {
    chain.status = 'completed';
    chain.completedAt = date;
    chain.closedAt = date;
    chain.closeReason = 'completed';
    events.push({ date, type: 'completed', detail: '全部分支终点确认，传导链走完' });
    return;
  }
  if (branches.every((t) => t.status === 'falsified')) {
    chain.status = 'falsified';
    chain.falsifiedAt = date;
    chain.closedAt = date;
    chain.closeReason = 'falsified';
    events.push({ date, type: 'falsified', detail: '全部分支断裂' });
    return;
  }
  // 部分完成部分断裂：保持最活跃状态，但不关闭全链
  if (chain.status === 'completed' || chain.status === 'falsified') {
    chain.status = 'pending';
  }
}

function applyObservation(chain, date, values, ctx = {}) {
  if (chain && chain.schema === CHAIN_SCHEMA) return applyObservationV3(chain, date, values, ctx);
  if (!chain || isTerminal(chain.status)) return { chain, events: [] };
  const events = [];
  const tradingDates = ctx.tradingDates || null;

  // 链级寿命（resolving 期间同样计时）
  if (tradingDates) {
    const age = tradingDaysBetween(tradingDates, chain.createdAt, date);
    if (age > chain.maxLifespanTradingDays) {
      chain.status = 'expired';
      chain.expiredAt = date;
      chain.closedAt = date;
      chain.closeReason = 'expired';
      events.push({ date, type: 'expired', detail: `注册后 ${age} 个交易日仍未完成` });
      return { chain, events };
    }
  }

  if (chain.status === 'resolving') return { chain, events };

  // 更新每个节点的「当前值」供看板展示（T0 取观测值，T2 取已解析快照）
  const newData = new Map(); // nodeId → 本次是否有真实新数据
  for (const n of chain.nodes) {
    const isLegacyT0 = !n.resolution && n.indicatorId;
    const path = n.resolution ? n.resolution.path : (isLegacyT0 ? 'T0' : null);
    if (path === 'T0') {
      const v = values && values[n.indicatorId];
      if (v && v.value !== undefined && v.value !== null) {
        const vAsOf = v.asOf || date;
        // 新数据 = 真实数据日推进（asOf > 上次数据日）；同数据日重复观测不更新、不判定
        const hasNew = n.lastValueAt === null || n.lastValueAt === undefined || vAsOf > n.lastValueAt;
        newData.set(n.id, hasNew);
        if (hasNew) {
          n.prevValue = v.prevValue ?? n.lastValue;   // 前值 = 序列真实上一周期值
          n.prevValueAt = v.prevAt ?? n.lastValueAt;
          n.lastValue = v.value;
          n.lastValueAt = vAsOf;
        }
      }
    } else if (path === 'T2' && n.resolution.value !== undefined) {
      const hasNew = !n.lastValueAt || n.resolution.asOf >= n.lastValueAt;
      newData.set(n.id, hasNew);
      if (hasNew) {
        n.prevValue = n.lastValue;
        n.prevValueAt = n.lastValueAt;
        n.lastValue = n.resolution.value;
        n.lastValueAt = n.resolution.asOf;
      }
    }
    // legacy 链/历史确认节点：可信度回填（T0 目录指标 = high）
    if ((n.status === 'confirmed' || n.status === 'broken')
      && (n.credibility === null || n.credibility === undefined || n.credibility === 'unknown')) {
      if (path === 'T0') n.credibility = 'high';
    }
  }

  // 补齐所有节点的观察窗口截止日（已确认节点也展示其窗口）
  if (tradingDates) {
    for (let i = 0; i < chain.nodes.length; i++) {
      const n = chain.nodes[i];
      if (n.windowStartDate && (n.windowDeadlineDate === null || n.windowDeadlineDate === undefined)) {
        const lat = i === 0 ? chain.edges[0].latencyDays : chain.edges[i - 1].latencyDays;
        n.windowDeadlineDate = tradingDeadline(tradingDates, n.windowStartDate, lat);
      }
    }
  }

  // 流速异常告警（T0 指标；不判死链）
  for (const n of chain.nodes) {
    const v = values && values[n.indicatorId];
    if (v && Number.isFinite(v.speedZ) && Math.abs(v.speedZ) > 2.0) {
      events.push({ date, type: 'speed_anomaly', nodeId: n.id, detail: `流速异常 z=${Number(v.speedZ).toFixed(2)}（仅告警，不判死链）` });
    }
  }

  const idx = chain.nodes.findIndex((n) => n.status === 'pending');
  if (idx === -1) return { chain, events };
  const node = chain.nodes[idx];
  const edge = idx === 0 ? null : chain.edges[idx - 1];
  const latencyDays = edge ? edge.latencyDays : chain.edges[0].latencyDays;
  const windowStart = node.windowStartDate || chain.createdAt;

  // 观察窗口未开始：不评估（当前值仍已在上方更新）
  if (date < windowStart) return { chain, events };

  let obsValue = null, obsDir = 0, obsAt = date;
  if (node.resolution && node.resolution.path === 'T2') {
    const r = node.resolution;
    const maxFresh = (node.dataPlan && node.dataPlan.maxFreshDays) || DEFAULT_T2_MAX_FRESH_DAYS;
    const age = r.asOf ? dayDiff(date, r.asOf) : Infinity;
    if (Number.isFinite(age) && age <= maxFresh && newData.get(node.id) === true) {
      const baseline = node.dataPlan && node.dataPlan.baseline;
      const diff = Number.isFinite(baseline) ? r.value - baseline : null;
      obsDir = Number.isFinite(diff) && diff !== 0 ? (diff > 0 ? 1 : -1) : 0;
      obsValue = r.value;
      obsAt = r.asOf;
    } // 过期/无新数据 → 无观测，走 timeout
  } else {
    const v = values ? values[node.indicatorId] : null;
    const vAsOf = v && v.asOf ? v.asOf : date;
    // 必须同时满足：窗口已开启、真实数据日不早于窗口起点、本次有真实新数据
    if (v && vAsOf >= windowStart && newData.get(node.id) === true) {
      obsValue = v.value;
      obsDir = (v.direction === 1 || v.direction === -1) ? v.direction : 0;
      obsAt = vAsOf;
    }
  }

  if (obsDir !== 0) {
    const cred = deriveCredibility(node, date);
    if (obsDir === node.expectation) {
      node.sameStreak = (node.sameStreak || 0) + 1;
      node.oppStreak = 0;
      node.observedAt = obsAt;
      node.observedValue = obsValue;
      node.observedDirection = obsDir;
      node.credibility = cred;
      const needSame = node.resolution && node.resolution.path === 'T2' ? 1 : 2; // T2 事件快照一次即可；日频指标需连续 2 个数据日
      if (node.sameStreak >= needSame) {
        // 状态确认：连续 2 个不同数据日同向才算 confirmed（流是状态，不是单日事件）
        node.status = 'confirmed';
        events.push({ date, type: 'confirmed', nodeId: node.id, credibility: cred, path: node.resolution ? node.resolution.path : 'T0', detail: `${node.indicatorId || node.concept} 连续 ${node.sameStreak} 个数据日方向 ${obsDir > 0 ? '↑' : '↓'} 符合预期（可信度 ${cred}）` });

        const confirmedPrefix = chain.nodes.filter((n) => n.status === 'confirmed').length;
        if (idx === chain.nodes.length - 1) {
          chain.status = 'completed';
          chain.completedAt = date;
          chain.closedAt = date;
          chain.closeReason = 'completed';
          events.push({ date, type: 'completed', detail: '终节点确认，传导链走完' });
        } else {
          chain.nodes[idx + 1].windowStartDate = date;
          chain.nodes[idx + 1].windowDeadlineDate = null;
          if (chain.status === 'pending' && confirmedPrefix >= chain.entryProofIndex) {
            chain.status = 'proven';
            chain.provenAt = date;
            events.push({ date, type: 'proven', detail: `前 ${confirmedPrefix} 个节点确认，达到证明点 p=${chain.entryProofIndex}，可入场` });
          }
        }
      } else {
        events.push({ date, type: 'observing', nodeId: node.id, detail: `${node.indicatorId || node.concept} 同向第 ${node.sameStreak}/2 个数据日，暂不确认（单日不判）` });
      }
    } else {
      node.oppStreak = (node.oppStreak || 0) + 1;
      node.sameStreak = 0;
      node.observedAt = obsAt;
      node.observedValue = obsValue;
      node.observedDirection = obsDir;
      node.credibility = cred;
      const needOpp = node.resolution && node.resolution.path === 'T2' ? 1 : 2; // T2 事件快照一次即断
      if (node.oppStreak >= needOpp) {
        // 状态证伪：连续 2 个不同数据日反向才判断裂（单日反向是扰动）
        node.status = 'broken';
        node.brokenReason = 'opposite_direction';
        chain.status = 'falsified';
        chain.falsifiedAt = date;
        chain.closedAt = date;
        chain.closeReason = 'falsified';
        events.push({ date, type: 'broken', nodeId: node.id, credibility: cred, path: node.resolution ? node.resolution.path : 'T0', detail: `${node.indicatorId || node.concept} 连续 ${node.oppStreak} 个数据日方向 ${obsDir > 0 ? '↑' : '↓'} 与预期相反（可信度 ${cred}）` });
        events.push({ date, type: 'falsified', detail: `链断于节点 ${node.id}` });
      } else {
        events.push({ date, type: 'observing_opposite', nodeId: node.id, detail: `${node.indicatorId || node.concept} 反向第 ${node.oppStreak}/2 个数据日，暂不判死（单日反向是扰动）` });
      }
    }
  } else if (tradingDates && tradingDaysBetween(tradingDates, windowStart, date) > latencyDays) {
    node.status = 'broken';
    node.brokenReason = 'timeout';
    chain.status = 'falsified';
    chain.falsifiedAt = date;
    chain.closedAt = date;
    chain.closeReason = 'falsified';
    events.push({ date, type: 'broken', nodeId: node.id, detail: `${node.indicatorId || node.concept} 在 ${latencyDays} 个交易日内未按预期确认（timeout）` });
    events.push({ date, type: 'falsified', detail: `链断于节点 ${node.id}（超时）` });
  }

  chain.events.push(...events);
  return { chain, events };
}

function observeAll(date, values, { root = null, tradingDates = null } = {}) {
  const ledger = loadLedger(root);
  const touched = [];
  const alerts = [];
  for (const row of ledger.chains.filter((c) => isActive(c.status))) {
    const chain = loadChain(row.chainId, root);
    if (!chain) continue;
    const { events } = applyObservation(chain, date, values, { tradingDates });
    if (isTerminal(chain.status)) {
      row.status = chain.status;
      row.closedAt = chain.closedAt || date;
      row.closeReason = chain.closeReason;
    } else if (row.status !== chain.status) {
      row.status = chain.status; // pending → proven 等非终态变化也必须同步台账
    }
    saveChain(chain, root);
    for (const e of events) alerts.push({ chainId: chain.chainId, sector: chain.sector, ...e });
    touched.push({ chainId: chain.chainId, status: chain.status, events });
  }
  saveLedger(ledger, root);
  const view = buildView({ root });
  return { date, touched, alerts, view };
}

// ── 池视图 ─────────────────────────────────────────────────
function buildView({ root = null } = {}) {
  const ledger = loadLedger(root);
  const chains = [];
  for (const row of ledger.chains) {
    const c = loadChain(row.chainId, root);
    if (c) chains.push(c);
  }
  const seatsByChain = loadSeatRecords(root);
  const active = chains.filter((c) => isActive(c.status))
    .map((c) => {
      const branches = (c.terminals && c.terminals.length > 0)
        ? c.terminals.map((t) => ({
            branchId: t.nodeId,
            symbol: t.symbol,
            direction: t.direction,
            priority: t.priority,
            status: t.status,
            proofIndex: t.proofIndex,
            impactRationale: t.impactRationale,
            confirmedUpstream: t.confirmedUpstream || 0,
            intact: t.intact !== false,
          }))
        : [{
            branchId: null,
            symbol: c.representative || null,
            direction: c.direction,
            priority: 'primary',
            status: c.status,
            proofIndex: c.entryProofIndex || null,
            impactRationale: null,
            confirmedUpstream: null,
            intact: true,
          }];
      return {
        chainId: c.chainId,
        sourceId: c.sourceId || null,
        theme: c.theme || '（legacy 链，无主题）',
        themeDetail: c.themeDetail || null,
        sector: c.sector || null,
        direction: c.direction ?? (branches[0] && branches[0].direction) ?? null,
        representative: c.representative || (branches[0] && branches[0].symbol) || null,
        status: c.status,
        createdAt: c.createdAt,
        confirmedNodes: c.nodes.filter((n) => n.status === 'confirmed').length,
        totalNodes: c.nodes.length,
        entryProofIndex: c.entryProofIndex ?? null,
        unresolvedNodes: c.nodes.filter((n) => n.resolution === null).length,
        activeNode: (c.nodes.find((n) => n.status === 'pending') || {}).id || null,
        seats: seatsByChain.get(c.chainId) || [],
        linkedSignalId: c.linkedSignalId || null,
        branches,
        nodes: c.nodes.map((n) => ({
          id: n.id, indicatorId: n.indicatorId, concept: n.concept, expectation: n.expectation,
          label: n.label, status: n.status, credibility: n.credibility, brokenReason: n.brokenReason,
          unit: n.unit || null,
          observedValue: n.observedValue, observedDirection: n.observedDirection,
          observedAt: n.observedAt,
          windowStartDate: n.windowStartDate || null,
          windowDeadlineDate: n.windowDeadlineDate || null,
          lastValue: n.lastValue, lastValueAt: n.lastValueAt,
          prevValue: n.prevValue, prevValueAt: n.prevValueAt,
          resolution: n.resolution ? { path: n.resolution.path, sourceTier: n.resolution.sourceTier, asOf: n.resolution.asOf } : null,
          terminal: !!n.terminal,
        })),
        events: c.events.slice(-5),
      };
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const closed = chains.filter((c) => isTerminal(c.status))
    .map((c) => ({
      chainId: c.chainId, theme: c.theme || '（legacy 链，无主题）', themeDetail: c.themeDetail || null, sector: c.sector, status: c.status, closeReason: c.closeReason,
      createdAt: c.createdAt, closedAt: c.closedAt,
      confirmedNodes: c.nodes.filter((n) => n.status === 'confirmed').length,
      totalNodes: c.nodes.length, proven: c.provenAt !== null,
    }))
    .sort((a, b) => (b.closedAt || '').localeCompare(a.closedAt || '')).slice(0, 20);

  const evaluatedNodes = chains.reduce((a, c) => a + c.nodes.filter((n) => n.status === 'confirmed' || n.status === 'broken').length, 0);
  const confirmedNodes = chains.reduce((a, c) => a + c.nodes.filter((n) => n.status === 'confirmed').length, 0);
  const credDist = { high: 0, medium: 0, low: 0, unknown: 0 };
  const pathStats = { T0: { evaluated: 0, confirmed: 0 }, T1: { evaluated: 0, confirmed: 0 }, T2: { evaluated: 0, confirmed: 0 } };
  for (const c of chains) {
    for (const n of c.nodes) {
      if (n.status !== 'confirmed' && n.status !== 'broken') continue;
      const pathKey = n.resolution ? n.resolution.path : 'T0';
      if (!pathStats[pathKey]) pathStats[pathKey] = { evaluated: 0, confirmed: 0 };
      pathStats[pathKey].evaluated++;
      if (n.status === 'confirmed') pathStats[pathKey].confirmed++;
      const cred = n.credibility || 'unknown';
      if (n.status === 'confirmed') credDist[cred] = (credDist[cred] || 0) + 1;
    }
  }

  const view = {
    schema: VIEW_SCHEMA,
    generatedAt: new Date().toISOString(),
    activeCount: active.length,
    active,
    recentClosed: closed,
    stats: {
      totalChains: chains.length,
      resolvingChains: chains.filter((c) => c.status === 'resolving').length,
      provenChains: chains.filter((c) => c.provenAt !== null).length,
      completedChains: chains.filter((c) => c.status === 'completed').length,
      falsifiedChains: chains.filter((c) => c.status === 'falsified').length,
      expiredChains: chains.filter((c) => c.status === 'expired').length,
      supersededChains: chains.filter((c) => c.status === 'superseded').length,
      voidChains: chains.filter((c) => c.status === 'void').length,
      nodeHitRate: evaluatedNodes > 0 ? Number((confirmedNodes / evaluatedNodes).toFixed(4)) : null,
      confirmedCredibility: credDist,
      nodeHitRateByPath: pathStats,
    },
  };
  return view;
}

function writeView(root = null) {
  const view = buildView({ root });
  writeJsonAtomic(path.join(poolRoot(root), 'view.json'), view);
  return view;
}

module.exports = {
  CHAIN_SCHEMA, LEGACY_CHAIN_SCHEMA, LEDGER_SCHEMA, VIEW_SCHEMA,
  ACTIVE_STATUSES, TERMINAL_STATUSES,
  DEFAULT_MAX_LIFESPAN_TRADING_DAYS, DEFAULT_T2_MAX_FRESH_DAYS,
  poolRoot, ledgerPath, chainFile, seatsDir, researchDir, briefPath, resultsPath,
  loadLedger, saveLedger, loadChain, saveChain, loadSeatRecords,
  loadCatalog, loadSymbolsConfig,
  validateChainDefinition,
  registerChain,
  generateResolveBrief,
  resolveChain,
  deriveCredibility,
  applyObservation,
  observeAll,
  buildView,
  writeView,
  isActive, isTerminal,
  tradingDaysBetween,
  tradingDeadline,
};
