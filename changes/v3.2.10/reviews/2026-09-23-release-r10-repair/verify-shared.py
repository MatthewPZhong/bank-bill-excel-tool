"""复验本轮重新执行的 56 个共享探针，不复用历史 before 输出。"""
from pathlib import Path
import hashlib, json

E = Path(__file__).resolve().parent
ROOT = E.parents[3]
OLD = ROOT / 'changes/v3.2.10/reviews/2026-09-22-release-rereview-r10/evidence'
read = lambda path: json.loads(path.read_text())
sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
manifest = read(E / 'input-manifest.json')['sha256']
inputs = read(E / 'r10-probe-inputs.json')
counts = {'renderer': 0, 'query': 0}
changes = []
conservative = []
suites = []
sql_executed = 0
for script in sorted(E.glob('r10-shared-*.cjs')):
    output = script.with_suffix('.json')
    data = read(output)
    previous = read(OLD / output.name)
    assert len(data['beforeInputHashes']) == 5, output.name
    for entry in data['beforeInputHashes']:
        assert entry['match'] and entry['sha256'] == manifest[entry['path']], (output.name, entry)
        source = E / 'before' / entry['path'] if entry['path'].endswith('/renderer-contracts.js') else ROOT / entry['path']
        assert sha(source) == entry['sha256']
    assert len(data['currentInputHashes']) == 5
    for entry in data['currentInputHashes']:
        assert entry['sha256'] == inputs['current'][entry['path']] == sha(ROOT / entry['path'])
    assert all(item['same'] and item['before'] == item['current'] == manifest[item['path']] for item in data['policy'])
    for group in ['renderer', 'query']:
        assert len(data[group]) == len(previous[group]), (output.name, group)
        for row, historic in zip(data[group], previous[group]):
            counts[group] += 1
            assert row['name'] == historic['name'] and row['source'] == historic['source']
            assert row['expectedClean'] == historic['expectedClean']
            assert (not row['beforeR10']) == row['expectedClean'], (output.name, row['name'], 'before')
            assert (not row['current']) == row['expectedClean'], (output.name, row['name'], 'current')
            if row['beforeR10'] != row['current']:
                changes.append({'suite': output.name, 'name': row['name'], 'before': row['beforeR10'], 'current': row['current']})
            scanner = row['scanner']
            assert scanner['beforeCurrentEqual']
            assert scanner['beforeR10']['siteEvidenceIds'] == scanner['current']['siteEvidenceIds']
            for version in ['beforeR10', 'current']:
                assert scanner[version]['repeatEqual'] and scanner[version]['afterRulesEqual']
                assert scanner[version]['digest'] == scanner['beforeR10']['digest']
            if group == 'query':
                sql_executed += bool(row['sql'])
                assert row['sql'] == historic['sql'] and row['actual'] == historic['actual']
            if row.get('knownConservative') or row['name'].endswith('-conservative'):
                assert row['beforeR10'] and row['current']
                conservative.append({'suite': output.name, 'name': row['name'], 'reason': row.get('knownConservative', 'IPC field presence remains unknown; fallback capability is conservatively retained')})
            if row['name'] == 'single-mount-category-explicit-ipc':
                assert row['runtime']['calledIpc'] == ['app:get-info', 'other']
                assert row['runtime']['categoryWasThenable'] is True
                assert row['expectedClean'] is False
    suites.append({'file': output.name, 'rendererCases': len(data['renderer']), 'queryCases': len(data['query']), 'outputSha256': sha(output), 'scriptSha256': sha(output.with_suffix('.cjs'))})
assert counts == {'renderer': 38, 'query': 18}, counts
assert sql_executed == 10, sql_executed
assert not changes, changes
assert len(suites) == 6
result = {'status': 'PASS', 'beforeVersion': '2026-09-23-release-r10-repair/input-manifest.json', 'beforeExecution': 'All suites freshly executed with archived renderer-contracts.js and four SHA256-matched shared checkers', 'suiteCount': len(suites), 'totalCases': sum(counts.values()), 'rendererCases': counts['renderer'], 'queryCases': counts['query'], 'queryCasesExecutingSql': sql_executed, 'changedResults': changes, 'changedResultCount': len(changes), 'allExpectedResultsMatched': True, 'scannerRepeatAndPostRulesStableCases': sum(counts.values()), 'conservativeRejections': conservative, 'asyncIpcDefaultExpectationPreserved': True, 'suites': suites}
(E / 'shared-archive-verification.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(result, ensure_ascii=False, indent=2))
