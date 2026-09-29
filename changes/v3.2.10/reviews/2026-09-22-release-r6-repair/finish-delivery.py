"""验证最终门禁、输入与文件保留，生成本轮报告和相对 dirty 起点的增量补丁。"""
from pathlib import Path
import datetime,difflib,hashlib,json,re,subprocess
E=Path(__file__).resolve().parent
ROOT=E.parents[3]
PRIMARY=ROOT.parents[2]
def read(name): return json.loads((E/name).read_text())
def save(name,value): (E/name).write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n')
def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def git(root,*args): return subprocess.check_output(['git',*args],cwd=root,text=True).strip()
def verify(root,items): return {'files':len(items),'changed':[p for p,h in items.items() if not (root/p).is_file() or sha(root/p)!=h]}
def summary(name,prefix):
 text=(E/name).read_text()
 return {k:int(re.search(r'^'+re.escape(prefix)+k+r' (\d+)$',text,re.M)[1]) for k in ['tests','suites','pass','fail','cancelled','skipped','todo']}

gate=read('release-check-result.json')
assert gate['exitCode']==0 and gate['changedInputs']==[] and gate['head']==gate['headAfter'],gate
unit=summary('release-check.log','ℹ ')
assert unit['pass']==9130 and unit['fail']==unit['cancelled']==0 and unit['skipped']==4,unit
archtests=summary('architecture-tests.log','# ')
assert archtests['pass']==356 and archtests['fail']==0,archtests
regressions=summary('regressions-after.log','# ')
assert regressions['pass']==186 and regressions['fail']==0
before=summary('regressions-before-final.log','# ')
assert before['tests']==40 and before['fail']==23 and before['pass']==17
assert read('regressions-before-inputs.json')['testSha256']==sha(ROOT/'tests/unit/architecture/release-rereview-r6.test.js')
arch=read('architecture-check.json')
assert len(arch['activeBoundaries'])==31 and not arch['violations'] and not arch['staleExceptions']
assert read('probe-verification.json')['result']=='PASS'
assert read('focused-run.json')['result']=='PASS' and not verify(ROOT,read('focused-run.json')['sha256'])['changed']
assert not verify(ROOT,read('probe-verification.json')['checkerAndPolicySha256'])['changed']
lint=read('tool-lint.json');assert len(lint)==3 and all(x['errorCount']==x['warningCount']==0 for x in lint)
log=(E/'release-check.log').read_text()
windows_skips=re.findall(r'^﹣.*$',log,re.M)
assert len(windows_skips)==4 and all('Windows' in item for item in windows_skips)
integration=[]
for match in re.finditer(r'^\[integration\] ▶ (.*?) \.\.\. PASS (?:(\d+)/(\d+)|\(no count\)) \((\d+)ms\)$',log,re.M):
 name,passed,total,duration=match.groups()
 integration.append({'name':name,'passed':int(passed) if passed else None,'total':int(total) if total else None,'durationMs':int(duration)})
assert len(integration)==68 and '全部 68 个集成脚本通过' in log
assert all(x['passed']==x['total'] for x in integration)
assert next(x for x in integration if x['name']=='renderer-lifecycle')['passed']==233
period=f"{datetime.datetime.fromisoformat(gate['startedAt']):%Y-%m-%d %H:%M:%S}–{datetime.datetime.fromisoformat(gate['finishedAt']):%H:%M:%S}（Asia/Shanghai）"
result_text='9130 项单测通过、0 失败、4 项 Windows 条件跳过，68/68 集成脚本通过'

p=ROOT/'changes/v3.2.10/README.md';s=p.read_text().replace('第六轮修复最终门禁验证中，见','第六轮修复完整门禁 PASS，见').replace('新增 40 项回归，RR2–RR6 合计 186/186 PASS；最终完整门禁验证中。','新增 40 项回归；架构 356/356 PASS；完整门禁重跑 PASS（9130 项单测通过、4 项 Windows 条件跳过、68/68 集成脚本通过）。');p.write_text(s)
p=ROOT/'changes/v3.2.10/release.md';s=p.read_text().replace('最终完整门禁验证中，所有修复未提交，','完整门禁已在 1703 个冻结输入上重跑 PASS，所有修复未提交，')
section=f'''## 2026-09-22 第六轮独立审查修复（未提交）

RR6-01/02 已修复参数解构不按调用时点读取替换成员，以及数组/原型经 helper 参数改写后仍被视为原生比较的两项漏报。参数身份与能力检查分阶段求值，原生比较证明保留成员 selector 及有限返回来源；旧别名、不同实例和合法函数值比较保持。新增 40 项回归，在起点检查器上 23 FAIL / 17 PASS，修复后全部通过。

| 验证 | 本轮候选结果 |
| --- | --- |
| 完整门禁 | {gate['command']}：PASS，{period} |
| 架构专项 / CLI | 356/356 PASS；31 active、0 pending/partial、0 诊断、0 stale |
| 全量单测 | 9130 PASS、0 FAIL、4 项 Windows 条件跳过 |
| 全量集成 | 68/68 脚本 PASS，Renderer lifecycle 233/233 |
| 输入与保护 | 1703 个门禁输入及 HEAD 未漂移；792 个生产源码、374 个历史证据和主工作区 865 个 dirty 文件保持 |

[修复报告](reviews/2026-09-22-release-r6-repair/repair.md)、[验证汇总](reviews/2026-09-22-release-r6-repair/verification.json)、[增量补丁](reviews/2026-09-22-release-r6-repair/incremental.patch)。本轮为修复自检；修复后独立复审、真实产品 Main、Windows/安装包、Excel/WPS 和资金人工验收未执行。未提交或发布。

'''
marker='## 2026-09-22 第五轮独立审查修复（未提交）'
if '## 2026-09-22 第六轮独立审查修复（未提交）' not in s:s=s.replace(marker,section+marker)
p.write_text(s)
p=ROOT/'changes/v3.2.10/codex/v3.2.10-architecture-guardrails/implementation-notes.md';s=p.read_text().replace('最终全架构、实际配置与完整门禁结果见 [本轮修复报告]','架构 356/356 PASS，实际配置探针通过；完整门禁重跑 PASS：'+result_text+'。1703 个输入及 HEAD 未漂移。证据见 [本轮修复报告]');p.write_text(s)
p=E/'implementation-notes.md';s=p.read_text().replace('最终全架构、实际配置及完整门禁结果待收齐。','架构 356/356 PASS；实际 20 个 Renderer boundary 正反例、G1 原始 8 项及 3 份完整生产源码副本、共享 28 项数据/查询与旁表隔离检查通过。完整门禁 '+period+' PASS：'+result_text+'。最终输入与保护见 repair.md。');p.write_text(s)

initial=read('input-manifest.json');hashes=initial['sha256'];allowed={p.relative_to(E/'before').as_posix() for p in (E/'before').rglob('*') if p.is_file()}
preservation={'initial':verify(ROOT,hashes),
 'production':verify(ROOT,{n:h for n,h in hashes.items() if n.startswith('src/')}),
 'historicalReviews':verify(ROOT,{n:h for n,h in hashes.items() if n.startswith('changes/v3.2.10/reviews/')}),
 'architectureConfig':verify(ROOT,{n:h for n,h in hashes.items() if n.startswith('architecture/') and n.endswith('.json')}),
 'primaryDirty':verify(PRIMARY,initial['primaryDirty']),
 'primaryHead':git(PRIMARY,'rev-parse','HEAD'),'releaseHead':git(ROOT,'rev-parse','HEAD')}
preservation['unexpectedChanges']=sorted(set(preservation['initial']['changed'])-allowed)
assert not preservation['unexpectedChanges'],preservation
assert all(not preservation[k]['changed'] for k in ['production','historicalReviews','architectureConfig','primaryDirty'])
assert preservation['releaseHead']==initial['head']==gate['head'] and preservation['primaryHead']==initial['primaryHead']
save('preservation-final.json',preservation)
manifest=read('gate-input-manifest.json');assert len(manifest['sha256'])==1703 and not verify(ROOT,manifest['sha256'])['changed']
paths=subprocess.check_output(['git','ls-files','--cached','--others','--exclude-standard','-z','--','src','scripts','tests','architecture','index.html','package.json','package-lock.json','eslint.config.*','.github/workflows'],cwd=ROOT).decode().split('\0')
assert set(manifest['sha256'])=={p for p in paths if p and (ROOT/p).is_file()}
results={'result':'PASS','gate':gate,'unit':unit,'architectureTests':archtests,'architecture':{'active':31,'diagnostics':0,'stale':0},'newRegressions':40,'windowsSkips':windows_skips,'regressionsBefore':before,'regressionsRR2toRR6':regressions,
 'integration':{'scripts':len(integration),'countedPassed':sum(x['passed'] or 0 for x in integration),'countedTotal':sum(x['total'] or 0 for x in integration),'withoutCount':[x['name'] for x in integration if x['total'] is None],'results':integration},
 'probes':read('probe-verification.json'),'preservation':preservation}
save('verification.json',results)
report=f'''# release/v3.2.10 第六轮审查修复

**第六轮 2 项 P2 已修复，最终完整 release-check 已重新执行并通过。** 本轮是修复与自检，结论限于原始反例、列明静态组合和自动验证；修复后的独立复审及平台/资金人工验收尚未进行。

## 固定对象与变更范围

- 工作区：`{ROOT}`；分支 `release/v3.2.10`，HEAD `{gate['head']}` 加全部既有未提交修复。
- 依据：[第六轮审查](../2026-09-22-release-rereview-r6/review.md)、[G8 Spec](../../codex/v3.2.10-architecture-guardrails/spec.md) AC05/16、[TechDoc](../../codex/v3.2.10-architecture-guardrails/techdoc.md) §4.4 与恢复入口规则，以及 [架构说明](../../../../architecture/README.md)。
- 起点冻结 {len(hashes)} 个既有文件，[SHA-256 清单](input-manifest.json)、[原 tracked 差异](input-diff.patch)。本轮只修改 2 个检查器文件、新增回归和配套文档，保留前五轮修复。
- 生产源码、机器边界和授权例外未改；没有提交、推送、PR、升版、标签或发布。

## 两项发现的修复

### RR6-01：参数解构读取调用时点的成员

[renderer-contracts.js](../../../../scripts/architecture/renderer-contracts.js) 对工厂及 bound 实参先保留对象身份，再以调用 AST 位置应用现有成员快照；返回和实际使用处检查完整能力。对象参数、改名、嵌套、固定 computed 键、已提供默认参数、helper 转发、静态数组参数均复用该选择规则。

`envelope.api` 已替换时，解构得到的新别名现在追踪新对象；对该别名的越权写入被拒绝。替换前捕获的旧别名保持分离，直接注入该旧别名也保留正确能力集合；同一工厂的不同调用实例继续隔离。已重赋值的参数不绕过既有候选分析。

原脚本在实际全部 **20 个 Renderer boundary** 下：基线 0 诊断，原越权例 **1 条 ARCH-RENDERER-SCOPE**，旧别名安全例 **0 诊断**；VM 分别确认真正注入的 API 有/无额外可调用方法。[实际配置与 VM 结果](renderer-realconfig.json)、[原脚本](../2026-09-22-release-rereview-r6/evidence/r6-renderer-parameter-realconfig.cjs)。

### RR6-02：间接改写后取消原生比较语义

[contracts.js](../../../../scripts/architecture/contracts.js) 的来源解析保留参数 selector、成员链、静态容器及有限 helper 返回投影。数组成员、Array.prototype 经对象/解构/原型参数改写，或包在对象中传给未知 helper 后，不再清空恢复回调目标。未知候选不能抹掉已知可能的数组/原型来源；合法比较要求所有接收者来源均可证明。

helper 返回来源使用调用局部参数环境，不把全仓无关实参加入执行闭包；完整根查询按参数闭包 revision 缓存，递归和局部上下文不共用结果。返回容器保留参数来源，继续检查内部能力逃逸。未改变受限函数配置、allowedSites 或历史例外。

原 G1 **8 项** VM 对照中，对象参数、解构参数、原型参数和直接改写均为恢复 stub 执行 **1 次 / 1 条入口诊断**；原生 includes/lastIndexOf 和纯比较 helper 为 **0 次 / 0 诊断**。[结果](g1-neighbors.json)、[原脚本](../2026-09-22-release-rereview-r6/evidence/r6-g1-neighbor-probe.cjs)。

完整生产源码临时副本 **765/765** 解析：prepare 内 helper 改写例和真正 reduce 各产生 **1 条 ARCH-PUBLICATION-RECOVERY-ENTRY**，原生 includes **0 诊断且无恢复回调目标**。[间接改写](g1-real-source.json)、[原生比较](g1-native-real-source.json)、[reduce](g1-reduce-real-source.json)。这三份突变只使用实际 active G1 边界静态扫描，不执行真实恢复 IO，也不作为全部 31 边界突变证明。

## 最终验证

| 验证 | 结果及证据 |
| --- | --- |
| 新增回归 | **40 项**；起点检查器 **23 FAIL / 17 PASS**，修复后全 PASS。[起点工具哈希](regressions-before-inputs.json)、[before 日志](regressions-before-final.log)、[测试代码](../../../../tests/unit/architecture/release-rereview-r6.test.js) |
| RR2–RR6 | **186/186 PASS**，包含新增 40 项，非额外累加。[日志](regressions-after.log) |
| 全部架构 | **356/356 PASS**，0 fail/skip。[日志](architecture-tests.log) |
| 正式架构 CLI | **31 active、0 pending/partial、0 诊断、0 stale**；765/765 解析，2 个已登记 generated unresolved、33 个动态位置继续按既有合同记录。[JSON](architecture-check.json)、[日志](architecture-cli.log) |
| 共享数据与查询 | **28 项**正反例符合预期，含内存 SQLite SQL 执行；scanner 序列化、重复扫描及 evidenceId 前后保持。[20 项](shared-data-query.json)、[8 项](shared-destructure.json)、[旁表隔离](descriptor-isolation.json) |
| 检查器和新测试 lint | 3 个文件 0 错误/告警。[结果](tool-lint.json) |
| 完整门禁 | **PASS**，`{gate['command']}`；{period}；在沙箱外使用项目既有隔离测试环境。[完整日志](release-check.log)、[结果](release-check-result.json) |
| 全量单测 | **{unit['pass']} PASS、0 FAIL、4 项 Windows 条件跳过**；{unit['tests']} total、{unit['suites']} suites。 |
| 全量集成 | **68/68 脚本 PASS**；有计数用例 {results['integration']['countedPassed']}/{results['integration']['countedTotal']}，另 1 个脚本无计数；Renderer lifecycle 233/233。 |
| 输入一致性 | **1703 个门禁输入及 HEAD 未漂移**。[门禁清单](gate-input-manifest.json)、[验证汇总](verification.json) |

原探针 exit 0 只代表取证完成，结果由[显式断言脚本](verify-probes.py)逐项检查，见[探针汇总](probe-verification.json)。共享探针内 beforeR5 为历史第五轮修复起点；本轮修复起点由独立的 [run-baseline.py](run-baseline.py)及文件哈希固定，不混用两个 before。

初稿暴露的安全旧别名误报、bound helper 候选丢失和全仓扫描开销均在最终验证前处理；中间日志和被停止的扫描不计入 PASS。[实施记录](implementation-notes.md)、[中间命令记录](command-errors.json)。

## 保护、增量与剩余边界

- 起点 {len(hashes)} 个既有文件仅 {len(preservation['initial']['changed'])} 个计划内文件变化；792 个生产 src、374 个历史审查/修复证据、2 份机器 JSON 及主工作区 865 个已有 dirty 文件全部保持。[保护核对](preservation-final.json)。
- [本轮增量补丁](incremental.patch)相对于起始 dirty 状态生成；反向应用只读预检、git diff --check 和文档链接检查通过。[交付核对](delivery-check.json)。生产源码与 scanner 旁表实现保持本轮起点字节。
- 已覆盖参数形态、成员替换前后、不同实例、真正回调与纯函数值比较、间接数组/原型改写和未知 helper 容器逃逸；不宣称任意动态循环、重复调用、反射、跨文件共享对象时序或所有原生 API 的完整静态证明。
- 修复后的独立复审、真实产品 Main 全流程、Windows/安装包、Excel/WPS 与资金人工验收未执行。自动门禁 PASS 不等于正式可发布结论。
'''
(E/'repair.md').write_text(report)
patch=[]
for old in sorted((E/'before').rglob('*')):
 if not old.is_file():continue
 name=old.relative_to(E/'before').as_posix();assert sha(old)==hashes[name]
 patch.extend(difflib.unified_diff(old.read_text().splitlines(True),(ROOT/name).read_text().splitlines(True),fromfile='a/'+name,tofile='b/'+name))
name='tests/unit/architecture/release-rereview-r6.test.js'
patch.extend(difflib.unified_diff([],(ROOT/name).read_text().splitlines(True),fromfile='/dev/null',tofile='b/'+name))
(E/'incremental.patch').write_text(''.join(patch))
subprocess.run(['git','apply','--reverse','--check',str(E/'incremental.patch')],cwd=ROOT,check=True)
subprocess.run(['git','diff','--check'],cwd=ROOT,check=True)
links=[link for link in re.findall(r'\]\(([^)]+)\)',report) if '://' not in link and not link.startswith('#')]
missing=[link for link in links if not (E/link.split('#')[0]).exists() and link!='delivery-check.json'];assert not missing,missing
assert git(ROOT,'branch','--show-current')=='release/v3.2.10'
assert not verify(ROOT,manifest['sha256'])['changed']
save('delivery-check.json',{'result':'PASS','checkedAt':datetime.datetime.now().astimezone().isoformat(),'head':gate['head'],'branch':'release/v3.2.10','gateInputs':len(manifest['sha256']),'gitDiffCheck':'PASS','reversePatchCheck':'PASS','localLinks':len(links),'missingLinks':[],'executionContext':'outside filesystem sandbox'})
print(json.dumps({'result':'PASS','gate':gate,'unit':unit,'architecture':archtests,'integrationScripts':len(integration),'preservation':preservation},ensure_ascii=False,indent=2))
