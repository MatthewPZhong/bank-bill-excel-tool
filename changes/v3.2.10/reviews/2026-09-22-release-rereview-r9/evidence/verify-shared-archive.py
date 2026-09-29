import json
from pathlib import Path
counts={'renderer':0,'query':0};sql=0;changes=[]
expected_changed={'single-mount-category-explicit-ipc','whole-array-capability-write','awaited-ipc-capability-array-default','awaited-category-other-default-conservative'}
for name in ['shared-probes','destructure-probes','localenv-probes','default-combinations','async-array-combinations']:
 j=json.loads((Path(__file__).resolve().parent / ('r9-shared-'+name+'.json')).read_text())
 assert all(x['same'] for x in j['policy'])
 assert all(x['match'] for x in j['beforeInputHashes'])
 for group in ['renderer','query']:
  for x in j[group]:
   counts[group]+=1
   assert (len(x['current'])==0)==x['expectedClean'],(group,x['name'],'current')
   for version in ['beforeR8','current']:
    assert x['scanner'][version]['repeatEqual'] and x['scanner'][version]['afterRulesEqual'],x['name']
   assert x['scanner']['beforeCurrentEqual'],x['name']
   assert x['scanner']['beforeR8']['siteEvidenceIds']==x['scanner']['current']['siteEvidenceIds'],x['name']
   if x['name'] in expected_changed:
    assert len(x['beforeR8'])==0 and len(x['current'])==1,x['name']
    changes.append({'name':x['name'],'beforeViolations':0,'currentViolations':1})
   else: assert (len(x['beforeR8'])==0)==x['expectedClean'],(group,x['name'],'before')
   if group=='query':
    assert (len(x['sql'])==0)==x['expectedClean'],x['name'];sql+=len(x['sql'])
   if x['name']=='single-mount-category-explicit-ipc':
    r=x['runtime'];assert r['calledIpc']==['app:get-info','other'] and r['categoryWasThenable'] and r['category']['channel']=='other';assert x['historicalExpectedClean'] is True and x['expectedClean'] is False
   if name=='async-array-combinations':
    r=x['runtime']
    if x['name']=='whole-array-pure-write':assert r['initialInfo']==[{'name':'updated'}] and not r['initialContainsWholeApi']
    elif x['name']=='whole-array-capability-write':assert r['initialContainsWholeApi']
    elif x['name']=='awaited-ipc-pure-array-default':assert r['initialInfo']==[{'name':'bank'}] and r['calledIpc']==['app:get-info'] and not r['initialContainsWholeApi']
    elif x['name']=='awaited-ipc-capability-array-default':assert r['initialContainsWholeApi'] and r['calledIpc']==['app:get-info']
    else:assert r['calledIpc']==['app:get-info'] and r['category']=='business' and not r['categoryWasThenable']
assert len(changes)==4 and sum(counts.values())==50
summary={'status':'PASS','beforeVersion':'R8 repair start: renderer-contracts.js from before/ plus 4 unchanged current checker files; all 5 manifest-verified','reusedCases':44,'historicalExpectedCorrection':{'name':'single-mount-category-explicit-ipc','oldExpectedClean':True,'correctExpectedClean':False,'reason':'invoke returns Promise; member is undefined; other default actually runs'},'newArrayCases':4,'newAsyncControls':2,'rendererCases':counts['renderer'],'queryCases':counts['query'],'versionsPerCase':2,'changedOutcomes':changes,'actualInMemoryQueries':sql,'asyncContractReferences':['node_modules/electron/electron.d.ts:8847','src/preload.js:84','src/renderer.js:1642'],'knownConservativeRejection':'awaited-category-other-default-conservative: VM business data present, but no static field existence contract; both IPC and dangerous default remain candidates','scannerJsonBeforeCurrentEqual':True,'repeatedScanJsonEqual':True,'scannerUnchangedAfterRules':True,'siteEvidenceIdsUnchanged':True,'policyFilesUnchanged':True,'scope':'small fixtures and async VM only; no full scan, Electron launch, or source writes'}
(Path(__file__).resolve().parent / 'shared-archive-verification.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(summary,ensure_ascii=False,indent=2))
