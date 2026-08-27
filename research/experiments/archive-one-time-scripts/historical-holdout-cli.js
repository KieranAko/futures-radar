#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { evaluateDirectionMatrix } from './lib/direction-matrix-runner.js';
import { loadHoldoutManifest, runHistoricalHoldout } from './lib/historical-holdout.js';

const require = createRequire(import.meta.url);
const { loadCache } = require('../../backtest/cache-slicer.cjs');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../../..');
const manifestPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(root, 'data/futures-radar/holdout/manifest.json');
const outputPath = process.argv[3]
  ? path.resolve(process.argv[3])
  : path.join(root, 'data/futures-radar/holdout/result.json');

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

const manifest = loadHoldoutManifest(manifestPath);
const sourcePath = path.resolve(root, manifest.source.path);
if (sha256(sourcePath) !== manifest.source.sha256) throw new Error('historical cache hash drifted');
for (const [relativePath, expected] of Object.entries(manifest.lockedFiles)) {
  if (sha256(path.resolve(root, relativePath)) !== expected) {
    throw new Error(`locked file hash drifted: ${relativePath}`);
  }
}

const cache = loadCache();
const replay = runHistoricalHoldout(manifest, cache);
const evaluation = {};
for (const key of Object.keys(manifest.configs)) {
  evaluation[key] = evaluateDirectionMatrix(replay.dates.map(d => d[key]));
}
const report = {
  ...replay,
  generatedAt: new Date().toISOString(),
  evaluation
};
fs.writeFileSync(outputPath, JSON.stringify(report, null, 2), { encoding: 'utf8', flag: 'wx' });
console.log(JSON.stringify({
  outputPath,
  pairedDates: report.pairedDates,
  ...report.evaluation
}, null, 2));
