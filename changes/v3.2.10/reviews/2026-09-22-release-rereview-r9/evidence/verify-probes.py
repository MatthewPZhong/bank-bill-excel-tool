"""只验证本轮归档事实，PASS 不表示漏报已修复。"""
import json,re
from pathlib import Path
e=Path(__file__).resolve().parent
load=lambda n:json.loads((e/n).read_text())
rows=lambda n:{x['name']:x for x in map(json.loads,(e/n).read_text().splitlines())}
before=rows('r9-renderer-probes-before.jsonl');current=rows('r9-renderer-probes-current.jsonl')
for group in [before,current]:
 assert len(group)==6
 assert not group['logical-and-missing']['violations'] and group['logical-and-missing']['runtime']['same'] and group['logical-and-missing']['runtime']['extraResult']
 assert not group['logical-and-provided-safe']['violations'] and not group['logical-and-provided-safe']['runtime']['same']
for n in ['logical-or-undefined','logical-nullish-undefined','forwarded-ipc-missing']:assert len(current[n]['violations'])==1 and current[n]['runtime']['extraResult']
assert not current['explicit-object-safe']['violations'] and not current['explicit-object-safe']['runtime']['same']
for n in ['r9-renderer-before-inputs.json','r9-renderer-current-inputs.json']:assert len(load(n)['files'])==5 and all(x['match'] for x in load(n)['files'].values())
real=load('r9-renderer-logical-realconfig.json');old=load('r9-renderer-original-realconfig.json')
assert len(real)==len(old)==2 and all(x['boundaryCount']==20 and x['baseViolations']==0 for x in real+old)
assert all(not x['probeViolations'] and x['runtime']['ipcReads']==1 for x in real)
assert real[0]['runtime']['same'] and real[0]['runtime']['extraResult'] and real[0]['runtime']['apiKeys']==['run','outsideScope']
assert not real[1]['runtime']['same'] and real[1]['runtime']['apiKeys']==['run']
assert all(len(x['probeViolations'])==1 for x in old) and old[0]['runtime']['same'] and not old[1]['runtime']['same']
original=load('r9-array-real-original.json');assert original['boundaryCount']==20 and not original['baseline']['violations'] and len(original['results'])==5
for x in original['results']:
 assert len(x['violations'])==(0 if x['name']=='array-captured-before' else 1)
 if x['name']=='array-captured-before':assert not x['runtime']['same']
 else:assert x['runtime']['same'] and x['runtime']['extraResult']
for name,count in [('r9-array-neighbor-before-current.json',8),('r9-array-selected-real-before-current.json',4)]:
 d=load(name);assert len(d['hashes'])==7 and all(x['beforeMatchesR8Input'] and x['currentMatchesR9Input'] for x in d['hashes'])
 for version in ['before','current']:
  group=d[version];assert len(group['results'])==count
  if count==4:assert group['boundaryCount']==20 and not group['baseline']['violations'] and group['baseline']['coverage']['parsedFiles']==765
  for x in group['results']:
   expected=0 if version=='before' or x['name'] in ['push-static-spread','splice-static-spread','spread-before-replace-safe'] else 1
   assert len(x['violations'])==expected,(name,version,x['name'])
   assert x['coverage']['parseErrors']==0
   if x['name']=='spread-before-replace-safe':assert not x['runtime']['same'] and x['runtime']['keys']==['run']
   else:assert x['runtime']['same'] and x['runtime']['extraResult']
shared=load('shared-archive-verification.json');assert shared['status']=='PASS' and shared['rendererCases']==32 and shared['queryCases']==18 and shared['actualInMemoryQueries']==10
for n,count in [('architecture-tests.log',432),('r9-renderer-targeted-tests.log',13)]:
 totals={k:int(v) for k,v in re.findall(r'(?m)^[#ℹ] (tests|pass|fail|skipped) (\d+)$',(e/n).read_text())};assert totals=={'tests':count,'pass':count,'fail':0,'skipped':0},(n,totals)
cli=load('architecture-check.json');assert len(cli['activeBoundaries'])==31 and not cli['violations'] and not cli['staleExceptions']
assert cli['coverage']['parsedFiles']==cli['coverage']['scannedFiles']==765 and cli['coverage']['parseErrors']==0 and not cli['coverage']['pendingBoundaries'] and not cli['coverage']['partialBoundaries']
gate=load('gate-evidence-comparison.json');assert gate['headMatches'] and gate['gateInputCount']==1705 and not gate['changedGateInputs']
out={'status':'PASS','meaning':'归档支持两项既有剩余漏报与原始反例关闭；并非检查器全部通过。','confirmedOpenFindings':['RR9-01','RR9-02'],'newlyIntroducedRegressionsConfirmed':0,'priorOriginalCounterexamplesClosed':['RR8-01','RR8-02'],'allDefaultOrArraySemanticsClosed':False,'rendererNeighbors':6,'arrayNeighbors':8,'arrayOriginalCases':5,'sharedCases':50,'actualRendererBoundaryCount':20,'actualFactoryProbed':'BankStatement','architecturePass':432,'RR8IpcTargetedPassIncluded':13,'fullGateReusedInputCount':1705,'priorSharedSafeAssumptionCorrected':'single-mount-category-explicit-ipc uses a Promise without await and triggers other default'}
(e/'probe-verification.json').write_text(json.dumps(out,ensure_ascii=False,indent=2)+'\n');print(json.dumps(out,ensure_ascii=False,indent=2))
