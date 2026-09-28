import json
from pathlib import Path
counts={'renderer':0,'query':0};sql=0;improvements=[];unchanged=0
expected_improvements={'local-return-data','local-return-unreached-call','projected-return-unreached-call'}
for name in ['shared','destructure','localenv']:
 j=json.loads(Path('/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-r7-repair/r7-data-'+name+'-probes.json').read_text())
 assert all(x['same'] for x in j['policy'])
 assert all(x['match'] for x in j['beforeInputHashes'])
 for group in ['renderer','query']:
  for x in j[group]:
   counts[group]+=1
   assert (len(x['current'])==0)==x['expectedClean'],(group,x['name'],'current')
   for version in ['beforeR6','current']:
    assert x['scanner'][version]['repeatEqual'] and x['scanner'][version]['afterRulesEqual'],x['name']
   assert x['scanner']['beforeCurrentEqual'],x['name']
   assert x['scanner']['beforeR6']['siteEvidenceIds']==x['scanner']['current']['siteEvidenceIds'],x['name']
   if x['name'] in expected_improvements:
    assert len(x['beforeR6'])==1 and len(x['current'])==0,x['name']
    improvements.append({'name':x['name'],'beforeViolations':len(x['beforeR6']),'currentViolations':len(x['current'])})
   else:
    assert (len(x['beforeR6'])==0)==x['expectedClean'],(group,x['name'],'before')
    assert [v['rule'] for v in x['beforeR6']]==[v['rule'] for v in x['current']],x['name']
    unchanged+=1
   if group=='query':
    assert (len(x['sql'])==0)==x['expectedClean'],x['name']
    sql+=len(x['sql'])
assert len(improvements)==3
summary={'status':'PASS','beforeVersion':'R6 repair start: 2 modified checker files from before/ plus 3 unchanged current checker files; all 5 manifest-verified','rendererCases':counts['renderer'],'queryCases':counts['query'],'versionsPerCase':2,'unchangedExpectedOutcomes':unchanged,'correctedFalsePositives':improvements,'actualInMemoryQueries':sql,'scannerJsonBeforeCurrentEqual':True,'repeatedScanJsonEqual':True,'scannerUnchangedAfterRules':True,'siteEvidenceIdsUnchanged':True,'policyFilesUnchanged':True,'scope':'small fixtures only; no full scan or source writes'}
Path('/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-r7-repair/r7-data-verification.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(summary,ensure_ascii=False,indent=2))
