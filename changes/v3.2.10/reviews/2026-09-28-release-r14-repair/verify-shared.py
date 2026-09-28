"""在最终 RR14 检查器上重放上一轮冻结的共享正反例。"""
from pathlib import Path
import json
import subprocess

E = Path(__file__).resolve().parent
ROOT = E.parents[3]
REVIEW = ROOT / 'changes/v3.2.10/reviews/2026-09-28-release-rereview-r14/evidence'
names = ['shared-probes', 'destructure-probes', 'localenv-probes',
         'default-combinations', 'async-array-combinations', 'logical-combinations']
result = {'status': 'PASS', 'groups': {}, 'fixtures': 0, 'renderer': 0, 'query': 0,
          'diagnosticChanges': [], 'scannerChanges': []}
for name in names:
    script = REVIEW / f'r14-shared-{name}.cjs'
    previous = json.loads((REVIEW / f'r14-shared-{name}.json').read_text())
    current_path = E / f'r14-shared-{name}.json'
    with current_path.open('w') as output:
        subprocess.run(['node', str(script)], cwd=ROOT, stdout=output, check=True)
    current = json.loads(current_path.read_text())
    assert [row['path'] for row in current['policy']] == [row['path'] for row in previous['policy']]
    assert all(row['same'] for row in current['policy'])
    count = 0
    for group in ['renderer', 'query']:
        assert len(current[group]) == len(previous[group])
        result[group] += len(current[group])
        for now, old in zip(current[group], previous[group]):
            assert now['name'] == old['name'] and now['source'] == old['source']
            assert now['expectedClean'] == old['expectedClean']
            assert (not now['current']) == now['expectedClean'] or now.get('knownConservative')
            if now['current'] != old['current']:
                result['diagnosticChanges'].append(now['name'])
            if now['scanner']['current'] != old['scanner']['current']:
                result['scannerChanges'].append(now['name'])
            assert now['scanner']['current']['repeatEqual'] and now['scanner']['current']['afterRulesEqual']
            if group == 'query':
                assert now['sql'] == old['sql'] and now['actual'] == old['actual']
            count += 1
    result['groups'][name] = count
    result['fixtures'] += count
assert result['fixtures'] == 56 and result['renderer'] == 38 and result['query'] == 18
assert not result['diagnosticChanges'] and not result['scannerChanges'], result
(E / 'shared-verification.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(result, ensure_ascii=False))
