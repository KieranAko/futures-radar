#!/usr/bin/env node
/**
 * Usage: node experiments/train-scan-cli.js [output.json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { scan } from './lib/train-scan.js';

const require = createRequire(import.meta.url);
const { loadCache } = require('../../backtest/cache-slicer.cjs');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../../..');

const outputPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(root, 'data/futures-radar/train/scan-2026-08-14.json');
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
const result = scan(loadCache());
fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), { encoding: 'utf8', flag: 'w' });
console.log(JSON.stringify(result, null, 2));
