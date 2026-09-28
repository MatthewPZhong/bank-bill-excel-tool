import hashlib,json
from pathlib import Path
r=Path.cwd();e=Path(__file__).resolve().parent
read=lambda n:json.loads((e/n).read_text())
rows=lambda n:[json.loads(line) for line in (e/n).read_text().splitlines()]
frozen=read('input-manifest.json')['sha256'];old=json.loads((r/'changes/v3.2.10/reviews/2026-09-23-release-r12-repair/input-manifest.json').read_text())['sha256']
for side,manifest in [('before',old),('current',frozen)]:
 for name,v in read(f'r13-renderer-{side}-inputs.json')['files'].items():
  assert v['match'] and v['sha256']==v['expected']==manifest['scripts/architecture/'+name],(side,name)
comparison=read('r13-renderer-comparison-inputs.json');assert len(comparison['files'])==795
for name,h in comparison['files'].items():assert h==frozen[name]==hashlib.sha256((r/name).read_bytes()).hexdigest(),name
before=rows('r13-renderer-probes-before.jsonl');current=rows('r13-renderer-probes-current.jsonl')
assert len(before)==len(current)==4
assert [len(x['violations']) for x in before]==[1,1,1,1]
assert [len(x['violations']) for x in current]==[0,1,0,0]
for b,c in zip(before,current):
 assert b['name']==c['name'] and b['source']==c['source'] and b['runtime']==c['runtime']
 assert b['scanError'] is None and c['scanError'] is None
 assert c['runtime']['same']==c['runtime']['extraCallable']==(not c['safe'])
realbefore=read('r13-renderer-conditional-realconfig-before.json');realcurrent=read('r13-renderer-conditional-realconfig.json')
assert len(realbefore)==len(realcurrent)==2
assert [len(x['probeViolations']) for x in realbefore]==[1,1] and [len(x['probeViolations']) for x in realcurrent]==[0,0]
for b,c in zip(realbefore,realcurrent):
 assert b['source']==c['source'] and b['runtime']==c['runtime'] and b['name']==c['name']
 assert b['boundaryCount']==c['boundaryCount']==20 and b['baseViolations']==c['baseViolations']==0
 assert b['scanError'] is None and c['scanError'] is None
branches=read('r13-renderer-branch-vm.json');assert len(branches)==4
for item in branches:
 source=next(x['source'] for x in realcurrent if x['name']==item['name']); assert item['source']==source
 expected=item['name']=='conditional-call-skipped' and item['hasEnum'] is False
 assert item['same']==item['extraCallable']==expected and item['ipcReads']==1
 assert item['apiKeys']==(['run','outsideScope'] if expected else ['run'])
 if expected:assert item['extraResult'] is True
array=read('r13-array-verification.json');assert array['status']=='PASS' and array['fixtureCount']==14 and array['beforeScanErrors']==10 and array['currentScanErrors']==0 and array['conservativeRejections']==1
shared=read('r13-shared-verification.json');assert shared['status']=='PASS' and shared['totalFixtures']==62 and shared['scannerStableFixtures']==62 and shared['sharedDiagnosticChanges']==[]
arch=read('architecture-tests-result.json');assert arch['exitCode']==0 and arch['counts']['pass']==589 and arch['counts']['fail']==0
cli=read('architecture-check-result.json');assert cli['exitCode']==0 and cli['active']==31 and cli['violations']==cli['pending']==cli['partial']==cli['stale']==0
gate=read('gate-evidence-comparison.json');assert gate['headMatches'] and gate['inputSetMatches'] and gate['gateInputCount']==gate['currentGateInputCount']==1709 and gate['changedGateInputs']==[]
result={'evidenceAssertions':'PASS','reviewOutcome':'ONE_NEW_P2','findings':[{'id':'RR13-01','priority':2,'title':'条件 helper 的唯一调用点被视为必执行','beforeMinimal':1,'currentMinimal':0,'beforeActualRenderer':1,'currentActualRenderer':0,'runtimeConditionalFalse':'injected API has callable outsideScope','runtimeConditionalTrue':'injected API only run'}],'priorFindingClosure':{'id':'RR12-01','scope':'14 named existing array/helper fixtures','beforeScanErrors':10,'currentScanErrors':0,'unsafeRejected':7,'safeAllowed':6,'knownConservativeRejection':1},'rendererNeighborCases':4,'actualRendererRepresentativeCases':2,'actualRendererBoundaryCount':20,'branchVmRuns':4,'sharedAndBindingCases':62,'architecture':arch['counts'],'officialCli':cli,'fullGateRerun':False,'fullGateInputMatch':gate,'limitations':'PASS means archived evidence assertions hold, not that the current checker is defect-free or the release accepted.'}
(e/'verification.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({k:v for k,v in result.items() if k not in ['officialCli']},ensure_ascii=False,indent=2))
