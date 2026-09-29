import hashlib,json
from pathlib import Path
r=Path.cwd();e=Path(__file__).resolve().parent
read=lambda n:json.loads((e/n).read_text());rows=lambda n:[json.loads(x) for x in (e/n).read_text().splitlines()];sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
frozen=read('input-manifest.json');repair=r/'changes/v3.2.10/reviews/2026-09-23-release-r11-repair';before=json.loads((repair/'input-manifest.json').read_text())
for name,manifest in [('r12-renderer-before-inputs.json',before),('r12-renderer-current-inputs.json',frozen)]:
 for f,x in read(name)['files'].items():
  p='scripts/architecture/'+f
  assert x['match'] and x['sha256']==x['expected']==manifest['sha256'][p]
  assert sha(Path(x['source']) if 'source' in x else r/p)==x['sha256']
b=rows('r12-renderer-probes-before.jsonl');c=rows('r12-renderer-probes-current.jsonl')
assert len(b)==len(c)==6
assert [len(x['violations']) for x in b]==[0,0,0,0,0,1]
assert [len(x['violations']) for x in c]==[1,1,1,0,0,1]
for a,z in zip(b,c):assert a['source']==z['source'] and a['runtime']==z['runtime']
for x in c:
 assert (not x['violations'])==x['safe']
 assert x['runtime']['same']!=x['safe'] and x['runtime']['extraCallable']!=x['safe']
original=rows('r12-renderer-original-probes.jsonl');assert len(original)==6 and [len(x['violations']) for x in original]==[1,1,0,0,1,1]
real=read('r12-renderer-original-realconfig.json');assert [len(x['probeViolations']) for x in real]==[1,0]
assert all(x['boundaryCount']==20 and x['baseViolations']==0 for x in real)
assert real[0]['runtime']['same'] and real[0]['runtime']['extraCallable'] and real[0]['runtime']['extraResult']
assert real[1]['runtime']['apiKeys']==['run'] and not real[1]['runtime']['same']
original=read('r12-array-original-before-current.json')
assert [len(x['violations']) for x in original['before']['results']]==[1,0,0,1,1,0,1,0]
assert [len(x['violations']) for x in original['current']['results']]==[1,1,0,1,1,0,1,0]
for name in ['r12-array-original-before-current.json','r12-array-neighbor-before-current.json','r12-array-neighbor-real-before-current.json']:
 d=read(name);assert d['head']==frozen['head'] and not d['sourceMismatches'] and d['sourceFileCount']==793
 for h in d['hashes']:
  p=h['path'];assert h['beforeMatchesR11Input'] and h['currentMatchesR12Input']
  if 'beforeSha256' in h:assert h['beforeSha256']==before['sha256'][p] and h['currentSha256']==frozen['sha256'][p]==sha(r/p)
  else:assert h['sha256']==before['sha256'][p]==frozen['sha256'][p]==sha(r/p)
 for f in d['scripts']:assert sha(e/f['name'])==f['sha256'],f['name']
 for a,z in zip(d['before']['results'],d['current']['results']):assert a['source']==z['source'] and a['runtime']==z['runtime']
 if 'real' in name:
  for v in ['before','current']:assert d[v]['boundaryCount']==20 and not d[v]['baseline']['violations']
minimal=read('r12-array-neighbor-before-current.json');actual=read('r12-array-neighbor-real-before-current.json')
def observed(rows):return [x['scanError']['name'] if 'scanError' in x else len(x['violations']) for x in rows]
assert observed(minimal['before']['results'])==[0,'RangeError','RangeError','RangeError',0,0,'RangeError',0]
assert observed(minimal['current']['results'])==[1,'RangeError','RangeError','RangeError',1,1,'RangeError',0]
assert observed(actual['before']['results'])==[0,'RangeError','RangeError',0]
assert observed(actual['current']['results'])==[1,'RangeError','RangeError',0]
for d in [minimal,actual]:
 for v in ['before','current']:
  for x in d[v]['results']:
   if 'scanError' in x:
    assert 'violations' not in x
    assert x['scanError']['message']=='Maximum call stack size exceeded'
    assert x['runtime']['same']!=x['safe'] and x['runtime']['extraCallable']!=x['safe']
obs=minimal['current']['results'][4];assert obs['safe'] and obs['runtime']['keys']==['run'] and len(obs['violations'])==1
original=read('r12-array-original-real.json');assert original['boundaryCount']==20 and not original['baseline']['violations'] and [len(x['violations']) for x in original['results']]==[1,1,0]
raw=read('r12-array-raw-helper-exit.json');assert raw['status']==1 and raw['signal'] is None
assert 'RangeError: Maximum call stack size exceeded' in (e/'r12-array-raw-helper.stderr').read_text()
s=read('shared-archive-verification.json');assert s['status']=='PASS' and s['totalFixtures']==62 and s['scannerStableFixtures']==62 and not s['sharedDiagnosticChanges'] and not s['newFindings']
a=read('architecture-check.json');assert not a['violations'] and not a['staleExceptions'] and len(a['activeBoundaries'])==31
log=(e/'architecture-tests.log').read_text()
for t in ['tests 577','pass 577','fail 0','skipped 0']:assert t in log
p=read('policy-production-comparison.json');assert p['productionFilesCompared']==792 and not p['changedProductionFiles'] and all(x['sameAsRepairInput'] for x in p['policyAndScannerFiles'])
gate=json.loads((repair/'gate-input-manifest.json').read_text());assert len(gate['sha256'])==1708 and gate['head']==frozen['head'] and all(sha(r/p)==h for p,h in gate['sha256'].items())
g=read('reused-gate-verification.json');assert g['status']=='PASS' and not g['rerunThisRound'] and g['gate']['exitCode']==0 and g['unit']['pass']==9351 and g['unit']['skipped']==4 and g['integration']['scripts']==68
result={'status':'PASS','meaning':'Archived observations including scanError and conservative rejection are consistent; this is not a defect-free candidate verdict.','originalRendererCases':6,'originalArrayCases':8,'rendererNeighborCases':6,'arrayNeighborCases':8,'arrayNeighborErrorsPerVersion':4,'arrayActualConfigErrorsPerVersion':2,'sharedCases':56,'parameterBindingCases':6,'scannerStableCases':62,'closedOriginalFindings':['RR11-01','RR11-02'],'confirmedFindings':['RR12-01 pre-existing recursive checker failure through an array helper'],'observations':['new conservative rejection of overwritten-before-reorder-safe, not counted as a defect'],'architectureTests':577,'activeBoundaries':31,'architectureDiagnostics':0,'reusedGateInputsMatched':1708}
(e/'probe-verification.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');print(json.dumps(result,ensure_ascii=False,indent=2))
