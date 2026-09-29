"""复核归档证据的一致性；PASS 不表示检查器无缺陷。"""
import json, re
from pathlib import Path
p = Path(__file__).resolve().parent
load = lambda name: json.loads((p / name).read_text())
rows = lambda name: {x['name']: x for x in map(json.loads, (p / name).read_text().splitlines())}
before = rows('r7-renderer-neighbors-before.jsonl')
current = rows('r7-renderer-neighbors-current.jsonl')
regressions = ['default-missing-member', 'default-undefined-member', 'default-missing-parameter']
for name in regressions:
    assert len(before[name]['violations']) == 1 and before[name]['violations'][0]['rule'] == 'ARCH-RENDERER-SCOPE', name
    assert not current[name]['violations'], name
    assert current[name]['runtime']['same'] and current[name]['runtime']['extraResult'], name
assert not current['default-provided-other']['violations'] and not current['default-provided-other']['runtime']['same']
for name in ['r7-renderer-before-inputs.json', 'r7-renderer-current-inputs.json']:
    assert len(load(name)['files']) == 5 and all(x['match'] for x in load(name)['files'].values())
real = load('r7-renderer-default-realconfig.json')
assert len(real) == 2 and all(x['boundaryCount'] == 20 and x['baseViolations'] == 0 and not x['probeViolations'] for x in real)
assert real[0]['runtime']['same'] and real[0]['runtime']['extraResult'] and real[0]['runtime']['apiKeys'] == ['run', 'outsideScope']
assert not real[1]['runtime']['same'] and real[1]['runtime']['apiKeys'] == ['run']
old = load('r7-renderer-original-realconfig.json')
assert all(x['boundaryCount'] == 20 and x['baseViolations'] == 0 for x in old)
assert len(old[0]['probeViolations']) == 1 and old[0]['probeViolations'][0]['rule'] == 'ARCH-RENDERER-SCOPE'
assert not old[1]['probeViolations'] and not old[1]['runtime']['same']
g1_denied = g1_safe = 0
for name, count in [('r7-g1-before-current.json', 8), ('r7-g1-adjacent-before-current.json', 6)]:
    d = load(name)
    assert len(d['hashes']) == 7 and all(x['matchesInputManifest'] for x in d['hashes'])
    assert d['current']['boundaryState'] == 'active' and len(d['current']['outputs']) == count
    for row in d['current']['outputs']:
        assert row['parseErrors'] == 0 and row['unresolved'] == 0
        assert len(row['violations']) == row['writes']
        g1_denied += row['writes']; g1_safe += 1 - row['writes']
assert (g1_denied, g1_safe) == (9, 5)
for name, count in [('projection', 1), ('native-data', 0), ('preparing', 1)]:
    d = load('r7-g1-' + name + '-real-source-probe.json')
    assert d['boundaryState'] == 'active' and d['coverage']['parsedFiles'] == d['coverage']['scannedFiles'] == 765
    assert d['coverage']['parseErrors'] == 0 and d['coverage']['unresolved'] == 2 and len(d['violations']) == count
assert load('r7-g1-native-data-real-source-probe.json')['callbackCall']['callbackTargets'] == []
counts = {'renderer': 0, 'query': 0}; sql = improved = 0
improvements = {'local-return-data', 'local-return-unreached-call', 'projected-return-unreached-call'}
for name in ['shared', 'destructure', 'localenv']:
    d = load('r7-data-' + name + '-probes.json')
    assert all(x['same'] for x in d['policy']) and all(x['match'] for x in d['beforeInputHashes'])
    for group in counts:
        for row in d[group]:
            counts[group] += 1
            assert (len(row['current']) == 0) == row['expectedClean']
            for version in ['beforeR6', 'current']:
                assert row['scanner'][version]['repeatEqual'] and row['scanner'][version]['afterRulesEqual']
            assert row['scanner']['beforeCurrentEqual']
            assert row['scanner']['beforeR6']['siteEvidenceIds'] == row['scanner']['current']['siteEvidenceIds']
            if row['name'] in improvements:
                assert len(row['beforeR6']) == 1 and not row['current']; improved += 1
            else:
                assert [v['rule'] for v in row['beforeR6']] == [v['rule'] for v in row['current']]
            if group == 'query':
                assert (len(row['sql']) == 0) == row['expectedClean']; sql += len(row['sql'])
assert counts == {'renderer': 20, 'query': 18} and sql == 10 and improved == 3
for name, count in [('architecture-tests.log', 356), ('r7-renderer-targeted-tests.log', 21), ('r7-g1-rr6-02-tests.tap', 19)]:
    content = (p / name).read_text()
    values = {k: int(v) for k, v in re.findall(r'(?m)^[#ℹ] (tests|pass|fail|skipped) (\d+)$', content)}
    assert values == {'tests': count, 'pass': count, 'fail': 0, 'skipped': 0}, (name, values)
a = load('architecture-check.json')
assert len(a['activeBoundaries']) == 31 and not a['violations'] and not a['staleExceptions']
assert not a['coverage']['pendingBoundaries'] and not a['coverage']['partialBoundaries']
assert a['coverage']['scannedFiles'] == a['coverage']['parsedFiles'] == 765 and a['coverage']['parseErrors'] == 0
g = load('gate-evidence-comparison.json')
assert g['headMatches'] and g['gateInputCount'] == 1703 and not g['changedGateInputs']
result = {'status': 'PASS', 'meaning': 'Archived evidence assertions passed; RR7-01 remains a confirmed checker defect.', 'newFindings': ['RR7-01'], 'newRegressionVariants': regressions, 'closedPriorFindings': ['RR6-01', 'RR6-02'], 'rendererActualBoundaries': 20, 'g1DeniedExecutingCases': g1_denied, 'g1AcceptedSafeCases': g1_safe, 'sharedParserCases': counts, 'actualInMemoryQueries': sql, 'correctedQueryFalsePositives': improved, 'architectureTestsPassed': 356, 'activeBoundaries': 31, 'fullGateReusedMatchingInputs': 1703, 'existingArrayElementGap': 'Observed before/current unchanged in small fixture; not closed, not expanded to full actual configuration.'}
(p / 'probe-verification.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(result, ensure_ascii=False, indent=2))
