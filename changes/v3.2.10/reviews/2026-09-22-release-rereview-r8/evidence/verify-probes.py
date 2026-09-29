"""验证归档观察。PASS 不表示两项漏报已修复。"""
import json,re,hashlib
from pathlib import Path
e=Path(__file__).resolve().parent
load=lambda name:json.loads((e/name).read_text())
rows=lambda name:{x['name']:x for x in map(json.loads,(e/name).read_text().splitlines())}
before=rows('r8-renderer-probes-before.jsonl');current=rows('r8-renderer-probes-current.jsonl')
for name in ['original-default-missing-member','original-default-undefined-member','original-default-missing-parameter']:
 assert not before[name]['violations']
 assert len(current[name]['violations'])==1 and current[name]['violations'][0]['rule']=='ARCH-RENDERER-SCOPE'
 assert current[name]['runtime']['same'] and current[name]['runtime']['extraResult']
assert not current['original-default-provided-other']['violations'] and not current['original-default-provided-other']['runtime']['same']
for version in [before,current]:
 assert not version['ipc-missing-field']['violations'] and version['ipc-missing-field']['runtime']['extraResult'] and version['ipc-missing-field']['runtime']['ipcReads']==1
 assert not version['ipc-provided-field']['violations'] and not version['ipc-provided-field']['runtime']['same']
for name in ['previous-parameter-shared','default-container-after']: assert len(current[name]['violations'])==1 and current[name]['runtime']['extraResult']
for name in ['previous-parameter-other','default-container-before']: assert not current[name]['violations'] and not current[name]['runtime']['same']
real=load('r8-renderer-ipc-realconfig.json');original=load('r8-renderer-original-realconfig.json')
assert len(real)==len(original)==2
assert all(x['boundaryCount']==20 and x['baseViolations']==0 for x in real+original)
assert all(not x['probeViolations'] and x['runtime']['ipcReads']==1 for x in real)
assert real[0]['runtime']['same'] and real[0]['runtime']['extraResult'] and real[0]['runtime']['apiKeys']==['run','outsideScope']
assert not real[1]['runtime']['same'] and real[1]['runtime']['apiKeys']==['run']
assert len(original[0]['probeViolations'])==1 and original[0]['probeViolations'][0]['rule']=='ARCH-RENDERER-SCOPE' and not original[1]['probeViolations']
assert len(load('r8-renderer-before-inputs.json')['files'])==5 and all(x['match'] for x in load('r8-renderer-before-inputs.json')['files'].values())
assert len(load('r8-renderer-current-inputs.json')['files'])==5 and all(x['match'] for x in load('r8-renderer-current-inputs.json')['files'].values())
a=load('r8-array-before-current.json');actual=load('r8-array-real-current.json')
assert len(a['hashes'])==7 and all(x['beforeMatchesR7Input'] and x['currentMatchesR8Input'] for x in a['hashes'])
assert actual['boundaryCount']==20 and all(x['state']=='active' for x in actual['boundaries']) and not actual['baseline']['violations']
expected={'array-replaced-element':0,'array-captured-before':0,'array-direct-fixed-slot':0,'object-fixed-slot-control':1,'array-without-replacement-control':1}
for group in [a['before'],a['current'],actual]:
 assert len(group['results'])==5
 for x in group['results']:
  assert len(x['violations'])==expected[x['name']]
  assert x['coverage']['parseErrors']==0
  if x['name']=='array-captured-before': assert not x['runtime']['same'] and x['runtime']['keys']==['run']
  else: assert x['runtime']['same'] and x['runtime']['extraResult']
shared=load('shared-archive-verification.json');assert shared['status']=='PASS' and shared['rendererCases']==26 and shared['queryCases']==18 and shared['actualInMemoryQueries']==10
for name,count in [('architecture-tests.log',386),('r8-renderer-targeted-tests.log',30)]:
 totals={k:int(v) for k,v in re.findall(r'(?m)^[#ℹ] (tests|pass|fail|skipped) (\d+)$',(e/name).read_text())}
 assert totals=={'tests':count,'pass':count,'fail':0,'skipped':0},(name,totals)
cli=load('architecture-check.json');assert len(cli['activeBoundaries'])==31 and not cli['violations'] and not cli['staleExceptions']
assert cli['coverage']['parsedFiles']==cli['coverage']['scannedFiles']==765 and cli['coverage']['parseErrors']==0
assert not cli['coverage']['pendingBoundaries'] and not cli['coverage']['partialBoundaries']
gate=load('gate-evidence-comparison.json');assert gate['headMatches'] and gate['gateInputCount']==1704 and not gate['changedGateInputs']
result={'status':'PASS','meaning':'证据支持本轮观察；两项既有漏报仍开放。','confirmedOpenFindings':['RR8-01','RR8-02'],'newlyIntroducedRegressionsConfirmed':0,'RR7OriginalThreeCounterexamplesClosed':True,'allDefaultSemanticsClosed':False,'rendererMinimalCases':10,'arrayMinimalCases':5,'sharedSmallFixtures':44,'actualRendererConfigBoundaryCount':20,'actualRendererFactoryProbed':'BankStatement','architecturePass':386,'RR7TargetedPassIncluded':30,'fullGateReusedInputCount':1704}
(e/'probe-verification.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');print(json.dumps(result,ensure_ascii=False,indent=2))
