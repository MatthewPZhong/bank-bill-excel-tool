from pathlib import Path
import json
b=Path(__file__).resolve().parent
read=lambda name:json.loads((b/name).read_text())
rows=lambda name:{x['name']:x for x in (json.loads(line) for line in (b/name).read_text().splitlines() if line.strip())}
old={x['name']:x for x in read('r6-renderer-original-realconfig.json')}
assert len(old['static_member_replacement']['probeViolations'])==1
assert old['detached_alias_safe']['probeViolations']==[]
cur=rows('r6-renderer-neighbors-current.jsonl');before=rows('r6-renderer-neighbors-before.jsonl')
assert len(before['destructured-parameter-after']['violations'])==1
assert before['destructured-parameter-after']['violations'][0]['rule']=='ARCH-STATIC-COVERAGE'
assert cur['destructured-parameter-after']['violations']==[] and cur['destructured-parameter-after']['runtime']['extraResult'] is True
assert len(cur['explicit-parameter-after']['violations'])==1
assert cur['destructured-parameter-before']['violations']==[]
assert all(x['match'] for x in read('r6-renderer-before-inputs.json')['files'].values())
real={x['name']:x for x in read('r6-renderer-parameter-realconfig.json')}
bad=real['destructured_parameter_after'];safe=real['destructured_parameter_before_safe']
assert bad['boundaryCount']==20 and bad['baseViolations']==0 and bad['probeViolations']==[]
assert bad['runtime']['same'] is True and bad['runtime']['extraResult'] is True
assert safe['probeViolations']==[] and safe['runtime']['same'] is False and safe['runtime']['apiKeys']==['run']
g=read('r6-g1-before-current.json');assert all(x['matchesInputManifest'] for x in g['hashes'])
gbefore={x['name']:x for x in g['before']['outputs']};gcur={x['name']:x for x in g['current']['outputs']}
for name in ['projected_array_override','destructured_array_override','parameter_prototype_override']:
 assert len(gbefore[name]['violations'])==1 and gcur[name]['violations']==[] and gcur[name]['writes']==1
for name in ['direct_array_override','direct_prototype_override']:
 assert len(gcur[name]['violations'])==1 and gcur[name]['writes']==1
for name in ['safe_includes','safe_last_indexof']:
 assert gcur[name]['violations']==[] and gcur[name]['writes']==0
assert read('r6-g1-native-data-real-source-probe.json')['violations']==[]
assert len(read('r6-g1-preparing-real-source-probe.json')['violations'])==1
greal=read('r6-g1-projection-real-source-probe.json')
assert greal['boundaryState']=='active' and greal['coverage']['parsedFiles']==765
assert greal['violations']==[] and greal['callbackCall']['callbackTargets']==[]
data=read('r6-data-verification.json');assert data['status']=='PASS' and data['rendererCases']+data['queryCases']==28
assert data['scannerJsonBeforeCurrentEqual'] and data['siteEvidenceIdsUnchanged'] and data['descriptorIsolation']['status']=='PASS'
out={'status':'PASS','meaning':'Evidence consistency assertions passed; two newly confirmed violating examples remain false negatives, not product PASS.','originalR5ExamplesClosed':True,'rendererNewRegression':True,'g1NewRegression':True,'beforeHashesMatched':True,'dataFixtures':28,'rendererActualBoundaries':20,'g1ActualParsedFiles':765}
(b/'probe-verification.json').write_text(json.dumps(out,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(out,ensure_ascii=False))
