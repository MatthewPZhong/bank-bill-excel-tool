import json
from pathlib import Path
counts={'renderer':0,'query':0};sql=0;improvements=[];unchanged=0;reclassified=[]
expected_improvements={'single-mount-category-explicit-ipc','single-mount-explicit-data-over-state'}
for name in ['shared-probes','destructure-probes','localenv-probes','default-combinations']:
 j=json.loads(Path('/tmp/r8-shared-'+name+'.json').read_text())
 assert all(x['same'] for x in j['policy'])
 assert all(x['match'] for x in j['beforeInputHashes'])
 for group in ['renderer','query']:
  for x in j[group]:
   counts[group]+=1
   assert (len(x['current'])==0)==x['expectedClean'],(group,x['name'],'current')
   for version in ['beforeR7','current']:
    assert x['scanner'][version]['repeatEqual'] and x['scanner'][version]['afterRulesEqual'],x['name']
   assert x['scanner']['beforeCurrentEqual'],x['name']
   assert x['scanner']['beforeR7']['siteEvidenceIds']==x['scanner']['current']['siteEvidenceIds'],x['name']
   if x['name'] in expected_improvements:
    assert len(x['beforeR7'])==1 and len(x['current'])==0,x['name']
    improvements.append({'name':x['name'],'beforeViolations':len(x['beforeR7']),'currentViolations':len(x['current'])})
   else:
    assert (len(x['beforeR7'])==0)==x['expectedClean'],(group,x['name'],'before')
    if x['name']=='distinct-call-api-over-scoped-default':
     assert [v['rule'] for v in x['beforeR7']]==['ARCH-RENDERER-SCOPE']
     assert [v['rule'] for v in x['current']]==['ARCH-STATIC-COVERAGE']
     reclassified.append({'name':x['name'],'beforeRule':'ARCH-RENDERER-SCOPE','currentRule':'ARCH-STATIC-COVERAGE','deniedInBoth':True})
    else:assert [v['rule'] for v in x['beforeR7']]==[v['rule'] for v in x['current']],x['name']
    unchanged+=1
   if group=='query':
    assert (len(x['sql'])==0)==x['expectedClean'],x['name'];sql+=len(x['sql'])
   if name=='default-combinations':
    runtime=x['runtime']
    if x['name']=='single-mount-category-data-default':assert runtime['category']=='business' and runtime['calledIpc']==[]
    elif x['name']=='single-mount-category-explicit-ipc':assert runtime['calledIpc']==['app:get-info'] and runtime['category']=='business'
    elif x['name']=='single-mount-explicit-data-over-state':assert runtime['initialInfo']=={'name':'bank'} and not runtime['initialNestedIsState']
    elif x['name']=='single-mount-default-state-denied':assert runtime['initialNestedIsState']
    elif x['name']=='distinct-call-scoped-over-api-default':assert not runtime['apiIsWhole'] and runtime['apiKeys']==['run']
    elif x['name']=='distinct-call-api-over-scoped-default':assert runtime['apiIsWhole']
assert len(improvements)==2 and sum(counts.values())==44
summary={'status':'PASS','beforeVersion':'R7 repair start: renderer-contracts.js from before/ plus 4 unchanged current checker files; all 5 manifest-verified','reusedCases':38,'newDefaultCombinationCases':6,'rendererCases':counts['renderer'],'queryCases':counts['query'],'versionsPerCase':2,'unchangedExpectedOutcomes':unchanged,'correctedFalsePositives':improvements,'denialReclassification':reclassified,'actualInMemoryQueries':sql,'newCombinationVmAssertions':'6/6 passed','scannerJsonBeforeCurrentEqual':True,'repeatedScanJsonEqual':True,'scannerUnchangedAfterRules':True,'siteEvidenceIdsUnchanged':True,'policyFilesUnchanged':True,'scope':'small fixtures only; no full scan or source writes'}
Path('/tmp/r8-shared-verification.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(summary,ensure_ascii=False,indent=2))
