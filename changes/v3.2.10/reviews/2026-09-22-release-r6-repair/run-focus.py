from pathlib import Path
import subprocess,time,json,hashlib
E=Path(__file__).resolve().parent
ROOT=E.parents[3]
PROBES=ROOT/'changes/v3.2.10/reviews/2026-09-22-release-rereview-r6/evidence'
inputs={str(p.relative_to(ROOT)):hashlib.sha256(p.read_bytes()).hexdigest() for p in (ROOT/'scripts/architecture').glob('*.js')}
steps=[
 ('architecture-cli',['node','scripts/check-architecture.js','--json',str(E/'architecture-check.json')],'architecture-cli.log'),
 ('renderer-realconfig',['node',str(PROBES/'r6-renderer-parameter-realconfig.cjs')],'renderer-realconfig.json'),
 ('g1-neighbors',['node',str(PROBES/'r6-g1-neighbor-probe.cjs')],'g1-neighbors.json'),
 ('g1-projection-source',['node',str(PROBES/'r6-g1-projection-real-source-probe.cjs')],'g1-real-source.json'),
 ('g1-native-source',['node',str(PROBES/'r6-g1-native-data-real-source-probe.cjs')],'g1-native-real-source.json'),
 ('g1-reduce-source',['node',str(PROBES/'r6-g1-preparing-real-source-probe.cjs')],'g1-reduce-real-source.json'),
 ('shared-data-query',['node',str(PROBES/'r6-data-shared-probes.cjs')],'shared-data-query.json'),
 ('shared-destructure',['node',str(PROBES/'r6-data-destructure-probes.cjs')],'shared-destructure.json'),
 ('descriptor-isolation',['node',str(PROBES/'r6-data-descriptor-isolation.cjs')],'descriptor-isolation.json'),
 ('probe-verification',['python3',str(E/'verify-probes.py')],'probe-verification.log'),
 ('architecture-tests',['node','--test','--test-reporter=tap','--test-concurrency=2',*[str(p.relative_to(ROOT)) for p in sorted((ROOT/'tests/unit/architecture').glob('*.test.js'))]],'architecture-tests.log'),
 ('tool-lint',['./node_modules/.bin/eslint','scripts/architecture/renderer-contracts.js','scripts/architecture/contracts.js','tests/unit/architecture/release-rereview-r6.test.js','--format','json'],'tool-lint.json')]
results=[]
for name,command,output in steps:
 start=time.monotonic()
 with (E/output).open('w') as out,(E/(name+'.stderr.log')).open('w') as err:r=subprocess.run(command,cwd=ROOT,stdout=out,stderr=err)
 item={'name':name,'exitCode':r.returncode,'seconds':time.monotonic()-start};results.append(item);print(json.dumps(item),flush=True)
 if r.returncode:raise SystemExit(r.returncode)
assert all(hashlib.sha256((ROOT/p).read_bytes()).hexdigest()==h for p,h in inputs.items())
(E/'focused-run.json').write_text(json.dumps({'result':'PASS','sha256':inputs,'steps':results},indent=2)+'\n')
