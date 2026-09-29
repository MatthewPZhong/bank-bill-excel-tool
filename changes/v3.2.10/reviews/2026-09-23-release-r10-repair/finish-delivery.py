"""核对 R10 最终证据后生成交付材料；任何结果或输入不符即停止。"""
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
SOURCE = 'scripts/architecture/renderer-contracts.js'
TEST = 'tests/unit/architecture/release-rereview-r10.test.js'
FINAL_SOURCE_SHA = 'dd34f594f57d0d5d6f33944bed80802d50b4712077e9f4dba1f205d93b19dbb7'
EXPECTED = {'newRegressions': 84, 'beforePass': 46, 'beforeFail': 38,
            'architectureTests': 566, 'unitPass': 9340, 'unitSkip': 4,
            'gateInputs': 1707, 'integrationScripts': 68, 'rendererLifecycle': 233,
            'existingFiles': 4710, 'primaryDirtyFiles': 865, 'plannedExistingChanges': 7}


def read(name):
    return json.loads((E / name).read_text())


def save(name, value):
    (E / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def git(root, *args):
    return subprocess.check_output(['git', *args], cwd=root, text=True).strip()


def verify(root, items):
    return {'files': len(items), 'changed': [name for name, digest in items.items()
            if not (root / name).is_file() or sha(root / name) != digest]}


def summary(name):
    """兼容 node 默认的 ℹ 格式及 TAP # 格式；不接受缺少的统计项。"""
    content = (E / name).read_text()
    result = {}
    for key in ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo']:
        matches = re.findall(r'^(?:ℹ|#) ' + key + r' (\d+)\s*$', content, re.M)
        assert len(matches) == 1, (name, key, matches)
        result[key] = int(matches[0])
    return result


def check_passing(result, count, skips=0):
    assert result['pass'] == count, result
    assert result['tests'] == count + skips, result
    assert result['skipped'] == skips, result
    assert result['fail'] == result['cancelled'] == result['todo'] == 0, result


def preservation_snapshot(initial, allowed):
    hashes = initial['sha256']
    result = {
        'initial': verify(ROOT, hashes),
        'production': verify(ROOT, {n: h for n, h in hashes.items() if n.startswith('src/')}),
        'historicalReviews': verify(ROOT, {n: h for n, h in hashes.items()
                                          if n.startswith('changes/v3.2.10/reviews/')}),
        'architectureConfig': verify(ROOT, {n: h for n, h in hashes.items()
                                           if n.startswith('architecture/') and n.endswith('.json')}),
        'primaryDirty': verify(PRIMARY, initial['primaryDirty']),
        'primaryHead': git(PRIMARY, 'rev-parse', 'HEAD'),
        'releaseHead': git(ROOT, 'rev-parse', 'HEAD'),
    }
    result['unexpectedChanges'] = sorted(set(result['initial']['changed']) - allowed)
    assert not result['unexpectedChanges'], result['unexpectedChanges']
    for key in ['production', 'historicalReviews', 'architectureConfig', 'primaryDirty']:
        assert not result[key]['changed'], (key, result[key])
    assert result['releaseHead'] == initial['head'] == gate['head']
    assert result['primaryHead'] == initial['primaryHead']
    return result


# 以下全部只读断言先于文档修改；未完成的旧门禁不能替代最终门禁。
assert sha(ROOT / SOURCE) == FINAL_SOURCE_SHA
assert git(ROOT, 'branch', '--show-current') == 'release/v3.2.10'
initial = read('input-manifest.json')
hashes = initial['sha256']
assert len(hashes) == EXPECTED['existingFiles']
assert len(initial['primaryDirty']) == EXPECTED['primaryDirtyFiles']
allowed = {p.relative_to(E / 'before').as_posix()
           for p in (E / 'before').rglob('*') if p.is_file()}
assert len(allowed) == EXPECTED['plannedExistingChanges']
for name in allowed:
    assert sha(E / 'before' / name) == hashes[name], name

gate = read('release-check-result.json')
assert gate['exitCode'] == 0 and not gate['changedInputs'], gate
assert gate['head'] == gate['headAfter'] == initial['head']
assert gate['cwd'] == str(ROOT) and gate['inputFiles'] == EXPECTED['gateInputs']
assert gate['command'] == 'UNIT_TEST_CONCURRENCY=2 npm run release-check'
assert not gate.get('aborted'), gate
manifest = read('gate-input-manifest.json')
assert manifest['head'] == gate['head'] and manifest['cwd'] == str(ROOT)
assert len(manifest['sha256']) == EXPECTED['gateInputs']
assert not verify(ROOT, manifest['sha256'])['changed']
assert manifest['sha256'][SOURCE] == FINAL_SOURCE_SHA
paths = subprocess.check_output([
    'git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--',
    'src', 'scripts', 'tests', 'architecture', 'index.html', 'package.json',
    'package-lock.json', 'eslint.config.*', '.github/workflows'], cwd=ROOT).decode().split('\0')
assert set(manifest['sha256']) == {p for p in paths if p and (ROOT / p).is_file()}

preliminary = read('preliminary-release-check-result.json')
assert preliminary['exitCode'] == -15, preliminary
assert datetime.datetime.fromisoformat(preliminary['finishedAt']) < datetime.datetime.fromisoformat(gate['startedAt'])
assert read('preliminary-gate-input-manifest.json')['sha256'][SOURCE] != FINAL_SOURCE_SHA

unit = summary('release-check.log')
check_passing(unit, EXPECTED['unitPass'], EXPECTED['unitSkip'])
archtests = summary('architecture-tests.log')
check_passing(archtests, EXPECTED['architectureTests'])
current = summary('regressions-final.log')
check_passing(current, EXPECTED['newRegressions'])
before = summary('regressions-before-final.log')
assert before['tests'] == EXPECTED['newRegressions']
assert before['fail'] == EXPECTED['beforeFail'] and before['pass'] == EXPECTED['beforePass']
assert before['cancelled'] == before['skipped'] == before['todo'] == 0
before_inputs = read('regressions-before-inputs.json')
assert before_inputs['exitCode'] == 1 and before_inputs['testSha256'] == sha(ROOT / TEST)
assert before_inputs['originalCheckers']
assert all(hashes[name] == digest for name, digest in before_inputs['originalCheckers'].items())

arch = read('architecture-check.json')
assert len(arch['activeBoundaries']) == 31
assert not arch['violations'] and not arch['staleExceptions']
assert not arch['coverage']['pendingBoundaries'] and not arch['coverage']['partialBoundaries']
probes = read('probe-verification.json')
shared = read('shared-archive-verification.json')
assert probes['result'] == 'PASS' and probes['rendererBoundaries'] == 20
assert probes['realAstCases'] == 6 and probes['realAstLogicalCases'] == 2 and probes['realAstArrayCases'] == 4
assert probes['realAstBaselineDiagnostics'] == 0
assert probes['logicalCases']['count'] == 8 and probes['arrayCases']['count'] == 7
assert not verify(ROOT, probes['currentCheckerSha256'])['changed']
assert probes['currentCheckerSha256'][SOURCE] == FINAL_SOURCE_SHA
assert not verify(ROOT, probes['unchangedSharedCheckerAndPolicySha256'])['changed']
assert all(hashes[name] == digest for name, digest in probes['unchangedSharedCheckerAndPolicySha256'].items())
assert all(sha(E / name) == digest for name, digest in probes['artifactSha256'].items())
assert shared['status'] == 'PASS' and shared['totalCases'] == 56
assert shared['rendererCases'] == 38 and shared['queryCases'] == 18
assert shared['queryCasesExecutingSql'] == 10 and shared['scannerRepeatAndPostRulesStableCases'] == 56
assert shared['changedResultCount'] == 0 and not shared['changedResults'] and shared['allExpectedResultsMatched']
for suite in shared['suites']:
    assert sha(E / suite['file']) == suite['outputSha256']
    assert sha((E / suite['file']).with_suffix('.cjs')) == suite['scriptSha256']
adjacent = read('r10-adjacent-review/results.json')
assert adjacent['total'] == adjacent['pass'] == 6
assert len(adjacent['results']) == 6 and all(row['passed'] for row in adjacent['results'])
assert sum(row['unsafe'] for row in adjacent['results']) == 3
assert not verify(ROOT, adjacent['hashes'])['changed']
assert adjacent['hashes'][SOURCE] == FINAL_SOURCE_SHA
assert FINAL_SOURCE_SHA in (E / 'r10-adjacent-review/review.md').read_text()
merge_before = read('uncertainty-merge-before.json')
merge_after = read('uncertainty-merge-after.json')
assert merge_before['total'] == merge_after['total'] == 1
assert merge_before['pass'] == 0 and merge_after['pass'] == 1
assert merge_before['hashes'][SOURCE] == read('preliminary-gate-input-manifest.json')['sha256'][SOURCE]
assert merge_after['hashes'][SOURCE] == FINAL_SOURCE_SHA
assert not verify(ROOT, merge_after['hashes'])['changed']
assert merge_before['results'][0]['source'] == merge_after['results'][0]['source']
assert merge_before['results'][0]['runtime'] == merge_after['results'][0]['runtime']
assert not merge_before['results'][0]['violations']
assert len(merge_after['results'][0]['violations']) == 1

lint = read('tool-lint.json')
assert {row['filePath'] for row in lint} == {str(ROOT / SOURCE), str(ROOT / TEST)}
assert all(row['errorCount'] == row['warningCount'] == row['fatalErrorCount'] == 0 for row in lint)
log = (E / 'release-check.log').read_text()
skips = re.findall(r'^﹣.*$', log, re.M)
assert len(skips) == EXPECTED['unitSkip'] and all('Windows' in row for row in skips)
integration = []
for match in re.finditer(r'^\[integration\] ▶ (.*?) \.\.\. PASS (?:(\d+)/(\d+)|\(no count\)) \((\d+)ms\)$', log, re.M):
    name, passed, total, duration = match.groups()
    integration.append({'name': name, 'passed': int(passed) if passed else None,
                        'total': int(total) if total else None, 'durationMs': int(duration)})
assert len(integration) == EXPECTED['integrationScripts'] and '全部 68 个集成脚本通过' in log
assert all(row['passed'] == row['total'] for row in integration)
assert next(row for row in integration if row['name'] == 'renderer-lifecycle')['passed'] == EXPECTED['rendererLifecycle']
preservation_snapshot(initial, allowed)

period = (f"{datetime.datetime.fromisoformat(gate['startedAt']):%Y-%m-%d %H:%M:%S}–"
          f"{datetime.datetime.fromisoformat(gate['finishedAt']):%H:%M:%S}（Asia/Shanghai）")
result_text = f"{unit['pass']} 项单测通过、0 失败、4 项 Windows 条件跳过，68/68 集成脚本通过"
section_title = '## 2026-09-23 第十轮独立审查修复（未提交）'
release_section = f'''{section_title}

RR10-01/02 已修复嵌套 AND/OR/nullish 的合法注入误报，以及工厂内部扩容数组经 spread 后的对象来源漏报。未知分支保留来源，参数按声明函数与参数名绑定；合并候选时来源取并集、真值/非空证明取交集。新增 84 项回归，准确起点 38 FAIL / 46 PASS，最终全部通过。

| 验证 | 本轮候选结果 |
| --- | --- |
| 完整门禁 | `{gate['command']}`：PASS，{period}；沙箱外隔离测试环境 |
| 架构专项 / CLI | 566/566 PASS；31 active、0 pending/partial、0 诊断、0 stale |
| 全量单测 | 9340 PASS、0 FAIL、4 项 Windows 条件跳过 |
| 全量集成 | 68/68 脚本 PASS；Renderer lifecycle 233/233 |
| 实际配置 / 共享探针 | 保留 20 个 Renderer boundary 的 6 个真实 AST 场景符合预期；56 项共享正反例保持 |
| 相邻独立复核 | 同一组 6 例在最终源码上符合预期，已纳入新增 84 项回归 |
| 输入 | 1707 个门禁输入及 HEAD 未漂移 |

[修复报告](reviews/2026-09-23-release-r10-repair/repair.md)、[验证汇总](reviews/2026-09-23-release-r10-repair/verification.json)、[相邻复核](reviews/2026-09-23-release-r10-repair/r10-adjacent-review/review.md)、[增量补丁](reviews/2026-09-23-release-r10-repair/incremental.patch)。初版门禁为继续修复已确认问题而主动停止，不作为 PASS；上表来自最终冻结候选的完整重跑。生产源码、共享 checker、机器配置和历史材料保持。本轮仅关闭列明反例，不代表全部 G8 合同、产品或平台验收完成；所有修复未提交。

'''

# 只替换当前 R10 状态和 R10 新增段落；较早审查/修复记录保留原文。
path = ROOT / 'changes/v3.2.10/README.md'
content = path.read_text()
assert content.count('| 交付状态 |') == 1 and '第十轮' in content
content = content.replace('第十轮修复最终门禁验证中', '第十轮修复完整门禁 PASS')
content = re.sub(r'^\| 交付状态 \|.*$',
    '| 交付状态 | 第十轮 RR10-01/02 已修复；新增 84/84 回归、架构 566/566 PASS；完整门禁重跑 PASS（9340 项单测通过、4 项 Windows 条件跳过、68/68 集成脚本通过）。修复未提交，真实产品/平台验收未执行。见 [第十轮修复报告](reviews/2026-09-23-release-r10-repair/repair.md) |',
    content, flags=re.M)
path.write_text(content)

path = ROOT / 'changes/v3.2.10/release.md'
content = path.read_text()
paragraphs = content.split('\n\n', 2)
assert len(paragraphs) == 3 and '第十轮' in paragraphs[1]
paragraphs[1] = ('当前 G1–G8 均已本地合入，HEAD 为 `9a38b96b1b8006c5851535d0c1e586bbaeb63f10`。前九轮修复保留；第十轮 RR10-01/02 逻辑分支误报和工厂数组来源漏报已修复，新增 84 项回归。完整门禁已在 1707 个冻结输入上重跑 PASS，所有修复未提交，见[第十轮修复报告](reviews/2026-09-23-release-r10-repair/repair.md)。下方历史记录保留原候选意义。')
content = '\n\n'.join(paragraphs)
marker = '## 2026-09-22 第九轮独立审查修复（未提交）'
assert marker in content
if section_title in content:
    start, end = content.index(section_title), content.index(marker)
    assert start < end
    content = content[:start] + release_section + content[end:]
else:
    content = content.replace(marker, release_section + marker, 1)
path.write_text(content)

path = ROOT / 'changes/v3.2.10/codex/v3.2.10-architecture-guardrails/implementation-notes.md'
content = path.read_text()
marker = '## 2026-09-23 第十轮 release 审查修复'
assert content.count(marker) == 1
past, current_section = content.split(marker)
replacement = ('- 新增 84 项回归，起点 38 FAIL / 46 PASS，修复后全部通过；全部架构 566/566 PASS。实际配置 6 例、共享 56 例和相邻独立复核 6 例符合预期。完整门禁在最终 1707 个冻结输入上重跑 PASS：' + result_text + '。输入及 HEAD 未漂移；初版主动停止的门禁不作为通过证据。详见 [本轮修复报告](../../reviews/2026-09-23-release-r10-repair/repair.md)。本轮继续复用 implementation-notes、blindspot-pass 的证据记录方式。')
current_section, count = re.subn(r'^- 新增 \d+ 项回归，.*$', replacement, current_section, flags=re.M)
assert count == 1
path.write_text(past + marker + current_section)

path = E / 'implementation-notes.md'
content, count = re.subn(r'^84 项回归首先.*$',
    '84 项回归首先由 VM 验证身份/行为，再检查静态结果；准确起点 38 FAIL / 46 PASS，最终全部通过。全部架构 566/566 PASS；正式 CLI 31 active、0 诊断、0 stale。真实 AST 6 例、共享 56 例和相邻独立复核 6 例符合预期。完整门禁 ' + period + ' PASS：' + result_text + '。1707 个输入及 HEAD 未漂移。初版主动停止的门禁保留原证据，不计作通过。详见 repair.md。',
    path.read_text(), flags=re.M)
assert count == 1
path.write_text(content)

preservation = preservation_snapshot(initial, allowed)
assert len(preservation['initial']['changed']) == EXPECTED['plannedExistingChanges']
assert not verify(ROOT, manifest['sha256'])['changed']
save('preservation-final.json', preservation)
integration_summary = {
    'scripts': len(integration),
    'countedPassed': sum(row['passed'] or 0 for row in integration),
    'countedTotal': sum(row['total'] or 0 for row in integration),
    'withoutCount': [row['name'] for row in integration if row['total'] is None],
    'results': integration,
}
results = {
    'result': 'PASS',
    'scope': 'RR10-01/02 and the listed adjacent regressions only; not arbitrary JavaScript, all G8 contracts, or release/platform acceptance',
    'executionContext': 'outside filesystem sandbox; isolated test fixtures',
    'expectedCounts': EXPECTED, 'gate': gate,
    'supersededGate': {'result': 'INTERRUPTED', 'exitCode': preliminary['exitCode'],
                       'reason': 'Stopped for a confirmed remaining merge-identity issue before freezing the final checker',
                       'evidence': 'preliminary-release-check-result.json'},
    'unit': unit, 'architectureTests': archtests,
    'architecture': {'active': 31, 'diagnostics': 0, 'stale': 0,
                     'parsedFiles': arch['coverage']['parsedFiles'], 'scannedFiles': arch['coverage']['scannedFiles']},
    'newRegressions': current, 'regressionsBefore': before,
    'windowsSkips': skips, 'integration': integration_summary,
    'probes': probes, 'sharedProbes': shared,
    'boundedIndependentAdjacentReview': {'cases': 6, 'passed': 6, 'sourceSha256': FINAL_SOURCE_SHA,
                                        'report': 'r10-adjacent-review/review.md'},
    'intermediateCandidateMergeRegression': {'cases': 1, 'beforePass': 0, 'finalPass': 1,
                                            'before': 'uncertainty-merge-before.json',
                                            'after': 'uncertainty-merge-after.json'},
    'preservation': preservation,
}
save('verification.json', results)

report = f'''# release/v3.2.10 第十轮审查修复

**RR10-01、RR10-02 已修复，最终冻结候选的完整 release-check 已重跑通过。** 嵌套 AND/OR/nullish 的合法 scoped API 注入不再被误报，工厂内部扩容数组经 spread 传播的同对象越权写入能够拒绝。相邻验证发现的参数同名覆盖和私有候选合并问题也已修正并纳入回归。关闭范围为下列反例与验证，不代表全部 G8 合同或正式发布验收完成。

## 候选与改动

工作区 `{ROOT}`，分支 `release/v3.2.10`，HEAD `{gate['head']}` 加已有未提交修复。依据：[第十轮审查](../2026-09-22-release-rereview-r10/review.md)、[G8 Spec](../../codex/v3.2.10-architecture-guardrails/spec.md) G8-AC-05、[TechDoc](../../codex/v3.2.10-architecture-guardrails/techdoc.md) §4.4。[起点清单](input-manifest.json)冻结 {len(hashes)} 个既有文件，[原 tracked 差异](input-diff.patch)保留已有工作。

本轮修改 [renderer-contracts.js](../../../../scripts/architecture/renderer-contracts.js)，新增 [84 项回归](../../../../tests/unit/architecture/release-rereview-r10.test.js)，同步架构说明、TechDoc、实施记录和 release 状态；集成策略计数由完整门禁刷新。最终检查器 SHA-256 为 `{FINAL_SOURCE_SHA}`。生产 src、共享 scanner/contracts/rules/schema/policy-history、机器配置与旧审查材料保持。没有提交、推送、合并、PR、升版、标签或发布。

## 修复行为与原始问题

1. **RR10-01：按逻辑运算符保留真实可能返回的来源。** `&&`、`||`、`??` 统一处理确定真/假、null/undefined 和未知值。`(undefined && provided) || provided` 及 nullish 形式排除不会返回的 undefined，不再错误触发 shared 默认对象。未知候选只在相应返回分支携带真值或非空证明；能实际触发 shared 默认值的情况仍拒绝越权写入。
2. **RR10-02：在工厂调用环境中读取数组扩容来源。** 固定槽位、push/unshift/splice 及 helper 写入使用数组的 origin 环境，外层读取仍保留调用时点。空数组的内部写入和普通 literal spread 保留可见对象身份；无法证明索引位置时保留不确定性，避免虚构精确数组语义。不同调用实例、旧别名和无关接收者仍分离。
3. **相邻检查：声明归属与候选合并。** 私有参数绑定按声明函数与参数名保存，内层同名实参不再覆盖闭包捕获值；独立复核的 6 个正反例均纳入正式回归。结构相同候选合并时，数组来源取并集，真值/非空证明只保留所有候选共有的事实，新增 4 例覆盖第二分支来源和同一 IPC 候选默认值。

保留真实 Renderer AST 与全部 **20 个 active Renderer boundary** 的 6 个场景，生产基线 0 诊断。其中 2 个逻辑场景验证合法 OR 组合及违规默认来源，4 个数组场景验证固定槽位、push、违规对照和旧别名安全对照；这是在完整 Renderer 配置中的指定装配探针，不等同于逐一运行 20 个控制器。最小配置另验证 8 个逻辑与 7 个数组场景；VM 对照验证实际对象身份与 `outsideScope` 可调用性。

[真实 AST 逻辑结果](r10-renderer-nested-realconfig-current.json)、[真实 AST 数组结果](r10-array-real-neighbor-current.json)、[探针断言](verify-probes.py)与[汇总](probe-verification.json)保留准确起点和最终结果。上述原始反例探针的 before 指本轮 `input-manifest.json` 中的检查器；没有用更早修复前版本代替本轮起点。

## 最终验证

| 验证 | 结果与证据 |
| --- | --- |
| 新增回归 | **84/84 PASS**；准确起点 **38 FAIL / 46 PASS**。[before 输入哈希](regressions-before-inputs.json)、[before 日志](regressions-before-final.log)、[最终日志](regressions-final.log) |
| 全部架构测试 | **566/566 PASS**，含新增 84 项。[日志](architecture-tests.log) |
| 正式架构 CLI | **31 active、0 pending/partial、0 诊断、0 stale**，{arch['coverage']['parsedFiles']}/{arch['coverage']['scannedFiles']} 文件解析。[JSON](architecture-check.json)、[日志](architecture-check.log) |
| 共享解析 | **56/56** 预期保持：38 Renderer、18 query，10 个用例执行内存 SQLite 查询；重复扫描、规则前后 scanner 结果及 evidenceId 保持。[汇总](shared-archive-verification.json)、[断言](verify-shared.py) |
| 相邻独立复核 | **6/6**，3 个安全例 0 诊断、3 个越权例各 1 条 scope；使用最终检查器哈希。[报告](r10-adjacent-review/review.md)、[结果](r10-adjacent-review/results.json) |
| 修改/新增 JS lint | **2 个文件 0 error / 0 warning**。[结果](tool-lint.json) |
| 完整门禁 | **PASS**；`{gate['command']}`；{period}，沙箱外隔离测试环境。[日志](release-check.log)、[结果](release-check-result.json) |
| 全量单测 | **{unit['pass']} PASS、0 FAIL、4 项 Windows 条件跳过**；{unit['tests']} total、{unit['suites']} suites。 |
| 全量集成 | **68/68 脚本 PASS**；有计数项 {integration_summary['countedPassed']}/{integration_summary['countedTotal']}，无计数脚本 {len(integration_summary['withoutCount'])} 个；Renderer lifecycle 233/233。 |
| 候选一致性 | **1707 个门禁输入及 HEAD 未漂移**。[冻结清单](gate-input-manifest.json)、[验证汇总](verification.json) |

56 个共享用例中的已知保守拒绝单独记录，没有计作合法放行；IPC Promise/await 的预期沿用第九轮纠正。共享 checker 与政策 SHA-256 在修复起点和当前保持一致。

初补丁的相邻复核发现闭包同名参数的新增误报与既有漏报，已按声明归属修正。最终自检又复现候选合并丢失第二分支数组来源，并补齐同一 IPC 候选的默认来源对照；这一自检的 [before](uncertainty-merge-before.json) 特指本轮中间补丁，[after](uncertainty-merge-after.json) 对应最终 SHA，不能混作本轮接手基线。为修复这些已确认问题，**较早启动的完整门禁主动 SIGTERM 终止，exit -15，不作为 PASS 证据**：[中止结果](preliminary-release-check-result.json)、[中止日志](preliminary-release-check.log)、[当时输入](preliminary-gate-input-manifest.json)。本报告的完整 PASS 来自最终源码冻结后的重新执行；名称带 preliminary 的其他材料也不作为最终通过证据。

## 边界与工作区保护

{len(hashes)} 个既有文件仅 **{len(preservation['initial']['changed'])} 个计划内文件变化**；**{preservation['production']['files']} 个生产源码、{preservation['historicalReviews']['files']} 个历史审查/修复文件、{preservation['architectureConfig']['files']} 份机器 JSON，以及主工作区 {preservation['primaryDirty']['files']} 个 dirty 文件保持原字节**。两个工作区 HEAD 未漂移。[保护核对](preservation-final.json)。新增回归文件与本轮证据单独交付，原 renderer-contracts.js 在接手时已为未跟踪文件，未将它误记作本轮新建。

[本轮增量补丁](incremental.patch)相对于本轮起始 dirty 状态生成；反向适用只读预检、git diff --check 和文档链接检查通过。[交付核对](delivery-check.json)、[实施记录](implementation-notes.md)。

本轮包括修复自检和上述有限的独立相邻复核，没有进行覆盖全部 G8 合同的修复后独立审查。跨文件对象时序、动态反射及精确 mutator 索引仍未完整建模，既有保守拒绝不等同于业务不合法。真实产品 Main 全流程、Windows/安装包、Excel/WPS 和资金人工验收未执行；自动门禁通过不等于正式可发布。
'''
(E / 'repair.md').write_text(report)

patch = []
for name in sorted(allowed):
    old = E / 'before' / name
    patch.extend(difflib.unified_diff(old.read_text().splitlines(True), (ROOT / name).read_text().splitlines(True),
                                    fromfile='a/' + name, tofile='b/' + name))
patch.extend(difflib.unified_diff([], (ROOT / TEST).read_text().splitlines(True), fromfile='/dev/null', tofile='b/' + TEST))
(E / 'incremental.patch').write_text(''.join(patch))
subprocess.run(['git', 'apply', '--reverse', '--check', str(E / 'incremental.patch')], cwd=ROOT, check=True)
subprocess.run(['git', 'diff', '--check'], cwd=ROOT, check=True)
links = [link for link in re.findall(r'\]\(([^)]+)\)', report) if '://' not in link and not link.startswith('#')]
missing = [link for link in links if not (E / re.sub(r':\d+$', '', link.split('#')[0])).exists()
           and link != 'delivery-check.json']
assert not missing, missing
assert git(ROOT, 'branch', '--show-current') == 'release/v3.2.10'
assert not verify(ROOT, manifest['sha256'])['changed']
assert preservation_snapshot(initial, allowed) == preservation
save('delivery-check.json', {
    'result': 'PASS', 'checkedAt': datetime.datetime.now().astimezone().isoformat(),
    'head': gate['head'], 'branch': 'release/v3.2.10', 'gateInputs': EXPECTED['gateInputs'],
    'finalCheckerSha256': FINAL_SOURCE_SHA, 'expectedCountsMatched': True,
    'gitDiffCheck': 'PASS', 'reversePatchCheck': 'PASS', 'localLinks': len(links), 'missingLinks': [],
    'executionContext': 'outside filesystem sandbox; isolated test fixtures',
})
print(json.dumps({'result': 'PASS', 'gate': gate, 'unit': unit, 'architecture': archtests,
                  'newRegressions': current, 'integrationScripts': len(integration),
                  'preservation': preservation}, ensure_ascii=False, indent=2))
