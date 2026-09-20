#!/usr/bin/env node
/**
 * collector/backoff.cjs — 统一指数退避 + 冷却（P2 可靠容错，v0.1.2）
 *
 * 背景：sina 系接口遇并发/频率过高会返回 456，持续约 10 分钟；批处理重试
 * 若无间隔会立刻再次命中 456。本模块提供：
 *   - retryWithBackoff(fn, opts)：指数退避 + jitter 的重试包装
 *   - SourceCooldown：进程内按源记账的冷却窗口（连续失败后暂停该源 N 秒）
 * 应用点：批量采集重试、收盘快照拉取、宏观锚点 sina_fx。
 */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 指数退避重试。
 * @param {() => Promise<any>} fn
 * @param {{label?:string, attempts?:number, baseMs?:number, maxMs?:number, jitter?:number, shouldRetry?:(e:Error)=>boolean}} opts
 */
async function retryWithBackoff(fn, opts = {}) {
  const {
    label = 'op',
    attempts = 3,
    baseMs = 2000,
    maxMs = 30000,
    jitter = 0.3,
    shouldRetry = () => true
  } = opts;

  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i === attempts - 1 || !shouldRetry(err)) break;
      const delay = Math.min(baseMs * 2 ** i, maxMs);
      const jit = jitter > 0 ? delay * jitter * Math.random() : 0;
      await sleep(Math.round(delay + jit));
    }
  }
  const e = new Error(`${label}: failed after ${attempts} attempt(s): ${lastErr ? lastErr.message : 'unknown'}`);
  e.cause = lastErr;
  throw e;
}

/**
 * 进程内源冷却：某源连续失败 N 次后，冷却 windowMs 内直接抛"冷却中"错误，
 * 避免在 456 窗口内反复锤打同一端点。
 */
class SourceCooldown {
  constructor(opts = {}) {
    this.maxFailures = opts.maxFailures || 3;
    this.windowMs = opts.windowMs || 10 * 60 * 1000; // 默认 10 分钟（对齐 456 恢复周期）
    this.state = new Map(); // source -> {failures, coolUntil}
  }

  recordFailure(source) {
    const s = this.state.get(source) || { failures: 0, coolUntil: 0 };
    s.failures += 1;
    if (s.failures >= this.maxFailures) {
      s.coolUntil = Date.now() + this.windowMs;
    }
    this.state.set(source, s);
  }

  recordSuccess(source) {
    this.state.delete(source);
  }

  coolingDown(source) {
    const s = this.state.get(source);
    if (!s) return false;
    if (s.coolUntil > Date.now()) return true;
    // 仅当冷却期确实开始过且已过期才清理（未进入冷却的累计计数不得被查询清掉）
    if (s.coolUntil > 0) this.state.delete(source);
    return false;
  }

  remainingMs(source) {
    const s = this.state.get(source);
    if (!s || s.coolUntil <= Date.now()) return 0;
    return s.coolUntil - Date.now();
  }
}

module.exports = { sleep, retryWithBackoff, SourceCooldown };
