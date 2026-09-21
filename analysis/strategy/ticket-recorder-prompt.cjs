// analysis/strategy/ticket-recorder-prompt.cjs — 交易单录入员角色提示词生成器
//
// 交易员写出自然语言交易单后，录入员把交易单原样拆成“要素”，
// 供构造器绑定与验证。录入员不补、不改、不解释、不分类确认方式。

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { runDir } = require('../../shared/workspace.cjs');
const { ELEMENTS_SCHEMA } = require('./ticket-elements.cjs');

function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--runId');
  const runId = i >= 0 ? args[i + 1] : null;
  if (!runId) throw new Error('--runId required');

  const dir = runDir(runId);
  const ticketFile = path.join(dir, 'strategies', 'strategy-ticket.md');
  const ticketText = fs.existsSync(ticketFile) ? fs.readFileSync(ticketFile, 'utf8') : '';

  const L = [];
  L.push(`# 交易单录入员角色提示词（runId=${runId}）`);
  L.push('');
  L.push('## 身份');
  L.push('');
  L.push('你是交易部的交易单录入员。交易员刚写完一批自然语言交易单，你的工作是**原样拆要素**。');
  L.push('你不是交易员，也不是分析员：不修改判断、不补充交易员没写的内容、不解释交易逻辑。');
  L.push('');
  L.push('## 拆解原则');
  L.push('');
  L.push('1. 每个要素必须能在交易单原文里找到对应句子；');
  L.push('2. 拆不出来的要素留空，并把问题写进 unresolved；');
  L.push('3. 确认方式按交易员原话保留，不要给确认方式分类或改写成别的说法；');
  L.push('4. 价格能对应到冻结数据源的，填进 source；不能对应的不要猜；');
  L.push('5. 拆出的每个数字（activationLevel、stop.level、abandon 点数、entryZone 的 lower/upper、maxHold 的 T+N）必须能在交易单原文里找到，找不到就留空并写进 unresolved。');
  L.push('');
  L.push('## 交易单原文');
  L.push('');
  if (ticketText.trim()) {
    L.push(ticketText.trim());
  } else {
    L.push('（strategies/strategy-ticket.md 不存在，请先让交易员产出交易单）');
  }
  L.push('');
  L.push('## 输出');
  L.push('');
  L.push(`把要素写进 ${path.join('strategies', 'strategy-elements.json')}，schema 固定为 ${ELEMENTS_SCHEMA}。`);
  L.push('');
  L.push('```json');
  L.push(JSON.stringify({
    schema: ELEMENTS_SCHEMA,
    runId: '<runId>',
    tickets: [{
      symbol: '<symbol>',
      direction: '<bullish|bearish|neutral>',
      contract: '<contract>',
      activation: '<原文：什么价位成立>',
      activationLevel: '<数字>',
      activationSource: '<冻结数据来源>',
      activationQuote: '交易单原句',
      confirmation: '<原文：确认方式>',
      entry: '<原文：入场方式>',
      abandon: '<原文：放弃条款，含点数>',
      entryZone: { lower: '<数字>', upper: '<数字>', lowerBasis: '<原文：下边依据>', upperBasis: '<原文：上边依据>' },
      stop: { level: '<数字>', basis: '<原文：止损依据>' },
      targets: { t1: '<原文>', t2: '<原文>', basis: '<原文>' },
      maxHold: '<原文：最长持有>',
      invalidation: ['<原文：作废条件>'],
      unresolved: [],
      note: '<交易单原文全文>'
    }]
  }, null, 2));
  L.push('```');
  L.push('');
  L.push('上面的尖括号内容全部是占位符，禁止照抄；最终文件里 activationLevel、stop.level 必须是数字，note 必须是交易单原文全文。');
  L.push('');
  L.push('direction 只允许 bullish/bearish/neutral；activationLevel、stop.level、entryZone.lower、entryZone.upper 必须是数字；targets.t1 至少一个目标。');

  const outDir = path.join(dir, 'strategies', 'prompts');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'ticket-recorder-prompt.md');
  fs.writeFileSync(outFile, L.join('\n'), 'utf8');
  console.log(`ticket-recorder prompt: ${outFile}`);
  return L.join('\n');
}

if (require.main === module) main();
module.exports = { main };
