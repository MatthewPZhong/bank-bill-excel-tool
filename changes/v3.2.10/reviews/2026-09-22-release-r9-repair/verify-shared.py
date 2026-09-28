import json
from pathlib import Path
E=Path(__file__).resolve().parent
counts={'renderer':0,'query':0};sql=0
for name in ['shared-probes','destructure-probes','localenv-probes','default-combinations','async-array-combinations']:
 j=json.loads((E/('r9-shared-'+name+'.json')).read_text())
 assert all(x['same'] for x in j['policy'])
 assert all(x['match'] for x in j['beforeInputHashes'])
 for group in ['renderer','query']:
  for x in j[group]:
   counts[group]+=1
   for v in ['beforeR9','current']:
    assert (len(x[v])==0)==x['expectedClean'],(group,x['name'],v)
    assert x['scanner'][v]['repeatEqual'] and x['scanner'][v]['afterRulesEqual'],x['name']
   assert x['beforeR9']==x['current'],x['name']
   assert x['scanner']['beforeCurrentEqual'],x['name']
   assert x['scanner']['beforeR9']['siteEvidenceIds']==x['scanner']['current']['siteEvidenceIds'],x['name']
   if group=='query':
    assert (len(x['sql'])==0)==x['expectedClean'],x['name'];sql+=len(x['sql'])
   if x['name']=='single-mount-category-explicit-ipc':
    r=x['runtime'];assert r['calledIpc']==['app:get-info','other'] and r['categoryWasThenable'] and r['category']['channel']=='other'
    assert x['historicalExpectedClean'] is True and x['expectedClean'] is False
   if name=='async-array-combinations':
    r=x['runtime']
    if x['name']=='whole-array-pure-write':assert r['initialInfo']==[{'name':'updated'}] and not r['initialContainsWholeApi']
    elif x['name']=='whole-array-capability-write':assert r['initialContainsWholeApi']
    elif x['name']=='awaited-ipc-pure-array-default':assert r['initialInfo']==[{'name':'bank'}] and r['calledIpc']==['app:get-info'] and not r['initialContainsWholeApi']
    elif x['name']=='awaited-ipc-capability-array-default':assert r['initialContainsWholeApi'] and r['calledIpc']==['app:get-info']
    else:assert r['calledIpc']==['app:get-info'] and r['category']=='business' and not r['categoryWasThenable']
assert sum(counts.values())==50 and sql==10
summary={'status':'PASS','beforeVersion':'RR9 repair start; 5 checker files verified against input-manifest.json','rendererCases':counts['renderer'],'queryCases':counts['query'],'actualInMemoryQueries':sql,'beforeCurrentDiagnosticsEqual':True,'scannerJsonBeforeCurrentEqual':True,'repeatedScanJsonEqual':True,'scannerUnchangedAfterRules':True,'siteEvidenceIdsUnchanged':True,'policyFilesUnchanged':True,'historicalExpectedCorrectionPreserved':'single-mount-category-explicit-ipc: invoke returns Promise; missing await triggers other default','knownConservativeRejection':'awaited-category-other-default-conservative: IPC field presence is not proved','scope':'50 small fixtures, async VM and in-memory SQLite only'}
(E/'shared-archive-verification.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(summary,ensure_ascii=False,indent=2))
