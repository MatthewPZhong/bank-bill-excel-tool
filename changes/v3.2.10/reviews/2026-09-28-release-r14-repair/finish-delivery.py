"""核对最终候选与完整门禁，生成 RR14 修复报告和接手状态增量补丁。"""
from pathlib import Path
import difflib,hashlib,json,re,subprocess
E=Path(__file__).resolve().parent
ROOT=E.parents[3]
SOURCE='scripts/architecture/renderer-contracts.js'
TEST='tests/unit/architecture/release-rereview-r14.test.js'
def read(name): return json.loads((E/name).read_text())
def save(name,value): (E/name).write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n')
def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def git(*args): return subprocess.check_output(['git',*args],cwd=ROOT,text=True).strip()
def differences(hashes): return [p for p,h in hashes.items() if not (ROOT/p).is_file() or sha(ROOT/p)!=h]
def counts(name):
    text=(E/name).read_text();out={}
    for key in ['tests','pass','fail','cancelled','skipped','todo']:
        values=re.findall(r'^(?:ℹ|#) '+key+r' (\d+)\s*$',text,re.M)
        assert len(values)==1,(name,key,values)
        out[key]=int(values[0])
    return out
def passed(value,n,skipped=0):
    assert value==dict(tests=n+skipped,**{'pass':n},fail=0,cancelled=0,skipped=skipped,todo=0),value
initial=read('input-manifest.json');hashes=initial['sha256']
assert len(hashes)==5190
assert initial['branch']==git('branch','--show-current')=='release/v3.2.10'
assert initial['head']==git('rev-parse','HEAD')=='9a38b96b1b8006c5851535d0c1e586bbaeb63f10'
allowed={p.relative_to(E/'before').as_posix() for p in (E/'before').rglob('*') if p.is_file()}
assert len(allowed)==7 and SOURCE in allowed
assert all(sha(E/'before'/p)==hashes[p] for p in allowed)
assert set(differences(hashes))==allowed
paths=subprocess.check_output(['git','ls-files','--cached','--others','--exclude-standard','-z'],cwd=ROOT).decode().split('\0')
new_paths={p for p in paths if p and (ROOT/p).is_file()}-hashes.keys()
assert all(p==TEST or p.startswith(E.relative_to(ROOT).as_posix()+'/') for p in new_paths),new_paths

gate=read('release-check-result.json');manifest=read('gate-input-manifest.json')
assert gate['exitCode']==0 and not gate['changedInputs'] and not gate.get('aborted'),gate
assert gate['head']==gate['headAfter']==initial['head'] and gate['cwd']==str(ROOT)
assert gate['command']=='UNIT_TEST_CONCURRENCY=2 npm run release-check'
assert len(manifest['sha256'])==gate['inputFiles']==1711
assert manifest['head']==initial['head'] and not differences(manifest['sha256'])
preflight=read('preflight-verification.json')
assert preflight['sourceSha256']==sha(ROOT/SOURCE) and preflight['testSha256']==sha(ROOT/TEST)
assert preflight['newRegressionTests']==34
before=counts('regressions-before-final.log');arch=counts('architecture-tests-final.log');unit=counts('release-check.log')
assert before==dict(tests=34,**{'pass':19},fail=15,cancelled=0,skipped=0,todo=0)
assert read('regressions-before-inputs.json')['testSha256']==sha(ROOT/TEST)
passed(arch,655);passed(unit,9429,4)
assert len(re.findall(r'^ok \d+ - RR14-01 ',(E/'architecture-tests-final.log').read_text(),re.M))==34
lint=read('tool-lint.json')
assert {x['filePath'] for x in lint}=={str(ROOT/SOURCE),str(ROOT/TEST)}
assert all(x['errorCount']==x['warningCount']==x['fatalErrorCount']==0 for x in lint)
actual=read('do-realconfig.json')
assert [(r['name'],len(r['probeViolations'])) for r in actual]==[('do-break-before-write',1),('do-write-before-break-safe',0)]
assert all(not r['scanError'] and r['boundaryCount']==20 and not r['baseViolations'] for r in actual)
assert actual[0]['runtime']['extraCallable'] and not actual[1]['runtime']['extraCallable']
probes=read('probe-verification.json');shared=read('shared-verification.json')
assert probes['status']=='PASS' and shared['status']=='PASS' and shared['fixtures']==56
assert not shared['diagnosticChanges'] and not shared['scannerChanges']
assert probes['originalCases']==6 and probes['vmBranches']==12 and probes['bindings']['cases']==6
log=(E/'release-check.log').read_text()
cli=log.split('> node scripts/check-architecture.js\n',1)[1].split('> bank-bill-excel-tool@',1)[0]
assert '架构检查：通过；' in cli and 'active 31；pending 0；partial 0。' in cli
assert '[ARCH-' not in cli and '过期例外：' not in cli
(E/'architecture-check.log').write_text(cli)
architecture={'source':'release-check.log / check:architecture','active':31,'pending':0,'partial':0,'violations':0,'stale':0}
save('architecture-check-summary.json',architecture)
skips=re.findall(r'^﹣.*$',log,re.M)
assert len(skips)==4 and all('Windows' in line for line in skips)
integration=[]
for match in re.finditer(r'^\[integration\] ▶ (.*?) \.\.\. PASS (?:(\d+)/(\d+)|\(no count\)) \((\d+)ms\)$',log,re.M):
    name,ok,total,duration=match.groups()
    integration.append({'name':name,'passed':int(ok) if ok else None,'total':int(total) if total else None,'durationMs':int(duration)})
assert len(integration)==68 and '全部 68 个集成脚本通过' in log
assert all(x['passed']==x['total'] for x in integration)
assert next(x for x in integration if x['name']=='renderer-lifecycle')['passed']==233
result_line='9429 项单测通过、0 失败、4 项 Windows 条件跳过，68/68 集成脚本通过'
p=ROOT/'changes/v3.2.10/README.md'
p.write_text('\n'.join(f'| 交付状态 | 第十四轮 RR14-01 跳过写入漏报已修复，新增 34 项回归、架构 655/655 PASS；完整门禁重跑 PASS（{result_line}）。修复未提交，真实产品/平台验收未执行。见 [第十四轮修复报告](reviews/2026-09-28-release-r14-repair/repair.md) |' if line.startswith('| 交付状态 |') else line for line in p.read_text().splitlines())+'\n')
p=ROOT/'changes/v3.2.10/release.md';content=p.read_text()
content=content.replace('最终候选完整门禁待运行。所有修复未提交','完整门禁在 1711 个冻结输入上重跑 PASS。所有修复未提交')
marker='## 2026-09-28 第十三轮独立审查修复（未提交）'
section=f'''## 2026-09-28 第十四轮独立审查修复（未提交）

RR14-01：区分进入 do 首轮与到达具体写入。按 break/continue 的目标和执行顺序保留可能跳过写入时的旧来源，沿 helper 调用点传播；写入前后、body/test、内层跳转、label、finally 和共同读取路径都有安全对照。

新增 34 项 VM/静态回归，准确修复起点 15 FAIL / 19 PASS，最终全部通过；架构 655/655 PASS，正式 CLI 31 active、0 pending/partial、0 诊断、0 stale。实际 20 个 Renderer 边界原反例产生 scope 诊断，安全对照零诊断。原始 6 例/12 次 VM、覆盖顺序 8 例、RR12 数组 14 例和共享/绑定 62 例保持预期，已有保守拒绝单列。

`{gate['command']}` 重跑 PASS：{result_line}。1711 个输入及 HEAD 未漂移；开始 {gate['startedAt']}，结束 {gate['finishedAt']}。

[修复报告](reviews/2026-09-28-release-r14-repair/repair.md)、[验证汇总](reviews/2026-09-28-release-r14-repair/verification.json)、[增量补丁](reviews/2026-09-28-release-r14-repair/incremental.patch)。生产业务源码保持，未提交、推送或发布；没有进行平台及真实业务人工验收。

'''
assert marker in content and '## 2026-09-28 第十四轮独立审查修复' not in content
p.write_text(content.replace(marker,section+marker,1))
p=ROOT/'changes/v3.2.10/codex/v3.2.10-architecture-guardrails/implementation-notes.md'
p.write_text(p.read_text().replace('完整门禁待本轮冻结后执行。',f'完整门禁在 1711 个冻结输入上重跑 PASS：{result_line}；输入及 HEAD 未漂移。'))
p=E/'implementation-notes.md'
p.write_text(p.read_text().replace('最终输入待冻结并完整执行；以最终日志及 SHA-256 核对为准。',f'最终 1711 个输入冻结后完整执行 PASS：{result_line}；输入及 HEAD 未漂移，见 [修复报告](repair.md)。'))
assert set(differences(hashes))==allowed and not differences(manifest['sha256'])
preservation={'frozenExisting':len(hashes),'plannedChanged':sorted(allowed),'unchangedExisting':len(hashes)-len(allowed),'productionFilesUnchanged':sum(p.startswith('src/') for p in hashes),'historicalReviewFilesUnchanged':sum(p.startswith('changes/v3.2.10/reviews/') for p in hashes),'head':initial['head'],'gateInputs':1711}
save('preservation-final.json',preservation)
save('verification.json',{'result':'PASS','scope':'RR14-01 and listed controls; not all JavaScript or release acceptance','gate':gate,'newRegressions':{'pass':34,'includedIn':'architecture-tests-final.log'},'beforeRegressions':before,'architectureTests':arch,'architecture':architecture,'unit':unit,'integration':integration,'windowsSkips':skips,'actualConfig':{'boundaries':20,'cases':2,'scanErrors':0},'probes':probes,'sharedReplay':shared,'preservation':preservation})
report=f'''# release/v3.2.10 第十四轮审查修复

**RR14-01 已修复，最终候选的完整 `release-check` 已重新运行并通过。** do 首轮内的写入若可能被 break/continue 跳过，检查器保留旧对象来源；原始三个漏报均变为 `ARCH-RENDERER-SCOPE` 诊断，列明的安全对照继续通过。

## 依据与改动

分支 `release/v3.2.10`，HEAD `{initial['head']}` 加既有未提交修复。本次依据[第十四轮审查](../2026-09-28-release-rereview-r14/review.md)、[G8 Spec](../../codex/v3.2.10-architecture-guardrails/spec.md) AC-05 和 [TechDoc](../../codex/v3.2.10-architecture-guardrails/techdoc.md) §4.4。

[Renderer 检查器](../../../../scripts/architecture/renderer-contracts.js)的成员快照新增有限跳转检查：

1. 解析同一函数内静态 break/continue 的目标，核对跳转是否位于写入之前、是否能跳过写入而仍到达读取；沿现有 helper 调用位置传递这一判断。
2. break 可跳过 do 剩余 body 和条件测试；continue 仍执行 do 条件测试。内层循环/switch/label 的跳转只影响其实际目标。
3. 跳转前的写入、跳转必经的 finally 写入、字面量不可达分支，以及同时跳过写入和读取的安全路径保持精度。可跳过的写入仅合并来源，后续确定覆盖沿用既有规则。

新增 [34 项回归](../../../../tests/unit/architecture/release-rereview-r14.test.js)，逐项使用异步 VM 的 false/true 输入核实对象身份、额外能力和静态诊断；涵盖 helper、数组槽位、label、switch、finally 与跳转前后顺序。共享 scan/contracts/rules/schema、机器配置、授权集合及生产业务源码均保持。

## 验证

| 范围 | 结果与证据 |
| --- | --- |
| 准确修复起点 | 最终同一 34 项测试：**15 FAIL / 19 PASS**，检查器逐文件哈希匹配。[日志](regressions-before-final.log)、[输入](regressions-before-inputs.json) |
| 新增回归 / 全部架构单测 | 新增 **34/34 PASS**，包含于 **655/655 PASS**。[架构日志](architecture-tests-final.log)、[预检](preflight-verification.json) |
| 审查原始案例 | **6 例符合预期、12 次 VM 分支验证**；三个原始 do 漏报均从 0 变为 1 条 scope 诊断，无异常。[修复前](renderer-before.jsonl)、[修复后](renderer-after.jsonl)、[VM](renderer-vm.json) |
| 实际 Renderer 配置 | 保留 **20 个 active 边界**；代表反例 1 条 scope 诊断、安全例 0 条、基线 0 条、无扫描异常。[结果](do-realconfig.json) |
| 覆盖顺序 / RR12 数组 | 顺序 **8 例**保持（5 安全通过、3 违规拒绝）；数组 **14 例**无异常（7 违规拒绝、6 安全通过、1 既有保守拒绝单列）。[顺序](order.json)、[数组](array-original.json)、[嵌套/helper](array-finite.json)、[核对](probe-verification.json) |
| 共享解析 / 参数绑定 | **56 + 6 例**诊断、scanner 结构及 evidenceId 与 R14 审查结果一致。[共享汇总](shared-verification.json)、[绑定](bindings-probe.json) |
| 修改的 JS lint | **0 error / 0 warning**。[结果](tool-lint.json) |
| 正式架构 CLI | **31 active、0 pending/partial、0 诊断、0 stale**，从本次完整门禁内同一 CLI 调用提取。[日志](architecture-check.log) |
| 完整门禁 | **PASS**：`{gate['command']}`。[完整日志](release-check.log)、[进程结果](release-check-result.json) |
| 全量单测 / 集成 | **{result_line}**；Renderer lifecycle 233/233 |
| 候选一致性 | **1711 个门禁输入与 HEAD 未漂移**。[冻结清单](gate-input-manifest.json)、[验证汇总](verification.json) |

完整门禁开始于 **{gate['startedAt']}**，结束于 **{gate['finishedAt']}**。本轮重跑全套，没有复用旧候选的完整门禁结论。实际配置探针在内存中追加 AST 样例、VM 使用 mock API，不等于执行 20 个控制器的真实业务。

## 保全与限制

接手时冻结 **5190 个既有文件**，仅 **7 个计划内文件**变化：检查器、5 份设计/状态文档和完整门禁自动刷新的集成耗时表。其余 **5183 个文件逐字节保持**，包含 **{preservation['productionFilesUnchanged']} 个生产源码文件**和 **{preservation['historicalReviewFilesUnchanged']} 个历史审查/修复文件**。新增本轮测试和证据，HEAD 未变；未提交、推送、开 PR、升版或发布。[保全核对](preservation-final.json)。

[本轮增量补丁](incremental.patch)相对接手时的未提交候选生成；反向适用只读预检和 `git diff --check` 均通过。[交付核对](delivery-check.json)、[实施记录](implementation-notes.md)。复现入口为 [起点回归](run-baseline.py)、[原始与相邻探针](replay-probes.py)、[共享探针](verify-shared.py)；脚本结果写入本轮目录，不覆盖历史审查证据。

本轮复核围绕 do、静态跳转目标、具体写入及读取位置；列明用例内没有待处理的确认缺陷。既有“槽位先覆盖再重排”和不同纯字符串候选的保守拒绝继续保留，不计作合法通过。本次不声明任意循环次数、异常传播、动态调用或完整 JavaScript 控制流均得到证明，也不扩大为整个 G8 无缺口的结论。

真实产品 Main 全流程、GUI、Windows 实机/安装包、Excel/WPS 和资金人工验收未执行。完整自动门禁通过不等于整个 release 的人工验收或发布完成。
'''
(E/'repair.md').write_text(report)
patch=[]
for name in sorted(allowed):
    patch.extend(difflib.unified_diff((E/'before'/name).read_text().splitlines(True),(ROOT/name).read_text().splitlines(True),fromfile='a/'+name,tofile='b/'+name))
patch.extend(difflib.unified_diff([],(ROOT/TEST).read_text().splitlines(True),fromfile='/dev/null',tofile='b/'+TEST))
(E/'incremental.patch').write_text(''.join(patch))
subprocess.run(['git','apply','--reverse','--check',str(E/'incremental.patch')],cwd=ROOT,check=True)
subprocess.run(['git','diff','--check'],cwd=ROOT,check=True)
links=[x for x in re.findall(r'\]\(([^)]+)\)',report) if '://' not in x and not x.startswith('#')]
missing=[x for x in links if not (E/x.split('#')[0]).exists() and x!='delivery-check.json']
assert not missing,missing
assert not differences(manifest['sha256']) and git('rev-parse','HEAD')==initial['head']
save('delivery-check.json',{'result':'PASS','head':initial['head'],'gateInputs':1711,'checkerSha256':sha(ROOT/SOURCE),'reversePatchCheck':'PASS','gitDiffCheck':'PASS','localLinks':len(links),'missingLinks':[]})
print(json.dumps({'result':'PASS','unit':unit,'architectureTests':arch,'preservation':preservation},ensure_ascii=False,indent=2))
