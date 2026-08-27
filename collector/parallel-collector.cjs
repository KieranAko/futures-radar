#!/usr/bin/env node
/**
 * parallel-collector.cjs — Multi-threaded futures data collection
 *
 * Manages thread pool with dynamic task queue, failure pool, and retry mechanism.
 * Divides symbols into batches and executes concurrently with timeout control.
 */

const path = require('path');
const { executeBatch } = require('./batch-runner.cjs');

class ParallelCollector {
  /**
   * @param {Array<string>} symbols - All symbol codes to collect
   * @param {Object} options
   * @param {number} options.maxWorkers - Max concurrent threads (default: 4)
   * @param {number} options.batchSize - Symbols per batch (default: 5)
   * @param {number} options.days - Days of historical data (default: 30)
   * @param {number} options.timeout - Timeout per batch in ms (default: 180000)
   * @param {number} options.maxRetries - Max retry attempts per batch (default: 3)
   * @param {string} options.pythonScript - Path to futures_collector.py
   * @param {string} options.tempDir - Directory for temporary output files
   */
  constructor(symbols, options = {}) {
    this.symbols = symbols;
    this.maxWorkers = options.maxWorkers || 4;
    this.batchSize = options.batchSize || 5;
    this.days = options.days || 30;
    this.timeout = options.timeout || 180000; // 3 minutes
    this.maxRetries = options.maxRetries || 3;
    this.pythonScript = options.pythonScript;
    this.tempDir = options.tempDir;

    // Create batches
    this.batches = this.createBatches(symbols, this.batchSize);
    this.queue = [...this.batches];
    this.activeWorkers = 0;

    // Results tracking
    this.results = {
      success: [],
      failed: []
    };

    // Failure pool: batchId → retryCount
    this.failurePool = new Map();

    // Statistics
    this.stats = {
      totalBatches: this.batches.length,
      completed: 0,
      failed: 0,
      retried: 0
    };
  }

  /**
   * Split symbols into batches
   */
  createBatches(symbols, size) {
    const batches = [];
    for (let i = 0; i < symbols.length; i += size) {
      batches.push({
        id: Math.floor(i / size),
        symbols: symbols.slice(i, i + size)
      });
    }
    return batches;
  }

  /**
   * Run collection with thread pool
   */
  async run() {
    console.log(`\n=== Parallel Collection ===`);
    console.log(`Symbols: ${this.symbols.length}, Batches: ${this.batches.length}, Workers: ${this.maxWorkers}`);
    console.log(`Batch size: ${this.batchSize} symbols × ${this.days} days, Timeout: ${this.timeout}ms\n`);

    // Spawn workers
    const workers = [];
    for (let i = 0; i < this.maxWorkers; i++) {
      workers.push(this.worker(i));
    }

    // Wait for all workers to complete
    await Promise.all(workers);

    // Retry failed batches
    await this.retryFailures();

    console.log(`\n=== Collection Complete ===`);
    console.log(`Success: ${this.stats.completed}/${this.stats.totalBatches}`);
    console.log(`Failed: ${this.stats.failed}/${this.stats.totalBatches}`);
    console.log(`Retried: ${this.stats.retried}`);

    return {
      success: this.results.success,
      failed: this.results.failed,
      stats: this.stats
    };
  }

  /**
   * Worker coroutine - consumes tasks from queue
   */
  async worker(workerId) {
    while (this.queue.length > 0 || this.failurePool.size > 0) {
      // Get next batch (priority: queue > failure pool)
      const batch = this.queue.shift();
      if (!batch) {
        // No more tasks in main queue, check failure pool later
        await new Promise(resolve => setTimeout(resolve, 100));
        continue;
      }

      this.activeWorkers++;
      console.log(`[Worker ${workerId}] Starting batch ${batch.id}: ${batch.symbols.join(',')}`);

      try {
        const outputPath = path.join(this.tempDir, `batch_${batch.id}_${Date.now()}.json`);
        const result = await executeBatch(
          batch.symbols,
          this.days,
          outputPath,
          this.pythonScript,
          this.timeout
        );

        console.log(`[Worker ${workerId}] ✓ Batch ${batch.id} complete (${result.elapsed}ms)`);
        this.results.success.push(result);
        this.stats.completed++;

      } catch (err) {
        console.error(`[Worker ${workerId}] ✗ Batch ${batch.id} failed: ${err.message}`);
        this.handleFailure(batch, err);

      } finally {
        this.activeWorkers--;
      }
    }
  }

  /**
   * Handle batch failure - retry up to maxRetries
   */
  handleFailure(batch, error) {
    const retryCount = this.failurePool.get(batch.id) || 0;

    if (retryCount < this.maxRetries) {
      // Add to failure pool for retry
      this.failurePool.set(batch.id, retryCount + 1);
      console.log(`[Retry] Batch ${batch.id} → retry ${retryCount + 1}/${this.maxRetries}`);
      this.stats.retried++;
    } else {
      // Max retries exceeded
      this.results.failed.push({
        batch: batch.id,
        symbols: batch.symbols,
        error: error.message,
        retries: retryCount
      });
      this.stats.failed++;
      console.error(`[Failed] Batch ${batch.id} exceeded ${this.maxRetries} retries`);
    }
  }

  /**
   * Retry all batches in failure pool
   */
  async retryFailures() {
    if (this.failurePool.size === 0) return;

    console.log(`\n=== Retrying ${this.failurePool.size} failed batches ===`);

    const retryBatches = [];
    for (const [batchId, retryCount] of this.failurePool.entries()) {
      const batch = this.batches.find(b => b.id === batchId);
      if (batch) {
        retryBatches.push(batch);
      }
    }

    this.failurePool.clear();
    this.queue = retryBatches;

    // Re-run workers
    const workers = [];
    for (let i = 0; i < this.maxWorkers; i++) {
      workers.push(this.worker(i));
    }
    await Promise.all(workers);
  }
}

module.exports = { ParallelCollector };
