import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseMysteelPrice } = require('../collector/spot-basis-collector.cjs');

describe('spot-basis collector', () => {
  it('从 Mysteel HTML 解析重质纯碱折盘面价 983', () => {
    const html = '<html><body>品名 市场 规格 价格 涨跌 交易方式 备注 纯碱 沙河及周边 重质纯碱 983 -13 自提</body></html>';
    assert.equal(parseMysteelPrice(html, '重质纯碱'), 983);
  });

  it('无匹配时回退解析首个三位数价格', () => {
    const html = '<html><body>某规格 976 -10 自提</body></html>';
    assert.equal(parseMysteelPrice(html, '重质纯碱'), 976);
  });
});
