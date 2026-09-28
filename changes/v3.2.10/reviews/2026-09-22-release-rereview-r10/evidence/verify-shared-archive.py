#!/usr/bin/env python3
import hashlib
import json
from pathlib import Path

REPO = Path('/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10')
ARCHIVE = REPO / 'changes/v3.2.10/reviews/2026-09-22-release-r9-repair'
EXPECTED = json.loads((ARCHIVE / 'input-manifest.json').read_text())['sha256']
GROUPS = {'shared-probes': 20, 'destructure-probes': 8, 'localenv-probes': 10, 'default-combinations': 6, 'async-array-combinations': 6, 'logical-combinations': 6}
TOOLS = {'scan', 'contracts', 'rules', 'renderer-contracts', 'schema'}
POLICY = {'architecture/boundaries.json', 'architecture/legacy-allowlist.json', 'scripts/architecture/schema.js', 'scripts/architecture/policy-history.js'}
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
summary = {'status': 'PASS', 'before': str(ARCHIVE / 'input-manifest.json'), 'groups': {}, 'renderer': 0, 'query': 0, 'executedSqlFixtures': 0, 'changes': [], 'knownConservativeLimitations': []}
all_cases = {}
for name, count in GROUPS.items():
    p = Path(__file__).resolve().parent / ('r10-shared-' + name + '.json')
    data = json.loads(p.read_text())
    cases = data['renderer'] + data['query']
    assert len(cases) == count, name
    assert {Path(x['path']).stem for x in data['beforeInputHashes']} == TOOLS
    for item in data['beforeInputHashes']:
        relative = item['path']
        src = ARCHIVE / 'before' / relative if Path(relative).stem == 'renderer-contracts' else REPO / relative
        assert item['match'] and item['sha256'] == EXPECTED[relative] == sha(src), (name, relative)
    assert {x['path'] for x in data['policy']} == POLICY
    for item in data['policy']:
        assert item['same'] and item['before'] == item['current'] == EXPECTED[item['path']] == sha(REPO / item['path']), (name, item)
    for case in cases:
        key = case['name']
        assert key not in all_cases, key
        all_cases[key] = case
        assert (len(case['current']) == 0) == case['expectedClean'], key
        scan = case['scanner']
        assert scan['beforeCurrentEqual'], key
        assert scan['beforeR9']['digest'] == scan['current']['digest'], key
        assert scan['beforeR9']['siteEvidenceIds'] == scan['current']['siteEvidenceIds'], key
        for version in ['beforeR9', 'current']:
            assert scan[version]['repeatEqual'] and scan[version]['afterRulesEqual'], (key, version)
        if case['beforeR9'] != case['current']:
            summary['changes'].append({'name': key, 'before': len(case['beforeR9']), 'current': len(case['current'])})
        if case.get('knownConservative'):
            summary['knownConservativeLimitations'].append({'name': key, 'note': case['knownConservative']})
    for case in data['query']:
        assert bool(case['sql']) != case['expectedClean'], case['name']
        summary['executedSqlFixtures'] += bool(case['sql'])
    summary['renderer'] += len(data['renderer'])
    summary['query'] += len(data['query'])
    summary['groups'][name] = {'count': count, 'sha256': sha(p)}
assert summary['renderer'] == 38 and summary['query'] == 18 and summary['executedSqlFixtures'] == 10
assert summary['changes'] == [{'name': 'category-falsy-and-api', 'before': 1, 'current': 0}], summary['changes']

# A real async invoke Promise has no reconIdFixBillCategory property before await.
# It triggers the default from channel "other"; retain the corrected unsafe expectation.
case = all_cases['single-mount-category-explicit-ipc']
assert case['historicalExpectedClean'] is True and case['expectedClean'] is False
assert case['runtime']['calledIpc'] == ['app:get-info', 'other']
assert case['runtime']['categoryWasThenable'] is True
assert case['runtime']['category']['channel'] == 'other'
assert len(case['beforeR9']) == len(case['current']) == 1

logical_names = ['ipc-and-pure-data', 'ipc-and-whole-api', 'category-falsy-and-api', 'category-truthy-and-data', 'conditional-distinct-pure-values', 'conditional-pure-or-api']
for name in logical_names:
    cases = all_cases[name]['runtime']
    assert [x['flag'] for x in cases] == [False, True], name
    assert [x['calledIpc'] for x in cases] == ([['app:get-info'], ['app:get-info']] if name.startswith('ipc-') else [[], []]), name
assert [x['value'] for x in all_cases['ipc-and-pure-data']['runtime']] == [False, ['bank', 1]]
assert [x['isWholeApi'] for x in all_cases['ipc-and-pure-data']['runtime']] == [False, False]
assert [x['isWholeApi'] for x in all_cases['ipc-and-whole-api']['runtime']] == [False, True]
assert [x['value'] for x in all_cases['category-falsy-and-api']['runtime']] == [0, 0]
assert [x['value'] for x in all_cases['category-truthy-and-data']['runtime']] == ['business', 'business']
assert [x['value'] for x in all_cases['conditional-distinct-pure-values']['runtime']] == ['gateway', 'business']
assert [x['isWholeApi'] for x in all_cases['conditional-pure-or-api']['runtime']] == [True, False]
assert len(all_cases['conditional-distinct-pure-values']['beforeR9']) == len(all_cases['conditional-distinct-pure-values']['current']) == 1
assert len(summary['knownConservativeLimitations']) == 1
summary['totalFixtures'] = 56
summary['newFindings'] = []
summary['scope'] = '50 reused fixtures plus 6 new logical data-contract probes; one existing conservative rejection is recorded separately, not counted as a newly correct legal acceptance.'
(Path(__file__).resolve().parent / 'shared-archive-verification.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(summary, ensure_ascii=False, indent=2))
