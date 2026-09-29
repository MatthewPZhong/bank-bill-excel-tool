import hashlib, json, subprocess
from pathlib import Path
r=Path.cwd(); e=Path(__file__).resolve().parent
read=lambda n:json.loads((e/n).read_text())
rows=lambda n:[json.loads(x) for x in (e/n).read_text().splitlines()]
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
f=read('input-manifest.json'); assert str(r)==f['cwd']
assert subprocess.check_output(['git','rev-parse','HEAD'],cwd=r,text=True).strip()==f['head']
repair=r/'changes/v3.2.10/reviews/2026-09-28-release-r14-repair'
bf=json.loads((repair/'input-manifest.json').read_text())['sha256']
for side, manifest in [('before',bf),('current',f['sha256'])]:
    inputs=read('r15-renderer-'+side+'-inputs.json')['files']
    assert len(inputs)==5
    for name,item in inputs.items():
        rel='scripts/architecture/'+name
        p=repair/'before'/rel if side=='before' and name=='renderer-contracts.js' else r/rel
        assert sha(p)==item['sha256']==item['expected']==manifest[rel] and item['match']
for item in read('r15-renderer-archive-manifest.json')['files']:
    p=e/item['file']; assert sha(p)==item['sha256'] and p.stat().st_size==item['bytes'],str(p)
rv=read('r15-renderer-verification.json')
assert len(rv['scannerInputHashes'])==795
for rel,digest in rv['scannerInputHashes'].items(): assert sha(r/rel)==digest==f['sha256'][rel]
def pair(before,current,expected_before,expected_current,key):
    assert len(before)==len(current)==len(expected_before)==len(expected_current)
    assert [len(x[key]) for x in before]==expected_before
    assert [len(x[key]) for x in current]==expected_current
    for a,b in zip(before,current): assert a['source']==b['source'] and a['name']==b['name']
    for x in before+current: assert x['scanError'] is None
old=rows('r15-renderer-original-probes-before.jsonl'); now=rows('r15-renderer-original-probes.jsonl')
pair(old,now,[0,0,0,0,0,1],[1,0,1,1,0,1],'violations')
a=rows('r15-renderer-probes-before.jsonl'); b=rows('r15-renderer-probes-current.jsonl')
pair(a,b,[0]*6,[1,1,1,0,0,1],'violations')
actual_before=read('r15-renderer-forof-realconfig-before.json'); actual_current=read('r15-renderer-forof-realconfig-current.json')
pair(actual_before,actual_current,[0,0],[1,1],'probeViolations')
actual_original=read('r15-renderer-original-realconfig.json')
assert [len(x['probeViolations']) for x in actual_original]==[1,0]
for x in actual_before+actual_current+actual_original:
    assert x['baseViolations']==0 and x['boundaryCount']==20 and x['scanError'] is None
    unsafe='unsafe' in x['name'] or x['name']=='do-break-before-write'
    assert x['runtime']['same']==unsafe and x['runtime']['extraCallable']==unsafe
    assert x['runtime']['apiKeys']==(['run','outsideScope'] if unsafe else ['run'])
branches=read('r15-renderer-branch-vm.json'); assert len(branches)==12
for x in branches:
    match=next(y for y in b if y['name']==x['name']); assert match['source']==x['source']
    unsafe=x['name'] in ['nonempty-forof-label-break-unsafe','multiple-label-continue-unsafe'] and x['hasEnum']
    assert x['same']==unsafe and x['extraCallable']==unsafe and x['ipcReads']==1
    assert x['apiKeys']==(['run','outsideScope'] if unsafe else ['run'])
for x in b:
    br=[y for y in branches if y['name']==x['name']];assert {y['hasEnum'] for y in br}=={False,True}
reg=read('r15-regression-verification.json'); assert reg['status']=='PASS'
assert reg['array']['cases']==14 and reg['array']['conservative']==1 and reg['order']['cases']==8
assert all(reg[k]['scanErrors']==reg[k]['diagnosticChanges']==0 for k in ['array','order'])
flow=read('r15-flow-verification.json'); assert flow['status']=='PASS'
assert flow['fixtureCount']==8 and flow['currentAllowed']==flow['currentRejected']==4
assert flow['beforeScanErrors']==flow['currentScanErrors']==0 and flow['sourceMismatches']==[]
shared=read('r15-shared-verification.json'); assert shared['status']=='PASS'
assert shared['totalFixtures']==shared['scannerStableFixtures']==62 and shared['executedSqlFixtures']==10
assert shared['sharedDiagnosticChanges']==[] and shared['asyncIpcCorrectionPreserved']
for group in shared['groups'].values(): assert group['count']>0
suite=read('architecture-tests-result.json'); assert suite['exitCode']==0
assert suite['counts']['tests']==suite['counts']['pass']==655 and suite['counts']['fail']==suite['counts']['skipped']==0
cli=read('architecture-check-result.json'); assert cli['exitCode']==0 and cli['active']==31
assert all(cli[k]==0 for k in ['pending','partial','violations','stale'])
assert cli['coverage']['parsedFiles']==cli['coverage']['scannedFiles']==765 and cli['coverage']['parseErrors']==0
gate=read('gate-evidence-comparison.json'); audit=read('gate-log-audit.json'); reused=read('reused-gate-verification.json')
assert gate['headMatches'] and gate['inputSetMatches'] and gate['gateInputCount']==gate['currentGateInputCount']==1711 and gate['changedGateInputs']==[]
assert audit['gate']['exitCode']==0 and audit['gate']['changedInputs']==[]
assert audit['unitSummaryMatchesLog']=={'tests':9433,'pass':9429,'fail':0,'skipped':4}
assert audit['integrationScriptCount']==len(reused['integration'])==68
assert all(x['passed']==x['total'] for x in reused['integration'])
assert reused['unit']['pass']==9429 and reused['unit']['fail']==0 and reused['unit']['skipped']==4
result={'evidenceAssertions':'PASS','reviewOutcome':'NO_NEW_CONFIRMED_MANDATORY_FINDINGS','findings':[],
'observations':[{'id':'R15-O1','classification':'new conservative precision observation','safeEmptyForOfBreak':[0,1],'safeEmptyForOfContinue':[0,1],'unsafeNonemptyControl':[0,1],'reason':'Runtime-safe empty iterable cases are newly rejected; exact empty iterable cardinality is not explicitly promised in the bounded static contract.'}],
'head':f['head'],'frozenFiles':len(f['sha256']),'closure':{'id':'RR14-01','scope':'original six minimal cases and two current actual20 representatives; limited new finally/helper controls','originalBefore':[0,0,0,0,0,1],'originalCurrent':[1,0,1,1,0,1]},
'newRendererCases':{'total':6,'safeAccepted':2,'safeConservativelyRejected':2,'unsafeRejected':2,'vmRuns':12,'actual20Before':[0,0],'actual20Current':[1,1]},
'flowCases':8,'arrayCases':14,'orderCases':8,'sharedCases':62,'architectureTests':suite,'architectureCheck':cli,
'fullGate':{'rerunInR15':False,'exactInputCount':1711,'source':'R14 repair gate','unitPassed':9429,'unitFailed':0,'unitSkipped':4,'integrationScriptsPassed':68,'exitCode':0},
'limits':['No production source modification','No Electron GUI, Windows, Excel/WPS, packaging or real business manual acceptance','Assertion PASS includes explicit conservative rejections; not universal precision or release readiness']}
(e/'verification.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({k:v for k,v in result.items() if k not in ['architectureTests','architectureCheck']},ensure_ascii=False,indent=2))
