// ga7-f9-check.cjs — GA-7 政策日历 v0 的 F9 discipline 校验（falsification 数据前置）
//
// 校验对象：data/ga7-policy-calendar-v0.json（由 ga7-calendar-sync.py 从 YAML 同步生成）。
// F9 断言：
//   1) YAML↔JSON 同源（sha256 锁定，JSON 不得脱离人工 YAML 源漂移）；
//   2) 每条事件 event.date <= 锚点日才可用（多锚点正反两向用例：包含/排除）；
//   3) 每条事件带 source（反"价格反推事件"：无来源条目直接拒绝）；
//   4) 结构完整性：date/end 格式、scope 非空、verified 布尔、sector/type 枚举、
//      日历维护日之后无未来日期事件、必要窗口覆盖（FS-04(d)/FS-05(c)/EC-01(c)）。
//
// 用法: node strategies/research/v2/falsification/ga7-f9-check.cjs
// 退出码: 0 = 全部断言通过；1 = 有断言失败（打印 FAIL 明细）

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FALS = __dirname;
const YAML_PATH = path.join(FALS, 'ga7-policy-calendar-v0.yaml');
const JSON_PATH = path.join(FALS, 'data', 'ga7-policy-calendar-v0.json');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SECTORS = ['black', 'agriculture', 'energy_chemical'];
const ALLOWED_TYPES = ['policy_window', 'structural_event', 'reserve_window'];

let failures = [];
let checks = [];

function check(name, ok, detail) {
  checks.push({ check: name, passed: !!ok, detail: String(detail) });
  if (!ok) failures.push(`${name}: ${detail}`);
}

function isValidDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function usableEvents(events, anchorDate) {
  return events.filter((e) => e.date <= anchorDate);
}

function main() {
  if (!fs.existsSync(YAML_PATH)) { console.error('FAIL: yaml not found'); process.exit(1); }
  if (!fs.existsSync(JSON_PATH)) {
    console.error('FAIL: json not found — run `python strategies/research/v2/falsification/ga7-calendar-sync.py` first');
    process.exit(1);
  }
  const yamlRaw = fs.readFileSync(YAML_PATH);
  const doc = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));

  // 1) YAML↔JSON 同源
  const sha = crypto.createHash('sha256').update(yamlRaw).digest('hex');
  check('yamlSha256 matches yaml source', doc.yamlSha256 === sha,
    `expected ${sha.slice(0, 16)}... got ${(doc.yamlSha256 || 'none').slice(0, 16)}...`);

  // 2) 结构完整性
  check('schema', doc.schema === 'futures-radar-ga7-policy-calendar/1', doc.schema);
  const events = doc.events || [];
  check('events >= 9', events.length >= 9, `events=${events.length}`);

  const ids = new Set();
  for (const e of events) {
    const tag = `event ${e.id}`;
    check(`${tag} date valid`, isValidDate(e.date), e.date);
    check(`${tag} end valid when present`, !e.end || isValidDate(e.end), e.end);
    check(`${tag} end >= date`, !e.end || e.end >= e.date, `${e.date}..${e.end}`);
    check(`${tag} type allowed`, ALLOWED_TYPES.includes(e.type), e.type);
    check(`${tag} sector allowed`, SECTORS.includes(e.sector), e.sector);
    check(`${tag} scope non-empty`, Array.isArray(e.scope) && e.scope.length > 0, JSON.stringify(e.scope));
    check(`${tag} source http(s)`, typeof e.source === 'string' && /^https?:\/\//.test(e.source), e.source);
    check(`${tag} verified boolean`, typeof e.verified === 'boolean', String(e.verified));
    check(`${tag} id unique`, !ids.has(e.id), e.id);
    ids.add(e.id);
    // F9 反价格推演：事件必须留档来源（source 非空已断言）；verified=true 必须可溯源 URL
    if (e.verified === true) {
      check(`${tag} verified requires source URL`, /^https?:\/\//.test(e.source), e.source);
    }
  }

  // 3) 无未来日期（日历维护日之后）
  const maintained = doc.maintainedAt;
  const future = events.filter((e) => e.date > maintained).map((e) => e.id);
  check('no event dated after maintainedAt', future.length === 0, future.join(','));

  // 4) 每类 ≥2 个事件
  for (const sec of SECTORS) {
    const n = events.filter((e) => e.sector === sec).length;
    check(`sector ${sec} >= 2 events`, n >= 2, `n=${n}`);
  }

  // 5) 必要窗口覆盖（FS-04(d)/FS-05(c)/EC-01(c) 证伪测试开窗）
  function coversYear(sec, year) {
    return events.some((e) => e.sector === sec && e.date.slice(0, 4) <= String(year)
      && (e.end || e.date).slice(0, 4) >= String(year));
  }
  const required = [
    ['black', 2016, 'FS-04(d) 2016-17 供给侧'], ['black', 2017, 'FS-04(d) 2016-17 供给侧'],
    ['black', 2021, 'FS-04(d) 2021 粗钢压减'], ['black', 2025, 'FS-04(d) 2025 粗钢产量调控'],
    ['agriculture', 2019, 'FS-05(c) 2019 菜籽进口政策'], ['agriculture', 2024, 'FS-05(c) 反倾销（2024-09 立案）'],
    ['energy_chemical', 2020, 'EC-01(c) 2020 负油价'], ['energy_chemical', 2022, 'EC-01(c) 2022 俄乌'],
  ];
  for (const [sec, year, label] of required) {
    check(`window coverage ${sec} ${year}`, coversYear(sec, year), label);
  }

  // 6) F9 使用门禁正反用例：event.date <= 锚点日 才可用
  const cases = [
    {
      anchor: '2016-06-30',
      mustInclude: ['ga7-bk-2016'],
      mustExclude: ['ga7-en-2020oil', 'ga7-en-2022ru', 'ga7-ag-2024ad', 'ga7-bk-2025'],
    },
    {
      anchor: '2019-06-30',
      mustInclude: ['ga7-bk-2016', 'ga7-ag-2019'],
      mustExclude: ['ga7-en-2020oil', 'ga7-ag-2024ad'],
    },
    {
      anchor: '2020-05-01',
      mustInclude: ['ga7-en-2020opec', 'ga7-en-2020oil'],
      mustExclude: ['ga7-en-2022ru', 'ga7-ag-2024ad'],
    },
    {
      anchor: '2022-06-30',
      mustInclude: ['ga7-en-2022ru', 'ga7-bk-2021'],
      mustExclude: ['ga7-bk-2025', 'ga7-ag-2024ad'],
    },
    {
      anchor: '2026-08-14',
      mustInclude: ['ga7-bk-2025', 'ga7-ag-2024ad'],
      mustExclude: [],
    },
  ];
  for (const c of cases) {
    const usable = usableEvents(events, c.anchor).map((e) => e.id);
    for (const id of c.mustInclude) {
      check(`F9 @${c.anchor}: ${id} usable`, usable.includes(id), `usable=[${usable.slice(0, 6).join(',')}...]`);
    }
    for (const id of c.mustExclude) {
      check(`F9 @${c.anchor}: ${id} NOT usable`, !usable.includes(id), `usable=[${usable.slice(0, 6).join(',')}...]`);
    }
  }

  // 7) schedules 结构
  const scheds = doc.schedules || [];
  check('schedules >= 8 (月度发布日最小集)', scheds.length >= 8, `n=${scheds.length}`);
  for (const s of scheds) {
    const tag = `schedule ${s.type}`;
    check(`${tag} title`, typeof s.title === 'string' && s.title.length > 0, s.title);
    check(`${tag} rule`, typeof s.rule === 'string' && s.rule.length > 0, s.rule);
    check(`${tag} scope non-empty`, Array.isArray(s.scope) && s.scope.length > 0, JSON.stringify(s.scope));
    check(`${tag} source http(s)`, typeof s.source === 'string' && /^https?:\/\//.test(s.source), s.source);
  }

  console.log(JSON.stringify({ checks, failures }, null, 2));
  if (failures.length) {
    console.error(`F9 CHECK FAILED: ${failures.length} assertion(s)`);
    process.exit(1);
  }
  console.log('F9 CHECK PASSED');
  process.exit(0);
}

main();
