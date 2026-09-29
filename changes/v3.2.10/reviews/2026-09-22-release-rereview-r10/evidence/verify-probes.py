import hashlib,json,re
from pathlib import Path
r=Path.cwd();e=Path(__file__).resolve().parent
read=lambda n:json.loads((e/n).read_text())
rows=lambda n:[json.loads(x) for x in (e/n).read_text().splitlines()]
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
frozen=read('input-manifest.json')
before=json.loads((r/'changes/v3.2.10/reviews/2026-09-22-release-r9-repair/input-manifest.json').read_text())
for name,manifest in [('r10-renderer-before-inputs.json',before),('r10-renderer-current-inputs.json',frozen)]:
 for f,x in read(name)['files'].items():
  p='scripts/architecture/'+f
  assert x['match'] and x['sha256']==x['expected']==manifest['sha256'][p],(name,p)
  if 'source' in x: assert sha(Path(x['source']))==x['sha256']
  else:assert sha(r/p)==x['sha256']
b=rows('r10-renderer-probes-before.jsonl');c=rows('r10-renderer-probes-current.jsonl')
assert len(b)==len(c)==8
assert [len(x['violations']) for x in b]==[0,1,0,0,0,0,1,0]
assert [len(x['violations']) for x in c]==[0,1,1,1,1,1,1,0]
for a,z in zip(b,c): assert a['source']==z['source'] and a['runtime']==z['runtime']
for x in c:
 if x['name'] in ['and-or-provided','and-nullish-provided']:
  assert x['safe'] and x['runtime']['same'] is False and x['runtime']['keys']==['run'] and not x['runtime']['extraCallable']
for name,counts in [('r10-renderer-original-realconfig.json',[1,0]),('r10-renderer-nested-realconfig.json',[1,1])]:
 d=read(name);assert [len(x['probeViolations']) for x in d]==counts
 assert all(x['boundaryCount']==20 and x['baseViolations']==0 for x in d)
nested=read('r10-renderer-nested-realconfig.json')
assert nested[0]['runtime']['apiKeys']==['run'] and nested[0]['runtime']['same'] is False
assert nested[1]['runtime']['extraCallable'] and nested[1]['runtime']['same']
original=read('r10-array-original-real.json')
assert original['boundaryCount']==20 and not original['baseline']['violations']
assert [len(x['violations']) for x in original['results']]==[1,1,1,0]
for name,expected in [('r10-array-neighbor-before-current.json',[0,1,0,1,0,0,1]),('r10-array-real-neighbor-before-current.json',[0,1,0,0])]:
 d=read(name)
 for h in d['hashes']:assert h['beforeMatchesR9Input'] and h['currentMatchesR10Input']
 for f,h in d['caseHashes'].items():assert sha(e/f)==h,(name,f)
 assert [len(x['violations']) for x in d['before']['results']]==[0]*len(expected)
 assert [len(x['violations']) for x in d['current']['results']]==expected
 for a,z in zip(d['before']['results'],d['current']['results']):
  assert a['source']==z['source'] and a['runtime']==z['runtime']
  if z['name'] in ['factory-empty-extended','factory-empty-pushed']:
   assert z['runtime']['same'] and z['runtime']['extraCallable'] and z['runtime']['extraResult'] and not z['violations']
 if 'real' in name:
  for v in ['before','current']:assert d[v]['boundaryCount']==20 and not d[v]['baseline']['violations']
shared_count=0;logical_count=0;query_count=0
for p in sorted(e.glob('r10-shared-*.json')):
 if p.name.endswith('verification.json'):continue
 d=json.loads(p.read_text())
 if 'beforeInputHashes' not in d:continue
 assert len(d['beforeInputHashes'])==5 and all(x['match'] and x['sha256']==before['sha256'][x['path']] for x in d['beforeInputHashes'])
 assert all(x['same'] and x['before']==x['current'] for x in d['policy'])
 for group in ['renderer','query']:
  for x in d[group]:
   assert (not x['current'])==x['expectedClean'],(p.name,x['name'])
   if 'logical' in p.name: logical_count+=1
   else:shared_count+=1
   if group=='query':query_count+=1
   s=x['scanner'];assert s['beforeCurrentEqual']
   for v in ['beforeR9','current']:assert s[v]['repeatEqual'] and s[v]['afterRulesEqual']
   assert s['beforeR9']['siteEvidenceIds']==s['current']['siteEvidenceIds']
assert (shared_count,logical_count,query_count)==(50,6,18)
a=read('architecture-check.json');assert not a['violations'] and not a['staleExceptions']
assert len(a['activeBoundaries'])==31
log=(e/'architecture-tests.log').read_text()
for text in ['tests 482','pass 482','fail 0','skipped 0']:assert text in log
p=read('policy-production-comparison.json');assert p['productionFilesCompared']==792 and not p['changedProductionFiles']
assert all(x['sameAsRepairInput'] for x in p['policyAndScannerFiles'])
g=read('gate-evidence-comparison.json');assert g['headMatches'] and g['gateInputCount']==1706 and not g['changedGateInputs']
gate_manifest=json.loads((r/'changes/v3.2.10/reviews/2026-09-22-release-r9-repair/gate-input-manifest.json').read_text())
assert len(gate_manifest['sha256'])==1706 and gate_manifest['head']==frozen['head']
assert all(sha(r/p)==h for p,h in gate_manifest['sha256'].items())
result={'status':'PASS','meaning':'Archived observations and stated counterexamples are internally consistent; this is not a defect-free candidate verdict.','rendererNeighborCases':8,'arrayNeighborCases':7,'sharedPriorCases':50,'sharedNewLogicalCases':6,'sharedQueryCases':18,'priorOriginalClosures':['RR9-01 original actual-config cases','RR9-02 original actual-config cases'],'confirmedFindings':['RR10-01 new false-positive regression','RR10-02 pre-existing source-loss gap'],'formalArchitectureTests':482,'activeBoundaries':31,'formalArchitectureDiagnostics':0,'reusedGateInputsMatched':1706}
(e/'probe-verification.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(result,ensure_ascii=False,indent=2))
