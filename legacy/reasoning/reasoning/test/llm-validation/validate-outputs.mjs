/**
 * FinCoT Real LLM Validation — Step 3 格式验证
 * 对 outputs/*.md 中的 JSON 输出执行 extractResult + validateGrounding
 * packet 从 runs raw.json + delta term_structure 重建（与单臂对照 After 臂同构）
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildPacketFromRawJson } from '../../lib/raw-adapter.js';
import { buildPacket } from '../../lib/packet-builder.js';
import { extractResult } from '../../lib/post-processor.js';
import { validateGrounding } from '../../lib/grounding-validator.js';

// 路径可通过环境变量覆盖，适配任意安装位置：
//   FUTURES_VALIDATION_RUNS_DIR   — runs 数据目录（含 <runId>/raw.json）
//   FUTURES_VALIDATION_DELTA_DIR  — delta term_structure cases 目录
const SKILL_ROOT = path.resolve(__dirname, '../../..');
const RUNS_DIR = process.env.FUTURES_VALIDATION_RUNS_DIR
  || path.join(SKILL_ROOT, '..', '..', '..', 'data', 'futures-radar', 'runs');
const DELTA_DIR = process.env.FUTURES_VALIDATION_DELTA_DIR || null;
const OUT_DIR = path.join(__dirname, 'outputs');

const CASES = [
  { file: 'SC0-20260730.md', run: '20260730-1701-auto', symbol: 'SC0', date: '2026-07-30' },
  { file: 'Y0-20260821.md', run: '20260824-1503-auto', symbol: 'Y0', date: '2026-08-21' },
  { file: 'I0-20260804.md', run: '20260805-1027-auto', symbol: 'I0', date: '2026-08-04' },
  { file: 'EC0-20260730.md', run: '20260730-1701-auto', symbol: 'EC0', date: '2026-07-30' },
  { file: 'AU0-20260821.md', run: '20260824-1503-auto', symbol: 'AU0', date: '2026-08-21' }
];

function rebuildAfterPacket(run, symbol, signalDate) {
  const rawJsonPath = path.join(RUNS_DIR, run, 'raw.json');
  const raw = buildPacketFromRawJson(rawJsonPath, symbol, signalDate);
  raw.packetFrozenAt = new Date().toISOString();
  for (const name of ['price_data', 'volume_oi']) {
    if (raw.fields[name] && raw.fields[name].gap === null) raw.fields[name]._timestamp_origin = 'observed';
  }
  const delta = JSON.parse(fs.readFileSync(path.join(DELTA_DIR, `${run}__${symbol}`, 'delta.json'), 'utf-8'));
  raw.fields.term_structure = delta.term_structure;
  raw.packetFrozenAt = delta.term_structure.fetchedAt;
  return buildPacket(raw).packet;
}

if (!DELTA_DIR || !fs.existsSync(DELTA_DIR)) {
  console.error('FATAL: delta cases 目录缺失。请设置 FUTURES_VALIDATION_DELTA_DIR 指向 sa-compare/cases（含 <runId>__<symbol>/delta.json）。');
  process.exit(2);
}

let parseOk = 0;
let groundingOk = 0;
const failures = [];

for (const c of CASES) {
  const doc = fs.readFileSync(path.join(OUT_DIR, c.file), 'utf-8');
  const jsonMatch = doc.match(/```json\s*([\s\S]*?)\s*```/);
  if (!jsonMatch) {
    failures.push(`${c.file}: NO_JSON_BLOCK`);
    continue;
  }
  let result;
  try {
    result = extractResult(jsonMatch[1].trim(), {
      expectedSymbol: c.symbol,
      expectedSignalDate: c.date,
      expectedStrategy: 'fincot'
    });
    parseOk += 1;
  } catch (err) {
    failures.push(`${c.file}: PARSE_ERROR ${err.message}`);
    continue;
  }
  const packet = rebuildAfterPacket(c.run, c.symbol, c.date);
  const g = validateGrounding(result, packet);
  if (g.grounded) {
    groundingOk += 1;
    console.log(`[OK] ${c.file}: ${result.direction}/${result.confidence} grounded, evidence=${result.evidence_ids.length}, opposing=${result.opposing_ids.length}`);
  } else {
    failures.push(`${c.file}: GROUNDING_FAIL ${JSON.stringify(g)}`);
    console.log(`[FAIL] ${c.file}: ungrounded ${JSON.stringify(g)}`);
  }
}

console.log(`\nParse: ${parseOk}/${CASES.length}, Grounding: ${groundingOk}/${CASES.length}`);
if (failures.length) {
  console.log('Failures:');
  for (const f of failures) console.log(' -', f);
  process.exitCode = 1;
} else {
  console.log('ALL PASS');
}
