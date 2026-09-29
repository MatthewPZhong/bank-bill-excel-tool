from pathlib import Path
import hashlib,json
root=Path('/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10')
prefix=Path('/tmp')
def read(name):return json.loads((prefix/('r15-renderer-'+name)).read_text())
def lines(name):return [json.loads(l) for l in (prefix/('r15-renderer-'+name)).read_text().splitlines()]
old=lines('original-probes-before.jsonl');now=lines('original-probes.jsonl')
assert [len(x['violations']) for x in old]==[0,0,0,0,0,1]
assert [len(x['violations']) for x in now]==[1,0,1,1,0,1]
before=lines('probes-before.jsonl');current=lines('probes-current.jsonl')
assert [len(x['violations']) for x in before]==[0]*6
assert [len(x['violations']) for x in current]==[1,1,1,0,0,1]
actualBefore=read('forof-realconfig-before.json');actualCurrent=read('forof-realconfig-current.json');actualOriginal=read('original-realconfig.json')
assert [len(x['probeViolations']) for x in actualBefore]==[0,0]
assert [len(x['probeViolations']) for x in actualCurrent]==[1,1]
assert [len(x['probeViolations']) for x in actualOriginal]==[1,0]
for a,b in zip(old,now):assert a['source']==b['source']
for a,b in zip(before,current):assert a['source']==b['source']
for a,b in zip(actualBefore,actualCurrent):assert a['source']==b['source']
allscans=old+now+before+current+actualBefore+actualCurrent+actualOriginal
assert all(x['scanError'] is None for x in allscans)
assert all(x['boundaryCount']==20 and x['baseViolations']==0 for x in actualBefore+actualCurrent+actualOriginal)
branches=read('branch-vm.json');assert len(branches)==12
for x in branches:
 unsafe=x['name'] in ['nonempty-forof-label-break-unsafe','multiple-label-continue-unsafe'] and x['hasEnum']
 assert x['same']==unsafe and x['extraCallable']==unsafe
manifest=json.loads((root/'changes/v3.2.10/reviews/2026-09-28-release-rereview-r15/evidence/input-manifest.json').read_text())
inputs={}
for rel,expected in manifest['sha256'].items():
 if rel.startswith('src/') or rel in ['index.html','architecture/boundaries.json','architecture/legacy-allowlist.json']:
  digest=hashlib.sha256((root/rel).read_bytes()).hexdigest();assert digest==expected,rel;inputs[rel]=digest
beforeTools=read('before-inputs.json');currentTools=read('current-inputs.json')
assert all(x['match'] for x in beforeTools['files'].values())
assert all(x['match'] for x in currentTools['files'].values())
result={'cwd':str(root),'head':manifest['head'],'classification':'RR14 original cases closed; no additional high-confidence mandatory finding; new empty-for-of conservative precision observation', 'scanErrors':0,'originalMinimal':{'before':[len(x['violations']) for x in old],'current':[len(x['violations']) for x in now]},'originalActual20':{'counts':[len(x['probeViolations']) for x in actualOriginal],'baseline':0},'adjacentMinimal':{'before':[len(x['violations']) for x in before],'current':[len(x['violations']) for x in current],'safeAccepted':2,'safeConservativelyRejected':2,'unsafeRejected':2},'adjacentActual20':{'before':[0,0],'current':[1,1],'baseline':0,'boundaryCount':20},'vmBranchRuns':len(branches),'scannerInputsUnchangedFromR15Freeze':len(inputs),'scannerInputHashes':inputs,'beforeTools':beforeTools,'currentTools':currentTools,'notes':['All before/current case source strings are identical.','Original scripts were rerun unchanged from R14 evidence.','Two preliminary real-config result files used an unintended renamed run method and are not included in final counts; corrected scripts preserve allowed run field.']}
(prefix/'r15-renderer-verification.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({k:v for k,v in result.items() if k not in ['scannerInputHashes','beforeTools','currentTools']},ensure_ascii=False,indent=2))
