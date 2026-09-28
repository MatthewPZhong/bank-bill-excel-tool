"""断言本轮准确起点和最终检查器的 Renderer 修复证据；不代表完整产品验收。"""
from pathlib import Path
import hashlib, json

E = Path(__file__).resolve().parent
ROOT = E.parents[3]
read = lambda name: json.loads((E / name).read_text())
rows = lambda name: [json.loads(line) for line in (E / name).read_text().splitlines()]
sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
manifest = read('input-manifest.json')['sha256']
inputs = read('r10-probe-inputs.json')
assert len(inputs['before']) == len(inputs['current']) == 5
for file, digest in inputs['before'].items():
    source = E / 'before' / file if file.endswith('/renderer-contracts.js') else ROOT / file
    assert digest == manifest[file] == sha(source), file
for file, digest in inputs['current'].items():
    assert digest == sha(ROOT / file), file
unchanged = inputs['unchangedSharedCheckerAndPolicySha256']
assert len(unchanged) == 7
for file, digest in unchanged.items():
    assert digest == manifest[file] == sha(ROOT / file), file
assert inputs['before']['scripts/architecture/renderer-contracts.js'] != inputs['current']['scripts/architecture/renderer-contracts.js']
assert all(row['exitCode'] == 0 for row in read('r10-probe-executions.json'))
assert len(inputs['reusedFreshBeforeArtifacts']) == 4
for file, digest in inputs['reusedFreshBeforeArtifacts'].items():
    assert sha(E / file) == digest, file

logical_before = rows('r10-renderer-probes-before.jsonl')
logical_current = rows('r10-renderer-probes-current.jsonl')
assert len(logical_before) == len(logical_current) == 8
assert [len(row['violations']) for row in logical_before] == [0, 1, 1, 1, 1, 1, 1, 0]
assert [len(row['violations']) for row in logical_current] == [0, 1, 1, 1, 0, 0, 1, 0]
logical_summary = []
for before, current in zip(logical_before, logical_current):
    assert before['name'] == current['name'] and before['source'] == current['source'] and before['runtime'] == current['runtime']
    assert bool(current['violations']) is not current['safe']
    assert current['runtime']['same'] is not current['safe']
    assert current['runtime']['extraCallable'] is not current['safe']
    if current['safe']:
        assert current['runtime']['keys'] == ['run']
    else:
        assert current['runtime']['extraResult'] is True
    logical_summary.append({'name': current['name'], 'safe': current['safe'], 'beforeDiagnostics': len(before['violations']), 'currentDiagnostics': len(current['violations']), 'runtimeSameObject': current['runtime']['same']})

array_summary = []
for prefix, expected_before, expected_current in [
    ('r10-array-neighbor-', [0, 1, 0, 1, 0, 0, 1], [1, 1, 1, 1, 0, 0, 1]),
    ('r10-array-real-neighbor-', [0, 1, 0, 0], [1, 1, 1, 0]),
]:
    before = read(prefix + 'before.json')
    current = read(prefix + 'current.json')
    assert [len(row['violations']) for row in before['results']] == expected_before
    assert [len(row['violations']) for row in current['results']] == expected_current
    if prefix == 'r10-array-real-neighbor-':
        for result in [before, current]:
            assert result['boundaryCount'] == 20 and not result['baseline']['violations']
            assert all(boundary['state'] == 'active' for boundary in result['boundaries'])
    for old, row in zip(before['results'], current['results']):
        assert old['name'] == row['name'] and old['source'] == row['source'] and old['runtime'] == row['runtime']
        assert bool(row['violations']) is not row['safe']
        assert row['runtime']['same'] is not row['safe']
        assert row['runtime']['extraCallable'] is not row['safe']
        if row['safe']:
            assert row['runtime']['keys'] == ['run']
        else:
            assert row['runtime']['extraResult'] is True
        if prefix == 'r10-array-neighbor-':
            array_summary.append({'name': row['name'], 'safe': row['safe'], 'beforeDiagnostics': len(old['violations']), 'currentDiagnostics': len(row['violations']), 'runtimeSameObject': row['runtime']['same']})

real_before = read('r10-renderer-nested-realconfig-before.json')
real_current = read('r10-renderer-nested-realconfig-current.json')
assert [len(row['probeViolations']) for row in real_before] == [1, 1]
assert [len(row['probeViolations']) for row in real_current] == [0, 1]
for before, row in zip(real_before, real_current):
    assert before['source'] == row['source'] and before['runtime'] == row['runtime']
    assert before['boundaryCount'] == row['boundaryCount'] == 20
    assert before['baseViolations'] == row['baseViolations'] == 0
    assert row['runtime']['ipcReads'] == 1
assert real_current[0]['runtime']['apiKeys'] == ['run']
assert real_current[0]['runtime']['same'] is False and real_current[0]['runtime']['extraCallable'] is False
assert real_current[1]['runtime']['same'] is True and real_current[1]['runtime']['extraResult'] is True

shared = read('shared-archive-verification.json')
assert shared['status'] == 'PASS' and shared['totalCases'] == 56 and shared['changedResultCount'] == 0
assert shared['rendererCases'] == 38 and shared['queryCases'] == 18
assert shared['allExpectedResultsMatched']
files = sorted(list(E.glob('r10-*.cjs')) + [E / execution['output'] for execution in read('r10-probe-executions.json')])
result = {
    'result': 'PASS', 'beforeVersion': inputs['beforeVersion'],
    'meaning': 'RR10-01/02 bounded logical and factory-array probes meet their expected static diagnostics and VM identity checks; this does not establish arbitrary JavaScript coverage or product/platform acceptance.',
    'rendererBoundaries': 20, 'realAstCases': 6,
    'realAstLogicalCases': 2, 'realAstArrayCases': 4,
    'realAstBaselineDiagnostics': 0,
    'logicalCases': {'count': len(logical_summary), 'falsePositivesClosed': 2, 'cases': logical_summary},
    'arrayCases': {'count': len(array_summary), 'sourceLossCasesClosed': 2, 'cases': array_summary},
    'shared': {key: shared[key] for key in ['status', 'totalCases', 'rendererCases', 'queryCases', 'queryCasesExecutingSql', 'changedResultCount', 'scannerRepeatAndPostRulesStableCases', 'conservativeRejections']},
    'currentCheckerSha256': inputs['current'],
    'reusedFreshBeforeArtifacts': inputs['reusedFreshBeforeArtifacts'],
    'unchangedSharedCheckerAndPolicySha256': unchanged,
    'artifactSha256': {file.name: sha(file) for file in files},
    'supersededEvidence': 'Files whose names contain preliminary are retained observations from before the final checker freeze and are excluded from these assertions.',
}
(E / 'probe-verification.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({key: result[key] for key in ['result', 'rendererBoundaries', 'realAstCases', 'shared']}, ensure_ascii=False, indent=2))
