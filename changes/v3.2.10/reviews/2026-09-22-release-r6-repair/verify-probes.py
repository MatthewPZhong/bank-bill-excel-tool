"""对原审查脚本的当前输出逐项断言，不以探针退出 0 代替修复结论。"""
from pathlib import Path
import hashlib,json
E=Path(__file__).resolve().parent
ROOT=E.parents[3]
def read(name): return json.loads((E/name).read_text())
renderer=read('renderer-realconfig.json')
assert len(renderer)==2
assert all(x['boundaryCount']==20 and x['baseViolations']==0 for x in renderer)
assert renderer[0]['runtime']['extraCallable'] and not renderer[1]['runtime']['extraCallable']
assert len(renderer[0]['probeViolations'])==1 and renderer[0]['probeViolations'][0]['rule']=='ARCH-RENDERER-SCOPE'
assert not renderer[1]['probeViolations']
neighbor=read('g1-neighbors.json')
assert neighbor['boundaryState']=='active' and len(neighbor['outputs'])==8
assert all((x['writes']==1)==bool(x['violations']) and x['parseErrors']==0 and x['unresolved']==0 for x in neighbor['outputs'])
for name,bad in [('g1-real-source.json',True),('g1-native-real-source.json',False),('g1-reduce-real-source.json',True)]:
 d=read(name);assert d['boundaryState']=='active' and d['coverage']['parsedFiles']==d['coverage']['scannedFiles']==765
 assert len(d['violations'])==int(bad),(name,d['violations'])
 if bad: assert d['violations'][0]['rule']=='ARCH-PUBLICATION-RECOVERY-ENTRY' and d['recoveryScopeReached']
 else: assert not d['callbackCall']['callbackTargets'] and not d['recoveryScopeReached']
shared=[]
for name in ['shared-data-query.json','shared-destructure.json']:
 d=read(name)
 for x in d['renderer']+d['query']:
  assert (len(x['current'])==0)==x['expectedClean'],x['name']
  assert (len(x['beforeR5'])==0)==x['expectedClean'],x['name']
  assert x['scanner']['beforeCurrentEqual']
  for k in ['beforeR5','current']: assert x['scanner'][k]['repeatEqual'] and x['scanner'][k]['afterRulesEqual']
  assert x['scanner']['beforeR5']['siteEvidenceIds']==x['scanner']['current']['siteEvidenceIds']
  shared.append(x['name'])
 assert all(x['same'] for x in d['policy'])
assert len(shared)==28
assert read('descriptor-isolation.json')['status']=='PASS'
inputs={p:hashlib.sha256((ROOT/p).read_bytes()).hexdigest() for p in [
 'scripts/architecture/scan.js','scripts/architecture/contracts.js','scripts/architecture/renderer-contracts.js',
 'scripts/architecture/rules.js','architecture/boundaries.json','architecture/legacy-allowlist.json']}
result={'result':'PASS','rendererBoundaries':20,'rendererCases':2,'g1NeighborCases':8,'g1ProductionSourceCases':3,
 'sharedCases':28,'descriptorIsolation':'PASS','checkerAndPolicySha256':inputs,
 'limits':'G1 生产源码副本只按实际 active G1 边界静态扫描；VM 仅执行恢复 stub，没有恢复 IO。共享 beforeR5 是历史 R5 修复起点，当前 R6 起点另由 run-baseline.py 验证。'}
(E/'probe-verification.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({k:v for k,v in result.items() if k!='checkerAndPolicySha256'},ensure_ascii=False,indent=2))
