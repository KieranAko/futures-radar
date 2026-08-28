// experiment-line/trust-model.cjs — 报告环节 candidate：三层可信度模型 v1
//
// v6 架构 P9/AD-10：可信度 = 族级证据 × 实例状态匹配 × 实现保真；缺一层必须降档并标注。
// 本实现只读实验线镜像结果与族级证据账本，不进入生产报告。
//
// 用法: node experiment-line/trust-model.cjs --runId <生产runId>
// 输出: experiment-line/results/trust/<runId>.json
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const EL = __dirname;
const familyEvidence = require(path.join(EL, 'evidence', 'family-evidence.json'));
const candidate = require(path.join(EL, 'candidates', 'report-trust-model.json'));

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function familyScore(family) {
  const f = familyEvidence.families[family];
  if (!f) return 0;
  const positive = (f.previews || []).some((p) => p.status === 'preview_not_preregistered' || p.status === 'preview_preregistered');
  if (f.level === 'validated') return 3;
  if (f.level === 'g1' && positive) return 2;
  if (f.level === 'instance_gate_failed') return 1;
  if (f.level === 'g1' && !positive) return 1;
  return 0;
}

function inferFamily(thesisText) {
  const t = String(thesisText || '');
  if (/基差|贴水|升水|展期|期限结构|carry/i.test(t)) return 'carry';
  if (/趋势|动量|突破|均线|momentum|trend/i.test(t)) return 'momentum';
  if (/价差|利润|回归|均值|协整|value/i.test(t)) return 'value';
  if (/事件|政策|冲击|event|shock/i.test(t)) return 'event';
  return 'none';
}

function stateMatchScore(family, registry) {
  const mechs = Object.values(registry || {}).filter((m) => m.family === family);
  if (!mechs.length) return 1; // 无已注册机制的族：unknown
  return 2; // 已注册（含退役）：机制目录可提供 applicableStates 参照
}

function fidelityScore(replay) {
  const plan = (replay && replay.checks || []).find((c) => c.stage === 'strategy-plan');
  if (plan && plan.status === 'pass') return 2; // 镜像逐字节复现策略适配 = 实现保真已知
  return 1;
}

function rate({ fs: family, ms: match, xs: fidelity }) {
  if (family >= 3 && match === 2 && fidelity === 2) return 'A';
  if (family >= 2 && match >= 1 && fidelity >= 1) return 'B';
  if (family >= 1) return 'C';
  return 'D';
}

function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--runId');
  const runId = i >= 0 ? args[i + 1] : null;
  if (!runId) throw new Error('--runId required');

  const reportModel = readJson(path.join(EL, 'runs', runId, 'report-model.json'));
  const replayFile = path.join(EL, 'results', `${runId}-replay.json`);
  const replay = fs.existsSync(replayFile) ? readJson(replayFile) : null;
  if (!replay) throw new Error(`replay baseline missing: ${replayFile} (run mirror.cjs replay first)`);

  let registry = {};
  const regDir = path.join(EL, 'registry');
  if (fs.existsSync(regDir)) {
    for (const f of fs.readdirSync(regDir).filter((x) => x.endsWith('.json'))) {
      registry[f.replace('.json', '')] = readJson(path.join(regDir, f));
    }
  }

  const rows = [];
  for (const opp of reportModel.opportunities || []) {
    const thesisText = [
      opp.thesis?.driver?.primary,
      opp.thesis?.trendOrImpulse?.assessment,
      opp.thesis?.odds?.reasoning,
    ].join(' ');
    const family = inferFamily(thesisText);
    const fsScore = familyScore(family);
    const match = stateMatchScore(family, registry);
    const fidelity = fidelityScore(replay);
    const rating = rate({ fs: fsScore, ms: match, xs: fidelity });
    const familyInfo = familyEvidence.families[family] || { level: 'none', conclusion: '无族级证据' };
    rows.push({
      symbol: opp.symbol,
      family,
      familyInference: 'keyword-rule-v1（待 analyze 机制识别 candidate 替换）',
      familyLevel: familyInfo.level,
      familyConclusion: familyInfo.conclusion,
      scores: { familyEvidence: fsScore, stateMatch: match, fidelity },
      downgradeReasons: [
        fsScore < 3 ? '族级证据未达 validated' : null,
        match < 2 ? '状态匹配数据不可得（unknown）' : null,
        fidelity < 2 ? '实现保真未验证（镜像 replay 无 strategy-plan pass）' : null,
      ].filter(Boolean),
      trust: rating,
      trustMeaning: candidate.verdictRules.synthesis[rating],
    });
  }

  const out = {
    schema: 'futures-radar-experiment-line-trust/1',
    generatedAt: new Date().toISOString(),
    candidateId: candidate.id,
    runId,
    synthesisRule: candidate.verdictRules.synthesis,
    disclaimer: candidate.disclaimer,
    rows,
  };
  const outDir = path.join(EL, 'results', 'trust');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `${runId}.json`), JSON.stringify(out, null, 2) + '\n');
  console.log(`trust rows: ${rows.length}`);
  for (const r of rows) console.log(`  ${r.symbol}: family=${r.family}(${r.familyLevel}) trust=${r.trust} reasons=[${r.downgradeReasons.join('; ')}]`);
  return out;
}

if (require.main === module) main();
module.exports = { main, inferFamily, familyScore, rate };
