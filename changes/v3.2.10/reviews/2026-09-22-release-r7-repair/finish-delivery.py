"""汇总最终门禁与 RR7 证据，核对既有文件并生成相对 dirty 起点的补丁。"""
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
assert unit['pass'] == 9160 and unit['fail'] == unit['cancelled'] == 0 and unit['skipped'] == 4, unit
archtests = summary('architecture-tests.log', '# ')
assert archtests['pass'] == 386 and archtests['fail'] == archtests['skipped'] == 0, archtests
regressions = summary('regressions-after.log', '# ')
assert regressions['pass'] == 216 and regressions['fail'] == 0
before = summary('regressions-before-final.log', '# ')
assert before['tests'] == 30 and before['fail'] == 18 and before['pass'] == 12
test_name = 'tests/unit/architecture/release-rereview-r7.test.js'
assert read('regressions-before-inputs.json')['testSha256'] == sha(ROOT / test_name)
arch = read('architecture-check.json')
assert len(arch['activeBoundaries']) == 31 and not arch['violations'] and not arch['staleExceptions']
assert not arch['coverage']['pendingBoundaries'] and not arch['coverage']['partialBoundaries']
probes = read('probe-verification.json')
assert probes['result'] == 'PASS' and probes['remainingObservations'][0]['status'] == 'OPEN_OBSERVATION'
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
result_text = '9160 项单测通过、0 失败、4 项 Windows 条件跳过，68/68 集成脚本通过'

p = ROOT / 'changes/v3.2.10/README.md'
s = p.read_text().replace('第七轮修复最终门禁待验证', '第七轮修复完整门禁 PASS')
s = s.replace('RR2–RR7 共 216/216 PASS，最终完整门禁待验证。',
              '架构 386/386 PASS，完整门禁重跑 PASS（9160 项单测通过、4 项 Windows 条件跳过、68/68 集成脚本通过）。')
p.write_text(s)
p = ROOT / 'changes/v3.2.10/release.md'
s = p.read_text().replace('最终完整门禁待验证，所有修复未提交，', '完整门禁已在 1704 个冻结输入上重跑 PASS，所有修复未提交，')
section = f'''## 2026-09-22 第七轮独立审查修复（未提交）

RR7-01 已修复触发默认参数时丢失默认对象来源的问题。省略、缺失成员或 undefined 正确启用默认表达式，显式提供的其他对象保持独立；默认表达式在被调用函数环境及本次调用身份下求值。新增 30 项回归，在起点检查器上 18 FAIL / 12 PASS，修复后全部通过。R7 留存的数组元素替换观察仍未关闭，不纳入默认参数问题的关闭结论。

| 验证 | 本轮候选结果 |
| --- | --- |
| 完整门禁 | `{gate['command']}`：PASS，{period}；在沙箱外使用隔离测试环境 |
| 架构专项 / CLI | 386/386 PASS；31 active、0 pending/partial、0 诊断、0 stale |
| 全量单测 | 9160 PASS、0 FAIL、4 项 Windows 条件跳过 |
| 全量集成 | 68/68 脚本 PASS，Renderer lifecycle 233/233 |
| 输入与保护 | 1704 个门禁输入及 HEAD 未漂移；792 个生产源码、462 个历史证据和主工作区 865 个 dirty 文件保持 |

[修复报告](reviews/2026-09-22-release-r7-repair/repair.md)、[验证汇总](reviews/2026-09-22-release-r7-repair/verification.json)、[增量补丁](reviews/2026-09-22-release-r7-repair/incremental.patch)。本轮为修复自检；修复后独立复审、真实产品 Main、Windows/安装包、Excel/WPS 和资金人工验收未执行。未提交或发布。

'''
marker = '## 2026-09-22 第六轮独立审查修复（未提交）'
if '## 2026-09-22 第七轮独立审查修复（未提交）' not in s:
    assert marker in s
    s = s.replace(marker, section + marker)
p.write_text(s)
p = ROOT / 'changes/v3.2.10/codex/v3.2.10-architecture-guardrails/implementation-notes.md'
s = p.read_text().replace('最终专项及门禁证据见 [本轮修复报告]',
                          '架构 386/386 PASS，实际配置正反例通过；完整门禁重跑 PASS：' + result_text + '。1704 个输入及 HEAD 未漂移。证据见 [本轮修复报告]')
p.write_text(s)
p = E / 'implementation-notes.md'
s = p.read_text().replace('其余证据待最终专项及完整门禁收齐。',
                          '架构 386/386 PASS；真实 20 个 Renderer boundary 原始正反例符合预期；共享 38 项正反例与旁表隔离检查通过。完整门禁 ' + period + ' PASS：' + result_text + '。最终输入与保护见 repair.md。')
p.write_text(s)
notes = read('command-notes.json')
notes['fallback'] = 'Default sandbox run failed only at Electron startup (SIGABRT); the isolated Electron test passed outside the sandbox, followed by a complete release-check rerun outside the sandbox.'
save('command-notes.json', notes)

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
assert len(manifest['sha256']) == 1704 and not verify(ROOT, manifest['sha256'])['changed']
assert manifest == read('default-sandbox-attempt/gate-input-manifest.json')
assert read('default-sandbox-attempt/release-check-result.json')['exitCode'] == 1
assert read('renderer-lifecycle-outside-result.json')['result'] == 'PASS'
paths = subprocess.check_output(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--',
                                'src', 'scripts', 'tests', 'architecture', 'index.html', 'package.json',
                                'package-lock.json', 'eslint.config.*', '.github/workflows'], cwd=ROOT).decode().split('\0')
assert set(manifest['sha256']) == {p for p in paths if p and (ROOT / p).is_file()}
results = {'result': 'PASS', 'scope': 'RR7-01 repair; array replacement observation remains open',
           'executionContext': 'outside filesystem sandbox', 'gate': gate, 'unit': unit,
           'architectureTests': archtests, 'architecture': {'active': 31, 'diagnostics': 0, 'stale': 0},
           'newRegressions': 30, 'windowsSkips': windows_skips, 'regressionsBefore': before,
           'regressionsRR2toRR7': regressions,
           'integration': {'scripts': len(integration), 'countedPassed': sum(x['passed'] or 0 for x in integration),
                           'countedTotal': sum(x['total'] or 0 for x in integration),
                           'withoutCount': [x['name'] for x in integration if x['total'] is None], 'results': integration},
           'probes': probes, 'preservation': preservation}
save('verification.json', results)
report = f'''# release/v3.2.10 第七轮审查修复

**RR7-01 已修复，最终完整 release-check 已重新执行并通过。** 原始三种默认参数反例均被拒绝，显式提供其他对象的安全对照仍通过。R7 留存的数组元素替换观察仍可复现且未关闭；本报告不作全部 G8 合同或 release 可发布结论。

## 固定对象与范围

- 工作区：`{ROOT}`；分支 `release/v3.2.10`，HEAD `{gate['head']}` 加全部既有未提交修复。
- 依据：[第七轮审查](../2026-09-22-release-rereview-r7/review.md)、[G8 Spec](../../codex/v3.2.10-architecture-guardrails/spec.md) G8-AC-05、[TechDoc](../../codex/v3.2.10-architecture-guardrails/techdoc.md) §4.4。
- 起点冻结 {len(hashes)} 个既有文件，见 [SHA-256 清单](input-manifest.json)、[原 tracked 差异](input-diff.patch)。本轮修改 1 个 Renderer 检查器、新增 1 个回归文件并更新配套文档；集成测试策略文档由完整门禁刷新。
- 生产源码、共享 scanner/G1/G5 检查器、机器边界和授权例外未改。前六轮修复保留，没有提交、推送、PR、升版、标签或发布。

## RR7-01：默认参数保留实际生效的对象来源

[renderer-contracts.js](../../../../scripts/architecture/renderer-contracts.js) 在 AssignmentPattern 绑定时区分缺失、undefined、已提供值和未知来源。缺失实参、确定缺少的成员/数组槽位、未遮蔽的 undefined 使用默认表达式；null、false、0、空串和已提供对象继续使用实际参数。未知实参保留可能的默认来源，不能抹掉默认对象身份；Object.prototype 上的继承成员不当作确定缺失。

默认表达式在被调用函数的词法环境中求值，并先建立本次调用身份。因此默认值引用前序参数、读取已替换成员或创建新对象时，分别保留参数来源、调用时点和独立实例。默认参数与普通参数复用同一参数回溯，实际重赋值的参数仍走原有候选分析。

现在 `select({{}})`、`select({{api: undefined}})` 和省略普通默认参数的实参都能追踪 `shared`；经返回值添加的 `outsideScope` 会触发拒绝。显式传入另一对象不会把该对象的修改算到 `shared`；同一工厂不同调用产生的新默认对象保持分离。

保留实际全部 **20 个 Renderer boundary**、真实 Renderer AST 的原始探针：越权例在 R7 审查中为 **0 诊断**，本轮复验为 **1 条 ARCH-RENDERER-SCOPE**；显式提供另一对象的安全例维持 **0 诊断**。VM 分别确认注入对象存在/不存在额外可调用方法。[本轮结果](renderer-realconfig.json)、[日志](renderer-realconfig.log)、[R7 审查结果](../2026-09-22-release-rereview-r7/evidence/r7-renderer-default-realconfig.json)、[原脚本](../2026-09-22-release-rereview-r7/evidence/r7-renderer-default-realconfig.cjs)。

## 验证

| 范围 | 结果与证据 |
| --- | --- |
| 新增回归 | **30 项**；字节匹配的起点检查器 **18 FAIL / 12 PASS**，修复后全部通过。[起点哈希](regressions-before-inputs.json)、[before 日志](regressions-before-final.log)、[测试代码](../../../../tests/unit/architecture/release-rereview-r7.test.js) |
| RR2–RR7 | **216/216 PASS**，包含新增 30 项，非额外累加。[日志](regressions-after.log) |
| 全部架构 | **386/386 PASS**，0 fail/skip。[日志](architecture-tests.log) |
| 正式架构 CLI | **31 active、0 pending/partial、0 诊断、0 stale**；765/765 解析。[JSON](architecture-check.json)、[日志](architecture-cli.log) |
| 原 Renderer 相邻探针 | 三类默认值反例及 bound-live 被拒绝；提供其他对象、bound/array 旧别名安全例通过。8 项中 **7 项符合关闭或合法预期，1 项数组替换观察仍开放**。[结果](renderer-neighbors.jsonl) |
| 共享数据与查询 | **38 项**正反例符合预期：20 个 Renderer、18 个查询，含 10 次内存 SQLite 查询；scanner 序列化、重复扫描及 evidenceId 保持。[汇总](r7-data-verification.json)、[断言脚本](verify-shared.py) |
| G1 相邻证据 | 复用 R7 审查的静态/VM 探针；G1 相关检查器和机器配置逐字节保持，本轮重跑全部架构单测。未重复执行真实恢复 IO。[输入哈希与范围](probe-verification.json) |
| 检查器及新测试 lint | 2 个文件 0 错误/告警。[结果](tool-lint.json) |
| 完整门禁 | **PASS**，`{gate['command']}`，{period}；在沙箱外使用项目测试环境。[完整日志](release-check.log)、[结果](release-check-result.json) |
| 全量单测 | **{unit['pass']} PASS、0 FAIL、4 项 Windows 条件跳过**；{unit['tests']} total、{unit['suites']} suites。 |
| 全量集成 | **68/68 脚本 PASS**；有计数用例 {results['integration']['countedPassed']}/{results['integration']['countedTotal']}；另 1 个脚本无计数；Renderer lifecycle 233/233。 |
| 输入一致性 | **1704 个门禁输入及 HEAD 未漂移**。[清单](gate-input-manifest.json)、[验证汇总](verification.json) |

共享探针的 beforeR6 指 R6 修复起点，35 项预期保持、3 项当时误报的修复仍有效，不将其计为本轮新增修复。本轮起点比较使用独立 [run-baseline.py](run-baseline.py) 和完整文件哈希。默认参数测试初稿中的非法全局 undefined 声明已改为合法参数遮蔽，并重新运行起点与修复后测试；只计最终结果。

首次沙箱外门禁两次因自动权限审查超时未启动。默认沙箱中的完整门禁仅 Electron 生命周期测试因 SIGABRT 失败；[首次门禁日志](default-sandbox-attempt/release-check.log)及[结果](default-sandbox-attempt/release-check-result.json)保留。核对测试隔离后，单独沙箱外运行 [Electron 测试 233/233 PASS](renderer-lifecycle-outside-result.json)，随后在同一冻结输入上重新执行完整沙箱外门禁并通过。没有用分段结果拼接完整 PASS。[命令记录](command-notes.json)。

## 保留观察与保护

**数组元素替换观察未关闭。** `array-replaced-element` 仍为运行时注入对象有额外方法、静态 0 诊断，属于既有数组写入身份传播观察，本轮未完成实际全部 Renderer 配置的扩展验证。本次默认参数修复不覆盖它；未把 8 项相邻探针统一标为 PASS，也不宣称 G8 防倒退合同全部闭环。

- 起点 {len(hashes)} 个既有文件仅 {len(preservation['initial']['changed'])} 个计划内文件变化；792 个生产 src、462 个历史审查/修复证据、2 份机器 JSON 及主工作区 865 个 dirty 文件全部保持。[保护核对](preservation-final.json)。
- [本轮增量补丁](incremental.patch)相对于起始 dirty 状态生成。反向应用只读预检、git diff --check 和文档链接检查通过。[交付核对](delivery-check.json)、[实施记录](implementation-notes.md)。
- 本轮为修复自检，未进行修复后独立复审、真实产品 Main 全流程、Windows/安装包、Excel/WPS 或资金人工验收。自动门禁不证明任意动态 JavaScript 都可静态解析，也不等于正式可发布结论。
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
missing = [link for link in links if not (E / link.split('#')[0]).exists() and link != 'delivery-check.json']
assert not missing, missing
assert git(ROOT, 'branch', '--show-current') == 'release/v3.2.10'
assert not verify(ROOT, manifest['sha256'])['changed']
save('delivery-check.json', {'result': 'PASS', 'checkedAt': datetime.datetime.now().astimezone().isoformat(),
                            'head': gate['head'], 'branch': 'release/v3.2.10', 'gateInputs': len(manifest['sha256']),
                            'gitDiffCheck': 'PASS', 'reversePatchCheck': 'PASS', 'localLinks': len(links),
                            'missingLinks': [], 'executionContext': 'outside filesystem sandbox'})
print(json.dumps({'result': 'PASS', 'gate': gate, 'unit': unit, 'architecture': archtests,
                  'integrationScripts': len(integration), 'preservation': preservation}, ensure_ascii=False, indent=2))
