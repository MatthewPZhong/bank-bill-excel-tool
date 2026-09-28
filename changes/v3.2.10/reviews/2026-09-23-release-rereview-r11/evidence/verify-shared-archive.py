#!/usr/bin/env python3
import hashlib
import json
from pathlib import Path

REPO = Path('/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10')
REPAIR = REPO / 'changes/v3.2.10/reviews/2026-09-23-release-r10-repair'
FROZEN = REPO / 'changes/v3.2.10/reviews/2026-09-23-release-rereview-r11/evidence/input-manifest.json'
read = lambda p: json.loads(p.read_text())
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
before = read(REPAIR / 'input-manifest.json')['sha256']
current = read(FROZEN)['sha256']
GROUPS = {'shared-probes':20, 'destructure-probes':8, 'localenv-probes':10, 'default-combinations':6, 'async-array-combinations':6, 'logical-combinations':6}
TOOLS = {'scan', 'contracts', 'rules', 'renderer-contracts', 'schema'}
POLICY = {'architecture/boundaries.json', 'architecture/legacy-allowlist.json', 'scripts/architecture/schema.js', 'scripts/architecture/policy-history.js'}
summary = {'status':'PASS', 'beforeManifest':str(REPAIR / 'input-manifest.json'), 'currentManifest':str(FROZEN), 'groups':{}, 'renderer':0, 'query':0, 'executedSqlFixtures':0, 'sharedDiagnosticChanges':[], 'knownConservativeLimitations':[]}
all_cases = {}

def check_hashes(data):
    assert {Path(i['path']).stem for i in data['beforeInputHashes']} == TOOLS
    assert {Path(i['path']).stem for i in data['currentInputHashes']} == TOOLS
    for item in data['beforeInputHashes']:
        p = item['path']
        src = REPAIR / 'before' / p if Path(p).stem == 'renderer-contracts' else REPO / p
        assert item['match'] and item['sha256'] == before[p] == sha(src), p
    for item in data['currentInputHashes']:
        p = item['path']
        assert item['sha256'] == current[p] == sha(REPO / p), p

def check_scanner(case):
    s = case['scanner']
    assert s['beforeCurrentEqual'], case['name']
    assert s['beforeR10']['digest'] == s['current']['digest'], case['name']
    assert s['beforeR10']['siteEvidenceIds'] == s['current']['siteEvidenceIds'], case['name']
    for version in ['beforeR10', 'current']:
        assert s[version]['repeatEqual'] and s[version]['afterRulesEqual'], (case['name'], version)

for name,count in GROUPS.items():
    p = Path(__file__).resolve().parent / ('r11-shared-' + name + '.json')
    data = read(p)
    previous = read(REPAIR / ('r10-shared-' + name + '.json'))
    check_hashes(data)
    assert {i['path'] for i in data['policy']} == POLICY
    for i in data['policy']:
        assert i['same'] and i['before'] == i['current'] == before[i['path']] == current[i['path']] == sha(REPO/i['path'])
    assert len(data['renderer']) + len(data['query']) == count
    for group in ['renderer','query']:
        assert len(data[group]) == len(previous[group])
        summary[group] += len(data[group])
        for case, old_case in zip(data[group], previous[group]):
            assert case['name'] not in all_cases
            all_cases[case['name']] = case
            assert case['name'] == old_case['name'] and case['source'] == old_case['source']
            assert case['expectedClean'] == old_case['expectedClean']
            assert (not case['current']) == case['expectedClean']
            assert (not case['beforeR10']) == case['expectedClean']
            check_scanner(case)
            if case['beforeR10'] != case['current']:
                summary['sharedDiagnosticChanges'].append(case['name'])
            if case.get('knownConservative'):
                summary['knownConservativeLimitations'].append({'name':case['name'],'note':case['knownConservative']})
            if group == 'query':
                assert case['sql'] == old_case['sql'] and case['actual'] == old_case['actual']
                assert bool(case['sql']) != case['expectedClean']
                summary['executedSqlFixtures'] += bool(case['sql'])
    summary['groups'][name] = {'count':count,'outputSha256':sha(p),'scriptSha256':sha(p.with_suffix('.cjs'))}
assert (summary['renderer'],summary['query'],summary['executedSqlFixtures']) == (38,18,10)
assert summary['sharedDiagnosticChanges'] == []

# Preserve real Promise behavior; the historical synchronous stub's clean expectation is wrong.
case = all_cases['single-mount-category-explicit-ipc']
assert case['historicalExpectedClean'] is True and case['expectedClean'] is False
assert case['runtime']['calledIpc'] == ['app:get-info','other']
assert case['runtime']['categoryWasThenable'] is True
assert case['runtime']['category']['channel'] == 'other'
assert len(case['beforeR10']) == len(case['current']) == 1
summary['asyncIpcCorrectionPreserved'] = True

# This is an existing conservative false positive, not legal acceptance or a new finding.
case = all_cases['conditional-distinct-pure-values']
assert [v['value'] for v in case['runtime']] == ['gateway','business']
assert len(case['beforeR10']) == len(case['current']) == 1
assert len(summary['knownConservativeLimitations']) == 1
for key in ['ipc-and-pure-data','ipc-and-whole-api','category-falsy-and-api','category-truthy-and-data','conditional-distinct-pure-values','conditional-pure-or-api']:
    assert [x['flag'] for x in all_cases[key]['runtime']] == [False,True]
assert [x['value'] for x in all_cases['ipc-and-pure-data']['runtime']] == [False,['bank',1]]
assert [x['isWholeApi'] for x in all_cases['ipc-and-whole-api']['runtime']] == [False,True]
assert [x['value'] for x in all_cases['category-falsy-and-api']['runtime']] == [0,0]
assert [x['value'] for x in all_cases['category-truthy-and-data']['runtime']] == ['business','business']
assert [x['isWholeApi'] for x in all_cases['conditional-pure-or-api']['runtime']] == [True,False]
summary['sharedTotalFixtures'] = 56

bindings = read((Path(__file__).resolve().parent / 'r11-bindings-probes.json'))
check_hashes(bindings)
old_bindings = read(REPAIR/'r10-adjacent-review/results.json')['results']
assert bindings['total'] == len(bindings['rows']) == len(old_bindings) == 6
binding_summary = []
for case, historic in zip(bindings['rows'], old_bindings):
    assert case['name'] == historic['name'] and case['source'] == historic['source']
    assert case['unsafe'] == historic['unsafe']
    assert case['runtime']['sameCurrent'] == case['unsafe']
    assert case['runtime']['sameOld'] != case['unsafe']
    assert case['runtime']['outsideScope'] == case['unsafe']
    assert case['runtime']['outsideScopeResult'] == (True if case['unsafe'] else None)
    assert len(case['beforeR10']) == 0
    assert len(case['current']) == int(case['unsafe'])
    if case['unsafe']:
        assert case['current'][0]['rule'] == 'ARCH-RENDERER-SCOPE'
        assert case['runtime']['injectedKeys'] == ['run','outsideScope']
    else:
        assert case['runtime']['injectedKeys'] == ['run']
    check_scanner(case)
    binding_summary.append({'name':case['name'],'unsafe':case['unsafe'],'beforeDiagnostics':len(case['beforeR10']),'currentDiagnostics':len(case['current']),'vmAgrees':True})
summary['bindings'] = {'totalFixtures':6, 'cases':binding_summary, 'scriptSha256':sha((Path(__file__).resolve().parent / 'r11-bindings-probes.cjs')), 'outputSha256':sha((Path(__file__).resolve().parent / 'r11-bindings-probes.json'))}
summary['totalFixtures'] = 62
summary['scannerStableFixtures'] = 62
summary['currentRendererSha256'] = current['scripts/architecture/renderer-contracts.js']
summary['newFindings'] = []
summary['scope'] = '56 shared cases and 6 exact R10 adjacent parameter-binding/capture cases; no full repository scan or architecture suite.'
(Path(__file__).resolve().parent / 'shared-archive-verification.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(summary,ensure_ascii=False,indent=2))
