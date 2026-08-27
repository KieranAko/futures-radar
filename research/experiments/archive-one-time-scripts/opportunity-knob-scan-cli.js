#!/usr/bin/env node
/**
 * Usage: node experiments/opportunity-knob-scan-cli.js [output.json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { scan } from './lib/opportunity-knob-scan.js';

const require = createRequire(import.meta.url);
const { loadCache } = require('../../backtest/cache-slicer.cjs');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../../..');

const outputPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(root, 'data/futures-radar/train/opportunity-knob-scan-2026-08-14.json');

const result = scan(loadCache());

// 锚点校验：frozen 单元必须逐项复现 train-scan-2026-08-14.json 的 ER=0.20 单元
const frozen = result.cells.find(c => c.name === 'frozen');
const anchor = { candidates: 1195, withOutcome: 1184, strong: 796 };
for (const [key, expected] of Object.entries(anchor)) {
  if (frozen[key] !== expected) {
    throw new Error(
      `frozen anchor mismatch: ${key} = ${frozen[key]}, expected ${expected}. ` +
      'Knob scan does not reproduce the frozen pipeline.'
    );
  }
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), { encoding: 'utf8', flag: 'w' });

for (const c of result.cells) {
  const hit = c.hitRate === null ? 'null' : `${(c.hitRate * 100).toFixed(2)}%`;
  console.log(
    `${c.name.padEnd(12)} cand=${String(c.candidates).padStart(4)} ` +
    `wo=${String(c.withOutcome).padStart(4)} strong=${String(c.strong).padStart(4)} ` +
    `hit=${hit}`
  );
}
const f = frozen;
console.log('\nfrozen byYear:', JSON.stringify(f.byYear));
