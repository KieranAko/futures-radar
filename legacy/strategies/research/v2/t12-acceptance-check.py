# -*- coding: utf-8 -*-
# t12 acceptance verification script (independent re-computation, not trusting embedded claims)
import json, re, sys

lib = json.load(open('strategies/strategy-library-v2.json', encoding='utf-8'))
contracts = json.load(open('strategies/research/v2/04-data-contracts.json', encoding='utf-8'))
results = []

def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))

strategies = lib['strategies']
byid = {s['id']: s for s in strategies}
ids = [s['id'] for s in strategies]

# A1: core set exactly 8
check('A1-core-8',
      ids == lib['manifest']['coreStrategyIds'] == ['TR-01','TR-03','TR-06','FS-02','FS-04','FS-05','M1','EC-01'],
      str(ids))

# A2: five segments + pricing model complete, pricingSource=self-model
seg_required = ['theory','marketModel','strategy','dataContract','falsificationTests','pricingModel']
a2_ok, a2_detail = True, []
for s in strategies:
    missing = [k for k in seg_required if k not in s or not s[k]]
    if missing:
        a2_ok, _ = False, a2_detail.append("%s missing %s" % (s['id'], missing))
    if s.get('pricingSource') != 'self-model':
        a2_ok, _ = False, a2_detail.append("%s pricingSource=%s" % (s['id'], s.get('pricingSource')))
    pm = s.get('pricingModel', {})
    for f in ['stop','target','position']:
        if 'modelRef' not in pm.get(f, {}):
            a2_ok, _ = False, a2_detail.append("%s.%s no modelRef" % (s['id'], f))
    mm = s.get('marketModel', {})
    for f in ['stateVariables','formulas','conditionalDistribution','confirmationZone','invalidationEvent','edgeDecay']:
        if not mm.get(f):
            a2_ok, _ = False, a2_detail.append("%s.marketModel.%s empty" % (s['id'], f))
check('A2-five-segments-binding', a2_ok, '; '.join(a2_detail) or '8/8 complete')

# A3: no cross-strategy model mixing
a3_ok, a3_detail = True, []
for s in strategies:
    if s.get('crossModelRefs'):
        a3_ok, _ = False, a3_detail.append("%s crossModelRefs=%s" % (s['id'], s.get('crossModelRefs')))
    own = set()
    for ftext in s.get('marketModel', {}).get('formulas', []):
        own |= set(re.findall(r'F(\d+)', str(ftext)))
    refs = set(re.findall(r'F(\d+)', json.dumps(s.get('pricingModel', {}), ensure_ascii=False)))
    if refs - own:
        a3_ok, _ = False, a3_detail.append("%s modelRef F%s not in own formulas %s" % (s['id'], sorted(refs-own), sorted(own)))
check('A3-no-cross-model-refs', a3_ok, '; '.join(a3_detail) or '8/8 clean')

# A4: FinCoT analysis-only
a4_ok, a4_detail = True, []
for s in strategies:
    af = s.get('analysisFilter', {})
    if af.get('noNumericPricing') is not True:
        a4_ok, _ = False, a4_detail.append("%s noNumericPricing=%s" % (s['id'], af.get('noNumericPricing')))
    if 'finCoTUsage' not in af:
        a4_ok, _ = False, a4_detail.append("%s missing finCoTUsage" % s['id'])
check('A4-fincot-analysis-only', a4_ok, '; '.join(a4_detail) or '8/8 noNumericPricing=true')

# A4b: cone only in target for TR-01/03/06, never in stop/position, with provenance
a4b_ok, a4b_detail = True, []
for sid in ['TR-01','TR-03','TR-06']:
    s = byid[sid]
    if s['analysisFilter'].get('probabilityConeUsage') != 'target-only':
        a4b_ok, _ = False, a4b_detail.append("%s coneUsage=%s" % (sid, s['analysisFilter'].get('probabilityConeUsage')))
    if '[cap-6' not in str(s['pricingModel']['target'].get('rule','')):
        a4b_ok, _ = False, a4b_detail.append("%s target missing cap-6 marker" % sid)
    if 'provenance=probability.json' not in str(s['pricingModel']['target'].get('rule','')):
        a4b_ok, _ = False, a4b_detail.append("%s target missing provenance" % sid)
    for f in ['stop','position']:
        rule = str(s['pricingModel'][f].get('rule',''))
        if 'p95' in rule or 'p68' in rule:
            a4b_ok, _ = False, a4b_detail.append("%s cone leaked into %s" % (sid, f))
for sid in ['FS-02','FS-04','FS-05','M1','EC-01']:
    if byid[sid]['analysisFilter'].get('probabilityConeUsage') != 'none':
        a4b_ok, _ = False, a4b_detail.append("%s coneUsage=%s" % (sid, byid[sid]['analysisFilter'].get('probabilityConeUsage')))
check('A4b-cone-target-only', a4b_ok, '; '.join(a4b_detail) or 'TR-01/03/06 target-only with provenance; others none')

# A5: falsification tests complete and numeric
a5_ok, a5_detail = True, []
for s in strategies:
    ft = s.get('falsificationTests', {})
    sl = ft.get('strategyLevel', {})
    if not isinstance(sl.get('minTrades'), int) or sl['minTrades'] < 100:
        a5_ok, _ = False, a5_detail.append("%s minTrades=%s" % (s['id'], sl.get('minTrades')))
    if sl.get('pfThreshold') != 1.2:
        a5_ok, _ = False, a5_detail.append("%s pfThreshold=%s" % (s['id'], sl.get('pfThreshold')))
    if len(sl.get('baselines', [])) != 3:
        a5_ok, _ = False, a5_detail.append("%s baselines=%s" % (s['id'], sl.get('baselines')))
    if not ft.get('theoryLevel', {}).get('test'):
        a5_ok, _ = False, a5_detail.append("%s theoryLevel.test empty" % s['id'])
    if not ft.get('killRules'):
        a5_ok, _ = False, a5_detail.append("%s killRules empty" % s['id'])
check('A5-falsification-complete', a5_ok, '; '.join(a5_detail) or '8/8 numeric + theory-level + killRules')

# A6: contracts available
a6_ok, a6_detail = True, []
for s in strategies:
    ref = s['dataContract'].get('ref')
    st = contracts['strategies'].get(ref, {}).get('status')
    if st != 'available':
        a6_ok, _ = False, a6_detail.append("%s->%s status=%s" % (s['id'], ref, st))
check('A6-contracts-available', a6_ok, '; '.join(a6_detail) or '8/8 available')

# A7: parameters sourced + freezeCondition
a7_ok, a7_detail, nparam = True, [], 0
for s in strategies:
    for p in s.get('parameters', []):
        nparam += 1
        if p.get('source') not in {'literature','industry-practice','repo-convention','calibration'}:
            a7_ok, _ = False, a7_detail.append("%s.%s source=%s" % (s['id'], p['name'], p.get('source')))
        if not p.get('freezeCondition'):
            a7_ok, _ = False, a7_detail.append("%s.%s no freezeCondition" % (s['id'], p['name']))
check('A7-params-sourced(%d)' % nparam, a7_ok, '; '.join(a7_detail) or 'all %d params sourced' % nparam)

# A8: H7 OI ban
a8_ok, a8_detail = True, []
for s in strategies:
    for f in ['stop','target','position']:
        rule = str(s.get('pricingModel', {}).get(f, {}).get('rule',''))
        for m in re.finditer(r'OIΔ|openInterest', rule):
            ctx = rule[max(0,m.start()-25):m.end()+25]
            if '[H7]' not in ctx:
                a8_ok, _ = False, a8_detail.append("%s.%s ctx=%s" % (s['id'], f, ctx))
    if s['id'] not in ('TR-03','TR-06') and 'OIΔ' in json.dumps(s, ensure_ascii=False):
        # non-H7 entries should not mention OIΔ anywhere in pricing/market fields
        for f in ['stop','target','position']:
            if 'OIΔ' in str(s.get('pricingModel', {}).get(f, {}).get('rule','')):
                a8_ok, _ = False, a8_detail.append("%s.%s contains OIΔ" % (s['id'], f))
check('A8-H7-OI-ban', a8_ok, '; '.join(a8_detail) or 'OIΔ only in [H7]-annotated disable contexts')

# A9: prerequisites & asOfContract well-formed
ga_ids = [g['id'] for g in contracts['globalActions']]
f_ids = set('F%d' % i for i in range(1, 10))
a9_ok, a9_detail = True, []
for s in strategies:
    pr = s.get('prerequisites', [])
    if not pr:
        a9_ok, _ = False, a9_detail.append("%s prerequisites empty" % s['id'])
    if any(p not in ga_ids for p in pr):
        a9_ok, _ = False, a9_detail.append("%s bad prereq %s" % (s['id'], pr))
    ao = s.get('asOfContract', [])
    if not ao or any(x not in f_ids for x in ao):
        a9_ok, _ = False, a9_detail.append("%s bad asOf %s" % (s['id'], ao))
check('A9-prerequisites-asOf', a9_ok, '; '.join(a9_detail) or '8/8 well-formed (prereq %s)' % {s['id']: s['prerequisites'] for s in strategies})

# A10: embedded machineChecks all pass and cover MC-1..MC-10
a10_ok = all(v.get('status') == 'pass' for k, v in lib['machineChecks'].items())
a10_ok = a10_ok and set(lib['machineChecks'].keys()) == set('MC-%d' % i for i in range(1, 11))
check('A10-embedded-MC-1..10-pass', a10_ok, 'keys: ' + ','.join(lib['machineChecks'].keys()))

# A11: manifest complete (capRulings, hardConstraints, decisions)
a11_ok = all(k in lib['manifest']['capRulings'] for k in ['cap-1','cap-2','cap-3','cap-4','cap-5','cap-6'])
a11_ok = a11_ok and all(k in lib['manifest']['hardConstraints'] for k in ['H1','H2','H3','H4','H5','H6','H7'])
a11_ok = a11_ok and all(k in lib['manifest']['decisions'] for k in ['D%d' % i for i in range(1, 12)])
check('A11-manifest-complete', a11_ok,
      'capRulings=%s hardConstraints=%s decisions=%s' % (sorted(lib['manifest']['capRulings'].keys()),
                                                         sorted(lib['manifest']['hardConstraints'].keys()),
                                                         sorted(lib['manifest']['decisions'].keys())))

# A12: revisionLog 22 items
check('A12-revisionLog-22', len(lib['revisionLog']['items']) == 22, 'count=%d' % len(lib['revisionLog']['items']))

# A13: no fabricated achieved-performance claims.
# Falsification kill-thresholds ("夏普 < 0.5 → 停用", "命中率 < 55%", "PF ≥ 1.2") are legitimate gate texts,
# so the regex only matches achieved-value assertions: performance metric + (=/≈/≥ or bare) + numeric value.
scan = json.dumps(lib, ensure_ascii=False)
claims = re.findall(r'(?:夏普|Sharpe)\s*(?:[=≈≥]\s*)?[+\-]?\d+(?:\.\d+)?', scan)
claims += re.findall(r'(?:年化收益|累计收益|回测收益|实盘收益|样本外收益|实测收益)\s*[：:≈=]?\s*[+\-]?\d+(?:\.\d+)?%?', scan)
claims += re.findall(r'(?:胜率|命中率|正确率)\s*[=≈]\s*\d+(?:\.\d+)?%', scan)
claims += re.findall(r'(?:实盘|实测|样本外)\s*(?:夏普|收益|胜率|命中率|PF)\s*[=≈]\s*[+\-]?\d', scan)
check('A13-no-fabricated-returns', len(claims) == 0,
      str(claims[:5]) if claims else 'clean（正则已排除证伪阈值，如"夏普 < 0.5 → 停用"）')

# A14: FS-P1-02 rejected in waitlist
wl = lib['waitlist']['entries']
a14_ok = len(wl) == 1 and wl[0]['id'] == 'FS-P1-02' and wl[0]['executable'] is False and wl[0]['status'] == 'rejected_by_policy'
check('A14-FS-P1-02-rejected', a14_ok, 'status=%s executable=%s' % (wl[0].get('status'), wl[0].get('executable')))

# A15: H1/GC-1 cap-6 wording present
a15_ok = 'provenance' in lib['manifest']['hardConstraints']['H1'] and 'cap-6' in lib['manifest']['hardConstraints']['H1']
a15_ok = a15_ok and 'provenance' in lib['globalConstraints']['GC-1']['constraint']
check('A15-H1-cap6-wording', a15_ok, 'H1+GC-1 revised per cap-6')

# A16: TR-03 prerequisites include GA-2 (cap-6 cone pipeline)
check('A16-TR-03-prereq-GA-2', 'GA-2' in byid['TR-03']['prerequisites'], str(byid['TR-03']['prerequisites']))

# A17: GA-7 exists in contracts and is referenced where required
a17_ok = 'GA-7' in ga_ids
a17_ok = a17_ok and all('GA-7' in byid[sid]['prerequisites'] for sid in ['FS-04','FS-05','EC-01'])
a17_ok = a17_ok and 'activationGate' in byid['EC-01']['dataContract']
check('A17-GA-7-gate', a17_ok, 'GA-7 in contracts + FS-04/05/EC-01 prereq + EC-01 activationGate')

print('=' * 70)
for name, ok, detail in results:
    print('[%s] %s: %s' % ('PASS' if ok else 'FAIL', name, detail))
print('=' * 70)
fails = [n for n, o, _ in results if not o]
print('TOTAL %d checks, %d FAIL: %s' % (len(results), len(fails), fails))
sys.exit(1 if fails else 0)
