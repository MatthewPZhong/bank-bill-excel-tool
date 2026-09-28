from pathlib import Path
import json
p=Path(__file__).resolve().parent
read=lambda name:json.loads((p/name).read_text())
summary={}
for group,files in [('array',['r15-array-original-before-current.json','r15-array-finite-before-current.json']),('order',['r15-order-before-current.json'])]:
 result=[]
 for name in files:
  d=read(name);assert d['sourceMismatches']==[] and d['sourceFileCount']==793
  for b,c in zip(d['before']['results'],d['current']['results']):
   assert not b.get('scanError') and not c.get('scanError')
   assert b['name']==c['name'] and b['source']==c['source'] and b['runtime']==c['runtime'] and b['violations']==c['violations']
   conservative=c['name']=='overwritten-before-reorder-safe'
   assert len(c['violations'])==(0 if c['safe'] and not conservative else 1)
   if group=='array':assert c['runtime']['same']==c['runtime']['extraCallable']==(not c['safe'])
   else:assert any(x['extraCallable'] for x in c['runtime'])==(not c['safe'])
   result.append({'name':c['name'],'safe':c['safe'],'conservative':conservative,'diagnostics':len(c['violations'])})
 summary[group]={'cases':len(result),'allowed':sum(x['diagnostics']==0 for x in result),'rejected':sum(x['diagnostics']>0 for x in result),'conservative':sum(x['conservative'] for x in result),'scanErrors':0,'diagnosticChanges':0,'rows':result}
assert summary['array']['cases']==14 and summary['array']['allowed']==6 and summary['array']['conservative']==1
assert summary['order']['cases']==8 and summary['order']['allowed']==5 and summary['order']['conservative']==0
out={'status':'PASS',**summary};(p/'r15-regression-verification.json').write_text(json.dumps(out,ensure_ascii=False,indent=2)+'\n');print(json.dumps(out,ensure_ascii=False,indent=2))
