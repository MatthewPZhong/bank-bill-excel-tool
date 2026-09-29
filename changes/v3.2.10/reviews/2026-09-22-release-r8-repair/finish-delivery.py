"""核验 RR8 最终门禁、冻结输入和保护范围，生成报告与增量补丁。"""
from pathlib import Path
import datetime
import difflib
import hashlib
import json
import re
import subprocess

E = Path(__file__).resolve().parent
ROOT = E.parents[3]
PRIMARY = ROOT.parents[2]


def read(name):
    return json.loads((E / name).read_text())


def save(name, value):
    (E / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def git(root, *args):
    return subprocess.check_output(['git', *args], cwd=root, text=True).strip()


def verify(root, items):
    return {'files': len(items), 'changed': [p for p, h in items.items()
            if not (root / p).is_file() or sha(root / p) != h]}


def summary(name, prefix):
    text = (E / name).read_text()
    return {k: int(re.search(r'^' + re.escape(prefix) + k + r' (\d+)$', text, re.M)[1])
            for k in ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo']}


gate = read('release-check-result.json')
assert gate['exitCode'] == 0 and gate['changedInputs'] == [] and gate['head'] == gate['headAfter'], gate
unit = summary('release-check.log', 'ℹ ')
assert unit['pass'] == 9206 and unit['fail'] == unit['cancelled'] == 0 and unit['skipped'] == 4, unit
archtests = summary('architecture-tests.log', '# ')
assert archtests['pass'] == 432 and archtests['fail'] == archtests['skipped'] == 0, archtests
regressions = summary('regressions-after.log', '# ')
assert regressions['pass'] == 262 and regressions['fail'] == 0
before = summary('regressions-before-final.log', '# ')
assert before['tests'] == 46 and before['fail'] == 34 and before['pass'] == 12
test_name = 'tests/unit/architecture/release-rereview-r8.test.js'
assert read('regressions-before-inputs.json')['testSha256'] == sha(ROOT / test_name)
arch = read('architecture-check.json')
assert len(arch['activeBoundaries']) == 31 and not arch['violations'] and not arch['staleExceptions']
assert not arch['coverage']['pendingBoundaries'] and not arch['coverage']['partialBoundaries']
probes = read('probe-verification.json')
assert probes['result'] == 'PASS' and read('shared-ipc-async-verification.json')['result'] == 'PASS'
assert not verify(ROOT, probes['unchangedSharedCheckerAndPolicySha256'])['changed']
lint = read('tool-lint.json')
assert len(lint) == 2 and all(x['errorCount'] == x['warningCount'] == 0 for x in lint)
log = (E / 'release-check.log').read_text()
windows_skips = re.findall(r'^﹣.*$', log, re.M)
assert len(windows_skips) == 4 and all('Windows' in item for item in windows_skips)
integration = []
for match in re.finditer(r'^\[integration\] ▶ (.*?) \.\.\. PASS (?:(\d+)/(\d+)|\(no count\)) \((\d+)ms\)$', log, re.M):
    name, passed, total, duration = match.groups()
    integration.append({'name': name, 'passed': int(passed) if passed else None,
                        'total': int(total) if total else None, 'durationMs': int(duration)})
assert len(integration) == 68 and '全部 68 个集成脚本通过' in log
assert all(x['passed'] == x['total'] for x in integration)
assert next(x for x in integration if x['name'] == 'renderer-lifecycle')['passed'] == 233
period = (f"{datetime.datetime.fromisoformat(gate['startedAt']):%Y-%m-%d %H:%M:%S}–"
          f"{datetime.datetime.fromisoformat(gate['finishedAt']):%H:%M:%S}（Asia/Shanghai）")
result_text = '9206 项单测通过、0 失败、4 项 Windows 条件跳过，68/68 集成脚本通过'

p = ROOT / 'changes/v3.2.10/README.md'
s = p.read_text().replace('第八轮修复最终门禁验证中', '第八轮修复完整门禁 PASS')
s = s.replace('最终完整门禁验证中。前轮固定数组槽位观察',
              '架构 432/432 PASS，完整门禁重跑 PASS（9206 项单测通过、4 项 Windows 条件跳过、68/68 集成脚本通过）。前轮固定数组槽位观察')
p.write_text(s)
p = ROOT / 'changes/v3.2.10/release.md'
s = p.read_text().replace('最终完整门禁验证中，所有修复未提交，', '完整门禁已在 1705 个冻结输入上重跑 PASS，所有修复未提交，')
section = f'''## 2026-09-22 第八轮独立审查修复（未提交）

RR8-01/02 已修复 IPC 默认来源和固定数组槽位身份漏报。IPC 字段不能仅凭来源标签排除 undefined；数组以分配位置及调用帧区分实例，按读取时点选择槽位，旧别名和浅复制保持分离。新增 46 项回归，起点 34 FAIL / 12 PASS，修复后全部通过。前轮固定槽位观察已纳入本轮关闭范围。

| 验证 | 本轮候选结果 |
| --- | --- |
| 完整门禁 | `{gate['command']}`：PASS，{period}；沙箱外隔离测试环境 |
| 架构专项 / CLI | 432/432 PASS；31 active、0 pending/partial、0 诊断、0 stale |
| 全量单测 | 9206 PASS、0 FAIL、4 项 Windows 条件跳过 |
| 全量集成 | 68/68 脚本 PASS，Renderer lifecycle 233/233 |
| 输入与保护 | 1705 个门禁输入及 HEAD 未漂移；792 个生产源码、542 个历史证据和主工作区 865 个 dirty 文件保持 |

IPC 形状未声明时，即使 VM stub 恰好提供某字段，默认候选仍保守保留。共享 44 例中一个旧合法预期的同步 invoke stub 与 Electron Promise 合同不符，异步对照确认会触发其他频道默认值，当前拒绝有证据；详见[修复报告](reviews/2026-09-22-release-r8-repair/repair.md)。[验证汇总](reviews/2026-09-22-release-r8-repair/verification.json)、[增量补丁](reviews/2026-09-22-release-r8-repair/incremental.patch)。本轮为修复自检，未执行修复后独立复审或产品/平台人工验收，未提交或发布。

'''
marker = '## 2026-09-22 第七轮独立审查修复（未提交）'
if '## 2026-09-22 第八轮独立审查修复（未提交）' not in s:
    assert marker in s
    s = s.replace(marker, section + marker)
p.write_text(s)
p = ROOT / 'changes/v3.2.10/codex/v3.2.10-architecture-guardrails/implementation-notes.md'
s = p.read_text().replace('最终架构、实际配置和完整门禁见 [本轮修复报告]',
                          '架构 432/432 PASS，实际配置原反例拒绝；完整门禁重跑 PASS：' + result_text + '。1705 个输入及 HEAD 未漂移。证据见 [本轮修复报告]')
p.write_text(s)
p = E / 'implementation-notes.md'
s = p.read_text().replace('后续架构、真实配置、共享解析和完整门禁结果见最终报告。',
                          '最终架构 432/432 PASS，正式 CLI 31 active/0 诊断/0 stale，实际配置及共享解析符合记录的预期。完整门禁 ' + period + ' PASS：' + result_text + '。输入及保护见 repair.md。')
p.write_text(s)

initial = read('input-manifest.json')
hashes = initial['sha256']
allowed = {p.relative_to(E / 'before').as_posix() for p in (E / 'before').rglob('*') if p.is_file()}
preservation = {
    'initial': verify(ROOT, hashes),
    'production': verify(ROOT, {n: h for n, h in hashes.items() if n.startswith('src/')}),
    'historicalReviews': verify(ROOT, {n: h for n, h in hashes.items() if n.startswith('changes/v3.2.10/reviews/')}),
    'architectureConfig': verify(ROOT, {n: h for n, h in hashes.items() if n.startswith('architecture/') and n.endswith('.json')}),
    'primaryDirty': verify(PRIMARY, initial['primaryDirty']),
    'primaryHead': git(PRIMARY, 'rev-parse', 'HEAD'),
    'releaseHead': git(ROOT, 'rev-parse', 'HEAD')}
preservation['unexpectedChanges'] = sorted(set(preservation['initial']['changed']) - allowed)
assert not preservation['unexpectedChanges'], preservation
assert all(not preservation[k]['changed'] for k in ['production', 'historicalReviews', 'architectureConfig', 'primaryDirty'])
assert preservation['releaseHead'] == initial['head'] == gate['head'] and preservation['primaryHead'] == initial['primaryHead']
save('preservation-final.json', preservation)
manifest = read('gate-input-manifest.json')
assert len(manifest['sha256']) == 1705 and not verify(ROOT, manifest['sha256'])['changed']
paths = subprocess.check_output(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--',
                                'src', 'scripts', 'tests', 'architecture', 'index.html', 'package.json',
                                'package-lock.json', 'eslint.config.*', '.github/workflows'], cwd=ROOT).decode().split('\0')
assert set(manifest['sha256']) == {p for p in paths if p and (ROOT / p).is_file()}
results = {'result': 'PASS', 'scope': 'RR8-01/02 repair with conservative IPC default handling; not all dynamic JavaScript',
           'executionContext': 'outside filesystem sandbox', 'gate': gate, 'unit': unit,
           'architectureTests': archtests, 'architecture': {'active': 31, 'diagnostics': 0, 'stale': 0},
           'newRegressions': 46, 'windowsSkips': windows_skips, 'regressionsBefore': before,
           'regressionsRR2toRR8': regressions,
           'integration': {'scripts': len(integration), 'countedPassed': sum(x['passed'] or 0 for x in integration),
                           'countedTotal': sum(x['total'] or 0 for x in integration),
                           'withoutCount': [x['name'] for x in integration if x['total'] is None], 'results': integration},
           'probes': probes, 'preservation': preservation}
save('verification.json', results)
report = f'''# release/v3.2.10 第八轮审查修复

**RR8-01、RR8-02 已修复，完整 release-check 已重新执行并通过。** IPC 缺字段与固定数组槽位替换的原始越权例均被拒绝，旧别名安全例继续通过。关闭范围为列明原始反例、静态组合和自动验证，不作全部 G8 合同或正式可发布结论。

## 固定对象与变更

- 工作区：`{ROOT}`；分支 `release/v3.2.10`，HEAD `{gate['head']}` 加全部既有未提交修复。
- 依据：[第八轮审查](../2026-09-22-release-rereview-r8/review.md)、[G8 Spec](../../codex/v3.2.10-architecture-guardrails/spec.md) G8-AC-05、[TechDoc](../../codex/v3.2.10-architecture-guardrails/techdoc.md) §4.4。
- 冻结 {len(hashes)} 个既有文件，见 [SHA-256 清单](input-manifest.json)、[原 tracked 差异](input-diff.patch)。修改 1 个 Renderer 检查器，新增 1 个回归文件，更新配套说明；集成策略清单由完整门禁刷新。
- 生产业务、共享 scanner、G1/G5、机器边界和授权例外未改；前七轮修复和历史审查材料保留，没有提交、推送、PR、升版、标签或发布。

## RR8-01：IPC 默认来源

[renderer-contracts.js](../../../../scripts/architecture/renderer-contracts.js) 不再把 ipc-data 当作必然非 undefined。来源标签只保存 channel/fields；默认参数同时保留 IPC 值和默认表达式候选，别名写入能够命中实际可能使用的 shared。所有候选都满足同一数据合同才允许纯数据注入；显式构造对象仍可证明已提供。

保留真实 Renderer AST 和全部 **20 个 active Renderer boundary** 的原始探针，基线 **0 诊断**，IPC 缺字段越权例现 **1 条诊断**，异步 VM 确认 shared 收到 outsideScope。[结果](renderer-ipc-realconfig.json)、[日志](renderer-ipc-realconfig.log)、[原脚本](../2026-09-22-release-rereview-r8/evidence/r8-renderer-ipc-realconfig.cjs)。

**保守范围说明：** 原 `info.backgroundConfig` stub 安全例当前也产生 1 条诊断，VM 中实际 shared 仍安全。原因是现有来源合同没有字段存在性/非 undefined 证明，不能用 stub 恰好提供值代替合同。这里选择报告建议的保守拒绝，不增加字段白名单。显式构造的对象、显式标量，以及纯数据默认候选均有允许回归；普通无默认值的已授权 IPC 数据路径保持。

## RR8-02：固定数组槽位与实例身份

数组以字面量分配位置和可解释调用帧区分实例。身份映射仅在 Renderer 内建立，不修改共享 scanner 描述符或 evidenceId。固定数字/字符串索引、参数/局部解构、bound 参数、嵌套数组/对象和静态 spread 复制复用成员快照。`list[0] = current` 后读取获得 current；替换前捕获的旧别名、复制后源数组改写和不同工厂实例保持分离。

整体数组数据注入检查初始及可见写入候选，不能让后列未执行的安全分支遮盖能力。对已识别的 mutator、length、delete/update 和动态键，保留不确定性及已知元素/插入来源，不把未知退化为安全初始元素；不声称精确执行这些操作。真实装配中的递归身份核对使用在途标记，避免从深度零反复展开。

实际全部 **20 个 active Renderer boundary** 的 5 个场景：参数解构和直接索引两个原漏报均从 **0 变为 1 条诊断**；替换前旧别名 **0 诊断**；对象固定键、无替换数组两个违规对照各 **1 条诊断**。VM 与扫描一致，765/765 文件解析。具体追加 BankStatement 装配，不表示逐个测试全部 20 个工厂。[结果](renderer-array-realconfig.json)、[日志](renderer-array-realconfig.log)、[原脚本](../2026-09-22-release-rereview-r8/evidence/r8-array-probe.cjs)。R7 留存的固定槽位观察已纳入本项关闭范围。

## 验证与共享探针判定修正

| 验证 | 本轮结果 |
| --- | --- |
| 新增回归 | **46 项**；字节匹配起点 **34 FAIL / 12 PASS**，修复后 **46/46 PASS**。[起点哈希](regressions-before-inputs.json)、[before 日志](regressions-before-final.log)、[当前日志](regressions-r8.log)、[测试代码](../../../../tests/unit/architecture/release-rereview-r8.test.js) |
| RR2–RR8 | **262/262 PASS**，包含新增 46 项，非额外累加。[日志](regressions-after.log) |
| 全部架构 | **432/432 PASS**，0 fail/skip。[日志](architecture-tests.log) |
| 正式 CLI | **31 active、0 pending/partial、0 诊断、0 stale**，765/765 parsed。[JSON](architecture-check.json)、[日志](architecture-cli.log) |
| 实际配置 / VM | IPC 原反例及 5 个数组对照符合上述预期。[显式断言](verify-probes.py)、[汇总](probe-verification.json) |
| 共享解析 | **44 项**：26 Renderer、18 查询；10 次内存 SQLite 查询；scanner 序列化、重复扫描和 evidenceId 保持。1 项旧合法预期按异步 IPC 合同修正为拒绝，其余通过/拒绝预期保持。[汇总](shared-archive-verification.json)、[断言](verify-shared.py) |
| 检查器及新测试 lint | 2 个文件 0 错误/告警。[结果](tool-lint.json) |
| 完整门禁 | **PASS**，`{gate['command']}`，{period}，沙箱外隔离测试环境。[日志](release-check.log)、[结果](release-check-result.json) |
| 全量单测 | **{unit['pass']} PASS、0 FAIL、4 项 Windows 条件跳过**；{unit['tests']} total、{unit['suites']} suites。 |
| 全量集成 | **68/68 脚本 PASS**；有计数项 {results['integration']['countedPassed']}/{results['integration']['countedTotal']}，另 1 个脚本无计数；Renderer lifecycle **233/233**。 |
| 输入 | **1705 个门禁输入及 HEAD 未漂移**。[门禁清单](gate-input-manifest.json)、[验证汇总](verification.json) |

共享例 `single-mount-category-explicit-ipc` 的源码未 await，就读取 `ipcRenderer.invoke('app:get-info').reconIdFixBillCategory`；旧 VM 的 invoke 同步返回对象。本地 [Electron 类型定义](../../../../node_modules/electron/electron.d.ts:8847) 为 Promise。替换成异步 VM 后，调用序列为 **app:get-info → other**，实际触发被禁止的默认频道，当前拒绝有运行时反证。修正的是探针的合法性假设，没有改写旧审查材料。[异步对照](shared-ipc-async-verification.json)。共享脚本 beforeR7 指历史 R7 修复起点；本轮起点单独由 [run-baseline.py](run-baseline.py) 与冻结哈希固定，不混用。

首次全量 Renderer 验证发现递归栈溢出，已修复并重跑；中间失败日志保留，不计入最终 PASS。[原架构失败](architecture-tests-initial-failure.log)、[修复后真实装配专项](renderer-policy-after-cycle-fix.log)、[实施记录](implementation-notes.md)。G1/G5 的工具和机器配置逐字节保持，本轮通过全部架构及共享夹具核验，不新增真实用户恢复 IO 结论。

## 保护、增量与边界

- 起点 {len(hashes)} 个既有文件仅 {len(preservation['initial']['changed'])} 个计划内文件变化；792 个生产 src、542 个历史审查/修复证据、2 份机器 JSON 和主工作区 865 个 dirty 文件保持。[保护核对](preservation-final.json)。
- [本轮增量补丁](incremental.patch)相对于起始 dirty 状态生成，反向应用只读预检、git diff --check 和文档链接检查通过。[交付核对](delivery-check.json)。
- 原两项 P2 和列明邻域已覆盖；不承诺任意动态循环、未知 helper、变长 spread、跨文件对象时序、反射或所有数组操作的完整静态语义。IPC 返回字段的存在性仍未引入形状合同，可能保守拒绝未经证明的合法运行样本。
- 本轮为修复自检。修复后独立复审、真实产品 Main 全流程、Windows/安装包、Excel/WPS 和资金人工验收未执行。自动门禁 PASS 不等于正式可发布。
'''
(E / 'repair.md').write_text(report)
patch = []
for old in sorted((E / 'before').rglob('*')):
    if not old.is_file():
        continue
    name = old.relative_to(E / 'before').as_posix()
    assert sha(old) == hashes[name]
    patch.extend(difflib.unified_diff(old.read_text().splitlines(True), (ROOT / name).read_text().splitlines(True),
                                     fromfile='a/' + name, tofile='b/' + name))
patch.extend(difflib.unified_diff([], (ROOT / test_name).read_text().splitlines(True),
                                 fromfile='/dev/null', tofile='b/' + test_name))
(E / 'incremental.patch').write_text(''.join(patch))
subprocess.run(['git', 'apply', '--reverse', '--check', str(E / 'incremental.patch')], cwd=ROOT, check=True)
subprocess.run(['git', 'diff', '--check'], cwd=ROOT, check=True)
links = [link for link in re.findall(r'\]\(([^)]+)\)', report) if '://' not in link and not link.startswith('#')]
missing = [link for link in links if not (E / re.sub(r':\d+$', '', link.split('#')[0])).exists() and link != 'delivery-check.json']
assert not missing, missing
assert git(ROOT, 'branch', '--show-current') == 'release/v3.2.10'
assert not verify(ROOT, manifest['sha256'])['changed']
save('delivery-check.json', {'result': 'PASS', 'checkedAt': datetime.datetime.now().astimezone().isoformat(),
                            'head': gate['head'], 'branch': 'release/v3.2.10', 'gateInputs': len(manifest['sha256']),
                            'gitDiffCheck': 'PASS', 'reversePatchCheck': 'PASS', 'localLinks': len(links),
                            'missingLinks': [], 'executionContext': 'outside filesystem sandbox'})
print(json.dumps({'result': 'PASS', 'gate': gate, 'unit': unit, 'architecture': archtests,
                  'integrationScripts': len(integration), 'preservation': preservation}, ensure_ascii=False, indent=2))
