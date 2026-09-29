import json
from pathlib import Path
counts={'renderer':0,'query':0};sql=0
for name in ['shared','destructure']:
 j=json.loads(Path('/tmp/r6-data-'+name+'-probes.json').read_text())
 assert all(x['same'] for x in j['policy'])
 assert all(x['match'] for x in j['beforeInputHashes'])
 for group in ['renderer','query']:
  for x in j[group]:
   counts[group]+=1
   for version in ['beforeR5','current']:
    assert (len(x[version])==0)==x['expectedClean'],(group,x['name'],version)
    assert x['scanner'][version]['repeatEqual'] and x['scanner'][version]['afterRulesEqual'],x['name']
   assert x['scanner']['beforeCurrentEqual'],x['name']
   assert x['scanner']['beforeR5']['siteEvidenceIds']==x['scanner']['current']['siteEvidenceIds'],x['name']
   assert [v['rule'] for v in x['beforeR5']]==[v['rule'] for v in x['current']],x['name']
   if group=='query':
    assert (len(x['sql'])==0)==x['expectedClean'],x['name']
    sql+=len(x['sql'])
isolation=json.loads(Path('/tmp/r6-data-descriptor-isolation.json').read_text())
assert isolation['status']=='PASS'
summary={'status':'PASS','beforeVersion':'R5 repair start: manifest-verified 5 checker files','rendererCases':counts['renderer'],'queryCases':counts['query'],'versionsPerCase':2,'actualInMemoryQueries':sql,'scannerJsonBeforeCurrentEqual':True,'repeatedScanJsonEqual':True,'scannerUnchangedAfterRules':True,'siteEvidenceIdsUnchanged':True,'descriptorIsolation':isolation,'policyFilesUnchanged':True,'scope':'small fixtures only; no full scan or source writes'}
Path('/tmp/r6-data-verification.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(summary,ensure_ascii=False,indent=2))
