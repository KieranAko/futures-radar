// stories/seats/apply-story-seats.cjs — 故事传导链追踪席位注入
//
// 在 filter-llm 写完 filtered.json 之后、freeze-packets 之前运行（可与 signal-pool
// 追踪席位同一时点，顺序任意）：
//   node stories/seats/apply-story-seats.cjs --runId <runId>
//
// 行为：读取故事池，把所有 proven 链的代表品种强制加入 filtered.json 的 candidates
//       （KEEP，tracking=true / storyChainId），使它们与 TOP3 一样进入完整分析，
//       再由 strategy-plan → signal-pool 完成前向验证（#2 桥）。
//
// 纪律：确定性、不联网、不调用 LLM；只修改 filtered.json 与 candidates.json。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { runDir, skillRoot } = require('../../shared/workspace.cjs');
const { loadLedger, loadChain } = require('../lib/story-chain.cjs');

const SEATS_DIR = path.join(skillRoot, 'data', 'story-pool', 'seats');

function flagVal(args, flag) {
  const i = args.indexOf(flag);
  return i === -1 ? null : args[i + 1];
}

function readJSON(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeJSONAtomic(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, p);
}

function chainDirectionHint(dir) {
  return dir === -1 ? 'bearish' : 'bullish';
}

function chainConfidence(chain) {
  const confirmed = chain.nodes.filter((n) => n.status === 'confirmed');
  if (confirmed.length === 0) return 'medium';
  const bad = confirmed.filter((n) => ['low', 'unknown'].includes(n.credibility)).length;
  const high = confirmed.filter((n) => n.credibility === 'high').length;
  if (high === confirmed.length) return 'high';
  if (bad > 0) return 'low';
  return 'medium';
}

function chainReason(chain) {
  const confirmed = chain.nodes.filter((n) => n.status === 'confirmed').length;
  return `故事传导链 ${chain.chainId}：${chain.provenAt} 达到证明点 p=${chain.entryProofIndex}（已确认 ${confirmed}/${chain.nodes.length} 节点）`;
}

/**
 * 纯函数：把 proven 链注入 filtered.json（镜像 signal-pool 追踪席位）。
 * @param {object} filtered filtered.json 内容
 * @param {object[]} provenChains 故事池中 status=proven 的链
 */
function applyStorySeats(filtered, provenChains, now = new Date().toISOString()) {
  const candidates = Array.isArray(filtered.candidates) ? filtered.candidates : [];
  const downgraded = Array.isArray(filtered.downgraded) ? filtered.downgraded : [];
  const candidateSymbols = new Set(candidates.map((c) => c.symbol));
  const added = [];
  const eligible = (provenChains || []).filter((c) => c && c.status === 'proven' && c.provenAt);

  for (const chain of eligible) {
    if (!chain || candidateSymbols.has(chain.representative)) continue;
    const hint = chainDirectionHint(chain.direction);
    candidates.push({
      symbol: chain.representative,
      rank: 90 + added.length,
      directionHint: hint,
      directionBias: hint,
      decision: 'KEEP',
      confidence: chainConfidence(chain),
      reason: chainReason(chain),
      informationGap: '故事传导链追踪席位：需与 TOP3 同规格完整再分析',
      tracking: true,
      storyChainId: chain.chainId,
      author: 'machine-seat',
    });
    added.push(chain.representative);
  }

  const nextDowngraded = downgraded.filter((d) => {
    if (added.includes(d.symbol) || candidateSymbols.has(d.symbol)) return false;
    return true;
  });

  filtered.candidates = candidates;
  filtered.downgraded = nextDowngraded;
  filtered.meta = filtered.meta || {};
  filtered.meta.outputCount = candidates.filter((c) => c.decision === 'KEEP').length;
  filtered.meta.storySeats = added.length;
  filtered.meta.note = (filtered.meta.note ? filtered.meta.note + '；' : '') + `故事传导链追踪席位注入 ${added.length} 个`;
  filtered.meta.storySeatsAppliedAt = now;
  filtered.meta.seatAuthor = 'machine-seat';
  return { filtered, added };
}

function patchCandidates(candidatesPath, added, provenChains) {
  const candidates = readJSON(candidatesPath);
  const candList = Array.isArray(candidates.candidates) ? candidates.candidates : [];
  const existing = new Set(candList.map((c) => c.symbol));
  const symbolsConfig = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'config', 'symbols.json'), 'utf8'));
  const cfgMap = new Map((symbolsConfig.symbols || []).map((c) => [c.symbol, c]));
  let rank = Math.max(0, ...candList.map((c) => Number(c.rank) || 0)) + 1;
  for (const sym of added) {
    if (existing.has(sym)) continue;
    const cfg = cfgMap.get(sym) || {};
    const chain = provenChains.find((c) => c.representative === sym);
    candList.push({
      symbol: sym,
      name: cfg.name || sym,
      exchange: cfg.exchange || '',
      sector: cfg.sector || (chain && chain.sector) || '',
      rank,
      indicators: { atr5: 0, atrPct: 0, hv5: 0, hv20: 0, volPercentile: 0, volMultiplier: 0, change5d: 0 },
      trend: { close: 0, vsMA20: 0, vsMA60: 0, direction: 'flat' },
      liquidity: { avgVolume5d: 0, avgTurnover5d: 0, avgOI5d: 0 },
      score: 0,
      tracking: true,
      storyChainId: chain ? chain.chainId : null
    });
    rank++;
  }
  candidates.candidates = candList;
  candidates.meta = candidates.meta || {};
  candidates.meta.storySeats = added.length;
  writeJSONAtomic(candidatesPath, candidates);
  return candidates;
}

function main() {
  const args = process.argv.slice(2);
  const runId = flagVal(args, '--runId');
  if (!runId) {
    console.error('FATAL: --runId required');
    process.exit(1);
  }

  const dir = runDir(runId);
  const filteredPath = path.join(dir, 'filtered.json');
  if (!fs.existsSync(filteredPath)) {
    console.error(`FATAL: filtered.json not found in ${dir}`);
    process.exit(1);
  }

  const ledger = loadLedger();
  const provenChains = [];
  for (const row of ledger.chains) {
    if (row.status !== 'proven') continue;
    const c = loadChain(row.chainId);
    if (c) provenChains.push(c);
  }

  const filtered = readJSON(filteredPath);
  const { added } = applyStorySeats(filtered, provenChains);
  writeJSONAtomic(filteredPath, filtered);

  const candidatesPath = path.join(dir, 'candidates.json');
  if (added.length > 0 && fs.existsSync(candidatesPath)) {
    patchCandidates(candidatesPath, added, provenChains);
    console.log(`candidates.json: patched ${added.length} story seat(s)`);
  }

  // 席位血缘前向记录（文件库 data/story-pool/seats/<runId>.json；不回写链文件）
  const seatRecord = writeSeatRecord(runId, added, provenChains);
  if (seatRecord.seats.length > 0) console.log(`seat lineage: ${seatRecord.file}`);

  console.log(`story-chain seats: added ${added.length} (${added.join(', ') || 'none'})`);
  console.log(`filtered.json KEEP=${filtered.meta.outputCount}, downgraded=${filtered.downgraded.length}`);
}

function writeSeatRecord(runId, addedSymbols, provenChains, now = new Date().toISOString()) {
  const seats = addedSymbols.map((sym) => {
    const c = (provenChains || []).find((x) => x.representative === sym);
    return { runId, chainId: c ? c.chainId : null, theme: c ? (c.theme || null) : null, symbol: sym, appliedAt: now };
  });
  const out = { schema: 'futures-radar-story-seats/1', runId, appliedAt: now, seats };
  writeJSONAtomic(path.join(SEATS_DIR, `${runId}.json`), out);
  return { file: path.join(SEATS_DIR, `${runId}.json`), seats };
}

if (require.main === module) main();
module.exports = { main, applyStorySeats, patchCandidates, chainConfidence, chainDirectionHint, writeSeatRecord, SEATS_DIR };
