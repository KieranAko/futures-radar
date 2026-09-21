/**
 * test/news-snapshot.test.js — 新闻/政策快照文件库
 *
 * 覆盖：
 *   1. schema /1 结构校验：type/date/title/summary/sources/tier/verified/singleSource
 *   2. 少而精上限（≤20 条）与板块覆盖告警（不拒收）
 *   3. 写入 data/news/<runId>.json + _index.json 跨期索引 + latestNewsSnapshot
 *   4. digestLines 只投影中性事实字段
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const news = require(path.join(ROOT, 'stories', 'lib', 'news-snapshot.cjs'));

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'news-snapshot-'));
}

function validDoc(overrides = {}) {
  return {
    schema: 'futures-radar-news-snapshot/1',
    runId: '20260921-1514-auto',
    generatedAt: '2026-09-21T07:00:00.000Z',
    items: [
      {
        id: 'news-20260921-black-01',
        date: '2026-09-20',
        type: 'industry',
        sectors: ['black'],
        scope: ['RB0', 'black'],
        title: '全国建筑钢材成交量数据发布',
        summary: 'Mysteel 与兰格钢铁分别发布 9 月 20 日建筑钢材成交量数据，口径与同比基准各异。',
        sources: [
          { url: 'https://gc.mysteel.com/a/x.html', tier: 'A', publishedAt: '2026-09-20' },
          { url: 'https://shidian.lgmi.com/html/202609/20/3139.htm', tier: 'B', publishedAt: '2026-09-20' },
        ],
        verified: true,
        singleSource: false,
        fetchedAt: '2026-09-21T07:00:00.000Z',
      },
      {
        id: 'news-20260921-macro-01',
        date: '2026-09-21',
        type: 'macro',
        sectors: ['macro'],
        scope: ['macro'],
        title: '公开市场操作公告',
        summary: '央行公开市场操作信息发布，本期操作规模与利率保持不变。',
        sources: [
          { url: 'https://www.pbc.gov.cn/example.html', tier: 'A', publishedAt: '2026-09-21' },
        ],
        verified: true,
        singleSource: true,
        fetchedAt: '2026-09-21T07:00:00.000Z',
      },
    ],
    ...overrides,
  };
}

describe('新闻快照 schema 校验', () => {
  it('合法快照通过校验，并给出板块覆盖统计', () => {
    const check = news.validateNewsSnapshot(validDoc());
    assert.equal(check.ok, true, check.errors.join(';'));
    assert.equal(check.coverage.total, 2);
    assert.equal(check.coverage.black, 1);
    assert.equal(check.coverage.macro, 1);
    assert.ok(check.warnings.length >= 6, '其余板块缺失应告警');
  });

  it('schema/runId/items 错误拒收', () => {
    assert.match(news.validateNewsSnapshot(null).errors.join('|'), /schema/);
    assert.match(news.validateNewsSnapshot({ schema: 'futures-radar-news-snapshot/1', items: [] }).errors.join('|'), /runId/);
    assert.match(news.validateNewsSnapshot({ schema: 'futures-radar-news-snapshot/1', runId: 'x' }).errors.join('|'), /items/);
  });

  it('type/date/title/summary/verified 结构校验', () => {
    const bad = validDoc();
    bad.items[0].type = 'rumor';
    bad.items[0].date = '2026/09/20';
    bad.items[0].title = 'x';
    bad.items[0].summary = '短';
    bad.items[0].verified = 'yes';
    const errors = news.validateNewsSnapshot(bad).errors.join('|');
    assert.match(errors, /type 必须/);
    assert.match(errors, /date 必须/);
    assert.match(errors, /title/);
    assert.match(errors, /summary/);
    assert.match(errors, /verified/);
  });

  it('sources 缺失/URL/tier/publishedAt 校验', () => {
    const bad = validDoc();
    bad.items[0].sources = [{ url: 'ftp://x', tier: 'D', publishedAt: 'x' }];
    const errors = news.validateNewsSnapshot(bad).errors.join('|');
    assert.match(errors, /url 必须为 http/);
    assert.match(errors, /tier 必须/);
    assert.match(errors, /publishedAt/);
  });

  it('单来源必须显式 singleSource=true；多来源标 true 只告警', () => {
    const single = validDoc();
    single.items[0].sources = single.items[0].sources.slice(0, 1);
    single.items[0].singleSource = false;
    const check = news.validateNewsSnapshot(single);
    assert.equal(check.ok, false);
    assert.match(check.errors.join('|'), /singleSource=true/);

    const multi = validDoc();
    multi.items[0].singleSource = true;
    const check2 = news.validateNewsSnapshot(multi);
    assert.equal(check2.ok, true);
    assert.ok(check2.warnings.some((w) => w.includes('多来源')));
  });

  it('id 重复拒收；超过 20 条拒收；空快照合法但告警', () => {
    const dup = validDoc();
    dup.items[1].id = dup.items[0].id;
    assert.match(news.validateNewsSnapshot(dup).errors.join('|'), /重复/);

    const many = validDoc();
    many.items = Array.from({ length: 21 }, (_, i) => ({ ...many.items[0], id: `news-x-${i}` }));
    assert.match(news.validateNewsSnapshot(many).errors.join('|'), /上限/);

    const empty = validDoc({ items: [] });
    const check = news.validateNewsSnapshot(empty);
    assert.equal(check.ok, true);
    assert.ok(check.warnings.some((w) => w.includes('空快照')));
  });
});

describe('新闻快照文件库读写与索引', () => {
  it('writeNewsSnapshot 写入快照并重建 _index.json', () => {
    const root = tmpRoot();
    const out = news.writeNewsSnapshot(validDoc(), root);
    assert.equal(out.ok, true, out.errors ? out.errors.join(';') : '');
    assert.ok(fs.existsSync(news.newsFile('20260921-1514-auto', root)));
    const index = news.loadNewsIndex(root);
    assert.equal(index.schema, 'futures-radar-news-index/1');
    assert.equal(index.runs.length, 1);
    assert.equal(index.runs[0].itemCount, 2);
    assert.ok(index.bySector.black.length === 1);
    assert.ok(index.bySector.macro.length === 1);
  });

  it('多期快照索引保留全部 run，latestNewsSnapshot 取最新一期', () => {
    const root = tmpRoot();
    news.writeNewsSnapshot(validDoc({ runId: '20260918-1941-auto' }), root);
    news.writeNewsSnapshot(validDoc({ runId: '20260921-1514-auto' }), root);
    const index = news.loadNewsIndex(root);
    assert.equal(index.runs.length, 2);
    const latest = news.latestNewsSnapshot(root);
    assert.equal(latest.runId, '20260921-1514-auto');
  });

  it('updateNewsIndex 对不存在快照报错；非法快照不重建索引', () => {
    const root = tmpRoot();
    const missing = news.updateNewsIndex('no-such-run', root);
    assert.equal(missing.ok, false);
    const out = news.writeNewsSnapshot(validDoc(), root);
    assert.equal(out.ok, true);
  });

  it('digestLines 只投影中性事实字段（title/summary/来源数），不产生新判断', () => {
    const lines = news.digestLines(validDoc());
    assert.equal(lines.length, 2);
    assert.ok('id' in lines[0]);
    assert.ok('date' in lines[0]);
    assert.ok('title' in lines[0]);
    assert.ok('summary' in lines[0]);
    assert.equal(lines[0].sourceCount, 2);
    assert.equal('direction' in lines[0], false);
    assert.equal('bullish' in lines[0], false);
  });
});
