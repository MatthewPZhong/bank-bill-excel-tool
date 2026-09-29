"""核对最终门禁、修复增量与工作区保护，再生成可交付证据。"""
from pathlib import Path
import datetime,difflib,hashlib,json,re,subprocess
E=Path(__file__).resolve().parent;ROOT=E.parents[3];PRIMARY=ROOT.parents[2]
def read(n):return json.loads((E/n).read_text())
def save(n,v):(E/n).write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n')
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def git(r,*args):return subprocess.check_output(['git',*args],cwd=r,text=True).strip()
def verify(r,items):return {'files':len(items),'changed':[n for n,h in items.items() if not (r/n).is_file() or sha(r/n)!=h]}
def summary(n,prefix):
 s=(E/n).read_text();return {k:int(re.search(r'^'+re.escape(prefix)+k+r' (\d+)$',s,re.M)[1]) for k in ['tests','suites','pass','fail','cancelled','skipped','todo']}
gate=read('release-check-result.json');assert gate['exitCode']==0 and not gate['changedInputs'] and gate['head']==gate['headAfter']
unit=summary('release-check.log','ℹ ');assert unit['pass']==9256 and unit['fail']==unit['cancelled']==0 and unit['skipped']==4
archtests=summary('architecture-tests.log','# ');assert archtests['pass']==482 and archtests['fail']==archtests['skipped']==0
current=summary('regressions-current.log','# ');assert current['tests']==current['pass']==50
before=summary('regressions-before-final.log','# ');assert before['tests']==50 and before['fail']==27 and before['pass']==23
test_name='tests/unit/architecture/release-rereview-r9.test.js';assert read('regressions-before-inputs.json')['testSha256']==sha(ROOT/test_name)
arch=read('architecture-check.json');assert len(arch['activeBoundaries'])==31 and not arch['violations'] and not arch['staleExceptions']
assert not arch['coverage']['pendingBoundaries'] and not arch['coverage']['partialBoundaries']
probes=read('probe-verification.json');assert probes['result']=='PASS' and read('shared-archive-verification.json')['status']=='PASS'
assert not verify(ROOT,probes['unchangedSharedCheckerAndPolicySha256'])['changed']
lint=read('tool-lint.json');assert len(lint)==2 and all(x['errorCount']==x['warningCount']==0 for x in lint)
log=(E/'release-check.log').read_text();skips=re.findall(r'^﹣.*$',log,re.M);assert len(skips)==4 and all('Windows' in s for s in skips)
integration=[]
for match in re.finditer(r'^\[integration\] ▶ (.*?) \.\.\. PASS (?:(\d+)/(\d+)|\(no count\)) \((\d+)ms\)$',log,re.M):
 n,p,t,d=match.groups();integration.append({'name':n,'passed':int(p) if p else None,'total':int(t) if t else None,'durationMs':int(d)})
assert len(integration)==68 and '全部 68 个集成脚本通过' in log and all(x['passed']==x['total'] for x in integration)
assert next(x for x in integration if x['name']=='renderer-lifecycle')['passed']==233
period=f"{datetime.datetime.fromisoformat(gate['startedAt']):%Y-%m-%d %H:%M:%S}–{datetime.datetime.fromisoformat(gate['finishedAt']):%H:%M:%S}（Asia/Shanghai）"
result_text='9256 项单测通过、0 失败、4 项 Windows 条件跳过，68/68 集成脚本通过'
p=ROOT/'changes/v3.2.10/README.md';s=p.read_text().replace('第九轮修复最终门禁验证中','第九轮修复完整门禁 PASS').replace('最终完整门禁验证中。修复未提交','架构 482/482 PASS，完整门禁重跑 PASS（9256 项单测通过、4 项 Windows 条件跳过、68/68 集成脚本通过）。修复未提交');p.write_text(s)
p=ROOT/'changes/v3.2.10/release.md';s=p.read_text().replace('最终完整门禁验证中，所有修复未提交','完整门禁已在 1706 个冻结输入上重跑 PASS，所有修复未提交')
section=f'''## 2026-09-22 第九轮独立审查修复（未提交）

RR9-01/02 已修复 AND 短路产生 undefined 的默认来源，以及数组 mutator 静态 spread 的插入来源。保留确定真值、旧别名和独立实例安全对照；Preload 对象的真值证明不扩大完整 API 的注入权限。新增 50 项回归，起点 27 FAIL / 23 PASS，修复后全部通过。

| 验证 | 本轮候选结果 |
| --- | --- |
| 完整门禁 | `{gate['command']}`：PASS，{period}；沙箱外隔离测试环境 |
| 架构专项 / CLI | 482/482 PASS；31 active、0 pending/partial、0 诊断、0 stale |
| 全量单测 | 9256 PASS、0 FAIL、4 项 Windows 条件跳过 |
| 全量集成 | 68/68 脚本 PASS；Renderer lifecycle 233/233 |
| 实际配置 / 共享探针 | 20 个 Renderer 边界下 6 个原始及对照场景符合预期；50 项共享正反例保持 |
| 输入 | 1706 个门禁输入及 HEAD 未漂移 |

[修复报告](reviews/2026-09-22-release-r9-repair/repair.md)、[验证汇总](reviews/2026-09-22-release-r9-repair/verification.json)、[增量补丁](reviews/2026-09-22-release-r9-repair/incremental.patch)。只修正 Renderer 检查器，生产业务、共享 scanner、机器配置和历史材料保持。本轮为修复自检，不扩展为任意动态语义或全部 G8 合同已闭环；未执行修复后独立复审、产品/平台人工验收或发布。

'''
marker='## 2026-09-22 第八轮独立审查修复（未提交）'
if '## 2026-09-22 第九轮独立审查修复（未提交）' not in s:
 assert marker in s;s=s.replace(marker,section+marker)
p.write_text(s)
p=ROOT/'changes/v3.2.10/codex/v3.2.10-architecture-guardrails/implementation-notes.md';s=p.read_text().replace('最终验证见 [本轮修复报告]','架构 482/482 PASS，实际配置 6 例与共享 50 例通过，完整门禁重跑 PASS：'+result_text+'。1706 个输入及 HEAD 未漂移。证据见 [本轮修复报告]');p.write_text(s)
p=E/'implementation-notes.md';p.write_text(p.read_text().replace('最终架构、实际配置、共享解析及完整门禁见 repair.md。','最终架构 482/482 PASS；正式 CLI 31 active/0 诊断/0 stale；实际配置 6 例、共享 50 例符合预期。完整门禁 '+period+' PASS：'+result_text+'。详见 repair.md。'))
initial=read('input-manifest.json');hashes=initial['sha256'];allowed={p.relative_to(E/'before').as_posix() for p in (E/'before').rglob('*') if p.is_file()}
preservation={'initial':verify(ROOT,hashes),'production':verify(ROOT,{n:h for n,h in hashes.items() if n.startswith('src/')}),'historicalReviews':verify(ROOT,{n:h for n,h in hashes.items() if n.startswith('changes/v3.2.10/reviews/')}),'architectureConfig':verify(ROOT,{n:h for n,h in hashes.items() if n.startswith('architecture/') and n.endswith('.json')}),'primaryDirty':verify(PRIMARY,initial['primaryDirty']),'primaryHead':git(PRIMARY,'rev-parse','HEAD'),'releaseHead':git(ROOT,'rev-parse','HEAD')}
preservation['unexpectedChanges']=sorted(set(preservation['initial']['changed'])-allowed);assert not preservation['unexpectedChanges']
assert all(not preservation[k]['changed'] for k in ['production','historicalReviews','architectureConfig','primaryDirty'])
assert preservation['releaseHead']==initial['head']==gate['head'] and preservation['primaryHead']==initial['primaryHead']
save('preservation-final.json',preservation)
manifest=read('gate-input-manifest.json');assert len(manifest['sha256'])==1706 and not verify(ROOT,manifest['sha256'])['changed']
paths=subprocess.check_output(['git','ls-files','--cached','--others','--exclude-standard','-z','--','src','scripts','tests','architecture','index.html','package.json','package-lock.json','eslint.config.*','.github/workflows'],cwd=ROOT).decode().split('\0')
assert set(manifest['sha256'])=={p for p in paths if p and (ROOT/p).is_file()}
results={'result':'PASS','scope':'RR9-01/02 original cases and listed adjacent combinations; not all dynamic JavaScript or release readiness','executionContext':'outside filesystem sandbox','gate':gate,'unit':unit,'architectureTests':archtests,'architecture':{'active':31,'diagnostics':0,'stale':0,'parsedFiles':arch['coverage']['parsedFiles'],'scannedFiles':arch['coverage']['scannedFiles']},'newRegressions':current,'regressionsBefore':before,'windowsSkips':skips,'integration':{'scripts':len(integration),'countedPassed':sum(x['passed'] or 0 for x in integration),'countedTotal':sum(x['total'] or 0 for x in integration),'withoutCount':[x['name'] for x in integration if x['total'] is None],'results':integration},'probes':probes,'preservation':preservation}
save('verification.json',results)
report=f'''# release/v3.2.10 第九轮审查修复

**RR9-01、RR9-02 已修复，最终完整 release-check 重新执行并通过。** 原始 AND 默认对象越权、push/splice 静态 spread 越权均被拒绝，真值及旧别名安全例继续通过。关闭范围为本报告列明反例与自动验证，不等于所有 G8 合同或正式发布验收完成。

## 候选与改动

工作区 `{ROOT}`，分支 `release/v3.2.10`，HEAD `{gate['head']}` 加已有未提交修复。依据：[第九轮审查](../2026-09-22-release-rereview-r9/review.md)、[G8 Spec](../../codex/v3.2.10-architecture-guardrails/spec.md) G8-AC-05、[TechDoc](../../codex/v3.2.10-architecture-guardrails/techdoc.md) §4.4。冻结 {len(hashes)} 个既有文件，[输入清单](input-manifest.json)与[原 tracked 差异](input-diff.patch)保留起点。

本轮修改 [renderer-contracts.js](../../../../scripts/architecture/renderer-contracts.js)，新增 [50 项回归](../../../../tests/unit/architecture/release-rereview-r9.test.js)，同步架构说明、TechDoc、实施记录及 release 状态；集成策略计数由完整门禁刷新。生产 src、共享 scanner/contracts/rules/schema、机器边界及例外 JSON、旧审查材料保持。没有提交、推送、合并、PR、升版、标签或发布。

## 修复行为

1. **RR9-01：保留 AND 返回来源。** 确定假值返回左侧，确定真值返回右侧，未知 IPC 字段保留两个来源。后续默认参数可以继续取得 shared 身份，别名越权写入不再消失。登记的 Preload 对象能证明真实 Position 装配的 API 守卫为真；完整 API 本身仍禁止注入，没有增加授权白名单。
2. **RR9-02：按 spread 展开时点保留插入来源。** 字面量/具名/工厂返回数组、嵌套 spread、固定槽位替换、可见扩容及源数组已有 mutator 写入纳入来源候选。初始空数组也检查后续插入对象。未知结果保留不确定性及可见来源，不假装精确模拟所有 mutator 索引；替换前捕获的旧对象与独立实例继续分离。

## 原始反例与安全对照

保留真实 Renderer AST、全部 **20 个 active Renderer boundary**，基线 **0 诊断**。具体向 BankStatement 增加装配，不表示逐一执行全部 20 个工厂。

| 场景 | 修复起点 | 修复后 | VM |
| --- | --- | --- | --- |
| IPC 缺失字段经 AND 触发 shared 默认值 | 0 诊断 | 1 条诊断 | shared 含可调用 outsideScope |
| true AND 显式另一个对象 | 0 诊断 | 0 诊断 | shared 没有额外方法 |
| push 静态 spread 插入对象 | 0 诊断 | 1 条诊断 | current API 含额外方法 |
| splice 静态 spread 插入对象 | 0 诊断 | 1 条诊断 | current API 含额外方法 |
| 直接 push 的违规对照 | 1 条诊断 | 1 条诊断 | current API 含额外方法 |
| spread 复制后替换源槽位的安全对照 | 0 诊断 | 0 诊断 | current API 保持独立 |

修复起点的原配置结果来自只读 R9 审查归档；新增 50 项测试另用字节匹配的本轮起点检查器运行。[逻辑结果](r9-renderer-logical-realconfig.json)、[数组结果](r9-array-selected-real.json)、[显式断言](verify-probes.py)、[探针汇总](probe-verification.json)。

## 最终验证

| 验证 | 结果与证据 |
| --- | --- |
| 新增回归 | **50/50 PASS**；起点 **27 FAIL / 23 PASS**。[before 哈希](regressions-before-inputs.json)、[before 日志](regressions-before-final.log)、[当前日志](regressions-current.log) |
| 全部架构测试 | **482/482 PASS**，包含新增 50 项。[日志](architecture-tests.log) |
| 正式架构 CLI | **31 active、0 pending/partial、0 诊断、0 stale**，{arch['coverage']['parsedFiles']}/{arch['coverage']['scannedFiles']} 文件解析。[JSON](architecture-check.json)、[日志](architecture-check.log) |
| 共享解析 | **50/50** 预期保持：32 Renderer、18 query，10 次内存 SQLite 查询；重复扫描、规则执行前后 scanner JSON 和 evidenceId 保持。[汇总](shared-archive-verification.json)、[断言](verify-shared.py) |
| 新增/修改 JS lint | **2 个文件 0 error / 0 warning**。[结果](tool-lint.json) |
| 完整门禁 | **PASS**；`{gate['command']}`；{period}，沙箱外隔离测试环境。[日志](release-check.log)、[结果](release-check-result.json) |
| 全量单测 | **{unit['pass']} PASS、0 FAIL、4 项 Windows 条件跳过**；{unit['tests']} total、{unit['suites']} suites。 |
| 全量集成 | **68/68 脚本 PASS**；有计数项 {results['integration']['countedPassed']}/{results['integration']['countedTotal']}，另 1 个脚本无计数；Renderer lifecycle 233/233。 |
| 候选一致性 | **1706 个门禁输入及 HEAD 未漂移**。[冻结清单](gate-input-manifest.json)、[验证汇总](verification.json) |

共享探针沿用 R9 对旧同步 invoke stub 的纠正：未 await 就读取 Promise 字段，会触发 other 默认频道；异步 VM 确认 app:get-info → other，当前拒绝正确。所有 beforeR9 指本轮修复起点，不混用 R8 修复前版本，历史文档保持原样。

初版全量检查曾发现 Position API 守卫的误报，已使用 Preload 对象证据修正；[初版失败日志](preliminary-architecture-tests.log)保留，最终验证均在修正后完成。初版未完成的正式 CLI 主动停止，其日志不作为 PASS 证据。完整门禁只在最终冻结候选上执行一次。

## 保守范围与工作区保护

`select(info.api && {{}})` 的对象实参组合在修复前后均因未知 helper 逃逸保守拒绝，已单独保留测试。未声明形状的 IPC 字段仍不能证明非 undefined；mutator 结果位置、动态长度、未知 helper/反射、跨文件对象时序不属于本轮精确解释承诺。[实施记录](implementation-notes.md)记载取证和决定。没有把这些有限验证扩展为默认值、数组语义或 G8 全部合同闭环。

{len(hashes)} 个既有文件仅 {len(preservation['initial']['changed'])} 个计划内文件变化；**{preservation['production']['files']} 个生产源码、{preservation['historicalReviews']['files']} 个历史审查/修复文件、{preservation['architectureConfig']['files']} 份机器 JSON 和主工作区 {preservation['primaryDirty']['files']} 个 dirty 文件保持原字节**。HEAD 均未漂移。[保护核对](preservation-final.json)。

[本轮增量补丁](incremental.patch)相对于本轮起始 dirty 状态生成，反向应用只读预检、git diff --check 和文档链接检查通过。[交付核对](delivery-check.json)。

本轮为修复自检。修复后独立复审、真实产品 Main 全流程、Windows/安装包、Excel/WPS 和资金人工验收未执行；自动门禁通过不等于正式可发布。
'''
(E/'repair.md').write_text(report)
patch=[]
for old in sorted((E/'before').rglob('*')):
 if not old.is_file():continue
 n=old.relative_to(E/'before').as_posix();assert sha(old)==hashes[n]
 patch.extend(difflib.unified_diff(old.read_text().splitlines(True),(ROOT/n).read_text().splitlines(True),fromfile='a/'+n,tofile='b/'+n))
patch.extend(difflib.unified_diff([],(ROOT/test_name).read_text().splitlines(True),fromfile='/dev/null',tofile='b/'+test_name))
(E/'incremental.patch').write_text(''.join(patch))
subprocess.run(['git','apply','--reverse','--check',str(E/'incremental.patch')],cwd=ROOT,check=True)
subprocess.run(['git','diff','--check'],cwd=ROOT,check=True)
links=[s for s in re.findall(r'\]\(([^)]+)\)',report) if '://' not in s and not s.startswith('#')]
missing=[s for s in links if not(E/re.sub(r':\d+$','',s.split('#')[0])).exists() and s!='delivery-check.json'];assert not missing,missing
assert git(ROOT,'branch','--show-current')=='release/v3.2.10' and not verify(ROOT,manifest['sha256'])['changed']
save('delivery-check.json',{'result':'PASS','checkedAt':datetime.datetime.now().astimezone().isoformat(),'head':gate['head'],'branch':'release/v3.2.10','gateInputs':1706,'gitDiffCheck':'PASS','reversePatchCheck':'PASS','localLinks':len(links),'missingLinks':[],'executionContext':'outside filesystem sandbox'})
print(json.dumps({'result':'PASS','gate':gate,'unit':unit,'architecture':archtests,'integrationScripts':len(integration),'preservation':preservation},ensure_ascii=False,indent=2))
