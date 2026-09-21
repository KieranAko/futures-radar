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
  L.push('4. 价格能对应到冻结数据源的，填进 source；不能对应的不要猜。');
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
    runId,
    tickets: [{
      symbol: 'RB0',
      direction: 'bearish',
      contract: 'RB2701',
      activation: '反抽至 3119 下方不破',
      activationLevel: 3119,
      activationSource: 'near_term.pdl',
      activationQuote: '交易单原句',
      confirmation: 'T+1 收盘仍在 3119 下方',
      entry: 'T+2 开盘入场',
      abandon: '偏离超过 0.5 ATR 放弃',
      stop: { level: 3132, basis: '收盘站回价值区上沿' },
      targets: { t1: '3065', t2: '3034', basis: '…' },
      maxHold: 'T+4 交易日收盘前未到目标则离场（入场后最多持有 3 个交易日）',
      invalidation: ['收盘站上 3132'],
      unresolved: [],
      note: '交易单原文'
    }]
  }, null, 2));
  L.push('```');
  L.push('');
  L.push('direction 只允许 bullish/bearish/neutral；activationLevel、stop.level 必须是数字；targets.t1 至少一个目标。');

  const outDir = path.join(dir, 'strategies', 'prompts');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'ticket-recorder-prompt.md');
  fs.writeFileSync(outFile, L.join('\n'), 'utf8');
  console.log(`ticket-recorder prompt: ${outFile}`);
  return L.join('\n');
}

if (require.main === module) main();
module.exports = { main };
