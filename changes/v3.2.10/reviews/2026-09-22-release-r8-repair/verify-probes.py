"""核验 RR8 实际配置、VM 与共享解析证据；区分保守拒绝和真实越权。"""
from pathlib import Path
import hashlib
import json

E = Path(__file__).resolve().parent
ROOT = E.parents[3]


def read(name):
    return json.loads((E / name).read_text())


ipc = read('renderer-ipc-realconfig.json')
assert len(ipc) == 2
for item in ipc:
    assert item['boundaryCount'] == 20 and item['baseViolations'] == 0
    assert len(item['probeViolations']) == 1 and item['runtime']['ipcReads'] == 1
assert ipc[0]['runtime']['extraCallable'] and ipc[0]['runtime']['same']
assert not ipc[1]['runtime']['extraCallable'] and not ipc[1]['runtime']['same']
array = read('renderer-array-realconfig.json')
assert array['boundaryCount'] == 20 and not array['baseline']['violations']
assert len(array['results']) == 5
for item in array['results']:
    assert (len(item['violations']) == 0) == item['safe'], item['name']
    assert item['runtime']['extraCallable'] != item['safe'], item['name']
    assert item['coverage']['parsedFiles'] == 765 and item['coverage']['parseErrors'] == 0
shared = read('shared-archive-verification.json')
assert shared['status'] == 'PASS' and shared['rendererCases'] + shared['queryCases'] == 44
initial = read('input-manifest.json')['sha256']
unchanged = {}
for name in ['scripts/architecture/contracts.js', 'scripts/architecture/rules.js', 'scripts/architecture/scan.js',
             'scripts/architecture/schema.js', 'scripts/architecture/policy-history.js',
             'architecture/boundaries.json', 'architecture/legacy-allowlist.json']:
    digest = hashlib.sha256((ROOT / name).read_bytes()).hexdigest()
    assert digest == initial[name], name
    unchanged[name] = digest
summary = {'result': 'PASS', 'rendererBoundaries': 20, 'arrayCases': 5,
           'ipcMissingField': '1 diagnostic; VM confirms injected outsideScope',
           'ipcProvidedField': '1 conservative diagnostic: channel/fields does not prove presence; VM confirms this stub is safe',
           'ipcProvablyProvidedObject': 'Accepted by unit regression; no default identity contamination',
           'shared': shared, 'unchangedSharedCheckerAndPolicySha256': unchanged,
           'scope': 'Renderer real AST and VM stubs; no product Main or recovery IO; no claim that each of the 20 factories was individually mutated'}
(E / 'probe-verification.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(summary, ensure_ascii=False, indent=2))
