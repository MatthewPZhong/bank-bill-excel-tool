"""重放审查原始探针，只在本轮证据目录和独立临时工具树写入。"""
from pathlib import Path
import hashlib,json,os,shutil,subprocess,tempfile
E=Path(__file__).resolve().parent
ROOT=E.parents[3]
REVIEW=ROOT/'changes/v3.2.10/reviews/2026-09-28-release-rereview-r14/evidence'
initial=json.loads((E/'input-manifest.json').read_text())['sha256']
commands=[]
def run(script, output, args=(), env=None):
    command=['node',str(REVIEW/script),*map(str,args)]
    with (E/output).open('w') as out,(E/(output+'.stderr')).open('w') as err:
        result=subprocess.run(command,cwd=ROOT,env={**os.environ,**(env or {})},stdout=out,stderr=err)
    commands.append({'command':command,'cwd':str(ROOT),'output':output,'exitCode':result.returncode})
    assert result.returncode==0,output
    return [json.loads(line) for line in (E/output).read_text().splitlines()] if output.endswith('.jsonl') else json.loads((E/output).read_text())
with tempfile.TemporaryDirectory(prefix='g8-r14-probe-before-') as temp:
    sandbox=Path(temp)
    shutil.copytree(ROOT/'scripts/architecture',sandbox/'scripts/architecture')
    for file in (sandbox/'scripts/architecture').glob('*.js'):
        name=file.relative_to(sandbox).as_posix(); backup=E/'before'/name
        if backup.exists(): shutil.copyfile(backup,file)
        assert hashlib.sha256(file.read_bytes()).hexdigest()==initial[name],name
    os.symlink(ROOT/'node_modules',sandbox/'node_modules')
    before=run('r14-renderer-probes.cjs','renderer-before.jsonl',env={'RENDERER_SCANNER_ROOT':str(sandbox)})
after=run('r14-renderer-probes.cjs','renderer-after.jsonl')
assert len(before)==len(after)==6
for now,old in zip(after,before):
    assert now['name']==old['name'] and now['source']==old['source'] and now['runtime']==old['runtime']
    assert not now['scanError'] and not old['scanError']
    assert bool(now['violations']) == (not now['safe']),now
assert [len(row['violations']) for row in before]==[0,0,0,0,0,1]
assert [len(row['violations']) for row in after]==[1,0,1,1,0,1]
vm=run('r14-renderer-branch-vm.cjs','renderer-vm.json',[E/'renderer-after.jsonl'])
assert len(vm)==12
order=run('r14-order-probe.cjs','order.json')
previous=json.loads((REVIEW/'r14-order-before-current.json').read_text())
for row in order['results']:
    assert not row.get('scanError') and bool(row['violations']) == (not row['safe']),row
assert len(order['results'])==8 and sum(row['safe'] for row in order['results'])==5
arrays=[]
for group in ['original','finite']:
    arrays += run(f'r14-array-{group}-probe.cjs',f'array-{group}.json')['results']
assert len(arrays)==14
for row in arrays:
    assert not row.get('scanError'),row
    assert bool(row['violations']) == (not row['safe'] or row['name']=='overwritten-before-reorder-safe'),row
    assert row['runtime']['extraCallable'] == (not row['safe']),row
bindings=run('r14-shared-bindings-probes.cjs','bindings-probe.json')
old=json.loads((REVIEW/'r14-shared-bindings-probes.json').read_text())
assert len(bindings['rows'])==6
for now,old in zip(bindings['rows'],old['rows']):
    assert now['current']==old['current'] and now['scanner']['current']==old['scanner']['current']
    assert now['runtime']==old['runtime'] and bool(now['current'])==now['unsafe']
summary={'status':'PASS','originalCases':6,'vmBranches':12,'ordering':{'cases':8,'safe':5,'unsafe':3},'rr12Arrays':{'cases':14,'safePass':6,'unsafeRejected':7,'knownConservative':['overwritten-before-reorder-safe']},'bindings':{'cases':6,'diagnosticAndScannerChanges':[]},'commands':commands}
(E/'probe-verification.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(summary,ensure_ascii=False))
