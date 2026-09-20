#!/usr/bin/env node
/**
 * batch-runner.cjs — Execute single batch of futures collection
 *
 * Spawns Python collector for a subset of symbols with timeout control.
 * Returns Promise that resolves to collected data or rejects on failure.
 */

const cp = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * Execute a single batch collection
 * @param {Array<string>} symbols - Symbol codes to collect (e.g., ['SC0', 'M0', 'EG0'])
 * @param {number} days - Days of historical data per symbol
 * @param {string} outputPath - Temporary output file path
 * @param {string} pythonScript - Path to futures_collector.py
 * @param {number} timeout - Timeout in milliseconds
 * @returns {Promise<Object>} Resolves to { symbols, data, elapsed }
 */
function executeBatch(symbols, days, outputPath, pythonScript, timeout) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const symbolList = symbols.join(',');

    const child = cp.spawn('python', [
      pythonScript,
      '--symbols', symbolList,
      '--days', String(days),
      '--output', outputPath
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout,
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('close', (code) => {
      const elapsed = Date.now() - t0;

      if (code === 0) {
        // Success: read output file
        if (!fs.existsSync(outputPath)) {
          return reject(new Error(`Output file not found: ${outputPath}`));
        }

        try {
          const data = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
          fs.unlinkSync(outputPath); // Clean up temp file
          resolve({
            symbols,
            data,
            elapsed: Math.round(elapsed)
          });
        } catch (err) {
          reject(new Error(`Failed to parse output: ${err.message}`));
        }
      } else {
        // Failure
        reject(new Error(`Python exited with code ${code}. stderr: ${stderr.slice(0, 200)}`));
      }
    });

    child.on('error', (err) => {
      reject(new Error(`Spawn failed: ${err.message}`));
    });

    // Timeout handling
    setTimeout(() => {
      if (!child.killed) {
        child.kill('SIGTERM');
        reject(new Error(`Batch timeout after ${timeout}ms for symbols: ${symbolList}`));
      }
    }, timeout);
  });
}

module.exports = { executeBatch };
