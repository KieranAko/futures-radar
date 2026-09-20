import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const { mergeSeries } = require(path.join(ROOT, 'collector', 'macro-history-builder.cjs'));

describe('macro-history-builder 文件库宏观历史合并', () => {
  it('同日快照按 fetchedAt 最新覆盖，最终按日期升序', () => {
    const base = [['2026-09-01', 1.1], ['2026-09-02', 1.2]];
    const snaps = [
      { date: '2026-09-02', value: 1.3, fetchedAt: '2026-09-02T10:00:00Z' },
      { date: '2026-09-02', value: 1.4, fetchedAt: '2026-09-02T12:00:00Z' },
      { date: '2026-09-03', value: 1.5, fetchedAt: '2026-09-03T10:00:00Z' },
    ];
    assert.deepEqual(mergeSeries(base, snaps), [
      ['2026-09-01', 1.1],
      ['2026-09-02', 1.4],
      ['2026-09-03', 1.5],
    ]);
  });

  it('过滤非法日期与非数值', () => {
    const base = [['2026-09-01', 1.1], ['bad', 2], ['2026-09-02', NaN]];
    assert.deepEqual(mergeSeries(base, []), [['2026-09-01', 1.1]]);
  });
});
