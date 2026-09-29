import hashlib,json
from pathlib import Path
r=Path.cwd();e=Path(__file__).resolve().parent
read=lambda n:json.loads((e/n).read_text());rows=lambda n:[json.loads(x) for x in (e/n).read_text().splitlines()]
frozen=read('input-manifest.json')['sha256'];old=json.loads((r/'changes/v3.2.10/reviews/2026-09-28-release-r13-repair/input-manifest.json').read_text())['sha256']
for side,manifest in [('before',old),('current',frozen)]:
 for name,v in read(f'r14-renderer-{side}-inputs.json')['files'].items():assert v['match'] and v['sha256']==v['expected']==manifest['scripts/architecture/'+name],(side,name)
for name,h in read('r14-renderer-archive-manifest.json').items():assert hashlib.sha256((e/name).read_bytes()).hexdigest()==h['sha256'] and (e/name).stat().st_size==h['bytes'],name
comparison=read('r14-renderer-comparison-inputs.json');assert len(comparison['files'])==795
for name,h in comparison['files'].items():assert h==frozen[name]==hashlib.sha256((r/name).read_bytes()).hexdigest(),name
before=rows('r14-renderer-probes-before.jsonl');current=rows('r14-renderer-probes-current.jsonl');assert len(before)==len(current)==6
assert [len(x['violations']) for x in before]==[1]*6
assert [len(x['violations']) for x in current]==[0,0,0,0,0,1]
for b,c in zip(before,current):
 assert b['name']==c['name'] and b['source']==c['source'] and b['runtime']==c['runtime']
 assert b['scanError'] is None and c['scanError'] is None
realbefore=read('r14-renderer-do-realconfig-before.json');realcurrent=read('r14-renderer-do-realconfig-current.json');assert len(realbefore)==len(realcurrent)==2
assert [len(x['probeViolations']) for x in realbefore]==[1,1] and [len(x['probeViolations']) for x in realcurrent]==[0,0]
for b,c in zip(realbefore,realcurrent):
 assert b['source']==c['source'] and b['runtime']==c['runtime'] and b['name']==c['name']
 assert b['boundaryCount']==c['boundaryCount']==20 and b['baseViolations']==c['baseViolations']==0
 assert b['scanError'] is None and c['scanError'] is None
branches=read('r14-renderer-branch-vm.json');assert len(branches)==12
unsafe_do=['do-break-before-write','do-continue-before-write','do-break-skips-test']
for item in branches:
 assert item['source']==next(x['source'] for x in current if x['name']==item['name'])
 expected=item['hasEnum'] if item['name'] in unsafe_do else not item['hasEnum'] if item['name']=='while-zero-body' else False
 assert item['same']==item['extraCallable']==expected and item['ipcReads']==1
 assert item['apiKeys']==(['run','outsideScope'] if expected else ['run'])
 if expected:assert item['extraResult'] is True
orig=rows('r14-renderer-original-probes.jsonl');prior=r/'changes/v3.2.10/reviews/2026-09-28-release-rereview-r13/evidence';priororig=[json.loads(x) for x in (prior/'r13-renderer-probes-current.jsonl').read_text().splitlines()]
assert len(orig)==4 and [len(x['violations']) for x in orig]==[1,1,0,0]
for p,c in zip(priororig,orig):assert p['source']==c['source'] and c['scanError'] is None and p['runtime']==c['runtime']
realorig=read('r14-renderer-original-realconfig.json');assert [len(x['probeViolations']) for x in realorig]==[1,0]
for x in realorig:assert x['scanError'] is None and x['baseViolations']==0 and x['boundaryCount']==20
for x in read('r14-renderer-lint.json'):
 assert x['status']==0
 for output in x['output']:assert output['errorCount']==output['warningCount']==0
array_rows=[]
for group in ['original','finite']:
 d=read(f'r14-array-{group}-before-current.json');assert d['sourceMismatches']==[]
 for b,c in zip(d['before']['results'],d['current']['results']):
  assert not b.get('scanError') and not c.get('scanError') and b['source']==c['source'] and b['runtime']==c['runtime'] and b['violations']==c['violations']
  conservative=c['name']=='overwritten-before-reorder-safe';assert len(c['violations'])==(0 if c['safe'] and not conservative else 1)
  assert c['runtime']['same']==c['runtime']['extraCallable']==(not c['safe']);array_rows.append(c['name'])
assert len(array_rows)==14
order=read('r14-order-verification.json');assert order['status']=='PASS' and order['fixtureCount']==8 and order['currentAllowed']==5 and order['currentRejected']==3 and order['currentScanErrors']==order['beforeCurrentDifferenceCount']==0
shared=read('r14-shared-verification.json');assert shared['status']=='PASS' and shared['totalFixtures']==shared['scannerStableFixtures']==62 and shared['sharedDiagnosticChanges']==[]
arch=read('architecture-tests-result.json');assert arch['exitCode']==0 and arch['counts']['pass']==621 and arch['counts']['fail']==0
cli=read('architecture-check-result.json');assert cli['exitCode']==0 and cli['active']==31 and cli['violations']==cli['pending']==cli['partial']==cli['stale']==0
gate=read('gate-evidence-comparison.json');assert gate['headMatches'] and gate['inputSetMatches'] and gate['gateInputCount']==gate['currentGateInputCount']==1710 and gate['changedGateInputs']==[]
result={'evidenceAssertions':'PASS','reviewOutcome':'ONE_NEW_P2','findings':[{'id':'RR14-01','priority':2,'title':'do首轮不能证明其中写入及条件测试必执行','minimalReproductions':unsafe_do,'beforeDiagnostics':[1,1,1],'currentDiagnostics':[0,0,0],'actualMainCaseBefore':1,'actualMainCaseCurrent':0,'runtimeMainCaseTrue':'old retains callable outsideScope','runtimeMainCaseFalse':'old only has run'}],'priorFindingClosure':{'id':'RR13-01','originalCases':4,'originalActualConfigurationCases':2,'currentDiagnostics':[1,1,0,0],'actualDiagnostics':[1,0]},'neighborCases':6,'neighborBranchVmRuns':12,'actualRendererNewRepresentativeCases':2,'actualRendererBoundaryCount':20,'orderCases':8,'arrayRegressionCases':14,'sharedAndBindingCases':62,'architecture':arch['counts'],'officialCli':cli,'fullGateRerun':False,'fullGateInputMatch':gate,'limitations':'PASS means archived evidence assertions hold, not checker correctness or release acceptance.'}
(e/'verification.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');print(json.dumps({k:v for k,v in result.items() if k!='officialCli'},ensure_ascii=False,indent=2))
