from pathlib import Path
import json,hashlib
E=Path(__file__).resolve().parent;ROOT=E.parents[3]
initial=json.loads((E/'input-manifest.json').read_text())['sha256']
review=json.loads((E.parent/'2026-09-22-release-rereview-r9/evidence/input-manifest.json').read_text())
assert review['head']==json.loads((E/'input-manifest.json').read_text())['head']
for name in ['src/renderer.js','src/preload.js','scripts/architecture/renderer-contracts.js','scripts/architecture/scan.js','scripts/architecture/contracts.js','scripts/architecture/rules.js','scripts/architecture/schema.js','architecture/boundaries.json','architecture/legacy-allowlist.json']:
 assert initial[name]==review['sha256'][name],name
checks={}
for name in ['scripts/architecture/scan.js','scripts/architecture/contracts.js','scripts/architecture/rules.js','scripts/architecture/schema.js','scripts/architecture/policy-history.js','architecture/boundaries.json','architecture/legacy-allowlist.json']:
 digest=hashlib.sha256((ROOT/name).read_bytes()).hexdigest();assert digest==initial[name],name;checks[name]=digest
logical=json.loads((E/'r9-renderer-logical-realconfig.json').read_text());assert len(logical)==2
for x in logical:
 assert x['boundaryCount']==20 and x['baseViolations']==0
 unsafe=x['name']=='logical-and-missing'
 assert len(x['probeViolations'])==(1 if unsafe else 0)
 assert x['runtime']['ipcReads']==1 and x['runtime']['extraCallable']==unsafe
 assert x['runtime']['same']==unsafe
arrays=json.loads((E/'r9-array-selected-real.json').read_text());assert arrays['boundaryCount']==20 and arrays['baseline']['violations']==[]
assert len(arrays['results'])==4
for x in arrays['results']:
 assert len(x['violations'])==(0 if x['safe'] else 1),x['name']
 assert x['runtime']['extraCallable']==(not x['safe']) and x['runtime']['same']==(not x['safe']),x['name']
 assert x['coverage']['parsedFiles']==x['coverage']['scannedFiles'] if 'scannedFiles' in x['coverage'] else True
shared=json.loads((E/'shared-archive-verification.json').read_text());assert shared['status']=='PASS'
summary={'result':'PASS','rendererBoundaries':20,'realAstCases':6,'baselineViolations':0,'priorReviewCheckersAndPolicyMatchRepairStart':True,'logicalCases':[{'name':x['name'],'violations':len(x['probeViolations']),'runtime':x['runtime']} for x in logical],'arrayCases':[{'name':x['name'],'violations':len(x['violations']),'runtime':x['runtime']} for x in arrays['results']],'shared':shared,'unchangedSharedCheckerAndPolicySha256':checks,'scope':'BankStatement examples appended to real Renderer AST with all 20 active Renderer configurations; not 20 separate factory executions'}
(E/'probe-verification.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n');print(json.dumps(summary,ensure_ascii=False,indent=2))
