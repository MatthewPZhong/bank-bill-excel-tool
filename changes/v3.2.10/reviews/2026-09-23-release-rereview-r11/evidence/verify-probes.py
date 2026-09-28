import hashlib,json
from pathlib import Path
r=Path.cwd();e=Path(__file__).resolve().parent
read=lambda n:json.loads((e/n).read_text())
rows=lambda n:[json.loads(x) for x in (e/n).read_text().splitlines()]
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
frozen=read('input-manifest.json');repair=r/'changes/v3.2.10/reviews/2026-09-23-release-r10-repair'
before=json.loads((repair/'input-manifest.json').read_text())
for name,manifest in [('r11-renderer-before-inputs.json',before),('r11-renderer-current-inputs.json',frozen)]:
 for f,x in read(name)['files'].items():
  p='scripts/architecture/'+f
  assert x['match'] and x['sha256']==x['expected']==manifest['sha256'][p]
  assert sha(Path(x['source']) if 'source' in x else r/p)==x['sha256']
b=rows('r11-renderer-probes-before.jsonl');c=rows('r11-renderer-probes-current.jsonl')
assert len(b)==len(c)==6
assert [len(x['violations']) for x in b]==[1,1,1,1,1,1]
assert [len(x['violations']) for x in c]==[0,0,0,0,1,1]
for a,z in zip(b,c):assert a['source']==z['source'] and a['runtime']==z['runtime']
for x in c[:2]:assert x['runtime']['same'] and x['runtime']['extraCallable'] and x['runtime']['extraResult'] and not x['violations']
for x in c[2:4]:assert not x['runtime']['same'] and x['runtime']['keys']==['run'] and not x['runtime']['extraCallable']
original=rows('r11-renderer-original-probes.jsonl')
assert len(original)==8 and [len(x['violations']) for x in original]==[0,1,1,1,0,0,1,0]
for name,counts in [('r11-renderer-original-realconfig.json',[0,1]),('r11-renderer-member-realconfig.json',[0,0])]:
 d=read(name);assert [len(x['probeViolations']) for x in d]==counts
 assert all(x['boundaryCount']==20 and x['baseViolations']==0 for x in d)
real=read('r11-renderer-member-realconfig.json')
assert real[0]['runtime']['same'] and real[0]['runtime']['extraCallable'] and real[0]['runtime']['extraResult']
assert real[1]['runtime']['apiKeys']==['run'] and not real[1]['runtime']['same']
array_expected=[('r11-array-original-before-current.json',[0,1,0,1,0,0,1],[1,1,1,1,0,0,1]),('r11-array-neighbor-before-current.json',[0]*8,[1,0,0,1,1,0,1,0]),('r11-array-neighbor-real-before-current.json',[0,0,0],[1,0,0])]
for name,bcounts,ccounts in array_expected:
 d=read(name);assert d['head']==frozen['head'] and not d['sourceMismatches'] and d['sourceFileCount']==793
 for h in d['hashes']:
  p=h['path'];assert h['beforeMatchesR10Input'] and h['currentMatchesR11Input']
  if 'beforeSha256' in h:assert h['beforeSha256']==before['sha256'][p] and h['currentSha256']==frozen['sha256'][p]==sha(r/p)
  else:assert h['sha256']==before['sha256'][p]==frozen['sha256'][p]==sha(r/p)
 for f in d['scripts']:assert sha(e/f['name'])==f['sha256']
 assert [len(x['violations']) for x in d['before']['results']]==bcounts
 assert [len(x['violations']) for x in d['current']['results']]==ccounts
 for a,z in zip(d['before']['results'],d['current']['results']):assert a['source']==z['source'] and a['runtime']==z['runtime']
 if 'neighbor' in name:
  item=next(x for x in d['current']['results'] if x['name']=='uncertain-copy-slot-reverse')
  assert item['runtime']['same'] and item['runtime']['extraCallable'] and item['runtime']['extraResult'] and not item['violations']
 if 'real' in name:
  for v in ['before','current']:assert d[v]['boundaryCount']==20 and not d[v]['baseline']['violations']
original=read('r11-array-original-real.json')
assert original['boundaryCount']==20 and not original['baseline']['violations']
assert [len(x['violations']) for x in original['results']]==[1,1,1,0]
s=read('shared-archive-verification.json');assert s['status']=='PASS' and s['totalFixtures']==62 and s['scannerStableFixtures']==62 and not s['sharedDiagnosticChanges'] and not s['newFindings']
a=read('architecture-check.json');assert not a['violations'] and not a['staleExceptions'] and len(a['activeBoundaries'])==31
log=(e/'architecture-tests.log').read_text()
for t in ['tests 566','pass 566','fail 0','skipped 0']:assert t in log
p=read('policy-production-comparison.json');assert p['productionFilesCompared']==792 and not p['changedProductionFiles'] and all(x['sameAsRepairInput'] for x in p['policyAndScannerFiles'])
gate=json.loads((repair/'gate-input-manifest.json').read_text())
assert len(gate['sha256'])==1707 and gate['head']==frozen['head'] and all(sha(r/p)==h for p,h in gate['sha256'].items())
g=read('reused-gate-verification.json');assert g['status']=='PASS' and not g['rerunThisRound'] and g['gate']['exitCode']==0 and g['unit']['pass']==9340 and g['unit']['skipped']==4 and g['integration']['scripts']==68
result={'status':'PASS','meaning':'Archived observations and confirmed defects are consistent; this is not a defect-free candidate verdict.','originalRendererCases':8,'originalArrayCases':7,'rendererNeighborCases':6,'arrayNeighborCases':8,'sharedCases':56,'parameterBindingCases':6,'scannerStableCases':62,'closedOriginalFindings':['RR10-01','RR10-02'],'confirmedFindings':['RR11-01 new member-proof propagation regression','RR11-02 pre-existing moved-array-source gap'],'architectureTests':566,'activeBoundaries':31,'architectureDiagnostics':0,'reusedGateInputsMatched':1707}
(e/'probe-verification.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');print(json.dumps(result,ensure_ascii=False,indent=2))
