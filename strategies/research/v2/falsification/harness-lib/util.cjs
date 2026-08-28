// falsification harness — shared utilities (determinism, dates, hashing)
// Convention: everything that involves randomness is seeded; results must be byte-identical across runs.
'use strict';

const crypto = require('node:crypto');
const path = require('node:path');

// REPO_ROOT = <futures-radar> — this file lives at
// <repo>/strategies/research/v2/falsification/harness-lib/util.cjs
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const FALS_DIR = path.join(REPO_ROOT, 'strategies', 'research', 'v2', 'falsification');
const FALS_DATA_DIR = path.join(FALS_DIR, 'data');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) {
    throw new Error(`invalid date string: ${String(s)}`);
  }
  const [y, m, d] = s.split('-').map(Number);
  return { y, m, d, s };
}

// day number since epoch (deterministic, no TZ dependency)
function toDayNum(s) {
  const { y, m, d } = parseDate(s);
  return Date.UTC(y, m - 1, d) / 86400000;
}

function fmtDate(y, m, d) {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// Mulberry32 — small deterministic PRNG
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  constructor(seed) {
    this.seed = seed >>> 0;
    this._next = mulberry32(this.seed);
    this.calls = 0;
  }
  uniform() {
    this.calls += 1;
    return this._next();
  }
  int(n) {
    // uniform int in [0, n)
    if (!Number.isInteger(n) || n <= 0) throw new Error(`bad int bound: ${n}`);
    return Math.floor(this.uniform() * n);
  }
  coin(p = 0.5) {
    return this.uniform() < p;
  }
  pick(arr) {
    return arr[this.int(arr.length)];
  }
  shuffle(arr) {
    // Fisher-Yates with local rng; returns new array
    const out = arr.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }
  fork(label) {
    // deterministic child seed derived from label + current state hash
    const h = crypto.createHash('sha256').update(`${this.seed}:${label}:${this.calls}`).digest();
    return new Rng(h.readUInt32BE(0));
  }
}

function sha256(obj) {
  const s = JSON.stringify(obj);
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

// stable serialization: sorted keys
function stableStringify(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(',')}]`;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function stableHash(obj) {
  return crypto.createHash('sha256').update(stableStringify(obj), 'utf8').digest('hex');
}

function round(x, digits = 6) {
  if (x === null || x === undefined || !Number.isFinite(x)) return x;
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

function assert(cond, msg) {
  if (!cond) throw new Error(`assert failed: ${msg}`);
}

function isFiniteNum(x) {
  return typeof x === 'number' && Number.isFinite(x);
}

module.exports = {
  REPO_ROOT,
  FALS_DIR,
  FALS_DATA_DIR,
  parseDate,
  toDayNum,
  fmtDate,
  Rng,
  mulberry32,
  sha256,
  stableStringify,
  stableHash,
  round,
  assert,
  isFiniteNum,
};
