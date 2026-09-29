"""核对 RR12 最终候选，生成可复核报告和相对接手状态的增量补丁。"""
from pathlib import Path
import difflib
import hashlib
import json
import re
import subprocess

E = Path(__file__).resolve().parent
ROOT = E.parents[3]
SOURCE = 'scripts/architecture/renderer-contracts.js'
TEST = 'tests/unit/architecture/release-rereview-r12.test.js'
REVIEW = ROOT / 'changes/v3.2.10/reviews/2026-09-23-release-rereview-r12/evidence'

def read(name):
    return json.loads((E / name).read_text())

def save(name, value):
    (E / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT, text=True).strip()

def differences(hashes):
    return [name for name, digest in hashes.items()
            if not (ROOT / name).is_file() or sha(ROOT / name) != digest]

def counts(name):
    content = (E / name).read_text()
    result = {}
    for key in ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']:
        found = re.findall(r'^(?:ℹ|#) ' + key + r' (\d+)\s*$', content, re.M)
        assert len(found) == 1, (name, key, found)
        result[key] = int(found[0])
    return result

def assert_pass(value, passed, skipped=0):
    assert value == dict(tests=passed+skipped, **{'pass': passed}, fail=0,
                         cancelled=0, skipped=skipped, todo=0), value

initial = read('input-manifest.json')
hashes = initial['sha256']
assert len(hashes) == 4966
assert initial['branch'] == git('branch', '--show-current') == 'release/v3.2.10'
assert initial['head'] == git('rev-parse', 'HEAD') == '9a38b96b1b8006c5851535d0c1e586bbaeb63f10'
allowed = {p.relative_to(E / 'before').as_posix() for p in (E / 'before').rglob('*') if p.is_file()}
assert len(allowed) == 7 and SOURCE in allowed
assert all(sha(E / 'before' / name) == hashes[name] for name in allowed)
assert set(differences(hashes)) == allowed

gate = read('release-check-result.json')
manifest = read('gate-input-manifest.json')
assert gate['exitCode'] == 0 and not gate['changedInputs'] and not gate.get('aborted'), gate
assert gate['head'] == gate['headAfter'] == initial['head'] and gate['cwd'] == str(ROOT)
assert gate['command'] == 'UNIT_TEST_CONCURRENCY=2 npm run release-check'
assert len(manifest['sha256']) == gate['inputFiles'] == 1709
assert manifest['head'] == initial['head'] and not differences(manifest['sha256'])
paths = subprocess.check_output(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], cwd=ROOT).decode().split('\0')
new_paths = {p for p in paths if p and (ROOT / p).is_file()} - hashes.keys()
assert all(p == TEST or p.startswith(E.relative_to(ROOT).as_posix() + '/') for p in new_paths), new_paths

new = counts('targeted-tests.log')
before = counts('regressions-before-final.log')
arch_tests = counts('architecture-tests-final.log')
unit = counts('release-check.log')
assert_pass(new, 12)
assert before == dict(tests=12, **{'pass': 2}, fail=10, cancelled=0, skipped=0, todo=0)
assert read('regressions-before-inputs.json')['testSha256'] == sha(ROOT / TEST)
assert_pass(arch_tests, 589)
assert_pass(unit, 9363, 4)
lint = read('tool-lint.json')
assert {x['filePath'] for x in lint} == {str(ROOT / SOURCE), str(ROOT / TEST)}
assert all(x['errorCount'] == x['warningCount'] == x['fatalErrorCount'] == 0 for x in lint)

actual = read('actual-array-probe.json')
assert actual['boundaryCount'] == 20 and not actual['baseline']['violations']
assert all(b['state'] == 'active' for b in actual['boundaries'])
assert len(actual['results']) == 8
for row in actual['results']:
    assert 'scanError' not in row, row
    assert bool(row['violations']) == (not row['safe'] or row['name'] == 'overwritten-before-reorder-safe'), row
    assert row['runtime']['extraCallable'] == (not row['safe']), row
raw = read('raw-helper.json')['results'][0]
assert raw['violations'][0]['rule'] == 'ARCH-RENDERER-SCOPE' and 'scanError' not in raw
shared = read('shared-verification.json')
assert shared['status'] == 'PASS' and shared['fixtures'] == 56
assert not shared['diagnosticChanges'] and not shared['scannerChanges']
bindings = read('bindings-probe.json')
old_bindings = json.loads((REVIEW / 'r12-bindings-probes.json').read_text())
assert len(bindings['rows']) == 6
for now, old in zip(bindings['rows'], old_bindings['rows']):
    assert now['current'] == old['current'] and now['scanner']['current'] == old['scanner']['current']
    assert now['runtime'] == old['runtime'] and bool(now['current']) == now['unsafe']

log = (E / 'release-check.log').read_text()
# 正式 CLI 是完整门禁的同一调用；从原始输出提取结果，避免重复运行。
cli = log.split('> node scripts/check-architecture.js\n', 1)[1].split('> bank-bill-excel-tool@', 1)[0]
assert '架构检查：通过；' in cli and 'active 31；pending 0；partial 0。' in cli
assert '[ARCH-' not in cli and '过期例外：' not in cli
(E / 'architecture-check.log').write_text(cli)
architecture = {'source': 'release-check.log / check:architecture', 'active': 31,
                'pending': 0, 'partial': 0, 'violations': 0, 'stale': 0}
save('architecture-check-summary.json', architecture)
skips = re.findall(r'^﹣.*$', log, re.M)
assert len(skips) == 4 and all('Windows' in line for line in skips)
integration = []
for match in re.finditer(r'^\[integration\] ▶ (.*?) \.\.\. PASS (?:(\d+)/(\d+)|\(no count\)) \((\d+)ms\)$', log, re.M):
    name, passed, total, duration = match.groups()
    integration.append({'name': name, 'passed': int(passed) if passed else None,
                        'total': int(total) if total else None, 'durationMs': int(duration)})
assert len(integration) == 68 and '全部 68 个集成脚本通过' in log
assert all(x['passed'] == x['total'] for x in integration)
assert next(x for x in integration if x['name'] == 'renderer-lifecycle')['passed'] == 233
result_line = '9363 项单测通过、0 失败、4 项 Windows 条件跳过，68/68 集成脚本通过'

p = ROOT / 'changes/v3.2.10/README.md'
lines = p.read_text().splitlines()
lines = [f'| 交付状态 | 第十二轮 RR12-01 helper 递归溢出已修复，新增 12/12 回归、架构 589/589 PASS；完整门禁重跑 PASS（{result_line}）。修复未提交，真实产品/平台验收未执行。见 [第十二轮修复报告](reviews/2026-09-23-release-r12-repair/repair.md) |' if x.startswith('| 交付状态 |') else x for x in lines]
p.write_text('\n'.join(lines) + '\n')
p = ROOT / 'changes/v3.2.10/release.md'
content = p.read_text().replace('最终候选完整门禁待运行。所有修复未提交', '完整门禁在 1709 个冻结输入上重跑 PASS。所有修复未提交')
marker = '## 2026-09-23 第十一轮独立审查修复（未提交）'
section = f'''## 2026-09-23 第十二轮独立审查修复（未提交）

RR12-01：数组身份比较不再提前展开内容；元素读取保留原求值链。普通 helper 使用唯一调用位置核对写入与重排顺序。原违规和安全样例均可正常分析。

新增 12 项回归，准确修复起点 10 FAIL（RangeError）/ 2 PASS，最终 12 PASS；架构 589/589 PASS，正式 CLI 31 active、0 诊断、0 stale。保留实际 20 个 Renderer 边界的 8 个数组样例全部无异常：7 项符合正反预期、1 项既有保守拒绝继续单列。62 个共享解析和绑定用例保持原结果。

`{gate['command']}` 重跑 PASS：{result_line}。1709 个输入及 HEAD 未漂移。开始 {gate['startedAt']}，结束 {gate['finishedAt']}。

[修复报告](reviews/2026-09-23-release-r12-repair/repair.md)、[验证汇总](reviews/2026-09-23-release-r12-repair/verification.json)、[增量补丁](reviews/2026-09-23-release-r12-repair/incremental.patch)。本轮未修改生产业务源码，未提交、推送或发布；平台及人工验收不在此结论内。

'''
assert marker in content and '## 2026-09-23 第十二轮独立审查修复' not in content
p.write_text(content.replace(marker, section + marker, 1))
p = ROOT / 'changes/v3.2.10/codex/v3.2.10-architecture-guardrails/implementation-notes.md'
content = p.read_text().replace('最终候选完整门禁待运行。', f'最终架构 589/589 PASS，完整门禁在 1709 个冻结输入上重跑 PASS：{result_line}。')
p.write_text(content)
p = E / 'implementation-notes.md'
p.write_text(p.read_text() + f'\n## 最终验证\n\n架构 589/589 PASS；完整门禁重跑 PASS：{result_line}。1709 个输入及 HEAD 未漂移。实际配置探针和 62 个共享/绑定用例通过对应断言；既有保守拒绝仍单列。见 [修复报告](repair.md)。\n')

assert set(differences(hashes)) == allowed and not differences(manifest['sha256'])
preservation = {'frozenExisting': len(hashes), 'plannedChanged': sorted(allowed),
                'unchangedExisting': len(hashes)-len(allowed),
                'productionFilesUnchanged': sum(p.startswith('src/') for p in hashes),
                'historicalReviewFilesUnchanged': sum(p.startswith('changes/v3.2.10/reviews/') for p in hashes),
                'head': initial['head'], 'gateInputs': 1709}
save('preservation-final.json', preservation)
save('verification.json', {'result': 'PASS', 'scope': 'RR12-01 and listed controls; not all dynamic JavaScript or release acceptance',
     'gate': gate, 'newRegressions': new, 'beforeRegressions': before, 'architectureTests': arch_tests,
     'architecture': architecture, 'unit': unit, 'integration': integration, 'windowsSkips': skips,
     'actualConfig': {'boundaries': 20, 'cases': 8, 'scanErrors': 0, 'expectedCases': 7,
                      'knownConservative': ['overwritten-before-reorder-safe']},
     'sharedReplay': shared, 'bindingsReplay': {'cases': 6, 'changes': []}, 'preservation': preservation})
report = f'''# release/v3.2.10 第十二轮审查修复

**RR12-01 已修复；最终候选的完整 `release-check` 已重新运行并通过。** 普通数组 helper 不再引起检查器递归栈溢出，原始违规例产生 scope 诊断，安全例正常通过。

## 修复与候选

分支 `release/v3.2.10`，HEAD `{initial['head']}` 加既有未提交修复。[第十二轮审查](../2026-09-23-release-rereview-r12/review.md)与 [G8 Spec](../../codex/v3.2.10-architecture-guardrails/spec.md) AC-05 为本次依据；[TechDoc](../../codex/v3.2.10-architecture-guardrails/techdoc.md) §4.4 已同步。

[Renderer 检查器](../../../../scripts/architecture/renderer-contracts.js)调整两处：

1. 数组分配身份与元素求值分开。比较接收者身份时保留分配节点和调用环境，不提前展开 spread、扫描元素变更；真正读元素时延续原来的 depth/visited 求值链。这消除了 `sameObject → 数组展开 → helper 参数重求值 → sameObject` 的循环。
2. 参数绑定与执行顺序比较复用同一个唯一调用入口。当数组在外层创建时，也能按 helper 的调用位置区分“先写后重排”和“先重排后写”，避免修好崩溃后将安全样例误判为违规。

新增 [12 项回归](../../../../tests/unit/architecture/release-rereview-r12.test.js)，同时用 VM 核对对象是否相同及额外方法是否存在。覆盖普通 helper、对象参数、解构参数、嵌套 helper、直接重排和旧别名安全对照。没有修改生产业务源码、公共解析器、机器边界或例外配置。

## 验证

| 范围 | 结果与证据 |
| --- | --- |
| 准确修复起点 | 12 项中 **10 FAIL（RangeError）/ 2 PASS**；使用 hash 匹配的旧检查器及最终同一测试文件。[日志](regressions-before-final.log)、[输入](regressions-before-inputs.json) |
| 新增回归 | **12/12 PASS**。[日志](targeted-tests.log) |
| 全部架构单测 | **589/589 PASS**。[日志](architecture-tests-final.log) |
| 原始未捕获探针 | 正常 exit 0；输出 `ARCH-RENDERER-SCOPE`，无异常。[结果](raw-helper.json) |
| 实际 Renderer 配置 | 保留全部 **20 个 active 边界**，8 例均无异常；7 例符合正反预期，1 例既有保守拒绝单列。[结果](actual-array-probe.json)、[进度日志](actual-array-probe.log) |
| 共享解析 / 参数绑定 | **56 + 6** 例与 R12 审查的诊断、scanner 结构及 evidenceId 保持一致。[共享汇总](shared-verification.json)、[绑定结果](bindings-probe.json) |
| 修改的 JS lint | **0 error / 0 warning**。[结果](tool-lint.json) |
| 正式架构 CLI | **31 active、0 pending/partial、0 诊断、0 stale**，来自本次完整门禁内同一 CLI 调用。[日志](architecture-check.log) |
| 完整门禁 | **PASS**：`{gate['command']}`。[完整日志](release-check.log)、[进程结果](release-check-result.json) |
| 全量单测 / 集成 | **{result_line}**；Renderer lifecycle 233/233 |
| 候选一致性 | **1709 个门禁输入与 HEAD 未漂移**。[冻结清单](gate-input-manifest.json)、[验证汇总](verification.json) |

完整门禁开始于 **{gate['startedAt']}**，结束于 **{gate['finishedAt']}**。本次没有复用上一轮的完整门禁结果。实际配置探针仅追加指定装配，不等于逐一执行 20 个控制器业务。

## 保全与限制

接手时冻结 **4966 个既有文件**，其中 **7 个计划内文件**发生变更：检查器、5 份架构/状态文档，以及门禁自动刷新的集成耗时策略表。其余 **4959 个**保持逐字节一致，包括 **{preservation['productionFilesUnchanged']} 个生产源码**和 **{preservation['historicalReviewFilesUnchanged']} 个历史审查/修复文件**。新增本轮测试与证据。HEAD 未变，未提交、推送、开 PR、升版或发布。[保全核对](preservation-final.json)。

[增量补丁](incremental.patch)相对于本次接手的未提交状态生成，反向适用只读预检与 `git diff --check` 通过。[交付核对](delivery-check.json)、[实施记录](implementation-notes.md)。

“槽位先写入 clean、再覆盖为 old、然后重排”的样例仍被保守拒绝；这是审查已记录的边界，不计作合法通过，也未在本轮扩修为精确数组模拟。此次关闭的是列明的 helper 崩溃及其安全/违规对照，不代表任意 JavaScript 静态解释均完整。真实产品 Main 全流程、GUI、Windows 实机/安装包、Excel/WPS 和资金人工验收未执行，自动门禁不等于整个 release 已验收或可发布。
'''
(E / 'repair.md').write_text(report)
patch = []
for name in sorted(allowed):
    patch.extend(difflib.unified_diff((E / 'before' / name).read_text().splitlines(True), (ROOT / name).read_text().splitlines(True), fromfile='a/'+name, tofile='b/'+name))
patch.extend(difflib.unified_diff([], (ROOT / TEST).read_text().splitlines(True), fromfile='/dev/null', tofile='b/'+TEST))
(E / 'incremental.patch').write_text(''.join(patch))
subprocess.run(['git', 'apply', '--reverse', '--check', str(E/'incremental.patch')], cwd=ROOT, check=True)
subprocess.run(['git', 'diff', '--check'], cwd=ROOT, check=True)
links = [x for x in re.findall(r'\]\(([^)]+)\)', report) if '://' not in x and not x.startswith('#')]
missing = [x for x in links if not (E / x.split('#')[0]).exists() and x != 'delivery-check.json']
assert not missing, missing
assert not differences(manifest['sha256']) and git('rev-parse', 'HEAD') == initial['head']
save('delivery-check.json', {'result': 'PASS', 'head': initial['head'], 'gateInputs': 1709,
     'checkerSha256': sha(ROOT/SOURCE), 'reversePatchCheck': 'PASS', 'gitDiffCheck': 'PASS',
     'localLinks': len(links), 'missingLinks': []})
print(json.dumps({'result': 'PASS', 'unit': unit, 'architectureTests': arch_tests, 'preservation': preservation}, ensure_ascii=False, indent=2))
